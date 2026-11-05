/* The board a shop's customers see.

   One publish per shop, read by every public surface: the rate page, the
   window screens and anything the shop plugs in. It is always the latest
   PUBLISHED board in rate_boards, never a draft. Only the code, buy and
   sell leave the server; mids and margins stay inside. */
import Decimal from "decimal.js";
import { asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { RateBoardRow } from "../db/schema.js";

export type PublicRate = { code: string; buy: number; sell: number };
export type PublishedRates = { home: string | null; timeZone: string | null; publishedAt: number | null; rates: PublicRate[] };

/* The desk's own two lines, so a customer is shown what the desk will
   charge. The margin is the row's spread, else the board's buy or sell
   margin, as the quote service picks it (quotes/service.ts). We buy at
   mid x (1 - margin). A customer buying foreign receives (1 - margin) /
   mid units per unit of home currency (quotes/terms.ts), so we sell at
   mid / (1 - margin). The website's older mid x (1 + margin) is a little
   kinder than the desk; this page does not repeat it. Six places, the
   same as the window display. */
function deskPair(row: RateBoardRow, buyMargin: Decimal.Value, sellMargin: Decimal.Value): { buy: number; sell: number } {
  const mid = new Decimal(row.mid);
  const buyM = new Decimal(row.spread ?? buyMargin);
  const sellM = new Decimal(row.spread ?? sellMargin);
  if (!mid.isFinite() || mid.lte(0)) throw new Error("invalid mid on a published board");
  for (const m of [buyM, sellM]) if (!m.isFinite() || m.lt(0) || m.gte(1)) throw new Error("invalid margin on a published board");
  const six = (value: Decimal) => Number(value.toDecimalPlaces(6).toFixed(6));
  return { buy: six(mid.mul(new Decimal(1).sub(buyM))), sell: six(mid.div(new Decimal(1).sub(sellM))) };
}

async function homeCurrency(db: Db, legalEntityId: string): Promise<string | null> {
  const row = (await db
    .select({ home: schema.legalEntities.homeCurrency })
    .from(schema.legalEntities)
    .where(eq(schema.legalEntities.id, legalEntityId))
    .limit(1))[0];
  /* No home currency is shown as none. Substituting one would quote a
     shop in somebody else's money. */
  const code = (row?.home ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/* The shop's clock: the time zone of the branch that published the board,
   else the shop's first branch. The public pages show the publish time and
   whether the shop is open in it. A zone the runtime does not know is
   sent as none: a wrong clock would say a shop is open when it is shut. */
async function shopTimeZone(db: Db, tenantId: string, branchId: string | null): Promise<string | null> {
  const row = (await db
    .select({ zone: schema.branches.timezone })
    .from(schema.branches)
    .where(branchId ? eq(schema.branches.id, branchId) : eq(schema.branches.tenantId, tenantId))
    .orderBy(asc(schema.branches.id))
    .limit(1))[0];
  const zone = (row?.zone ?? "").trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export async function publishedRates(db: Db, tenantId: string): Promise<PublishedRates> {
  const board = (await db
    .select()
    .from(schema.rateBoards)
    .where(eq(schema.rateBoards.tenantId, tenantId))
    .orderBy(desc(schema.rateBoards.publishedAt))
    .limit(1))[0];
  if (!board) {
    const entity = (await db
      .select({ id: schema.legalEntities.id })
      .from(schema.legalEntities)
      .where(eq(schema.legalEntities.tenantId, tenantId))
      .orderBy(asc(schema.legalEntities.id))
      .limit(1))[0];
    return { home: entity ? await homeCurrency(db, entity.id) : null, timeZone: await shopTimeZone(db, tenantId, null), publishedAt: null, rates: [] };
  }
  const rows = board.boardRows ?? {};
  const order = [...new Set(board.boardOrder ?? Object.keys(rows))];
  const rates = order
    .filter((code) => rows[code] && rows[code]!.show !== false)
    .map((code) => ({ code, ...deskPair(rows[code]!, board.buyMargin, board.sellMargin) }));
  return {
    home: await homeCurrency(db, board.legalEntityId),
    timeZone: await shopTimeZone(db, tenantId, board.branchId),
    publishedAt: board.publishedAt.getTime(),
    rates,
  };
}

/* ---- public answers from memory ----
   A TV in the window asks all day. Read from the database each time, it
   would keep a suspended database awake around the clock. A found answer
   is kept here for five minutes. Anything that changes one clears all of
   them at once: a publish, the market sync, a rate page or screen change,
   a shop suspended. The five minutes is the limit for a change this
   process did not make (a second server, a direct write). Not-found is
   never kept, so guessing tokens cannot fill this map. */
const KEEP_MS = 5 * 60_000;
const answers = new Map<string, { at: number; value: unknown }>();

export async function remembered<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const kept = answers.get(key);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.value as T;
  const value = await load();
  if (value === null) answers.delete(key);
  else answers.set(key, { at: Date.now(), value });
  return value;
}

export function forgetPublicAnswers(): void {
  answers.clear();
}

/* ---- a window screen that is on ----
   A screen asks for its rates every minute. Its last sighting is written
   to window_screens.last_seen_at so the desk can show it as On, at most
   once a minute per screen whatever answers the request (the memory above
   or the database), so a screen cannot be made to write more often. */
const SIGHTING_GAP_MS = 60_000;
const sightings = new Map<string, number>();

export function screenSighted(id: string, now = Date.now()): boolean {
  const last = sightings.get(id);
  if (last !== undefined && now - last < SIGHTING_GAP_MS) return false;
  sightings.set(id, now);
  return true;
}

export function forgetScreenSightings(): void {
  sightings.clear();
}
