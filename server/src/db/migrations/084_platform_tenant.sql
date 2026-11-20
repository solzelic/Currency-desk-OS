-- The platform tenant is the row an anonymous sign-in challenge hangs
-- on until a desk is chosen. A request must not insert it.
-- Idempotent: a second run keeps a slug that is already set.

INSERT INTO tenants (id, name, plan, site_slug)
VALUES ('tnt-platform', 'CurrencyDesk Platform', 'premium', 'platform')
ON CONFLICT (id) DO UPDATE SET
  site_slug = COALESCE(tenants.site_slug, EXCLUDED.site_slug);
