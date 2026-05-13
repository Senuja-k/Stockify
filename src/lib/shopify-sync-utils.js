import { supabase, ensureValidSession } from './supabase';

// ============= TYPES =============

/**
 * Organization-level sync status for determining if data is ready for reports
 */
// ============= PRODUCTS =============

export async function upsertProducts(
  userId,
  storeId,
  products,
  syncTimestamp = new Date().toISOString(),
  organizationId
) {
  try {
    if (products.length === 0) {
      
      return;
    }

    

    const records = products.map((product) => ({
      user_id: userId,
      organization_id: organizationId,
      store_id: storeId,
      shopify_product_id: product.id?.toString(),
      title: product.title,
      description: product.description || product.body_html,
      handle: product.handle,
      vendor: product.vendor,
      product_type: product.product_type,
      status: product.status,
      tags: product.tags || [],
      created_at: product.created_at,
      updated_at: product.updated_at,
      published_at: product.published_at,
      shopify_updated_at: product.updated_at,
      synced_at: syncTimestamp,
    }));

    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const batch = records.slice(i, i + BATCH_SIZE);

      

      const { error } = await supabase
        .from('shopify_products')
        .upsert(batch, { onConflict: 'store_id,shopify_product_id' });

      if (error) {
        console.error(`[upsertProducts] Error in batch ${batchNumber}:`, error);
        throw error;
      }
    }

    
  } catch (error) {
    console.error('[upsertProducts] Error:', error);
    throw error;
  }
}

// ============= VARIANTS =============

export async function upsertVariants(
  userId,
  storeId,
  variants,
  syncTimestamp = new Date().toISOString(),
  organizationId
) {
  try {
    if (variants.length === 0) {
      
      return;
    }

    

    // First, fetch the product UUIDs we just inserted
    const productIds = await supabase
      .from('shopify_products')
      .select('id, shopify_product_id')
      .eq('store_id', storeId)
      .in(
        'shopify_product_id',
        [...new Set(variants.map((v) => v.product_id))]
      );

    if (productIds.error) {
      throw new Error(`Failed to fetch product IDs: ${productIds.error.message}`);
    }

    const productMap = new Map(
      productIds.data?.map((p) => [p.shopify_product_id, p.id]) || []
    );

    const records = variants.map((variant) => {
      const productUuid = productMap.get(variant.product_id);
      if (!productUuid) {
        throw new Error(`Product ${variant.product_id} not found`);
      }

      return {
        user_id: userId,
        organization_id: organizationId,
        store_id: storeId,
        product_id: productUuid,
        shopify_variant_id: variant.id?.toString(),
        shopify_product_id: variant.product_id?.toString(),
        title: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price ? parseFloat(variant.price.toString()) : null,
        compare_at_price: variant.compare_at_price
          ? parseFloat(variant.compare_at_price.toString())
          : null,
        cost: variant.cost ? parseFloat(variant.cost.toString()) : null,
        weight: variant.weight ? parseFloat(variant.weight.toString()) : null,
        weight_unit: variant.weight_unit,
        tracked: variant.tracked ?? true,
        inventory_quantity: variant.inventory_quantity ?? 0,
        inventory_policy: variant.inventory_policy,
        created_at: variant.created_at,
        updated_at: variant.updated_at,
        shopify_updated_at: variant.updated_at,
        synced_at: syncTimestamp,
      };
    });

    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const batch = records.slice(i, i + BATCH_SIZE);

      

      const { error } = await supabase
        .from('shopify_products')
        .upsert(batch, { onConflict: 'store_id,shopify_variant_id' });

      if (error) {
        console.error(`[upsertVariants] Error in batch ${batchNumber}:`, error);
        throw error;
      }
    }

    
  } catch (error) {
    console.error('[upsertVariants] Error:', error);
    throw error;
  }
}

// ============= PRODUCT METAFIELDS =============

export async function upsertProductMetafields(
  userId,
  storeId,
  metafields,
  syncTimestamp = new Date().toISOString(),
  organizationId
) {
  try {
    if (metafields.length === 0) {
      
      return;
    }

    

    const records = metafields.map((mf) => ({
      user_id: userId,
      organization_id: organizationId,
      store_id: storeId,
      shopify_metafield_id: mf.id?.toString(),
      namespace: mf.namespace,
      key: mf.key,
      value: mf.value,
      value_type: mf.type || mf.value_type,
      synced_at: syncTimestamp,
    }));

    const BATCH_SIZE = 200;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('shopify_product_metafields')
        .upsert(batch, { onConflict: 'store_id,shopify_metafield_id' });

      if (error) {
        console.error('[upsertProductMetafields] Error:', error);
        throw error;
      }
    }

    
  } catch (error) {
    console.error('[upsertProductMetafields] Error:', error);
    throw error;
  }
}

// ============= SYNC STATUS =============

/**
 * Get organization-level sync status for determining if reports can be generated.
 * This is used by public reports to check if data is ready.
 * Uses the public Supabase client to avoid auth-related abort issues.
 */
export async function getOrganizationSyncStatus(
  organizationId,
  signal
) {
  const { supabasePublic } = await import('./supabase');
  
  try {
    // Get all sync statuses for the organization
    let query = supabasePublic
      .from('shopify_store_sync_status')
      .select('store_id, last_synced_at, organization_id')
      .eq('organization_id', organizationId);

    if (signal) {
      query = query.abortSignal(signal);
    }

    const { data, error } = await query;

    if (error) {
      // If aborted, return a "not ready" status without throwing
      if (error.message?.includes('AbortError') || error.message?.includes('signal is aborted')) {
        return {
          isReady: false,
          isAnySyncing: false,
          lastSyncAt: null,
          storeCount: 0,
          syncedStoreCount: 0,
        };
      }
      throw error;
    }

    if (!data || data.length === 0) {
      return {
        isReady: false,
        isAnySyncing: false,
        lastSyncAt: null,
        storeCount: 0,
        syncedStoreCount: 0,
      };
    }

    // Calculate organization-level status
    const syncedStores = data.filter(s => s.last_synced_at !== null);
    const lastSyncTimes = syncedStores
      .map(s => s.last_synced_at)
      .filter(Boolean);
    
    const lastSyncAt = lastSyncTimes.length > 0
      ? lastSyncTimes.sort().at(-1) || null
      : null;

    return {
      isReady: syncedStores.length > 0,  // Ready if at least one store has synced
      isAnySyncing: false,  // We don't track this in current schema
      lastSyncAt,
      storeCount: data.length,
      syncedStoreCount: syncedStores.length,
    };
  } catch (error) {
    console.error('[getOrganizationSyncStatus] Error:', error);
    // Return a safe default on error
    return {
      isReady: false,
      isAnySyncing: false,
      lastSyncAt: null,
      storeCount: 0,
      syncedStoreCount: 0,
    };
  }
}

export async function getSyncStatus(
  userId,
  storeId,
  organizationId,
  signal
) {
  
  try {
    
    let query = supabase
      .from('shopify_store_sync_status')
      .select('*')
      .eq('store_id', storeId);

    if (signal) {
      query = query.abortSignal(signal);
    }

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    } else {
      query = query.eq('user_id', userId);
    }

    
    const { data, error } = await query.maybeSingle();
    

    if (error && error.code !== 'PGRST116') {
      const isAbort =
        (error)?.name === 'AbortError' ||
        (typeof (error)?.message === 'string' &&
          (error).message.includes('signal is aborted'));

      if (isAbort) {
        
        // Expected cancellation (e.g., visibility change/unmount) � ignore
        return null;
      }

      console.error('[getSyncStatus] Query error:', error);
      throw error;
    }

    if (!data) {
      
      return null;
    }

    

    return {
      store_id: data.store_id,
      last_product_sync_at: data.last_synced_at,
      last_order_sync_at: data.last_order_sync_at || null,
      is_syncing: data.is_syncing || false,
    };
  } catch (error) {
    const isAbort =
      (error)?.name === 'AbortError' ||
      (typeof (error)?.message === 'string' &&
        (error).message.includes('signal is aborted'));

    if (isAbort) {
      // Expected cancellation � ignore
      return null;
    }

    console.error('[getSyncStatus] Error:', error);
    return null;
  }
}

export async function updateSyncStatus(
  userId,
  storeId,
  updates,
  organizationId
) {
  try {
    const updateData = {
      user_id: userId,
      organization_id: organizationId,
      store_id: storeId,
    };

    // Map new field names to old schema
    if (updates.last_product_sync_at) {
      updateData.last_synced_at = updates.last_product_sync_at;
    }

    const { error } = await supabase
      .from('shopify_store_sync_status')
      .upsert(updateData, { onConflict: 'store_id' });

    if (error) {
      throw error;
    }

    
  } catch (error) {
    console.error('[updateSyncStatus] Error:', error);
    throw error;
  }
}

// ============= DELETION HANDLING =============

export async function markDeletedProducts(
  storeId,
  syncTimestamp,
  organizationId
) {
  try {
    

    let query = supabase
      .from('shopify_products')
      .update({ is_deleted: true })
      .eq('store_id', storeId)
      .lt('synced_at', syncTimestamp);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { error } = await query;

    if (error) {
      throw error;
    }

    
  } catch (error) {
    console.error('[markDeletedProducts] Error:', error);
    throw error;
  }
}

export async function markDeletedVariants(
  storeId,
  syncTimestamp,
  organizationId
) {
  try {
    

    let query = supabase
      .from('shopify_products')
      .update({ updated_at: new Date().toISOString() })
      .eq('store_id', storeId)
      .lt('updated_at', syncTimestamp);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { error } = await query;

    if (error) {
      throw error;
    }

    
  } catch (error) {
    console.error('[markDeletedVariants] Error:', error);
    throw error;
  }
}

// ============= REPORTING HELPERS =============

export async function getProductsByStore(
  userId,
  storeIds,
  options,
  organizationId
) {
  try {
    let query = supabase
      .from('shopify_products')
      .select(
        `
        id,
        shopify_product_id,
        title,
        description,
        handle,
        vendor,
        product_type,
        status,
        tags,
        created_at,
        updated_at,
        published_at
      `
      )
      .in('store_id', storeIds);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    } else {
      query = query.eq('user_id', userId);
    }

    if (options?.excludeDeleted !== false) {
      query = query.eq('is_deleted', false);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('[getProductsByStore] Error:', error);
    return [];
  }
}

export async function getVariantsByStore(
  userId,
  storeIds,
  options,
  organizationId
) {
  try {
    // Fetch all products without limit - use count to get total
    let query = supabase
      .from('shopify_products')
      .select('*', { count: 'exact' })
      .in('store_id', storeIds)
      .limit(100000); // Set very high limit to get all products

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    } else {
      query = query.eq('user_id', userId);
    }

    const { data, error, count } = await query;

    if (error) throw error;
    
    
    
    // The old schema stores the full product in the 'data' JSONB column
    // Extract it and add store_id
    const products = (data || []).map((row) => {
      const productData = row.data || {};
      return {
        ...productData,
        id: row.id || productData.id,
        store_id: row.store_id,
        shopify_product_id: row.shopify_product_id,
        // Prefer top-level title; fall back to fullProduct for sync-stores format
        title: productData.title || productData.fullProduct?.title || '',
        // Prefer top-level status; fall back to fullProduct.status for sync-stores format
        status: productData.status || productData.fullProduct?.status || 'UNKNOWN',
        variantPrice: productData.variantPrice || productData.variantData?.price || productData.price,
        compareAtPrice: productData.compareAtPrice || productData.variantData?.compareAtPrice,
        totalInventory: productData.totalInventory ?? productData.fullProduct?.totalInventory,
        // Hoist variant fields from variantData (sync-stores format) to top level
        sku: productData.sku || productData.variantData?.sku || undefined,
        barcode: productData.barcode || productData.variantData?.barcode || undefined,
        variantSku: productData.variantSku || productData.variantData?.sku || undefined,
        variantBarcode: productData.variantBarcode || productData.variantData?.barcode || undefined,
        variantTitle: productData.variantTitle || productData.variantData?.title || undefined,
        // Ensure variants array exists for flattening
        variants: Array.isArray(productData.variants) ? productData.variants : [],
      };
    });
    
    
    if (products.length > 0) {
      
    }
    
    return products;
  } catch (error) {
    console.error('[getVariantsByStore] Error:', error);
    return [];
  }
}

// ============= PAGINATED QUERY =============

/**
 * Fetch a single page of products with server-side pagination
 * @param userId User ID for RLS
 * @param storeIds Array of store IDs to fetch from
 * @param pageIndex 0-based page index
 * @param pageSize Number of items per page
 */
export async function getVariantsByStorePaginated(
  userId,
  storeIds,
  pageIndex = 0,
  pageSize = 25,
  organizationId
) {
  try {
    const from = pageIndex * pageSize;
    const to = from + pageSize - 1;

    

    // Get total count first
    let countQuery = supabase
      .from('shopify_products')
      .select('id', { count: 'exact', head: true })
      .in('store_id', storeIds);

    if (organizationId) {
      countQuery = countQuery.eq('organization_id', organizationId);
    } else {
      countQuery = countQuery.eq('user_id', userId);
    }

    const { count: totalCount } = await countQuery;

    // Get page data
    let pageQuery = supabase
      .from('shopify_products')
      .select('*')
      .in('store_id', storeIds)
      .range(from, to);

    if (organizationId) {
      pageQuery = pageQuery.eq('organization_id', organizationId);
    } else {
      pageQuery = pageQuery.eq('user_id', userId);
    }

    const { data, error } = await pageQuery;

    if (error) throw error;

    // Extract products from JSONB data
    const products = (data || []).map((row) => {
      const productData = row.data || {};
      return {
        ...productData,
        store_id: row.store_id,
        title: productData.title || productData.fullProduct?.title || '',
        status: productData.status || productData.fullProduct?.status || 'UNKNOWN',
        variantPrice: productData.variantPrice || productData.variantData?.price || productData.price,
        compareAtPrice: productData.compareAtPrice || productData.variantData?.compareAtPrice,
        totalInventory: productData.totalInventory ?? productData.fullProduct?.totalInventory,
        sku: productData.sku || productData.variantData?.sku || undefined,
        barcode: productData.barcode || productData.variantData?.barcode || undefined,
        variantSku: productData.variantSku || productData.variantData?.sku || undefined,
        variantBarcode: productData.variantBarcode || productData.variantData?.barcode || undefined,
        variantTitle: productData.variantTitle || productData.variantData?.title || undefined,
      };
    });

    const pageCount = Math.ceil((totalCount || 0) / pageSize);

    

    return {
      data,
      totalCount: totalCount || 0,
      pageCount,
    };
  } catch (error) {
    console.error('[getVariantsByStorePaginated] Error:', error);
    return {
      data: [],
      totalCount: 0,
      pageCount: 0,
    };
  }
}

export async function getAllVariantsByStore(
  userId,
  storeIds,
  organizationId,
  signal
) {
  try {
    
    
    // Ensure we have a valid session before making authenticated queries
    const session = await ensureValidSession();
    if (!session) {
      console.error('[getAllVariantsByStore] No valid session, cannot fetch products');
      throw new Error('Session expired. Please refresh the page to re-authenticate.');
    }
    
    // Use authenticated supabase client (required for RLS)
    // Get total count first
    let countQuery = supabase
      .from('shopify_products')
      .select('id', { count: 'exact', head: true })
      .in('store_id', storeIds);

    if (signal) {
      countQuery = countQuery.abortSignal(signal);
    }

    if (organizationId) {
      countQuery = countQuery.eq('organization_id', organizationId);
    } else {
      countQuery = countQuery.eq('user_id', userId);
    }

    const { count, error: countError } = await countQuery;
    
    if (countError) {
      console.error('[getAllVariantsByStore] Count error:', countError);
      throw countError;
    }

    

    if (!count || count === 0) {
      
      return [];
    }

    // Fetch all products in batches of 1000 in parallel for speed
    const batchSize = 1000;
    const totalBatches = Math.ceil(count / batchSize);
    const maxConcurrent = 5;
    const allProducts = [];

    // Process batches in groups
    for (let groupStart = 0; groupStart < totalBatches; groupStart += maxConcurrent) {
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const groupEnd = Math.min(groupStart + maxConcurrent, totalBatches);
      const batchPromises = [];

      for (let batchIndex = groupStart; batchIndex < groupEnd; batchIndex++) {
        const from = batchIndex * batchSize;
        const to = from + batchSize - 1;

        const fetchBatch = async () => {
          let pageQuery = supabase
            .from('shopify_products')
            .select('*')
            .in('store_id', storeIds)
            .range(from, to);

          if (signal) {
            pageQuery = pageQuery.abortSignal(signal);
          }

          if (organizationId) {
            pageQuery = pageQuery.eq('organization_id', organizationId);
          } else {
            pageQuery = pageQuery.eq('user_id', userId);
          }

          const { data, error } = await pageQuery;

          if (error) throw error;

          // Extract products from JSONB data
          // IMPORTANT: Each database row already represents ONE VARIANT (not a product with multiple variants)
          // The database stores variants rows, so we should NOT include the variants array
          // Including it causes duplication when flattenProductsWithVariants is called later
          return (data || []).map((row) => {
            const productData = row.data || {};
            return {
              ...productData,
              id: row.id || productData.id,
              store_id: row.store_id,
              shopify_product_id: row.shopify_product_id,
              shopify_variant_id: row.shopify_variant_id, // This row IS a specific variant
              title: productData.title || productData.fullProduct?.title || '',
              status: productData.status || productData.fullProduct?.status || 'UNKNOWN',
              variantPrice: productData.variantPrice || productData.variantData?.price || productData.price,
              compareAtPrice: productData.compareAtPrice || productData.variantData?.compareAtPrice,
              totalInventory: productData.totalInventory ?? productData.fullProduct?.totalInventory,
              sku: productData.sku || productData.variantData?.sku || undefined,
              barcode: productData.barcode || productData.variantData?.barcode || undefined,
              variantSku: productData.variantSku || productData.variantData?.sku || undefined,
              variantBarcode: productData.variantBarcode || productData.variantData?.barcode || undefined,
              variantTitle: productData.variantTitle || productData.variantData?.title || undefined,
              variants: [], // DON'T include variants array - this row already IS a single variant
            };
          });
        };

        batchPromises.push(fetchBatch());
      }

      const batchResults = await Promise.all(batchPromises);
      for (const products of batchResults) {
        allProducts.push(...products);
      }

      
    }

    
    return allProducts;
  } catch (error) {
    // Don't log AbortErrors - they're expected when requests are cancelled
    if (error instanceof DOMException && error.name === 'AbortError') {
      
      return [];
    }
    // Check for error name property
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
      
      return [];
    }
    // Check for abort in error message
    if (error && typeof error === 'object' && 'message' in error && 
        typeof error.message === 'string' && (error.message.toLowerCase().includes('abort') || error.message.includes('cancelled'))) {
      
      return [];
    }
    console.error('[getAllVariantsByStore] Error:', error);
    return [];
  }
}
