/* ============================================================
   Platform admin — the back office for whoever runs CurrencyDesk.
   Cross-tenant, read-only views so the operator can see every desk that
   signed up, look one up to help a customer, and read the audit trail.
   Gated to PLATFORM_ADMIN_EMAILS (comma-separated) — a regular tenant
   owner can NOT reach these; only the platform operator can.
     GET /api/admin/tenants          → every desk + its owner
     GET /api/admin/tenants/:id      → one desk in detail
     GET /api/admin/audit            → recent events across all desks
     GET /api/admin/me               → am I a platform admin? (drives the UI)
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, revokeAllSessions, SESSION_COOKIE } from "../auth/sessions.js";
import { hashPassword } from "../auth/password.js";
import { issueCdId } from "../auth/cdid.js";
import { clearPinAttempts, generatePin, hashPin, pinLockedUntil } from "./pin.js";
import { forgetClaimedCount } from "./early-access.js";
import { makeReference } from "./enquiries.js";
import { audit } from "../audit.js";
import { sendEmail, inviteEmail, tempPasswordEmail, cdIdEmail, replyEmail, replyToAddress, makeCode, verificationEmail, type EmailStatus } from "../email.js";
import { hasHostedSite } from "../sites.js";
import { board, cleanLabel, labelsOf, moveTo, type Stage } from "../onboarding/pipeline.js";
import { can, member, refuseChange, ROLES, type Permission, type PlatformRole } from "../platform/team.js";
import { stripeBillingConfig } from "../billing/stripe.js";
import { systemHealth } from "../platform/health.js";
import { resetWalkthrough, WALKTHROUGH_REF } from "../onboarding/walkthrough.js";
import { CODE_TTL_MS, issueCode as issueVerificationCode, loadOrCreateOnboarding } from "../onboarding/verify.js";
import { VERIFY_CHANNEL } from "./onboarding-public.js";
import { DISPATCHES, DISPATCH, SILENT, delivery, sendableTo, type Recipient } from "../comms.js";
import { tenantPlan } from "./tenant.js";

const PLAN = z.enum(["trial", "basic", "pro", "premium"]);
const patchEnquiryBody = z
  .object({
    status: z.enum(schema.ENQUIRY_STATUSES as [Stage, ...Stage[]]).optional(),
    notes: z.string().max(4000).optional(),
    // send the stage's email again without pretending the stage changed
    resend: z.boolean().optional(),
    /* A note from the contact page is not an application and has no stages
       to walk. It is answered or it is not, and that is the whole model —
       which is why this is its own field rather than a status somebody had
       to squint at. Reversible, because "answered" is a claim a person
       makes and people misclick. */
    answered: z.boolean().optional(),
  })
  .refine((b) => b.status !== undefined || b.notes !== undefined || b.answered !== undefined, { message: "nothing to change" });
const replyBody = z.object({ body: z.string().trim().min(1, "write something first").max(6000) });
/* Sending one of the written emails to one person, by hand.

   `preview` is a flag on the same request rather than a route of its own,
   so what an operator is shown before pressing send and what actually
   leaves are produced by one call to one renderer. A preview that could
   drift from the send would be worse than no preview. */
const templateBody = z.object({
  template: z.string().trim().min(1).max(64),
  fields: z.record(z.string().max(6000)).optional(),
  preview: z.boolean().optional(),
});
const labelsBody = z.object({ labels: z.array(z.string().max(32)).max(12) });
const ROLE_IDS = ["owner", "support", "billing", "security", "privacy", "auditor"] as const;
const teamAddBody = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLE_IDS),
});
const teamPatchBody = z.object({
  role: z.enum(ROLE_IDS).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  name: z.string().trim().max(120).optional(),
}).refine((b) => b.role !== undefined || b.status !== undefined || b.name !== undefined, { message: "nothing to change" });

/* List prices in cents, mirroring the Stripe catalog. Held here so MRR can be
   worked out from a price id without a round trip to Stripe on every page
   load; if the catalog changes these move with it. */
const PLAN_LIST_CENTS: Record<"basic" | "pro" | "premium", number> = { basic: 29900, pro: 49900, premium: 74900 };
const patchTenantBody = z
  .object({ plan: PLAN.optional(), suspended: z.boolean().optional() })
  .refine((b) => b.plan !== undefined || b.suspended !== undefined, { message: "nothing to change" });
/* What an operator types to start somebody off: the same handful of things
   the early-access form asks, and nothing the customer should be answering
   themselves. No password here — theirs is set on their own screen. */
const inviteBody = z.object({
  ownerEmail: z.string().trim().toLowerCase().email().max(160),
  ownerName: z.string().trim().min(1).max(120),
  businessName: z.string().trim().max(120).optional(),
  country: z.string().trim().max(4).optional(),
  slug: z.string().trim().toLowerCase().max(40).regex(/^[a-z0-9-]*$/).optional(),
  website: z.string().trim().max(160).optional(),
});

const createTenantBody = z.object({
  businessName: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().toLowerCase().email().max(160),
  slug: z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug: lowercase letters, digits, hyphens"),
  plan: PLAN.default("trial"),
  password: z.string().min(8, "password: at least 8 characters").max(512),
});

/* Authorization comes from the platform_users table now, not from an env
   var. The env vars seed the first owner into an empty database and are
   ignored afterwards — see src/platform/team.ts for why that matters. */
// the operator's own tenant is not a customer desk — hide it from the lists
const PLATFORM_TENANT = "tnt-platform";
/* Kept sync and callback-shaped because registerOnboardingRoutes takes it
   that way; it answers from a cache the gate refreshes on every request, so
   a member removed in the panel stops being one on their next call. */
const memberCache = new Map<string, PlatformRole>();
export const isPlatformAdmin = (email: string | undefined): boolean =>
  !!email && memberCache.has(email.toLowerCase());

/* Readable aloud and hard to mistype: no vowels to form a word by accident,
   no characters that look like each other down a phone line. */
function tempPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(14);
  globalThis.crypto.getRandomValues(bytes);
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10)}`;
}

/* The desk's working book lives in its saved state as a bag of JSON strings,
   one per thing the OS keeps. Read the few that answer "how is this customer
   actually doing", and never let a malformed blob take the page down — a
   support screen that 500s when a customer rings is worse than one with a
   gap in it. */
type DeskSnapshot = {
  recentTransactions: Record<string, unknown>[];
  book: { transactions: number; volumeCad: number; feesCad: number; clients: number; lastTradeAt: string | null };
  deskSettings: { name: string | null; branches: number; currencies: number } | null;
};
async function deskSnapshot(db: Db, tenantId: string): Promise<DeskSnapshot> {
  const empty: DeskSnapshot = {
    recentTransactions: [],
    book: { transactions: 0, volumeCad: 0, feesCad: 0, clients: 0, lastTradeAt: null },
    deskSettings: null,
  };
  const row = (await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, tenantId)).limit(1))[0];
  const state = (row?.state ?? null) as Record<string, string> | null;
  if (!state) return empty;

  const read = <T,>(key: string, fallback: T): T => {
    try {
      const raw = state[key];
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };

  const rows = read<Record<string, unknown>[]>("cdos_rows_v1", []).filter((r) => r && typeof r === "object");
  const when = (r: Record<string, unknown>) => `${r.date ?? ""} ${r.time ?? ""}`.trim();
  const byNewest = [...rows].sort((a, b) => when(b).localeCompare(when(a)));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // only the fields a support conversation needs — the rest of a ticket
  // (compliance threads, tags, notes) is the customer's to see, not ours
  const recentTransactions = byNewest.slice(0, 5).map((r) => ({
    ref: r.ref ?? null, date: r.date ?? null, time: r.time ?? null, type: r.type ?? null,
    inCcy: r.inCcy ?? null, inAmt: num(r.inAmt), outCcy: r.outCcy ?? null, outAmt: num(r.outAmt),
    fee: num(r.fee), teller: r.teller ?? null, status: r.status ?? null,
  }));

  const settings = read<Record<string, unknown>>("cdos_settings", {});
  const branches = read<unknown[]>("cdos_branches_v1", []);
  const board = read<Record<string, unknown>>("yorkfx_rates_v1", {});

  return {
    recentTransactions,
    book: {
      transactions: rows.length,
      volumeCad: Math.round(rows.reduce((s, r) => s + num(r.inAmt), 0)),
      feesCad: Math.round(rows.reduce((s, r) => s + num(r.fee), 0)),
      clients: read<unknown[]>("cdos_clients_v1", []).length,
      lastTradeAt: byNewest[0] ? when(byNewest[0]) || null : null,
    },
    deskSettings: {
      name: typeof settings.deskName === "string" ? settings.deskName : null,
      branches: Array.isArray(branches) ? branches.length : 0,
      currencies: board && typeof board === "object" ? Object.keys(board).length : 0,
    },
  };
}

/* An enquiry as the email catalogue sees it. Everything a hand-sent
   email fills in about the person comes from here, off the record —
   never from the request — so no amount of typing in the panel can
   address an email to somebody else. */
const recipientOf = (row: typeof schema.enquiries.$inferSelect): Recipient => ({
  who: "applicant",
  name: row.name ?? null,
  email: row.email,
  reference: row.reference,
  status: row.status,
  kind: row.kind,
});

/* A staff member's address is their sign-in id, but only when that id is an
   address — plenty of desks sign their people in as "a.rostami". Somebody
   with no address cannot be written to, and saying so beats sending into
   the void. */
const STAFF_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const staffRecipient = (p: typeof schema.staffUsers.$inferSelect, deskName: string): Recipient => ({
  who: "staff",
  name: p.name ?? null,
  email: STAFF_EMAIL.test(p.staffId) ? p.staffId : "",
  reference: "",
  status: deskName,
  kind: "staff",
});

/* Where the customer-facing links point. */
const publicOrigin = (): string =>
  (process.env.PUBLIC_ORIGIN ?? "https://www.currencydeskos.com").replace(/\/+$/, "");

export function registerAdminRoutes(app: FastifyInstance, db: Db) {
  // resolve the session and confirm platform-admin; returns the user or null
  // (having already sent 401/403).
  /* `need` is the permission this route requires. Omitting it means "any
     member of the platform team", which is right for the read-only shell
     around everything else. */
  async function gate(req: any, reply: any, need?: Permission) {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    const me = await member(db, who.staffId);
    if (me) memberCache.set(me.email, me.role as PlatformRole);
    else memberCache.delete((who.staffId ?? "").toLowerCase());
    if (!me) {
      reply.code(403).send({ error: "forbidden", detail: "Platform team only." });
      return null;
    }
    if (need && !can(me.role as PlatformRole, need)) {
      reply.code(403).send({ error: "permission_denied", detail: `Your role (${me.role}) cannot ${need.replace(":", " ")}.` });
      return null;
    }
    (who as any).platform = me;
    return who;
  }


  // lightweight probe the UI calls to decide whether to show the admin app
  app.get("/api/admin/me", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    /* Ask the table, not the cache: this is usually the FIRST admin call a
       browser makes, and the cache is only warm once a gated route has run.
       Reading it here answered "no" to the owner on every fresh page load. */
    const me = who ? await member(db, who.staffId) : null;
    if (me) memberCache.set(me.email, me.role as PlatformRole);
    return {
      isAdmin: !!me,
      role: me?.role ?? null,
      email: me?.email ?? null,
      can: me ? Object.fromEntries((ROLES.find((r) => r.id === me.role)?.permissions ?? []).map((p) => [p, true])) : {},
    };
  });

  app.get("/api/admin/tenants", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const tenants = (await db.select().from(schema.tenants).orderBy(desc(schema.tenants.createdAt))).filter((t) => t.id !== PLATFORM_TENANT);
    // one owner (administrator) per tenant, mapped in a single query
    const admins = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.role, "administrator"));
    const ownerOf = new Map<string, (typeof admins)[number]>();
    for (const a of admins) if (!ownerOf.has(a.tenantId)) ownerOf.set(a.tenantId, a);
    // staff counts per tenant
    const allStaff = await db.select({ tenantId: schema.staffUsers.tenantId }).from(schema.staffUsers);
    const staffCount = new Map<string, number>();
    for (const s of allStaff) staffCount.set(s.tenantId, (staffCount.get(s.tenantId) || 0) + 1);

    const rows = tenants.map((t) => {
      const owner = ownerOf.get(t.id);
      const setup = (t.setup || {}) as Record<string, unknown>;
      return {
        id: t.id,
        name: t.name,
        slug: t.siteSlug,
        plan: t.plan, // raw purchased tier ('trial'/'basic'/'pro'/'premium')
        status: t.suspended ? "suspended" : t.plan === "trial" ? "trial" : "active",
        suspended: t.suspended,
        country: typeof setup.country === "string" ? setup.country : null,
        regulator: typeof setup.regulator === "string" ? setup.regulator : null,
        owner: owner ? { id: owner.id, staffId: owner.staffId, name: owner.name } : null,
        staffCount: staffCount.get(t.id) || 0,
        createdAt: t.createdAt,
      };
    });
    return { tenants: rows, total: rows.length };
  });

  app.get<{ Params: { id: string } }>("/api/admin/tenants/:id", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const id = req.params.id;
    const t = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1))[0];
    if (!t) return reply.code(404).send({ error: "not_found" });
    const entities = await db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, id));
    const staff = await db
      .select({ id: schema.staffUsers.id, staffId: schema.staffUsers.staffId, cdId: schema.staffUsers.cdId, name: schema.staffUsers.name, role: schema.staffUsers.role, active: schema.staffUsers.active, createdAt: schema.staffUsers.createdAt })
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.tenantId, id));
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, id)).orderBy(desc(schema.auditEvents.at)).limit(50);
    const plan = await tenantPlan(db, id);

    /* Everything you want in front of you when this customer rings up. The
       desk keeps its working book in its saved state, so that is where the
       trading picture comes from; the relational tables carry who they are. */
    const desk = await deskSnapshot(db, id);

    /* Where they came from. A desk that started as an early-access
       application can show it, which is the whole point of stamping the
       tenant on the application when the signup completes. */
    const application =
      (await db.select().from(schema.enquiries).where(eq(schema.enquiries.tenantId, id)).limit(1))[0] ?? null;

    /* Is their public board actually live?

       Three separate things have to be true and any of them can be false on
       its own, which is exactly why this was so hard to see: the desk has to
       have a site to serve, it has to have published a board, and a visitor
       has to be able to reach it. Answer all three in one place rather than
       leaving an operator to infer it. */
    const boards = await db
      .select()
      .from(schema.rateBoards)
      .where(eq(schema.rateBoards.tenantId, id))
      .orderBy(desc(schema.rateBoards.publishedAt))
      .limit(1);
    const board = boards[0] ?? null;
    const rows = (board?.boardRows ?? {}) as Record<string, { show?: boolean }>;
    const shown = Object.entries(rows).filter(([, r]) => r && r.show !== false);
    const hosted = !!t.siteSlug && hasHostedSite(t.siteSlug);
    const publicSite = {
      // the address anybody can reach today
      slug: t.siteSlug,
      path: t.siteSlug && hosted ? `/sites/${t.siteSlug}` : null,
      domain: t.siteDomain,
      // is a storefront actually deployed for this slug, or is it just a name?
      hosted,
      published: !!board,
      publishedAt: board ? board.publishedAt.getTime() : null,
      publishedBy: board?.publishedBy ?? null,
      currencies: shown.length,
      // what a visitor's browser would ask for
      ratesEndpoint: t.siteSlug ? `/api/sites/${t.siteSlug}/rates` : null,
      /* The one sentence an operator needs. Anything else is them working it
         out from three booleans, which is how "is it connected?" became a
         question nobody could answer. */
      status: !t.siteSlug
        ? "No public address yet."
        : !hosted
          ? "No storefront is deployed at this address yet."
          : !board
            ? "Site is live, but this desk has never published a board — visitors see no rates."
            : `Live. ${shown.length} currencies, last published ${board.publishedAt.toISOString()}.`,
    };

    return {
      tenant: { id: t.id, name: t.name, slug: t.siteSlug, plan: t.plan, entitledPlan: plan, suspended: t.suspended, siteDomain: t.siteDomain, setup: t.setup ?? null, createdAt: t.createdAt },
      publicSite,
      legalEntities: entities,
      staff,
      audit,
      ...desk,
      application,
    };
  });

  // one application, for its own page
  app.get<{ Params: { id: string } }>("/api/admin/enquiries/:id", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    const tenant = row.tenantId
      ? ((await db.select().from(schema.tenants).where(eq(schema.tenants.id, row.tenantId)).limit(1))[0] ?? null)
      : null;
    // anything else this address has sent us, so the history is in one place
    const alsoFrom = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.email, row.email)))
      .filter((e) => e.id !== row.id)
      .map((e) => ({ id: e.id, kind: e.kind, reference: e.reference, status: e.status, createdAt: e.createdAt }));
    // the same stage list the board uses, so one application's page offers
    // exactly the moves the board does — and exactly the ones that will work
    /* Our side of the thread, oldest first — the order a conversation is
       read in. Their own note is the enquiry itself and is already here. */
    const replies = (await db.select().from(schema.enquiryReplies)
      .where(eq(schema.enquiryReplies.enquiryId, row.id))
      .orderBy(schema.enquiryReplies.createdAt));
    return {
      enquiry: { ...row, tenantName: tenant?.name ?? null }, alsoFrom, stages: board(), replies,
      /* Which of the written emails can go to this particular person as
         they stand — computed here rather than in the browser, so the
         menu and the send agree by construction. */
      templates: sendableTo(recipientOf(row)),
      delivery: delivery(),
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/audit", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const events = await db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.at)).limit(limit);
    // decorate with the tenant name so the UI needn't join
    const tenantNames = new Map<string, string>();
    for (const t of await db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants)) tenantNames.set(t.id, t.name);
    return { events: events.map((e) => ({ ...e, tenantName: tenantNames.get(e.tenantId) || e.tenantId })) };
  });

  // a health snapshot for the dashboard header
  app.get("/api/admin/overview", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const tenants = (await db.select().from(schema.tenants)).filter((t) => t.id !== PLATFORM_TENANT);
    const staff = (await db.select({ tenantId: schema.staffUsers.tenantId }).from(schema.staffUsers)).filter((s) => s.tenantId !== PLATFORM_TENANT);
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const byStatus = { active: 0, trial: 0, suspended: 0 };
    const byPlan: Record<string, number> = {};
    let recent7 = 0;
    for (const t of tenants) {
      byPlan[t.plan] = (byPlan[t.plan] || 0) + 1;
      if (t.suspended) byStatus.suspended++;
      else if (t.plan === "trial") byStatus.trial++;
      else byStatus.active++;
      if (t.createdAt && new Date(t.createdAt).getTime() > weekAgo) recent7++;
    }
    const recentActivity = await db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.at)).limit(8);

    /* The funnel ahead of those desks. "waiting" is the number that should
       drive someone to open this page: applications nobody has answered. */
    // the walkthrough is a rehearsal, not a lead — it belongs in no total
    const apps = (await db.select().from(schema.enquiries)).filter((e) => e.kind === "early_access" && !e.isDemo);
    const byAppStatus: Record<string, number> = {};
    for (const s of schema.ENQUIRY_STATUSES) byAppStatus[s] = 0;
    for (const a of apps) byAppStatus[a.status] = (byAppStatus[a.status] || 0) + 1;
    const messages = (await db.select().from(schema.enquiries)).filter((e) => e.kind === "contact" && !e.isDemo);

    return {
      totals: { desks: tenants.length, people: staff.length, recent7 },
      byStatus,
      byPlan,
      recentActivity,
      funnel: {
        applications: apps.length,
        waiting: (byAppStatus.new ?? 0) + (byAppStatus.reviewing ?? 0),
        byStatus: byAppStatus,
        messages: messages.length,
        /* A message is answered or it is not — `handledAt` is the record
           of that, and it is what the Inbox sets. Counting by status here
           meant the badge never cleared, because nothing moves a contact
           note through the applications stages. */
        unread: messages.filter((m) => !m.handledAt).length,
      },
    };
  });

  /* ---- the funnel ahead of the desks -----------------------------------
     Every early-access application and contact message, and the operator's
     progress on each. Read the list, open one, move it along. */
  app.get<{ Querystring: { kind?: string; status?: string } }>("/api/admin/enquiries", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const { kind, status } = req.query;
    let rows = await db.select().from(schema.enquiries).orderBy(desc(schema.enquiries.createdAt));
    if (kind === "early_access" || kind === "contact") rows = rows.filter((r) => r.kind === kind);
    if (status && status !== "all") rows = rows.filter((r) => r.status === status);

    // an accepted application points at a real desk; carry its name so the
    // list can say what the application became without a second round trip
    const ids = [...new Set(rows.map((r) => r.tenantId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (ids.length) {
      for (const t of await db.select().from(schema.tenants).where(inArray(schema.tenants.id, ids))) {
        names.set(t.id, t.name);
      }
    }
    /* How many times we have written back, so the list can show a thread
       as a thread without opening every one of them. */
    const replyCount = new Map<string, number>();
    if (kind === "contact") {
      for (const r of await db.select({ id: schema.enquiryReplies.enquiryId }).from(schema.enquiryReplies)) {
        replyCount.set(r.id, (replyCount.get(r.id) ?? 0) + 1);
      }
    }
    return {
      enquiries: rows.map((r) => ({
        ...r,
        tenantName: r.tenantId ? (names.get(r.tenantId) ?? null) : null,
        replyCount: replyCount.get(r.id) ?? 0,
      })),
      /* The board's columns come from the server's own list of stages, and
         each carries the moves that leave it, so adding a stage later shows
         up in the panel without a second edit and the buttons on a card can
         never offer a move a transition would refuse. */
      stages: board(),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/enquiries/:id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = patchEnquiryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    /* Everything about moving an application lives in one place now — which
       stage may follow which, what the applicant hears on arrival, and how
       the move is recorded. A reviewer agent doing this later calls the same
       function with a different `by`. */
    if (parsed.data.notes !== undefined) {
      await db.update(schema.enquiries).set({ notes: parsed.data.notes }).where(eq(schema.enquiries.id, req.params.id));
    }
    /* Marking a message answered. Deliberately not routed through moveTo:
       the pipeline is the applications funnel, and a contact note has no
       business borrowing stages called "Invited" and "Open". */
    if (parsed.data.answered !== undefined) {
      const at = parsed.data.answered ? new Date() : null;
      await db.update(schema.enquiries).set({ handledAt: at, decidedBy: parsed.data.answered ? who.staffId : null })
        .where(eq(schema.enquiries.id, req.params.id));
      await audit(db, {
        tenantId: "tnt-platform", legalEntityId: "-", branchId: "-", actorId: who.id,
        action: "admin.message_answered",
        detail: { reference: row.reference, answered: parsed.data.answered },
      });
    }

    if (parsed.data.status === undefined) return { ok: true, answered: parsed.data.answered };

    // declining hands the place back to the site's "N of 100 claimed"
    if (parsed.data.status !== row.status) forgetClaimedCount();

    const moved = await moveTo(db, row, parsed.data.status as Stage, who.staffId, {
      actorId: who.id,
      resend: parsed.data.resend === true,
    });
    if (!moved.ok) return reply.code(400).send({ error: moved.error, detail: moved.detail });
    return { ok: true, from: moved.from, to: moved.to, email: moved.email, ...(moved.email ? { invite: moved.email } : {}) };
  });

  /* Labels — what an application is like, as opposed to where it is. */
  app.put<{ Params: { id: string } }>("/api/admin/enquiries/:id/labels", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = labelsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    // deduplicated and normalised, so "High Volume" and "high volume" are one
    const labels = [...new Set(parsed.data.labels.map(cleanLabel).filter(Boolean))].slice(0, 12);
    await db.update(schema.enquiries).set({ labels }).where(eq(schema.enquiries.id, req.params.id));
    return { ok: true, labels };
  });

  /* Every label anybody has used, so the panel can offer them back rather
     than making an operator remember what they typed last week. */
  app.get("/api/admin/labels", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const rows = await db.select({ labels: schema.enquiries.labels }).from(schema.enquiries);
    const seen = new Map<string, number>();
    for (const r of rows) for (const l of labelsOf(r)) seen.set(l, (seen.get(l) ?? 0) + 1);
    return { labels: [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })) };
  });

  /* Burn this code and issue another.

     Moving an application out of `invited` already stops its code opening
     anything — that is the revoke, and it needs no new machinery. This is
     the other case: the code itself has gone somewhere it should not have,
     and they need a different one. The old reference dies with it, so
     anybody holding it gets the same nothing as a stranger. */
  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/rotate", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.status === "accepted") {
      return reply.code(409).send({ error: "already_open", detail: "Their desk is open — the code has done its job." });
    }
    const was = row.reference;
    const reference = makeReference();
    await db.update(schema.enquiries).set({ reference }).where(eq(schema.enquiries.id, req.params.id));
    await audit(db, {
      tenantId: row.tenantId ?? PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.enquiry_code_rotated", detail: { was, now: reference },
    });
    /* Only re-send if they are holding a live invitation. Emailing a new code
       to somebody still in review would be telling them they are in. */
    let email: EmailStatus | null = null;
    if (row.status === "invited") {
      const m = await moveTo(db, { ...row, reference }, "invited", who.staffId, { actorId: who.id, resend: true });
      email = m.ok ? m.email : null;
    }
    return { ok: true, reference, was, email };
  });

  /* ---- who runs CurrencyDesk --------------------------------------------
     The team, the fixed roles, and what each may do. Readable by anybody on
     the team so they can see who else has access; changeable only by the
     owner. */
  app.get("/api/admin/team", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const rows = await db.select().from(schema.platformUsers).orderBy(schema.platformUsers.createdAt);
    const me = (who as any).platform as { email: string; role: string };
    return {
      me: { email: me.email, role: me.role, isOwner: me.role === "owner" },
      members: rows,
      roles: ROLES,
      canManage: can(me.role as PlatformRole, "team:manage"),
    };
  });

  app.post("/api/admin/team", async (req, reply) => {
    const who = await gate(req, reply, "team:manage");
    if (!who) return;
    const parsed = teamAddBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;
    if (b.role === "owner") {
      return reply.code(400).send({ error: "one_owner", detail: "There is one Platform Owner. Give them a role and hand ownership over deliberately if it ever needs to move." });
    }
    const existing = (await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, b.email)).limit(1))[0];
    if (existing) return reply.code(409).send({ error: "already_on_team", detail: `${b.email} is already ${existing.role}.` });
    await db.insert(schema.platformUsers).values({
      email: b.email, name: b.name ?? null, role: b.role, status: "active", addedBy: (who as any).platform.email,
    });
    await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "platform.team_added", detail: { email: b.email, role: b.role } });
    return reply.code(201).send({ ok: true });
  });

  app.patch<{ Params: { email: string } }>("/api/admin/team/:email", async (req, reply) => {
    const who = await gate(req, reply, "team:manage");
    if (!who) return;
    const parsed = teamPatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const target = (await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, decodeURIComponent(req.params.email).toLowerCase())).limit(1))[0];
    if (!target) return reply.code(404).send({ error: "not_found" });
    const actor = (who as any).platform;

    if (parsed.data.role !== undefined) {
      const no = refuseChange(actor, target, "role");
      if (no) return reply.code(403).send({ error: "protected", detail: no });
      if (parsed.data.role === "owner") return reply.code(400).send({ error: "one_owner", detail: "There is one Platform Owner." });
    }
    if (parsed.data.status !== undefined) {
      const no = refuseChange(actor, target, "status");
      if (no) return reply.code(403).send({ error: "protected", detail: no });
    }
    const set: Record<string, unknown> = {};
    if (parsed.data.role !== undefined) set.role = parsed.data.role;
    if (parsed.data.status !== undefined) set.status = parsed.data.status;
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    await db.update(schema.platformUsers).set(set).where(eq(schema.platformUsers.email, target.email));
    memberCache.delete(target.email);
    await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "platform.team_changed", detail: { email: target.email, ...set } });
    return { ok: true };
  });

  app.delete<{ Params: { email: string } }>("/api/admin/team/:email", async (req, reply) => {
    const who = await gate(req, reply, "team:manage");
    if (!who) return;
    const target = (await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, decodeURIComponent(req.params.email).toLowerCase())).limit(1))[0];
    if (!target) return reply.code(404).send({ error: "not_found" });
    const no = refuseChange((who as any).platform, target, "remove");
    if (no) return reply.code(403).send({ error: "protected", detail: no });
    await db.delete(schema.platformUsers).where(eq(schema.platformUsers.email, target.email));
    memberCache.delete(target.email);
    /* Their sessions go with their access. Removing somebody who stays
       signed in until their cookie expires is not removing them. */
    const staff = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, target.email));
    for (const u of staff) await revokeAllSessions(db, u.id);
    await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "platform.team_removed", detail: { email: target.email, was: target.role } });
    return { ok: true };
  });

  /* ---- the money ---------------------------------------------------------
     Stripe stays the source of truth; this reads what its webhooks have
     already told us. Amounts are in cents, as Stripe sends them, and are
     converted once at the edge rather than drifting through float maths.

     One distinction the panel must not blur: CASH COLLECTED is not REVENUE.
     A customer paying a year up front hands over twelve months of cash today
     and earns one month of it. These are Stripe's cash and subscription
     numbers; accounting recognition is a different report. */
  /* ---- writing back ------------------------------------------------------
     Somebody messaged us; this is answering them without leaving the panel.

     Sending is what marks the message answered — there is no separate
     button for "I replied", because a claim you have to remember to make
     is a claim that goes stale. The reply is kept with its delivery
     result, so "they say they never heard back" has an answer.

     Outbound only. Their response goes to the reply-to inbox, not into
     this table, and the panel says so rather than implying otherwise. */
  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/reply", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.isDemo) {
      return reply.code(400).send({ error: "is_walkthrough", detail: "The walkthrough has no inbox — nothing would arrive." });
    }

    const author = (await member(db, who.staffId))?.name || who.name || who.staffId;
    const mail = replyEmail({ name: row.name, body: parsed.data.body, reference: row.reference, from: author });
    const status = await sendEmail(row.email, mail.subject, { text: mail.text, html: mail.html, replyTo: replyToAddress() })
      .catch(() => "failed" as const);

    const saved = {
      id: randomUUID(), enquiryId: row.id, body: parsed.data.body,
      sentBy: who.staffId, emailStatus: status,
    };
    await db.insert(schema.enquiryReplies).values(saved);
    // answering IS the thing that marks it answered
    await db.update(schema.enquiries).set({ handledAt: new Date(), decidedBy: who.staffId })
      .where(eq(schema.enquiries.id, row.id));
    await audit(db, {
      tenantId: "tnt-platform", legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.enquiry_replied", detail: { reference: row.reference, email: status },
    });
    return reply.code(201).send({ ok: true, email: status, reply: { ...saved, createdAt: new Date().toISOString() } });
  });

  /* ---- send one of the written emails, to one person --------------------

     The Inbox reply is one email written from scratch. This is the rest of
     them: pick a template off the catalogue, see exactly what will go, send
     it. Everything about the person — their name, their address, their
     reference — comes off their record, so the only thing an operator can
     supply is the part the template genuinely cannot know.

     Whatever goes out is written onto the thread with the same shape a
     reply has, because from the customer's side there is no difference: an
     email arrived from us, and the next person to open this page needs to
     know it did. */
  /* Everything up to the moment of sending, shared by both kinds of
     recipient. Returns the rendered mail, or null having already answered
     with the reason it cannot go — so the applicant route and the staff
     route cannot drift into disagreeing about what is allowed. */
  async function compose(req: any, reply: any, who: any, to: Recipient) {
    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message }); return null; }
    const { template, fields = {}, preview } = parsed.data;

    const d = DISPATCH.get(template);
    if (!d) { reply.code(404).send({ error: "no_such_template", detail: `There is no email called "${template}".` }); return null; }
    if (!d.manual) {
      reply.code(400).send({ error: "not_sendable_by_hand", detail: d.elsewhere ?? "This one is not something to send by hand." });
      return null;
    }
    if (!to.email) {
      reply.code(409).send({ error: "no_address", detail: "There is no email address on file for them — they sign in with a name rather than an address." });
      return null;
    }
    const blocked = d.manual.blocked?.(to);
    if (blocked) { reply.code(409).send({ error: "blocked", detail: blocked }); return null; }

    for (const f of d.manual.needs) {
      if (!(fields[f.id] ?? "").trim()) {
        reply.code(400).send({ error: "missing_field", detail: `${f.label} is empty — there is nothing to send.` });
        return null;
      }
    }

    const author = (await member(db, who.staffId))?.name || who.name || who.staffId;
    const mail = d.manual.render(to, fields, { origin: publicOrigin(), from: author });
    return { d, mail, preview: !!preview };
  }

  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/email", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;

    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });

    const c = await compose(req, reply, who, recipientOf(row));
    if (!c) return;
    const { d, mail } = c;

    /* Shown, not sent. Same render, one branch later — see templateBody. */
    if (c.preview) return { preview: true, template: d.id, to: row.email, ...mail };

    if (row.isDemo) {
      return reply.code(400).send({ error: "is_walkthrough", detail: "The walkthrough has no inbox — nothing would arrive." });
    }

    const status = await sendEmail(row.email, mail.subject, { text: mail.text, html: mail.html, replyTo: replyToAddress() })
      .catch(() => "failed" as const);

    const saved = {
      id: randomUUID(), enquiryId: row.id,
      /* The thread stores what was actually said, not the name of a
         template — a year from now "invite" tells nobody anything. */
      body: mail.text,
      sentBy: who.staffId, emailStatus: status,
    };
    await db.insert(schema.enquiryReplies).values(saved);
    await db.update(schema.enquiries).set({ handledAt: row.handledAt ?? new Date(), decidedBy: who.staffId })
      .where(eq(schema.enquiries.id, row.id));
    await audit(db, {
      tenantId: "tnt-platform", legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.enquiry_emailed", detail: { reference: row.reference, template: d.id, email: status },
    });
    return reply.code(201).send({
      ok: true, template: d.id, email: status, subject: mail.subject,
      reply: { ...saved, createdAt: new Date().toISOString() },
    });
  });

  /* The same thing, to somebody who already has a desk.

     "Email owner" used to be a mailto: link — which is to say, it handed
     the conversation to whatever mail client the operator happened to have
     open. That mail is in the wrong voice, off the record, and invisible
     to whoever picks the customer up next. It goes through here now, and
     lands on the desk's audit trail like everything else. */
  app.post<{ Params: { id: string } }>("/api/admin/staff/:id/email", async (req, reply) => {
    const who = await gate(req, reply, "desks:write");
    if (!who) return;

    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });
    const desk = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, p.tenantId)).limit(1))[0];

    const c = await compose(req, reply, who, staffRecipient(p, desk?.name ?? ""));
    if (!c) return;
    const { d, mail } = c;
    if (c.preview) return { preview: true, template: d.id, to: p.staffId, ...mail };

    const status = await sendEmail(p.staffId, mail.subject, { text: mail.text, html: mail.html, replyTo: replyToAddress() })
      .catch(() => "failed" as const);
    await audit(db, {
      tenantId: p.tenantId, legalEntityId: p.legalEntityId, branchId: p.branchId, actorId: who.id,
      action: "admin.staff_emailed",
      /* The subject, not the body. What was said to a customer belongs on
         the record; the audit trail is not the place to keep a copy of
         every sentence, and a subject is enough to find the conversation. */
      detail: { to: p.staffId, template: d.id, subject: mail.subject, email: status },
    });
    return reply.code(201).send({ ok: true, template: d.id, email: status, subject: mail.subject });
  });

  /* ---- their confirmation code, minted for real -------------------------

     Setup asks them to confirm their address before the desk is built, and
     normally they press the button on their own screen. On the phone that
     is one instruction too many, and if their mail is slow it is a dead
     end — so this issues one from the panel.

     It is the SAME code their screen would have issued, through the same
     storage, on the same ten-minute clock. It is not a template rendered
     from something somebody typed; that distinction is the whole reason
     the written "verification code" email cannot be hand-sent.

     WHILE EMAIL IS OFF, THE CODE COMES BACK AND THE PANEL SHOWS IT.

     That is a deliberate decision and it deserves saying out loud: with no
     provider configured nothing reaches anybody, so a code that only ever
     went to a log file makes setup impossible to finish, including for us
     testing our own product. The moment sending works, it goes to them and
     the panel stops showing it. Reading it out on a call you placed is the
     same act as them reading it off their screen. */
  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/verify-code", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;

    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.kind !== "early_access") {
      return reply.code(400).send({ error: "not_an_application", detail: "Only an application has a setup to confirm." });
    }
    if (row.status !== "invited") {
      return reply.code(409).send({
        error: "not_invited",
        detail: row.status === "accepted"
          ? "Their desk is already open — there is nothing left to confirm."
          : "Their setup is not open yet. Approve them first.",
      });
    }

    /* Whatever address their setup is working against, which is not
       necessarily the one they applied with — plenty of people apply from
       a personal address and run the desk from a shared one. */
    const onb = await loadOrCreateOnboarding(db, row.id);
    const answers = (onb.answers ?? {}) as Record<string, unknown>;
    const to = String(answers.ownerEmail ?? row.email ?? "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(to)) {
      return reply.code(400).send({ error: "no_email", detail: "There is no owner address on their setup yet." });
    }

    const code = makeCode();
    await issueVerificationCode(db, row.id, code, to, VERIFY_CHANNEL);
    const mail = verificationEmail(code, String(answers.bizName ?? answers.operatingName ?? ""));
    const status = await sendEmail(to, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);

    await audit(db, {
      tenantId: "tnt-platform", legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.verify_code_issued", detail: { reference: row.reference, to, email: status },
    });
    return {
      ok: true, sentTo: to, email: status,
      /* Withheld the moment it can actually reach them. */
      code: status === "sent" ? null : code,
      expiresInMinutes: Math.round(CODE_TTL_MS / 60000),
    };
  });

  /* ---- put the rehearsal back -------------------------------------------
     The walkthrough is a real application against the real customer flow,
     so running it leaves answers behind and the second run would start
     halfway through. This wipes those, not the application. It is the only
     record that can be reset — a real applicant's answers are theirs. */
  app.post("/api/admin/walkthrough/reset", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    await resetWalkthrough(db);
    await audit(db, {
      tenantId: "tnt-platform", legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.walkthrough_reset", detail: { reference: WALKTHROUGH_REF },
    });
    return { ok: true, reference: WALKTHROUGH_REF };
  });

  /* ---- is anything broken right now -------------------------------------
     The screen you open when somebody says "it's not working". Every check
     answers in one sentence and says where to go and fix it. */
  app.get("/api/admin/health", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    return systemHealth(db);
  });

  /* ---- what we say to people --------------------------------------------
     The catalogue of every email, what fires it, and whether sending is
     live or simulated. Also the two stages that deliberately say nothing,
     because an operator should not have to guess about silence. */
  app.get("/api/admin/comms", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    return {
      delivery: delivery(),
      dispatches: DISPATCHES.map((d) => ({
        id: d.id, title: d.title, audience: d.audience,
        when: d.when, automatic: d.automatic, stage: d.stage ?? null,
        /* Whether an operator can reach for this one on a person's page,
           and if not, where the send actually lives. */
        manual: d.manual ? { action: d.manual.action, needs: d.manual.needs } : null,
        elsewhere: d.elsewhere ?? null,
        sample: d.sample(),
      })),
      silent: SILENT,
    };
  });

  /* ---- send yourself a sample -------------------------------------------

     The Emails page renders every template, which answers "is the markup
     right" and not "what does this look like in Gmail on a phone". Those
     are different questions, and only the second one catches the things
     that actually go wrong: Outlook renders through Word, Gmail clips a
     long message, a dark-mode client inverts a cream background.

     So: type an address, get the real thing. It goes through the same
     sendEmail as everything else, from the same domain, so what lands is
     what a customer would get.

     IT REFUSES TO SEND TO A CUSTOMER. Sample data carries a made-up
     reference and a setup link that opens nothing, and an applicant
     receiving "You're in" out of the blue is a phone call you cannot take
     back. Addresses belonging to an application or to somebody on a
     customer desk are turned away by name. */
  const sampleBody = z.object({
    to: z.array(z.string().trim().toLowerCase().email()).min(1).max(5),
    /* Omitted means all of them — which is the usual reason to be here. */
    template: z.string().trim().max(64).optional(),
  });

  app.post("/api/admin/comms/sample", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    const parsed = sampleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { to, template } = parsed.data;

    const chosen = template ? DISPATCHES.filter((d) => d.id === template) : DISPATCHES;
    if (chosen.length === 0) return reply.code(404).send({ error: "no_such_template", detail: `There is no email called "${template}".` });

    /* Everyone this platform could reach for real. Platform team members
       are fine — that is who is asking — but an applicant or a customer's
       staff is not. */
    const applicants = new Set((await db.select().from(schema.enquiries)).map((e) => e.email.toLowerCase()));
    const team = new Set((await db.select().from(schema.platformUsers)).map((m) => m.email.toLowerCase()));
    const customerStaff = new Set(
      (await db.select().from(schema.staffUsers))
        .filter((s) => !team.has(s.staffId.toLowerCase()))
        .map((s) => s.staffId.toLowerCase()),
    );
    for (const addr of to) {
      if (team.has(addr)) continue;
      if (applicants.has(addr) || customerStaff.has(addr)) {
        return reply.code(409).send({
          error: "real_person",
          detail: `${addr} belongs to somebody in the system. Samples carry a made-up reference and a link that opens nothing — send them to your own inbox instead.`,
        });
      }
    }

    const sent: { to: string; template: string; email: EmailStatus }[] = [];
    for (const addr of to) {
      for (const d of chosen) {
        const s = d.sample();
        if (!s.html && !s.text) continue;
        const status = await sendEmail(addr, s.subject, { text: s.text, html: s.html || undefined, replyTo: replyToAddress() })
          .catch(() => "failed" as const);
        sent.push({ to: addr, template: d.id, email: status });
      }
    }
    await audit(db, {
      tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.samples_sent", detail: { to, templates: chosen.map((d) => d.id), results: sent.map((s) => s.email) },
    });
    return reply.code(201).send({ ok: true, delivery: delivery(), sent });
  });

  app.get("/api/admin/billing", async (req, reply) => {
    const who = await gate(req, reply, "billing:read");
    if (!who) return;

    const subs = await db.select().from(schema.stripeSubscriptions);
    const invoices = await db.select().from(schema.stripeInvoices).orderBy(desc(schema.stripeInvoices.updatedAt));
    const tenants = await db.select().from(schema.tenants);
    const names = new Map(tenants.map((t) => [t.id, t.name]));

    const cfg = stripeBillingConfig();
    const monthlyCents = (s: typeof subs[number]): number => {
      if (!s.priceId || !cfg) return 0;
      for (const plan of ["basic", "pro", "premium"] as const) {
        const p = cfg.prices[plan];
        if (p.monthly === s.priceId) return PLAN_LIST_CENTS[plan];
        // annual list price spread across the year it covers
        if (p.annual === s.priceId) return Math.round((PLAN_LIST_CENTS[plan] * 12 * 0.9) / 12);
      }
      return 0;
    };

    const live = subs.filter((s) => s.status === "active" || s.status === "past_due");
    const trialing = subs.filter((s) => s.status === "trialing");
    const cancelled = subs.filter((s) => s.status === "canceled" || s.status === "unpaid");
    const mrr = live.reduce((n, s) => n + monthlyCents(s), 0);

    const since = (days: number) => Date.now() - days * 864e5;
    const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0, 0, 0, 0);
    const paidThisMonth = invoices.filter((i) => i.status === "paid" && i.updatedAt.getTime() >= thisMonth.getTime());
    const needsAttention = invoices.filter((i) => i.status === "open" || i.status === "uncollectible");

    const byPlan = (["basic", "pro", "premium"] as const).map((plan) => {
      const inPlan = live.filter((s) => s.plan === plan);
      return { plan, subscribers: inPlan.length, mrrCents: inPlan.reduce((n, s) => n + monthlyCents(s), 0) };
    });

    const events = await db.select().from(schema.stripeEvents).orderBy(desc(schema.stripeEvents.receivedAt)).limit(1);
    return {
      connected: !!cfg,
      /* A webhook that has not spoken in a while is the failure that hides:
         the panel keeps showing yesterday's numbers as though they were
         today's, and nothing looks wrong. */
      lastEventAt: events[0]?.receivedAt?.getTime() ?? null,
      mrrCents: mrr,
      arrCents: mrr * 12,
      activePaying: live.length,
      trialing: trialing.length,
      cancelled: cancelled.length,
      newThisMonth: subs.filter((s) => s.createdAt.getTime() >= thisMonth.getTime()).length,
      cashCollectedThisMonthCents: paidThisMonth.reduce((n, i) => n + (i.amountPaid ?? 0), 0),
      taxCollectedThisMonthCents: paidThisMonth.reduce((n, i) => n + (i.tax ?? 0), 0),
      expectedThisMonthCents: live.reduce((n, s) => n + monthlyCents(s), 0),
      byPlan,
      needsAttention: needsAttention.slice(0, 25).map((i) => ({
        invoiceId: i.stripeInvoiceId, tenantId: i.tenantId, tenantName: names.get(i.tenantId) ?? i.tenantId,
        status: i.status, amountDueCents: i.amountDue ?? 0, currency: i.currency,
        url: i.hostedInvoiceUrl, at: i.updatedAt.getTime(),
      })),
      recent: invoices.slice(0, 20).map((i) => ({
        invoiceId: i.stripeInvoiceId, tenantName: names.get(i.tenantId) ?? i.tenantId,
        status: i.status, amountPaidCents: i.amountPaid ?? 0, currency: i.currency,
        url: i.hostedInvoiceUrl, at: i.updatedAt.getTime(),
      })),
      subscribers: live.concat(trialing).map((s) => ({
        tenantId: s.tenantId, tenantName: names.get(s.tenantId) ?? s.tenantId,
        plan: s.plan, status: s.status, mrrCents: monthlyCents(s),
        cancelAtPeriodEnd: s.cancelAtPeriodEnd, periodEnd: s.currentPeriodEnd?.getTime() ?? null,
      })),
    };
  });

  /* ---- one person -------------------------------------------------------
     Support acts on people, not just desks: someone leaves, someone's laptop
     goes missing, someone can't get in. */
  app.get<{ Params: { id: string } }>("/api/admin/staff/:id", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });
    const tenant = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, p.tenantId)).limit(1))[0];
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, p.id));
    const now = Date.now();
    const live = sessions.filter((s) => !s.revokedAt && new Date(s.expiresAt).getTime() > now);
    const events = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, p.tenantId)).orderBy(desc(schema.auditEvents.at)).limit(200))
      .filter((e) => e.actorId === p.id)
      .slice(0, 25);
    const lastSignIn = sessions.length
      ? sessions.map((s) => new Date(s.createdAt).getTime()).sort((a, b) => b - a)[0]
      : null;
    return {
      person: {
        id: p.id, staffId: p.staffId, cdId: p.cdId, name: p.name, role: p.role, active: p.active,
        mustChangePassword: p.mustChangePassword, passwordUpdatedAt: p.passwordUpdatedAt,
        createdAt: p.createdAt, tenantId: p.tenantId, branchId: p.branchId,
        authorizedBranchIds: p.authorizedBranchIds,
        // the PIN itself is never readable — only whether one exists, when it
        // was set, and whether the keypad is currently shut against them
        hasPin: !!p.pinHash, pinSetAt: p.pinSetAt, pinLockedUntil: pinLockedUntil(p.id),
        pinMustChange: p.pinMustChange,
      },
      desk: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.siteSlug, suspended: tenant.suspended } : null,
      sessions: { live: live.length, lastSignInAt: lastSignIn ? new Date(lastSignIn).toISOString() : null },
      events,
      /* What can be written to them, and what cannot — same catalogue the
         applications side uses, asked about a person with an account
         rather than an application. */
      templates: sendableTo(staffRecipient(p, tenant?.name ?? "")),
      delivery: delivery(),
      canEmail: STAFF_EMAIL.test(p.staffId),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/staff/:id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "active is required" });
    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });

    await db.update(schema.staffUsers).set({ active: parsed.data.active }).where(eq(schema.staffUsers.id, p.id));
    /* Blocking somebody has to take effect now, not when their cookie happens
       to expire — that is the whole reason to reach for it. */
    if (!parsed.data.active) await revokeAllSessions(db, p.id);
    await audit(db, {
      tenantId: p.tenantId, legalEntityId: p.legalEntityId, branchId: p.branchId, actorId: who.id,
      action: parsed.data.active ? "admin.person_unblocked" : "admin.person_blocked",
      detail: { staffId: p.staffId, name: p.name },
    });
    return { ok: true };
  });

  /* Reset a password the way support actually does it: issue a temporary one,
     force a change at next sign-in, sign every device out, and email it. The
     operator never sees it, so it cannot be read back out of this panel. */
  app.post<{ Params: { id: string } }>("/api/admin/staff/:id/reset-password", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });

    const temp = tempPassword();
    await db
      .update(schema.staffUsers)
      .set({ passwordHash: await hashPassword(temp), mustChangePassword: true, passwordUpdatedAt: new Date() })
      .where(eq(schema.staffUsers.id, p.id));
    await revokeAllSessions(db, p.id);

    let delivered: EmailStatus | "no_address" = "no_address";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.staffId)) {
      const mail = tempPasswordEmail({ name: p.name, tempPassword: temp, signInId: p.cdId || p.staffId });
      delivered = await sendEmail(p.staffId, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
    }
    await audit(db, {
      tenantId: p.tenantId, legalEntityId: p.legalEntityId, branchId: p.branchId, actorId: who.id,
      action: "admin.password_reset", detail: { staffId: p.staffId, delivered },
    });
    /* Only hand the password back when there was no address to send it to —
       otherwise the operator would have a copy of a live credential. */
    return { ok: true, delivered, ...(delivered === "no_address" ? { tempPassword: temp } : {}) };
  });

  /* Reset somebody's till PIN. Handed back to the operator, because the
     person who needs it is almost always on the phone and tellers rarely have
     an email address — and a PIN is a local confirmation, not a credential
     that opens the desk on its own. */
  app.post<{ Params: { id: string } }>("/api/admin/staff/:id/reset-pin", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });

    const pin = generatePin();
    await db.update(schema.staffUsers).set({ pinHash: await hashPin(pin), pinSetAt: new Date(), pinMustChange: true }).where(eq(schema.staffUsers.id, p.id));
    clearPinAttempts(p.id);
    await audit(db, {
      tenantId: p.tenantId, legalEntityId: p.legalEntityId, branchId: p.branchId, actorId: who.id,
      action: "admin.pin_reset", detail: { staffId: p.staffId },
    });
    return { ok: true, pin };
  });

  // issue a CurrencyDesk ID, or replace one that has been given out too widely
  app.post<{ Params: { id: string } }>("/api/admin/staff/:id/cd-id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const p = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, req.params.id)).limit(1))[0];
    if (!p) return reply.code(404).send({ error: "not_found" });

    const previous = p.cdId;
    const cdId = await issueCdId(db, p.tenantId);
    await db.update(schema.staffUsers).set({ cdId }).where(eq(schema.staffUsers.id, p.id));

    let delivered: EmailStatus | "no_address" = "no_address";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.staffId)) {
      const mail = cdIdEmail({ name: p.name, cdId, replaced: !!previous });
      delivered = await sendEmail(p.staffId, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
    }
    await audit(db, {
      tenantId: p.tenantId, legalEntityId: p.legalEntityId, branchId: p.branchId, actorId: who.id,
      action: previous ? "admin.cd_id_reissued" : "admin.cd_id_issued",
      detail: { staffId: p.staffId, from: previous, to: cdId, delivered },
    });
    return { ok: true, cdId, previous, delivered };
  });

  // block/unblock a desk, or change its plan
  app.patch<{ Params: { id: string } }>("/api/admin/tenants/:id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = patchTenantBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const id = req.params.id;
    const t = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1))[0];
    if (!t) return reply.code(404).send({ error: "not_found" });
    const set: Record<string, unknown> = {};
    if (parsed.data.plan !== undefined) set.plan = parsed.data.plan;
    if (parsed.data.suspended !== undefined) set.suspended = parsed.data.suspended;
    await db.update(schema.tenants).set(set).where(eq(schema.tenants.id, id));
    const action = parsed.data.suspended !== undefined ? (parsed.data.suspended ? "admin.desk_suspended" : "admin.desk_unsuspended") : "admin.plan_changed";
    await audit(db, { tenantId: id, legalEntityId: "-", branchId: "-", actorId: who.id, action, detail: parsed.data });
    return { ok: true };
  });

  /* ---- start a desk -----------------------------------------------------
     Adding a desk does not create a desk. It creates the INVITATION to one:
     a reference, an onboarding record holding what we already know, and an
     email with the link. The shop exists at the end of their setup, not the
     start of ours — which is the only order in which the answers can be
     theirs.

     Everything the early-access form asks, an operator can type here on
     somebody's behalf, so a shop signed up at the counter and a shop that
     found the website arrive at exactly the same screen. */
  app.post("/api/admin/onboarding/invite", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;

    if ((await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, b.ownerEmail)).limit(1)).length) {
      return reply.code(409).send({ error: "email_in_use", detail: "That email already owns a desk." });
    }
    /* One live invitation per address. Sending a second would put two
       references in one inbox, and whichever they opened second would be the
       one that loses their answers. */
    const existing = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.email, b.ownerEmail)))
      .find((e) => e.kind === "early_access" && (e.status === "invited" || e.status === "accepted"));

    const origin = publicOrigin();
    const linkFor = (ref: string) => `${origin}/onboarding/${encodeURIComponent(ref)}`;
    if (existing) {
      const mail = inviteEmail({
        name: existing.name, reference: existing.reference, origin,
        shopName: b.businessName || null, cohortNo: existing.charterNo,
      });
      const sent = await sendEmail(existing.email, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
      return {
        ok: true, resent: true, reference: existing.reference, link: linkFor(existing.reference), invite: sent,
        detail: "They already had an invitation — we sent that same link again rather than a second one.",
      };
    }

    /* Their place in the founding cohort, the same way the site issues it:
       the next one nobody has had. Counted off the highest ever issued so a
       declined application never hands its number on. */
    const issued = (await db.select({ n: schema.enquiries.charterNo }).from(schema.enquiries)).map((r) => r.n ?? 0);
    const charterNo = (issued.length ? Math.max(...issued) : 0) + 1;
    const reference = makeReference();
    const id = randomUUID();

    forgetClaimedCount();
    await db.insert(schema.enquiries).values({
      id, reference, kind: "early_access",
      email: b.ownerEmail, name: b.ownerName,
      details: {
        workspace: b.slug ? `${b.slug}.currencydeskos.com` : undefined,
        jurisdiction: b.country,
        website: b.website || undefined,
        businessName: b.businessName || undefined,
        addedBy: who.staffId,
      },
      status: "invited", charterNo, decidedAt: new Date(), decidedBy: who.staffId,
    });

    /* Seed their setup with what we just typed, so the first screen they see
       already knows the shop's name rather than asking for it again. */
    if (b.businessName) {
      await db.insert(schema.onboarding).values({ enquiryId: id, answers: { operatingName: b.businessName } }).onConflictDoNothing();
    }

    const mail = inviteEmail({
      name: b.ownerName, reference, origin, shopName: b.businessName || null, cohortNo: charterNo,
    });
    const sent = await sendEmail(b.ownerEmail, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
    await audit(db, {
      tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId: who.id,
      action: "admin.onboarding_invited", detail: { reference, email: b.ownerEmail, invite: sent },
    });
    return reply.code(201).send({ ok: true, reference, link: linkFor(reference), charterNo, invite: sent });
  });

  // create a desk by hand, skipping onboarding entirely. Kept for the cases
  // that genuinely need it; the panel's "add a desk" invites instead.
  app.post("/api/admin/tenants", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = createTenantBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;
    if ((await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.siteSlug, b.slug)).limit(1)).length) return reply.code(409).send({ error: "slug_taken", detail: "That desk address is taken." });
    if ((await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, b.ownerEmail)).limit(1)).length) return reply.code(409).send({ error: "email_in_use", detail: "That email already owns a desk." });
    const tenantId = "tnt-" + b.slug, legalEntityId = "le-" + b.slug, branchId = "br-" + b.slug + "-main", workspaceId = "ws-" + b.slug + "-till-01";
    await db.insert(schema.tenants).values({ id: tenantId, name: b.businessName, plan: b.plan, siteSlug: b.slug }).onConflictDoNothing();
    await db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: b.businessName, jurisdiction: "FINTRAC" }).onConflictDoNothing();
    await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Main" }).onConflictDoNothing();
    await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" }).onConflictDoNothing();
    await db.insert(schema.staffUsers).values({ id: `${tenantId}:${b.ownerEmail}`, tenantId, legalEntityId, branchId, staffId: b.ownerEmail, name: b.ownerName, role: "administrator", authorizedBranchIds: [branchId], passwordHash: await hashPassword(b.password), mustChangePassword: true, passwordUpdatedAt: new Date() }).onConflictDoNothing();
    await audit(db, { tenantId, legalEntityId, branchId, actorId: who.id, action: "tenant.created", detail: { via: "admin", slug: b.slug, email: b.ownerEmail } });
    return reply.code(201).send({ ok: true, tenant: { id: tenantId, name: b.businessName, slug: b.slug, plan: b.plan } });
  });

  // permanently delete a desk and ALL its data (cascade, FK-safe order)
  app.delete<{ Params: { id: string } }>("/api/admin/tenants/:id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const id = req.params.id;
    const t = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1))[0];
    if (!t) return reply.code(404).send({ error: "not_found" });
    // safety: a desk must be SUSPENDED before it can be deleted — deletion is a
    // deliberate, last-resort step, and destroys records we keep for 6 years.
    if (!t.suspended) return reply.code(409).send({ error: "not_suspended", detail: "Suspend the desk first. Deletion permanently destroys 6-year retention records and is a deliberate last resort." });
    const staff = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, id));
    const staffIds = staff.map((s) => s.id);
    if (staffIds.length) await db.delete(schema.sessions).where(inArray(schema.sessions.userId, staffIds));
    await db.delete(schema.staffUsers).where(eq(schema.staffUsers.tenantId, id));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.tenantId, id));
    await db.delete(schema.rateBoards).where(eq(schema.rateBoards.tenantId, id));
    await db.delete(schema.branches).where(eq(schema.branches.tenantId, id));
    await db.delete(schema.rateQuotes).where(eq(schema.rateQuotes.tenantId, id));
    await db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, id));
    await db.delete(schema.legalEntities).where(eq(schema.legalEntities.tenantId, id));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.tenantId, id));
    await db.delete(schema.tenants).where(eq(schema.tenants.id, id));
    // record the deletion under the admin's own tenant so it survives
    await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "admin.desk_deleted", detail: { id, name: t.name, slug: t.siteSlug } });
    return { ok: true, deleted: id };
  });
}
