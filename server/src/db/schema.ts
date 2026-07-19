/* ============================================================
   CurrencyDesk server — database schema
   Mirrors the frontend's DomainScope hierarchy exactly:
     tenant → legal entity → branch → workspace (till)
   Staff roles are the same union as src/domain/types.ts StaffRole,
   so the two sides can never drift apart on authorization.
   ============================================================ */
import { boolean, doublePrecision, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const staffRole = pgEnum("staff_role", [
  "teller",
  "supervisor",
  "compliance_officer",
  "branch_manager",
  "administrator",
  "auditor",
]);

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // purchased tier — decides which apps the OS unlocks and which APIs the
  // server serves. basic = rate board + live rates on the customer's site.
  plan: text("plan").notNull().default("premium"),
  // hosted storefront: served at /sites/<site_slug>; when the customer
  // points their domain's DNS here, requests for site_domain serve the
  // same site at their root (see src/sites.ts)
  siteSlug: text("site_slug"),
  siteDomain: text("site_domain"),
  // public storefront content the OS publishes: contact + hours the site
  // hydrates from — one source of truth for every shop we host
  siteConfig: jsonb("site_config").$type<SiteConfig>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface SiteConfig {
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  region?: string;
  postal?: string;
  hours?: { days: string; hours: string }[];
  updatedAt?: string;
}

export type TenantPlan = "basic" | "pro" | "premium";
export const TENANT_PLANS: TenantPlan[] = ["basic", "pro", "premium"];

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    // MSB registration lives at the legal-entity level (per-jurisdiction)
    msbNumber: text("msb_number"),
    jurisdiction: text("jurisdiction").notNull().default("FINTRAC"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_entities_tenant_idx").on(t.tenantId)],
);

export const branches = pgTable(
  "branches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("America/Toronto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("branches_entity_idx").on(t.legalEntityId)],
);

// a workspace is a till/station within a branch — the finest scope unit
export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    branchId: text("branch_id").notNull().references(() => branches.id),
    tillId: text("till_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspaces_branch_till_idx").on(t.branchId, t.tillId)],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    // human-memorable staff id ("a.singh") scoped per tenant; the login key
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    // home branch; may be authorized into others
    branchId: text("branch_id").notNull().references(() => branches.id),
    staffId: text("staff_id").notNull(),
    name: text("name").notNull(),
    role: staffRole("role").notNull(),
    authorizedBranchIds: jsonb("authorized_branch_ids").$type<string[]>().notNull().default([]),
    passwordHash: text("password_hash").notNull(),
    // true while the password is a manager-issued temporary — the person is
    // forced to pick their own at next sign-in
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_tenant_staffid_idx").on(t.tenantId, t.staffId)],
);

export const sessions = pgTable(
  "sessions",
  {
    // stores only the SHA-256 of the session token — a DB leak can't replay sessions
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => staffUsers.id),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/* Rate board publications — APPEND-ONLY. A publication is the full board
   at a moment in time (same shape the prototype's converter reads):
   mids are CAD per 1 unit, margins are fractions (0.015 = 1.5%), a row's
   `spread` overrides the board margin for that currency. The current board
   is simply the newest row per branch; history is the compliance trail. */
export interface RateBoardRow {
  mid: number;
  spread?: number;
  show?: boolean;
}

export const rateBoards = pgTable(
  "rate_boards",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    legalEntityId: text("legal_entity_id").notNull().references(() => legalEntities.id),
    branchId: text("branch_id").notNull().references(() => branches.id),
    buyMargin: doublePrecision("buy_margin").notNull(),
    sellMargin: doublePrecision("sell_margin").notNull(),
    boardRows: jsonb("board_rows").$type<Record<string, RateBoardRow>>().notNull(),
    boardOrder: jsonb("board_order").$type<string[]>(),
    publishedBy: text("published_by"),
    marketSnapshotId: text("market_snapshot_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_boards_branch_idx").on(t.branchId, t.publishedAt)],
);

/* Market-rate snapshots — APPEND-ONLY. One row per provider pull; mids are
   CAD per 1 unit (board convention). The scheduler publishes a fresh board
   from the newest snapshot, preserving staff margins/spreads/order. */
export const marketRates = pgTable(
  "market_rates",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    mids: jsonb("mids").$type<Record<string, number>>().notNull(),
    providerTimestamp: text("provider_timestamp"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("market_rates_fetched_idx").on(t.fetchedAt)],
);

/* SMS rate-hold quotes — a site visitor asks for a rate by text; the
   server prices it off the newest published board and HOLDS it for 30
   minutes. Status walks held → confirmed | expired | cancelled; expiry
   is computed on read, no scheduler needed. */
export const rateQuotes = pgTable(
  "rate_quotes",
  {
    id: text("id").primaryKey(),                    // customer-facing ref, "Q-4821"
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    phone: text("phone").notNull(),                 // normalized +E.164
    name: text("name"),
    haveCcy: text("have_ccy").notNull(),
    wantCcy: text("want_ccy").notNull(),
    haveAmount: doublePrecision("have_amount").notNull(),
    quotedRate: doublePrecision("quoted_rate").notNull(),   // want per 1 have
    receiveAmount: doublePrecision("receive_amount").notNull(),
    status: text("status").notNull().default("held"),
    smsStatus: text("sms_status").notNull().default("simulated"),
    smsText: text("sms_text").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_quotes_tenant_idx").on(t.tenantId, t.createdAt)],
);

// append-only security audit (mirrors src/security/audit.ts event shape)
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    legalEntityId: text("legal_entity_id").notNull(),
    branchId: text("branch_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_scope_idx").on(t.tenantId, t.branchId, t.at)],
);
