-- Counter ID scan. The inquiry remembers which Didit method started it.
-- A document-only pass is not verified until the teller attests.
-- 085 is the Didit provider column. This file does not edit it.

ALTER TABLE idv_inquiries ADD COLUMN IF NOT EXISTS check_method text;
ALTER TABLE idv_inquiries DROP CONSTRAINT IF EXISTS idv_inquiries_check_method_known;
ALTER TABLE idv_inquiries ADD CONSTRAINT idv_inquiries_check_method_known
  CHECK (
    check_method IS NULL
    OR check_method IN ('id_and_selfie', 'counter_id_scan', 'counter_full')
  );

ALTER TABLE idv_inquiries ADD COLUMN IF NOT EXISTS id_scan_passed boolean;

ALTER TABLE idv_check_records DROP CONSTRAINT IF EXISTS idv_check_records_method_check;
ALTER TABLE idv_check_records DROP CONSTRAINT IF EXISTS idv_check_records_method_known;
ALTER TABLE idv_check_records ADD CONSTRAINT idv_check_records_method_known
  CHECK (method IN (
    'in_person', 'returning_client', 'id_and_selfie', 'id_selfie_database',
    'counter_id_scan', 'counter_full'
  ));

ALTER TABLE idv_check_records ADD COLUMN IF NOT EXISTS attestation_staff_id text;
ALTER TABLE idv_check_records ADD COLUMN IF NOT EXISTS attestation_role text;
ALTER TABLE idv_check_records ADD COLUMN IF NOT EXISTS attestation_at timestamptz;

CREATE TABLE IF NOT EXISTS idv_face_attestations (
  attestation_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  client_id text NOT NULL,
  reference_id text NOT NULL,
  staff_user_id text NOT NULL,
  staff_id text NOT NULL,
  role text NOT NULL,
  statement text NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idv_face_attestations_ref_idx
  ON idv_face_attestations (tenant_id, legal_entity_id, reference_id, attested_at DESC);

DROP TRIGGER IF EXISTS idv_face_attestations_append_only ON idv_face_attestations;
CREATE TRIGGER idv_face_attestations_append_only
  BEFORE UPDATE OR DELETE ON idv_face_attestations
  FOR EACH ROW EXECUTE FUNCTION idv_records_append_only();

DROP TRIGGER IF EXISTS idv_face_attestations_no_truncate ON idv_face_attestations;
CREATE TRIGGER idv_face_attestations_no_truncate
  BEFORE TRUNCATE ON idv_face_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION idv_records_append_only();
