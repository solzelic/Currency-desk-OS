-- Persona inquiry events. Append-only. Ids and a status only.
-- A client id is set when Persona's reference-id is that client.
-- The name, the date of birth, and the document number are not columns.
-- 040 is on main, so this file is 041.

CREATE TABLE IF NOT EXISTS persona_inquiry_events (
  event_id text PRIMARY KEY,
  inquiry_id text NOT NULL,
  event_name text NOT NULL,
  status text NOT NULL,
  client_id text REFERENCES desk_clients(client_id),
  tenant_id text REFERENCES tenants(id),
  legal_entity_id text,
  environment text NOT NULL CHECK (environment IN ('sandbox','live','unknown')),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS persona_inquiry_events_client_idx
  ON persona_inquiry_events (client_id, received_at DESC);

CREATE OR REPLACE FUNCTION persona_inquiry_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'persona inquiry events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS persona_inquiry_events_immutable ON persona_inquiry_events;
CREATE TRIGGER persona_inquiry_events_immutable
  BEFORE UPDATE OR DELETE ON persona_inquiry_events
  FOR EACH ROW EXECUTE FUNCTION persona_inquiry_events_append_only();
