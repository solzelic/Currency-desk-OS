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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
CREATE TABLE IF NOT EXISTS legal_entities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  msb_number text,
  jurisdiction text NOT NULL DEFAULT 'FINTRAC',
  created_at timestamptz NOT NULL DEFAULT now()
);
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
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_boards_branch_idx ON rate_boards(branch_id, published_at);
CREATE TABLE IF NOT EXISTS market_rates (
  id text PRIMARY KEY,
  provider text NOT NULL,
  mids jsonb NOT NULL,
  provider_timestamp text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_rates_fetched_idx ON market_rates(fetched_at);
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
    await pool.query(await readFile(resolve(process.cwd(), "src/ledger/migration.sql"), "utf8"));
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
