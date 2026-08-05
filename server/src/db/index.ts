/* ============================================================
   CurrencyDesk server — database bootstrap
   One schema, two drivers:
     • DATABASE_URL set   → node-postgres against managed Postgres (prod)
     • DATABASE_URL unset → embedded PGlite (dev / tests, zero install)
   Both are real Postgres, so SQL and migrations never fork.
   ============================================================ */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runMigrations } from "./migrations.js";
import * as schema from "./schema.js";

export type Db = PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

// The base schema and ledger migration are idempotent and applied during the
// existing database bootstrap. This keeps the production database lifecycle
// versioned alongside the server instead of creating a separate ledger-only
// setup path.
const ENUM_DDL = `CREATE TYPE staff_role AS ENUM ('teller','supervisor','compliance_officer','branch_manager','administrator','auditor');`;

const DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'premium',
  site_slug text,
  site_domain text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'premium';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS site_slug text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS site_domain text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS site_config jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS setup jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS rate_quotes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  phone text NOT NULL,
  name text,
  have_ccy text NOT NULL,
  want_ccy text NOT NULL,
  have_amount double precision NOT NULL,
  quoted_rate double precision NOT NULL,
  receive_amount double precision NOT NULL,
  status text NOT NULL DEFAULT 'held',
  sms_status text NOT NULL DEFAULT 'simulated',
  sms_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_quotes_tenant_idx ON rate_quotes(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS pending_signups (
  id text PRIMARY KEY,
  email text NOT NULL,
  business_name text NOT NULL,
  owner_name text NOT NULL,
  password_hash text NOT NULL,
  slug text NOT NULL,
  onboarding jsonb,
  code_hash text NOT NULL,
  attempts double precision NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- existing databases already have pending_signups without the guided-onboarding
-- blob; CREATE TABLE IF NOT EXISTS is a no-op there, so add the column explicitly
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS onboarding jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS pending_signups_email_idx ON pending_signups(email);
CREATE TABLE IF NOT EXISTS platform_users (
  email text PRIMARY KEY,
  name text,
  role text NOT NULL DEFAULT 'support',
  status text NOT NULL DEFAULT 'active',
  added_by text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS enquiries (
  id text PRIMARY KEY,
  reference text NOT NULL,
  kind text NOT NULL,
  email text NOT NULL,
  name text,
  details jsonb,
  status text NOT NULL DEFAULT 'new',
  notes text,
  tenant_id text,
  decided_at timestamptz,
  decided_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS charter_no integer;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
-- an enquiry carries its own progress; existing rows predate these columns
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS decided_by text;
-- what an application is LIKE, as opposed to where it IS. Free-form and
-- multi-valued; status stays the single ordered thing automation keys off.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS enquiries_reference_idx ON enquiries(reference);
CREATE INDEX IF NOT EXISTS enquiries_kind_idx ON enquiries(kind, created_at);
CREATE INDEX IF NOT EXISTS enquiries_status_idx ON enquiries(status);
-- our side of a thread with somebody who wrote to us. Outbound only.
CREATE TABLE IF NOT EXISTS enquiry_replies (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL,
  body text NOT NULL,
  sent_by text NOT NULL,
  email_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_replies_idx ON enquiry_replies(enquiry_id, created_at);
CREATE INDEX IF NOT EXISTS enquiries_email_idx ON enquiries(email);
CREATE TABLE IF NOT EXISTS onboarding (
  enquiry_id text PRIMARY KEY,
  answers jsonb NOT NULL DEFAULT '{}',
  touched jsonb NOT NULL DEFAULT '{}',
  marks jsonb NOT NULL DEFAULT '{}',
  tenant_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TABLE IF EXISTS desk_onboarding;
CREATE TABLE IF NOT EXISTS tenant_state (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  state jsonb NOT NULL DEFAULT '{}',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Bumped on every write. A client sends back the version it last saw, and a
-- save built on a stale one is refused instead of quietly erasing whatever
-- landed in between. See routes/tenantState.ts.
ALTER TABLE tenant_state ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS legal_entities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  msb_number text,
  jurisdiction text NOT NULL DEFAULT 'FINTRAC',
  -- which country's rules this entity operates under, and the currency it
  -- keeps its books in. Migration 011 adds these to existing databases; they
  -- are here so a freshly created one has them from the start.
  home_currency char(3),
  jurisdiction_pack_id text,
  jurisdiction_pack_version integer,
  -- how this desk costs its inventory: 'weighted_average' or 'fifo'. NULL
  -- means "follow the jurisdiction pack's suggestion". Migration 014 adds it
  -- to existing databases; it is here because the test database is built from
  -- this constant rather than from the migrations.
  cost_method text,
  -- what this desk reports and identifies at, and how long it keeps the
  -- paperwork. NULL on every one of them means "follow the jurisdiction
  -- pack" — the pack states the mandate, the desk may only tighten it.
  -- Migration 016 adds them to existing databases; they are here because
  -- the test database is built from this constant rather than from the
  -- migrations. See server/src/ledger/thresholds.ts.
  report_threshold numeric(24,2),
  id_threshold numeric(24,2),
  aggregation_hours integer,
  retention_years integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS cost_method text;
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS report_threshold numeric(24,2);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS id_threshold numeric(24,2);
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS aggregation_hours integer;
ALTER TABLE legal_entities ADD COLUMN IF NOT EXISTS retention_years integer;
CREATE INDEX IF NOT EXISTS legal_entities_tenant_idx ON legal_entities(tenant_id);
CREATE TABLE IF NOT EXISTS branches (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Toronto',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS branches_entity_idx ON branches(legal_entity_id);
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),
  branch_id text NOT NULL REFERENCES branches(id),
  till_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_branch_till_idx ON workspaces(branch_id, till_id);
CREATE TABLE IF NOT EXISTS staff_users (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),
  branch_id text NOT NULL REFERENCES branches(id),
  staff_id text NOT NULL,
  name text NOT NULL,
  role staff_role NOT NULL,
  authorized_branch_ids jsonb NOT NULL DEFAULT '[]',
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  password_updated_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_tenant_staffid_idx ON staff_users(tenant_id, staff_id);
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz;
-- the till PIN, hashed. Held here rather than in the desk's saved state, which
-- the browser downloads whole — see routes/tenantState.ts for the migration.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_set_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_must_change boolean NOT NULL DEFAULT false;
-- the human identifier a person quotes to support and signs in with. Unique
-- where set; Postgres allows many NULLs, so accounts predating it keep working.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS cd_id text;
CREATE UNIQUE INDEX IF NOT EXISTS staff_cd_id_idx ON staff_users(cd_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES staff_users(id),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES staff_users(id),
  workspace_id text REFERENCES workspaces(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  actor_id text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_scope_idx ON audit_events(tenant_id, branch_id, at);
CREATE TABLE IF NOT EXISTS rate_boards (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),
  branch_id text NOT NULL REFERENCES branches(id),
  buy_margin double precision NOT NULL,
  sell_margin double precision NOT NULL,
  board_rows jsonb NOT NULL,
  board_order jsonb,
  published_by text,
  market_snapshot_id text,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_boards_branch_idx ON rate_boards(branch_id, published_at);
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
CREATE INDEX IF NOT EXISTS stripe_subscriptions_tenant_idx ON stripe_subscriptions(tenant_id, updated_at);
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
CREATE INDEX IF NOT EXISTS stripe_invoices_tenant_idx ON stripe_invoices(tenant_id, updated_at);
CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id text PRIMARY KEY,
  type text NOT NULL,
  object_id text,
  tenant_id text REFERENCES tenants(id),
  livemode boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS stripe_events_tenant_idx ON stripe_events(tenant_id, received_at);
CREATE TABLE IF NOT EXISTS market_rates (
  id text PRIMARY KEY,
  provider text NOT NULL,
  mids jsonb NOT NULL,
  provider_timestamp text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_rates_fetched_idx ON market_rates(fetched_at);
/* ---- the desk's customer files ---------------------------------------

   Mirrors migration 019, which is where all the reasoning lives. These
   are here because the embedded database is built from this constant and
   does NOT run migrations, so a table that exists only in a migration
   file does not exist in dev or in the unit suite at all.

   What is deliberately NOT mirrored here is the one statement in 019
   that touches ledger_customers — the client_id column that joins
   the desk's record to the ledger's counter row. That table is created
   by the ledger migration and so has never existed on the embedded
   database; adding a column to a table that is not there would fail the
   bootstrap for every dev machine. It follows that the client ROUTES are
   registered only where the ledger's are (see app.ts): scoping is per
   legal entity, but the join is per till and the till's table lives with
   the migrations.

   The IDENTIFYING / SIGNAL split, why a name is not a key, what a reveal
   records and what retention obliges are all written down once, in
   019_client_records.sql and docs/CLIENT_RECORDS.md. Do not restate them
   here — two copies of that reasoning is how the two halves start
   disagreeing. */
CREATE TABLE IF NOT EXISTS desk_clients (
  client_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),
  -- identifying
  display_name text NOT NULL,
  date_of_birth date,
  address_line text,
  city text,
  postal_code text,
  email text,
  phone text,
  notes text,
  -- signal
  kind text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','business')),
  region text,
  country text,
  occupation text,
  risk_rating text NOT NULL DEFAULT 'normal' CHECK (risk_rating IN ('low','normal','medium','high')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','identified','verified','expired')),
  verified_at timestamptz,
  screening_outcome text CHECK (screening_outcome IS NULL OR screening_outcome IN ('clear','hit','pending')),
  screening_matched text,
  screened_at timestamptz,
  incorporation_date date,
  incorporation_jurisdiction text,
  nature_of_business text,
  contact_name text,
  contact_title text,
  -- NOT unique, and must never become unique: two customers legitimately
  -- share a name. It exists so a collision is visible instead of silent.
  name_key text GENERATED ALWAYS AS (lower(regexp_replace(btrim(display_name), '\\s+', ' ', 'g'))) STORED,
  possible_duplicate boolean NOT NULL DEFAULT false,
  duplicate_reason text,
  -- reserved for cross-desk matching, written by nothing. See 019.
  network_match_hash text,
  network_match_hash_version integer,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desk_clients_entity_idx ON desk_clients (tenant_id, legal_entity_id, name_key);
CREATE INDEX IF NOT EXISTS desk_clients_entity_updated_idx ON desk_clients (tenant_id, legal_entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS desk_clients_network_hash_idx ON desk_clients (network_match_hash) WHERE network_match_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS desk_client_aliases (
  alias_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  alias text NOT NULL,
  alias_key text GENERATED ALWAYS AS (lower(regexp_replace(btrim(alias), '\\s+', ' ', 'g'))) STORED,
  alias_kind text NOT NULL DEFAULT 'also_known_as'
    CHECK (alias_kind IN ('legacy_name_key','former_name','also_known_as')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_client_aliases_unique ON desk_client_aliases (client_id, alias_key, alias_kind);
CREATE INDEX IF NOT EXISTS desk_client_aliases_lookup_idx ON desk_client_aliases (tenant_id, legal_entity_id, alias_key);
CREATE TABLE IF NOT EXISTS desk_client_identity_documents (
  document_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  doc_type text NOT NULL,
  doc_number text,
  issuing_jurisdiction text,
  issued_on date,
  expires_on date,
  is_primary boolean NOT NULL DEFAULT false,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desk_client_documents_client_idx ON desk_client_identity_documents (client_id, is_primary DESC, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS desk_client_documents_one_primary ON desk_client_identity_documents (client_id) WHERE is_primary;
CREATE TABLE IF NOT EXISTS desk_client_images (
  image_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('identity_document','client_photograph')),
  document_id text REFERENCES desk_client_identity_documents(document_id) ON DELETE CASCADE,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  bytes bytea NOT NULL,
  label text,
  captured_by text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_client_images_purpose_shape CHECK (
    (purpose = 'identity_document' AND document_id IS NOT NULL) OR
    (purpose = 'client_photograph' AND document_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS desk_client_images_client_idx ON desk_client_images (client_id, purpose, captured_at DESC);
CREATE INDEX IF NOT EXISTS desk_client_images_document_idx ON desk_client_images (document_id) WHERE document_id IS NOT NULL;
`;

export async function createDb(): Promise<DbHandle> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    // same idempotent bootstrap as the embedded path — a fresh managed
    // Postgres (Neon) gets its schema on first boot, existing ones no-op
    const typeExists = await pool.query(`SELECT 1 FROM pg_type WHERE typname = 'staff_role'`);
    if (typeExists.rows.length === 0) {
      await pool.query(ENUM_DDL);
    }
    await pool.query(DDL);
    await runMigrations(pool);
    const db = drizzlePg(pool, { schema });
    return { db, close: () => pool.end() };
  }
  // embedded Postgres — file-backed in dev so data survives restarts,
  // pure in-memory when PGLITE_MEMORY=1 (tests)
  const dataDir = process.env.PGLITE_MEMORY === "1" ? undefined : process.env.PGLITE_DIR ?? "./.pgdata";
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  // idempotent bootstrap: the enum CREATE throws if it exists — probe just
  // that; the table DDL is IF NOT EXISTS throughout, so re-running it picks
  // up newly added tables in an existing data directory
  const typeExists = await client.query(`SELECT 1 FROM pg_type WHERE typname = 'staff_role'`);
  if (typeExists.rows.length === 0) {
    await client.exec(ENUM_DDL);
  }
  await client.exec(DDL);
  const db = drizzlePglite(client, { schema });
  return { db, close: () => client.close() };
}

export { schema };
