import { create } from 'zustand';
import { fetchSalesDataBySku } from '@/lib/shopifySalesData';

export const useSalesDataStore = create((set, get) => ({
  /** Map<sku, { qty: number, amount: number }> */
  salesMap: new Map(),
  isLoading: false,
  error: null,
  /** Sorted comma-separated store IDs we last loaded for (dedup guard) */
  _lastStoreKey: '',

  /**
   * Fetches sales data for all stores that have an adminToken.
   * Results from multiple stores are merged by SKU (quantities/amounts summed).
   * Skips re-fetching if called again for the exact same set of stores.
   */
  loadSalesData: async (stores) => {
    const adminStores = (stores || []).filter((s) => s.adminToken);
    if (adminStores.length === 0) return;

    const storeKey = adminStores
      .map((s) => s.id)
      .sort()
      .join(',');

    // Already loaded for this exact set of stores with no error — skip
    if (get()._lastStoreKey === storeKey && get().salesMap.size > 0 && !get().error) return;

    set({ isLoading: true, error: null });
    try {
      const results = await Promise.allSettled(
        adminStores.map((store) => fetchSalesDataBySku(store))
      );

      const merged = new Map();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const [sku, data] of result.value) {
            const existing = merged.get(sku);
            if (existing) {
              merged.set(sku, {
                qty: existing.qty + data.qty,
                amount: existing.amount + data.amount,
              });
            } else {
              merged.set(sku, { qty: data.qty, amount: data.amount });
            }
          }
        } else {
          const errMsg = result.reason?.message || String(result.reason);
          // Silently degrade — shopifyqlQuery requires Advanced/Plus plan.
          // Log only in debug, not as a warning, to avoid console spam.
          if (import.meta.env.DEV) {
            console.debug('[salesDataStore] Sales data unavailable:', errMsg);
          }
          set((s) => ({ error: s.error ? s.error : errMsg }));
        }
      }

      set({ salesMap: merged, isLoading: false, _lastStoreKey: storeKey });
    } catch (err) {
      console.error('[salesDataStore] Unexpected error:', err);
      set({ isLoading: false, error: err.message });
    }
  },

  /** Force a fresh reload (clears the dedup guard) */
  invalidate: () => set({ _lastStoreKey: '' }),
}));
