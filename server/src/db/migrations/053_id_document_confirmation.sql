-- The teller's confirmation on two photo ID rows.
--
-- secure_card: the plastic Secure Certificate of Indian Status, not
-- the laminated card. A row without it is not that type.
-- in_person: the teller checked the original card with the person
-- there. The pre-2012 citizenship card requires it. Existing rows
-- stay false, so a card filed before this column does not become
-- the manual path on its own.
ALTER TABLE desk_client_identity_documents
  ADD COLUMN IF NOT EXISTS secure_card boolean NOT NULL DEFAULT false;

ALTER TABLE desk_client_identity_documents
  ADD COLUMN IF NOT EXISTS in_person boolean NOT NULL DEFAULT false;
