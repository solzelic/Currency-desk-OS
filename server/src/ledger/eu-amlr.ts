/* The European Union pack that follows Regulation (EU) 2024/1624.
   It applies from 10 July 2027. Until that date a desk on this pack
   is told so. National law still governs the shop today.

   The lines are the ones the regulation writes down. A draft test for
   linked transactions is not applied. Article 80's cash payment limit
   is not a block. pack-eu-v1 is a different row and is not read here. */
import Decimal from "decimal.js";
import { idKindForDeal } from "./compliance-gate.js";
import { EU_AMLR_PACK_ID } from "./jurisdiction.js";

export { EU_AMLR_PACK_ID };

export const EU_AMLR_APPLIES_FROM = "2027-07-10";

export const EU_AMLR_NOTICE =
  "These are the 2027 European Union rules. They apply from 10 July 2027. Until then, your country's current anti-money-laundering law still governs. That includes the national rules that transpose the fourth and fifth anti-money-laundering directives.";

export type EuIdLine = {
  lineId: string;
  dealKind: string;
  threshold: Decimal;
  comparator: "gte" | "gt";
  diligence: "identify" | "cdd" | "edd";
  cashOnly: boolean;
};

export type EuDuty = {
  /** An unverified customer cannot be posted. */
  identify: boolean;
  /** Purpose and source of funds are required, verified or not. */
  cdd: boolean;
  /** The lines could not be read. Refuse rather than guess. */
  failClosed: boolean;
};

const CHEQUE = "cheque_cashing";

function pgCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function dateOnly(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** The disclaimer while today is before the date the regulation applies.
    On that date, and after it, there is nothing extra to say. */
export function euAmlrNotice(appliesFrom: unknown, today = new Date()): string | null {
  const from = dateOnly(appliesFrom);
  if (!from) return null;
  const now = today.toISOString().slice(0, 10);
  return now < from ? EU_AMLR_NOTICE : null;
}

type QueryClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** The identification lines for this pack. Null when the table is not
    there yet (the embedded database does not run SQL migrations). */
export async function loadEuAmlrLines(
  client: QueryClient,
  packId: string,
): Promise<EuIdLine[] | null> {
  /* Posting holds a transaction. A missing table aborts it unless
     this read sits on its own savepoint. A caller that has not opened
     a transaction (a direct gate check) cannot use a savepoint, and
     a failed statement there does not poison the next one. */
  let savepoint = false;
  try {
    await client.query("SAVEPOINT eu_amlr_lines");
    savepoint = true;
  } catch (error) {
    if (pgCode(error) !== "25P01") throw error;
  }
  try {
    const found = await client.query(
      `SELECT line_id, deal_kind, threshold, comparator, diligence, cash_only
         FROM jurisdiction_rule_lines
        WHERE pack_id = $1`,
      [packId],
    );
    if (savepoint) await client.query("RELEASE SAVEPOINT eu_amlr_lines");
    const lines: EuIdLine[] = [];
    for (const row of found.rows) {
      const parsed = parseLine(row);
      if (!parsed) return null;
      lines.push(parsed);
    }
    return lines;
  } catch (error) {
    if (savepoint) await client.query("ROLLBACK TO SAVEPOINT eu_amlr_lines");
    const code = pgCode(error);
    if (code === "42P01" || code === "42703") return null;
    throw error;
  }
}

function parseLine(row: Record<string, unknown>): EuIdLine | null {
  try {
    const threshold = new Decimal(String(row.threshold));
    if (!threshold.isFinite() || threshold.isNegative()) return null;
    const diligence = row.diligence === "cdd" || row.diligence === "edd"
      ? row.diligence
      : "identify";
    return {
      lineId: String(row.line_id ?? "primary"),
      dealKind: String(row.deal_kind),
      threshold,
      comparator: row.comparator === "gt" ? "gt" : "gte",
      diligence,
      cashOnly: row.cash_only === true,
    };
  } catch {
    return null;
  }
}

function hits(amount: Decimal, line: Decimal, comparator: "gte" | "gt"): boolean {
  return comparator === "gt" ? amount.gt(line) : amount.gte(line);
}

/**
 * What this one deal owes under the 2027 lines.
 *
 * A cash identification line applies only to cash, and not to a cheque
 * presented for cash. Cashing a cheque is not the cash transaction
 * Article 19(4) describes. The occasional due-diligence line still
 * applies to it.
 *
 * The desk's own identification number replaces only the cash
 * identification line. It can be tighter or looser. The transfer line
 * and the 10,000 line stay where the regulation put them.
 *
 * Deals are judged one at a time. A series of smaller deals is not
 * added up: the draft test for a linked transaction is not law.
 */
export function euAmlrDuty(input: {
  lines: EuIdLine[] | null;
  amountHome: Decimal;
  dealKind: string;
  cash: boolean;
  deskCashIdentify: Decimal | null;
}): EuDuty {
  if (!input.lines || input.lines.length === 0) {
    return { identify: true, cdd: true, failClosed: true };
  }
  const kind = idKindForDeal(input.dealKind);
  const cheque = input.dealKind === CHEQUE;
  let identify = false;
  let cdd = false;
  for (const line of input.lines) {
    if (line.dealKind !== "any" && line.dealKind !== kind) continue;
    if (line.cashOnly && (!input.cash || cheque)) continue;
    const threshold = line.lineId === "cash_identify" && input.deskCashIdentify
      ? input.deskCashIdentify
      : line.threshold;
    if (!hits(input.amountHome, threshold, line.comparator)) continue;
    if (line.diligence === "identify") identify = true;
    else cdd = true;
  }
  return { identify: identify || cdd, cdd, failClosed: false };
}

/** The date this pack applies from, or null when the column is absent. */
export async function loadEuAppliesFrom(
  client: QueryClient,
  packId: string,
): Promise<unknown> {
  if (packId !== EU_AMLR_PACK_ID) return null;
  try {
    const found = await client.query(
      `SELECT applies_from FROM jurisdiction_packs WHERE pack_id = $1`,
      [packId],
    );
    return found.rows[0]?.applies_from ?? null;
  } catch (error) {
    const code = pgCode(error);
    if (code === "42P01" || code === "42703") return null;
    throw error;
  }
}
