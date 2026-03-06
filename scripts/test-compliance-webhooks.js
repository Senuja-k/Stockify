/**
 * Test script for Shopify compliance webhooks.
 *
 * Sends a properly HMAC-signed request to the webhook-handler Edge Function
 * to verify HMAC verification and topic routing work correctly.
 *
 * Usage:
 *   node scripts/test-compliance-webhooks.js
 *
 * Required env vars (set them or edit the defaults below):
 *   WEBHOOK_URL            – Full URL to the webhook-handler function
 *   SHOPIFY_CLIENT_SECRET  – Same secret the Edge Function uses for HMAC
 */

const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/*  Configuration – edit these or set via environment variables        */
/* ------------------------------------------------------------------ */

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "https://<YOUR_SUPABASE_PROJECT>.supabase.co/functions/v1/webhook-handler";

const CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET || "<YOUR_SHOPIFY_CLIENT_SECRET>";

/* ------------------------------------------------------------------ */
/*  Test payloads                                                     */
/* ------------------------------------------------------------------ */

const testPayloads = {
  "customers/data_request": {
    shop_id: 954889,
    shop_domain: "test-store.myshopify.com",
    orders_requested: [299938, 280263, 220458],
    customer: {
      id: 191167,
      email: "john@example.com",
      phone: "555-625-1199",
    },
    data_request: {
      id: 9999,
    },
  },

  "customers/redact": {
    shop_id: 954889,
    shop_domain: "test-store.myshopify.com",
    customer: {
      id: 191167,
      email: "john@example.com",
      phone: "555-625-1199",
    },
    orders_to_redact: [299938, 280263],
  },

  "shop/redact": {
    shop_id: 954889,
    shop_domain: "test-store.myshopify.com",
  },
};

/* ------------------------------------------------------------------ */
/*  HMAC signing helper                                               */
/* ------------------------------------------------------------------ */

function signPayload(body) {
  return crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(body, "utf8")
    .digest("base64");
}

/* ------------------------------------------------------------------ */
/*  Send a single test webhook                                        */
/* ------------------------------------------------------------------ */

async function sendWebhook(topic, payload) {
  const body = JSON.stringify(payload);
  const hmac = signPayload(body);

  console.log(`\n--- Testing topic: ${topic} ---`);
  console.log(`  HMAC: ${hmac}`);

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Shop-Domain": payload.shop_domain || "test-store.myshopify.com",
    },
    body,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  console.log(`  Status: ${res.status}`);
  console.log(`  Response:`, json);

  if (res.status !== 200) {
    console.error(`  ❌ FAILED – expected 200, got ${res.status}`);
  } else {
    console.log(`  ✅ PASSED`);
  }

  return res.status;
}

/* ------------------------------------------------------------------ */
/*  Also test with a BAD HMAC to ensure 401                           */
/* ------------------------------------------------------------------ */

async function testBadHmac() {
  const topic = "customers/data_request";
  const body = JSON.stringify(testPayloads[topic]);

  console.log(`\n--- Testing BAD HMAC (should return 401) ---`);

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": "this-is-not-a-valid-hmac",
      "X-Shopify-Shop-Domain": "test-store.myshopify.com",
    },
    body,
  });

  const text = await res.text();
  console.log(`  Status: ${res.status}`);
  console.log(`  Response:`, text);

  if (res.status === 401) {
    console.log(`  ✅ PASSED – correctly rejected invalid HMAC`);
  } else {
    console.error(`  ❌ FAILED – expected 401, got ${res.status}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Runner                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  console.log("=== Shopify Compliance Webhook Test Suite ===");
  console.log(`Endpoint: ${WEBHOOK_URL}`);
  console.log(`Secret:   ${CLIENT_SECRET.substring(0, 4)}...${CLIENT_SECRET.slice(-4)}`);

  // Test all three topics with valid HMAC
  for (const [topic, payload] of Object.entries(testPayloads)) {
    await sendWebhook(topic, payload);
  }

  // Test invalid HMAC rejection
  await testBadHmac();

  console.log("\n=== All tests complete ===");
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
