-- The handover audit row names the old session, the count batch,
-- the role the actor's session held, and the user the till came from.
-- Those facts used to live only inside the reason text.
-- created_at for that row is clock_timestamp(), written by the insert.
-- Older rows leave the four columns NULL. Nothing backfills them.
ALTER TABLE ledger_audit_events
  ADD COLUMN prior_session_id text,
  ADD COLUMN count_batch_id text,
  ADD COLUMN actor_role text,
  ADD COLUMN from_user text;
