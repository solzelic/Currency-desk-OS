-- Rates v2.5, Auto-publish. When it is on for a branch, every market pull
-- publishes the branch's board again with the market's mids in the shop's
-- own home currency (server/src/rates/market.ts). Off until staff who may
-- change rates turn it on (PUT /api/rates/auto-publish), and every change
-- is in audit_events (rates.auto_publish).
ALTER TABLE branches ADD COLUMN IF NOT EXISTS auto_publish_rates boolean NOT NULL DEFAULT false;
