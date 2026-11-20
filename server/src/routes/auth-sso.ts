/* Google sign-in and linking. Microsoft is the same callback once its
   flag and routes are turned on. Flags off: 503, and no session. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { readSignInFlags } from "../auth/signin-flags.js";
import { clientIp } from "../auth/client-ip.js";
import { chargeSignInBucket, lockBody, SIGNIN_IP_MAX } from "../auth/signin-guard.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { sessionCookieOptions } from "../auth/complete-sign-in.js";
import { stepUpFresh } from "../auth/owner-mfa.js";
import { listSignInMethods } from "../auth/methods.js";
import {
  beginSso,
  confirmOwner,
  finishLinkCallback,
  finishSignInCallback,
  pickShop,
  shopsForPending,
  ssoConfig,
  unlinkIdentity,
  type CallbackResult,
} from "../auth/sso-flow.js";
import type { Provider } from "../auth/oidc.js";

const PENDING = "cdos_sso_pending";

function flagOn(provider: Provider): boolean {
  const flags = readSignInFlags();
  return provider === "google" ? flags.google : flags.microsoft;
}

function sendResult(reply: FastifyReply, result: CallbackResult, cookies: ReturnType<typeof sessionCookieOptions>) {
  if (!result.ok) return reply.redirect("/login?sso=refused", 303);
  if (result.kind === "session") {
    reply.setCookie(SESSION_COOKIE, result.token, { ...cookies, expires: result.expiresAt });
    reply.clearCookie(PENDING, cookies);
    return reply.redirect(result.returnTo, 303);
  }
  if (result.kind === "linked") return reply.redirect("/app?sso=linked", 303);
  reply.setCookie(PENDING, result.pending, { ...cookies, maxAge: 5 * 60 });
  const page = result.kind === "shops" ? "shops" : "confirm";
  return reply.redirect(`/login?sso=${page}`, 303);
}

export function registerSsoRoutes(app: FastifyInstance, db: Db, providers: readonly Provider[] = ["google"]): void {
  const cookies = sessionCookieOptions();

  app.get("/api/auth/methods", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1))[0];
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { methods: await listSignInMethods(db, user.id, user.passwordHash) };
  });

  for (const provider of providers) {
    app.get(`/api/auth/sso/${provider}/start`, async (req, reply) => {
      if (!flagOn(provider)) return reply.code(503).send({ error: "not_available" });
      const cfg = ssoConfig(provider, "signin");
      if (!cfg) return reply.code(503).send({ error: "not_available" });
      const query = req.query as { returnTo?: unknown };
      const url = await beginSso(db, cfg, "signin", { returnTo: query.returnTo });
      return reply.redirect(url, 302);
    });

    app.get(`/api/auth/sso/link/${provider}/start`, async (req, reply) => {
      if (!flagOn(provider)) return reply.code(503).send({ error: "not_available" });
      const token = req.cookies[SESSION_COOKIE];
      const who = await resolveSession(db, token);
      if (!who || !token) return reply.code(401).send({ error: "unauthenticated" });
      if (who.tenantId === "tnt-yorkfx") return reply.code(403).send({ error: "not_available" });
      if (!(await stepUpFresh(db, token))) return reply.code(403).send({ error: "step_up_required" });
      const cfg = ssoConfig(provider, "link");
      if (!cfg) return reply.code(503).send({ error: "not_available" });
      const url = await beginSso(db, cfg, "link", { staffUserId: who.id, sessionToken: token, returnTo: "/app" });
      return reply.redirect(url, 302);
    });

    app.post(`/api/auth/sso/${provider}/unlink`, async (req, reply) => {
      if (!flagOn(provider)) return reply.code(503).send({ error: "not_available" });
      const token = req.cookies[SESSION_COOKIE];
      const who = await resolveSession(db, token);
      if (!who || !token) return reply.code(401).send({ error: "unauthenticated" });
      if (!(await stepUpFresh(db, token))) return reply.code(403).send({ error: "step_up_required" });
      const outcome = await unlinkIdentity(db, who.id, provider);
      if (outcome === "last_method") return reply.code(409).send({ error: "last_method", detail: "Add another way to sign in before removing this one." });
      if (outcome === "missing") return reply.code(404).send({ error: "not_found" });
      reply.clearCookie(SESSION_COOKIE, cookies);
      return { ok: true };
    });
  }

  const callback = (purpose: "signin" | "link") => async (req: FastifyRequest, reply: FastifyReply) => {
    const query = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(512) }).safeParse(req.query);
    if (!query.success) return reply.redirect("/login?sso=refused", 303);
    if (!providers.some((provider) => flagOn(provider))) return reply.code(503).send({ error: "not_available" });
    const ip = clientIp(req);
    const limited = await chargeSignInBucket(db, `sso-ip:${ip}`, SIGNIN_IP_MAX);
    if (limited.result === "locked") return reply.code(429).send(lockBody(limited, "UTC"));
    for (const provider of providers) {
      if (!flagOn(provider)) continue;
      const cfg = ssoConfig(provider, purpose);
      if (!cfg) continue;
      const result = purpose === "link"
        ? await finishLinkCallback(db, cfg, query.data.code, query.data.state, req.cookies[SESSION_COOKIE])
        : await finishSignInCallback(db, cfg, query.data.code, query.data.state, ip);
      if (!result.ok && result.reason === "no_state") continue;
      return sendResult(reply, result, cookies);
    }
    return reply.redirect("/login?sso=refused", 303);
  };

  app.get("/auth/sso/callback", callback("signin"));
  app.get("/auth/sso/link/callback", callback("link"));

  app.get("/api/auth/sso/shops", async (req, reply) => {
    const token = req.cookies[PENDING];
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const shops = await shopsForPending(db, token);
    if (!shops) return reply.code(401).send({ error: "unauthenticated" });
    return { shops };
  });

  app.post("/api/auth/sso/pick", async (req, reply) => {
    const token = req.cookies[PENDING];
    const parsed = z.object({ staffUserId: z.string().min(1).max(200) }).safeParse(req.body);
    if (!token || !parsed.success) return reply.code(401).send({ error: "invalid_credentials" });
    const result = await pickShop(db, token, parsed.data.staffUserId, clientIp(req));
    if (!result.ok) return reply.code(401).send({ error: "invalid_credentials" });
    if (result.kind === "confirm") {
      reply.setCookie(PENDING, result.pending, { ...cookies, maxAge: 5 * 60 });
      return { ok: true, step: "confirm" };
    }
    if (result.kind !== "session") return reply.code(401).send({ error: "invalid_credentials" });
    reply.setCookie(SESSION_COOKIE, result.token, { ...cookies, expires: result.expiresAt });
    reply.clearCookie(PENDING, cookies);
    return { ok: true, returnTo: result.returnTo };
  });

  app.post("/api/auth/sso/confirm", async (req, reply) => {
    const token = req.cookies[PENDING];
    const parsed = z.object({ code: z.string().trim().min(6).max(32) }).safeParse(req.body);
    if (!token || !parsed.success) return reply.code(401).send({ error: "invalid_credentials" });
    const result = await confirmOwner(db, token, parsed.data.code, clientIp(req));
    if (!result.ok && result.reason === "locked") return reply.code(429).send(lockBody(result.locked, "UTC"));
    if (!result.ok || result.kind !== "session") return reply.code(401).send({ error: "invalid_credentials" });
    reply.setCookie(SESSION_COOKIE, result.token, { ...cookies, expires: result.expiresAt });
    reply.clearCookie(PENDING, cookies);
    return { ok: true, returnTo: result.returnTo };
  });
}
