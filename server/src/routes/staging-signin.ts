/* One-click staging sign-in. Registered only when stagingDoorOpen()
   is true (STAGING exactly "1"; see app.ts). Every request calls
   stagingDoorOpen with the headers and checks the demo shop, so a
   live host or any shop other than tnt-yorkfx is still 404.

   The session is a normal cdos_session for one seeded demo staff
   member. It lasts three days. A desk sign-in stays twelve hours. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.js";
import { clientIp } from "../auth/client-ip.js";
import { stagingAddressLimited } from "../auth/signin-guard.js";
import { requestHost, stagingDoorOpen, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { isDemoDeskTenant } from "../demo-desk.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { DEMO } from "../seed.js";

export const STAGING_COOKIE = "cdos_staging";
export const STAGING_SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/* One person per role on the demo shop. The four that seed.ts
   already had keep their ids. Compliance and auditor are added there. */
const ROLE_STAFF = {
  administrator: "j.masri",
  branch_manager: "r.haddad",
  supervisor: "a.singh",
  compliance_officer: "c.adebayo",
  teller: "m.costa",
  auditor: "l.berg",
} as const;

const enterBody = z.object({
  role: z.enum(["administrator", "branch_manager", "supervisor", "compliance_officer", "teller", "auditor"]),
}).strict();

function cookieOpts(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };
}

export function clearStagingCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(STAGING_COOKIE, cookieOpts(secure));
}

async function doorOpen(db: Db, headers: StagingDoorHeaders): Promise<boolean> {
  if (!stagingDoorOpen(headers)) return false;
  const row = await db
    .select({ id: schema.tenants.id, siteSlug: schema.tenants.siteSlug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEMO.tenantId))
    .limit(1)
    .then((rows) => rows[0]);
  return !!row && isDemoDeskTenant(row);
}

export function registerStagingSignInRoutes(app: FastifyInstance, db: Db): void {
  const secure = process.env.NODE_ENV === "production";

  app.get("/api/staging/signin", async (req, reply) => {
    /* 404, not 403, and enabled is false. The login page treats
       anything other than 200 { enabled: true } as no buttons. */
    if (!(await doorOpen(db, req.headers))) {
      return reply.code(404).send({ enabled: false });
    }
    return { enabled: true };
  });

  app.post("/api/staging/enter", async (req, reply) => {
    if (!(await doorOpen(db, req.headers))) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (await stagingAddressLimited(db, clientIp(req))) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }
    const type = req.headers["content-type"];
    const media = (Array.isArray(type) ? type[0] : type)?.split(";")[0]?.trim().toLowerCase();
    if (media !== "application/json") return reply.code(415).send({ error: "unsupported_media_type" });
    const parsed = enterBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const role = parsed.data.role;
    /* The shop id is not read from the body. The row has to be this
       role, on the demo tenant, and active. */
    const user = await db
      .select()
      .from(schema.staffUsers)
      .where(and(
        eq(schema.staffUsers.tenantId, DEMO.tenantId),
        eq(schema.staffUsers.legalEntityId, DEMO.legalEntityId),
        eq(schema.staffUsers.staffId, ROLE_STAFF[role]),
        eq(schema.staffUsers.role, role),
        eq(schema.staffUsers.active, true),
      ))
      .limit(1)
      .then((rows) => rows[0]);
    if (!user) return reply.code(404).send({ error: "not_found" });

    const { token, expiresAt } = await createSession(db, user.id, { ttlMs: STAGING_SESSION_TTL_MS });
    const host = requestHost(req.headers.host);
    await audit(db, {
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      branchId: user.branchId,
      actorId: user.id,
      action: "auth.staging_enter",
      detail: { role: user.role, host, at: new Date().toISOString(), ip: clientIp(req), userAgent: (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "").slice(0, 500) },
    });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts(secure), expires: expiresAt });
    reply.setCookie(STAGING_COOKIE, "1", { ...cookieOpts(secure), expires: expiresAt });
    return {
      staging: true,
      user: {
        id: user.staffId,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        authorizedBranchIds: user.authorizedBranchIds,
        mustChangePassword: user.mustChangePassword,
      },
    };
  });
}
