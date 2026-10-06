-- Fractional order keys (base62 "lexorank"-style strings) must compare byte-by-byte.
-- With the database's default locale collation, comparison is case-insensitive, so
-- 'aVXFZhhh' sorts before 'aVXFZhRd' and rows/fields/views appear in the wrong order
-- (and keyset cursors skip or repeat rows). Switch every order-key column to "C".
-- Postgres rebuilds dependent indexes automatically.

ALTER TABLE core.base_directory  ALTER COLUMN order_key    TYPE text COLLATE "C";
ALTER TABLE data.tables          ALTER COLUMN order_key    TYPE text COLLATE "C";
ALTER TABLE data.fields          ALTER COLUMN order_key    TYPE text COLLATE "C";
ALTER TABLE data.records         ALTER COLUMN manual_order TYPE text COLLATE "C";
ALTER TABLE data.view_sections   ALTER COLUMN order_key    TYPE text COLLATE "C";
ALTER TABLE data.views           ALTER COLUMN order_key    TYPE text COLLATE "C";
ALTER TABLE data.record_links    ALTER COLUMN a_order      TYPE text COLLATE "C";
ALTER TABLE data.record_links    ALTER COLUMN b_order      TYPE text COLLATE "C";
