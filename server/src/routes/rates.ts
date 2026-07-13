/* ============================================================
   Rate board API
     GET  /api/rates            → current published board (public — it's
                                  the board in the shop window)
     GET  /api/rates/history    → recent publications (staff only)
     POST /api/rates/publish    → append a new publication (staff with
                                  the rates:change permission)
   Publications are append-only: the "current board" is the newest row
   for the branch, and history answers "what was on the board at time T".
   The permission table is imported from the FRONTEND source — one
   contract, no drift.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasBackendPermission } from "../auth/permissions.js";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";

const DEMO_BRANCH = "br-yorkville";

const rowSchema = z.object({
  mid: z.number().positive().finite(),
  spread: z.number().min(0).max(0.2).optional(),
  show: z.boolean().optional(),
});

const publishBody = z.object({
  buyMargin: z.number().min(0).max(0.2),
  sellMargin: z.number().min(0).max(0.2),
  rows: z.record(z.string().regex(/^[A-Z]{3}$/), rowSchema).refine((r) => Object.keys(r).length > 0 && Object.keys(r).length <= 200, {
    message: "1-200 currencies",
  }),
  order: z.array(z.string().regex(/^[A-Z]{3}$/)).max(200).optional(),
  branchId: z.string().min(1).max(120).optional(),
});

function toBoardJson(row: typeof schema.rateBoards.$inferSelect) {
  return {
    buyMargin: row.buyMargin,
    sellMargin: row.sellMargin,
    rows: row.boardRows,
    order: row.boardOrder ?? undefined,
    publishedAt: row.publishedAt.getTime(),
    publishedBy: row.publishedBy ?? undefined,
    branchId: row.branchId,
    publicationId: row.id,
  };
}

export function registerRatesRoutes(app: FastifyInstance, db: Db) {
  // latest raw market snapshot (mid-market is public information)
  app.get("/api/rates/market", async () => {
    const rows = await db
      .select()
      .from(schema.marketRates)
      .orderBy(desc(schema.marketRates.fetchedAt))
      .limit(1);
    const snap = rows[0];
    return snap
      ? { provider: snap.provider, mids: snap.mids, providerTimestamp: snap.providerTimestamp, fetchedAt: snap.fetchedAt.getTime() }
      : { provider: null, mids: null };
  });

  app.get("/api/rates", async (req) => {
    const branchId = (req.query as { branchId?: string }).branchId ?? DEMO_BRANCH;
    const rows = await db
      .select()
      .from(schema.rateBoards)
      .where(eq(schema.rateBoards.branchId, branchId))
      .orderBy(desc(schema.rateBoards.publishedAt))
      .limit(1);
    return { board: rows[0] ? toBoardJson(rows[0]) : null, serverTime: Date.now() };
  });

  app.get("/api/rates/history", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const branchId = (req.query as { branchId?: string }).branchId ?? who.branchId;
    if (!who.authorizedBranchIds.includes(branchId)) {
      return reply.code(403).send({ error: "branch_denied" });
    }
    const rows = await db
      .select()
      .from(schema.rateBoards)
      .where(eq(schema.rateBoards.branchId, branchId))
      .orderBy(desc(schema.rateBoards.publishedAt))
      .limit(20);
    return { publications: rows.map(toBoardJson) };
  });

  app.post("/api/rates/publish", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "rates:change")) {
      return reply.code(403).send({ error: "permission_denied", detail: "rates:change required" });
    }

    const parsed = publishBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    }
    const body = parsed.data;
    const branchId = body.branchId ?? who.branchId;
    if (!who.authorizedBranchIds.includes(branchId)) {
      return reply.code(403).send({ error: "branch_denied" });
    }

    const id = randomUUID();
    const inserted = await db
      .insert(schema.rateBoards)
      .values({
        id,
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId,
        buyMargin: body.buyMargin,
        sellMargin: body.sellMargin,
        boardRows: body.rows,
        boardOrder: body.order ?? null,
        publishedBy: who.staffId,
      })
      .returning();
    await db.insert(schema.auditEvents).values({
      id: randomUUID(),
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      actorId: who.id,
      action: "rates.publish",
      detail: { publicationId: id, currencies: Object.keys(body.rows).length, buyMargin: body.buyMargin, sellMargin: body.sellMargin },
    });
    return { board: toBoardJson(inserted[0]!) };
  });
}
