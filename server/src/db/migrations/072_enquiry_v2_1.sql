-- Early Access v2.1 (CD-179 to CD-183): what the server hands an
-- applicant back, kept on the application.
--
--   cd_id           the CurrencyDesk ID minted when an application is
--                   accepted (CD-YORK-7K42; server/src/enquiries/cd-id.ts).
--                   Unique, never reused. Null for a waitlisted application,
--                   a contact message, and every row from before v2.1.
--   waitlist_reason the server's decision: 'outside-canada' or
--                   'not-fintrac-registered'. Null when accepted.
--   invite_code     a waitlisted shop outside Canada's code to give another
--                   shop. Unique.
--   place_in_line   that shop's place in line for its own country.
--
-- 072, not 069: open PRs #673 to #675 hold 069 to 071 on main.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS cd_id text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS waitlist_reason text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS place_in_line integer;
CREATE UNIQUE INDEX IF NOT EXISTS enquiries_cd_id_idx ON enquiries (cd_id) WHERE cd_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS enquiries_invite_code_idx ON enquiries (invite_code) WHERE invite_code IS NOT NULL;
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_waitlist_reason_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_waitlist_reason_check
  CHECK (waitlist_reason IS NULL OR waitlist_reason IN ('outside-canada', 'not-fintrac-registered'));
