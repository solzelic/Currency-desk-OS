-- NULL keeps the existing branch fallback. No default and no backfill.
-- IANA validation belongs to the service, not a database timezone catalogue.
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS timezone text;

-- Boot DDL may already have installed the column and its check. A legacy
-- database may have neither, or the column alone. Do not skip the check
-- merely because ADD COLUMN was a no-op.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'legal_entities'::regclass
      AND conname = 'legal_entities_timezone_nonblank'
  ) THEN
    ALTER TABLE legal_entities ADD CONSTRAINT legal_entities_timezone_nonblank
      CHECK (timezone IS NULL OR btrim(timezone) <> '');
  END IF;
END $$;
