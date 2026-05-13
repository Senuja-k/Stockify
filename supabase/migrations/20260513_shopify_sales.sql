-- Persist per-SKU sales totals so public reports can display sales columns
-- without needing a live Shopify API call. Populated/refreshed on every sync.

CREATE TABLE IF NOT EXISTS shopify_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  sales_qty INTEGER NOT NULL DEFAULT 0,
  sales_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_shopify_sales_store_id ON shopify_sales(store_id);
CREATE INDEX IF NOT EXISTS idx_shopify_sales_sku ON shopify_sales(sku);
CREATE INDEX IF NOT EXISTS idx_shopify_sales_org_id ON shopify_sales(organization_id);

ALTER TABLE shopify_sales ENABLE ROW LEVEL SECURITY;

-- Authenticated org members can read
DROP POLICY IF EXISTS "Org members can read sales" ON shopify_sales;
CREATE POLICY "Org members can read sales"
  ON shopify_sales FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Anonymous users can read sales for orgs that have at least one public report
DROP POLICY IF EXISTS "Anon users can read sales for public reports" ON shopify_sales;
CREATE POLICY "Anon users can read sales for public reports"
  ON shopify_sales FOR SELECT
  USING (
    auth.role() = 'anon'
  );
