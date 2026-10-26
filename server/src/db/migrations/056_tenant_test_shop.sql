-- A staging test shop is marked on the tenant.
-- Nothing in this change sets the marker.
-- A shop that already exists stays false.
-- Postgres adds the column here. Boot DDL does not.
-- A leftover column is kept only when it is already
-- boolean NOT NULL DEFAULT false. Any other shape raises,
-- and the shop row is left as it was.

DO $$
DECLARE
  got record;
BEGIN
  SELECT c.data_type, c.udt_name, c.is_nullable, c.column_default
    INTO got
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name = 'tenants'
     AND c.column_name = 'is_test_shop';
  IF NOT FOUND THEN
    ALTER TABLE tenants
      ADD COLUMN is_test_shop boolean NOT NULL DEFAULT false;
    RETURN;
  END IF;
  IF got.data_type IS DISTINCT FROM 'boolean'
     OR got.udt_name IS DISTINCT FROM 'bool'
     OR got.is_nullable IS DISTINCT FROM 'NO'
     OR got.column_default IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION
      'tenants.is_test_shop has the wrong shape. It must be boolean NOT NULL DEFAULT false, or absent.';
  END IF;
END $$;
