import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const adminClient = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey)
  : null;

function normalizeDomain(domain) {
  if (!domain) return '';
  return String(domain).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function fetchStoreCurrency(domain: string, adminToken: string): Promise<string> {
  const API_VER = '2025-07';
  const url = `https://${domain}/admin/api/${API_VER}/graphql.json`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': adminToken },
      body: JSON.stringify({ query: '{ shop { currencyCode } }' }),
    });
    if (!resp.ok) return 'USD';
    const json = await resp.json();
    return json.data?.shop?.currencyCode || 'USD';
  } catch {
    return 'USD';
  }
}

async function fetchAllProductsForStore(domain: string, adminToken: string, currencyCode: string = 'USD') {
  const API_VER = '2025-07';
  const url = `https://${domain}/admin/api/${API_VER}/graphql.json`;
  const allProducts = [];
  let hasNext = true;
  let cursor = null;

  const query = `
    query GetProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            productType
            vendor
            status
            createdAt
            updatedAt
            totalInventory
            images(first: 1) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 250) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  compareAtPrice
                  inventoryQuantity
                }
              }
            }
            metafields(first: 250) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
      }
    }
  `;
  while (hasNext) {
    const variables = { first: 250 };
    if (cursor) variables.after = cursor;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Shopify fetch failed: ${resp.status} ${txt.substring(0,200)}`);
    }

    const json = await resp.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));

    const products = json.data.products;
    for (const edge of products.edges) {
      const node = edge.node;
      const variants = (node.variants?.edges || []).map((v) => v.node || {});
      if (variants.length === 0) {
        allProducts.push({ product: node, variant: null });
      } else {
        for (const variant of variants) {
          allProducts.push({ product: node, variant });
        }
      }
    }

    hasNext = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  // Map into flattened rows compatible with shopify_products.data
  return allProducts.map(({ product, variant }) => {
    const v = variant || {};
    return {
      productId: product.id,
      variantId: v.id || product.id,
      sku: v.sku || null,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status || 'ACTIVE',
      totalInventory: product.totalInventory ?? 0,
      updatedAt: product.updatedAt,
      createdAt: product.createdAt,
      image: (product.images?.edges?.[0]?.node?.url) || null,
      variantPrice: v.price ? String(v.price) : null,
      compareAtPrice: v.compareAtPrice ? String(v.compareAtPrice) : null,
      currencyCode,
      metafields: (product.metafields?.edges || []).map((e: any) => e.node),
      variantData: v,
      fullProduct: product,
    };
  });
}

/**
 * Fetch all paid orders and aggregate sales totals by SKU.
 * Best-effort: requires read_orders scope (available on all Shopify plans).
 * Returns a Map<sku, { qty, amount }>.
 */
async function fetchSalesDataForStore(
  domain: string,
  adminToken: string,
): Promise<Map<string, { qty: number; amount: number }>> {
  const API_VER = '2025-07';
  const url = `https://${domain}/admin/api/${API_VER}/graphql.json`;
  const query = `
    query FetchOrderLineItems($cursor: String) {
      orders(
        first: 250
        after: $cursor
        query: "financial_status:paid OR financial_status:partially_paid"
      ) {
        edges {
          node {
            lineItems(first: 250) {
              edges {
                node {
                  sku
                  quantity
                  discountedUnitPriceSet { shopMoney { amount } }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const salesMap = new Map<string, { qty: number; amount: number }>();
  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const variables: Record<string, unknown> = {};
    if (cursor) variables.cursor = cursor;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) throw new Error(`Orders API failed: ${resp.status}`);
    const json = await resp.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));

    const ordersData = json.data?.orders;
    if (!ordersData) break;

    for (const { node: order } of ordersData.edges) {
      for (const { node: item } of order.lineItems.edges) {
        const sku: string = item.sku;
        if (!sku) continue;
        const qty: number = item.quantity || 0;
        const unitPrice = parseFloat(item.discountedUnitPriceSet?.shopMoney?.amount || '0');
        const amount = qty * unitPrice;
        const existing = salesMap.get(sku);
        if (existing) {
          salesMap.set(sku, { qty: existing.qty + qty, amount: existing.amount + amount });
        } else {
          salesMap.set(sku, { qty, amount });
        }
      }
    }

    hasNext = ordersData.pageInfo.hasNextPage;
    cursor = ordersData.pageInfo.endCursor;
  }

  return salesMap;
}

/**
 * Second-pass location sync.
 * Fetches per-location inventory for a list of variant GIDs in batches of 40.
 * Cost per batch ≈ 840 points — safely under Shopify's 1000-point limit.
 * Returns a map of variantGid → [{name, available}]
 */
async function fetchInventoryLocationsForVariants(
  domain: string,
  adminToken: string,
  variantGids: string[],
): Promise<Record<string, Array<{ name: string; available: number }>>> {
  const API_VER = '2025-07';
  const url = `https://${domain}/admin/api/${API_VER}/graphql.json`;
  const BATCH = 40;
  const result: Record<string, Array<{ name: string; available: number }>> = {};

  const query = `
    query GetInventoryLocations($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          inventoryItem {
            inventoryLevels(first: 20) {
              edges {
                node {
                  quantities(names: ["available"]) { name quantity }
                  location { id name }
                }
              }
            }
          }
        }
      }
    }
  `;

  for (let i = 0; i < variantGids.length; i += BATCH) {
    const batch = variantGids.slice(i, i + BATCH);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': adminToken,
        },
        body: JSON.stringify({ query, variables: { ids: batch } }),
      });
      if (!resp.ok) {
        console.error(`[sync-stores] location batch ${i}-${i + BATCH} failed: ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      if (json.errors) {
        console.error('[sync-stores] location batch errors:', JSON.stringify(json.errors));
        continue;
      }
      for (const node of (json.data?.nodes || [])) {
        if (!node?.id) continue;
        const edges = node.inventoryItem?.inventoryLevels?.edges || [];
        const locations = edges
          .map((e: any) => {
            const qtyEntry = (e.node?.quantities || []).find((q: any) => q.name === 'available');
            return {
              name: e.node?.location?.name || 'Unknown',
              available: qtyEntry?.quantity ?? 0,
            };
          })
          .sort((a: any, b: any) => b.available - a.available);
        result[node.id] = locations;
      }
    } catch (err) {
      console.error(`[sync-stores] location batch ${i} error:`, err);
    }
    // Small polite delay between batches (100 ms) to avoid throttling
    if (i + BATCH < variantGids.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return result;
}

serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!adminClient) return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const text = await req.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

    const { storeIds = [], organizationId = null, userId = null } = body || {};
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return new Response(JSON.stringify({ error: 'storeIds required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Resolve userId: prefer body param, fall back to JWT
    let resolvedUserId = userId;
    if (!resolvedUserId) {
      const authHeader = req.headers.get('Authorization');
      if (authHeader) {
        try {
          const token = authHeader.replace('Bearer ', '');
          const payload = JSON.parse(atob(token.split('.')[1]));
          resolvedUserId = payload.sub || null;
        } catch (_) {}
      }
    }

    // Load stores including admin token
    const { data: stores, error: storesErr } = await adminClient
      .from('stores')
      .select('id, name, domain, admin_token')
      .in('id', storeIds);
    if (storesErr) throw storesErr;

    const results = [];
    for (const store of stores) {
      try {
        const domain = normalizeDomain(store.domain);
        const adminToken = store.admin_token;
        if (!adminToken) {
          results.push({ storeId: store.id, ok: false, error: 'no_admin_token' });
          continue;
        }

        const currencyCode = await fetchStoreCurrency(domain, adminToken);
        const products = await fetchAllProductsForStore(domain, adminToken, currencyCode);

        // Prepare rows for upsert
        const rows = products.map((p) => ({
          user_id: resolvedUserId,
          organization_id: organizationId,
          store_id: store.id,
          shopify_product_id: String(p.productId || ''),
          shopify_variant_id: String(p.variantId || ''),
          data: p,
          updated_at: new Date().toISOString(),
        }));

        // Upsert in batches of 25
        const BATCH = 25;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error: upsertErr } = await adminClient.from('shopify_products').upsert(batch, { onConflict: 'store_id,shopify_variant_id' });
          if (upsertErr) throw upsertErr;
        }

        // Update sync status
        const syncStatusRow = {
          store_id: store.id,
          last_synced_at: new Date().toISOString(),
          organization_id: organizationId,
        };
        if (resolvedUserId) syncStatusRow.user_id = resolvedUserId;
        const { error: syncStatusErr } = await adminClient.from('shopify_store_sync_status').upsert(syncStatusRow, { onConflict: 'store_id' });
        if (syncStatusErr) console.error('[sync-stores] sync status upsert error:', syncStatusErr);

        // ----------------------------------------------------------------
        // Second pass: sync per-location inventory in cost-safe batches
        // ----------------------------------------------------------------
        const variantGids = products
          .map((p) => p.variantId)
          .filter((id) => id && String(id).startsWith('gid://shopify/ProductVariant/'));

        if (variantGids.length > 0) {
          try {
            const locationMap = await fetchInventoryLocationsForVariants(
              domain,
              adminToken,
              variantGids as string[],
            );

            const locationRows = Object.entries(locationMap).map(([variantGid, locs]) => ({
              store_id: store.id,
              shopify_variant_id: String(variantGid),
              organization_id: organizationId,
              locations: locs,
              synced_at: new Date().toISOString(),
            }));

            const LOC_BATCH = 100;
            for (let i = 0; i < locationRows.length; i += LOC_BATCH) {
              const batch = locationRows.slice(i, i + LOC_BATCH);
              const { error: locErr } = await adminClient
                .from('variant_inventory_locations')
                .upsert(batch, { onConflict: 'store_id,shopify_variant_id' });
              if (locErr) console.error('[sync-stores] location upsert error:', locErr);
            }
            console.log(`[sync-stores] synced ${locationRows.length} location rows for store ${store.id}`);
          } catch (locSyncErr) {
            // Location sync is best-effort — don't fail the whole sync
            console.error('[sync-stores] location sync error (non-fatal):', locSyncErr);
          }
        }

        // ----------------------------------------------------------------
        // Third pass: sync sales data (orders) into shopify_sales table
        // Best-effort — requires read_orders scope, won't fail the sync
        // ----------------------------------------------------------------
        try {
          const salesMap = await fetchSalesDataForStore(domain, adminToken);
          if (salesMap.size > 0) {
            const salesRows = Array.from(salesMap.entries()).map(([sku, { qty, amount }]) => ({
              store_id: store.id,
              organization_id: organizationId,
              sku,
              sales_qty: qty,
              sales_amount: amount,
              synced_at: new Date().toISOString(),
            }));
            const SALES_BATCH = 100;
            for (let i = 0; i < salesRows.length; i += SALES_BATCH) {
              const batch = salesRows.slice(i, i + SALES_BATCH);
              const { error: salesErr } = await adminClient
                .from('shopify_sales')
                .upsert(batch, { onConflict: 'store_id,sku' });
              if (salesErr) console.error('[sync-stores] sales upsert error:', salesErr);
            }
            console.log(`[sync-stores] synced ${salesRows.length} SKU sales rows for store ${store.id}`);
          }
        } catch (salesSyncErr) {
          // Sales sync is best-effort — don't fail the whole sync
          console.error('[sync-stores] sales sync error (non-fatal):', salesSyncErr);
        }

        results.push({ storeId: store.id, ok: true, imported: rows.length });
      } catch (err) {
        console.error('[sync-stores] store failed', store.id, err);
        const errMsg = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
        results.push({ storeId: store.id, ok: false, error: errMsg.substring(0,500) });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[sync-stores] Unhandled error', error);
    return new Response(JSON.stringify({ error: 'internal', message: error instanceof Error ? error.message : String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});