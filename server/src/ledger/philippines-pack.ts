/* ============================================================
   Philippines rules the columns can state, and the ones the till
   can test on a single deal.

   The pack row holds the amounts. This file is the arithmetic, in
   Decimal, for the parts a teller can hit:

     customer due diligence on money changing and remittance, more
     than 5,000 PHP
     customer due diligence on any other occasional deal, more than
     100,000 PHP
     a covered transaction of more than 500,000 PHP
     a cash payout of more than 500,000 PHP, or the foreign-currency
     equivalent
     a sale of foreign currency of more than 10,000 USD, or the
     equivalent, in one transaction

   A missing threshold, a blank one, or one that will not parse blocks
   the deal. Zero means every deal, and a desk line cannot turn that
   off. The live remittance row is 5,000, not zero: a 1.00 PHP
   remittance is allowed. Sources, read 7 Oct 2026, are written up in
   docs/PHILIPPINES_PACK.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { idKindForDeal, marketHomePerUnit } from "./compliance-gate.js";

export const PHILIPPINES_PACK_ID = "pack-ph-v1";

/* RA 11521, amending RA 9160 section 3(b). More than 500,000 PHP.
   Exactly 500,000 is not a covered transaction. */
export const PH_CTR_PHP = new Decimal("500000");

/* MORB Part IX, 31 Dec 2023, section 921(d)(3). Money changing and
   remittance. More than 5,000 PHP. */
export const PH_FX_CDD_PHP = new Decimal("5000");

/* The same section, 921(d)(1). Everything that is not money changing
   or remittance. More than 100,000 PHP. */
export const PH_OCCASIONAL_CDD_PHP = new Decimal("100000");

/* Circular 942, MORNBFI section 4511N.9(a). A cash payout of more
   than 500,000 PHP, or its foreign-currency equivalent, in one
   transaction. Exactly 500,000 may be paid in cash. */
export const PH_CASH_PAYOUT_PHP = new Decimal("500000");

/* Circular 942, section 4511N.9(b). A sale of foreign currency not
   exceeding 10,000 USD or its equivalent per transaction. 10,000 is
   allowed. 10,000.01 is not. */
export const PH_SALE_USD = new Decimal("10000");

export const PH_UNPRICED_MESSAGE =
  "This deal has no peso amount and no fresh rate, so the desk cannot test the Philippine limits. It is not posted.";

export const PH_BOOK_MESSAGE =
  "This Philippines desk is not keeping its book in PHP, so the desk cannot test the Philippine limits. It is not posted.";

export const PH_PAYOUT_BLOCK_MESSAGE =
  "A cash payout of more than 500000 PHP, or the foreign-currency equivalent, has to be a cheque or a credit to a deposit account. This payout is over that line.";

export const PH_PAYOUT_UNPRICED_MESSAGE =
  "This cash payout is in foreign currency and there is no fresh rate, so the desk cannot test the 500000 PHP payout limit. It is not posted.";

export const PH_SALE_BLOCK_MESSAGE =
  "A sale of foreign currency must not exceed 10000 USD, or the equivalent, in one transaction. This sale is over that line.";

export const PH_SALE_UNPRICED_MESSAGE =
  "This sale of foreign currency has no fresh US dollar rate, so the desk cannot test the 10000 USD limit. It is not posted.";

export const PH_PURPOSE_MESSAGE =
  "This deal is over 500000 PHP, so it needs the customer's purpose and the source of the funds before it can be posted.";

export function isPhilippinesPack(packId: string | null | undefined): boolean {
  return packId === PHILIPPINES_PACK_ID;
}

/* Cheque cashing is not money changing. idKindForDeal would call it
   foreign exchange and apply the 5,000 line. The general 100,000 line
   is the eft row. */
export function philippinesIdKind(
  dealKind: string,
): "fx" | "remittance" | "eft" | "virtual_currency" {
  if (dealKind === "cheque_cashing") return "eft";
  return idKindForDeal(dealKind);
}

export async function philippinesIdRow(
  client: pg.PoolClient,
  packId: string,
  dealKind: string,
): Promise<{ threshold: unknown; comparator: unknown } | null> {
  const found = await client.query(
    `SELECT threshold, comparator
       FROM jurisdiction_id_thresholds
      WHERE pack_id = $1 AND deal_kind = $2`,
    [packId, philippinesIdKind(dealKind)],
  );
  return found.rows[0] ?? null;
}

/* True when this unverified customer must be identified.

   No row, a blank amount, a value that will not parse, or a negative
   amount blocks. Zero means every deal: 0.01 is refused. A positive
   line uses the stored comparator, so "more than 5,000" allows 5,000.
   A desk line can only tighten, and only when it is a positive number
   strictly below the pack line. That tighter number is "at or above",
   which is what the desk field means. A desk line of 8,000 does not
   lift a 6,000 deal off a 5,000 line. */
export function identificationBlocks(
  amount: Decimal,
  row: { threshold: unknown; comparator: unknown } | null,
  deskLine: Decimal | null,
): boolean {
  if (!amount.isFinite() || amount.isNegative()) return true;
  if (!row) return true;
  const line = parseLine(row.threshold);
  if (line === "missing" || line === "bad") return true;
  const comparator = row.comparator === "gt" || row.comparator === "gte" ? row.comparator : null;
  if (!comparator) return true;
  const over = comparator === "gt" ? amount.gt(line) : amount.gte(line);
  if (over) return true;
  if (line.isZero()) return false;
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

/* The peso leg of one deal. One side only. Adding both legs would
   count an exchange twice. A cross with no peso leg is unvalued here.
   The shop board is not a rate. */
export function pesoLeg(input: {
  from: string;
  to: string;
  inputAmount: Decimal;
  outputAmount: Decimal;
}): Decimal | null {
  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (from === "PHP") return input.inputAmount;
  if (to === "PHP") return input.outputAmount;
  return null;
}

/* Pesos for the covered-transaction and due-diligence tests. A peso
   leg is used as written, with no rounding. A cross is converted from
   the amount the customer tendered, at the newest market snapshot.
   No snapshot, a stale one, or a missing mid comes back null. The
   caller refuses the deal. */
export async function philippinesDealPesos(
  client: pg.PoolClient,
  legs: { from: string; to: string; inputAmount: Decimal; outputAmount: Decimal },
): Promise<{ pesos: Decimal; rate: string; rateAt: Date | null } | null> {
  const exact = pesoLeg(legs);
  if (exact) {
    if (!exact.isFinite() || exact.isNegative()) return null;
    return { pesos: exact, rate: "1.000000000000", rateAt: null };
  }
  const market = await marketHomePerUnit(client, legs.from, "PHP");
  if (!market) return null;
  const pesos = legs.inputAmount.mul(market.rate);
  if (!pesos.isFinite() || pesos.isNegative()) return null;
  return {
    pesos,
    rate: market.rate.toDecimalPlaces(12).toFixed(12),
    rateAt: market.rateAt,
  };
}

/* Cash leaving the drawer. PHP is compared as written. Any other
   currency is turned into pesos at the market snapshot, unrounded,
   and compared with "more than". A missing rate does not allow the
   payout. A payout that is already a cheque or a bank credit is not
   this function: the caller does not ask. */
export async function philippinesCashPayout(
  client: pg.PoolClient,
  currency: string,
  amount: Decimal,
): Promise<"ok" | "over" | "unpriced"> {
  if (!amount.isFinite() || amount.isNegative()) return "unpriced";
  if (amount.isZero()) return "ok";
  const code = currency.trim().toUpperCase();
  if (code === "PHP") return amount.gt(PH_CASH_PAYOUT_PHP) ? "over" : "ok";
  const market = await marketHomePerUnit(client, code, "PHP");
  if (!market) return "unpriced";
  return amount.mul(market.rate).gt(PH_CASH_PAYOUT_PHP) ? "over" : "ok";
}

/* Sale of foreign currency: the customer pays pesos and receives
   foreign notes. USD is compared as written. Any other currency is
   turned into US dollars at the market snapshot. A purchase (foreign
   in, pesos out) is not this rule. The monthly 50,000 USD cap is not
   summed here. */
export async function philippinesFxSale(
  client: pg.PoolClient,
  from: string,
  to: string,
  outputAmount: Decimal,
): Promise<"ok" | "over" | "unpriced" | "not_a_sale"> {
  if (from.trim().toUpperCase() !== "PHP") return "not_a_sale";
  if (to.trim().toUpperCase() === "PHP") return "not_a_sale";
  if (!outputAmount.isFinite() || outputAmount.isNegative()) return "unpriced";
  if (to.trim().toUpperCase() === "USD") {
    return outputAmount.gt(PH_SALE_USD) ? "over" : "ok";
  }
  const market = await marketHomePerUnit(client, to, "USD");
  if (!market) return "unpriced";
  return outputAmount.mul(market.rate).gt(PH_SALE_USD) ? "over" : "ok";
}

/* Purpose and source of funds when the deal itself is a covered
   transaction. Not at 5,000. Exactly 500,000 does not need them. */
export function philippinesPurposeRequired(pesos: Decimal): boolean {
  return pesos.isFinite() && pesos.gt(PH_CTR_PHP);
}
