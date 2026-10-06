/* ============================================================
   Canada, where the pack actually splits.

   pack-ca-v1 stores one identification number and copies it onto
   every kind of deal. The regulation does not. Foreign exchange and
   money orders are $3,000. A remittance, an electronic funds
   transfer, and virtual currency are $1,000. PCMLTFR s.95, read
   2026-10-06.

   A pack is "split" when its lines are not all that one number, or
   when it names a money-order line of its own. Only a split pack
   takes the path in this file. Every other country pack, including
   pack-ca-v1, keeps the single-column gate it already had.

   Two further rules live here because they are the same pack:

     s.84. Identity is required when a large cash report is required,
     including one that exists only because several smaller receipts
     in the same 24 hours add up. The gate can only refuse the deal
     in front of it. It cannot unwind one that already posted.

     s.36(i) with s.1(2). At the foreign-exchange line the ticket
     needs the person's name, address, occupation, and date of birth,
     not only a numbered identity document. An expired document still
     blocks the deal. That is a product choice, and s.155 is looser.

   Money is Decimal. A float never enters this file.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { idKindForDeal } from "./compliance-gate.js";
import type { JurisdictionPack } from "./jurisdiction.js";

export type IdentificationDeal = {
  kind: string;
  cash: boolean;
  /** Cash the desk received. A payout and a cashed cheque are false:
      a large cash report is cash that came in. */
  cashIn?: boolean;
  customerId?: string | null;
  /** The person the customer is acting for, when one was named. */
  onBehalfOf?: string | null;
  /** The person a remittance is for, when this deal names one. */
  beneficiaryName?: string | null;
};

export type GateRefusal = {
  code: "COMPLIANCE_BLOCKED" | "FX_TICKET";
  message: string;
};

export type CountryGate =
  | { split: false }
  | { split: true; refusal: GateRefusal | null };

const ID_BLOCKED: GateRefusal = {
  code: "COMPLIANCE_BLOCKED",
  message: "Authoritative compliance policy blocked posting.",
};

const NO_LINE: GateRefusal = {
  code: "COMPLIANCE_BLOCKED",
  message:
    "This desk has no identification threshold, so it cannot tell whether this customer needs to be identified. Set one in Settings, or ask your jurisdiction pack to be installed.",
};

const TICKET: GateRefusal = {
  code: "FX_TICKET",
  message:
    "A foreign exchange at or above the identification line needs the customer's name, address, occupation, and date of birth on the ticket.",
};

type IdRow = {
  dealKind: string;
  amount: Decimal | null;
  comparator: string;
};

/* Cheque clearance and cheque return are not deals a customer did.
   The list lives in cheques.ts as SETTLEMENT_DEAL_KINDS. It is repeated
   here, rather than imported, because that file imports the posting
   service and this file is imported by the posting service. A test
   asserts the two strings still match. */
export const NOT_A_DEAL_SQL = "'cheque_clearing','cheque_return'";

const AXES = ["conductor", "on_behalf_of", "beneficiary"] as const;
type Axis = (typeof AXES)[number];

function positive(value: unknown): Decimal | null {
  if (value == null || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

/** Zero is a real line: every deal. Null is "this kind has no row". */
function lineAmount(value: unknown): Decimal | null {
  if (value == null || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    if (!parsed.isFinite() || parsed.isNegative()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hits(amount: Decimal, line: Decimal, comparator: string): boolean {
  return comparator === "gt" ? amount.gt(line) : amount.gte(line);
}

function personKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/* Money orders stay on their own row when the pack has one. The
   baseline maps them to remittance, and that mapping is left alone:
   a missing money-order row there would otherwise fail closed. */
function kindKey(dealKind: string): string {
  if (dealKind === "money_order") return "money_order";
  return idKindForDeal(dealKind);
}

async function idRows(client: pg.PoolClient, packId: string): Promise<IdRow[]> {
  const found = await client.query(
    `SELECT deal_kind, threshold, comparator
       FROM jurisdiction_id_thresholds
      WHERE pack_id = $1`,
    [packId],
  );
  return found.rows.map((row) => ({
    dealKind: String(row.deal_kind),
    amount: lineAmount(row.threshold),
    comparator: String(row.comparator || "gte"),
  }));
}

function isSplit(rows: IdRow[], packLine: Decimal | null): boolean {
  if (rows.some((row) => row.dealKind === "money_order")) return true;
  if (!packLine) return false;
  return rows.some((row) => row.amount !== null && !row.amount.eq(packLine));
}

/* The desk's own identification number. NULL means follow the pack.
   On a split pack that number is the foreign-exchange line the
   settings screen edits. It may replace the $3,000 foreign-exchange
   and money-order lines, including a looser choice, which the screen
   already labels. It must not lift a lower legal line: a desk that
   saved 2,500 when every Canada line was 3,000 does not get to
   identify a $1,000 remittance at 2,500. A lower number tightens
   every line. */
function effectiveLine(
  key: string,
  packRow: IdRow | undefined,
  desk: Decimal | null,
): { amount: Decimal; comparator: string } | null {
  if (!packRow || packRow.amount === null) {
    if (desk && (key === "fx" || key === "money_order")) {
      return { amount: desk, comparator: "gte" };
    }
    return null;
  }
  if (!desk) return { amount: packRow.amount, comparator: packRow.comparator };
  if (key === "fx" || key === "money_order") {
    return { amount: desk, comparator: "gte" };
  }
  const amount = desk.lt(packRow.amount) ? desk : packRow.amount;
  return { amount, comparator: packRow.comparator };
}

async function deskMoney(
  client: pg.PoolClient,
  legalEntityId: string,
  column: "id_threshold" | "report_threshold",
): Promise<Decimal | null> {
  const found = await client.query(
    `SELECT ${column} AS amount FROM legal_entities WHERE id = $1`,
    [legalEntityId],
  );
  return positive(found.rows[0]?.amount);
}

type LargeCashRule = {
  trigger: Decimal;
  aggregateAll: boolean;
  axes: Axis[];
};

async function largeCashRule(
  client: pg.PoolClient,
  packId: string,
): Promise<LargeCashRule | null> {
  const found = await client.query(
    `SELECT trigger_threshold, aggregate_all_amounts, aggregation_axes
       FROM jurisdiction_reports
      WHERE pack_id = $1 AND kind = 'large_cash'
      ORDER BY version DESC
      LIMIT 1`,
    [packId],
  );
  const row = found.rows[0];
  const trigger = positive(row?.trigger_threshold);
  if (!row || !trigger) return null;
  const raw = Array.isArray(row.aggregation_axes) ? row.aggregation_axes : [];
  const axes = raw.filter((item): item is Axis =>
    AXES.includes(item as Axis),
  );
  return {
    trigger,
    aggregateAll: row.aggregate_all_amounts === true,
    axes: axes.length ? axes : ["conductor", "on_behalf_of", "beneficiary"],
  };
}

/* Midnight in the branch's zone, then 24 consecutive hours. The law
   is 24 consecutive hours, so the end is that instant plus 24 hours
   and not "the same clock time tomorrow", which is 23 or 25 hours
   across a daylight-saving change.

   The browser lets an owner move the anchor off midnight
   (settings.aggWindowStart). That choice is not on the server. The
   gate uses midnight, which is the product default. A desk that
   moves the anchor is a known gap: docs/CANADA_PACK.md. */
export function staticWindow(
  at: Date,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedMidnight(at, timeZone);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = pick("hour");
  /* A few engines report midnight as hour 24. */
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    hour,
    pick("minute"),
    pick("second"),
  );
  return asUtc - at.getTime();
}

function zonedMidnight(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const guess = Date.UTC(pick("year"), pick("month") - 1, pick("day"), 0, 0, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  let start = guess - offset;
  const corrected = zoneOffsetMs(new Date(start), timeZone);
  if (corrected !== offset) start = guess - corrected;
  return new Date(start);
}

async function branchZone(client: pg.PoolClient, branchId: string): Promise<string> {
  try {
    const found = await client.query(
      "SELECT timezone FROM branches WHERE id = $1",
      [branchId],
    );
    const zone = String(found.rows[0]?.timezone ?? "").trim();
    if (zone) return zone;
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  return "America/Toronto";
}

/* Cash the desk received, in home currency, inside the window, for
   one axis only. Axes are not added together: the same notes can be
   a conductor report and, separately, an on-behalf-of report, and
   mixing the two people into one total is the mistake the guidance
   warns about.

   cash_in_home is the recorded figure. An older exchange that never
   wrote it falls back to the input only when the customer paid in
   the home currency, which needs no conversion. A foreign-currency
   receipt with no home figure is left out rather than priced here.
   A cheque is not that fallback: cashing one is not cash received. */
async function cashReceived(
  client: pg.PoolClient,
  legalEntityId: string,
  window: { start: Date; end: Date },
  axis: Axis,
  key: string,
): Promise<Decimal> {
  /* DISTINCT ON the transaction so a second obligation row cannot
     add the same cash twice. The beneficiary axis still needs the
     join, because that name lives on the obligation. */
  const found = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT DISTINCT ON (t.transaction_id)
                CASE
                  WHEN t.cash_in_home IS NOT NULL THEN t.cash_in_home
                  WHEN t.deal_kind = 'exchange'
                   AND upper(btrim(t.from_currency::text))
                       = upper(btrim(COALESCE(t.home_currency::text, '')))
                    THEN t.input_amount
                  ELSE NULL
                END AS amount
           FROM ledger_transactions t
           LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
           LEFT JOIN ledger_obligations o ON o.transaction_id = t.transaction_id
          WHERE t.legal_entity_id = $1
            AND t.posted_at >= $2
            AND t.posted_at < $3
            AND r.reversal_id IS NULL
            AND t.deal_kind NOT IN (${NOT_A_DEAL_SQL})
            AND (
              ($4 = 'conductor' AND t.customer_id = $5)
              OR ($4 = 'on_behalf_of' AND lower(btrim(COALESCE(t.third_party_name, ''))) = $5)
              OR ($4 = 'beneficiary' AND lower(btrim(COALESCE(o.beneficiary_name, ''))) = $5)
            )
          ORDER BY t.transaction_id
       ) AS received
      WHERE amount IS NOT NULL AND amount > 0`,
    [legalEntityId, window.start, window.end, axis, key],
  );
  return new Decimal(String(found.rows[0]?.total ?? "0"));
}

async function ticketComplete(
  client: pg.PoolClient,
  legalEntityId: string,
  customerId: string,
): Promise<boolean> {
  const found = await client.query(
    `SELECT c.name AS customer_name,
            d.display_name, d.address_line, d.occupation, d.date_of_birth
       FROM ledger_customers c
       LEFT JOIN desk_clients d ON d.client_id = c.client_id
      WHERE c.customer_id = $1 AND c.legal_entity_id = $2`,
    [customerId, legalEntityId],
  );
  const row = found.rows[0];
  if (!row) return false;
  const name = String(row.display_name || row.customer_name || "").trim();
  const address = String(row.address_line || "").trim();
  const occupation = String(row.occupation || "").trim();
  const born = row.date_of_birth;
  return Boolean(name && address && occupation && born);
}

/**
 * The country-pack half of the identification gate.
 * `split: false` means the caller keeps the single-column rule.
 */
export async function countryIdentification(
  client: pg.PoolClient,
  args: {
    legalEntityId: string;
    branchId: string;
    pack: JurisdictionPack;
    amountHome: Decimal;
    verified: boolean;
    deal: IdentificationDeal;
  },
): Promise<CountryGate> {
  const rows = await idRows(client, args.pack.packId);
  const packLine = positive(args.pack.idThreshold);
  if (!isSplit(rows, packLine)) return { split: false };

  const key = kindKey(args.deal.kind);
  const row =
    rows.find((item) => item.dealKind === key) ??
    (key === "money_order"
      ? rows.find((item) => item.dealKind === "remittance")
      : undefined);
  const desk = await deskMoney(client, args.legalEntityId, "id_threshold");
  const line = effectiveLine(key, row, desk);

  if (!args.verified) {
    if (!line) return { split: true, refusal: NO_LINE };
    if (hits(args.amountHome, line.amount, line.comparator)) {
      return { split: true, refusal: ID_BLOCKED };
    }
    /* s.84. A receipt under the identification line can still be part
       of a large cash report, and identity is required then too.
       Only when this pack says the window includes every amount.
       Each axis is its own total. */
    if (args.deal.cashIn) {
      const rule = await largeCashRule(client, args.pack.packId);
      if (rule?.aggregateAll) {
        const deskReport = await deskMoney(
          client,
          args.legalEntityId,
          "report_threshold",
        );
        const trigger =
          deskReport && deskReport.lt(rule.trigger) ? deskReport : rule.trigger;
        const zone = await branchZone(client, args.branchId);
        const window = staticWindow(new Date(), zone);
        const keys: Partial<Record<Axis, string | null>> = {
          conductor: args.deal.customerId?.trim() || null,
          on_behalf_of: personKey(args.deal.onBehalfOf),
          beneficiary: personKey(args.deal.beneficiaryName),
        };
        for (const axis of rule.axes) {
          const who = keys[axis];
          if (!who) continue;
          const prior = await cashReceived(
            client,
            args.legalEntityId,
            window,
            axis,
            who,
          );
          if (prior.add(args.amountHome).gte(trigger)) {
            return { split: true, refusal: ID_BLOCKED };
          }
        }
      }
    }
  }

  /* The ticket fields are a record, not the identity document. A
     customer who is already verified still needs them on the
     foreign-exchange ticket once the deal is at the line. Cheque
     cashing is a different ticket and is not this check. */
  if (args.deal.kind === "exchange") {
    const fx = effectiveLine(
      "fx",
      rows.find((item) => item.dealKind === "fx"),
      desk,
    );
    if (fx && hits(args.amountHome, fx.amount, fx.comparator)) {
      const customerId = args.deal.customerId?.trim();
      const complete =
        !!customerId &&
        (await ticketComplete(client, args.legalEntityId, customerId));
      if (!complete) return { split: true, refusal: TICKET };
    }
  }

  return { split: true, refusal: null };
}

/**
 * Beneficiary name and address, s.36(c.1) to (f).
 * Required only on a split pack, at or above that pack's remittance
 * line. A looser desk number cannot push the line up. Under the line
 * the fields may be omitted, and they are still stored when present.
 * Returns the refusal message, or null when the record is acceptable.
 */
export async function beneficiaryRecordGap(
  client: pg.PoolClient,
  pack: JurisdictionPack,
  amountHome: Decimal,
  name: string | null | undefined,
  address: string | null | undefined,
): Promise<string | null> {
  const rows = await idRows(client, pack.packId);
  if (!isSplit(rows, positive(pack.idThreshold))) return null;
  const remittance = rows.find((row) => row.dealKind === "remittance");
  if (!remittance || remittance.amount === null) return null;
  if (!hits(amountHome, remittance.amount, remittance.comparator)) return null;
  if (String(name ?? "").trim() && String(address ?? "").trim()) return null;
  return "A transfer at or above the identification line needs the beneficiary's name and address on the record.";
}

/* "Within N days after the day" starts counting the next day.
   Working days here are Monday to Friday. FINTRAC also drops
   statutory holidays. This does not: there is no holiday calendar
   in the pack, and inventing one would be a guess. docs/CANADA_PACK.md. */
export function deadlineDate(
  day: Date,
  value: number,
  unit: "calendar_days" | "business_days",
): Date {
  const cursor = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  );
  if (unit === "calendar_days") {
    cursor.setUTCDate(cursor.getUTCDate() + value);
    return cursor;
  }
  let left = value;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return cursor;
}

export function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}
