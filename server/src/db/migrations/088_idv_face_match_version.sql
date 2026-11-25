-- Statement version on a counter-scan attestation.
-- 086 created the attestation table. This file does not edit that statement.

ALTER TABLE idv_face_attestations ADD COLUMN IF NOT EXISTS statement_version text;
