/* Review queue and the ID-check screen.

   A teller receives only the neutral sentence. The matched name stays
   on the review row for a compliance officer or the owner. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import { z } from "zod";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import type { Db } from "../db/index.js";
import { screenSubject, TELLER_HOLD_MESSAGE } from "./gate.js";
import type { ScreeningProvider } from "./provider.js";
import { SCORE_THRESHOLD_PLACEHOLDER, THRESHOLD_SIGNOFF } from "./names.js";

const idCheckBody = z.object({
  clientId: z.string().trim().min(1).max(80),
  tier: z.enum(["1", "2", "3", "quick", "verify", "plus"]),
  pepAnswer: z.boolean().optional(),
}).strict();

const decisionBody = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

const TIER_NUMBER: Record<string, "1" | "2" | "3"> = {
  "1": "1", quick: "1", "2": "2", verify: "2", "3": "3", plus: "3",
};

export type ScreeningRouteOptions = {
  provider?: ScreeningProvider;
};

export function registerScreeningRoutes(
  app: FastifyInstance,
  db: Db,
  databaseUrl: string,
  options?: ScreeningRouteOptions,
): void {
  /* Present so a caller can pass a vendor later. This route never calls it. */
  void options?.provider;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  app.addHook("onClose", async () => { await pool.end(); });

  app.post("/api/screening/id-check", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const body = idCheckBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const tier = TIER_NUMBER[body.data.tier] ?? "1";
    if ((tier === "1" || tier === "2") && typeof body.data.pepAnswer !== "boolean") {
      return reply.code(400).send({
        error: "pep_answer_required",
        message: "Ask the client whether they are a politically exposed person, and record the answer.",
      });
    }
    const owned = await pool.query(
      `SELECT display_name, date_of_birth FROM desk_clients
        WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
      [body.data.clientId, who.tenantId, who.legalEntityId],
    );
    if (!owned.rowCount) return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (tier === "1" || tier === "2") {
        await client.query(
          `INSERT INTO client_pep_answers (client_id, tier, is_pep, answered_at, answered_by)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (client_id) DO UPDATE
             SET tier = EXCLUDED.tier, is_pep = EXCLUDED.is_pep,
                 answered_at = now(), answered_by = EXCLUDED.answered_by`,
          [body.data.clientId, tier, body.data.pepAnswer, who.staffId],
        );
      }
      const row = owned.rows[0];
      const plan = await screenSubject(client, {
        tenantId: who.tenantId, legalEntityId: who.legalEntityId, userId: who.staffId,
      }, {
        name: String(row.display_name),
        dob: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
        clientId: body.data.clientId,
      });
      await client.query("COMMIT");
      if (plan.hold) {
        return { screened: true, tier, state: "needs_review", message: TELLER_HOLD_MESSAGE };
      }
      if (plan.outcome === "not_screened") return { screened: true, tier, state: "not_screened" };
      return { screened: true, tier, state: "clear" };
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ name: err instanceof Error ? err.name : "Error" }, "id check screen failed");
      return reply.code(500).send({ error: "screen_failed" });
    } finally {
      client.release();
    }
  });

  app.get("/api/screening/reviews", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "screening:review")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const setting = await pool.query(
      "SELECT score_threshold, signed_off FROM sanctions_score_settings WHERE legal_entity_id = $1",
      [who.legalEntityId],
    );
    const stored = setting.rows[0];
    const items = await pool.query(
      `SELECT review_id, subject_name, matched_name, matched_source_key, score, status,
              client_id, customer_id, quote_id, created_at
         FROM sanctions_reviews
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND status IN ('open', 'confirmed')
        ORDER BY created_at DESC
        LIMIT 100`,
      [who.tenantId, who.legalEntityId],
    );
    return {
      threshold: {
        score: stored ? Number(stored.score_threshold) : SCORE_THRESHOLD_PLACEHOLDER,
        signedOff: stored ? stored.signed_off === true : false,
        note: THRESHOLD_SIGNOFF,
      },
      items: items.rows.map((row) => ({
        reviewId: row.review_id,
        subjectName: row.subject_name,
        matchedName: row.matched_name,
        sourceKey: row.matched_source_key,
        score: row.score === null || row.score === undefined ? null : Number(row.score),
        status: row.status,
        clientId: row.client_id,
        customerId: row.customer_id,
        quoteId: row.quote_id,
        createdAt: row.created_at,
      })),
    };
  });

  async function decide(action: "clear" | "confirm", req: FastifyRequest<{ Params: { reviewId: string } }>, reply: FastifyReply) {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "screening:review")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "reason_required" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE sanctions_reviews
            SET status = $4
          WHERE review_id = $1 AND tenant_id = $2 AND legal_entity_id = $3 AND status = 'open'
          RETURNING review_id`,
        [req.params.reviewId, who.tenantId, who.legalEntityId, action === "clear" ? "cleared" : "confirmed"],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "not_open" });
      }
      await client.query(
        `INSERT INTO sanctions_review_decisions (decision_id, review_id, actor_id, action, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [`dec_${randomUUID()}`, req.params.reviewId, who.staffId, action, body.data.reason],
      );
      await client.query("COMMIT");
      return { ok: true, status: action === "clear" ? "cleared" : "confirmed" };
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error({ name: err instanceof Error ? err.name : "Error" }, "review decision failed");
      return reply.code(500).send({ error: "decision_failed" });
    } finally {
      client.release();
    }
  }

  app.post<{ Params: { reviewId: string } }>("/api/screening/reviews/:reviewId/clear", async (req, reply) => decide("clear", req, reply));
  app.post<{ Params: { reviewId: string } }>("/api/screening/reviews/:reviewId/confirm", async (req, reply) => decide("confirm", req, reply));
}
