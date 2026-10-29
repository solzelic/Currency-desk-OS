/* Sandbox seeding and the owner's own balance. No purchase and no payment.
   A grant is a platform administrator, and only when IDV_CREDIT_SANDBOX=1.
   The shop owner still reads the balance. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { attachPoolErrorHandler } from "../db/pool-error.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import type { Db } from "../db/index.js";
import { member } from "../platform/team.js";
import { grant, IdvCreditRefused, readCredits } from "./credit-ledger.js";
type Caller = { kind: "none" } | { kind: "forbidden" } | { kind: "ok"; user: SessionUser };
export function registerIdvCreditRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  attachPoolErrorHandler(pool);
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
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    if (!(await member(db, user.staffId))) return reply.code(403).send({ code: "AUTHORIZATION_DENIED" });
    if (process.env.IDV_CREDIT_SANDBOX !== "1") return reply.code(403).send({ code: "SANDBOX_REQUIRED" });
    const body = (req.body ?? {}) as { amount?: number; shopId?: unknown };
    if (otherShop(body.shopId, user.legalEntityId)) return reply.code(403).send({ code: "SCOPE_DENIED" });
    try {
      return reply.code(201).send(await grant(pool, user.legalEntityId, body.amount as number, user.id));
    } catch (error) {
      if (error instanceof IdvCreditRefused) {
        const status = error.code === "AMOUNT_CAP" ? 400 : 422;
        return reply.code(status).send({ code: error.code });
      }
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
