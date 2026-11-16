-- ID check records for Persona PR 2a. Append-only.
-- The full document number and the face crop are ciphertext.
-- No full ID image, no selfie, and no photo URL is stored.
-- 080 is the highest number claimed by an open PR, so this file is 081.

ALTER TABLE branches ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_province_len;
ALTER TABLE branches ADD CONSTRAINT branches_province_len
  CHECK (province IS NULL OR char_length(btrim(province)) BETWEEN 1 AND 40);
UPDATE branches SET province = 'ON' WHERE id = 'br-yorkville' AND province IS NULL;

ALTER TABLE idv_inquiries ADD COLUMN IF NOT EXISTS requested_tier text;
ALTER TABLE idv_inquiries DROP CONSTRAINT IF EXISTS idv_inquiries_requested_tier_check;
ALTER TABLE idv_inquiries ADD CONSTRAINT idv_inquiries_requested_tier_check
  CHECK (requested_tier IS NULL OR requested_tier IN ('1', '2', '3', '4'));

ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS template_id_tier3 text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS template_id_tier4 text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS privacy_contact text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS privacy_email text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS privacy_phone text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS privacy_policy_url text;
ALTER TABLE idv_shop_config ADD COLUMN IF NOT EXISTS face_crop_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE idv_shop_config DROP CONSTRAINT IF EXISTS idv_shop_config_template_tier3_shape;
ALTER TABLE idv_shop_config ADD CONSTRAINT idv_shop_config_template_tier3_shape CHECK (
  template_id_tier3 IS NULL OR (
    char_length(template_id_tier3) BETWEEN 1 AND 80
    AND template_id_tier3 ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  )
);
ALTER TABLE idv_shop_config DROP CONSTRAINT IF EXISTS idv_shop_config_template_tier4_shape;
ALTER TABLE idv_shop_config ADD CONSTRAINT idv_shop_config_template_tier4_shape CHECK (
  template_id_tier4 IS NULL OR (
    char_length(template_id_tier4) BETWEEN 1 AND 80
    AND template_id_tier4 ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  )
);

CREATE TABLE IF NOT EXISTS idv_consents (
  consent_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  client_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  copy_version text NOT NULL,
  language text NOT NULL,
  inquiry_id text,
  choice text NOT NULL CHECK (choice IN ('agreed', 'counter_check')),
  staff_id text NOT NULL,
  face_crop_shown boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS idv_check_records (
  record_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  client_id text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('1', '2', '3', '4')),
  method text NOT NULL CHECK (method IN ('in_person', 'returning_client', 'id_and_selfie', 'id_selfie_database')),
  name_on_id text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  document_type text,
  persona_id_class text,
  document_number_ciphertext text,
  document_number_last4 text,
  issuing_jurisdiction text,
  issuing_country text,
  expiry_date date,
  result text NOT NULL CHECK (result IN ('pass', 'declined', 'needs_review', 'method_not_completed')),
  provider_checks text,
  persona_inquiry_id text,
  government_id_verification_id text,
  selfie_verification_id text,
  template_id text,
  template_version text,
  staff_id text NOT NULL,
  inspector_staff_id text,
  attestation text,
  confirmed_by_staff_id text,
  original_record_id text,
  consent_id text,
  counter_check_chosen boolean NOT NULL DEFAULT false,
  deal_id text,
  address_line text,
  date_of_birth date,
  database_step text NOT NULL DEFAULT 'not_applicable' CHECK (database_step IN ('off', 'not_applicable')),
  face_crop_ciphertext text,
  face_crop_retained_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idv_check_records_number_cipher CHECK (
    document_number_ciphertext IS NULL OR document_number_ciphertext LIKE 'aes-256-gcm$%'
  ),
  CONSTRAINT idv_check_records_last4 CHECK (
    document_number_last4 IS NULL OR char_length(document_number_last4) BETWEEN 1 AND 4
  ),
  CONSTRAINT idv_check_records_crop_cipher CHECK (
    face_crop_ciphertext IS NULL OR face_crop_ciphertext LIKE 'aes-256-gcm$%'
  ),
  CONSTRAINT idv_check_records_crop_retention CHECK (
    (face_crop_ciphertext IS NULL AND face_crop_retained_until IS NULL)
    OR (face_crop_ciphertext IS NOT NULL AND face_crop_retained_until IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idv_check_records_client_idx
  ON idv_check_records (tenant_id, legal_entity_id, client_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS idv_check_deals (
  link_id text PRIMARY KEY,
  record_id text NOT NULL,
  deal_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  client_id text NOT NULL,
  staff_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idv_record_supersessions (
  supersession_id text PRIMARY KEY,
  record_id text NOT NULL,
  superseded_by_record_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  staff_id text NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idv_number_reveals (
  reveal_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  record_id text NOT NULL,
  client_id text NOT NULL,
  deal_id text,
  staff_id text NOT NULL,
  role text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('fintrac_request', 'report_filing', 'id_mismatch', 'client_request')),
  note text,
  revealed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '5 years')
);

CREATE TABLE IF NOT EXISTS idv_crop_views (
  view_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  record_id text NOT NULL,
  client_id text NOT NULL,
  deal_id text,
  staff_id text NOT NULL,
  role text NOT NULL,
  reason text NOT NULL CHECK (reason = 'eye_comparison'),
  note text,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '5 years')
);

CREATE TABLE IF NOT EXISTS idv_returning_blocks (
  block_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  client_id text NOT NULL,
  staff_id text NOT NULL,
  reason text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION idv_records_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'id check rows are append-only and kept for 5 years';
END;
$$;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'idv_consents', 'idv_check_records', 'idv_check_deals', 'idv_record_supersessions',
    'idv_number_reveals', 'idv_crop_views', 'idv_returning_blocks'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_append_only', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION idv_records_append_only()',
      tbl || '_append_only', tbl
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_no_truncate', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION idv_records_append_only()',
      tbl || '_no_truncate', tbl
    );
  END LOOP;
END $$;
