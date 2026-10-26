import { createHash, randomUUID } from "node:crypto";
import { civilDate, civilTodayInZone } from "../civil-date.js";
import { branchZone } from "./branch-day.js";
import Decimal from "decimal.js";
import type pg from "pg";
import { branchZone as branchZoneOnClient } from "./branch-zone.js";
import { currentBasis } from "./cost-basis.js";
import { resolvePack } from "./jurisdiction.js";
import { assertTradeable, parseMoney, roundTo } from "./currencies.js";
import { pinDeskName } from "../auth/desk-name.js";
import { hasBackendPermission } from "../auth/permissions.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, refuseTillHeld, type LedgerActor } from "./service.js";
import { withSerializationRetry } from "./retry.js";
import {
  applyVaultLeg,
  boardUnitCostHome,
  CHANGED_MOVEMENT_MESSAGE,
  lockVault,
  sameStoredMovement,
  transferCost,
  VAULT_IDEMPOTENCY_CONSTRAINT,
  vaultBox,
  vaultIsTracked,
  type CostBox,
} from "./vault-control.js";

/* A currency, as a code. This was a four-way union — CAD, USD, EUR, GBP
   — which is what a `char(3)` column had been narrowed to by hand. It
   was the type-level half of the ceiling described in migration 020: a
   desk trading pesos could not be represented, never mind stored. What
   a given desk may hold is data, and it is resolved per desk in
   ./currencies.ts. */
type Currency = string;
type Counts = Partial<Record<Currency, string>>;
type MovementInput = {
  idempotencyKey: string;
  direction: "in" | "out";
  currency: Currency;
  amount: string;
  counterpartyType: "vault" | "bank" | "other";
  counterpartyRef: string;
  reason: string;
};

/* Postgres named this itself from the UNIQUE (tenant, entity, branch,
   workspace, till, idempotency_key) in migration 006, and truncated it
   at 63 characters. A float also writes that same key on the vault leg,
   so the loser of a race can hit the vault's idempotency constraint
   instead. Either name is this key. The primary key is not. */
const TILL_IDEMPOTENCY_CONSTRAINT =
  "ledger_operational_cash_movem_tenant_id_legal_entity_id_bra_key";

const cashMoveKeyConflict = (error: unknown) => {
  const pgError = error as { code?: string; constraint?: string };
  return (
    pgError.code === "23505" &&
    (pgError.constraint === TILL_IDEMPOTENCY_CONSTRAINT ||
      pgError.constraint === VAULT_IDEMPOTENCY_CONSTRAINT)
  );
};

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

/* The day this branch is trading. `branches.timezone` is the clock
   the location keeps. The process zone, and UTC, are not that day.
   A missing table (a ledger database that does not hold the desk
   rows) falls back to the column's own default. `client` is the
   till transaction. The zone is read on that connection, inside a
   savepoint, so a missing table does not abort the transaction. */
async function branchBusinessDate(
  client: pg.PoolClient,
  branchId: string,
  now: Date,
): Promise<{ zone: string; day: string }> {
  const zone = await branchZoneOnClient(client, branchId);
  return { zone, day: civilTodayInZone(now, zone) };
}

const fixed = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2).toFixed(2);
/* Expected on the count row is the balance the ledger stored, at two
   places. The variance is counted minus roundTo of that figure. The
   rounding rule is written on roundTo. A count does not rewrite the
   stored balance. */
const expectedIn = (value: Decimal.Value) => fixed(value);
export function recordedVariance(
  counted: string,
  expected: string,
  currency: string,
): string {
  return fixed(new Decimal(counted).minus(roundTo(new Decimal(expected), currency)));
}
const countedIn = (value: string, currency: string) =>
  fixed(parseMoney(value, currency, "Count", "0"));
const HANDOVER_MISMATCH = "The count does not match. A supervisor must approve this takeover.";
/* The approver sheet is not in this release. A request that names an
   approver or a PIN is refused here, before the PIN is read. */
const HANDOVER_APPROVAL_ENABLED: boolean = false;
const handoverRequestHash = (
  counts: Counts,
  approval?: { staffId: string; pin: string },
) => createHash("sha256").update(JSON.stringify({
  counts: Object.keys(counts).sort().map((currency) => [currency, counts[currency]]),
  approverPresent: Boolean(approval && (approval.staffId !== "" || approval.pin !== "")),
})).digest("hex");
const sessionJson = (row: Record<string, unknown>, zone = "America/Toronto") => ({
  sessionId: row.session_id,
  sessionNumber: row.session_number,
  businessDate: (() => {
    const day = civilDate(row.business_date);
    if (!day) throw new Error("Till session is missing its business date");
    return day;
  })(),
  timezone: zone,
  status: row.status,
  openedBy: row.opened_by,
  openedAt: new Date(row.opened_at as string | Date).toISOString(),
  closedBy: row.closed_by ?? null,
  closedAt: row.closed_at
    ? new Date(row.closed_at as string | Date).toISOString()
    : null,
  closeNote: row.close_note ?? null,
});

export class TillControlService {
  constructor(private readonly pool: pg.Pool) {}

  private async currentWithClient(
    client: pg.PoolClient,
    actor: LedgerActor,
  ) {
    const session = await client.query(
      `SELECT *
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5
        ORDER BY session_number DESC
        LIMIT 1`,
      scope(actor),
    );
    const codes = await client.query(
      `SELECT currency
         FROM ledger_till_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5
        ORDER BY currency`,
      scope(actor),
    );
    const currencies = codes.rows.map((row) => String(row.currency).trim());
    if (!session.rowCount) {
      return { session: null, latestCounts: {}, currencies };
    }
    const counts = await client.query(
      `SELECT DISTINCT ON (c.currency)
              c.currency,c.expected_amount,c.counted_amount,c.variance_amount,
              c.stored_expected_amount,c.board_mid_rate,
              b.batch_id,b.count_kind,b.actor_id,b.counted_at
         FROM ledger_till_count_batches b
         JOIN ledger_till_counts c ON c.batch_id=b.batch_id
        WHERE b.session_id=$1
        ORDER BY c.currency,b.counted_at DESC,c.count_id DESC`,
      [session.rows[0].session_id],
    );
    /* Open and handover call this before they release `client`.
       The zone is read on that connection. A pool read here waits
       for a second connection while the till transaction still holds one. */
    const zone = await branchZoneOnClient(client, actor.branchId);
    const openedBy = String(session.rows[0].opened_by ?? "");
    const named = openedBy
      ? await client.query(`SELECT name FROM staff_users WHERE id=$1`, [openedBy])
      : { rows: [] as { name?: string }[] };
    const holderName = pinDeskName(String(named.rows[0]?.name ?? ""));
    return {
      session: {
        ...sessionJson(session.rows[0], zone),
        holderName: holderName || null,
      },
      currencies,
      latestCounts: Object.fromEntries(
        counts.rows.map((row) => {
          const figure: Record<string, unknown> = {
            batchId: row.batch_id,
            kind: row.count_kind,
            countedAt: new Date(row.counted_at).toISOString(),
          };
          /* Counted figures and who entered them belong to the holder
             while the session is open. A non-holder gets the currency
             and the time, not the amount. A closed session is the record
             the closer just wrote. */
          if (String(session.rows[0].status) !== "open" || openedBy === actor.userId) {
            figure.counted = row.counted_amount;
            figure.actorId = row.actor_id;
          }
          /* The handover copy is the count the incoming teller just gave.
             Expected and variance are the book. They stay off this payload. */
          if (row.count_kind !== "handover") {
            figure.expected = row.expected_amount;
            figure.variance = row.variance_amount;
            figure.storedExpected = row.stored_expected_amount;
          }
          return [row.currency.trim(), figure];
        }),
      ),
    };
  }

  async current(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const response = await this.currentWithClient(client, actor);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* WHO IS ON WHICH DRAWER, ACCORDING TO THE BOOK.

     The desk used to answer this from a roster baked into the browser:
     "Till 2 — Express · M. Costa on now", for a till that had never held a
     session and a person the ledger has never heard of. A teller reads that
     line to decide where to sit, and a handover recorded against the wrong
     drawer is a cash defect with a name attached to it.

     So occupancy is a server fact or it is nothing. The latest session per
     workspace is returned with its status; a workspace absent from the map
     has never been opened, and the client is expected to say exactly that
     rather than fill the gap.

     Scoped by branch rather than by actor because the caller — the workspace
     list — is answering "what tills does this branch have", a question that
     by definition spans workspaces the actor is not currently in. It carries
     no cash: a session number, a status and the id of whoever opened it. */
  async branchOccupancy(scopeIn: {
    tenantId: string;
    legalEntityId: string;
    branchId: string;
  }) {
    const zone = await branchZone(this.pool, scopeIn.branchId);
    const result = await this.pool.query(
      `SELECT DISTINCT ON (workspace_id)
              workspace_id,till_id,session_id,session_number,status,
              business_date,opened_by,opened_at,closed_by,closed_at
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        ORDER BY workspace_id,session_number DESC`,
      [scopeIn.tenantId, scopeIn.legalEntityId, scopeIn.branchId],
    );
    const ids = result.rows.map((row) => String(row.opened_by ?? "")).filter(Boolean);
    const names = ids.length
      ? await this.pool.query(
          `SELECT id, name FROM staff_users WHERE id = ANY($1::text[])`,
          [ids],
        )
      : { rows: [] as { id: string; name: string }[] };
    const byId = new Map(
      names.rows.map((row) => [String(row.id), pinDeskName(String(row.name ?? ""))]),
    );
    return new Map(
      result.rows.map((row) => {
        const session = sessionJson(row as Record<string, unknown>, zone);
        const holderName = byId.get(String(row.opened_by ?? "")) || null;
        return [String(row.workspace_id), { ...session, holderName }] as const;
      }),
    );
  }

  /* Handover rows a closer can read. A nonzero variance is a flag.
     An even count is still a record. Names come from staff_users.
     Counted amounts and the variance stay on the count batch. */
  async handoverNotes(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const rows = await client.query(
        `SELECT a.count_batch_id, a.from_user, a.actor_id, a.prior_session_id,
                a.target_id, a.actor_role, a.created_at, b.till_id,
                c.currency, c.counted_amount::text AS counted,
                c.variance_amount::text AS variance
           FROM ledger_audit_events a
           JOIN ledger_till_count_batches b ON b.batch_id = a.count_batch_id
           JOIN ledger_till_counts c ON c.batch_id = a.count_batch_id
          WHERE a.action = 'till.session.handover'
            AND a.tenant_id=$1 AND a.legal_entity_id=$2 AND a.branch_id=$3
            AND a.workspace_id=$4
          ORDER BY a.created_at, c.currency`,
        scope(actor).slice(0, 4),
      );
      const ids = [
        ...new Set(
          rows.rows.flatMap((row) => [String(row.from_user ?? ""), String(row.actor_id ?? "")]).filter(Boolean),
        ),
      ];
      const names = ids.length
        ? await client.query(`SELECT id, name FROM staff_users WHERE id = ANY($1::text[])`, [ids])
        : { rows: [] as { id: string; name: string }[] };
      const byId = new Map(
        names.rows.map((row) => [String(row.id), pinDeskName(String(row.name ?? ""))]),
      );
      const grouped = new Map<string, {
        batchId: string; tillId: string; priorSessionId: string; sessionId: string;
        actorRole: string; at: string; fromName: string; toName: string;
        lines: { currency: string; counted: string; variance: string }[]; off: boolean;
      }>();
      for (const row of rows.rows) {
        const key = String(row.count_batch_id);
        if (!grouped.has(key)) {
          grouped.set(key, {
            batchId: key,
            tillId: String(row.till_id ?? "").trim(),
            priorSessionId: String(row.prior_session_id ?? ""),
            sessionId: String(row.target_id ?? ""),
            actorRole: String(row.actor_role ?? ""),
            at: new Date(row.created_at as string | Date).toISOString(),
            fromName: byId.get(String(row.from_user)) || "",
            toName: byId.get(String(row.actor_id)) || "",
            lines: [],
            off: false,
          });
        }
        const item = grouped.get(key)!;
        const variance = String(row.variance);
        if (!new Decimal(variance).isZero()) item.off = true;
        item.lines.push({
          currency: String(row.currency).trim(),
          counted: String(row.counted),
          variance,
        });
      }
      await client.query("COMMIT");
      const records = [...grouped.values()];
      const flags = records.filter((row) => row.off).map((row) => ({
        fromName: row.fromName,
        toName: row.toName,
        lines: row.lines.map((line) => ({ currency: line.currency, variance: line.variance })),
      }));
      return { flags, records };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* MOVING TO ANOTHER DRAWER, ON THE RECORD.

     The Cash Drawer's till switcher promises, in the confirmation modal,
     that "the switch is stamped to the audit trail with your name and the
     time". Nothing was written: the browser renamed a label, kept sending
     the old workspace header, and a count taken at Till 2 was recorded
     against Till 1 with a large invented variance on an innocent drawer.

     This is the server end of the switch. It exists so that the client has
     something to await before it changes what the screen says — the actor,
     the target workspace and the authorization are all checked here, and
     the audit row is written here, so a switch that appears on screen is a
     switch the book agreed to. The response carries the new till's session
     and balances so the drawer never renders the new name over the old
     money.

     WHY IT DOES NOT REFUSE A SWITCH AWAY FROM AN OPEN, UNCOUNTED TILL.

     The tempting rule is "you may not leave a drawer you have not counted".
     It is the wrong rule here, for three reasons:

       · The switch is not the event. A person physically moving to another
         drawer has already happened; refusing only stops the LEDGER from
         following them, which recreates precisely the divergence this whole
         change exists to remove — screen on one till, requests on another.
       · A session is not a lock. Sessions deliberately outlive a teller and
         a shift; a till sitting open and uncounted is an ordinary state, not
         an error, and two tellers on two drawers of the same branch is the
         case a second till exists for.
       · The refusal that matters already exists, at the point where an
         uncounted currency could overwrite real money: the CLOSE refuses
         (INCOMPLETE_TILL_COUNT) unless every ledger currency has a real
         count. Moving that refusal earlier would not protect any cash it
         does not already protect.

     A count typed in and not yet saved is the one genuine hazard, and it is
     a client-side one: those figures belong to the drawer they were counted
     at. The browser discards them on a switch rather than carrying them, and
     says so — see cdos-till.jsx. Discarding is safe because nothing was
     posted; carrying is a count recorded against the wrong till. */
  async selectTill(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const now = new Date();
      await this.audit(
        client,
        actor,
        "till.select",
        actor.workspaceId,
        `operator moved to ${actor.tillId}`,
        now,
      );
      const state = await this.currentWithClient(client, actor);
      const balances = await client.query(
        `SELECT currency,available_amount
           FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
          ORDER BY currency`,
        scope(actor),
      );
      const mark = await client.query(
        `SELECT generation::text AS generation
           FROM ledger_till_balance_generations
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5`,
        scope(actor),
      );
      const withheld = !!(state.session && state.session.status === "open" && state.session.openedBy !== actor.userId);
      if (withheld) {
        for (const figure of Object.values(state.latestCounts)) {
          const row = figure as { expected?: unknown; storedExpected?: unknown; variance?: unknown };
          delete row.expected;
          delete row.storedExpected;
          delete row.variance;
        }
      }
      await client.query("COMMIT");
      return {
        workspaceId: actor.workspaceId,
        tillId: actor.tillId,
        branchId: actor.branchId,
        selectedAt: now.toISOString(),
        ...state,
        balanceGeneration: mark.rows[0]?.generation ?? "0",
        balances: withheld
          ? {}
          : Object.fromEntries(
              balances.rows.map((row) => [
                row.currency.trim(),
                row.available_amount,
              ]),
            ),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  open(actor: LedgerActor) {
    return withSerializationRetry(() => this.openOnce(actor));
  }

  private async openOnce(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "till:count");
      const now = new Date();
      const clock = await branchBusinessDate(client, actor.branchId, now);
      const existing = await client.query(
        `SELECT *
           FROM ledger_till_sessions
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND status='open'
          FOR UPDATE`,
        scope(actor),
      );
      if (!existing.rowCount) {
        const next = await client.query(
          `SELECT COALESCE(max(session_number),0)+1 AS session_number
             FROM ledger_till_sessions
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5`,
          scope(actor),
        );
        const sessionId = `till_session_${randomUUID()}`;
        await client.query(
          `INSERT INTO ledger_till_sessions
            (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
             session_number,business_date,status,opened_by,opened_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)`,
          [
            sessionId,
            ...scope(actor),
            next.rows[0].session_number,
            clock.day,
            actor.userId,
            now,
          ],
        );
        await this.audit(
          client,
          actor,
          "till.session.open",
          sessionId,
          `session=${next.rows[0].session_number}`,
          now,
        );
      }
      const response = await this.currentWithClient(client, actor);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  recordCount(actor: LedgerActor, idempotencyKey: string, counts: Counts) {
    return withSerializationRetry(() =>
      this.recordCountOnce(actor, idempotencyKey, counts));
  }

  private async recordCountOnce(
    actor: LedgerActor,
    idempotencyKey: string,
    counts: Counts,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "till:count");
      const session = await this.openSession(client, actor);
      if (String(session.opened_by) !== actor.userId) {
        await refuseTillHeld(client, String(session.opened_by));
      }
      const existing = await client.query(
        `SELECT batch_id
           FROM ledger_till_count_batches
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND session_id=$6
            AND idempotency_key=$7`,
        [...scope(actor), session.session_id, idempotencyKey],
      );
      if (!existing.rowCount) {
        const balances = await this.lockBalances(client, actor);
        const balanceMap = new Map(
          balances.map((row) => [row.currency.trim(), row.available_amount]),
        );
        for (const currency of Object.keys(counts)) {
          if (!balanceMap.has(currency)) {
            throw new LedgerError(
              "INVALID_REQUEST",
              `No authoritative ${currency} balance exists for this till.`,
            );
          }
        }
        const batchId = `till_count_${randomUUID()}`;
        const now = new Date();
        await client.query(
          `INSERT INTO ledger_till_count_batches
            (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             till_id,count_kind,actor_id,idempotency_key,counted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'interim',$8,$9,$10)`,
          [
            batchId,
            session.session_id,
            ...scope(actor),
            actor.userId,
            idempotencyKey,
            now,
          ],
        );
        for (const [currency, counted] of Object.entries(counts)) {
          const expected = expectedIn(balanceMap.get(currency)!);
          const countedAmount = countedIn(String(counted), currency);
          await client.query(
            `INSERT INTO ledger_till_counts
              (batch_id,currency,expected_amount,counted_amount,variance_amount,
               stored_expected_amount)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              batchId,
              currency,
              expected,
              countedAmount,
              recordedVariance(countedAmount, expected, currency),
              expected,
            ],
          );
        }
        await this.audit(
          client,
          actor,
          "till.count.record",
          batchId,
          `currencies=${Object.keys(counts).sort().join(",")}`,
          now,
        );
      }
      const response = await this.currentWithClient(client, actor);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close(
    actor: LedgerActor,
    sessionId: string,
    idempotencyKey: string,
    counts: Counts,
    note: string,
    balanceGeneration: string,
  ) {
    return withSerializationRetry(() =>
      this.closeOnce(actor, sessionId, idempotencyKey, counts, note, balanceGeneration));
  }

  private async closeOnce(
    actor: LedgerActor,
    sessionId: string,
    idempotencyKey: string,
    counts: Counts,
    note: string,
    balanceGeneration: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "till:close");
      const session = await client.query(
        `SELECT *
           FROM ledger_till_sessions
          WHERE session_id=$1 AND tenant_id=$2 AND legal_entity_id=$3
            AND branch_id=$4 AND workspace_id=$5 AND till_id=$6
          FOR UPDATE`,
        [sessionId, ...scope(actor)],
      );
      if (!session.rowCount) {
        throw new LedgerError("TILL_SESSION_NOT_FOUND", "Till session not found.");
      }
      if (session.rows[0].status === "closed") {
        const existing = await client.query(
          `SELECT batch_id
             FROM ledger_till_count_batches
            WHERE session_id=$1 AND idempotency_key=$2 AND count_kind='close'`,
          [sessionId, idempotencyKey],
        );
        if (!existing.rowCount) {
          throw new LedgerError("TILL_ALREADY_CLOSED", "Till session is already closed.");
        }
        const response = await this.currentWithClient(client, actor);
        await client.query("COMMIT");
        return response;
      }
      const balances = await this.lockBalances(client, actor);
      /* The count names the drawer it was taken against. A deal, a cheque
         or a float since that read has a newer mark, and writing the old
         count back would put the drawer where it was before the money
         moved. Refuse, and leave both the session and the balances. */
      const mark = await client.query(
        `SELECT generation::text AS generation
           FROM ledger_till_balance_generations
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
          FOR UPDATE`,
        scope(actor),
      );
      const currentMark = mark.rows[0]?.generation ?? "0";
      if (currentMark !== balanceGeneration) {
        throw new LedgerError(
          "TILL_COUNT_STALE",
          "Money moved since you counted. Count again.",
        );
      }
      const balanceCurrencies = balances
        .map((row) => row.currency.trim())
        .sort();
      const countCurrencies = Object.keys(counts).sort();
      if (
        !balanceCurrencies.length ||
        balanceCurrencies.join(",") !== countCurrencies.join(",")
      ) {
        throw new LedgerError(
          "INCOMPLETE_TILL_COUNT",
          "Every authoritative till currency must be counted before closing.",
        );
      }
      const batchId = `till_close_${randomUUID()}`;
      const now = new Date();
      await client.query(
        `INSERT INTO ledger_till_count_batches
          (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
           till_id,count_kind,actor_id,idempotency_key,counted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'close',$8,$9,$10)`,
        [
          batchId,
          sessionId,
          ...scope(actor),
          actor.userId,
          idempotencyKey,
          now,
        ],
      );
      for (const row of balances) {
        const currency = row.currency.trim() as Currency;
        const expected = expectedIn(row.available_amount);
        const counted = countedIn(String(counts[currency]), currency);
        await client.query(
          `INSERT INTO ledger_till_counts
            (batch_id,currency,expected_amount,counted_amount,variance_amount,
             stored_expected_amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            batchId,
            currency,
            expected,
            counted,
            recordedVariance(counted, expected, currency),
            expected,
          ],
        );
        await client.query(
          `UPDATE ledger_till_balances
              SET available_amount=$1
            WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
              AND workspace_id=$5 AND till_id=$6 AND currency=$7`,
          [counted, ...scope(actor), currency],
        );
      }
      await client.query(
        `UPDATE ledger_till_sessions
            SET status='closed',closed_by=$1,closed_at=$2,close_note=$3
          WHERE session_id=$4`,
        [actor.userId, now, note || null, sessionId],
      );
      await this.audit(
        client,
        actor,
        "till.session.close",
        sessionId,
        note || "Till reconciled and closed.",
        now,
      );
      const response = await this.currentWithClient(client, actor);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new LedgerError(
          "IDEMPOTENCY_CONFLICT",
          "That till operation was already recorded.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /* A blind count. The incoming teller does not see the book or the
     variance. Over CAD 20.00, absolute at the board mid, stays held
     until a different person with till:handover:approve enters a PIN. */
  handover(
    actor: LedgerActor,
    idempotencyKey: string,
    counts: Counts,
    approval?: { staffId: string; pin: string },
  ) {
    return withSerializationRetry(() => this.handoverOnce(actor, idempotencyKey, counts, approval));
  }

  private async handoverOnce(
    actor: LedgerActor,
    idempotencyKey: string,
    counts: Counts,
    approval?: { staffId: string; pin: string },
  ): Promise<Awaited<ReturnType<TillControlService["current"]>>> {
    const client = await this.pool.connect();
    const hash = handoverRequestHash(counts, approval);
    let settled = false;
    const remember = (response: unknown) => client.query(
      `UPDATE ledger_idempotency SET response=$1
        WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
          AND workspace_id=$5 AND till_id=$6 AND operation='till-handover'
          AND idempotency_key=$7`,
      [response, ...scope(actor), idempotencyKey],
    );
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const role = await authorizeLedgerActor(client, actor, "till:count");
      const replay = await client.query(
        `SELECT response, actor_id, request_hash FROM ledger_idempotency
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND operation='till-handover'
            AND idempotency_key=$6
          FOR UPDATE`,
        [...scope(actor), idempotencyKey],
      );
      if (replay.rowCount) {
        const row = replay.rows[0] as { response?: unknown; actor_id?: string | null; request_hash?: string | null };
        if (row.actor_id !== actor.userId || row.request_hash !== hash) {
          throw new LedgerError("IDEMPOTENCY_CONFLICT", "That till operation was already recorded.");
        }
        if (row.response) {
          await client.query("COMMIT");
          return row.response as Awaited<ReturnType<TillControlService["current"]>>;
        }
      }
      if (!replay.rowCount) {
        const claimed = await client.query(
          `INSERT INTO ledger_idempotency
            (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key,actor_id,request_hash)
           VALUES ($1,$2,$3,$4,$5,'till-handover',$6,$7,$8) ON CONFLICT DO NOTHING`,
          [...scope(actor), idempotencyKey, actor.userId, hash],
        );
        if (!claimed.rowCount) {
          throw new LedgerError("IDEMPOTENCY_IN_PROGRESS", "Request is already in progress.");
        }
      }
      /* The session day follows the same clock as opening a till.
         The approver stamp below is the database clock on its own. */
      const now = new Date();
      const clock = await branchBusinessDate(client, actor.branchId, now);
      const session = await this.openSession(client, actor);
      if (session.opened_by === actor.userId) {
        const response = await this.currentWithClient(client, actor);
        await remember(response);
        await client.query("COMMIT");
        return response;
      }
      const balances = await this.lockBalances(client, actor);
      const have = balances.map((row) => row.currency.trim()).sort().join(",");
      const gave = Object.keys(counts).sort().join(",");
      if (!have || have !== gave) {
        throw new LedgerError(
          "INCOMPLETE_TILL_COUNT",
          "Every authoritative till currency must be counted before closing.",
        );
      }
      /* A refusal is committed on its own, so the audit row survives the
         403. The first submitted count is the one stored on that row.
         A later count from someone who cannot approve is the same 403. */
      const refuse = async (): Promise<never> => {
        const counted = Object.keys(counts).sort().map((currency) => ({
          currency,
          counted: String(counts[currency] ?? ""),
        }));
        await client.query(
          `INSERT INTO ledger_audit_events
            (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
             action,target_id,correlation_id,created_at,prior_session_id,variances)
           VALUES ($1,$2,$3,$4,$5,$6,'till.handover.refused',$7,$8,clock_timestamp(),$9,$10::jsonb)`,
          [
            randomUUID(),
            ...scope(actor).slice(0, 4),
            actor.userId,
            actor.tillId,
            randomUUID(),
            session.session_id,
            JSON.stringify(counted),
          ],
        );
        await client.query("COMMIT");
        settled = true;
        throw new LedgerError("HANDOVER_APPROVAL_REQUIRED", HANDOVER_MISMATCH);
      };
      const prior = await client.query(
        `SELECT 1 FROM ledger_audit_events
          WHERE action='till.handover.refused' AND prior_session_id=$1
          LIMIT 1`,
        [session.session_id],
      );
      if (prior.rowCount && !hasBackendPermission(role, "till:handover:approve")) await refuse();
      if (approval && !HANDOVER_APPROVAL_ENABLED) await refuse();
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency.trim().toUpperCase();
      const board = await client.query(
        `SELECT board_rows FROM rate_boards
          WHERE tenant_id=$1 AND branch_id=$2
          ORDER BY published_at DESC LIMIT 1`,
        [actor.tenantId, actor.branchId],
      );
      const boardRows = (board.rows[0]?.board_rows ?? {}) as Record<string, { mid?: unknown }>;
      const lines: { currency: string; expected: string; counted: string; variance: string; mid: string | null }[] = [];
      let absCad = new Decimal(0);
      let unpriced = false;
      for (const row of balances) {
        const currency = row.currency.trim();
        const expected = expectedIn(row.available_amount);
        const counted = countedIn(String(counts[currency]), currency);
        const variance = recordedVariance(counted, expected, currency);
        const raw = currency === home ? 1 : boardRows[currency]?.mid;
        const midDec = raw == null ? null : new Decimal(String(raw));
        const mid = midDec && midDec.gt(0) ? midDec.toDecimalPlaces(12).toFixed(12) : null;
        const gap = new Decimal(variance).abs();
        if (gap.gt(0) && !mid) unpriced = true;
        else if (mid) absCad = absCad.plus(gap.mul(mid));
        lines.push({ currency, expected, counted, variance, mid });
      }
      if (unpriced || absCad.gt(new Decimal("20"))) await refuse();
      const opener = session.opened_by as string;
      const writeBatch = async (sessionId: string, kind: "close" | "handover") => {
        const id = `till_${kind}_${randomUUID()}`;
        await client.query(
          `INSERT INTO ledger_till_count_batches
            (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             till_id,count_kind,actor_id,idempotency_key,counted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, sessionId, ...scope(actor), kind, actor.userId, idempotencyKey, now],
        );
        for (const line of lines) {
          await client.query(
            `INSERT INTO ledger_till_counts
              (batch_id,currency,expected_amount,counted_amount,variance_amount,
               stored_expected_amount,board_mid_rate)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, line.currency, line.expected, line.counted, line.variance, line.expected, line.mid],
          );
        }
        return id;
      };
      const batchId = await writeBatch(session.session_id, "close");
      for (const line of lines) {
        await client.query(
          `UPDATE ledger_till_balances SET available_amount=$1
            WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
              AND workspace_id=$5 AND till_id=$6 AND currency=$7`,
          [line.counted, ...scope(actor), line.currency],
        );
      }
      await client.query(
        `UPDATE ledger_till_sessions
            SET status='closed', closed_by=$1, closed_at=$2, close_note='Handover count'
          WHERE session_id=$3`,
        [actor.userId, now, session.session_id],
      );
      const next = await client.query(
        `SELECT COALESCE(max(session_number),0)+1 AS session_number
           FROM ledger_till_sessions
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5`,
        scope(actor),
      );
      const sessionId = `till_session_${randomUUID()}`;
      await client.query(
        `INSERT INTO ledger_till_sessions
          (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
           session_number,business_date,status,opened_by,opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)`,
        [
          sessionId, ...scope(actor), next.rows[0].session_number,
          clock.day, actor.userId, now,
        ],
      );
      await writeBatch(sessionId, "handover");
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at,
           prior_session_id,count_batch_id,actor_role,from_user,
           approver_id,approver_role,approved_at,variances)
         VALUES ($1,$2,$3,$4,$5,$6,'till.session.handover',$7,$8,$9,clock_timestamp(),
           $10,$11,$12,$13,$14,$15,
           CASE WHEN $14::text IS NULL THEN NULL ELSE clock_timestamp() END,$16::jsonb)`,
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          sessionId,
          `from=${opener}`,
          randomUUID(),
          session.session_id,
          batchId,
          role,
          opener,
          null,
          null,
          JSON.stringify(lines.map((line) => ({
            currency: line.currency,
            variance: line.variance,
            mid: line.mid,
          }))),
        ],
      );
      const dropped = await client.query(
        `UPDATE quotes SET status='cancelled'
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
            AND status='active' AND created_by=$6
          RETURNING quote_id`,
        [...scope(actor), opener],
      );
      for (const row of dropped.rows) {
        await client.query(
          `INSERT INTO quote_events (event_id,quote_id,actor_id,event_type,detail,created_at)
           VALUES ($1,$2,$3,'cancelled',$4::jsonb,clock_timestamp())`,
          [randomUUID(), row.quote_id, actor.userId, JSON.stringify({ reason: "handover" })],
        );
      }
      const response = await this.currentWithClient(client, actor);
      await remember(response);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      if (!settled) await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new LedgerError("IDEMPOTENCY_CONFLICT", "That till operation was already recorded.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /* Retried, because SERIALIZABLE asks callers to. The cash rail is the
     most contended thing on the desk — a float, a top-up and the screen
     refreshing its balances all touch the same rows — and an abort here
     used to reach the teller as "Unexpected server error" on a movement
     that was never wrong. See retry.ts. */
  moveCash(actor: LedgerActor, input: MovementInput) {
    return withSerializationRetry(() => this.moveCashOnce(actor, input));
  }

  private async moveCashOnce(actor: LedgerActor, input: MovementInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "till:move");
      const existing = await client.query(
        `SELECT *
           FROM ledger_operational_cash_movements
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6`,
        [...scope(actor), input.idempotencyKey],
      );
      if (existing.rowCount) {
        /* A lost answer leaves the form open on this key. Editing the
           amount, the currency, or the direction and tapping again is
           not a retry of the movement that already landed. */
        if (!sameStoredMovement(existing.rows[0], input)) {
          throw new LedgerError("IDEMPOTENCY_CONFLICT", CHANGED_MOVEMENT_MESSAGE);
        }
        const response = await this.movementResponse(client, actor, existing.rows[0]);
        await client.query("COMMIT");
        return response;
      }
      const session = await this.openSession(client, actor);
      if (String(session.opened_by) !== actor.userId) {
        await refuseTillHeld(client, String(session.opened_by));
      }
      const balance = await client.query(
        `SELECT available_amount
           FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND currency=$6
          FOR UPDATE`,
        [...scope(actor), input.currency],
      );
      const amount = new Decimal(input.amount).toDecimalPlaces(2);

      /* ---------------- COST BASIS ----------------
         A float and a return are TRANSFERS. The desk has not sold anything
         to anybody, so nothing is realized — but the cash carries what it
         cost out of the sending box and into the receiving one, and that is
         the part that used to be missing. A float that landed in the drawer
         with no basis made the drawer's next sale unpriceable: either the
         posting refuses it or it books the whole proceeds as profit.

         Only a vault counterparty is handled here. Cash arriving from a bank
         or from 'other' has no box on this ledger to have come out of, so
         there is no average to carry and no price on record; that stays
         quantity-only until somebody states what it cost.

         Both averages are read BEFORE either balance moves, and under the
         locks, because the weighted average is taken against the quantities
         as they stood. Read afterwards it is a different, wrong number, and
         nothing downstream would ever say so. See docs/COST_BASIS.md. */
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;
      /* A movement can bring a currency onto the book that was never on
         it, so this is one of the doors the desk's own set has to be
         checked at. Refused by name — "this desk does not trade PHP" —
         rather than by a four-way enum in the route, which is what used
         to happen and which no shop could act on. See migration 020. */
      await assertTradeable(
        client,
        { legalEntityId: actor.legalEntityId, branchId: actor.branchId, homeCurrency: home },
        input.currency,
      );
      const carriesCost =
        input.counterpartyType === "vault" && input.currency !== home;
      /* A float names the vault as the other box. If that box has never
         been counted, there is nothing to subtract, and crediting the
         till anyway invents cash. Refuse before either balance moves.
         Cash from a bank or from 'other' has no vault leg, and still posts. */
      if (input.counterpartyType === "vault") {
        const tracked = await vaultIsTracked(
          client,
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
        );
        if (!tracked) {
          throw new LedgerError(
            "VAULT_NOT_INITIALIZED",
            "Open the vault with a starting count first.",
          );
        }
      }
      const tillBox: CostBox = {
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        locationKind: "till",
        locationId: actor.tillId,
      };
      const branchVault = vaultBox(
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
      );
      type Basis = { quantity: Decimal; avgCost: Decimal | null };
      let tillBefore: Basis | null = null;
      let vaultBefore: Basis | null = null;
      if (carriesCost) {
        tillBefore = await currentBasis(client, {
          ...tillBox,
          currency: input.currency,
        });
        await lockVault(client, actor.tenantId, actor.legalEntityId, actor.branchId);
        vaultBefore = await currentBasis(client, {
          ...branchVault,
          currency: input.currency,
        });
      }

      const current = new Decimal(balance.rows[0]?.available_amount ?? 0);
      const next =
        input.direction === "in" ? current.add(amount) : current.minus(amount);
      if (next.lt(0)) {
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Cash movement exceeds the authoritative till balance.",
        );
      }
      if (balance.rowCount) {
        await client.query(
          `UPDATE ledger_till_balances
              SET available_amount=$1
            WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
              AND workspace_id=$5 AND till_id=$6 AND currency=$7`,
          [fixed(next), ...scope(actor), input.currency],
        );
      } else {
        await client.query(
          `INSERT INTO ledger_till_balances
            (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,
             available_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [...scope(actor), input.currency, fixed(next)],
        );
      }
      const now = new Date();
      const movementId = `cash_move_${randomUUID()}`;
      /* THE OTHER HALF OF THE FLOAT.
         Cash into a drawer came out of the branch's strong room, so the
         strong room is debited here, in this transaction, against the same
         locks. Either both boxes move or neither does — the till can no
         longer be floated from a vault that did not have the money.
         An unopened vault was refused above, before this till moved. */
      let vaultLegId: string | null = null;
      if (input.counterpartyType === "vault") {
        vaultLegId = await applyVaultLeg(client, {
          tenantId: actor.tenantId,
          legalEntityId: actor.legalEntityId,
          branchId: actor.branchId,
          direction: input.direction === "in" ? "out" : "in",
          currency: input.currency,
          amount: fixed(amount),
          counterpartyType: "till",
          counterpartyRef: actor.tillId,
          relatedMovementId: movementId,
          reason: input.reason,
          actorId: actor.userId,
          idempotencyKey: input.idempotencyKey,
          now,
        });
      }
      /* Both boxes have moved; now the cost follows, against the figures
         captured above. A null vault leg means this branch has never stated
         a vault position — nothing was debited, so there is nothing whose
         cost could have come from anywhere. */
      if (carriesCost && vaultLegId && tillBefore && vaultBefore) {
        const sending = input.direction === "in" ? branchVault : tillBox;
        const receiving = input.direction === "in" ? tillBox : branchVault;
        await transferCost(client, {
          from: sending,
          to: receiving,
          currency: input.currency,
          amount,
          fromBefore: input.direction === "in" ? vaultBefore : tillBefore,
          toBefore: input.direction === "in" ? tillBefore : vaultBefore,
          fallbackUnitCostHome: await boardUnitCostHome(client, {
            tenantId: actor.tenantId,
            legalEntityId: actor.legalEntityId,
            branchId: actor.branchId,
            currency: input.currency,
            homeCurrency: home,
          }),
          sourceKind: "cash_movement",
          sourceId: movementId,
          actorId: actor.userId,
          now,
        });
      }
      const movement = await client.query(
        `INSERT INTO ledger_operational_cash_movements
          (movement_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
           session_id,direction,currency,amount,counterparty_type,
           counterparty_ref,reason,actor_id,idempotency_key,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          movementId,
          ...scope(actor),
          session.session_id,
          input.direction,
          input.currency,
          fixed(amount),
          input.counterpartyType,
          input.counterpartyRef,
          input.reason,
          actor.userId,
          input.idempotencyKey,
          now,
        ],
      );
      await this.audit(
        client,
        actor,
        "till.cash.move",
        movementId,
        `${input.direction} ${fixed(amount)} ${input.currency}; ${input.reason}`,
        now,
      );
      const response = await this.movementResponse(client, actor, movement.rows[0]);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      /* Two taps of one form can both pass the "have I seen this key?"
         read and then one of them loses the unique index. That loser
         did not move any money — the winner's transaction holds both
         boxes — so it answers with the winner's movement when the body
         is the same one. A different body is the same refusal as the
         read above. A 23505 from any other constraint is not this key. */
      if (cashMoveKeyConflict(error)) {
        /* This connection is idle. The move was rolled back. The winner
           has committed, which is what raised the unique violation.
           Reading that movement on a new connection waits forever once
           every connection is a loser of the same race. */
        const replayed = await this.replayMovement(client, actor, input);
        if (replayed) return replayed;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async replayMovement(
    client: pg.PoolClient,
    actor: LedgerActor,
    input: MovementInput,
  ) {
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT *
           FROM ledger_operational_cash_movements
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6`,
        [...scope(actor), input.idempotencyKey],
      );
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      if (!sameStoredMovement(existing.rows[0], input)) {
        throw new LedgerError("IDEMPOTENCY_CONFLICT", CHANGED_MOVEMENT_MESSAGE);
      }
      const response = await this.movementResponse(client, actor, existing.rows[0]);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private async openSession(client: pg.PoolClient, actor: LedgerActor) {
    const session = await client.query(
      `SELECT *
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5 AND status='open'
        FOR UPDATE`,
      scope(actor),
    );
    if (!session.rowCount) {
      throw new LedgerError("TILL_NOT_OPEN", "Open the till before recording activity.");
    }
    return session.rows[0];
  }

  private async lockBalances(client: pg.PoolClient, actor: LedgerActor) {
    const result = await client.query(
      `SELECT currency,available_amount
         FROM ledger_till_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5
        ORDER BY currency
        FOR UPDATE`,
      scope(actor),
    );
    return result.rows;
  }

  private async movementResponse(
    client: pg.PoolClient,
    actor: LedgerActor,
    row: Record<string, unknown>,
  ) {
    const balances = await this.lockBalances(client, actor);
    // both sides of the movement come back together — a float that shows the
    // drawer going up without the vault coming down is half a story
    const vault = await client.query(
      `SELECT currency,available_amount
         FROM ledger_vault_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        ORDER BY currency`,
      [actor.tenantId, actor.legalEntityId, actor.branchId],
    );
    return {
      vaultTracked: vault.rowCount! > 0,
      vaultBalances: Object.fromEntries(
        vault.rows.map((entry) => [entry.currency.trim(), entry.available_amount]),
      ),
      movement: {
        movementId: row.movement_id,
        sessionId: row.session_id,
        direction: row.direction,
        currency: String(row.currency).trim(),
        amount: row.amount,
        counterpartyType: row.counterparty_type,
        counterpartyRef: row.counterparty_ref,
        reason: row.reason,
        actorId: row.actor_id,
        createdAt: new Date(row.created_at as string | Date).toISOString(),
      },
      balances: Object.fromEntries(
        balances.map((balance) => [
          balance.currency.trim(),
          balance.available_amount,
        ]),
      ),
    };
  }

  private async audit(
    client: pg.PoolClient,
    actor: LedgerActor,
    action: string,
    targetId: string,
    reason: string,
    now: Date,
  ) {
    await client.query(
      `INSERT INTO ledger_audit_events
        (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
         action,target_id,reason,correlation_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        ...scope(actor).slice(0, 4),
        actor.userId,
        action,
        targetId,
        reason,
        randomUUID(),
        now,
      ],
    );
  }
}
