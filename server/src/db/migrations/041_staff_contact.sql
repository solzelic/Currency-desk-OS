-- The phone's My details screen was writing a contact email and a
-- mobile into the whole desk snapshot and calling it saved. Those two
-- facts belong on the person. Neither one is the sign-in name: a teller
-- still signs in as "m.costa", and an emailed sign-in code is still sent
-- only when that sign-in name is itself an email.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS mobile_phone text;
