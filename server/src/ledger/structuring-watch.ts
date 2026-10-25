/* The structuring watch is a list the server computes.
   Supervisor and the three STR roles may read it and acknowledge
   one customer. A teller is refused before any row is written.
   The role set is shared/str-role.js. Cash under the reporting
   line, same customer, not reversed, inside seven days, two or
   more, summing to the line or more. No line: an empty list. */
import { createRequire } from "node:module";
import Decimal from "decimal.js";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";
import { resolveReportThreshold } from "./thresholds.js";

const { canSeeStructuringWatch } = createRequire(import.meta.url)("../../../shared/str-role.js") as {
  canSeeStructuringWatch: (role: string) => boolean;
};

const WINDOW_DAYS = 7;
const REFUSED = "You cannot open this list.";

export type WatchItem = {
  customerId: string;
  name: string;
  count: number;
  total: string;
  acknowledged: boolean;
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
    `SELECT t.customer_id, c.name AS customer_name, t.cash_in_home::text AS cash,
            (a.customer_id IS NOT NULL) AS acknowledged
       FROM ledger_transactions t
       JOIN ledger_customers c ON c.customer_id = t.customer_id
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
       LEFT JOIN ledger_structuring_acks a
         ON a.tenant_id = t.tenant_id AND a.legal_entity_id = t.legal_entity_id
        AND a.branch_id = t.branch_id AND a.customer_id = t.customer_id
      WHERE t.tenant_id = $1 AND t.legal_entity_id = $2 AND t.branch_id = $3
        AND t.posted_at >= now() - make_interval(days => $4::int)
        AND r.reversal_id IS NULL
        AND t.cash_in_home IS NOT NULL
        AND t.cash_in_home > 0`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, WINDOW_DAYS],
  );
  const grouped = new Map<string, { name: string; cash: Decimal[]; acknowledged: boolean }>();
  for (const row of found.rows) {
    const cash = new Decimal(String(row.cash));
    if (!cash.gt(0) || !cash.lt(line)) continue;
    const current = grouped.get(String(row.customer_id)) ?? {
      name: String(row.customer_name),
      cash: [],
      acknowledged: Boolean(row.acknowledged),
    };
    current.cash.push(cash);
    grouped.set(String(row.customer_id), current);
  }
  const items: WatchItem[] = [];
  for (const [customerId, group] of grouped) {
    if (group.cash.length < 2) continue;
    const total = group.cash.reduce((sum, amount) => sum.add(amount), new Decimal(0));
    if (total.lt(line)) continue;
    items.push({
      customerId,
      name: group.name,
      count: group.cash.length,
      total: total.toFixed(2),
      acknowledged: group.acknowledged,
    });
  }
  return items;
}

export async function dealMarks(
  client: pg.PoolClient,
  actor: LedgerActor,
  rows: ReadonlyArray<{ transaction_ref: string; customer_id: string }>,
): Promise<Map<string, DealMark>> {
  const filings = await client.query(
    `SELECT filing_id, subject_transaction_ids
       FROM ledger_report_filings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND upper(btrim(report_code)) = 'STR'`,
    [actor.tenantId, actor.legalEntityId],
  );
  const link = new Map<string, string>();
  for (const row of filings.rows) {
    for (const ref of refsOf(row.subject_transaction_ids)) link.set(ref, String(row.filing_id));
  }
  const watch = new Map((await loadWatch(client, actor)).map((item) => [item.customerId, item]));
  const marks = new Map<string, DealMark>();
  for (const row of rows) {
    const filingId = link.get(String(row.transaction_ref));
    const seen = watch.get(String(row.customer_id));
    marks.set(String(row.transaction_ref), {
      strTag: filingId ? "STR" : null,
      strLink: filingId ?? null,
      structuring: Boolean(seen),
      structuringTotal: seen ? seen.total : null,
      ackStr: seen ? seen.acknowledged : false,
    });
  }
  return marks;
}

function requireWatch(role: string) {
  if (!canSeeStructuringWatch(role)) throw new LedgerError("AUTHORIZATION_DENIED", REFUSED);
}

export class StructuringWatchService {
  constructor(private readonly pool: pg.Pool) {}

  async list(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      requireWatch(await authorizeLedgerActor(client, actor, "ledger:view"));
      const items = await loadWatch(client, actor);
      await client.query("COMMIT");
      return { items };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async acknowledge(actor: LedgerActor, customerId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      requireWatch(await authorizeLedgerActor(client, actor, "ledger:view"));
      await client.query(
        `INSERT INTO ledger_structuring_acks
           (tenant_id, legal_entity_id, branch_id, customer_id, actor_id, acknowledged_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id, legal_entity_id, branch_id, customer_id)
         DO UPDATE SET actor_id = EXCLUDED.actor_id, acknowledged_at = now()`,
        [actor.tenantId, actor.legalEntityId, actor.branchId, customerId, actor.userId],
      );
      await client.query("COMMIT");
      return { customerId, acknowledged: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
