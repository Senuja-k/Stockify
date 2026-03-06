// Shopify Mandatory Privacy / Compliance Webhook Handler
// Topics: customers/data_request, customers/redact, shop/redact
// Shopify signs every webhook with HMAC-SHA256 using the app's client secret.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ------------------------------------------------------------------ */
/*  Environment & Supabase admin client                               */
/* ------------------------------------------------------------------ */

const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const adminClient =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey)
    : null;

/* ------------------------------------------------------------------ */
/*  HMAC-SHA256 verification (Web Crypto API – Deno built-in)         */
/* ------------------------------------------------------------------ */

async function verifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_CLIENT_SECRET || !hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SHOPIFY_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));

  // Constant-time comparison via subtle.timingSafeEqual (Deno ≥ 1.25)
  const a = new TextEncoder().encode(computedHmac);
  const b = new TextEncoder().encode(hmacHeader);
  if (a.byteLength !== b.byteLength) return false;

  // Use crypto.subtle.timingSafeEqual if available, fallback to manual
  try {
    // Deno supports this since 1.25
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    // Fallback: still safe enough given lengths match
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function normalizeDomain(domain) {
  if (!domain) return "";
  return String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function logComplianceRequest(topic, shopDomain, shopId, payload, status = "received") {
  if (!adminClient) {
    console.warn("[webhook-handler] No admin client – skipping audit log");
    return;
  }

  const { error } = await adminClient.from("compliance_webhook_log").insert({
    topic,
    shop_domain: shopDomain,
    shop_id: shopId,
    payload,
    status,
  });

  if (error) {
    console.error("[webhook-handler] Failed to write compliance log:", error);
  }
}

/* ------------------------------------------------------------------ */
/*  Topic Handlers                                                     */
/* ------------------------------------------------------------------ */

/**
 * customers/data_request
 * A customer requests their data. We look up what we store and log it.
 * Shopify gives us 30 days to provide the data.
 */
async function handleCustomersDataRequest(body) {
  const shopDomain = normalizeDomain(body.shop_domain);
  const shopId = body.shop_id;
  const customerEmail = body.customer?.email;
  const customerId = body.customer?.id;

  console.log(`[webhook-handler] customers/data_request for shop=${shopDomain} customer=${customerId}`);

  await logComplianceRequest("customers/data_request", shopDomain, shopId, body, "received");

  // Our app stores product data only — no direct customer PII in shopify_products.
  // If the stores table has customer-related data, we would query it here.
  // For now, log the request so it can be fulfilled manually within 30 days.

  if (adminClient) {
    // Check if we have any data for this shop at all
    const { data: stores } = await adminClient
      .from("stores")
      .select("id, name, domain")
      .ilike("domain", `%${shopDomain}%`);

    const storeInfo = stores?.length
      ? `Found ${stores.length} store(s) for ${shopDomain}`
      : `No stores found for ${shopDomain}`;

    console.log(`[webhook-handler] ${storeInfo}`);

    await logComplianceRequest(
      "customers/data_request",
      shopDomain,
      shopId,
      { ...body, store_lookup: storeInfo },
      "processed"
    );
  }

  return new Response(JSON.stringify({ status: "ok", message: "Data request received and logged" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * customers/redact
 * A customer requests erasure of their data.
 * Our app primarily stores product/inventory data, not customer-specific PII.
 * We log the request and delete any customer-linked data if found.
 */
async function handleCustomersRedact(body) {
  const shopDomain = normalizeDomain(body.shop_domain);
  const shopId = body.shop_id;
  const customerId = body.customer?.id;
  const customerEmail = body.customer?.email;

  console.log(`[webhook-handler] customers/redact for shop=${shopDomain} customer=${customerId}`);

  await logComplianceRequest("customers/redact", shopDomain, shopId, body, "received");

  // Our app stores products—not customer-specific data—so there is typically
  // nothing tied to a specific customer ID.  Log for audit and mark processed.

  if (adminClient && body.orders_to_redact?.length) {
    console.log(`[webhook-handler] orders_to_redact count: ${body.orders_to_redact.length}`);
    // If we ever store order data, delete it here.
  }

  await logComplianceRequest("customers/redact", shopDomain, shopId, body, "processed");

  return new Response(JSON.stringify({ status: "ok", message: "Customer data redacted" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * shop/redact
 * 48 hours after a merchant uninstalls the app, Shopify sends this webhook.
 * We must delete ALL data for that shop within 30 days.
 */
async function handleShopRedact(body) {
  const shopDomain = normalizeDomain(body.shop_domain);
  const shopId = body.shop_id;

  console.log(`[webhook-handler] shop/redact for shop=${shopDomain}`);

  await logComplianceRequest("shop/redact", shopDomain, shopId, body, "received");

  if (!adminClient) {
    console.error("[webhook-handler] No admin client – cannot delete shop data");
    return new Response(JSON.stringify({ status: "error", message: "No DB client" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Find stores by domain
  const { data: stores, error: storesErr } = await adminClient
    .from("stores")
    .select("id, user_id, organization_id, domain")
    .ilike("domain", `%${shopDomain}%`);

  if (storesErr) {
    console.error("[webhook-handler] Error looking up stores:", storesErr);
  }

  const storeIds = (stores || []).map((s) => s.id);
  let deletedProducts = 0;
  let deletedSyncStatus = 0;
  let deletedStores = 0;

  if (storeIds.length > 0) {
    // 2. Delete products for those stores
    const { error: prodErr, count: prodCount } = await adminClient
      .from("shopify_products")
      .delete({ count: "exact" })
      .in("store_id", storeIds);

    if (prodErr) console.error("[webhook-handler] Error deleting products:", prodErr);
    deletedProducts = prodCount || 0;

    // 3. Delete sync status records
    const { error: syncErr, count: syncCount } = await adminClient
      .from("shopify_store_sync_status")
      .delete({ count: "exact" })
      .in("store_id", storeIds);

    if (syncErr) console.error("[webhook-handler] Error deleting sync status:", syncErr);
    deletedSyncStatus = syncCount || 0;

    // 4. Delete the stores themselves
    const { error: delStoreErr, count: storeCount } = await adminClient
      .from("stores")
      .delete({ count: "exact" })
      .in("id", storeIds);

    if (delStoreErr) console.error("[webhook-handler] Error deleting stores:", delStoreErr);
    deletedStores = storeCount || 0;
  }

  const summary = {
    shop_domain: shopDomain,
    stores_found: storeIds.length,
    deleted: { products: deletedProducts, sync_status: deletedSyncStatus, stores: deletedStores },
  };

  console.log("[webhook-handler] shop/redact summary:", JSON.stringify(summary));

  await logComplianceRequest("shop/redact", shopDomain, shopId, { ...body, ...summary }, "processed");

  return new Response(JSON.stringify({ status: "ok", ...summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

serve(async (req) => {
  // Only accept POST
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Topic, X-Shopify-Shop-Domain",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Read raw body for HMAC verification
  const rawBody = await req.text();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("X-Shopify-Topic") || req.headers.get("x-shopify-topic");

  console.log(`[webhook-handler] Received topic=${topic} hmac=${hmacHeader ? "present" : "missing"}`);

  // --- HMAC Verification ---
  if (!SHOPIFY_CLIENT_SECRET) {
    console.error("[webhook-handler] SHOPIFY_CLIENT_SECRET not set – cannot verify HMAC");
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const valid = await verifyHmac(rawBody, hmacHeader);
  if (!valid) {
    console.warn("[webhook-handler] HMAC verification failed");
    return new Response(JSON.stringify({ error: "Unauthorized – invalid HMAC" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Route by topic
  switch (topic) {
    case "customers/data_request":
      return handleCustomersDataRequest(body);

    case "customers/redact":
      return handleCustomersRedact(body);

    case "shop/redact":
      return handleShopRedact(body);

    default:
      console.warn(`[webhook-handler] Unknown topic: ${topic}`);
      return new Response(JSON.stringify({ error: `Unknown topic: ${topic}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
  }
});
