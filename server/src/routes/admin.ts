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
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, revokeAllSessions, SESSION_COOKIE } from "../auth/sessions.js";
import { hashPassword } from "../auth/password.js";
import { issueCdId } from "../auth/cdid.js";
import { clearPinAttempts, generatePin, hashPin, pinLockedUntil } from "./pin.js";
import { forgetClaimedCount } from "./early-access.js";
import { audit } from "../audit.js";
import { sendEmail, inviteEmail, tempPasswordEmail, cdIdEmail, type EmailStatus } from "../email.js";
import { tenantPlan } from "./tenant.js";

const PLAN = z.enum(["trial", "basic", "pro", "premium"]);
const patchEnquiryBody = z
  .object({
    status: z.enum(["new", "reviewing", "invited", "accepted", "declined"]).optional(),
    notes: z.string().max(4000).optional(),
  })
  .refine((b) => b.status !== undefined || b.notes !== undefined, { message: "nothing to change" });
const patchTenantBody = z
  .object({ plan: PLAN.optional(), suspended: z.boolean().optional() })
  .refine((b) => b.plan !== undefined || b.suspended !== undefined, { message: "nothing to change" });
const createTenantBody = z.object({
  businessName: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().toLowerCase().email().max(160),
  slug: z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug: lowercase letters, digits, hyphens"),
  plan: PLAN.default("trial"),
  password: z.string().min(8, "password: at least 8 characters").max(512),
});

function platformAdmins(): Set<string> {
  const set = new Set(
    (process.env.PLATFORM_ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  // the bootstrapped operator email is always a platform admin
  const boot = process.env.PLATFORM_ADMIN_BOOTSTRAP;
  if (boot) { const email = boot.split(":")[0]?.trim().toLowerCase(); if (email) set.add(email); }
  return set;
}
// the operator's own tenant is not a customer desk — hide it from the lists
const PLATFORM_TENANT = "tnt-platform";
export const isPlatformAdmin = (email: string | undefined): boolean =>
  !!email && platformAdmins().has(email.toLowerCase());

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

export function registerAdminRoutes(app: FastifyInstance, db: Db) {
  // resolve the session and confirm platform-admin; returns the user or null
  // (having already sent 401/403).
  async function gate(req: any, reply: any) {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (!isPlatformAdmin(who.staffId)) {
      reply.code(403).send({ error: "forbidden", detail: "Platform admin only." });
      return null;
    }
    return who;
  }

  // lightweight probe the UI calls to decide whether to show the admin app
  app.get("/api/admin/me", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    return { isAdmin: !!who && isPlatformAdmin(who.staffId) };
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

    return {
      tenant: { id: t.id, name: t.name, slug: t.siteSlug, plan: t.plan, entitledPlan: plan, suspended: t.suspended, siteDomain: t.siteDomain, setup: t.setup ?? null, createdAt: t.createdAt },
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
    return { enquiry: { ...row, tenantName: tenant?.name ?? null }, alsoFrom };
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
        unread: messages.filter((m) => m.status === "new").length,
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
    return {
      enquiries: rows.map((r) => ({ ...r, tenantName: r.tenantId ? (names.get(r.tenantId) ?? null) : null })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/enquiries/:id", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = patchEnquiryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    /* "accepted" means a desk exists, which only a completed signup can make
       true. Letting it be set by hand would put a lie in the funnel. */
    if (parsed.data.status === "accepted") {
      return reply.code(400).send({
        error: "not_settable",
        detail: "An application becomes accepted when the desk is created, not by hand.",
      });
    }

    // declining hands the place back to the site's "N of 100 claimed"
    if (parsed.data.status !== undefined && parsed.data.status !== row.status) forgetClaimedCount();

    const set: Record<string, unknown> = {};
    if (parsed.data.status !== undefined) {
      set.status = parsed.data.status;
      set.decidedAt = new Date();
      set.decidedBy = who.staffId;
      if (parsed.data.status !== "new") set.handledAt = row.handledAt ?? new Date();
    }
    if (parsed.data.notes !== undefined) set.notes = parsed.data.notes;
    await db.update(schema.enquiries).set(set).where(eq(schema.enquiries.id, req.params.id));

    /* Inviting someone is the one stage change the applicant hears about, so
       it is the one that sends. Best-effort: the stage is already saved, and
       a mail outage must not silently roll it back — the operator can see it
       failed and send again. */
    let invited: EmailStatus | null = null;
    if (parsed.data.status === "invited" && row.status !== "invited") {
      const origin = (process.env.PUBLIC_ORIGIN ?? "https://www.currencydeskos.com").replace(/\/+$/, "");
      const mail = inviteEmail({ name: row.name, reference: row.reference, origin });
      invited = await sendEmail(row.email, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
    }

    if (parsed.data.status !== undefined) {
      await audit(db, {
        tenantId: row.tenantId ?? PLATFORM_TENANT,
        legalEntityId: "-",
        branchId: "-",
        actorId: who.id,
        action: "admin.enquiry_status",
        detail: { reference: row.reference, from: row.status, to: parsed.data.status, ...(invited ? { invite: invited } : {}) },
      });
    }
    return { ok: true, ...(invited ? { invite: invited } : {}) };
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

  // create a desk by hand (e.g. onboarding a shop over the phone). The owner
  // gets a temporary password they must change on first sign-in.
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
