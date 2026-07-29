-- Stripe billing projections. Stripe remains the payment and tax system of
-- record; this database stores only identifiers and entitlement state.
CREATE TABLE IF NOT EXISTS stripe_customers (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  stripe_customer_id text NOT NULL,
  price_id text,
  plan text,
  status text NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_subscriptions_tenant_idx
  ON stripe_subscriptions(tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS stripe_invoices (
  stripe_invoice_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text,
  status text,
  currency text,
  amount_due integer,
  amount_paid integer,
  tax integer,
  hosted_invoice_url text,
  invoice_pdf text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_invoices_tenant_idx
  ON stripe_invoices(tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id text PRIMARY KEY,
  type text NOT NULL,
  object_id text,
  tenant_id text REFERENCES tenants(id),
  livemode boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS stripe_events_tenant_idx
  ON stripe_events(tenant_id, received_at);
