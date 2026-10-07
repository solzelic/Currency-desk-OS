-- Receipt setup belongs to the desk owner.
-- The tenant state blob is writable by any signed-in teller, so these
-- options live on the tenant row and the write route checks the role.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS receipt_settings jsonb;
