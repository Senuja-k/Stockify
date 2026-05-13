import { supabase } from '@/lib/supabase';

const INVENTORY_QUERY = `
  query GetVariantInventory($id: ID!) {
    productVariant(id: $id) {
      inventoryItem {
        inventoryLevels(first: 20) {
          edges {
            node {
              quantities(names: ["available"]) {
                name
                quantity
              }
              location {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch per-location inventory for a single variant on demand.
 * Uses the shopify-admin-api edge function proxy.
 *
 * @param {{ domain: string, adminToken: string }} storeConfig
 * @param {string} variantId  e.g. "gid://shopify/ProductVariant/12345"
 * @returns {Promise<Array<{name: string, available: number}>>}
 */
export async function fetchInventoryLocations(storeConfig, variantId) {
  if (!storeConfig?.adminToken) throw new Error('No admin token — reconnect the store to enable live inventory lookup.');

  // Normalize variant ID to GID format (sync-stores stores GIDs; older syncs stored numeric IDs)
  const normalizedId = variantId?.startsWith?.('gid://') ? variantId : `gid://shopify/ProductVariant/${variantId}`;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shopify-admin-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        shop: storeConfig.domain,
        accessToken: storeConfig.adminToken,
        query: INVENTORY_QUERY,
        variables: { id: normalizedId },
      }),
    }
  );

  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const edges = json.data?.productVariant?.inventoryItem?.inventoryLevels?.edges || [];
  return edges
    .map((e) => {
      const node = e?.node;
      let available = 0;
      if (Array.isArray(node?.quantities)) {
        const avail = node.quantities.find((q) => q.name === 'available');
        if (avail) available = avail.quantity ?? 0;
      }
      return { name: node?.location?.name || 'Unknown', available };
    })
    .sort((a, b) => b.available - a.available);
}
