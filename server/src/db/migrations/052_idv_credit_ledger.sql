-- Append-only identity-check credits. Balance is SUM(amount).
-- Grant: amount > 0, no inquiry. Reserve holds 1 (amount -1).
-- Settle records a pass or decline and leaves that credit spent (amount 0).
-- Release returns it (amount 1). One row per type and inquiry.
-- Settle and release cannot both exist. 049 is #268, 050 is #267, 051 is #270.

CREATE TABLE idv_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id text NOT NULL,
  entry_type text NOT NULL,
  amount integer NOT NULL,
  inquiry_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  CONSTRAINT idv_credit_ledger_shape CHECK (
    (entry_type = 'grant' AND inquiry_id IS NULL AND amount > 0)
    OR (entry_type = 'reserve' AND inquiry_id IS NOT NULL AND amount = -1)
    OR (entry_type = 'settle' AND inquiry_id IS NOT NULL AND amount = 0)
    OR (entry_type = 'release' AND inquiry_id IS NOT NULL AND amount = 1)
  )
);

CREATE UNIQUE INDEX idv_credit_ledger_type_inquiry
  ON idv_credit_ledger (entry_type, inquiry_id) WHERE inquiry_id IS NOT NULL;
CREATE UNIQUE INDEX idv_credit_ledger_one_close
  ON idv_credit_ledger (inquiry_id) WHERE entry_type IN ('settle', 'release');
CREATE INDEX idv_credit_ledger_shop_idx ON idv_credit_ledger (shop_id);

CREATE TRIGGER idv_credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON idv_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
