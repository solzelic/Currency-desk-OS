/* ============================================================
   The account's own identifier, and the terms it was opened under.

   A new shop used to be asked for a CurrencyDesk ID before it could
   start. That ID is not an input. It is issued when the account is
   created, on the public setup page, and stored here so the same
   string can be shown back and quoted later.

   `reference` is null on every desk that already existed — including
   the demo tenant — because those accounts were not opened on this
   door. A unique index still allows many nulls.

   `terms_accepted_at` and `terms_version` are written in the same
   moment as the reference. An account this door creates has both.
   The version is the date on the legal page the person accepted,
   not a free-text claim from the browser.
   ============================================================ */

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_version text;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_reference_idx ON tenants (reference);
