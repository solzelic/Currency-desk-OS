-- Customer pre-verify. A remote Didit link, separate from the counter scan.
-- 086 added the counter methods. This file only extends the checks.

ALTER TABLE idv_inquiries DROP CONSTRAINT IF EXISTS idv_inquiries_check_method_known;
ALTER TABLE idv_inquiries ADD CONSTRAINT idv_inquiries_check_method_known
  CHECK (
    check_method IS NULL
    OR check_method IN ('id_and_selfie', 'counter_id_scan', 'counter_full', 'customer_preverify')
  );

ALTER TABLE idv_check_records DROP CONSTRAINT IF EXISTS idv_check_records_method_known;
ALTER TABLE idv_check_records ADD CONSTRAINT idv_check_records_method_known
  CHECK (method IN (
    'in_person', 'returning_client', 'id_and_selfie', 'id_selfie_database',
    'counter_id_scan', 'counter_full', 'customer_preverify'
  ));
