-- 038 is the last migration on main. 039 is the live-cheque index, on
-- the other open pull request, so this file is 040. The runner sorts
-- by id and skips an id it has already recorded, so either request
-- can merge first.
--
-- One mark per till, bumped whenever the cash in that drawer changes.
-- A close names the mark it counted against. If the mark has moved,
-- the count is of a drawer that no longer exists, and writing it back
-- would erase whatever landed in the meantime.

CREATE TABLE IF NOT EXISTS ledger_till_balance_generations (
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  generation bigint NOT NULL,
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, till_id)
);

INSERT INTO ledger_till_balance_generations (
  tenant_id, legal_entity_id, branch_id, workspace_id, till_id, generation
)
SELECT DISTINCT tenant_id, legal_entity_id, branch_id, workspace_id, till_id, 0
  FROM ledger_till_balances
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ledger_bump_till_balance_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.available_amount IS NOT DISTINCT FROM OLD.available_amount THEN
    RETURN NULL;
  END IF;
  INSERT INTO ledger_till_balance_generations (
    tenant_id, legal_entity_id, branch_id, workspace_id, till_id, generation
  ) VALUES (
    NEW.tenant_id, NEW.legal_entity_id, NEW.branch_id, NEW.workspace_id, NEW.till_id, 1
  )
  ON CONFLICT (tenant_id, legal_entity_id, branch_id, workspace_id, till_id)
  DO UPDATE SET generation = ledger_till_balance_generations.generation + 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ledger_till_balances_generation ON ledger_till_balances;
CREATE TRIGGER ledger_till_balances_generation
AFTER INSERT OR UPDATE OF available_amount ON ledger_till_balances
FOR EACH ROW
EXECUTE FUNCTION ledger_bump_till_balance_generation();
