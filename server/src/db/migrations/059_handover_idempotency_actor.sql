-- A till handover key remembers who sent it and a hash of the body.
-- A later call with another actor or another body is refused.
-- Older rows leave both columns NULL. Nothing backfills them.
ALTER TABLE ledger_idempotency
  ADD COLUMN actor_id text,
  ADD COLUMN request_hash text;
