/* ============================================================
   India rules the columns can state, and the two the till can test.

   The pack row holds the amounts. This file is the arithmetic, in
   Decimal, for the parts a teller can hit on a deal:

     customer due diligence on a walk-in at 50,000 INR or more
     customer due diligence on every international money transfer
     a cash sale of foreign exchange at 50,000 INR or more
     a cash transaction report of more than 10 lakh in a calendar month

   The resident cash-payout limit (1,000 USD) is a function here and is
   not called from posting. The till has no residency flag, and a
   visitor may be paid up to 3,000 USD. Refusing every payout over
   1,000 USD would block a payment the direction allows.

   Sources, read 7 Oct 2026, are written up in docs/INDIA_PACK.md.
   ============================================================ */
import Decimal from "decimal.js";
import { idKindForDeal } from "./compliance-gate.js";

export const INDIA_PACK_ID = "pack-in-v1";

/* PML Rules, rule 3(1)(A). More than ten lakh rupees. Exactly ten lakh
   is not a cash transaction report. */
export const INDIA_CTR_RUPEES = new Decimal("1000000");

/* NBFC KYC Directions, 2025, paragraph 21. At or above fifty thousand
   rupees for a walk-in. Every international money transfer. */
export const INDIA_CDD_RUPEES = new Decimal("50000");

/* Money Changing Master Direction, section V, paragraph 2(iv). Cash is
   not accepted for a sale of foreign exchange once the rupee side is
   Rs. 50,000 or more. */
export const INDIA_SALE_CASH_RUPEES = new Decimal("50000");

/* Money Changing Master Direction, section V, paragraph 2(ii). Cash
   rupees to a resident for foreign currency notes or travellers cheques,
   up to USD 1,000 or equivalent per transaction. Not enforced. */
export const INDIA_RESIDENT_PAYOUT_USD = new Decimal("1000");

/* Cross-border wires of more than five lakh. Catalogue only. */
export const INDIA_CBWTR_RUPEES = new Decimal("500000");

export const INDIA_SALE_CASH_MESSAGE =
  "Cash payment for a sale of foreign exchange must be below 50000 INR. This sale is at or above that line, so take a cheque or a bank transfer.";

export const INDIA_PURPOSE_MESSAGE =
  "This deal needs the customer's purpose and the source of the funds before it can be posted.";

export function isIndiaPack(packId: string | null | undefined): boolean {
  return packId === INDIA_PACK_ID;
}

/* The rupee leg of one deal. One side only: adding both legs would
   count an exchange twice. A cross with no rupee leg is unvalued. The
   statute allows a foreign-currency equivalent and does not name a rate
   source, so this does not invent one from the shop board. */
export function indiaCashRupees(input: {
  from: string;
  to: string;
  inputAmount: Decimal;
  outputAmount: Decimal;
}): Decimal | null {
  const from = input.from.trim().toUpperCase();
  const to = input.to.trim().toUpperCase();
  if (from === "INR") return input.inputAmount;
  if (to === "INR") return input.outputAmount;
  return null;
}

/* Asia/Kolkata calendar month, as YYYY-MM. en-CA yields numeric year
   and month. This is the month the cash report uses. It is not a
   rolling 24 hours and not a rolling 30 days. */
export function kolkataMonthKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not read the Asia/Kolkata month.");
  return `${year}-${month}`;
}

export type IndiaCashDeal = {
  amount: Decimal;
  at: Date;
  /* Null means the deal cannot be grouped. A series needs a customer. */
  customerId: string | null;
};

export type IndiaCtrFinding = {
  /* single: rule 3(1)(A). series: rule 3(1)(B), approximated. */
  limb: "single" | "series";
  customerId: string | null;
  month: string;
  amount: Decimal;
};

/* Two limbs, and the gap between them.

   Limb A: one cash amount strictly greater than 10 lakh.
   Limb B: at least two cash amounts, each strictly below 10 lakh, same
   customer, same Asia/Kolkata calendar month, sum strictly greater than
   10 lakh.

   Exactly 10 lakh is in neither limb. A deal already over 10 lakh is
   limb A only and is not added into the series. "Integrally connected"
   is not detected. Same customer and same month is the approximation,
   and it is not the legal test. No customer id: the deal is not grouped.
   */
export function indiaCtrFindings(deals: readonly IndiaCashDeal[]): IndiaCtrFinding[] {
  const findings: IndiaCtrFinding[] = [];
  const below = new Map<string, IndiaCashDeal[]>();
  for (const deal of deals) {
    if (!deal.amount.isFinite() || deal.amount.isNegative()) continue;
    const month = kolkataMonthKey(deal.at);
    if (deal.amount.gt(INDIA_CTR_RUPEES)) {
      findings.push({
        limb: "single",
        customerId: deal.customerId,
        month,
        amount: deal.amount,
      });
      continue;
    }
    if (!deal.amount.lt(INDIA_CTR_RUPEES)) continue;
    const customerId = deal.customerId?.trim() ?? "";
    if (!customerId) continue;
    const key = `${customerId}\n${month}`;
    const list = below.get(key);
    if (list) list.push(deal);
    else below.set(key, [deal]);
  }
  for (const [key, list] of below) {
    if (list.length < 2) continue;
    const sum = list.reduce((total, deal) => total.add(deal.amount), new Decimal(0));
    if (!sum.gt(INDIA_CTR_RUPEES)) continue;
    const split = key.indexOf("\n");
    findings.push({
      limb: "series",
      customerId: key.slice(0, split),
      month: key.slice(split + 1),
      amount: sum,
    });
  }
  return findings;
}

/* True when this unverified customer must be identified. A verified
   customer is the caller's problem: this function does not look at
   status. A desk line can only tighten the walk-in amount. It cannot
   lift remittance or an electronic transfer off "every deal". */
export function indiaIdentificationRequired(
  amountHome: Decimal,
  dealKind: string,
  deskLine: Decimal | null,
): boolean {
  const kind = idKindForDeal(dealKind);
  if (kind === "remittance" || kind === "eft") return true;
  const mandate = INDIA_CDD_RUPEES;
  const line =
    deskLine !== null && deskLine.isFinite() && deskLine.gt(0) && deskLine.lt(mandate)
      ? deskLine
      : mandate;
  return amountHome.gte(line);
}

/* Purpose and source of funds when the due-diligence line is met,
   including when the customer is already verified, and including a
   remittance below the ten-lakh report. */
export function indiaPurposeRequired(amountHome: Decimal, dealKind: string): boolean {
  const kind = idKindForDeal(dealKind);
  if (kind === "remittance" || kind === "eft") return true;
  return amountHome.gte(INDIA_CDD_RUPEES);
}

/* Cash taken for a sale of foreign exchange. The customer pays rupees
   and receives foreign notes. At 50,000 INR and above, cash is refused.
   A purchase (foreign in, rupees out) is not this rule. A cross with no
   rupee leg is not this rule. The fee is not added. Multiple drawals
   for one journey are not summed: the till has no journey id. */
export function indiaSaleCashBlocked(input: {
  packId: string;
  from: string;
  to: string;
  inputAmount: Decimal;
  home: string;
}): boolean {
  if (!isIndiaPack(input.packId)) return false;
  if (input.home.trim().toUpperCase() !== "INR") return false;
  if (input.from.trim().toUpperCase() !== "INR") return false;
  if (input.to.trim().toUpperCase() === "INR") return false;
  return input.inputAmount.gte(INDIA_SALE_CASH_RUPEES);
}

/* Resident cash payout, USD 1,000 or equivalent per purchase. 1,000 is
   allowed. 1,000.01 is not. Not called from posting. */
export function residentCashPayoutWithinLimit(usd: Decimal): boolean {
  return usd.isFinite() && !usd.isNegative() && usd.lte(INDIA_RESIDENT_PAYOUT_USD);
}
