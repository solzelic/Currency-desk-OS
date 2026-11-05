-- Rates v2.5, Lock rates. While a branch's rates are locked nobody can
-- publish its board (POST /api/rates/publish answers 409 rates_locked) and
-- the market sync leaves it alone, Auto-publish or not
-- (server/src/rates/market.ts). Staff who may change rates lock and unlock
-- it (PUT /api/rates/lock); every change is in audit_events (rates.lock).
-- Null is unlocked, which every existing branch is.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS rates_locked_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS rates_locked_by text;
