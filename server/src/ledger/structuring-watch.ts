/* The structuring watch is a list the server computes.
   Supervisor and the three STR roles may read it and acknowledge
   one customer. Each acknowledgement is a new row. It covers only
   the deals it saw. Update, delete, and truncate are refused.
   A teller is refused before any row is written.
   The role set is shared/str-role.js. Cash under the reporting
   line, same customer, not reversed, inside seven days, two or
   more, summing to the line or more. No line: an empty list.
   The deal read and the watch list use the latest row. */
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
  actorId: string | null;
  acknowledgedAt: string | null;
  dealIds: string[];
};

export type DealMark = {
  strTag: "STR" | null;
  strLink: string | null;
  structuring: boolean;
  structuringTotal: string | null;
  ackStr: boolean;
  ackActor: string | null;
  ackAt: string | null;
};

function sameIds(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const have = new Set(right);
  return left.every((id) => have.has(id));
}

function refsOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

async function loadWatch(client: pg.PoolClient, actor: LedgerActor): Promise<WatchItem[]> {
  const line = await resolveReportThreshold(client, actor.legalEntityId);
  if (!line) return [];
  const found = await client.query(
    `SELECT t.customer_id, t.transaction_id, t.posted_at,
            c.name AS customer_name, t.cash_in_home::text AS cash,
            a.actor_id, a.acknowledged_at, a.deal_ids
       FROM ledger_transactions t
       JOIN ledger_customers c ON c.customer_id = t.customer_id
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
       LEFT JOIN LATERAL (
         SELECT actor_id, acknowledged_at, deal_ids
           FROM ledger_structuring_acks
          WHERE tenant_id = t.tenant_id
            AND legal_entity_id = t.legal_entity_id
            AND branch_id = t.branch_id
            AND customer_id = t.customer_id
          ORDER BY acknowledged_at DESC, ack_id DESC
          LIMIT 1
       ) a ON true
      WHERE t.tenant_id = $1 AND t.legal_entity_id = $2 AND t.branch_id = $3
        AND t.posted_at >= now() - make_interval(days => $4::int)
        AND r.reversal_id IS NULL
        AND t.cash_in_home IS NOT NULL
        AND t.cash_in_home > 0`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, WINDOW_DAYS],
  );
  const grouped = new Map<string, {
    name: string;
    deals: { id: string; at: Date; cash: Decimal }[];
    actorId: string | null;
    ackAt: Date | null;
    coveredIds: string[] | null;
  }>();
  for (const row of found.rows) {
    const cash = new Decimal(String(row.cash));
    if (!cash.gt(0) || !cash.lt(line)) continue;
    const current = grouped.get(String(row.customer_id)) ?? {
      name: String(row.customer_name),
      deals: [],
      actorId: row.actor_id == null ? null : String(row.actor_id),
      ackAt: row.acknowledged_at ? new Date(row.acknowledged_at) : null,
      coveredIds: Array.isArray(row.deal_ids) ? row.deal_ids.map(String) : null,
    };
    current.deals.push({
      id: String(row.transaction_id),
      at: new Date(row.posted_at),
      cash,
    });
    grouped.set(String(row.customer_id), current);
  }
  const items: WatchItem[] = [];
  for (const [customerId, group] of grouped) {
    if (group.deals.length < 2) continue;
    const total = group.deals.reduce((sum, deal) => sum.add(deal.cash), new Decimal(0));
    if (total.lt(line)) continue;
    const dealIds = group.deals.map((deal) => deal.id);
    const newest = group.deals.reduce(
      (max, deal) => (deal.at > max ? deal.at : max),
      group.deals[0].at,
    );
    const acknowledged = group.ackAt != null
      && group.coveredIds != null
      && newest.getTime() <= group.ackAt.getTime()
      && sameIds(dealIds, group.coveredIds);
    items.push({
      customerId,
      name: group.name,
      count: group.deals.length,
      total: total.toFixed(2),
      acknowledged,
      actorId: acknowledged ? group.actorId : null,
      acknowledgedAt: acknowledged && group.ackAt ? group.ackAt.toISOString() : null,
      dealIds,
    });
  }
  return items;
}

/* One helper for the deal read and the watch list. The watch query
   runs only when this role may see the watch. STR_KEYS and WATCH_KEYS
   stay in shared/str-role.js. presentDeal drops what this role cannot see. */
export async function dealMarks(
  client: pg.PoolClient,
  actor: LedgerActor,
  rows: ReadonlyArray<{ transaction_ref: string; customer_id: string }>,
  role: string,
): Promise<{ marks: Map<string, DealMark>; items: WatchItem[] }> {
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
      ackStr: seen ? seen.acknowledged : false,
      ackActor: seen?.actorId ?? null,
      ackAt: seen?.acknowledgedAt ?? null,
    });
  }
  return { marks, items };
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
      const role = await authorizeLedgerActor(client, actor, "ledger:view");
      requireWatch(role);
      const { items } = await dealMarks(client, actor, [], role);
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
      const role = await authorizeLedgerActor(client, actor, "ledger:view");
      requireWatch(role);
      const { items } = await dealMarks(client, actor, [], role);
      const item = items.find((row) => row.customerId === customerId);
      if (!item) {
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "This customer is not on the watch.",
        );
      }
      await client.query(
        `INSERT INTO ledger_structuring_acks
           (tenant_id, legal_entity_id, branch_id, customer_id,
            actor_id, actor_role, deal_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          customerId,
          actor.userId,
          role,
          item.dealIds,
        ],
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
