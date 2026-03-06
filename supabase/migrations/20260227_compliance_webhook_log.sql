-- Compliance webhook audit log
-- Tracks all GDPR/privacy compliance webhook requests from Shopify.
-- Required for demonstrating compliance within Shopify's 30-day processing window.

CREATE TABLE IF NOT EXISTS compliance_webhook_log (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic        TEXT NOT NULL,                    -- e.g. customers/data_request, customers/redact, shop/redact
  shop_domain  TEXT NOT NULL,
  shop_id      BIGINT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'received', -- received | processing | processed | failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Index for quick lookups by shop and topic
CREATE INDEX IF NOT EXISTS idx_compliance_log_shop_domain ON compliance_webhook_log (shop_domain);
CREATE INDEX IF NOT EXISTS idx_compliance_log_topic       ON compliance_webhook_log (topic);
CREATE INDEX IF NOT EXISTS idx_compliance_log_created_at  ON compliance_webhook_log (created_at DESC);

-- Auto-set processed_at when status changes to 'processed'
CREATE OR REPLACE FUNCTION set_compliance_processed_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'processed' AND OLD.status IS DISTINCT FROM 'processed' THEN
    NEW.processed_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_processed_at
  BEFORE UPDATE ON compliance_webhook_log
  FOR EACH ROW
  EXECUTE FUNCTION set_compliance_processed_at();

-- RLS: Only service_role (Edge Functions) can read/write this table.
-- No user-facing access is needed.
ALTER TABLE compliance_webhook_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically, so no policies needed.
-- If you ever want dashboard admins to view logs, add a policy like:
-- CREATE POLICY "Admins can view compliance logs"
--   ON compliance_webhook_log FOR SELECT
--   USING (auth.uid() IN (SELECT user_id FROM organization_members WHERE role = 'owner'));

COMMENT ON TABLE compliance_webhook_log IS 'Audit log for Shopify mandatory privacy/GDPR compliance webhooks';
