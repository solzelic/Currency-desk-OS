/* ============================================================
   Singapore rules the columns can state, and the ones the till
   can test on a single deal.

   The pack row holds the money-changing line. This file is the
   arithmetic, in Decimal, for the parts a teller can hit:

     customer due diligence on money changing, more than 5000 SGD
     customer due diligence on a domestic electronic transfer, a
     bill, or a money order, more than 5000 SGD
     customer due diligence on every cross-border money transfer

   A missing threshold, a blank one, or one that will not parse
   blocks a deal that has a line. Zero means every deal of that kind,
   and it never means the check is off. The cross-border rule does
   not read the stored remittance cell at all. A desk line can only
   tighten a money-changing line. It cannot lift a transfer off every
   deal. Sources, read 7 Oct 2026, are written up in
   docs/SINGAPORE_PACK.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { marketHomePerUnit } from "./compliance-gate.js";

export const SINGAPORE_PACK_ID = "pack-sg-v1";

/* PSN01 paragraph 7.3(d), 30 June 2025. More than 5000 SGD.
   Exactly 5000 is not the trigger. */
export const SG_FX_CDD_SGD = new Decimal("5000");

export const SG_UNPRICED_MESSAGE =
  "This deal has no Singapore dollar amount and no fresh rate, so the desk cannot test the 5000 SGD line. It is not posted.";

export const SG_BOOK_MESSAGE =
  "This Singapore desk is not keeping its book in SGD, so the desk cannot test the Singapore limits. It is not posted.";

export function isSingaporePack(packId: string | null | undefined): boolean {
  return packId === SINGAPORE_PACK_ID;
}

/* PSN01 7.3(c) and 7.43. A cross-border money transfer, any amount.
   A money order in this product is domestic, so it is not in this list. */
export function crossBorderMoneyTransfer(dealKind: string): boolean {
  return (
    dealKind === "remittance" ||
    dealKind === "remittance_send" ||
    dealKind === "remittance_receive"
  );
}

/* Which identification row this deal reads.

   Cheque cashing is not a specified payment service under PSN01, so
   it has no row. Virtual currency is not one either: an absent row
   means no line, and a row that is present is still fail closed.
   A money order and a bill use the electronic-transfer row, not the
   remittance gate. */
export function singaporeIdKind(
  dealKind: string,
): "fx" | "remittance" | "eft" | "virtual_currency" | null {
  if (dealKind === "cheque_cashing") return null;
  if (dealKind === "virtual_currency") return "virtual_currency";
  if (crossBorderMoneyTransfer(dealKind)) return "remittance";
  if (dealKind === "eft" || dealKind === "bill_payment" || dealKind === "money_order") {
    return "eft";
  }
  return "fx";
}

export async function singaporeIdRow(
  client: pg.PoolClient,
  packId: string,
  dealKind: string,
): Promise<{ threshold: unknown; comparator: unknown } | null> {
  const kind = singaporeIdKind(dealKind);
  if (!kind) return null;
  const found = await client.query(
    `SELECT threshold, comparator
       FROM jurisdiction_id_thresholds
      WHERE pack_id = $1 AND deal_kind = $2`,
    [packId, kind],
  );
  return found.rows[0] ?? null;
}

/* True when this unverified customer must be identified.

   A cross-border money transfer always returns true. The stored
   remittance cell is ignored, including when it is NULL, 0, or 5000.
   Cheque cashing returns false. Virtual currency with no row returns
   false. Any other kind with no row, a blank amount, a value that
   will not parse, a bad comparator, or a zero line blocks. Zero means
   every deal. A positive line uses the stored comparator, so "more
   than 5000" allows 5000. A desk line can only tighten, and only when
   it is a positive number strictly below the pack line. That tighter
   number is "at or above". */
export function identificationBlocks(
  dealKind: string,
  amount: Decimal,
  row: { threshold: unknown; comparator: unknown } | null,
  deskLine: Decimal | null,
): boolean {
  if (!amount.isFinite() || amount.isNegative()) return true;
  if (dealKind === "cheque_cashing") return false;
  if (crossBorderMoneyTransfer(dealKind)) return true;
  if (dealKind === "virtual_currency" && !row) return false;

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

/* The Singapore dollar leg of one deal. One side only. Adding both
   legs would count an exchange twice. A cross with no SGD leg is
   unvalued here. The shop board is not a rate. */
export function sgdLeg(input: {
  from: string;
  to: string;
  inputAmount: Decimal;
  outputAmount: Decimal;
}): Decimal | null {
  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (from === "SGD") return input.inputAmount;
  if (to === "SGD") return input.outputAmount;
  return null;
}

/* Singapore dollars for the money-changing test. An SGD leg is used
   as written, with no rounding. A cross is converted from the amount
   the customer tendered, at the newest market snapshot. No snapshot,
   a stale one, or a missing mid comes back null. The caller refuses
   the deal only when the customer is not yet identified, because a
   verified customer has no amount test left. */
export async function singaporeDealSgd(
  client: pg.PoolClient,
  legs: { from: string; to: string; inputAmount: Decimal; outputAmount: Decimal },
): Promise<{ sgd: Decimal; rate: string; rateAt: Date | null } | null> {
  const exact = sgdLeg(legs);
  if (exact) {
    if (!exact.isFinite() || exact.isNegative()) return null;
    return { sgd: exact, rate: "1.000000000000", rateAt: null };
  }
  const market = await marketHomePerUnit(client, legs.from, "SGD");
  if (!market) return null;
  const sgd = legs.inputAmount.mul(market.rate);
  if (!sgd.isFinite() || sgd.isNegative()) return null;
  return {
    sgd,
    rate: market.rate.toDecimalPlaces(12).toFixed(12),
    rateAt: market.rateAt,
  };
}

/* PSN01 paragraph 7.18: purpose and source of funds "as appropriate",
   and not for a specified money-changing transaction. This pack does
   not hard require them. The generic posting gate treats a report
   threshold of 0 as "no line" and would otherwise demand purpose on
   every deal, including a 10 SGD exchange. Callers skip that gate. */
export function singaporePurposeRequired(): boolean {
  return false;
}

/* The screen asks, and then renders this. It does not compare the
   amount itself. A cheque is never this duty. A cross-border money
   transfer always is, and that answer does not read a stored cell or
   an amount. No Singapore dollar figure, a figure that will not parse,
   or a negative one fails closed. Everything else is the same Decimal
   test posting uses. */
export function singaporeIdentificationRequired(input: {
  dealKind: string;
  sgd: Decimal | null;
  row: { threshold: unknown; comparator: unknown } | null;
  deskLine: Decimal | null;
}): boolean {
  if (input.dealKind === "cheque_cashing") return false;
  if (crossBorderMoneyTransfer(input.dealKind)) return true;
  if (input.sgd == null || !input.sgd.isFinite() || input.sgd.isNegative()) return true;
  return identificationBlocks(input.dealKind, input.sgd, input.row, input.deskLine);
}
