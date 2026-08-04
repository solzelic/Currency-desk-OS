/* ============================================================
   The board a desk opens with.

   A newly created desk had no rate board at all. Its staff still SAW one,
   because `GET /api/rates` fell back to a hardcoded demo branch — so a new
   shop's screen showed York FX's prices, and the first quote then failed
   with "no published branch board" because their own branch genuinely had
   none. The board looked tradeable and belonged to somebody else.

   A desk now opens with its own board, published at provisioning. Rates
   come from the newest market snapshot when one exists; otherwise from the
   indicative table below, which is a starting point and not a price — the
   desk publishes their own from the Rate Board the first time they set a
   margin, and the market sync refreshes what is already on it.
   ============================================================ */
import { desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

/** Units of each currency per 1 CAD. The board stores CAD per 1 unit. */
export const INDICATIVE_PER_CAD: Readonly<Record<string, number>> = {
  USD: 0.7331, EUR: 0.6798, GBP: 0.5779, CHF: 0.6512, AUD: 1.119, JPY: 109.9,
  CNY: 5.284, INR: 60.31, AED: 2.6926, PHP: 41.15, MXN: 12.42, KRW: 982.4,
  HKD: 5.731, SGD: 0.9912, NZD: 1.2204, HUF: 262.3, TWD: 23.45, DKK: 5.071,
  ILS: 2.701, SEK: 7.842, NOK: 7.815, ZAR: 13.48, BRL: 3.951, THB: 26.38,
  PLN: 2.931, TRY: 23.82, SAR: 2.749, PKR: 204.3,
};

/** What the desk opens at when nobody said. */
const FALLBACK_MARGIN = 0.015;

/**
 * The margin the desk asked for, as a fraction.
 *
 * Onboarding asks "what's your margin on an exchange?", shows the answer
 * back ("on a 1,000 CAD exchange you'd earn about 35 CAD"), draws the live
 * board preview at it — and the desk then opened at a hardcoded 1.5%
 * regardless. On the volumes this product profiles, opening two points
 * under your intended spread is real money a day, and the owner has no
 * reason to check: they typed 3.5 and were shown 3.5.
 *
 * The stored answer is a percentage typed by a person, so it is read
 * defensively: anything unparseable, negative, or above a quarter — which
 * is far past any legitimate retail spread and much more likely to be a
 * fraction someone entered as a percentage — falls back rather than
 * publishing a board nobody meant.
 */
function marginFrom(spreadAll: unknown): number {
  const percent = Number(String(spreadAll ?? "").trim());
  if (!Number.isFinite(percent) || percent <= 0) return FALLBACK_MARGIN;
  const fraction = percent / 100;
  return fraction > 0.25 ? FALLBACK_MARGIN : fraction;
}

/**
 * Publish a branch's first board. Currencies come from what the desk said
 * they trade; anything we have no rate for is left off rather than guessed,
 * and the home currency is never a row — it is the base the board is in.
 * The margin is the one they set in onboarding.
 *
 * Idempotent by branch: a branch that already has a board keeps it.
 */
export async function publishStartingBoard(
  db: Db,
  args: {
    tenantId: string;
    legalEntityId: string;
    branchId: string;
    currencies: readonly string[];
    homeCurrency?: string;
    /** the `spreadAll` answer, a percentage as typed */
    spreadAll?: unknown;
    publishedBy?: string;
  },
): Promise<{ published: boolean; currencies: string[] }> {
  const existing = await db
    .select({ id: schema.rateBoards.id })
    .from(schema.rateBoards)
    .where(eq(schema.rateBoards.branchId, args.branchId))
    .limit(1);
  if (existing.length) return { published: false, currencies: [] };

  const home = (args.homeCurrency ?? "CAD").toUpperCase();
  const snapshot = await db
    .select({ mids: schema.marketRates.mids })
    .from(schema.marketRates)
    .orderBy(desc(schema.marketRates.fetchedAt))
    .limit(1);
  const live = (snapshot[0]?.mids ?? {}) as Record<string, number>;

  const wanted = args.currencies
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code) && code !== home);
  /* A desk that named no currencies still needs a board to trade off, so it
     opens with the majors rather than an empty one they cannot quote from. */
  const codes = wanted.length ? wanted : ["USD", "EUR", "GBP"];

  const rows: Record<string, { mid: number; show: boolean }> = {};
  for (const code of codes) {
    const mid = live[code] ?? midFromIndicative(code);
    if (mid) rows[code] = { mid, show: true };
  }
  if (!Object.keys(rows).length) return { published: false, currencies: [] };

  await db.insert(schema.rateBoards).values({
    id: randomUUID(),
    tenantId: args.tenantId,
    legalEntityId: args.legalEntityId,
    branchId: args.branchId,
    buyMargin: marginFrom(args.spreadAll),
    sellMargin: marginFrom(args.spreadAll),
    boardRows: rows,
    boardOrder: Object.keys(rows),
    publishedBy: args.publishedBy ?? "system:provisioning",
  });
  return { published: true, currencies: Object.keys(rows) };
}

function midFromIndicative(code: string): number | null {
  const perCad = INDICATIVE_PER_CAD[code];
  return perCad ? Number((1 / perCad).toFixed(6)) : null;
}

/**
 * Put the opening float the owner typed during onboarding into the drawer.
 *
 * The onboarding question is explicit about what this is — "roughly what is
 * in the drawer per currency… the first count trues it up" — so it lands on
 * the till, and the day's first close overwrites it with a real count. It
 * was previously stored in `tenants.setup` and applied to nothing, so a desk
 * that had said it held $20,000 opened with an empty drawer.
 *
 * Skipped entirely if the till already has balances: opening figures are
 * stated once and everything after that is a recorded movement.
 */
export async function seedOpeningFloat(
  db: Db,
  args: {
    tenantId: string;
    legalEntityId: string;
    branchId: string;
    workspaceId: string;
    tillId: string;
    float: Record<string, unknown>;
  },
): Promise<{ seeded: string[] }> {
  const amounts: [string, string][] = [];
  for (const [rawCode, rawValue] of Object.entries(args.float ?? {})) {
    const code = String(rawCode).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const value = Number(String(rawValue).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(value) || value < 0) continue;
    amounts.push([code, value.toFixed(2)]);
  }
  if (!amounts.length) return { seeded: [] };

  /* The ledger's tables are raw SQL, not Drizzle models, so this speaks to
     them directly, and it reaches them only when the ledger shares the
     application's database — which is how the product is deployed
     (LEDGER_DATABASE_URL falls back to DATABASE_URL). Where it does not,
     the float is simply not pre-filled and the desk states it from the
     drawer instead.

     Wrapped because creating somebody's desk must never fail over an
     opening float: the desk is the thing they paid for, the float is a
     convenience, and the first count trues it up either way. */
  try {
  const existing = await db.execute(
    sql`SELECT 1 FROM ledger_till_balances WHERE till_id = ${args.tillId}
          AND tenant_id = ${args.tenantId} LIMIT 1`,
  );
  if (rowCount(existing)) return { seeded: [] };

  for (const [currency, available] of amounts) {
    await db.execute(
      sql`INSERT INTO ledger_till_balances
            (tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
             currency, available_amount)
          VALUES (${args.tenantId}, ${args.legalEntityId}, ${args.branchId},
                  ${args.workspaceId}, ${args.tillId}, ${currency}, ${available})
          ON CONFLICT DO NOTHING`,
    );
  }
  return { seeded: amounts.map(([c]) => c) };
  } catch (error) {
    console.warn("opening float not applied to the ledger:", (error as Error)?.message);
    return { seeded: [] };
  }
}

/** Both drivers this project runs on report row counts differently. */
function rowCount(result: unknown): number {
  const r = result as { rowCount?: number; rows?: unknown[] } | unknown[];
  if (Array.isArray(r)) return r.length;
  return r?.rowCount ?? r?.rows?.length ?? 0;
}
