/* The structuring watch is a list the server computes.
   Supervisor and the three STR roles may see it on a deal.
   A teller does not, and the watch query does not run for that role.
   The role set is shared/str-role.js. Cash under the reporting
   line, same customer, not reversed, inside seven days, two or
   more, summing to the line or more. No line: an empty list.
   ackStr stays false. An acknowledgement is not stored here. */
import { createRequire } from "node:module";
import Decimal from "decimal.js";
import type pg from "pg";
import type { LedgerActor } from "./service.js";
import { resolveReportThreshold } from "./thresholds.js";

const { canSeeStructuringWatch } = createRequire(import.meta.url)("../../../shared/str-role.js") as {
  canSeeStructuringWatch: (role: string) => boolean;
};

const WINDOW_DAYS = 7;

type WatchItem = {
  customerId: string;
  total: string;
};

export type DealMark = {
  strTag: "STR" | null;
  strLink: string | null;
  structuring: boolean;
  structuringTotal: string | null;
  ackStr: boolean;
};

function refsOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

async function loadWatch(client: pg.PoolClient, actor: LedgerActor): Promise<WatchItem[]> {
  const line = await resolveReportThreshold(client, actor.legalEntityId);
  if (!line) return [];
  const found = await client.query(
    `SELECT t.customer_id, t.cash_in_home::text AS cash
       FROM ledger_transactions t
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
      WHERE t.tenant_id = $1 AND t.legal_entity_id = $2 AND t.branch_id = $3
        AND t.posted_at >= now() - make_interval(days => $4::int)
        AND r.reversal_id IS NULL
        AND t.cash_in_home IS NOT NULL
        AND t.cash_in_home > 0`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, WINDOW_DAYS],
  );
  const grouped = new Map<string, Decimal[]>();
  for (const row of found.rows) {
    const cash = new Decimal(String(row.cash));
    if (!cash.gt(0) || !cash.lt(line)) continue;
    const current = grouped.get(String(row.customer_id)) ?? [];
    current.push(cash);
    grouped.set(String(row.customer_id), current);
  }
  const items: WatchItem[] = [];
  for (const [customerId, cash] of grouped) {
    if (cash.length < 2) continue;
    const total = cash.reduce((sum, amount) => sum.add(amount), new Decimal(0));
    if (total.lt(line)) continue;
    items.push({ customerId, total: total.toFixed(2) });
  }
  return items;
}

/* One helper for the deal read. The watch query runs only when this
   role may see the watch. STR_KEYS and WATCH_KEYS stay in
   shared/str-role.js. presentDeal drops what this role cannot see. */
export async function dealMarks(
  client: pg.PoolClient,
  actor: LedgerActor,
  rows: ReadonlyArray<{ transaction_ref: string; customer_id: string }>,
  role: string,
): Promise<{ marks: Map<string, DealMark> }> {
  const link = new Map<string, string>();
  if (rows.length) {
    const filings = await client.query(
      `SELECT filing_id, subject_transaction_ids
         FROM ledger_report_filings
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND upper(btrim(report_code)) = 'STR'`,
      [actor.tenantId, actor.legalEntityId],
    );
    for (const row of filings.rows) {
      for (const ref of refsOf(row.subject_transaction_ids)) link.set(ref, String(row.filing_id));
    }
  }
  const items = canSeeStructuringWatch(role) ? await loadWatch(client, actor) : [];
  const watch = new Map(items.map((item) => [item.customerId, item]));
  const marks = new Map<string, DealMark>();
  for (const row of rows) {
    const filingId = link.get(String(row.transaction_ref));
    const seen = watch.get(String(row.customer_id));
    marks.set(String(row.transaction_ref), {
      strTag: filingId ? "STR" : null,
      strLink: filingId ?? null,
      structuring: Boolean(seen),
      structuringTotal: seen ? seen.total : null,
      ackStr: false,
    });
  }
  return { marks };
}
