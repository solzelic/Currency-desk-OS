-- Rates v2.5: when a window screen last asked for its rates, so the desk
-- can show it as On. Written by the public screen answer at most once a
-- minute per screen (server/src/rates/public-board.ts); never by the
-- desk's own preview.
ALTER TABLE window_screens ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
