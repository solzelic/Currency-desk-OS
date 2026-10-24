-- Inquiry status. 049 created the map. 050 is the shop config. This file is 051.

ALTER TABLE idv_inquiries
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'starting';
