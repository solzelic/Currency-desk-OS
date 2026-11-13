/* ============================================================
   Live market rates
   Providers (auto-selected):
     • Open Exchange Rates — hourly-updated data, free tier; used when
       OXR_APP_ID is set (sign up free at openexchangerates.org)
     • open.er-api.com — free, no key, daily-updated data; the default
   Both are normalized to the board convention: mid = CAD per 1 unit.
   Each pull is snapshotted append-only, then a fresh board publication
   is derived from the newest staff publication (their margins, spread
   overrides, show flags and ordering are preserved — only mids move).
   ============================================================ */
import Decimal from "decimal.js";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import type { RateBoardRow } from "../db/schema.js";
import { forgetPublicAnswers } from "./public-board.js";

// non-fiat provider symbols we never offer (metals, IMF SDR, crypto)
const NON_FIAT = new Set(["XAU", "XAG", "XPT", "XPD", "XDR", "BTC"]);

export interface MarketPull {
  provider: string;
  providerTimestamp: string | null;
  /** CAD per 1 unit of each currency */
  mids: Record<string, number>;
}

/** Normalize a units-per-CAD table (rates[X] = X per 1 CAD) to board mids.
    Keeps every fiat currency the provider offers — the full catalog is what
    the staff board's "add currency" list draws from. */
export function normalizePerCad(rates: Record<string, number>): Record<string, number> {
  const mids: Record<string, number> = {};
  for (const [code, perCad] of Object.entries(rates)) {
    if (!/^[A-Z]{3}$/.test(code) || code === "CAD" || NON_FIAT.has(code)) continue;
    if (typeof perCad === "number" && perCad > 0) {
      mids[code] = Number((1 / perCad).toPrecision(8));
    }
  }
  return mids;
}

async function pullOpenErApi(): Promise<MarketPull> {
  const res = await fetch("https://open.er-api.com/v6/latest/CAD");
  if (!res.ok) throw new Error(`open.er-api.com HTTP ${res.status}`);
  const body = (await res.json()) as { result: string; rates: Record<string, number>; time_last_update_utc?: string };
  if (body.result !== "success" || !body.rates) throw new Error("open.er-api.com bad payload");
  return { provider: "open.er-api.com", providerTimestamp: body.time_last_update_utc ?? null, mids: normalizePerCad(body.rates) };
}

async function pullOpenExchangeRates(appId: string): Promise<MarketPull> {
  // free tier is USD-base; rebase to CAD: X per CAD = (X per USD) / (CAD per USD)
  const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${appId}`);
  if (!res.ok) throw new Error(`openexchangerates HTTP ${res.status}`);
  const body = (await res.json()) as { rates: Record<string, number>; timestamp?: number };
  const cadPerUsd = body.rates?.CAD;
  if (!cadPerUsd || cadPerUsd <= 0) throw new Error("openexchangerates missing CAD");
  const perCad: Record<string, number> = {};
  for (const [code, perUsd] of Object.entries(body.rates)) {
    perCad[code] = perUsd / cadPerUsd;
  }
  return {
    provider: "openexchangerates.org",
    providerTimestamp: body.timestamp ? new Date(body.timestamp * 1000).toISOString() : null,
    mids: normalizePerCad(perCad),
  };
}

export async function fetchMarketRates(): Promise<MarketPull> {
  const appId = process.env.OXR_APP_ID;
  if (appId) {
    try {
      return await pullOpenExchangeRates(appId);
    } catch {
      // fall through to the keyless provider rather than serving nothing
    }
  }
  return pullOpenErApi();
}

/** The feed's mids (CAD per 1 unit) in another home currency: each
    divided by the home currency's own CAD mid, as the desk's Board does
    (os-src/rates-board.js homeMarket). CAD itself is added for a shop
    whose home is not CAD. Null when the feed has no mid for the home. */
export function midsInHome(mids: Record<string, number>, home: string): Record<string, number> | null {
  const code = home.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const per = code === "CAD" ? (mids.CAD && mids.CAD > 0 ? mids.CAD : 1) : mids[code];
  if (!per || !(per > 0)) return null;
  if (per === 1 && code === "CAD") return { ...mids };
  const out: Record<string, number> = {};
  for (const [c, cad] of Object.entries(mids)) {
    if (c === code || !(cad > 0)) continue;
    out[c] = Number(new Decimal(cad).div(per).toSignificantDigits(12).toString());
  }
  if (code !== "CAD" && !out.CAD) out.CAD = Number(new Decimal(1).div(per).toSignificantDigits(12).toString());
  return out;
}

/** Derive + publish a fresh board from market mids, preserving the newest
    staff-set margins, per-currency spreads, show flags and board order.
    The mids are put into the board's own home currency first, and a rate
    the shop pinned is never moved. */
export async function publishFromMarket(db: Db, pull: MarketPull, branchId: string, marketSnapshotId?: string): Promise<string | null> {
  if (Object.keys(pull.mids).length === 0) return null;
  /* Locked rates do not move with the market (Lock rates, PUT /api/rates/lock). */
  const lock = (await db.select({ lockedAt: schema.branches.ratesLockedAt }).from(schema.branches).where(eq(schema.branches.id, branchId)).limit(1))[0];
  if (lock?.lockedAt) return null;
  const last = await db
    .select()
    .from(schema.rateBoards)
    .where(eq(schema.rateBoards.branchId, branchId))
    .orderBy(desc(schema.rateBoards.publishedAt))
    .limit(1);
  const prev = last[0];
  if (!prev) return null; // no seed yet — nothing to inherit scope/margins from

  /* The board is priced in its legal entity's home currency, not CAD. A
     home the feed does not price is left as it is rather than filled with
     Canadian dollars. */
  const entity = (await db.select({ home: schema.legalEntities.homeCurrency }).from(schema.legalEntities)
    .where(eq(schema.legalEntities.id, prev.legalEntityId)).limit(1))[0];
  const mids = midsInHome(pull.mids, entity?.home ?? "CAD");
  if (!mids) return null;

  // the board's contents are a STAFF decision — market sync only refreshes
  // mids for currencies already on the board, never adds or removes any
  const rows: Record<string, RateBoardRow> = {};
  for (const [code, prevRow] of Object.entries(prev.boardRows)) {
    const mid = mids[code];
    /* A pinned rate is the shop's own number: the market does not move it. */
    rows[code] = mid && mid > 0 && !prevRow.pinned ? { ...prevRow, mid } : prevRow;
  }

  const id = randomUUID();
  await db.insert(schema.rateBoards).values({
    id,
    tenantId: prev.tenantId,
    legalEntityId: prev.legalEntityId,
    branchId,
    buyMargin: prev.buyMargin,
    sellMargin: prev.sellMargin,
    boardRows: rows,
    boardOrder: prev.boardOrder,
    publishedBy: `market-sync (${pull.provider})`,
    marketSnapshotId: marketSnapshotId ?? null,
    // now() is transaction start, which can precede a slow provider response.
    publishedAt: sql`clock_timestamp()`,
  });
  // The public rate page and screens show this board from now on.
  forgetPublicAnswers();
  return id;
}

/** Milliseconds since the newest snapshot, or Infinity if none exists.
    The clock lives in the database, so it survives process restarts. */
export async function msSinceLastPull(db: Db): Promise<number> {
  const last = await db
    .select({ fetchedAt: schema.marketRates.fetchedAt })
    .from(schema.marketRates)
    .orderBy(desc(schema.marketRates.fetchedAt))
    .limit(1);
  return last[0] ? Date.now() - last[0].fetchedAt.getTime() : Number.POSITIVE_INFINITY;
}

type SyncResult = { ok: boolean; skipped: boolean; detail: string; ageMs: number };

/** One global feed, not one pull per branch. The two-key advisory namespace
    (CDRT, 1) is distinct from IDV's single-key locks. Transaction scope pins
    every query to one connection, also with a transaction-pooling proxy.
    Commit/rollback releases the lock; no session lock can leak into a pool. */
async function syncWithLock(
  db: Db, branchId: string, minGapMs: number | null, fetcher: () => Promise<MarketPull>,
): Promise<SyncResult> {
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    const result = await db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(sql`SELECT pg_try_advisory_xact_lock(1128550996, 1) AS acquired`);
      if (!lock.rows[0]?.acquired) {
        return { ok: false, skipped: true, detail: "sync already in progress", ageMs };
      }
      // Read only after acquiring the lock: a queued connection may have
      // missed another instance completing a pull while it was waiting.
      ageMs = await msSinceLastPull(tx);
      if (minGapMs !== null && ageMs < minGapMs) {
        return { ok: true, skipped: true, detail: `fresh — last pull ${Math.round(ageMs / 60000)}m ago`, ageMs };
      }
      const result = await pullAndPublish(tx, branchId, fetcher);
      return { ...result, skipped: false, ageMs };
    }, { isolationLevel: "read committed" });
    // Readers can refill the cache before this transaction commits. Invalidate
    // again after commit, when the new boards are visible to other connections.
    if (result.ok && !result.skipped) forgetPublicAnswers();
    return result;
  } catch (err) {
    // Catch outside the transaction so failures roll back before reporting.
    return { ok: false, skipped: false, detail: err instanceof Error ? err.message : String(err), ageMs };
  }
}

/** The database freshness gate survives restarts. A competing sync skips
    without fetching; the scheduler retries inside its existing headroom.
    PGlite supports the same transaction/lock SQL. Never throws. */
export async function syncMarketRatesIfStale(
  db: Db,
  branchId: string,
  minGapMs: number,
  fetcher: () => Promise<MarketPull> = fetchMarketRates,
): Promise<SyncResult> {
  return syncWithLock(db, branchId, minGapMs, fetcher);
}

/** Force one sync cycle, still excluding concurrent market syncs. Never throws. */
export async function syncMarketRates(db: Db, branchId: string, fetcher: () => Promise<MarketPull> = fetchMarketRates): Promise<{ ok: boolean; detail: string }> {
  return syncWithLock(db, branchId, null, fetcher);
}

/** Called only with the lock-owning transaction; errors must reach rollback. */
async function pullAndPublish(db: Db, branchId: string, fetcher: () => Promise<MarketPull>): Promise<{ ok: boolean; detail: string }> {
  const pull = await fetcher();
  const snapshotId = randomUUID();
  await db.insert(schema.marketRates).values({
    id: snapshotId,
    provider: pull.provider,
    mids: pull.mids,
    providerTimestamp: pull.providerTimestamp,
    fetchedAt: sql`clock_timestamp()`,
  });
  const publicationId = await publishFromMarket(db, pull, branchId, snapshotId);
  /* Every other branch with Auto-publish on follows the same pull, each
     in its own home currency. One board that fails does not stop the
     rest; it is named in the detail. */
  const following = await db.select({ id: schema.branches.id }).from(schema.branches)
    .where(and(eq(schema.branches.autoPublishRates, true), ne(schema.branches.id, branchId)));
  let published = 0;
  const failed: string[] = [];
  for (const branch of following) {
    try {
      // A failed follower must not abort the enclosing sync transaction.
      const id = await db.transaction((tx) => publishFromMarket(tx, pull, branch.id, snapshotId));
      if (id) published += 1;
    } catch {
      failed.push(branch.id);
    }
  }
  return {
    ok: true,
    detail: `${Object.keys(pull.mids).length} mids from ${pull.provider}${publicationId ? ", board published" : ""}`
      + (following.length ? `, ${published} of ${following.length} auto-publish boards published` : "")
      + (failed.length ? `, failed: ${failed.join(", ")}` : ""),
  };
}
