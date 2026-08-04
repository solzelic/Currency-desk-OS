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
import { CostMethodService } from "./cost-method-control.js";
import { ReportFilingService, type FilingInput } from "./report-filings.js";
import { LedgerReportingService } from "./reporting.js";

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
/* A unit cost is a ratio, not a money amount, so it is not `monetary`: two
   decimal places on a per-unit figure drift the basis measurably over a day
   of trading, and the column carries twelve. */
const unitCost = z.string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/, "Expected a unit cost with at most twelve places.")
  .refine((value) => new Decimal(value).gt(0) && new Decimal(value).lte("1000000"), "Unit cost is outside the permitted range.");
const vaultBalancesBody = z.object({
  balances: z.object({
    CAD: monetary("0").optional(),
    USD: monetary("0").optional(),
    EUR: monetary("0").optional(),
    GBP: monetary("0").optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "At least one balance is required."),
  /* What a unit of the opening position cost, where the desk can say. Its
     own field rather than a change to `balances` so that every caller
     sending the original shape keeps working — a desk that cannot
     reconstruct what its safe cost must still be able to state what is in
     it, and gets an unset basis rather than an invented one. */
  unitCosts: z.object({
    CAD: unitCost.optional(),
    USD: unitCost.optional(),
    EUR: unitCost.optional(),
    GBP: unitCost.optional(),
  }).strict().optional(),
}).strict().refine(
  (value) =>
    Object.keys(value.unitCosts ?? {}).every((currency) => currency in value.balances),
  { message: "A unit cost needs an opening amount to belong to.", path: ["unitCosts"] },
);
const vaultReceiptBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  direction: z.enum(["in", "out"]),
  currency: z.enum(["CAD", "USD", "EUR", "GBP"]),
  amount: monetary("0.01"),
  counterpartyType: z.enum(["supplier", "bank", "other"]),
  counterpartyRef: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  /* The home-currency price of the whole movement — the supplier's invoice
     coming in, the sum the bank credited going out. Optional because the
     cash can reach the safe before the paperwork does. */
  costHome: monetary("0.01").optional(),
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
/* `pack_default` rather than a null: a client that means "hand this back to
   the jurisdiction pack" should have to say so, because a null arriving in a
   JSON body is just as often a field somebody forgot to fill in. */
const costMethodBody = z.object({
  method: z.enum(["weighted_average", "fifo", "pack_default"]),
}).strict();
/* A sealed regulatory filing arriving from the worksheet.

   `payload` is left as an opaque object on purpose: it is the regulator's
   form, and every jurisdiction's form is a different shape. Validating its
   contents here would mean this file knowing what an LCTR looks like,
   which is the hardcoding the jurisdiction packs exist to undo — the form
   is data, and it is transcribed in `jurisdiction_reports`.

   The acknowledgement is required because a filing without one is a desk
   claiming it filed with nothing to show for it. */
const iso8601 = z.string().datetime({ offset: true });
const filingBody = z.object({
  reportCode: z.string().trim().min(1).max(40),
  obligationId: z.string().trim().min(1).max(400),
  obligationGroupId: z.string().trim().min(1).max(400),
  reportRef: z.string().trim().min(1).max(200),
  subjectName: z.string().trim().min(1).max(300),
  reportedAmount: decimalString.nullable().default(null),
  reportedCurrency: z.string().trim().length(3).nullable().default(null),
  transactionRefs: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
  aggregationBasis: z.string().trim().max(40).nullable().default(null),
  windowStart: iso8601.nullable().default(null),
  windowEnd: iso8601.nullable().default(null),
  acknowledgementRef: z.string().trim().min(1).max(200),
  payload: z.unknown(),
  amendsFilingId: z.string().trim().min(1).max(120).nullable().default(null),
}).strict();
const filingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
/* The window a summary covers, as two instants.

   The caller states them because a business day belongs to a branch's
   clock, not to this server's — see the note on LedgerReportingService
   .summary. Both are optional and omitting both means "everything this
   till has ever posted", which is the only window that needs no timezone
   to be right. */
const summaryQuery = z.object({
  from: iso8601.optional(),
  to: iso8601.optional(),
}).refine(
  (value) => !value.from || !value.to || value.from < value.to,
  { message: "The window has to start before it ends.", path: ["to"] },
);
type Resolution = { kind: "authenticated"; actor: LedgerActor } | { kind: "unauthenticated" } | { kind: "scope_denied" } | { kind: "plan_denied" };

export function registerLedgerRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const service = new LedgerService(pool);
  const provisioning = new LedgerProvisioningService(pool);
  const tillControl = new TillControlService(pool);
  const vaultControl = new VaultControlService(pool);
  const costMethod = new CostMethodService(pool);
  const reportFilings = new ReportFilingService(pool);
  const reporting = new LedgerReportingService(pool);
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
              error.code === "LEGAL_ENTITY_NOT_FOUND" ||
              error.code === "FILING_NOT_FOUND" ||
              error.code === "TILL_SESSION_NOT_FOUND" ? 404
              : error.code === "IDEMPOTENCY_IN_PROGRESS" ||
                error.code === "IDEMPOTENCY_CONFLICT" ||
                error.code === "TILL_ALREADY_ACTIVE" ||
                error.code === "TILL_ALREADY_CLOSED" ||
                error.code === "TILL_NOT_OPEN" ||
                error.code === "CUSTOMER_EXTERNAL_REF_CONFLICT" ||
                error.code === "VAULT_ALREADY_INITIALIZED" ||
                error.code === "OBLIGATION_ALREADY_FILED" ||
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

  /* The desk's own topology: which tills this session's branch actually has on
     the ledger. Deliberately NOT resolved through resolveActor — that picks one
     workspace and refuses (SCOPE_DENIED) when a branch has more than one and the
     caller named none, which is exactly the state every client is in before it
     has seen this list. The browser never sent x-workspace-id at all, so the
     single-workspace fallback was carrying the whole desk; the day a branch got
     a second till every ledger and quote call would have started failing with
     nothing to tell the client which id to send. Scope still comes only from the
     session record — the request cannot name a tenant, entity or branch.

     Which also means a till this session is not posted at is never in the
     answer, so a till switcher built on this list cannot offer somebody a
     drawer they are not authorized to sit at. */
  type SessionUser = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;
  /* Sorted by till id so a client that has to pick one picks the same one on
     every reload rather than following whatever order the database returned. */
  async function branchTills(user: SessionUser) {
    const rows = await db
      .select({ workspace: schema.workspaces, branch: schema.branches })
      .from(schema.workspaces)
      .innerJoin(schema.branches, eq(schema.workspaces.branchId, schema.branches.id))
      .where(and(
        eq(schema.workspaces.tenantId, user.tenantId),
        eq(schema.workspaces.legalEntityId, user.legalEntityId),
        eq(schema.workspaces.branchId, user.branchId),
      ));
    return rows
      .map((row) => ({
        workspaceId: row.workspace.id,
        tillId: row.workspace.tillId,
        branchId: row.branch.id,
        branchName: row.branch.name,
      }))
      .sort((a, b) => a.tillId.localeCompare(b.tillId));
  }

  /* The gate both of them sit behind. Same three refusals, in the same order,
     because the roster is the same disclosure as the list. */
  async function tillListUser(
    req: FastifyRequest,
    reply: { code(status: number): { send(value: unknown): unknown } },
  ): Promise<SessionUser | null> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) {
      reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return null;
    }
    if ((await tenantPlan(db, user.tenantId)) === "basic") {
      reply.code(403).send({
        code: "PLAN_NOT_ENTITLED",
        message: "The ledger is a Pro feature — upgrade the plan to use it.",
      });
      return null;
    }
    if (!user.authorizedBranchIds.includes(user.branchId)) {
      reply.code(403).send({ code: "SCOPE_DENIED" });
      return null;
    }
    return user;
  }

  app.get("/api/ledger/workspaces", async (req, reply) => {
    try {
      const user = await tillListUser(req, reply);
      return user ? reply.send({ workspaces: await branchTills(user) }) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* The same tills, plus who is on each one according to the book.

     Separate from the list above only because that response shape is what
     other callers already read; this is the one the till switcher uses, and
     the switcher is the reason occupancy has to come from the server at all.
     It used to come from a roster baked into the browser, which announced
     "Till 2 — Express · M. Costa on now" for a till that had never held a
     session and a person the ledger has never heard of. A teller reads that
     line to decide which drawer to sit at.

     `session` is the LATEST session for the till, with its status, or null
     when the till has never been opened. Null means "the book cannot say" —
     the client renders nothing there, never "free". */
  app.get("/api/ledger/till-roster", async (req, reply) => {
    try {
      const user = await tillListUser(req, reply);
      if (!user) return undefined;
      const tills = await branchTills(user);
      const occupancy = await tillControl.branchOccupancy({
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
      });
      return reply.send({
        workspaces: tills.map((till) => ({
          ...till,
          session: occupancy.get(till.workspaceId) ?? null,
        })),
      });
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* Moving the operator to another drawer, recorded.

     The client sends the target workspace in x-workspace-id like every other
     ledger call, so this goes through exactly the same resolution and the same
     refusal as the money routes do: a workspace outside this session's branch,
     or a branch the principal is not authorized for, is SCOPE_DENIED here
     before anything is written or shown.

     It exists so the browser has something to AWAIT before it renames the
     screen. The old switcher changed a label and kept sending the previous
     workspace header, so the header said Till 2 while every read and write
     went to Till 1 — a count saved in that state overwrote an innocent till's
     figures. Now the name on screen only changes after the server has agreed,
     stamped the audit row the confirmation modal promises, and handed back the
     new till's session and balances in the same response. */
  app.post("/api/ledger/till-selection", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await tillControl.selectTill(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

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

  /* How the desk costs its inventory. A setting, not a preference: it lives
     on the legal entity in the book, not in the browser's saved state, because
     it decides what every future sale reports as profit. */
  app.get("/api/ledger/cost-method", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await costMethod.current(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.put("/api/ledger/cost-method", async (req, reply) => {
    const parsed = costMethodBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await costMethod.set(
              actor,
              parsed.data.method === "pack_default" ? null : parsed.data.method,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* The desk's filed reports. Scoped to the legal entity, not the till:
     these used to live in one browser's localStorage, which meant two
     counters held two disjoint sets of the same entity's filings and a
     cleared browser held none. */
  app.get("/api/ledger/report-filings", async (req, reply) => {
    const parsed = filingQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(await reportFilings.list(actor, parsed.data.limit))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/report-filings/:filingId", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.send(
            await reportFilings.get(
              actor,
              (req.params as { filingId: string }).filingId,
            ),
          )
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* Sealing a report. There is no PUT and no DELETE beside this on purpose:
     a filed report is evidence, the database refuses to let one be edited,
     and a correction arrives here as a new filing naming what it corrects. */
  app.post("/api/ledger/report-filings", async (req, reply) => {
    const parsed = filingBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor
        ? reply.code(201).send(await reportFilings.file(actor, parsed.data as FilingInput))
        : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* ---- the reads every summary screen was inventing for itself ----

     The Dashboard, the Ledger header, the Vault position and the close-out
     each derived their headline figures in the browser from a demo seed,
     and each of them was wrong in a different direction. These three
     answer the same questions out of the ledger instead. Read-only, and
     behind the same `ledger:view` gate as every other book read.

     Everything they cannot answer comes back null — see
     docs/ABSENT_FIGURES.md and the note at the top of reporting.ts. */
  app.get("/api/ledger/summary", async (req, reply) => {
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await reporting.summary(actor, parsed.data)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/position", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await reporting.position(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/ledger/jurisdiction", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await reporting.jurisdiction(actor)) : undefined;
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
        ? reply.code(201).send(await vaultControl.initialize(actor, parsed.data.balances, parsed.data.unitCosts))
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

  /* The direct-post path, kept for development only — production and staging
     refuse it below, because a real deal must come from a frozen quote.

     It also books NO COST BASIS. It still credits `revenue:fx_spread` against
     a market mid, which is the model docs/COST_BASIS.md replaced, so anything
     posted here creates inventory the ledger has no purchase price for. That
     is survivable in a scratch database — `ensureBasis` gives such stock a
     labelled estimate the first time it is sold — and would not be survivable
     anywhere else. If this is ever opened up, it needs the cost treatment in
     `postFrozenQuote` first, not a wider gate. */
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
