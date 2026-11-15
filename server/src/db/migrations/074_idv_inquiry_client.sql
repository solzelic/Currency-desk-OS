-- The client a check was started for. 073 is the previous file, so this is 074.
-- Nullable: a check started before this column has no client.
-- Personal data from the provider is not stored here.

ALTER TABLE idv_inquiries ADD COLUMN IF NOT EXISTS client_id text;

ALTER TABLE idv_inquiries DROP CONSTRAINT IF EXISTS idv_inquiries_client_fk;
ALTER TABLE idv_inquiries
  ADD CONSTRAINT idv_inquiries_client_fk
  FOREIGN KEY (client_id) REFERENCES desk_clients(client_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idv_inquiries_client_idx ON idv_inquiries (shop_id, client_id);
