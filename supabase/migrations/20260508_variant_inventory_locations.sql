-- Stores per-location inventory data synced from Shopify, separate from the
-- main shopify_products table so that a single expensive nested query isn't
-- needed during the product sync. The sync-stores function populates this
-- table in a second pass using batched nodes(ids:[...]) queries (≤40
-- variants each, cost ≈840 — under Shopify's 1000-point limit).

CREATE TABLE IF NOT EXISTS variant_inventory_locations (
  id                 uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id           uuid        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_variant_id text        NOT NULL,
  organization_id    uuid,
  locations          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT variant_inventory_locations_store_variant_key UNIQUE (store_id, shopify_variant_id)
);

CREATE INDEX IF NOT EXISTS vil_store_id_idx    ON variant_inventory_locations (store_id);
CREATE INDEX IF NOT EXISTS vil_variant_id_idx  ON variant_inventory_locations (shopify_variant_id);
CREATE INDEX IF NOT EXISTS vil_org_id_idx      ON variant_inventory_locations (organization_id);

ALTER TABLE variant_inventory_locations ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read (the query always filters by store_id which
-- is already scoped to the user's stores via the application logic).
DROP POLICY IF EXISTS "Authenticated users can read inventory locations" ON variant_inventory_locations;
CREATE POLICY "Authenticated users can read inventory locations"
  ON variant_inventory_locations FOR SELECT
  USING (auth.role() = 'authenticated');

-- Allow anon reads so public report viewers can see per-location inventory
DROP POLICY IF EXISTS "Anon users can read inventory locations" ON variant_inventory_locations;
CREATE POLICY "Anon users can read inventory locations"
  ON variant_inventory_locations FOR SELECT
  USING (auth.role() = 'anon');
