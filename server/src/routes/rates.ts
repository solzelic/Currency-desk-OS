/* ============================================================
   Rate board API
     GET  /api/rates            → current published board (public — it's
                                  the board in the shop window)
     GET  /api/rates/history    → recent publications (staff only)
     POST /api/rates/publish    → append a new publication (staff with
                                  the rates:change permission); refused
                                  while the branch's rates are locked
     PUT  /api/rates/lock       → lock or unlock this branch's rates
                                  (rates:change, audited)
   Publications are append-only: the "current board" is the newest row
   for the branch, and history answers "what was on the board at time T".
   The permission table is the server's own (auth/permissions.ts).
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { desc, eq, lte } from "drizzle-orm";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasBackendPermission } from "../auth/permissions.js";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { jsonMargin } from "../sites/storefront-hold.js";
import { quoteHomeMarket } from "../rates/ticker-quotes.js";
import { forgetPublicAnswers } from "../rates/public-board.js";

const DEMO_BRANCH = "br-yorkville";

const rowSchema = z.object({
  mid: z.number().positive().finite(),
  spread: z.number().min(0).max(0.2).optional(),
  show: z.boolean().optional(),
  /* A rate the shop pinned: the market sync leaves it alone. */
  pinned: z.literal(true).optional(),
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
    buyMargin: jsonMargin(row.buyMargin),
    sellMargin: jsonMargin(row.sellMargin),
    rows: row.boardRows,
    order: row.boardOrder ?? undefined,
    publishedAt: row.publishedAt.getTime(),
    publishedBy: row.publishedBy ?? undefined,
    marketSnapshotId: row.marketSnapshotId ?? undefined,
    branchId: row.branchId,
    publicationId: row.id,
  };
}

/* A branch's lock as the desk sees it: who locked it and when, or null. */
function lockOf(row: { lockedAt: Date | null; lockedBy: string | null }) {
  return row.lockedAt ? { at: row.lockedAt.getTime(), by: row.lockedBy ?? null } : null;
}

export function registerRatesRoutes(app: FastifyInstance, db: Db) {
  /* The desk's tape, in its own currency. The public snapshot below stays
     Canadian dollars per unit — the storefront and the rate sync read it
     that way. This one is the signed-in desk, so the cross is applied
     before anything is shown. */
  app.get("/api/rates/ticker", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const entity = await db
      .select({ homeCurrency: schema.legalEntities.homeCurrency })
      .from(schema.legalEntities)
      .where(eq(schema.legalEntities.id, who.legalEntityId))
      .limit(1);
    /* An entity with no home currency is not a Canada desk. Substituting
       CAD here quoted a dinar shop in Canadian dollars. */
    const home = (entity[0]?.homeCurrency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(home)) return { home: null, priced: false, quotes: [] };
    const rows = await db
      .select()
      .from(schema.marketRates)
      .orderBy(desc(schema.marketRates.fetchedAt))
      .limit(1);
    const snap = rows[0];
    /* Same 24-hour line the compliance gate uses
       (`fetched_at >= now() - interval '24 hours'`). A snapshot older
       than that, or no snapshot from about a day earlier, is not a
       change — the prices may still show, the percent does not. */
    const DAY_MS = 24 * 60 * 60 * 1000;
    const fresh = !!snap && Date.now() - snap.fetchedAt.getTime() <= DAY_MS;
    let prior: Record<string, unknown> | null = null;
    if (snap && fresh) {
      const earlier = await db
        .select()
        .from(schema.marketRates)
        .where(lte(schema.marketRates.fetchedAt, new Date(snap.fetchedAt.getTime() - DAY_MS)))
        .orderBy(desc(schema.marketRates.fetchedAt))
        .limit(1);
      prior = (earlier[0]?.mids as Record<string, unknown> | undefined) ?? null;
    }
    const quoted = quoteHomeMarket(home, (snap?.mids as Record<string, unknown> | undefined) ?? null, prior);
    return { home, priced: quoted.priced, quotes: quoted.quotes };
  });

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
    /* WHOSE BOARD IS THIS?

       This used to answer with a hardcoded demo branch whenever no branchId
       was given, and the OS has never sent one — so the moment there was a
       second desk, its staff were shown York FX's prices on their own rate
       board, and their first quote then failed with "no published branch
       board" because their branch genuinely had none. The board looked
       tradeable and was not, and it belonged to another shop.

       A request carrying a session is staff at a desk, and the answer is
       their own branch. The demo fallback survives only for a request with
       no session at all — the public shop-window case this endpoint was
       written for. */
    const asked = (req.query as { branchId?: string }).branchId;
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    const branchId = asked
      ? asked
      : who
        ? who.branchId
        : DEMO_BRANCH;
    if (asked && who && !who.authorizedBranchIds.includes(asked)) {
      return { board: null, serverTime: Date.now() };
    }
    const rows = await db
      .select()
      .from(schema.rateBoards)
      .where(eq(schema.rateBoards.branchId, branchId))
      .orderBy(desc(schema.rateBoards.publishedAt))
      .limit(1);
    /* Signed-in staff also see whether the board follows the market, and
       whether its rates are locked (who locked them, and when). */
    const branch = who
      ? (await db.select({ on: schema.branches.autoPublishRates, lockedAt: schema.branches.ratesLockedAt, lockedBy: schema.branches.ratesLockedBy })
        .from(schema.branches).where(eq(schema.branches.id, branchId)).limit(1))[0]
      : undefined;
    return {
      board: rows[0] ? toBoardJson(rows[0]) : null,
      serverTime: Date.now(),
      ...(branch ? { autoPublish: branch.on, locked: lockOf(branch) } : {}),
    };
  });

  /* Auto-publish: every market pull publishes this branch's board again,
     in the shop's home currency, keeping its margins, spreads, shown
     currencies, order and pinned rates (rates/market.ts). Staff who may
     change rates switch it; each change is in the audit log. */
  app.put("/api/rates/auto-publish", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "rates:change")) {
      return reply.code(403).send({ error: "permission_denied", detail: "rates:change required" });
    }
    const parsed = z.object({ on: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const before = (await db.select({ on: schema.branches.autoPublishRates }).from(schema.branches).where(eq(schema.branches.id, who.branchId)).limit(1))[0];
    if (!before) return reply.code(404).send({ error: "not_found" });
    await db.update(schema.branches).set({ autoPublishRates: parsed.data.on }).where(eq(schema.branches.id, who.branchId));
    if (before.on !== parsed.data.on) {
      await db.insert(schema.auditEvents).values({
        id: randomUUID(),
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        actorId: who.id,
        action: "rates.auto_publish",
        detail: { old: before.on, new: parsed.data.on },
      });
    }
    return { autoPublish: parsed.data.on };
  });

  /* Lock rates (the design's header button). While locked nobody
     publishes this branch's board and the market sync leaves it alone
     (rates/market.ts). Staff who may change rates lock and unlock their
     own branch; each change is in the audit log. */
  app.put("/api/rates/lock", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "rates:change")) {
      return reply.code(403).send({ error: "permission_denied", detail: "rates:change required" });
    }
    const parsed = z.object({ locked: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const before = (await db.select({ lockedAt: schema.branches.ratesLockedAt, lockedBy: schema.branches.ratesLockedBy })
      .from(schema.branches).where(eq(schema.branches.id, who.branchId)).limit(1))[0];
    if (!before) return reply.code(404).send({ error: "not_found" });
    const was = before.lockedAt !== null;
    if (was === parsed.data.locked) return { locked: lockOf(before) };
    const after = parsed.data.locked ? { lockedAt: new Date(), lockedBy: who.staffId } : { lockedAt: null, lockedBy: null };
    await db.update(schema.branches).set({ ratesLockedAt: after.lockedAt, ratesLockedBy: after.lockedBy }).where(eq(schema.branches.id, who.branchId));
    await db.insert(schema.auditEvents).values({
      id: randomUUID(),
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: who.branchId,
      actorId: who.id,
      action: "rates.lock",
      detail: { old: was, new: parsed.data.locked },
    });
    return { locked: lockOf(after) };
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
    /* Locked rates do not change, from this screen or any other. */
    const lock = (await db.select({ lockedAt: schema.branches.ratesLockedAt }).from(schema.branches).where(eq(schema.branches.id, branchId)).limit(1))[0];
    if (lock?.lockedAt) {
      return reply.code(409).send({ error: "rates_locked", detail: "Rates are locked. Unlock them to make changes." });
    }

    const id = randomUUID();
    const inserted = await db
      .insert(schema.rateBoards)
      .values({
        id,
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId,
        buyMargin: new Decimal(body.buyMargin).toFixed(12),
        sellMargin: new Decimal(body.sellMargin).toFixed(12),
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
    // The public rate page and screens show this board from now on.
    forgetPublicAnswers();
    return { board: toBoardJson(inserted[0]!) };
  });
}
