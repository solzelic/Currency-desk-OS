-- A work email for a person who signs in with a username.
-- The welcome email goes here when their staff id is not itself an
-- address. It is a contact, not a sign-in name: it is not unique, and
-- sign-in never looks it up. Null for everyone who already exists.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS email text;

-- A username has to be free on every desk, not only on its own, so the
-- create route and the sign-in fallback look a typed id up across all
-- tenants, case-folded. This index is that lookup.
CREATE INDEX IF NOT EXISTS staff_users_staff_id_lower_idx ON staff_users (lower(staff_id));
