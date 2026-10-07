/* ============================================================
   Australia, pack-au-v2, as the Act writes it.

   Called only for that pack. Other country packs keep the single
   identification column they already had. pack-au-v1 is not read
   here, so a desk that has not opted in is not judged by these lines.

   Money is Decimal. A missing cash figure is null, never zero: zero
   would say the desk handled no cash, and null says we cannot tell.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import {
  idKindForDeal,
  type ComplianceStamp,
} from "./compliance-gate.js";
import type { JurisdictionPack } from "./jurisdiction.js";
import type { LedgerActor } from "./service.js";
import { resolveIdThreshold } from "./thresholds.js";

export const AU_V1_PACK_ID = "pack-au-v1";
export const AU_V2_PACK_ID = "pack-au-v2";

/* Act s.39E items 9 and 10: initial customer due diligence on a
   currency exchange starts at 1,000 AUD. Items 27 and 28 use the same
   figure for a money order, as a separate rule that happens to match. */
export const AU_FX_CDD = new Decimal("1000.00");
/* Act s.43. Physical currency, received or paid. */
export const AU_TTR_AMOUNT = new Decimal("10000.00");

const IDENTITY: ComplianceStamp = { rate: "1.000000000000", rateAt: null, source: null };

const CHEQUE_KINDS = new Set([
  "cheque_cashing",
  "cheque_clearing",
  "cheque_return",
]);

function hits(amount: Decimal, line: Decimal, comparator: string): boolean {
  return comparator === "gt" ? amount.gt(line) : amount.gte(line);
}

/* The desk's own identification number, when it has typed one.
   Zero on this old column means the box was left empty. It does not
   mean every deal. A positive number replaces the foreign-exchange
   line, including a looser one. It must not lift a line that is
   already zero. */
async function deskIdentification(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<Decimal | null> {
  const found = await client.query(
    "SELECT id_threshold FROM legal_entities WHERE id=$1",
    [legalEntityId],
  );
  const value = found.rows[0]?.id_threshold;
  if (value == null || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

/* A lower desk number tightens the line. A higher one replaces the
   foreign-exchange line only. Remittance and electronic transfer stay
   at zero no matter what the settings box says. */
function effectiveLine(
  desk: Decimal | null,
  packLine: Decimal,
  replace: boolean,
): Decimal {
  if (desk === null) return packLine;
  if (replace) return desk;
  return desk.lt(packLine) ? desk : packLine;
}

type IdRow = {
  threshold: Decimal;
  comparator: string;
  cashOnly: boolean;
};

async function identificationRow(
  client: pg.PoolClient,
  dealKind: string,
): Promise<IdRow | null> {
  const found = await client.query(
    `SELECT threshold, comparator, cash_only
       FROM jurisdiction_id_thresholds
      WHERE pack_id = $1 AND deal_kind = $2`,
    [AU_V2_PACK_ID, dealKind],
  );
  const row = found.rows[0];
  if (!row || row.threshold == null || row.threshold === "") return null;
  let threshold: Decimal;
  try {
    threshold = new Decimal(String(row.threshold));
  } catch {
    return null;
  }
  if (!threshold.isFinite() || threshold.isNegative()) return null;
  return {
    threshold,
    comparator: String(row.comparator || "gte"),
    cashOnly: row.cash_only === true,
  };
}

/**
 * Whether this unverified customer may be served under pack-au-v2.
 * The caller has already let a verified customer through.
 *
 * Cheque cashing is not item 50. It stays on the single identification
 * column, which this pack still sets at 1,000 AUD. A money order uses
 * the item 27 and 28 figure, not the remittance line of zero.
 */
export async function australiaIdentification(
  client: pg.PoolClient,
  actor: LedgerActor,
  pack: JurisdictionPack,
  amountHome: Decimal,
  deal: { kind: string; cash: boolean },
): Promise<ComplianceStamp & { block: boolean }> {
  const desk = await deskIdentification(client, actor.legalEntityId);

  if (CHEQUE_KINDS.has(deal.kind)) {
    const line = await resolveIdThreshold(client, actor.legalEntityId, pack);
    if (line === null) return { block: true, ...IDENTITY };
    return { block: amountHome.gte(line), ...IDENTITY };
  }

  if (deal.kind === "money_order") {
    const line = effectiveLine(desk, AU_FX_CDD, true);
    return { block: amountHome.gte(line), ...IDENTITY };
  }

  const kind = idKindForDeal(deal.kind);
  const row = await identificationRow(client, kind);
  /* No row means the pack is incomplete. An unverified customer is
     not waved through. */
  if (!row) return { block: true, ...IDENTITY };
  if (row.cashOnly && !deal.cash) return { block: false, ...IDENTITY };

  const replace = kind === "fx";
  const line = effectiveLine(desk, row.threshold, replace);
  return { block: hits(amountHome, line, row.comparator), ...IDENTITY };
}

/**
 * A threshold transaction, Act s.43. Either leg at or above 10,000 AUD.
 * Null on a leg means that leg was not measured. It is not a zero.
 */
export function thresholdTransactionDue(
  received: Decimal | null,
  paid: Decimal | null,
  threshold: Decimal = AU_TTR_AMOUNT,
): { received: boolean; paid: boolean } {
  const leg = (amount: Decimal | null) =>
    amount != null && amount.isFinite() && amount.gte(threshold);
  return { received: leg(received), paid: leg(paid) };
}

/* Act s.5. A business day is a day other than a Saturday, a Sunday, or
   a public or bank holiday in the place concerned. This product does
   not ship a holiday calendar. The caller can pass dates as
   YYYY-MM-DD. Weekends are always excluded. */
export function isBusinessDay(
  day: Date,
  holidays: ReadonlySet<string> = new Set(),
): boolean {
  const weekday = day.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const month = String(day.getUTCMonth() + 1).padStart(2, "0");
  const date = String(day.getUTCDate()).padStart(2, "0");
  const key = `${day.getUTCFullYear()}-${month}-${date}`;
  return !holidays.has(key);
}

/** The date that is `count` business days after the civil day of `from`.
    The starting day itself is not counted. Act s.43: within 10 business
    days after the day the transaction takes place. */
export function addBusinessDays(
  from: Date,
  count: number,
  holidays: ReadonlySet<string> = new Set(),
): Date {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("A business-day count has to be a positive whole number.");
  }
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  let left = count;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor, holidays)) left -= 1;
  }
  return cursor;
}

/** Act s.41, terrorism financing: 24 hours after the time the suspicion
    is formed. This is a clock, not a business day. */
export function hoursAfter(from: Date, hours: number): Date {
  if (!Number.isInteger(hours) || hours < 1) {
    throw new Error("An hour count has to be a positive whole number.");
  }
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}
