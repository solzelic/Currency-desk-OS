-- Inquiry-to-shop map. 048 is last on main. 050 is another change. This is 049.
-- provider and provider_ref are provider-neutral. reference_id is our opaque id.

CREATE TABLE IF NOT EXISTS idv_inquiries (
  reference_id text PRIMARY KEY,
  shop_id text NOT NULL,
  branch_id text NOT NULL,
  teller_id text NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE TABLE IF NOT EXISTS idv_events (
  event_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  reference_id text NOT NULL REFERENCES idv_inquiries(reference_id),
  shop_id text NOT NULL,
  branch_id text NOT NULL,
  teller_id text NOT NULL,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idv_events_shop_idx ON idv_events (shop_id);
