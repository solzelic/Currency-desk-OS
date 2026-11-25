-- Didit is a second identity provider behind the same check record.
-- Existing rows stay persona. Nothing is renamed or dropped.

ALTER TABLE idv_check_records ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'persona';
ALTER TABLE idv_check_records DROP CONSTRAINT IF EXISTS idv_check_records_provider_known;
ALTER TABLE idv_check_records ADD CONSTRAINT idv_check_records_provider_known
  CHECK (provider IN ('persona', 'didit'));
