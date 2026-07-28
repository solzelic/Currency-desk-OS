-- A staff member may work from more than one authorized till. Preserve one
-- authorization row per exact ledger scope instead of moving a single row.
ALTER TABLE ledger_principals DROP CONSTRAINT IF EXISTS ledger_principals_pkey;
ALTER TABLE ledger_principals
  ADD PRIMARY KEY (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id);

ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE ledger_customers
   SET created_at=COALESCE(created_at,now()),
       updated_at=COALESCE(updated_at,now());

ALTER TABLE ledger_customers ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE ledger_customers ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE ledger_customers ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE ledger_customers ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_customers_scope_external_ref_unique
  ON ledger_customers (tenant_id,legal_entity_id,branch_id,workspace_id,external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_customers_scope_name_idx
  ON ledger_customers (tenant_id,legal_entity_id,branch_id,workspace_id,name);
