import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import pg from "pg";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { tenantPlan } from "../routes/tenant.js";
import { LedgerError, LedgerService, type LedgerActor } from "./service.js";

const decimalString = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, "Expected decimal string with at most two places.");
const monetary = (minimum: Decimal.Value) => decimalString.refine((value) => new Decimal(value).gte(minimum) && new Decimal(value).lte("1000000000"), "Amount is outside the permitted range.");
const postBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  customerId: z.string().min(1).max(120),
  from: z.enum(["CAD", "USD", "EUR", "GBP"]),
  to: z.enum(["CAD", "USD", "EUR", "GBP"]),
  inputAmount: monetary("0.01"),
  feeCad: monetary("0"),
  purpose: z.string().trim().max(500),
  sourceOfFunds: z.string().trim().max(500),
}).refine((value) => value.from !== value.to, { message: "Currencies must differ.", path: ["to"] });
const reverseBody = z.object({ idempotencyKey: z.string().min(1).max(200), reason: z.string().trim().min(1).max(1000) });
type Resolution = { kind: "authenticated"; actor: LedgerActor } | { kind: "unauthenticated" } | { kind: "scope_denied" } | { kind: "plan_denied" };

export function registerLedgerRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const service = new LedgerService(pool);
  app.addHook("onClose", async () => { await pool.end(); });

  async function resolveActor(req: FastifyRequest): Promise<Resolution> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return { kind: "unauthenticated" };
    // tier gate: the ledger is a Pro/Premium app — a basic tenant only has
    // the rate board, so its sessions can't post to the book
    if ((await tenantPlan(db, user.tenantId)) === "basic") return { kind: "plan_denied" };
    const header = req.headers["x-workspace-id"];
    if (Array.isArray(header)) return { kind: "scope_denied" };
    const candidates = await db.select().from(schema.workspaces).where(and(
      eq(schema.workspaces.tenantId, user.tenantId),
      eq(schema.workspaces.legalEntityId, user.legalEntityId),
      eq(schema.workspaces.branchId, user.branchId),
    ));
    const workspace = header ? candidates.find((item) => item.id === header) : candidates.length === 1 ? candidates[0] : undefined;
    if (!workspace || !user.authorizedBranchIds.includes(workspace.branchId)) return { kind: "scope_denied" };
    return { kind: "authenticated", actor: { userId: user.id, tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: workspace.branchId, workspaceId: workspace.id, tillId: workspace.tillId, role: user.role, authorizedBranchIds: user.authorizedBranchIds } };
  }

  function failure(reply: { code(status: number): { send(value: unknown): unknown } }, error: unknown) {
    if (!(error instanceof LedgerError)) {
      app.log.error(error, "ledger route failure");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
    }
    const status = error.code === "AUTHENTICATION_REQUIRED" ? 401 : error.code === "AUTHORIZATION_DENIED" || error.code === "SCOPE_DENIED" ? 403 : error.code === "IDEMPOTENCY_IN_PROGRESS" ? 409 : 422;
    return reply.code(status).send({ code: error.code, message: error.message });
  }

  app.post("/api/ledger/exchanges", async (req, reply) => {
    if (process.env.NODE_ENV === "production" || process.env.STAGING === "true") return reply.code(410).send({ code: "QUOTE_REQUIRED" });
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    try {
      const current = await resolveActor(req);
      if (current.kind === "unauthenticated") return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      if (current.kind === "plan_denied") return reply.code(403).send({ code: "PLAN_NOT_ENTITLED", message: "The ledger is a Pro feature — upgrade the plan to post transactions." });
      if (current.kind === "scope_denied") return reply.code(403).send({ code: "SCOPE_DENIED" });
      return reply.code(201).send(await service.post(current.actor, parsed.data));
    } catch (error) { return failure(reply, error); }
  });

  app.post("/api/ledger/transactions/:transactionId/reversal", async (req, reply) => {
    const parsed = reverseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    try {
      const current = await resolveActor(req);
      if (current.kind === "unauthenticated") return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      if (current.kind === "plan_denied") return reply.code(403).send({ code: "PLAN_NOT_ENTITLED", message: "The ledger is a Pro feature — upgrade the plan to post transactions." });
      if (current.kind === "scope_denied") return reply.code(403).send({ code: "SCOPE_DENIED" });
      return reply.code(201).send(await service.reverse(current.actor, (req.params as { transactionId: string }).transactionId, parsed.data.idempotencyKey, parsed.data.reason));
    } catch (error) { return failure(reply, error); }
  });
}
