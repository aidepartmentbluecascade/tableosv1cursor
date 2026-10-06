-- Wave 2: trash restore unit for soft-deleted records
ALTER TABLE data.records
  ADD COLUMN IF NOT EXISTS deletion_batch_id uuid REFERENCES data.deletion_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS records_deletion_batch_idx
  ON data.records (deletion_batch_id)
  WHERE deletion_batch_id IS NOT NULL;
