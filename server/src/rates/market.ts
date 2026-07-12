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
import { desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

// the currencies the desk trades — the board only ever shows these
export const DESK_CURRENCIES = [
  "USD", "EUR", "GBP", "CHF", "AUD", "JPY", "CNY", "INR", "AED", "PHP",
  "MXN", "KRW", "HKD", "SGD", "NZD", "HUF", "TWD", "DKK", "ILS", "SEK",
  "NOK", "ZAR", "BRL", "THB", "PLN", "TRY", "SAR", "PKR",
] as const;

export interface MarketPull {
  provider: string;
  providerTimestamp: string | null;
  /** CAD per 1 unit of each currency */
  mids: Record<string, number>;
}

/** Normalize a units-per-CAD table (rates[X] = X per 1 CAD) to board mids. */
export function normalizePerCad(rates: Record<string, number>): Record<string, number> {
  const mids: Record<string, number> = {};
  for (const code of DESK_CURRENCIES) {
    const perCad = rates[code];
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

/** Derive + publish a fresh board from market mids, preserving the newest
    staff-set margins, per-currency spreads, show flags and board order. */
export async function publishFromMarket(db: Db, pull: MarketPull, branchId: string): Promise<string | null> {
  if (Object.keys(pull.mids).length === 0) return null;
  const last = await db
    .select()
    .from(schema.rateBoards)
    .orderBy(desc(schema.rateBoards.publishedAt))
    .limit(1);
  const prev = last[0];
  if (!prev) return null; // no seed yet — nothing to inherit scope/margins from

  const rows: Record<string, { mid: number; spread?: number; show?: boolean }> = {};
  for (const [code, mid] of Object.entries(pull.mids)) {
    const prevRow = prev.boardRows[code];
    rows[code] = { mid, ...(prevRow?.spread != null ? { spread: prevRow.spread } : {}), show: prevRow ? prevRow.show !== false : true };
  }
  // keep currencies staff added that the provider didn't return
  for (const [code, prevRow] of Object.entries(prev.boardRows)) {
    if (!rows[code]) rows[code] = prevRow;
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
  });
  return id;
}

/** One sync cycle: pull → snapshot → auto-publish. Never throws. */
export async function syncMarketRates(db: Db, branchId: string, fetcher: () => Promise<MarketPull> = fetchMarketRates): Promise<{ ok: boolean; detail: string }> {
  try {
    const pull = await fetcher();
    await db.insert(schema.marketRates).values({
      id: randomUUID(),
      provider: pull.provider,
      mids: pull.mids,
      providerTimestamp: pull.providerTimestamp,
    });
    const publicationId = await publishFromMarket(db, pull, branchId);
    return { ok: true, detail: `${Object.keys(pull.mids).length} mids from ${pull.provider}${publicationId ? ", board published" : ""}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
