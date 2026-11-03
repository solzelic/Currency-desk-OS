-- Which kind of database this is (#609 PR B). One 'staging' row means
-- staging; no row, or anything else, means live. The table is insert
-- only: a trigger refuses UPDATE, DELETE and TRUNCATE for every role.
-- Only the CLI (server/src/staging/cli.ts, mark-db) inserts, and only on a
-- staging runtime; a source-scan test keeps every other file from it.
-- The app and the migrations share one database role today, so this is
-- not a role grant; role separation is deferred (P3, parked).
CREATE TABLE IF NOT EXISTS db_environment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('staging')),
  inserted_by text NOT NULL DEFAULT current_user,
  inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION db_environment_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'db_environment is insert only';
END $$;

DROP TRIGGER IF EXISTS db_environment_no_change ON db_environment;
CREATE TRIGGER db_environment_no_change BEFORE UPDATE OR DELETE ON db_environment
  FOR EACH ROW EXECUTE FUNCTION db_environment_insert_only();
DROP TRIGGER IF EXISTS db_environment_no_truncate ON db_environment;
CREATE TRIGGER db_environment_no_truncate BEFORE TRUNCATE ON db_environment
  FOR EACH STATEMENT EXECUTE FUNCTION db_environment_insert_only();

-- The shop the staging seed job owns. Written only by that job
-- (server/src/staging/pin-reset.ts); no route sets it.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seeded_by text;
