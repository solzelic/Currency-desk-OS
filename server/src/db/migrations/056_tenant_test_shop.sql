-- A staging test shop is marked on the tenant.
-- Nothing in this change sets the marker.
-- A shop that already exists stays false.
-- A database already at 055 gains the column on boot.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_test_shop boolean NOT NULL DEFAULT false;
