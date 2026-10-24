/* Sandbox seeding and the owner's own balance. No purchase and no payment. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import type { Db } from "../db/index.js";
import { grant, IdvCreditRefused, readCredits } from "./credit-ledger.js";
type Caller = { kind: "none" } | { kind: "forbidden" } | { kind: "ok"; user: SessionUser };
export function registerIdvCreditRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  app.addHook("onClose", async () => { await pool.end(); });
  async function owner(req: FastifyRequest): Promise<Caller> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return { kind: "none" };
    if (user.role !== "administrator") return { kind: "forbidden" };
    return { kind: "ok", user };
  }
  const refused = (who: Exclude<Caller, { kind: "ok" }>) =>
    who.kind === "none"
      ? { status: 401, code: "AUTHENTICATION_REQUIRED" }
      : { status: 403, code: "AUTHORIZATION_DENIED" };
  const otherShop = (shopId: unknown, legalEntityId: string) => shopId != null && shopId !== legalEntityId;
  app.post("/api/idv/credits", async (req, reply) => {
    const who = await owner(req);
    if (who.kind !== "ok") {
      const answer = refused(who);
      return reply.code(answer.status).send({ code: answer.code });
    }
    const body = (req.body ?? {}) as { amount?: number; shopId?: unknown };
    if (otherShop(body.shopId, who.user.legalEntityId)) return reply.code(403).send({ code: "SCOPE_DENIED" });
    try {
      return reply.code(201).send(await grant(pool, who.user.legalEntityId, body.amount as number, who.user.id));
    } catch (error) {
      if (error instanceof IdvCreditRefused) return reply.code(422).send({ code: error.code });
      throw error;
    }
  });
  app.get("/api/idv/credits", async (req, reply) => {
    const who = await owner(req);
    if (who.kind !== "ok") {
      const answer = refused(who);
      return reply.code(answer.status).send({ code: answer.code });
    }
    const shopId = (req.query as { shopId?: unknown }).shopId;
    if (otherShop(shopId, who.user.legalEntityId)) return reply.code(403).send({ code: "SCOPE_DENIED" });
    return readCredits(pool, who.user.legalEntityId);
  });
}
