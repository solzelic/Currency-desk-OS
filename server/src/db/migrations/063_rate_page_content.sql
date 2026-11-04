-- Rates v2.5, the rate page editor. What the shop wrote for its page: a
-- display name, a short line, which parts show, which currencies, and the
-- regulator block. Contact details and hours are not here: they belong to
-- the business profile (tenants.site_config), which Settings edits too.
-- Validated by the server (server/src/rates/rate-page.ts) before it is
-- written; an empty object means every default.
ALTER TABLE shop_rate_pages ADD COLUMN IF NOT EXISTS content jsonb NOT NULL DEFAULT '{}'::jsonb;
