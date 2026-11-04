-- Rates v2.5. Every surface a shop's customers see reads the shop's latest
-- PUBLISHED board (rate_boards). These two tables say where it is shown.

-- The shop's public rate page. Private until the owner turns it on. The
-- slug is the address (lowercase letters, digits and inner hyphens).
CREATE TABLE IF NOT EXISTS shop_rate_pages (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  live boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A screen in the shop (a TV in the window, a tablet at the counter). The
-- token is the screen's whole credential: long, random, minted by the
-- server. A retired screen stays for the record and stops answering.
CREATE TABLE IF NOT EXISTS window_screens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (kind IN ('tv', 'tablet')),
  layout text NOT NULL CHECK (layout IN ('one', 'two')),
  theme text NOT NULL CHECK (theme IN ('light', 'dark')),
  currencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  show_hours boolean NOT NULL DEFAULT true,
  token text NOT NULL UNIQUE CHECK (length(token) >= 32),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE INDEX IF NOT EXISTS window_screens_tenant_idx ON window_screens (tenant_id);
