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

const patchBody = z.object({ plan: z.enum(["basic", "pro", "premium"]) });

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
    return { tenant: { id: t.id, name: t.name, plan: t.plan } };
  });

  app.patch("/api/tenant", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (who.role !== "administrator") return reply.code(403).send({ error: "forbidden" });
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const before = await tenantPlan(db, who.tenantId);
    if (before !== parsed.data.plan) {
      await db.update(schema.tenants).set({ plan: parsed.data.plan }).where(eq(schema.tenants.id, who.tenantId));
      await audit(db, {
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        actorId: who.id,
        action: "tenant.plan_changed",
        detail: { from: before, to: parsed.data.plan },
      });
    }
    return { tenant: { id: who.tenantId, plan: parsed.data.plan } };
  });
}
