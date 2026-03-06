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

async function fetchAllProductsForStore(domain, adminToken) {
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
      updatedAt: product.updatedAt,
      createdAt: product.createdAt,
      image: (product.images?.edges?.[0]?.node?.url) || null,
      variantData: v,
      fullProduct: product,
    };
  });
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

        const products = await fetchAllProductsForStore(domain, adminToken);

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