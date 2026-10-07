/* ============================================================
   Hong Kong rules the columns can state, and the ones the till
   can test on a single deal.

   The pack row holds the money-changing line. This file is the
   arithmetic, in Decimal, for the parts a teller can hit:

     customer due diligence on money changing, at or above 120000 HKD
     customer due diligence on a bill, a money order, or a cheque,
     at or above that same 120000 HKD line
     customer due diligence on a wire, a remittance, or a virtual
     asset transfer, at or above 8000 HKD

   A missing threshold, a blank one, a zero, or one that will not
   parse blocks a deal that has a line. Zero means every deal of
   that kind, and it never means the check is off. There is no
   any-amount identification rule for an occasional transaction
   at an MSO counter. Wire message content of any amount is a
   record the desk does not build, and it is not a posting gate.
   A desk line can only tighten. Sources, read 7 Oct 2026, are
   written up in docs/HONG_KONG_PACK.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { marketHomePerUnit } from "./compliance-gate.js";

export const HONG_KONG_PACK_ID = "pack-hk-v1";

/* AMLO Cap. 615 Schedule 2 section 3(1)(b). Equal to or above
   HK$120,000. Exactly 120000 is the trigger. */
export const HK_FX_CDD_HKD = new Decimal("120000");

/* Schedule 2 section 3(1A) and section 13. Equal to or above
   HK$8,000. Exactly 8000 is the trigger. */
export const HK_TRANSFER_CDD_HKD = new Decimal("8000");

export const HK_UNPRICED_MESSAGE =
  "This deal has no Hong Kong dollar amount and no fresh rate, so the desk cannot test the Hong Kong lines. It is not posted.";

export const HK_BOOK_MESSAGE =
  "This Hong Kong desk is not keeping its book in HKD, so the desk cannot test the Hong Kong limits. It is not posted.";

export function isHongKongPack(packId: string | null | undefined): boolean {
  return packId === HONG_KONG_PACK_ID;
}

/* Which identification row this deal reads.

   Do not use idKindForDeal. That helper maps a money order onto the
   remittance row, and a money order is not a wire and not a section 13
   remittance. A bill, a money order, and a cheque are other occasional
   transactions, so they read the money-changing line. The product has
   only four deal kinds on the table, so those three share the fx row. */
export function hongKongIdKind(
  dealKind: string,
): "fx" | "remittance" | "eft" | "virtual_currency" {
  if (
    dealKind === "remittance" ||
    dealKind === "remittance_send" ||
    dealKind === "remittance_receive"
  ) {
    return "remittance";
  }
  if (dealKind === "eft") return "eft";
  if (dealKind === "virtual_currency") return "virtual_currency";
  return "fx";
}

export async function hongKongIdRow(
  client: pg.PoolClient,
  packId: string,
  dealKind: string,
): Promise<{ threshold: unknown; comparator: unknown } | null> {
  const kind = hongKongIdKind(dealKind);
  const found = await client.query(
    `SELECT threshold, comparator
       FROM jurisdiction_id_thresholds
      WHERE pack_id = $1 AND deal_kind = $2`,
    [packId, kind],
  );
  return found.rows[0] ?? null;
}

/* True when this unverified customer must be identified.

   Every kind this pack knows has a line, including virtual currency.
   A missing row blocks. A blank amount, a value that will not parse,
   a bad comparator, or a zero line blocks. Zero means every deal.
   A positive line uses the stored comparator, so "at or above 8000"
   blocks 8000 and allows 7999.99. A desk line can only tighten, and
   only when it is a positive number strictly below the pack line for
   this kind. That tighter number is "at or above". A desk line of
   50000 tightens money changing and does not lift a remittance,
   because 50000 is not below 8000. */
export function identificationBlocks(
  amount: Decimal,
  row: { threshold: unknown; comparator: unknown } | null,
  deskLine: Decimal | null,
): boolean {
  if (!amount.isFinite() || amount.isNegative()) return true;
  if (!row) return true;
  const line = parseLine(row.threshold);
  if (line === "missing" || line === "bad") return true;
  if (line.isZero()) return true;
  const comparator = row.comparator === "gt" || row.comparator === "gte" ? row.comparator : null;
  if (!comparator) return true;
  const over = comparator === "gt" ? amount.gt(line) : amount.gte(line);
  if (over) return true;
  if (deskLine && deskLine.isFinite() && deskLine.gt(0) && deskLine.lt(line)) {
    return amount.gte(deskLine);
  }
  return false;
}

function parseLine(raw: unknown): Decimal | "missing" | "bad" {
  if (raw == null || raw === "") return "missing";
  try {
    const parsed = new Decimal(String(raw));
    if (!parsed.isFinite() || parsed.isNegative()) return "bad";
    return parsed;
  } catch {
    return "bad";
  }
}

/* The Hong Kong dollar leg of one deal. One side only. Adding both
   legs would count an exchange twice. A cross with no HKD leg is
   unvalued here. The shop board is not a rate. */
export function hkdLeg(input: {
  from: string;
  to: string;
  inputAmount: Decimal;
  outputAmount: Decimal;
}): Decimal | null {
  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (from === "HKD") return input.inputAmount;
  if (to === "HKD") return input.outputAmount;
  return null;
}

/* Hong Kong dollars for the money-changing test. An HKD leg is used
   as written, with no rounding. A cross is converted from the amount
   the customer tendered, at the newest market snapshot. No snapshot,
   a stale one, or a missing mid comes back null. The caller refuses
   the deal only when the customer is not yet identified, because a
   verified customer has no amount test left. */
export async function hongKongDealHkd(
  client: pg.PoolClient,
  legs: { from: string; to: string; inputAmount: Decimal; outputAmount: Decimal },
): Promise<{ hkd: Decimal; rate: string; rateAt: Date | null } | null> {
  const exact = hkdLeg(legs);
  if (exact) {
    if (!exact.isFinite() || exact.isNegative()) return null;
    return { hkd: exact, rate: "1.000000000000", rateAt: null };
  }
  const market = await marketHomePerUnit(client, legs.from, "HKD");
  if (!market) return null;
  const hkd = legs.inputAmount.mul(market.rate);
  if (!hkd.isFinite() || hkd.isNegative()) return null;
  return {
    hkd,
    rate: market.rate.toDecimalPlaces(12).toFixed(12),
    rateAt: market.rateAt,
  };
}

/* Schedule 2 section 2(1)(c) asks for purpose and source of funds on
   a business relationship, unless it is obvious. It is not a hard
   requirement on every occasional deal. This pack does not hard
   require them. The generic posting gate treats a report threshold
   of 0 as "no line" and would otherwise demand purpose on every
   deal, including a 10 HKD exchange. Callers skip that gate. */
export function hongKongPurposeRequired(): boolean {
  return false;
}
