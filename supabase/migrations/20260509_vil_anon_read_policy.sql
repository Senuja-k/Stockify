-- Allow anonymous (public report) users to read per-location inventory
DROP POLICY IF EXISTS "Anon users can read inventory locations" ON variant_inventory_locations;
CREATE POLICY "Anon users can read inventory locations"
  ON variant_inventory_locations FOR SELECT
  USING (auth.role() = 'anon');
