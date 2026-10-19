-- Persona webhook deliveries. Append-only. Ids, a status, and at most one ID type.
-- Persona's event id is the key, so a replayed delivery inserts nothing.
-- client_id is set only when Persona's reference-id is a client file.
-- id_type is a catalogue code the catalogue accepts as ID, or NULL. It is
-- never a health card. The name, the date of birth, and the document
-- number are not columns.
-- 047 is the last migration on main. Open drafts hold 041, 042, and 043.
-- So this file is 048.

CREATE TABLE IF NOT EXISTS persona_inquiry_events (
  event_id text PRIMARY KEY,
  inquiry_id text NOT NULL,
  event_name text NOT NULL,
  status text NOT NULL,
  id_type text CHECK (id_type IS NULL OR id_type <> 'health_card'),
  client_id text REFERENCES desk_clients(client_id),
  tenant_id text REFERENCES tenants(id),
  legal_entity_id text,
  environment text NOT NULL CHECK (environment IN ('sandbox','live','unknown')),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS persona_inquiry_events_client_idx
  ON persona_inquiry_events (client_id, received_at DESC);
CREATE INDEX IF NOT EXISTS persona_inquiry_events_inquiry_idx
  ON persona_inquiry_events (inquiry_id);

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
