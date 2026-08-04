import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { currentBasis } from "./cost-basis.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";
import { withSerializationRetry } from "./retry.js";
import {
  applyVaultLeg,
  boardUnitCostHome,
  lockVault,
  transferCost,
  vaultBox,
  type CostBox,
} from "./vault-control.js";

type Currency = "CAD" | "USD" | "EUR" | "GBP";
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

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];
const fixed = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2).toFixed(2);
const sessionJson = (row: Record<string, unknown>) => ({
  sessionId: row.session_id,
  sessionNumber: row.session_number,
  businessDate:
    row.business_date instanceof Date
      ? row.business_date.toISOString().slice(0, 10)
      : String(row.business_date),
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
    if (!session.rowCount) {
      return { session: null, latestCounts: {} };
    }
    const counts = await client.query(
      `SELECT DISTINCT ON (c.currency)
              c.currency,c.expected_amount,c.counted_amount,c.variance_amount,
              b.batch_id,b.count_kind,b.actor_id,b.counted_at
         FROM ledger_till_count_batches b
         JOIN ledger_till_counts c ON c.batch_id=b.batch_id
        WHERE b.session_id=$1
        ORDER BY c.currency,b.counted_at DESC,c.count_id DESC`,
      [session.rows[0].session_id],
    );
    return {
      session: sessionJson(session.rows[0]),
      latestCounts: Object.fromEntries(
        counts.rows.map((row) => [
          row.currency.trim(),
          {
            batchId: row.batch_id,
            kind: row.count_kind,
            expected: row.expected_amount,
            counted: row.counted_amount,
            variance: row.variance_amount,
            actorId: row.actor_id,
            countedAt: new Date(row.counted_at).toISOString(),
          },
        ]),
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
    const result = await this.pool.query(
      `SELECT DISTINCT ON (workspace_id)
              workspace_id,till_id,session_id,session_number,status,
              opened_by,opened_at,closed_by,closed_at
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        ORDER BY workspace_id,session_number DESC`,
      [scopeIn.tenantId, scopeIn.legalEntityId, scopeIn.branchId],
    );
    return new Map(
      result.rows.map((row) => [
        String(row.workspace_id),
        sessionJson(row as Record<string, unknown>),
      ]),
    );
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
      await client.query("COMMIT");
      return {
        workspaceId: actor.workspaceId,
        tillId: actor.tillId,
        branchId: actor.branchId,
        selectedAt: now.toISOString(),
        ...state,
        balances: Object.fromEntries(
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
        const now = new Date();
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
            now.toISOString().slice(0, 10),
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
          const expected = fixed(balanceMap.get(currency)!);
          const countedAmount = fixed(counted!);
          await client.query(
            `INSERT INTO ledger_till_counts
              (batch_id,currency,expected_amount,counted_amount,variance_amount)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              batchId,
              currency,
              expected,
              countedAmount,
              fixed(new Decimal(countedAmount).minus(expected)),
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
  ) {
    return withSerializationRetry(() =>
      this.closeOnce(actor, sessionId, idempotencyKey, counts, note));
  }

  private async closeOnce(
    actor: LedgerActor,
    sessionId: string,
    idempotencyKey: string,
    counts: Counts,
    note: string,
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
        const expected = fixed(row.available_amount);
        const counted = fixed(counts[currency]!);
        await client.query(
          `INSERT INTO ledger_till_counts
            (batch_id,currency,expected_amount,counted_amount,variance_amount)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            batchId,
            currency,
            expected,
            counted,
            fixed(new Decimal(counted).minus(expected)),
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
        const response = await this.movementResponse(client, actor, existing.rows[0]);
        await client.query("COMMIT");
        return response;
      }
      const session = await this.openSession(client, actor);
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
      const carriesCost =
        input.counterpartyType === "vault" && input.currency !== home;
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
         A branch that has never stated a vault opening position returns
         null: nothing is balanced, because balancing against an unstated
         position would be inventing a number for somebody else's cash. */
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
      throw error;
    } finally {
      client.release();
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
