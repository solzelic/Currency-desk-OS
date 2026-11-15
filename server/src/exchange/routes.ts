/* Exchange v2.9 HTTP.
   Reveal reasons are read from id_reveal_reasons. The route does not
   keep its own copy of that list. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { resolveWorkspaceForUser } from "../auth/workspace-scope.js";
import type { Db } from "../db/index.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import { ensureLedgerPrincipal } from "../ledger/principal.js";
import { tenantPlan } from "../routes/tenant.js";
import { loadCashWindow } from "./canada-post.js";
import {
  badgeFor,
  listRevealReasons,
  loadShopCheck,
  maskedNumber,
  recordInPerson,
  recordReturning,
  revealNumber,
  confirmedHigh,
} from "./id-check.js";
import { screeningStatus } from "./screening.js";
import { civilToday } from "../civil-date.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rules = require("../../../shared/exchange-v29.js") as {
  returningDecision: (input: {
    checkedOn: string | null;
    today: string;
    doubt?: boolean;
    confirmedHigh?: boolean;
  }) => { offered: boolean; recommended: boolean; reason: string };
  riskLabel: (suggested: string | null, confirmed: string | null) => string | null;
  NO_EARLIER_CHECK: string;
};

const text = (max: number) => z.string().trim().min(1).max(max);
const idBody = z.object({
  customerId: text(120),
  docType: text(80),
  number: text(40),
  issuerRegion: text(80),
  issuerCountry: text(80),
  expiresOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  faceMatched: z.boolean(),
  looksGenuine: z.boolean(),
});
const returningBody = z.object({
  customerId: text(120),
  doubt: z.boolean().optional(),
});
const revealBody = z.object({
  customerId: text(120),
  checkId: z.string().trim().min(1).max(80).optional(),
  reasonCode: text(80),
  note: z.string().trim().max(1000).optional(),
  action: z.enum(["reveal", "export"]).default("reveal"),
});
const holdBody = z.object({
  customerId: text(120),
  cashMoved: z.boolean(),
  cashHome: z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).optional(),
});
const riskBody = z.object({
  customerId: text(120),
  suggested: z.enum(["low", "normal", "medium", "high"]).optional(),
  confirmed: z.enum(["low", "normal", "medium", "high"]).optional(),
});

type Resolution = { kind: "authenticated"; actor: LedgerActor } | { kind: "unauthenticated" } | { kind: "scope_denied" } | { kind: "plan_denied" };

export function registerExchangeRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  app.addHook("onClose", async () => pool.end());

  async function actor(req: FastifyRequest): Promise<Resolution> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return { kind: "unauthenticated" };
    if ((await tenantPlan(db, user.tenantId)) === "basic") return { kind: "plan_denied" };
    const workspace = await resolveWorkspaceForUser(db, user, req.headers["x-workspace-id"], req.cookies[SESSION_COOKIE]);
    if (!workspace) return { kind: "scope_denied" };
    const current: LedgerActor = {
      userId: user.id,
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      branchId: workspace.branchId,
      workspaceId: workspace.id,
      tillId: workspace.tillId,
      role: user.role,
      authorizedBranchIds: user.authorizedBranchIds,
    };
    await ensureLedgerPrincipal(pool, current);
    return { kind: "authenticated", actor: current };
  }

  function fail(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) {
    if (!(error instanceof LedgerError)) {
      app.log.error(error, "exchange route failure");
      return reply.code(500).send({ code: "INTERNAL_ERROR" });
    }
    const status = error.code === "AUTHORIZATION_DENIED" || error.code === "SCOPE_DENIED"
      ? 403
      : error.code === "INVALID_REQUEST"
        ? 400
        : 422;
    return reply.code(status).send({ code: error.code, message: error.message });
  }

  async function current(req: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const result = await actor(req);
    if (result.kind === "unauthenticated") {
      reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return null;
    }
    if (result.kind === "plan_denied") {
      reply.code(403).send({ code: "PLAN_NOT_ENTITLED" });
      return null;
    }
    if (result.kind === "scope_denied") {
      reply.code(403).send({ code: "SCOPE_DENIED" });
      return null;
    }
    return result.actor;
  }

  app.get("/api/exchange/screening-status", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    return reply.send(await screeningStatus());
  });

  app.get("/api/exchange/id-reveal-reasons", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const client = await pool.connect();
    try {
      const reasons = await listRevealReasons(client);
      return reply.send({ reasons });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/api/exchange/occupation-options", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const kind = (req.query as { kind?: string }).kind === "entity" ? "entity" : "individual";
    const client = await pool.connect();
    try {
      const found = await client.query(
        `SELECT code, label, applies_to FROM fx_occupation_options
          WHERE active AND applies_to IN ($1, 'both')
          ORDER BY sort_order, code`,
        [kind],
      );
      return reply.send({
        kind,
        options: found.rows.map((row) => ({ code: row.code, label: row.label })),
        declined: false,
      });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/api/exchange/id-check", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const customerId = String((req.query as { customerId?: string }).customerId || "").trim();
    if (!customerId) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const client = await pool.connect();
    try {
      const check = await loadShopCheck(client, a.legalEntityId, customerId);
      const high = await confirmedHigh(client, a.legalEntityId, customerId);
      const today = civilToday();
      const decision = rules.returningDecision({
        checkedOn: check && check.liftsLock ? (check.originalCheckedOn || check.checkedOn) : null,
        today,
        doubt: check?.doubt === true,
        confirmedHigh: high,
      });
      return reply.send({
        badge: badgeFor(check),
        maskedNumber: check ? maskedNumber(check) : null,
        method: check?.method ?? null,
        checkedOn: check?.checkedOn ?? null,
        returning: decision.offered
          ? decision
          : { offered: false, recommended: false, reason: decision.reason || rules.NO_EARLIER_CHECK },
      });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/id-check", async (req, reply) => {
    const body = idBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const a = await current(req, reply);
    if (!a) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await recordInPerson(client, a, body.data);
      await client.query("COMMIT");
      return reply.code(201).send({
        checkId: saved.check.checkId,
        number: saved.number,
        maskedNumber: maskedNumber(saved.check),
        badge: saved.badge,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/id-check/returning", async (req, reply) => {
    const body = returningBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const a = await current(req, reply);
    if (!a) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await recordReturning(client, a, body.data.customerId, body.data.doubt === true);
      await client.query("COMMIT");
      return reply.send(saved);
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/id-number/reveal", async (req, reply) => {
    const body = revealBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const a = await current(req, reply);
    if (!a) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const opened = await revealNumber(client, a, body.data);
      await client.query("COMMIT");
      return reply.send(opened);
    } catch (error) {
      await client.query("ROLLBACK");
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/api/exchange/cash-window", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const customerId = String((req.query as { customerId?: string }).customerId || "").trim();
    if (!customerId) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const client = await pool.connect();
    try {
      const window = await loadCashWindow(client, a.legalEntityId, customerId, new Date());
      return reply.send(window);
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/holds", async (req, reply) => {
    const body = holdBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const a = await current(req, reply);
    if (!a) return;
    if (body.data.cashMoved && !(Number(body.data.cashHome) > 0)) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Cash that moved needs an amount." });
    }
    const client = await pool.connect();
    try {
      const holdId = `hold_${randomUUID()}`;
      const before = await client.query(
        `SELECT available_amount FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6`,
        [a.tenantId, a.legalEntityId, a.branchId, a.workspaceId, a.tillId, "CAD"],
      );
      await client.query(
        `INSERT INTO exchange_holds
           (hold_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, customer_id,
            status, cash_moved, cash_home, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9, now() + interval '15 minutes')`,
        [
          holdId, a.tenantId, a.legalEntityId, a.branchId, a.workspaceId, a.tillId,
          body.data.customerId, body.data.cashMoved, body.data.cashMoved ? body.data.cashHome : null,
        ],
      );
      const after = await client.query(
        `SELECT available_amount FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6`,
        [a.tenantId, a.legalEntityId, a.branchId, a.workspaceId, a.tillId, "CAD"],
      );
      return reply.code(201).send({
        holdId,
        rate: null,
        expiresInMinutes: 15,
        tillUnchanged: String(before.rows[0]?.available_amount ?? "") === String(after.rows[0]?.available_amount ?? ""),
      });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/holds/:holdId/cancel", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const holdId = (req.params as { holdId: string }).holdId;
    const client = await pool.connect();
    try {
      const updated = await client.query(
        `UPDATE exchange_holds SET status = 'cancelled'
          WHERE hold_id = $1 AND legal_entity_id = $2 AND status = 'open' AND cash_moved = false
          RETURNING hold_id`,
        [holdId, a.legalEntityId],
      );
      if (!updated.rowCount) {
        return reply.code(422).send({ code: "HOLD_NOT_OPEN", message: "That hold cannot be cancelled. It stays in the log." });
      }
      const still = await client.query(`SELECT status FROM exchange_holds WHERE hold_id = $1`, [holdId]);
      return reply.send({ holdId, status: still.rows[0]?.status, removed: false });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/holds/:holdId/pickup", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const holdId = (req.params as { holdId: string }).holdId;
    const client = await pool.connect();
    try {
      const found = await client.query(
        `SELECT status, expires_at, cash_moved FROM exchange_holds WHERE hold_id = $1 AND legal_entity_id = $2`,
        [holdId, a.legalEntityId],
      );
      const row = found.rows[0];
      if (!row || row.status !== "open") {
        return reply.code(422).send({ code: "HOLD_NOT_OPEN", message: "That hold is not open." });
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query(`UPDATE exchange_holds SET status = 'expired' WHERE hold_id = $1`, [holdId]);
        return reply.code(422).send({ code: "HOLD_EXPIRED", message: "The hold has expired. Quote again.", rate: null });
      }
      await client.query(`UPDATE exchange_holds SET status = 'picked_up' WHERE hold_id = $1`, [holdId]);
      return reply.send({ holdId, quoteAgain: true, rate: null });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/api/exchange/risk", async (req, reply) => {
    const a = await current(req, reply);
    if (!a) return;
    const customerId = String((req.query as { customerId?: string }).customerId || "").trim();
    if (!customerId) return reply.code(400).send({ code: "INVALID_REQUEST" });
    const client = await pool.connect();
    try {
      const found = await client.query(
        `SELECT suggested, confirmed FROM shop_risk_ratings WHERE legal_entity_id = $1 AND customer_id = $2`,
        [a.legalEntityId, customerId],
      );
      const row = found.rows[0];
      const suggested = row?.suggested == null ? null : String(row.suggested);
      const confirmed = row?.confirmed == null ? null : String(row.confirmed);
      return reply.send({ suggested, confirmed, label: rules.riskLabel(suggested, confirmed) });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/api/exchange/risk", async (req, reply) => {
    const body = riskBody.safeParse(req.body);
    if (!body.success || (!body.data.suggested && !body.data.confirmed)) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    const a = await current(req, reply);
    if (!a) return;
    const client = await pool.connect();
    try {
      if (body.data.confirmed) {
        await client.query(
          `INSERT INTO shop_risk_ratings (legal_entity_id, customer_id, confirmed, confirmed_by, confirmed_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (legal_entity_id, customer_id)
           DO UPDATE SET confirmed = EXCLUDED.confirmed, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
          [a.legalEntityId, body.data.customerId, body.data.confirmed, a.userId],
        );
      } else {
        await client.query(
          `INSERT INTO shop_risk_ratings (legal_entity_id, customer_id, suggested)
           VALUES ($1,$2,$3)
           ON CONFLICT (legal_entity_id, customer_id)
           DO UPDATE SET suggested = EXCLUDED.suggested`,
          [a.legalEntityId, body.data.customerId, body.data.suggested],
        );
      }
      const found = await client.query(
        `SELECT suggested, confirmed FROM shop_risk_ratings WHERE legal_entity_id = $1 AND customer_id = $2`,
        [a.legalEntityId, body.data.customerId],
      );
      const suggested = found.rows[0]?.suggested == null ? null : String(found.rows[0].suggested);
      const confirmed = found.rows[0]?.confirmed == null ? null : String(found.rows[0].confirmed);
      return reply.send({ suggested, confirmed, label: rules.riskLabel(suggested, confirmed) });
    } catch (error) {
      return fail(reply, error);
    } finally {
      client.release();
    }
  });
}
