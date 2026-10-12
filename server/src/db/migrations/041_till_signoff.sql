/* One signed close of day per till session.

   The phone used to keep the sheet in localStorage. A second browser,
   and the book, never saw it. The snapshot is the figures the server
   had at the moment of the signature. The PDF is those same figures,
   frozen, so a later change to the renderer does not rewrite a sheet
   somebody already signed. */
CREATE TABLE IF NOT EXISTS ledger_till_signoffs (
  signoff_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  session_id text NOT NULL,
  idempotency_key text NOT NULL,
  not_counted boolean NOT NULL,
  snapshot jsonb NOT NULL,
  pdf bytea NOT NULL,
  signed_by text NOT NULL,
  signed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, session_id),
  UNIQUE (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, idempotency_key)
);
