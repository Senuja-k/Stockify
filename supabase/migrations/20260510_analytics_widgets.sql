-- Analytics widgets table
-- Each row is one user-defined analytics widget persisted per user+org.

CREATE TABLE IF NOT EXISTS analytics_widgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid,
  title           text NOT NULL,
  display_type    text NOT NULL DEFAULT 'card',  -- 'card' | 'bar' | 'pie' | 'line' | 'area'
  aggregation     text NOT NULL DEFAULT 'sum',   -- 'sum' | 'count' | 'avg' | 'min' | 'max' | 'custom'
  column_key      text,                          -- field name from product rows (e.g. 'variantPrice')
  formula         text,                          -- JS expression for 'custom' aggregation
  group_by_column text,                          -- for charts: field to group by (e.g. 'vendor')
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

-- Row-level security: users only see/modify their own widgets
ALTER TABLE analytics_widgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own analytics widgets"
  ON analytics_widgets
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast per-user+org queries
CREATE INDEX IF NOT EXISTS idx_analytics_widgets_user_org
  ON analytics_widgets (user_id, organization_id);
