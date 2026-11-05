-- Rates v2.5: the shop's logo, and the window screen options the design
-- has.
--
-- The logo is a PNG the desk drew at 240px, kept as a data URL. The server
-- checks its signature and size before it is written
-- (server/src/rates/logo.ts) and serves it back as image/png only.
ALTER TABLE shop_rate_pages ADD COLUMN IF NOT EXISTS logo text
  CHECK (logo IS NULL OR (logo LIKE 'data:image/png;base64,%' AND length(logo) <= 360000));
ALTER TABLE shop_rate_pages ADD COLUMN IF NOT EXISTS logo_at timestamptz;

-- Screens: on its side (portrait) and a strip above the counter, pages that
-- turn when the currencies do not fit, and what shows on the screen
-- (flags, names, clock, logo; an absent key means shown).
ALTER TABLE window_screens DROP CONSTRAINT IF EXISTS window_screens_kind_check;
ALTER TABLE window_screens ADD CONSTRAINT window_screens_kind_check CHECK (kind IN ('tv', 'portrait', 'tablet', 'strip'));
ALTER TABLE window_screens DROP CONSTRAINT IF EXISTS window_screens_layout_check;
ALTER TABLE window_screens ADD CONSTRAINT window_screens_layout_check CHECK (layout IN ('one', 'two', 'rotate'));
ALTER TABLE window_screens ADD COLUMN IF NOT EXISTS show jsonb NOT NULL DEFAULT '{}'::jsonb;
