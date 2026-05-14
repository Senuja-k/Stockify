import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

export const useSalesDataStore = create((set, get) => ({
  /** Map<sku, { qty: number, amount: number }> */
  salesMap: new Map(),
  isLoading: false,
  error: null,
  /** Sorted comma-separated store IDs we last loaded for (dedup guard) */
  _lastStoreKey: '',

  /**
   * Loads per-SKU sales totals. Tries the `shopify_sales` Supabase table first
   * (populated on every sync). Falls back to a live Shopify API call when the
   * table is empty or unavailable, then writes those results back to the DB so
   * subsequent loads use the fast DB path.
   *
   * @param {Array<{id: string, domain: string, adminToken: string}>} stores
   *   Full store objects are needed for the API fallback path.
   */
  loadSalesData: async (stores) => {
    const storeList = (stores || []).filter(Boolean);
    if (storeList.length === 0) return;

    // Support being called with plain ID strings (no fallback in that case)
    const ids = storeList.map((s) => (typeof s === 'string' ? s : s.id)).filter(Boolean);
    const storeKey = [...ids].sort().join(',');

    // Already loaded for this exact set of stores with no error — skip
    if (get()._lastStoreKey === storeKey && get().salesMap.size > 0 && !get().error) return;

    set({ isLoading: true, error: null });
    try {
      // --- Primary path: read from Supabase shopify_sales table ---
      const { data, error: dbError } = await supabase
        .from('shopify_sales')
        .select('sku, sales_qty, sales_amount')
        .in('store_id', ids);

      if (!dbError && data && data.length > 0) {
        // Table has data — build the map and we're done
        const merged = new Map();
        for (const row of data) {
          const existing = merged.get(row.sku);
          if (existing) {
            merged.set(row.sku, {
              qty: existing.qty + (row.sales_qty || 0),
              amount: existing.amount + parseFloat(row.sales_amount || 0),
            });
          } else {
            merged.set(row.sku, {
              qty: row.sales_qty || 0,
              amount: parseFloat(row.sales_amount || 0),
            });
          }
        }
        set({ salesMap: merged, isLoading: false, _lastStoreKey: storeKey });
        return;
      }

      if (dbError) {
        console.warn('[salesDataStore] shopify_sales DB query failed, falling back to API:', dbError.message);
      } else {
        console.warn('[salesDataStore] shopify_sales table empty, falling back to Shopify API and writing to DB');
      }

      // --- Fallback path: live Shopify API (dynamic import to avoid bundle init order issues) ---
      const storeObjects = storeList.filter((s) => typeof s === 'object' && s.domain && s.adminToken);
      if (storeObjects.length === 0) {
        set({ salesMap: new Map(), isLoading: false, _lastStoreKey: storeKey });
        return;
      }

      // Dynamic import so this module never creates a static circular dependency
      const { fetchSalesDataBySku } = await import('@/lib/shopifySalesData');

      const results = await Promise.allSettled(storeObjects.map((store) => fetchSalesDataBySku(store)));
      const merged = new Map();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const [sku, { qty, amount }] of result.value) {
          const existing = merged.get(sku);
          if (existing) {
            merged.set(sku, { qty: existing.qty + qty, amount: existing.amount + amount });
          } else {
            merged.set(sku, { qty, amount });
          }
        }
      }
      set({ salesMap: merged, isLoading: false, _lastStoreKey: storeKey });

      // Write results back to shopify_sales so future loads use the fast DB path.
      // Best-effort — don't let a DB write failure affect the in-memory data.
      try {
        const rowBatches = storeObjects.flatMap((store, i) => {
          const r = results[i];
          if (r?.status !== 'fulfilled' || !r.value?.size) return [];
          return Array.from(r.value.entries()).map(([sku, { qty, amount }]) => ({
            store_id: store.id,
            sku,
            sales_qty: qty,
            sales_amount: amount,
            synced_at: new Date().toISOString(),
          }));
        });

        if (rowBatches.length > 0) {
          const BATCH = 100;
          for (let i = 0; i < rowBatches.length; i += BATCH) {
            await supabase
              .from('shopify_sales')
              .upsert(rowBatches.slice(i, i + BATCH), { onConflict: 'store_id,sku' });
          }
          console.log('[salesDataStore] wrote', rowBatches.length, 'rows to shopify_sales');
        }
      } catch (writeErr) {
        console.warn('[salesDataStore] failed to write sales to DB (non-fatal):', writeErr.message);
      }
    } catch (err) {
      console.error('[salesDataStore] Failed to load sales data:', err);
      set({ isLoading: false, error: err.message });
    }
  },

  /** Force a fresh reload on next call (clears the dedup guard). */
  invalidate: () => set({ _lastStoreKey: '' }),
}));
