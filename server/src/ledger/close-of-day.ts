/* The close of day a teller signs, kept on the server.

   The phone used to write the sheet into localStorage and print whatever
   the browser had added up. Another till never saw it, a reload lost the
   only copy, and the drawer total was a sum the screen invented. This
   file is the copy that exists: one row per till session, the figures
   taken from the ledger at the moment of the signature, an audit row,
   and a PDF rendered from that snapshot.

   Seeing the earnings and saving the sheet are the same permission as
   closing the till (`till:close`). A teller does not have it. The route
   refuses them; it does not send the numbers with a flag the screen
   might forget to read. */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { loadBranchTimeZone } from "./branch-zone.js";
import { readDateOnly, signOffWindow } from "./business-date.js";
import { now as clockNow } from "./clock.js";
import { SETTLEMENT_DEAL_KINDS_SQL } from "./cheques.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { readDeskThresholds } from "./thresholds.js";
import { LedgerError, type LedgerActor } from "./service.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type LineComparator = "gte" | "gt";

/** A deal is on the reporting line.
 *
 *  Canada counts 10,000.00. `>` would leave that deal off the sheet and
 *  the 10,000.01 deal on it, which is a different rule. */
export function meetsReportingLine(
  amount: Decimal.Value,
  line: Decimal.Value,
  comparator: LineComparator = "gte",
): boolean {
  const value = new Decimal(amount);
  const threshold = new Decimal(line);
  return comparator === "gt" ? value.gt(threshold) : value.gte(threshold);
}

/** A calendar date, not an instant. "Oct 12, 2026". */
export function formatCalendarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${MONTHS[month - 1]} ${day}, ${Number(match[1])}`;
}

/** 12-hour clock in a named zone. "2:30 PM". */
export function formatBranchTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(pick("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
  const suffix = hour >= 12 ? "PM" : "AM";
  let shown = hour % 12;
  if (shown === 0) shown = 12;
  return `${shown}:${String(minute).padStart(2, "0")} ${suffix}`;
}

const money = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2).toFixed(2);

export type DrawerLine = {
  currency: string;
  counted: string | null;
  expected: string | null;
  variance: string | null;
};

export type VolumeLine = { currency: string; amount: string };

export type CloseOfDaySnapshot = {
  shopName: string;
  businessDate: string;
  timeZone: string;
  from: string;
  to: string;
  signedAt: string | null;
  signedBy: string | null;
  tillId: string;
  sessionId: string;
  notCounted: boolean;
  homeCurrency: string;
  posted: number;
  reversed: number;
  volumeHome: string | null;
  volumeByCurrency: VolumeLine[];
  feesHome: string | null;
  realizedPnlHome: string | null;
  earningsHome: string | null;
  drawerHome: string | null;
  drawerCurrencies: DrawerLine[];
  reportingLine: string | null;
  reportingCurrency: string;
  reportingComparator: LineComparator;
  singleDeals: number | null;
  lctrCustomers: number | null;
  clientsMissingId: number;
};

export type StoredSignoff = {
  signoffId: string;
  idempotencyKey: string;
  notCounted: boolean;
  signedAt: string;
  signedBy: string;
  snapshot: CloseOfDaySnapshot;
};

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Wrap so a phone-width viewer and an A4 page show the whole line.
 *  Helvetica at 11pt fits about 78 characters inside a 54pt margin. */
function wrap(text: string, width = 72): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function wholeAmount(amount: string): string {
  return amount.endsWith(".00") ? amount.slice(0, -3) : amount;
}

/** The lines of the sheet, in order. Teller and Owner are separate
 *  lines so a narrow page cannot put them on one row and clip one. */
export function signoffLines(snapshot: CloseOfDaySnapshot): string[] {
  const home = snapshot.homeCurrency;
  const date = formatCalendarDate(snapshot.businessDate);
  const time = snapshot.signedAt
    ? formatBranchTime(new Date(snapshot.signedAt), snapshot.timeZone)
    : "";
  const line = snapshot.reportingLine
    ? `${wholeAmount(snapshot.reportingLine)} ${snapshot.reportingCurrency}`
    : "";
  const amount = (value: string | null) => (value == null ? "Not loaded" : `${value} ${home}`);
  const lines = [
    snapshot.shopName || "Shop",
    "End of day",
    [date, time].filter(Boolean).join(", "),
    `Deals: ${snapshot.posted}`,
    `Taken in: ${amount(snapshot.volumeHome)}`,
    ...snapshot.volumeByCurrency.map((row) => `${row.currency}: ${row.amount} ${row.currency}`),
    `Earned: ${amount(snapshot.earningsHome)}`,
    snapshot.realizedPnlHome != null ? "Fees + margin" : (snapshot.feesHome != null ? "Fees" : ""),
    snapshot.notCounted ? "In the drawer: Not counted" : `In the drawer: ${amount(snapshot.drawerHome)}`,
    line
      ? `Single deals of ${line} or more: ${snapshot.singleDeals ?? "Not loaded"}`
      : "Single deals: no reporting line",
    line
      ? `LCTR, 24-hour total: ${snapshot.lctrCustomers ?? "Not loaded"}`
      : "",
    `Clients missing ID: ${snapshot.clientsMissingId}`,
    "",
    "Teller",
    "________________________________",
    "",
    "Owner",
    "________________________________",
  ].filter((row) => row !== "");
  return lines.flatMap((row) => wrap(row));
}

/** A one-page A4 PDF. Built-in Helvetica, no embedded font, so the
 *  bytes are the text and nothing else is required to print them. */
export function renderSignoffPdf(snapshot: CloseOfDaySnapshot): Buffer {
  const contentLines = signoffLines(snapshot);
  const commands = ["BT", "/F1 11 Tf", "16 TL", "54 788 Td"];
  for (const line of contentLines) {
    commands.push(`(${pdfEscape(line)}) Tj`, "T*");
  }
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

type CashRow = {
  customer_id: string | null;
  cash_in_home: string | null;
  from_currency: string | null;
  input_amount: string | null;
};

async function buildSnapshot(
  client: pg.PoolClient,
  actor: LedgerActor,
  session: { session_id: string; business_date: unknown; closed_at: Date | null },
  signedAt: string | null,
  signedBy: string | null,
): Promise<CloseOfDaySnapshot> {
  const timeZone = await loadBranchTimeZone(client, actor);
  const businessDate = readDateOnly(session.business_date);
  const window = signOffWindow({
    businessDate,
    timeZone,
    closedAt: session.closed_at,
    now: clockNow(),
  });
  const pack = await resolvePack(client, actor.legalEntityId);
  const thresholds = await readDeskThresholds(client, actor.legalEntityId, pack);
  const home = pack.homeCurrency;
  const report = await client.query(
    `SELECT trigger_threshold, comparator
       FROM jurisdiction_reports
      WHERE pack_id = $1 AND kind = 'large_cash'
      ORDER BY version DESC
      LIMIT 1`,
    [pack.packId],
  );
  const comparator: LineComparator = report.rows[0]?.comparator === "gt" ? "gt" : "gte";
  const effective = thresholds.reportThreshold.effective;
  const reportingLine = effective == null ? null : money(effective);

  const shop = await client.query(
    "SELECT name FROM legal_entities WHERE id = $1",
    [actor.legalEntityId],
  );
  const totals = await client.query(
    `WITH live AS (
       SELECT t.*,
              COALESCE(t.fee_amount, t.fee_cad) AS fee_home,
              CASE WHEN t.from_currency = $6 THEN t.input_amount
                   WHEN t.to_currency = $6 THEN t.output_amount
                   ELSE NULL END AS volume_home
         FROM ledger_transactions t
         LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
        WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
          AND t.workspace_id=$4 AND t.till_id=$5
          AND r.reversal_id IS NULL
          AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
          AND t.posted_at >= $7 AND t.posted_at < $8
     )
     SELECT
       (SELECT count(*)::int FROM live) AS posted,
       (SELECT count(*)::int FROM ledger_transactions t
          JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
         WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
           AND t.workspace_id=$4 AND t.till_id=$5
           AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
           AND t.posted_at >= $7 AND t.posted_at < $8) AS reversed,
       (SELECT sum(volume_home) FROM live) AS volume_home,
       (SELECT sum(fee_home) FROM live) AS fees_home,
       (SELECT sum(realized_pnl_home) FROM live WHERE realized_pnl_home IS NOT NULL) AS realized_home`,
    [...scope(actor), home, window.from, window.to],
  );
  const cash = await client.query(
    `SELECT t.customer_id,
            CASE
              WHEN t.cash_in_home IS NOT NULL THEN t.cash_in_home
              WHEN t.deal_kind = 'exchange'
               AND upper(btrim(t.from_currency::text)) = upper(btrim(COALESCE(t.home_currency::text, $6)))
                THEN t.input_amount
              ELSE NULL
            END AS cash_in_home,
            upper(btrim(t.from_currency::text)) AS from_currency,
            t.input_amount
       FROM ledger_transactions t
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
      WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
        AND t.workspace_id=$4 AND t.till_id=$5
        AND r.reversal_id IS NULL
        AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
        AND t.posted_at >= $7 AND t.posted_at < $8`,
    [...scope(actor), home, window.from, window.to],
  );
  const missing = await client.query(
    `SELECT count(DISTINCT t.customer_id)::int AS n
       FROM ledger_transactions t
       JOIN ledger_customers c
         ON c.customer_id = t.customer_id AND c.legal_entity_id = t.legal_entity_id
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
      WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
        AND t.workspace_id=$4 AND t.till_id=$5
        AND r.reversal_id IS NULL
        AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
        AND t.posted_at >= $6 AND t.posted_at < $7
        AND c.id_status IS DISTINCT FROM 'verified'`,
    [...scope(actor), window.from, window.to],
  );
  const balances = await client.query(
    `SELECT currency, available_amount
       FROM ledger_till_balances
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        AND workspace_id=$4 AND till_id=$5`,
    scope(actor),
  );
  const counts = await client.query(
    `SELECT DISTINCT ON (c.currency)
            c.currency, c.counted_amount, c.expected_amount, c.variance_amount
       FROM ledger_till_count_batches b
       JOIN ledger_till_counts c ON c.batch_id = b.batch_id
      WHERE b.session_id = $1
      ORDER BY c.currency, b.counted_at DESC, c.count_id DESC`,
    [session.session_id],
  );
  const rates = await client.query(
    `SELECT DISTINCT ON (currency) currency, units_per_cad
       FROM ledger_rates
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
      ORDER BY currency, workspace_id`,
    [actor.tenantId, actor.legalEntityId, actor.branchId],
  );

  const row = totals.rows[0];
  const fees = row.fees_home == null ? null : money(row.fees_home);
  const realized = row.realized_home == null ? null : money(row.realized_home);
  const earnings =
    fees === null && realized === null ? null : money(new Decimal(fees ?? 0).add(realized ?? 0));

  const byCurrency = new Map<string, Decimal>();
  const byCustomer = new Map<string, Decimal>();
  let singleDeals = 0;
  for (const item of cash.rows as CashRow[]) {
    const currency = String(item.from_currency || "").trim();
    if (currency && item.input_amount != null) {
      byCurrency.set(currency, (byCurrency.get(currency) ?? new Decimal(0)).add(item.input_amount));
    }
    if (item.cash_in_home == null || !reportingLine) continue;
    const received = new Decimal(item.cash_in_home);
    if (meetsReportingLine(received, reportingLine, comparator)) singleDeals += 1;
    const customer = item.customer_id == null ? "" : String(item.customer_id);
    if (!customer) continue;
    byCustomer.set(customer, (byCustomer.get(customer) ?? new Decimal(0)).add(received));
  }
  let lctrCustomers = 0;
  if (reportingLine) {
    for (const total of byCustomer.values()) {
      if (meetsReportingLine(total, reportingLine, comparator)) lctrCustomers += 1;
    }
  }

  const counted = new Map<string, { counted: string; expected: string | null; variance: string | null }>();
  for (const item of counts.rows) {
    counted.set(String(item.currency).trim(), {
      counted: money(item.counted_amount),
      expected: item.expected_amount == null ? null : money(item.expected_amount),
      variance: item.variance_amount == null ? null : money(item.variance_amount),
    });
  }
  const unitHome = new Map<string, Decimal>();
  if (home === "CAD") {
    for (const item of rates.rows) {
      const perCad = new Decimal(item.units_per_cad);
      if (perCad.gt(0)) unitHome.set(String(item.currency).trim(), new Decimal(1).div(perCad));
    }
  }
  const held = balances.rows
    .map((item) => ({ currency: String(item.currency).trim(), amount: new Decimal(item.available_amount) }))
    .filter((item) => item.amount.abs().gte("0.005"));
  /* No count batch means nobody has counted, even when the drawer
     is empty. An empty counted drawer is 0, not "not counted". */
  const notCounted = held.some((item) => !counted.has(item.currency)) || counted.size === 0;
  let drawerHome: string | null = null;
  if (!notCounted) {
    if (!held.length) drawerHome = money(0);
    else {
      let sum = new Decimal(0);
      let priced = true;
      for (const item of held) {
        const count = counted.get(item.currency);
        if (!count) { priced = false; break; }
        if (item.currency === home) {
          sum = sum.add(count.counted);
          continue;
        }
        const unit = unitHome.get(item.currency);
        if (!unit) { priced = false; break; }
        sum = sum.add(new Decimal(count.counted).mul(unit));
      }
      drawerHome = priced ? money(sum) : null;
    }
  }
  const drawerCurrencies: DrawerLine[] = [...counted.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, count]) => ({
      currency,
      counted: count.counted,
      expected: count.expected,
      variance: count.variance,
    }));

  return {
    shopName: String(shop.rows[0]?.name || "").trim(),
    businessDate,
    timeZone,
    from: window.from,
    to: window.to,
    signedAt,
    signedBy,
    tillId: actor.tillId,
    sessionId: String(session.session_id),
    notCounted,
    homeCurrency: home,
    posted: Number(row.posted),
    reversed: Number(row.reversed),
    volumeHome: row.volume_home == null ? null : money(row.volume_home),
    volumeByCurrency: [...byCurrency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => ({ currency, amount: money(amount) })),
    feesHome: fees,
    realizedPnlHome: realized,
    earningsHome: earnings,
    drawerHome,
    drawerCurrencies,
    reportingLine,
    reportingCurrency: thresholds.currency || home,
    reportingComparator: comparator,
    singleDeals: reportingLine == null ? null : singleDeals,
    lctrCustomers: reportingLine == null ? null : lctrCustomers,
    clientsMissingId: Number(missing.rows[0]?.n ?? 0),
  };
}

function storedFrom(row: Record<string, unknown>): StoredSignoff {
  return {
    signoffId: String(row.signoff_id),
    idempotencyKey: String(row.idempotency_key),
    notCounted: row.not_counted === true,
    signedAt: new Date(row.signed_at as string).toISOString(),
    signedBy: String(row.signed_by),
    snapshot: row.snapshot as CloseOfDaySnapshot,
  };
}

export class CloseOfDayService {
  constructor(private readonly pool: pg.Pool) {}

  async read(actor: LedgerActor): Promise<{ signoff: StoredSignoff | null; preview: CloseOfDaySnapshot | null }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "till:close");
      const session = await this.latestSession(client, actor);
      if (!session) {
        await client.query("COMMIT");
        return { signoff: null, preview: null };
      }
      const existing = await this.signoffForSession(client, actor, String(session.session_id));
      const preview = existing
        ? null
        : await buildSnapshot(client, actor, session, null, null);
      await client.query("COMMIT");
      return { signoff: existing, preview };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async sign(actor: LedgerActor, idempotencyKey: string, notCounted: boolean): Promise<StoredSignoff & { replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "till:close");
      const session = await this.latestSession(client, actor);
      if (!session) {
        throw new LedgerError("TILL_NOT_OPEN", "Open the till before signing off the day.");
      }
      const sessionId = String(session.session_id);
      const byKey = await client.query(
        `SELECT * FROM ledger_till_signoffs
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6
          FOR UPDATE`,
        [...scope(actor), idempotencyKey],
      );
      if (byKey.rowCount) {
        const stored = storedFrom(byKey.rows[0]);
        if (stored.notCounted !== notCounted) {
          throw new LedgerError(
            "IDEMPOTENCY_CONFLICT",
            "This form was already sent with a different count. Nothing else was saved.",
          );
        }
        await client.query("COMMIT");
        return { ...stored, replayed: true };
      }
      const existing = await this.signoffForSession(client, actor, sessionId);
      if (existing) {
        throw new LedgerError(
          "TILL_ALREADY_SIGNED",
          "This till session is already signed off.",
        );
      }
      const signedAt = clockNow().toISOString();
      const snapshot = await buildSnapshot(client, actor, session, signedAt, actor.userId);
      if (snapshot.notCounted !== notCounted) {
        throw new LedgerError(
          snapshot.notCounted ? "DRAWER_NOT_COUNTED" : "DRAWER_ALREADY_COUNTED",
          snapshot.notCounted
            ? "The drawer is not counted. Say so, or count it, before saving."
            : "The drawer is already counted. Save it as counted.",
        );
      }
      const signoffId = randomUUID();
      const pdf = renderSignoffPdf(snapshot);
      /* A unique violation aborts the transaction. The savepoint is what
         lets the loser of the race read the winner instead of failing
         the whole request as a 500. */
      await client.query("SAVEPOINT signoff_insert");
      try {
        await client.query(
          `INSERT INTO ledger_till_signoffs
            (signoff_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
             session_id, idempotency_key, not_counted, snapshot, pdf, signed_by, signed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            signoffId,
            ...scope(actor),
            sessionId,
            idempotencyKey,
            notCounted,
            JSON.stringify(snapshot),
            pdf,
            actor.userId,
            signedAt,
          ],
        );
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError.code !== "23505") throw error;
        await client.query("ROLLBACK TO SAVEPOINT signoff_insert");
        /* The unique index that fired may be the key or the session.
           Read the key first: a matching key is a replay, a different
           key on this session is a second signature. */
        const raced = await client.query(
          `SELECT * FROM ledger_till_signoffs
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6`,
          [...scope(actor), idempotencyKey],
        );
        if (raced.rowCount) {
          const stored = storedFrom(raced.rows[0]);
          if (stored.notCounted !== notCounted) {
            throw new LedgerError(
              "IDEMPOTENCY_CONFLICT",
              "This form was already sent with a different count. Nothing else was saved.",
            );
          }
          await client.query("COMMIT");
          return { ...stored, replayed: true };
        }
        throw new LedgerError("TILL_ALREADY_SIGNED", "This till session is already signed off.");
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id, tenant_id, legal_entity_id, branch_id, workspace_id, actor_id,
           action, target_id, reason, correlation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'till.signoff',$7,$8,$9,$10)`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          sessionId,
          notCounted ? "drawer not counted" : "drawer counted",
          idempotencyKey,
          signedAt,
        ],
      );
      await client.query("COMMIT");
      return {
        signoffId,
        idempotencyKey,
        notCounted,
        signedAt,
        signedBy: actor.userId,
        snapshot,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pdf(actor: LedgerActor): Promise<Buffer> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "till:close");
      const session = await this.latestSession(client, actor);
      if (!session) throw new LedgerError("TILL_NOT_OPEN", "Open the till before signing off the day.");
      const found = await client.query(
        `SELECT pdf FROM ledger_till_signoffs
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND session_id=$6`,
        [...scope(actor), session.session_id],
      );
      await client.query("COMMIT");
      if (!found.rowCount) {
        throw new LedgerError("TILL_SIGNOFF_NOT_FOUND", "This till session has not been signed off.");
      }
      const bytes = found.rows[0].pdf;
      return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async latestSession(client: pg.PoolClient, actor: LedgerActor) {
    const found = await client.query(
      `SELECT session_id, business_date, closed_at
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5
        ORDER BY session_number DESC
        LIMIT 1`,
      scope(actor),
    );
    if (!found.rowCount) return null;
    const row = found.rows[0];
    return {
      session_id: row.session_id as string,
      business_date: row.business_date,
      closed_at: row.closed_at == null ? null : new Date(row.closed_at),
    };
  }

  private async signoffForSession(client: pg.PoolClient, actor: LedgerActor, sessionId: string) {
    const found = await client.query(
      `SELECT * FROM ledger_till_signoffs
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5 AND session_id=$6`,
      [...scope(actor), sessionId],
    );
    return found.rowCount ? storedFrom(found.rows[0]) : null;
  }
}
