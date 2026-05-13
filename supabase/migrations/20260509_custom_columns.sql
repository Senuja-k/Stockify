-- Custom columns table: stores user-defined computed columns per organization
CREATE TABLE IF NOT EXISTS custom_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid,
  name text NOT NULL,
  formula text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE custom_columns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own custom columns"
  ON custom_columns
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS custom_columns_user_id_idx ON custom_columns(user_id);
CREATE INDEX IF NOT EXISTS custom_columns_org_id_idx ON custom_columns(organization_id);
