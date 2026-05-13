import { supabase } from './supabase';

/**
 * Fetches all paid orders and aggregates sales by SKU using the Orders GraphQL API.
 * Requires read_orders scope (works on all Shopify plans).
 * Paginates automatically using cursors until all orders are fetched.
 */
const ORDERS_QUERY = `
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
                discountedUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function callAdminApi(storeConfig, query, variables) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/shopify-admin-api`;

  const { data: sessionData } = await supabase.auth.getSession();
  const bearerToken = sessionData.session?.access_token;

  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify({
      shop: storeConfig.domain,
      query,
      variables,
      accessToken: storeConfig.adminToken,
      apiVersion: '2024-10',
    }),
  });

  if (!response.ok) {
    throw new Error(`API call failed (HTTP ${response.status}) for ${storeConfig.domain}`);
  }

  const json = await response.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join(', '));
  return json;
}

/**
 * @param {object} storeConfig – must have `domain` and `adminToken`
 * @returns {Promise<Map<string, {qty: number, amount: number}>>}
 */
export async function fetchSalesDataBySku(storeConfig) {
  const salesMap = new Map();
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const json = await callAdminApi(storeConfig, ORDERS_QUERY, { cursor });
    const ordersData = json.data?.orders;
    if (!ordersData) break;

    for (const { node: order } of ordersData.edges) {
      for (const { node: item } of order.lineItems.edges) {
        const sku = item.sku;
        if (!sku) continue;
        const qty = item.quantity || 0;
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

    hasNextPage = ordersData.pageInfo.hasNextPage;
    cursor = ordersData.pageInfo.endCursor;
  }

  return salesMap;
}
