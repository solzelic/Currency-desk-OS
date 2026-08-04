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
import { ensureLedgerPrincipal } from "./principal.js";
import {
  LedgerProvisioningService,
  type CustomerInput,
} from "./provisioning.js";
import { TillControlService } from "./till-control.js";
import { VaultControlService } from "./vault-control.js";

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
  thirdParty: z.boolean().default(false),
  thirdPartyName: z.string().trim().max(200).optional(),
})
  .refine((value) => value.from !== value.to, { message: "Currencies must differ.", path: ["to"] })
  .refine((value) => !value.thirdParty || !!value.thirdPartyName, { message: "Third-party name is required.", path: ["thirdPartyName"] })
  .refine((value) => value.thirdParty || !value.thirdPartyName, { message: "Third-party name requires third-party status.", path: ["thirdPartyName"] });
const reverseBody = z.object({ idempotencyKey: z.string().min(1).max(200), reason: z.string().trim().min(1).max(1000) });
const customerBody = z.object({
  externalRef: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  risk: z.enum(["normal", "enhanced", "high"]),
  idStatus: z.enum(["verified", "pending", "missing", "expired"]),
}).strict();
const balancesBody = z.object({
  balances: z.object({
    CAD: monetary("0").optional(),
    USD: monetary("0").optional(),
    EUR: monetary("0").optional(),
    GBP: monetary("0").optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "At least one balance is required."),
}).strict();
const transactionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const tillCounts = z.object({
  CAD: monetary("0").optional(),
  USD: monetary("0").optional(),
  EUR: monetary("0").optional(),
  GBP: monetary("0").optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one count is required.");
const countBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  counts: tillCounts,
}).strict();
const closeTillBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  counts: tillCounts,
  note: z.string().trim().max(1000).default(""),
}).strict();
const cashMovementBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  direction: z.enum(["in", "out"]),
  currency: z.enum(["CAD", "USD", "EUR", "GBP"]),
  amount: monetary("0.01"),
  counterpartyType: z.enum(["vault", "bank", "other"]),
  counterpartyRef: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
}).strict();
const vaultBalancesBody = z.object({
  balances: z.object({
    CAD: monetary("0").optional(),
    USD: monetary("0").optional(),
    EUR: monetary("0").optional(),
    GBP: monetary("0").optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "At least one balance is required."),
}).strict();
const vaultReceiptBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  direction: z.enum(["in", "out"]),
  currency: z.enum(["CAD", "USD", "EUR", "GBP"]),
  amount: monetary("0.01"),
  counterpartyType: z.enum(["supplier", "bank", "other"]),
  counterpartyRef: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
}).strict();
const vaultRunBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  toBranchId: z.string().trim().min(1).max(120),
  currency: z.enum(["CAD", "USD", "EUR", "GBP"]),
  amount: monetary("0.01"),
  reason: z.string().trim().min(1).max(1000),
}).strict();
const movementQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
type Resolution = { kind: "authenticated"; actor: LedgerActor } | { kind: "unauthenticated" } | { kind: "scope_denied" } | { kind: "plan_denied" };

export function registerLedgerRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const service = new LedgerService(pool);
  const provisioning = new LedgerProvisioningService(pool);
  const tillControl = new TillControlService(pool);
  const vaultControl = new VaultControlService(pool);
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
    const actor = { userId: user.id, tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: workspace.branchId, workspaceId: workspace.id, tillId: workspace.tillId, role: user.role, authorizedBranchIds: user.authorizedBranchIds };
    await ensureLedgerPrincipal(pool, actor);
    return { kind: "authenticated", actor };
  }

  function failure(reply: { code(status: number): { send(value: unknown): unknown } }, error: unknown) {
    if (!(error instanceof LedgerError)) {
      app.log.error(error, "ledger route failure");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
    }
    const status =
      error.code === "AUTHENTICATION_REQUIRED" ? 401
        : error.code === "AUTHORIZATION_DENIED" || error.code === "SCOPE_DENIED" ? 403
          : error.code === "CUSTOMER_NOT_FOUND" ||
              error.code === "TRANSACTION_NOT_FOUND" ||
              error.code === "TILL_SESSION_NOT_FOUND" ? 404
              : error.code === "IDEMPOTENCY_IN_PROGRESS" ||
                error.code === "IDEMPOTENCY_CONFLICT" ||
                error.code === "TILL_ALREADY_ACTIVE" ||
                error.code === "TILL_ALREADY_CLOSED" ||
                error.code === "TILL_NOT_OPEN" ||
                error.code === "CUSTOMER_EXTERNAL_REF_CONFLICT" ||
                error.code === "VAULT_ALREADY_INITIALIZED" ||
                error.code === "OPENING_BALANCES_ALREADY_SET" ? 409
              : 422;
    return reply.code(status).send({ code: error.code, message: error.message });
  }

  async function actorOrReply(
    req: FastifyRequest,
    reply: { code(status: number): { send(value: unknown): unknown } },
  ): Promise<LedgerActor | null> {
    const current = await resolveActor(req);
    if (current.kind === "unauthenticated") {
      reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return null;
    }
    if (current.kind === "plan_denied") {
      reply.code(403).send({
        code: "PLAN_NOT_ENTITLED",
        message: "The ledger is a Pro feature — upgrade the plan to use it.",
      });
      return null;
    }
    if (current.kind === "scope_denied") {
      reply.code(403).send({ code: "SCOPE_DENIED" });
      return null;
    }
    return current.actor;
  }

  app.get("/api/ledger/readiness", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await provisioning.readiness(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/customers", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send({ customers: await provisioning.listCustomers(actor) })
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/customers", async (req, reply) => {
    const parsed = customerBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply
            .code(201)
            .send(
              await provisioning.saveCustomer(
                actor,
                parsed.data as CustomerInput,
              ),
            )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.put("/api/ledger/customers/:customerId", async (req, reply) => {
    const parsed = customerBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await provisioning.saveCustomer(
              actor,
              parsed.data as CustomerInput,
              (req.params as { customerId: string }).customerId,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/till-balances", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(await provisioning.getBalances(actor))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/till-session", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await tillControl.current(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/till-sessions/open", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await tillControl.open(actor))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/till-counts", async (req, reply) => {
    const parsed = countBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(
            await tillControl.recordCount(
              actor,
              parsed.data.idempotencyKey,
              parsed.data.counts,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/till-sessions/:sessionId/close", async (req, reply) => {
    const parsed = closeTillBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await tillControl.close(
              actor,
              (req.params as { sessionId: string }).sessionId,
              parsed.data.idempotencyKey,
              parsed.data.counts,
              parsed.data.note,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/till-movements", async (req, reply) => {
    const parsed = cashMovementBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await tillControl.moveCash(actor, parsed.data))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/vault", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await vaultControl.current(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/vault/opening-position", async (req, reply) => {
    const parsed = vaultBalancesBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await vaultControl.initialize(actor, parsed.data.balances))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/vault/receipts", async (req, reply) => {
    const parsed = vaultReceiptBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await vaultControl.receive(actor, parsed.data))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/vault/runs", async (req, reply) => {
    const parsed = vaultRunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await vaultControl.run(actor, parsed.data))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/vault/movements", async (req, reply) => {
    const parsed = movementQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(await vaultControl.movements(actor, parsed.data.limit))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/ledger/opening-balances", async (req, reply) => {
    const parsed = balancesBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply
            .code(201)
            .send(
              await provisioning.initializeBalances(
                actor,
                parsed.data.balances,
              ),
            )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/transactions", async (req, reply) => {
    const parsed = transactionQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await provisioning.listTransactions(actor, parsed.data.limit),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/transactions/:transactionId/receipt", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await provisioning.transactionReceipt(
              actor,
              (req.params as { transactionId: string }).transactionId,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

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
