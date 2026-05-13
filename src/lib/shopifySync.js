import { fetchProductsFromStore } from '@/lib/shopify';
import {
  getSyncStatus,
  updateSyncStatus,
} from '@/lib/shopify-sync-utils';
import { supabase, isAbortError } from './supabase';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const UPSERT_BATCH_SIZE = 25;
const DELETE_BATCH_SIZE = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(error) {
  const msg =
    (error && typeof error === 'object' && 'message' in error && String(error.message)) ||
    '';
  const details =
    (error && typeof error === 'object' && 'details' in error && String(error.details)) ||
    '';
  const combined = `${msg} ${details}`.toLowerCase();
  return (
    combined.includes('failed to fetch') ||
    combined.includes('err_http2_protocol_error') ||
    combined.includes('connection_closed') ||
    combined.includes('network')
  );
}

async function withRetries(task, label, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await task();
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isTransientNetworkError(error)) {
        throw error;
      }
      const delayMs = 400 * attempt;
      console.warn(`[${label}] transient failure, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
      await sleep(delayMs);
    }
  }
}

/**
 * Get the latest sync time for an organization from the DB.
 * Returns the most recent last_synced_at across all stores in the org, or null.
 */
export async function getOrgLastSyncTime(organizationId, storeIds) {
  try {
    // Query by organization — not by specific storeIds — so we find existing
    // sync history even when the selected store ID changed (e.g. after reconnect).
    let query = supabase
      .from('shopify_store_sync_status')
      .select('last_synced_at')
      .not('last_synced_at', 'is', null)
      .order('last_synced_at', { ascending: false })
      .limit(1);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    } else if (storeIds && storeIds.length > 0) {
      // Fallback: no org, filter by storeIds
      query = query.in('store_id', storeIds);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      if (isAbortError(error)) {
        return null;
      }
      console.error('[getOrgLastSyncTime] Error:', error);
      return null;
    }

    const lastSync = data?.last_synced_at || null;
    
    return lastSync;
  } catch (err) {
    if (isAbortError(err)) return null;
    console.error('[getOrgLastSyncTime] Error:', err);
    return null;
  }
}

/**
 * Check if org sync is due: returns true if last sync was > 2 hours ago
 * Returns false if < 2 hours (no sync needed)
 * Returns false if no sync history (first sync should be manual)
 */
export function isOrgSyncDue(lastSyncedAt) {
  if (!lastSyncedAt) {
    
    return false;
  }
  const last = new Date(lastSyncedAt).getTime();
  const now = Date.now();
  const timeSince = now - last;
  const isDue = timeSince >= TWO_HOURS_MS;

  const minutesSince = Math.floor(timeSince / 1000 / 60);
  const minutesUntilDue = Math.max(0, Math.floor((TWO_HOURS_MS - timeSince) / 1000 / 60));

  
  

  return isDue;
}

/**
 * Full sync for a store - fetches all products and syncs to database
 * Marks any products not in this sync (soft delete)
 */
export async function syncStoreProductsFull(
  userId,
  store,
  organizationId
) {
  const syncTimestamp = new Date().toISOString();
  
  
  
  
  
  

  try {
    // Fetch all products from Shopify
    
    const allFetchedProducts = await fetchProductsFromStore({
      ...store,
      organizationId,
    });
    
    // Log all unique SKUs for debugging
    const allSkus = allFetchedProducts
      .map(p => p.sku || p.variantSku)
      .filter(Boolean);
    
    if (allSkus.length > 50) {
      
    }
    
    // Log products with 'test' in SKU for debugging
    const testSkuProducts = allFetchedProducts.filter(p => 
      p.sku?.toLowerCase().includes('test') || 
      p.variantSku?.toLowerCase().includes('test')
    );
    if (testSkuProducts.length > 0) {
      
    } else {
      
    }

    // For the old schema, we store each variant row with JSONB data
    const productsToUpsert = allFetchedProducts.map(product => ({
      user_id: userId,
      organization_id: organizationId,
      store_id: store.id,
      shopify_product_id: product.productId?.toString() || product.id?.toString(),
      shopify_variant_id: product.variantId?.toString() || product.id?.toString(),
      data: product, // Store entire product
      updated_at: new Date().toISOString(),
    }));
    
    
    

    // Smaller batches + retry for unstable network/protocol responses
    const BATCH_SIZE = UPSERT_BATCH_SIZE;
    let totalUpserted = 0;
    for (let i = 0; i < productsToUpsert.length; i += BATCH_SIZE) {
      const batch = productsToUpsert.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(productsToUpsert.length / BATCH_SIZE);
      
      
      
      const { error } = await withRetries(
        async () =>
          supabase
            .from('shopify_products')
            .upsert(batch, { onConflict: 'store_id,shopify_variant_id', count: 'exact' }),
        `syncStoreProductsFull:upsert-batch-${batchNumber}`,
      );
      
      if (error) {
        console.error(`[syncStoreProductsFull] Error in batch ${batchNumber}:`, error);
        console.error(`[syncStoreProductsFull] Failed batch sample:`, batch.slice(0, 2));
        throw error;
      }
      
      totalUpserted += batch.length;
      
    }
    
    
    // Delete products that weren't in this sync:
    // Avoid huge `not.in(...)` URL by doing chunked ID deletes.
    const incomingVariantIds = new Set(
      allFetchedProducts.map((p) => String(p.variantId || p.id)).filter(Boolean),
    );

    let existingQuery = supabase
      .from('shopify_products')
      .select('id, shopify_variant_id')
      .eq('user_id', userId)
      .eq('store_id', store.id);
    if (organizationId) existingQuery = existingQuery.eq('organization_id', organizationId);

    const { data: existingRows, error: existingError } = await withRetries(
      async () => existingQuery,
      'syncStoreProductsFull:fetch-existing-for-delete',
    );
    if (existingError) {
      console.error(`[syncStoreProductsFull] Error loading existing rows for cleanup:`, existingError);
    } else {
      const staleIds = (existingRows || [])
        .filter((row) => !incomingVariantIds.has(String(row.shopify_variant_id)))
        .map((row) => row.id);

      let totalDeleted = 0;
      for (let i = 0; i < staleIds.length; i += DELETE_BATCH_SIZE) {
        const idBatch = staleIds.slice(i, i + DELETE_BATCH_SIZE);
        const { error: delErr } = await withRetries(
          async () =>
            supabase
              .from('shopify_products')
              .delete()
              .in('id', idBatch),
          `syncStoreProductsFull:delete-batch-${Math.floor(i / DELETE_BATCH_SIZE) + 1}`,
        );
        if (delErr) {
          console.error(`[syncStoreProductsFull] Error deleting stale batch:`, delErr);
          break;
        }
        totalDeleted += idBatch.length;
      }

      
    }

    // Verify what was actually saved to database
    const { count: dbCount } = await supabase
      .from('shopify_products')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', store.id);
    
    
    
    if (dbCount !== productsToUpsert.length) {
      console.warn(`%c[syncStoreProductsFull] ?? MISMATCH Tried to upsert ${productsToUpsert.length} but database has ${dbCount}`, 'background: red; color: white; font-weight: bold; font-size: 16px');
    } else {
      
    }

    // Update sync status
    await updateSyncStatus(userId, store.id, {
      last_product_sync_at: syncTimestamp,
    }, organizationId);

    const next = new Date(new Date(syncTimestamp).getTime() + TWO_HOURS_MS);
    
    
    
    
  } catch (error) {
    console.error(`[syncStoreProductsFull] Error:`, error);
    await updateSyncStatus(userId, store.id, {
      last_sync_error: error instanceof Error ? error.message : String(error),
    }, organizationId);
    throw error;
  }
}

/**
 * Sync multiple stores in parallel
 */
export async function syncStoresProductsFull(
  userId,
  stores,
  organizationId
) {
  
  
  

  let successCount = 0;
  let failCount = 0;
  for (const store of stores) {
    try {
      await syncStoreProductsFull(userId, store, organizationId);
      successCount++;
      
      await sleep(250);
    } catch (error) {
      failCount++;
      console.error(`[syncStoresProductsFull] ? Store ${store.name} failed:`, error);
    }
  }

  
  
  
}

/**
 * Check if a sync is due based on last sync time
 */
export function isSyncDue(lastSyncedAt) {
  if (!lastSyncedAt) {
    
    return false;
  }
  const last = new Date(lastSyncedAt).getTime();
  const now = Date.now();
  const timeSince = now - last;
  const isDue = timeSince >= TWO_HOURS_MS;
  
  const minutesSince = Math.floor(timeSince / 1000 / 60);
  const minutesUntilDue = Math.floor((TWO_HOURS_MS - timeSince) / 1000 / 60);
  
  
  
  
  return isDue;
}
