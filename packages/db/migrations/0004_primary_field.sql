-- Add primary_field_id (circular with fields; FK deferred)
ALTER TABLE data.tables
  ADD COLUMN IF NOT EXISTS primary_field_id uuid;

ALTER TABLE data.tables
  DROP CONSTRAINT IF EXISTS tables_primary_field_fk;

ALTER TABLE data.tables
  ADD CONSTRAINT tables_primary_field_fk
  FOREIGN KEY (primary_field_id)
  REFERENCES data.fields(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
