/* ============================================================
   The customer's file folder, on the server.

   Proof of address, source of funds and corporate filings lived in
   `cdos_clients_v1` as `docs[]`: a data URL inside the same document
   that holds the desk's settings. That is one browser. The second till
   cannot see the file, a cleared cache destroys it, and the four-megabyte
   saving ceiling counts every byte of it. Identity scans already moved
   (migration 019). These are the same kind of evidence and they were
   left behind.

   They are NOT identity documents. `verification_status` is derived from
   `desk_client_identity_documents` — a utility bill with a number on it
   must not flip a customer to "identified". So they are a third purpose
   on `desk_client_images`, with no document_id, and nothing in this
   migration writes `verification_status`.

   The blob key is left in place, for the same reason 019 left it: a
   browser that has not reloaded still replicates `cdos_clients_v1`, and
   deleting the key here would look like a deletion that browser then
   wins. The Clients screen drops a local copy once the server holds the
   same file.
   ============================================================ */

ALTER TABLE desk_client_images DROP CONSTRAINT IF EXISTS desk_client_images_purpose_check;
ALTER TABLE desk_client_images DROP CONSTRAINT IF EXISTS desk_client_images_purpose_shape;

ALTER TABLE desk_client_images
  ADD CONSTRAINT desk_client_images_purpose_check
  CHECK (purpose IN ('identity_document', 'client_photograph', 'supporting_file'));

ALTER TABLE desk_client_images
  ADD CONSTRAINT desk_client_images_purpose_shape CHECK (
    (purpose = 'identity_document' AND document_id IS NOT NULL) OR
    (purpose = 'client_photograph' AND document_id IS NULL) OR
    (purpose = 'supporting_file' AND document_id IS NULL)
  );

ALTER TABLE desk_client_images ADD COLUMN IF NOT EXISTS file_name text;

/* Helpers for the length of this migration. 019 created the same two
   and dropped them; they are not still sitting there. Dropped again at
   the bottom so a later migration is not coupled to them. */
CREATE OR REPLACE FUNCTION cdos_migration_try_jsonb(input text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION cdos_migration_date(input text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF input IS NULL OR btrim(input) = '' THEN RETURN NULL; END IF;
  RETURN btrim(input)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$fn$;

/* One bad data URL must not abort the copy. A row that will not render
   for an examiner is worse than an absent one, and a single broken file
   must not leave every other customer's folder in the browser. */
CREATE OR REPLACE FUNCTION cdos_file_migration_decode(input text)
RETURNS TABLE (mime text, raw bytea)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  body text;
BEGIN
  IF input IS NULL OR input !~ '^data:(image/|application/pdf)' THEN
    RETURN;
  END IF;
  mime := substring(input from '^data:([a-zA-Z0-9.+/-]+);base64,');
  body := substring(input from ';base64,(.*)$');
  IF mime IS NULL OR body IS NULL OR btrim(body) = '' THEN
    RETURN;
  END IF;
  IF mime NOT LIKE 'image/%' AND mime <> 'application/pdf' THEN
    RETURN;
  END IF;
  BEGIN
    raw := decode(body, 'base64');
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF raw IS NULL OR octet_length(raw) = 0 OR octet_length(raw) > 4 * 1024 * 1024 THEN
    RETURN;
  END IF;
  RETURN NEXT;
END;
$fn$;

INSERT INTO desk_client_images
  (image_id, client_id, tenant_id, legal_entity_id, purpose, document_id,
   content_type, byte_size, sha256, bytes, label, file_name, captured_by, captured_at)
SELECT 'img_' || gen_random_uuid(),
       c.client_id, c.tenant_id, c.legal_entity_id,
       'supporting_file', NULL,
       decoded.mime, octet_length(decoded.raw),
       encode(sha256(decoded.raw), 'hex'), decoded.raw,
       nullif(btrim(coalesce(doc.value->>'label', '')), ''),
       nullif(btrim(coalesce(doc.value->>'fileName', '')), ''),
       'migration:026',
       coalesce(cdos_migration_date(doc.value->>'addedAt')::timestamptz, now())
  FROM tenant_state s
  JOIN (
    SELECT DISTINCT ON (tenant_id) tenant_id, id AS legal_entity_id
      FROM legal_entities
     ORDER BY tenant_id, created_at, id
  ) e ON e.tenant_id = s.tenant_id
  CROSS JOIN LATERAL jsonb_each(
    coalesce(cdos_migration_try_jsonb(s.state->>'cdos_clients_v1'), '{}'::jsonb)
  ) AS entry(key, value)
  JOIN desk_clients c
    ON c.tenant_id = s.tenant_id
   AND c.legal_entity_id = e.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(entry.key), '\s+', ' ', 'g'))
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(entry.value->'docs') = 'array'
         THEN entry.value->'docs' ELSE '[]'::jsonb END
  ) AS doc(value)
  CROSS JOIN LATERAL cdos_file_migration_decode(doc.value->>'file') AS decoded
 WHERE s.state ? 'cdos_clients_v1'
   AND jsonb_typeof(entry.value) = 'object'
   AND jsonb_typeof(doc.value) = 'object'
   AND NOT EXISTS (
     SELECT 1 FROM desk_client_images existing
      WHERE existing.client_id = c.client_id
        AND existing.purpose = 'supporting_file'
        AND existing.sha256 = encode(sha256(decoded.raw), 'hex')
   );

DROP FUNCTION IF EXISTS cdos_file_migration_decode(text);
DROP FUNCTION IF EXISTS cdos_migration_try_jsonb(text);
DROP FUNCTION IF EXISTS cdos_migration_date(text);
