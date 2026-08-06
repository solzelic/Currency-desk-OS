/* ============================================================
   CurrencyDesk server — database schema
   Mirrors the frontend's DomainScope hierarchy exactly:
     tenant → legal entity → branch → workspace (till)
   Staff roles are the same union as src/domain/types.ts StaffRole,
   so the two sides can never drift apart on authorization.
   ============================================================ */
import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  // onboarding answers captured at signup: regulator/country, home currency,
  // MSB number, address, compliance thresholds. The OS reads these as the
  // desk's starting configuration (fully consumed in Phase B).
  setup: jsonb("setup").$type<Record<string, unknown>>(),
  // platform admin can freeze a desk (non-payment/abuse): a suspended desk's
  // people can't sign in. Reversible.
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* Per-tenant OS working state — one JSON snapshot per desk. The buildless
   OS keeps its live state (rate board, ledger rows, clients, till counts,
   settings, texts…) in ~30 browser keys; this is the server-authoritative
   copy so a desk is REAL and durable: it hydrates from here on sign-in and
   writes back (debounced) as things change, isolated per tenant. Relational
   promotion of individual apps (ledger→book, texts→quotes) layers on later. */
export const tenantState = pgTable("tenant_state", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id),
  state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /* Bumped on every write. Two tellers on two machines each hold a whole
     copy of this document, so a save without a precondition silently erased
     whatever the other one had just done. The client sends back the version
     it last saw and a stale save is refused. */
  version: integer("version").notNull().default(0),
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

/* Stripe is the commercial system of record. These projections contain only
   identifiers and billing state needed to operate CurrencyDesk — never card
   data, billing addresses, or raw webhook payloads. */
/* The people who run CurrencyDesk, as opposed to the people who run a desk.

   Was an environment variable. An env var has no roles, no record of who
   added whom, nothing to suspend, and it resets to the deploy config on
   every restart — which is also why the bootstrap password kept coming
   back. The table is authoritative; the env vars only seed it when it is
   empty. */
export const platformUsers = pgTable("platform_users", {
  email: text("email").primaryKey(),
  name: text("name"),
  role: text("role").notNull().default("support"),
  status: text("status").notNull().default("active"),
  addedBy: text("added_by"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stripeCustomers = pgTable(
  "stripe_customers",
  {
    tenantId: text("tenant_id").primaryKey().references(() => tenants.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stripe_customers_customer_idx").on(t.stripeCustomerId)],
);

export const stripeSubscriptions = pgTable(
  "stripe_subscriptions",
  {
    stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    priceId: text("price_id"),
    plan: text("plan").$type<TenantPlan>(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stripe_subscriptions_tenant_idx").on(t.tenantId, t.updatedAt)],
);

export const stripeInvoices = pgTable(
  "stripe_invoices",
  {
    stripeInvoiceId: text("stripe_invoice_id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status"),
    currency: text("currency"),
    amountDue: integer("amount_due"),
    amountPaid: integer("amount_paid"),
    tax: integer("tax"),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdf: text("invoice_pdf"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stripe_invoices_tenant_idx").on(t.tenantId, t.updatedAt)],
);

export const stripeEvents = pgTable(
  "stripe_events",
  {
    stripeEventId: text("stripe_event_id").primaryKey(),
    type: text("type").notNull(),
    objectId: text("object_id"),
    tenantId: text("tenant_id").references(() => tenants.id),
    livemode: boolean("livemode").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("stripe_events_tenant_idx").on(t.tenantId, t.receivedAt)],
);

/* Opening a desk, in progress.

   Keyed on the APPLICATION, not on a tenant — because the whole point is
   that this happens BEFORE the desk exists. Somebody applies, we invite
   them, and then either they work through it from their link or we sit
   down and do it with them. The desk is created at the end, out of these
   answers; tenantId is set at that moment and not before.

   `answers` holds only what somebody actually typed. What the application
   already told us, and what follows from it, is worked out on read (see
   src/onboarding/flow.ts) so that changing the country moves the regulator
   with it instead of leaving a stale copy nobody notices. */
export const onboarding = pgTable("onboarding", {
  enquiryId: text("enquiry_id").primaryKey(),
  answers: jsonb("answers").$type<Record<string, unknown>>().notNull().default({}),
  // stepId → who last touched it, so "did we do this or did they" survives
  touched: jsonb("touched").$type<Record<string, unknown>>().notNull().default({}),
  // steps with nothing to type: paperwork sighted, payment cleared
  marks: jsonb("marks").$type<Record<string, unknown>>().notNull().default({}),
  tenantId: text("tenant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
    /* Which country's rules this entity operates under, and the currency it
       keeps its books in. Installed from the country chosen at onboarding —
       see server/src/ledger/jurisdiction.ts. Nullable because entities
       created before packs existed are backfilled by migration 011. */
    homeCurrency: text("home_currency"),
    jurisdictionPackId: text("jurisdiction_pack_id"),
    jurisdictionPackVersion: integer("jurisdiction_pack_version"),
    /* How this desk costs its inventory — 'weighted_average' or 'fifo'.
       Nullable on purpose: NULL is not a missing value, it means "follow
       whatever the jurisdiction pack suggests", which is where a desk starts
       and stays until an owner decides otherwise. See migration 014. */
    costMethod: text("cost_method"),
    /* What this desk reports at, identifies at, aggregates over and keeps
       records for. Nullable for the same reason `costMethod` is: NULL means
       "follow the jurisdiction pack", which states the regulator's mandate.
       A desk may tighten any of these and may never loosen one — see
       migration 016 and server/src/ledger/thresholds.ts. Read as strings
       because they are numeric columns and node-postgres does not narrow
       arbitrary-precision numbers into a float. */
    reportThreshold: text("report_threshold"),
    idThreshold: text("id_threshold"),
    aggregationHours: integer("aggregation_hours"),
    retentionYears: integer("retention_years"),
    /* The currencies this desk trades, beside the one its books are kept
       in. Onboarding asks for these and has always used the answer to
       publish the opening rate board; until migration 020 it was never
       written anywhere the LEDGER could read, so the ledger kept its own
       four-currency opinion and a Philippine-corridor desk could not put
       a peso in a till. NULL means unstated, not empty — the resolver
       falls back to the branch's board. */
    tradedCurrencies: text("traded_currencies").array(),
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
    /* The human identifier a person quotes to us and signs in with:
       CD-YORK-0042. Unique across the platform, so support can act on it
       without first asking which desk. Null until issued — every account
       created before the scheme existed keeps working on its staff id. */
    cdId: text("cd_id"),
    name: text("name").notNull(),
    role: staffRole("role").notNull(),
    authorizedBranchIds: jsonb("authorized_branch_ids").$type<string[]>().notNull().default([]),
    passwordHash: text("password_hash").notNull(),
    // true while the password is a manager-issued temporary — the person is
    // forced to pick their own at next sign-in
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
    /* The 4-digit code that confirms it is really them before they take a
       drawer, switch accounts or void a ticket. Hashed like a password: it is
       short, so it is worth nobody — including us — being able to read it. */
    pinHash: text("pin_hash"),
    pinSetAt: timestamp("pin_set_at", { withTimezone: true }),
    /* True while the PIN on file is one somebody else issued. A PIN the owner
       read out is known by the owner, so it is a way in, not an identity —
       the person picks their own and this clears. */
    pinMustChange: boolean("pin_must_change").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_tenant_staffid_idx").on(t.tenantId, t.staffId), uniqueIndex("staff_cd_id_idx").on(t.cdId)],
);

/* A password reset in flight.

   Only the hash of the code is kept, for the same reason sessions keep
   only the hash of the token: a leak of this table must not be a way in.

   One live reset per person — issuing a new code deletes the last, so
   "ask for another" is always safe advice and there is never a second
   code quietly still working. `attempts` is what makes six digits enough:
   the code dies on the fifth wrong guess, so the million-wide space is
   never walked. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => staffUsers.id),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
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

/* Pending signups — a business is creating a desk but hasn't verified
   their email yet. Held here (password already hashed, a hashed 6-digit
   code with a 10-min expiry) so an abandoned signup never creates an
   orphan tenant. On successful verification the tenant + owner are
   created and the row is deleted. */
export const pendingSignups = pgTable(
  "pending_signups",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    businessName: text("business_name").notNull(),
    ownerName: text("owner_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    slug: text("slug").notNull(),
    onboarding: jsonb("onboarding").$type<Record<string, unknown>>(),
    codeHash: text("code_hash").notNull(),
    attempts: doublePrecision("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pending_signups_email_idx").on(t.email)],
);

/* What the public site sends us: an application for early access, or a
   note from the contact page. Neither belongs to a tenant — the sender
   doesn't have one yet — so this table sits outside tenancy. The
   reference is what the site shows the sender to quote back at us. */
export const enquiries = pgTable(
  "enquiries",
  {
    id: text("id").primaryKey(),
    reference: text("reference").notNull(),
    kind: text("kind").$type<EnquiryKind>().notNull(),
    email: text("email").notNull(),
    name: text("name"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    /* Where this application has got to. An application is not a message in
       an inbox — it is a thing an operator works, so the row carries its own
       progress rather than leaving it in somebody's head. */
    status: text("status").$type<EnquiryStatus>().notNull().default("new"),
    notes: text("notes"),
    /* Their place in the founding cohort — the number printed on the charter
       card they keep. Assigned once, when they apply, and never reused: the
       card says "on the record", so two people must never hold Nº 0007, and
       a number cannot come back to mean somebody else because an earlier
       applicant was turned down. Null for contact messages, which are not
       claims on a place. */
    charterNo: integer("charter_no"),
    /* The walkthrough. One permanent application the platform team can open
       any time to practise onboarding end to end. It is a real row with a
       real reference, because a rehearsal against a special case rehearses
       the special case — but it is kept out of every count, or the site
       would tell visitors a place had gone when none had. */
    isDemo: boolean("is_demo").notNull().default(false),
    /* The desk this application became. Set when a signup completes against
       the same address — the join that turns two unrelated lists into a
       funnel you can actually measure. */
    tenantId: text("tenant_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    /* What an application is LIKE — "high volume", "toronto", "referred by
       jordan". Many, unordered, and they drive nothing: status is the single
       ordered value automation keys off, and mixing the two is how you end
       up with a stage called "high-volume-reviewing". */
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    /* A safety state, not an inferred fact. Once set, no automation may dial
       this lead; only a deliberate operator action may clear it. */
    doNotContact: boolean("do_not_contact").notNull().default(false),
    doNotContactAt: timestamp("do_not_contact_at", { withTimezone: true }),
    doNotContactBy: text("do_not_contact_by"),
    doNotContactReason: text("do_not_contact_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("enquiries_reference_idx").on(t.reference),
    index("enquiries_kind_idx").on(t.kind, t.createdAt),
    index("enquiries_status_idx").on(t.status),
    index("enquiries_email_idx").on(t.email),
  ],
);
export type EnquiryKind = "early_access" | "contact";
/* reviewing → invited → accepted, with hold and declined as the two other
   ways out of review. "accepted" is not set by hand: it is what a completed
   signup means. "new" is only for rows that arrived before applications
   were acknowledged automatically — nothing lands there any more, and the
   ordering here is what the board's columns are drawn from. */
export type EnquiryStatus = "new" | "reviewing" | "hold" | "invited" | "accepted" | "declined";
export const ENQUIRY_STATUSES: EnquiryStatus[] = ["new", "reviewing", "hold", "invited", "accepted", "declined"];

/* Evidence for the permission to contact this applicant. Kept outside
   `details`: that blob is exactly what the applicant typed, while this row is
   server/browser evidence about how and when the form was submitted. */
export const enquiryContactConsents = pgTable(
  "enquiry_contact_consents",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    formVersion: text("form_version").notNull(),
    ipAddress: text("ip_address").notNull(),
    userAgent: text("user_agent"),
    timezone: text("timezone"),
    timezoneSource: text("timezone_source"),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_contact_consents_idx").on(t.enquiryId, t.consentedAt)],
);

/* One immutable snapshot per research attempt. A re-run adds a row; it never
   rewrites what the caller saw before an earlier conversation. */
export const enquiryResearchRuns = pgTable(
  "enquiry_research_runs",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider").notNull(),
    model: text("model"),
    status: text("status").notNull(),
    summary: text("summary"),
    brief: jsonb("brief").$type<ResearchBrief>(),
    creditsUsed: integer("credits_used"),
    costCents: integer("cost_cents"),
    error: text("error"),
    createdBy: text("created_by").notNull(),
  },
  (t) => [index("enquiry_research_runs_idx").on(t.enquiryId, t.runAt)],
);

export type ResearchBrief = {
  executiveSummary: string;
  sourceCount: number;
  registryStatus: "possible_match" | "not_confirmed";
  talkingPoints: string[];
  openQuestions: string[];
  /* A call may only rely on research that independently named the business
     the applicant supplied. Older snapshots remain visible, but are not
     callable context merely because they happen to contain web text. */
  identity?: {
    businessName: string;
    websiteHost: string | null;
    verification: "exact_business_name";
  };
  /* This is the compact, caller-safe handoff. It deliberately contains only
     public, sourced business context; staff-only matching signals below never
     cross the boundary into an outbound agent prompt. */
  callerContext?: {
    goal: string;
    publicBusinessContext: string[];
    suggestedQuestions: string[];
  };
  /* Exact-match counts are a staff workflow aid, not research about a person.
     The counts reveal neither another applicant nor their contact details. */
  operatorOnly?: {
    matchingEmailApplications: number;
    matchingPhoneApplications: number;
    matchingBusinessApplications: number;
  };
};

export const enquiryGrowthJobs = pgTable(
  "enquiry_growth_jobs",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    status: text("status").$type<"queued" | "running" | "completed" | "failed">().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    researchId: text("research_id").references(() => enquiryResearchRuns.id),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_growth_jobs_queue_idx").on(t.status, t.availableAt, t.createdAt), index("enquiry_growth_jobs_enquiry_idx").on(t.enquiryId, t.createdAt)],
);

export const enquiryGrowthEvents = pgTable(
  "enquiry_growth_events",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    type: text("type").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_growth_events_idx").on(t.enquiryId, t.createdAt)],
);

export const enquiryGrowthAssignments = pgTable(
  "enquiry_growth_assignments",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    assignedTo: text("assigned_to"),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_growth_assignments_idx").on(t.enquiryId, t.assignedAt)],
);

export type ResearchMethod = "web_search" | "website_read" | "registry" | "model_inference";
export const enquiryResearchFacts = pgTable(
  "enquiry_research_facts",
  {
    id: text("id").primaryKey(),
    researchId: text("research_id").notNull().references(() => enquiryResearchRuns.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    sourceUrl: text("source_url").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    method: text("method").$type<ResearchMethod>().notNull(),
  },
  (t) => [index("enquiry_research_facts_idx").on(t.researchId)],
);

/* Reviewing is an event of its own. It does not mutate the run, which keeps
   the research history append-only. */
export const enquiryResearchReviews = pgTable(
  "enquiry_research_reviews",
  {
    id: text("id").primaryKey(),
    researchId: text("research_id").notNull().references(() => enquiryResearchRuns.id),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_research_reviews_idx").on(t.researchId, t.reviewedAt)],
);

/* One row per attempted real-world call. `trigger_key` is the reservation:
   the provider is never contacted unless this insert wins. */
export const enquiryCalls = pgTable(
  "enquiry_calls",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull().references(() => enquiries.id),
    researchId: text("research_id").references(() => enquiryResearchRuns.id),
    triggerKey: text("trigger_key").notNull(),
    provider: text("provider").notNull(),
    agentId: text("agent_id").notNull(),
    providerCallId: text("provider_call_id"),
    conversationId: text("conversation_id"),
    phone: text("phone").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    placedAt: timestamp("placed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    outcome: text("outcome"),
    recordingUrl: text("recording_url"),
    transcript: jsonb("transcript").$type<unknown[]>(),
    summary: text("summary"),
    error: text("error"),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("enquiry_calls_trigger_idx").on(t.triggerKey),
    index("enquiry_calls_enquiry_idx").on(t.enquiryId, t.requestedAt),
    uniqueIndex("enquiry_calls_conversation_idx").on(t.conversationId),
  ],
);

/* Operational switches must be reachable without a deploy. Values stay JSON
   so future settings do not require a new table shape. */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/* What we have written back to somebody who messaged us.

   Their note lives on `enquiries`; this is our side of the thread. Kept
   as rows rather than appended to a text field because each one has a
   sender, a time and a delivery result — "did that reply actually leave
   the building" is the question you ask when a customer says they never
   heard back, and a blob of concatenated text cannot answer it.

   Outbound only, and deliberately so: nothing here receives email. When
   they reply it goes to the reply-to address, which is a real inbox a
   person reads — not into this table. The panel says so rather than
   implying a two-way thread it does not have. */
export const enquiryReplies = pgTable(
  "enquiry_replies",
  {
    id: text("id").primaryKey(),
    enquiryId: text("enquiry_id").notNull(),
    body: text("body").notNull(),
    /* Who wrote it. A staff id rather than a name, so it still resolves
       after somebody changes what they are called. */
    sentBy: text("sent_by").notNull(),
    /* sent | simulated | failed — the same three answers sendEmail gives.
       A reply that only reached a log file must not look like one that
       reached a person. */
    emailStatus: text("email_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_replies_idx").on(t.enquiryId, t.createdAt)],
);
