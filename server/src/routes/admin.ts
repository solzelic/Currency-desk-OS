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
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { hashPassword } from "../auth/password.js";
import { audit } from "../audit.js";
import { tenantPlan } from "./tenant.js";

const PLAN = z.enum(["trial", "basic", "pro", "premium"]);
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
const isPlatformAdmin = (email: string | undefined): boolean =>
  !!email && platformAdmins().has(email.toLowerCase());

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
      .select({ id: schema.staffUsers.id, staffId: schema.staffUsers.staffId, name: schema.staffUsers.name, role: schema.staffUsers.role, active: schema.staffUsers.active, createdAt: schema.staffUsers.createdAt })
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.tenantId, id));
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, id)).orderBy(desc(schema.auditEvents.at)).limit(50);
    const plan = await tenantPlan(db, id);
    return {
      tenant: { id: t.id, name: t.name, slug: t.siteSlug, plan: t.plan, entitledPlan: plan, suspended: t.suspended, siteDomain: t.siteDomain, setup: t.setup ?? null, createdAt: t.createdAt },
      legalEntities: entities,
      staff,
      audit,
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
    return { totals: { desks: tenants.length, people: staff.length, recent7 }, byStatus, byPlan, recentActivity };
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
