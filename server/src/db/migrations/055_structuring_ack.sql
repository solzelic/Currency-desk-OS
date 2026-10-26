/* Each acknowledgement of one customer on the structuring watch is its own row.
   A later acknowledgement does not replace an earlier one.
   The row stores the deals it saw and the actor role from the session.
   Update, delete, and truncate are refused.
   A teller is refused before this table is written.
   ledger_structuring_acks may exist on staging from a branch preview.
   This migration never reads or writes that table. */
CREATE TABLE IF NOT EXISTS ledger_structuring_watch_acks (
  ack_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  deal_ids text[] NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  spec record;
  got record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('ack_id', 'bigint', 'int8', 'YES', 'ALWAYS'),
      ('tenant_id', 'text', 'text', 'NO', NULL),
      ('legal_entity_id', 'text', 'text', 'NO', NULL),
      ('branch_id', 'text', 'text', 'NO', NULL),
      ('customer_id', 'text', 'text', 'NO', NULL),
      ('actor_id', 'text', 'text', 'NO', NULL),
      ('actor_role', 'text', 'text', 'NO', NULL),
      ('deal_ids', 'ARRAY', '_text', 'NO', NULL),
      ('acknowledged_at', 'timestamp with time zone', 'timestamptz', 'NO', NULL)
    ) AS v(name, data_type, udt_name, is_identity, identity_generation)
  LOOP
    SELECT c.data_type, c.udt_name, c.is_nullable, c.is_identity, c.identity_generation
      INTO got
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'ledger_structuring_watch_acks'
       AND c.column_name = spec.name;
    IF NOT FOUND
       OR got.is_nullable <> 'NO'
       OR got.data_type <> spec.data_type
       OR got.udt_name <> spec.udt_name
       OR got.is_identity <> spec.is_identity
       OR got.identity_generation IS DISTINCT FROM spec.identity_generation
    THEN
      RAISE EXCEPTION
        'ledger_structuring_watch_acks exists with an old schema (column % missing or wrong). Drop the stray table on this database before migrating.',
        spec.name;
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS ledger_structuring_watch_acks_customer
  ON ledger_structuring_watch_acks (
    tenant_id, legal_entity_id, branch_id, customer_id,
    acknowledged_at DESC, ack_id DESC
  );

CREATE OR REPLACE TRIGGER ledger_structuring_watch_acks_append_only
  BEFORE UPDATE OR DELETE ON ledger_structuring_watch_acks
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE OR REPLACE TRIGGER ledger_structuring_watch_acks_no_truncate
  BEFORE TRUNCATE ON ledger_structuring_watch_acks
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

DO $$
BEGIN
  IF (
    SELECT count(*)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public'
       AND c.relname = 'ledger_structuring_watch_acks'
       AND t.tgname IN (
         'ledger_structuring_watch_acks_append_only',
         'ledger_structuring_watch_acks_no_truncate'
       )
       AND t.tgenabled <> 'D'
       AND p.proname = 'ledger_append_only'
  ) <> 2 THEN
    RAISE EXCEPTION
      'ledger_structuring_watch_acks is missing an enabled ledger_append_only trigger.';
  END IF;
END $$;
