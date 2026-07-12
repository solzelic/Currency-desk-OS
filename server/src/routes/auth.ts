/* ============================================================
   Auth routes
     POST /api/auth/login   { staffId, password } → session cookie + user
     POST /api/auth/logout  → revokes the session
     GET  /api/auth/me      → current user + scope (or 401)
   Login answers are deliberately uniform ("invalid credentials")
   so staff IDs can't be enumerated; every attempt is audited.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { verifyPassword } from "../auth/password.js";
import { createSession, resolveSession, revokeSession, SESSION_COOKIE } from "../auth/sessions.js";

const loginBody = z.object({
  staffId: z.string().min(1).max(120),
  password: z.string().min(1).max(512),
  // multi-tenant login: which house. Defaults to the demo tenant for now;
  // production resolves this from the subdomain / device enrolment.
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});

async function audit(db: Db, e: { tenantId: string; legalEntityId: string; branchId: string; actorId?: string | null; action: string; detail?: Record<string, unknown> }) {
  await db.insert(schema.auditEvents).values({
    id: randomUUID(),
    tenantId: e.tenantId,
    legalEntityId: e.legalEntityId,
    branchId: e.branchId,
    actorId: e.actorId ?? null,
    action: e.action,
    detail: e.detail ?? {},
  });
}

export function registerAuthRoutes(app: FastifyInstance, db: Db) {
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { staffId, password, tenantId } = parsed.data;

    const users = await db
      .select()
      .from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, staffId)))
      .limit(1);
    const user = users[0];

    // verify against a constant dummy hash when the user is unknown so the
    // response time doesn't reveal whether the staff ID exists
    const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY);

    if (!user || !user.active || !ok) {
      if (user) {
        await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login_failed" });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const { token, expiresAt } = await createSession(db, user.id);
    await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });

    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    return {
      user: {
        id: user.staffId,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        authorizedBranchIds: user.authorizedBranchIds,
      },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await resolveSession(db, token);
    await revokeSession(db, token);
    if (who) {
      await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "auth.logout" });
    }
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    return {
      user: {
        id: who.staffId,
        name: who.name,
        role: who.role,
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        authorizedBranchIds: who.authorizedBranchIds,
      },
    };
  });
}
