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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_boards_branch_idx").on(t.branchId, t.publishedAt)],
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
