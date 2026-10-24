-- numeric(24,2) money columns become unconstrained numeric. "722.10" stays "722.10".
DROP TRIGGER IF EXISTS ledger_till_balances_generation ON ledger_till_balances;
DO $$
DECLARE col record;
BEGIN
  FOR col IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type = 'numeric' AND c.numeric_scale = 2
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE numeric', col.table_schema, col.table_name, col.column_name);
  END LOOP;
END $$;
CREATE TRIGGER ledger_till_balances_generation
AFTER INSERT OR UPDATE OF available_amount ON ledger_till_balances
FOR EACH ROW EXECUTE FUNCTION ledger_bump_till_balance_generation();
