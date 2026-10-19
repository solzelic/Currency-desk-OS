-- Settings → Accepted IDs. The ID types this shop takes, as catalogue
-- codes (shared/id-document-types.js), such as passport or
-- drivers_licence.
--
-- NULL means the shop follows its jurisdiction pack. Every desk that
-- exists today is NULL, so none of them loses a type it uses. The pack
-- defaults and the types a pack locks off are code, in
-- server/src/ledger/id-type-rules.ts. They are not rows.
--
-- A stated set is never empty: the owner has to keep at least one
-- photo ID switched on. The server refuses an empty set, and so does
-- this constraint, for a row written from psql. It checks the shape
-- of each code and not the list itself, so a type added to the
-- catalogue later needs no migration.
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS accepted_id_types text[];

ALTER TABLE legal_entities DROP CONSTRAINT IF EXISTS legal_entities_accepted_id_types_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_accepted_id_types_check
  CHECK (
    accepted_id_types IS NULL
    OR accepted_id_types::text ~ '^\{[a-z][a-z_]*(,[a-z][a-z_]*)*\}$'
  );
