-- A PIN proves one action, once (CD-140, GitHub #630, PR 2).
--
-- POST /api/staff/pin/verify with an action and a target mints a random
-- token for the PIN's owner, stored here as a hash, bound to that
-- action, that target and the shop, good for about two minutes and
-- usable once (server/src/routes/step-up.ts). The route that performs
-- the action spends it. Nothing here is the token itself.
CREATE TABLE IF NOT EXISTS staff_step_up_tokens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  staff_id text NOT NULL,
  issued_by text NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text
);
CREATE INDEX IF NOT EXISTS staff_step_up_tokens_staff_idx ON staff_step_up_tokens(staff_id, created_at);
