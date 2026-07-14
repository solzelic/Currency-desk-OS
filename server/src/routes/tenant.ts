/* ============================================================
   Tenant routes — the purchased tier lives on the TENANT, not the
   device. The OS reads it at sign-in and unlocks apps accordingly;
   API-side, plan gates (see requirePlan) refuse endpoints the tier
   doesn't include.
     GET   /api/tenant  → { tenant: { id, name, plan } }
     PATCH /api/tenant  { plan } — administrator only, audited.
   In production the plan changes when billing clears a payment;
   until that pipe exists the owner account is the switch.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { TENANT_PLANS, type TenantPlan } from "../db/schema.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { refreshSiteDomains, SITES } from "../sites.js";

const domainShape = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i, "domain: e.g. yorkfx.ca");

const hoursRow = z.object({ days: z.string().trim().min(1).max(60), hours: z.string().trim().min(1).max(60) });
const siteConfigShape = z.object({
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(120).optional(),
  address: z.string().trim().max(160).optional(),
  city: z.string().trim().max(80).optional(),
  region: z.string().trim().max(40).optional(),
  postal: z.string().trim().max(16).optional(),
  hours: z.array(hoursRow).max(10).optional(),
});

const patchBody = z
  .object({
    plan: z.enum(["basic", "pro", "premium"]).optional(),
    // the customer's own domain for their hosted site; null disconnects it
    siteDomain: domainShape.nullable().optional(),
    // storefront contact + hours, published from the OS
    siteConfig: siteConfigShape.optional(),
  })
  .refine((b) => b.plan !== undefined || b.siteDomain !== undefined || b.siteConfig !== undefined, { message: "empty patch" });

export async function tenantPlan(db: Db, tenantId: string): Promise<TenantPlan> {
  const rows = await db.select({ plan: schema.tenants.plan }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const p = rows[0]?.plan;
  return (TENANT_PLANS as string[]).includes(p ?? "") ? (p as TenantPlan) : "premium";
}

export function registerTenantRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tenant", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await db.select().from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1);
    const t = rows[0];
    if (!t) return reply.code(404).send({ error: "not_found" });
    return {
      tenant: {
        id: t.id,
        name: t.name,
        plan: t.plan,
        siteSlug: t.siteSlug && SITES[t.siteSlug] ? t.siteSlug : null,
        siteDomain: t.siteDomain,
      },
    };
  });

  app.patch("/api/tenant", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    // plan & domain are commercial decisions — administrator only; the
    // storefront's contact/hours can be kept current by a branch manager
    const isAdmin = who.role === "administrator";
    const isManager = isAdmin || who.role === "branch_manager";
    if ((parsed.data.plan !== undefined || parsed.data.siteDomain !== undefined) && !isAdmin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (parsed.data.siteConfig !== undefined && !isManager) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const scope = { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id };

    if (parsed.data.plan !== undefined) {
      const before = await tenantPlan(db, who.tenantId);
      if (before !== parsed.data.plan) {
        await db.update(schema.tenants).set({ plan: parsed.data.plan }).where(eq(schema.tenants.id, who.tenantId));
        await audit(db, { ...scope, action: "tenant.plan_changed", detail: { from: before, to: parsed.data.plan } });
      }
    }

    if (parsed.data.siteDomain !== undefined) {
      const domain = parsed.data.siteDomain === null ? null : parsed.data.siteDomain.toLowerCase().replace(/^www\./, "");
      await db.update(schema.tenants).set({ siteDomain: domain }).where(eq(schema.tenants.id, who.tenantId));
      await refreshSiteDomains(db);
      await audit(db, { ...scope, action: "tenant.site_domain_changed", detail: { domain } });
    }

    if (parsed.data.siteConfig !== undefined) {
      const config = { ...parsed.data.siteConfig, updatedAt: new Date().toISOString() };
      await db.update(schema.tenants).set({ siteConfig: config }).where(eq(schema.tenants.id, who.tenantId));
      await audit(db, { ...scope, action: "tenant.site_config_changed", detail: { fields: Object.keys(parsed.data.siteConfig) } });
    }

    const rows = await db.select().from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1);
    const t = rows[0]!;
    return { tenant: { id: t.id, plan: t.plan, siteSlug: t.siteSlug, siteDomain: t.siteDomain, siteConfig: t.siteConfig } };
  });
}
