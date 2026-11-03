-- #617: the owner's till settings live on the server, one row per legal
-- entity. No row means the defaults: no count needed to switch, no large
-- difference alert, and the morning float asks.
CREATE TABLE IF NOT EXISTS ledger_till_settings (
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  require_count_on_switch boolean NOT NULL DEFAULT false,
  large_difference_alert boolean NOT NULL DEFAULT false,
  large_difference_amount numeric(18,2) CHECK (large_difference_amount IS NULL OR large_difference_amount >= 0),
  morning_float text NOT NULL DEFAULT 'ask' CHECK (morning_float IN ('ask', 'skip')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id)
);

-- What an audit row says in fields: a setting's old and new value, or a
-- switch count's home currency totals. Older rows leave it NULL.
ALTER TABLE ledger_audit_events ADD COLUMN IF NOT EXISTS detail jsonb;
