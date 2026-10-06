/* ============================================================
   Terms accepted on an invited application, before setup.

   The reference in the invite link (CD-XXXXXX) is already the
   application's own id. This migration does not issue another one,
   and it does not put an id on the tenant.

   The version is the date on the legal page the person accepted:
   26 July 2026. A row is either untouched — all three columns null —
   or it records that one version, the time, and who accepted. Who
   accepted is the application's email, written by the server. A
   different version, or a version with nobody and no time attached,
   is not a row this table will hold.

   The same columns and the same check are in the bootstrap DDL,
   because the embedded database applies that and not this file.
   ============================================================ */

ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE onboarding ADD COLUMN IF NOT EXISTS terms_accepted_by text;

ALTER TABLE onboarding DROP CONSTRAINT IF EXISTS onboarding_terms_recorded;
ALTER TABLE onboarding ADD CONSTRAINT onboarding_terms_recorded CHECK (
  (
    terms_version IS NULL
    AND terms_accepted_at IS NULL
    AND terms_accepted_by IS NULL
  )
  OR (
    terms_version = '2026-07-26'
    AND terms_accepted_at IS NOT NULL
    AND terms_accepted_by IS NOT NULL
    AND length(btrim(terms_accepted_by)) > 0
  )
);
