/* ============================================================
   The vault — the branch's strong room, on the ledger.

   Money reaches a drawer from exactly one place, and until now the server
   had no opinion about whether that place had it. This gives the vault a
   balance per currency, refuses to let it go negative, and records every
   change as an append-only movement.

   Three ways money enters a vault:
     · an opening position, stated once when the desk goes live
     · a wholesale delivery or a bank withdrawal          (receive)
     · a drawer handing cash back at the end of a shift   (till return)

   Three ways it leaves:
     · floating a drawer                                  (till issue)
     · an armoured run to another branch                  (run)
     · a bank deposit                                     (receive, out)

   The till legs are applied from TillControlService inside ITS transaction,
   through applyVaultLeg below, so a float either moves both boxes or
   neither. That is the whole point of putting the vault here.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type VaultCurrency = "CAD" | "USD" | "EUR" | "GBP";
export type VaultBalances = Partial<Record<VaultCurrency, string>>;

type ReceiveInput = {
  idempotencyKey: string;
  direction: "in" | "out";
  currency: VaultCurrency;
  amount: string;
  counterpartyType: "supplier" | "bank" | "other";
  counterpartyRef: string;
  reason: string;
};

type RunInput = {
  idempotencyKey: string;
  toBranchId: string;
  currency: VaultCurrency;
  amount: string;
  reason: string;
};

const branchScope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
];
const fixed = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2).toFixed(2);

const movementJson = (row: Record<string, unknown>) => ({
  movementId: row.movement_id,
  branchId: row.branch_id,
  direction: row.direction,
  currency: String(row.currency).trim(),
  amount: row.amount,
  counterpartyType: row.counterparty_type,
  counterpartyRef: row.counterparty_ref,
  relatedMovementId: row.related_movement_id ?? null,
  reason: row.reason,
  actorId: row.actor_id,
  createdAt: new Date(row.created_at as string | Date).toISOString(),
});

/* Read a branch's vault, locking the rows we are about to change. Kept
   free-standing because TillControlService needs it inside its own
   transaction — a float must see the same vault the run sees. */
async function lockVault(
  client: pg.PoolClient,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
) {
  const result = await client.query(
    `SELECT currency,available_amount
       FROM ledger_vault_balances
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
      ORDER BY currency
      FOR UPDATE`,
    [tenantId, legalEntityId, branchId],
  );
  return result.rows as { currency: string; available_amount: string }[];
}

/** Has this branch ever stated a vault position? */
export async function vaultIsTracked(
  client: pg.PoolClient,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
) {
  const result = await client.query(
    `SELECT EXISTS(
       SELECT 1 FROM ledger_vault_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
     ) AS tracked`,
    [tenantId, legalEntityId, branchId],
  );
  return Boolean(result.rows[0].tracked);
}

/**
 * Move one currency in or out of a branch vault and record it, inside the
 * caller's transaction. Returns the movement id, or null when this branch
 * has no vault position on the ledger yet — a desk that has not stated its
 * opening vault is not silently balanced against zero, because zero is a
 * claim about their money that nobody made.
 */
export async function applyVaultLeg(
  client: pg.PoolClient,
  args: {
    tenantId: string;
    legalEntityId: string;
    branchId: string;
    direction: "in" | "out";
    currency: string;
    amount: Decimal.Value;
    counterpartyType: "till" | "vault" | "supplier" | "bank" | "other";
    counterpartyRef: string;
    relatedMovementId?: string | null;
    reason: string;
    actorId: string;
    idempotencyKey: string;
    now: Date;
    /* Both legs of a run point at each other, so their ids are minted by the
       caller before either row exists. These rows are append-only — there is
       no second pass to fill the link in afterwards. */
    movementId?: string;
  },
) {
  const tracked = await vaultIsTracked(
    client,
    args.tenantId,
    args.legalEntityId,
    args.branchId,
  );
  if (!tracked) return null;

  const balances = await lockVault(
    client,
    args.tenantId,
    args.legalEntityId,
    args.branchId,
  );
  const held = balances.find(
    (row) => row.currency.trim() === args.currency,
  );
  const amount = new Decimal(args.amount).toDecimalPlaces(2);
  const current = new Decimal(held?.available_amount ?? 0);
  const next = args.direction === "in" ? current.add(amount) : current.minus(amount);
  if (next.lt(0)) {
    throw new LedgerError(
      "INSUFFICIENT_VAULT_LIQUIDITY",
      `The vault holds ${fixed(current)} ${args.currency} — this movement would overdraw it.`,
    );
  }
  if (held) {
    await client.query(
      `UPDATE ledger_vault_balances
          SET available_amount=$1
        WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
          AND currency=$5`,
      [fixed(next), args.tenantId, args.legalEntityId, args.branchId, args.currency],
    );
  } else {
    await client.query(
      `INSERT INTO ledger_vault_balances
        (tenant_id,legal_entity_id,branch_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.tenantId, args.legalEntityId, args.branchId, args.currency, fixed(next)],
    );
  }
  const movementId = args.movementId ?? `vault_move_${randomUUID()}`;
  await client.query(
    `INSERT INTO ledger_vault_movements
      (movement_id,tenant_id,legal_entity_id,branch_id,direction,currency,amount,
       counterparty_type,counterparty_ref,related_movement_id,reason,actor_id,
       idempotency_key,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      movementId,
      args.tenantId,
      args.legalEntityId,
      args.branchId,
      args.direction,
      args.currency,
      fixed(amount),
      args.counterpartyType,
      args.counterpartyRef,
      args.relatedMovementId ?? null,
      args.reason,
      args.actorId,
      args.idempotencyKey,
      args.now,
    ],
  );
  return movementId;
}

export class VaultControlService {
  constructor(private readonly pool: pg.Pool) {}

  /* The actor's own vault, plus every other branch they are authorized for
     — the vault-run picker cannot offer a destination it may not read. */
  async current(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "vault:view");
      const branchIds = Array.from(
        new Set([actor.branchId, ...actor.authorizedBranchIds]),
      );
      const rows = await client.query(
        `SELECT branch_id,currency,available_amount
           FROM ledger_vault_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id = ANY($3)
          ORDER BY branch_id,currency`,
        [actor.tenantId, actor.legalEntityId, branchIds],
      );
      await client.query("COMMIT");
      const byBranch: Record<string, Record<string, string>> = {};
      for (const branchId of branchIds) byBranch[branchId] = {};
      for (const row of rows.rows) {
        byBranch[row.branch_id] ??= {};
        byBranch[row.branch_id]![row.currency.trim()] = row.available_amount;
      }
      return {
        branchId: actor.branchId,
        tracked: Object.keys(byBranch[actor.branchId] ?? {}).length > 0,
        balances: byBranch[actor.branchId] ?? {},
        branches: byBranch,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* The opening position — what is in the safe on the day the ledger takes
     over. Stated once; after that the only way the number changes is a
     recorded movement. */
  async initialize(actor: LedgerActor, balances: VaultBalances) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "vault:initialize");
      if (await vaultIsTracked(client, actor.tenantId, actor.legalEntityId, actor.branchId)) {
        throw new LedgerError(
          "VAULT_ALREADY_INITIALIZED",
          "This branch vault already has an opening position.",
        );
      }
      const now = new Date();
      for (const [currency, amount] of Object.entries(balances)) {
        await client.query(
          `INSERT INTO ledger_vault_balances
            (tenant_id,legal_entity_id,branch_id,currency,available_amount)
           VALUES ($1,$2,$3,$4,$5)`,
          [...branchScope(actor), currency, fixed(amount!)],
        );
      }
      await this.audit(
        client,
        actor,
        "vault.opening_position",
        actor.branchId,
        JSON.stringify(balances),
        now,
      );
      await client.query("COMMIT");
      return this.current(actor);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* Money crossing the desk's outer boundary: a wholesale delivery in, a
     bank deposit out. Nothing else on the ledger balances against it,
     which is exactly what makes it the boundary. */
  async receive(actor: LedgerActor, input: ReceiveInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "vault:move");
      const existing = await this.replay(client, actor.branchId, actor, input.idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      await this.requireTracked(client, actor, actor.branchId);
      const now = new Date();
      const movementId = await applyVaultLeg(client, {
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        direction: input.direction,
        currency: input.currency,
        amount: input.amount,
        counterpartyType: input.counterpartyType,
        counterpartyRef: input.counterpartyRef,
        reason: input.reason,
        actorId: actor.userId,
        idempotencyKey: input.idempotencyKey,
        now,
      });
      await this.audit(
        client,
        actor,
        "vault.receive",
        movementId!,
        `${input.direction} ${fixed(input.amount)} ${input.currency}; ${input.reason}`,
        now,
      );
      const response = await this.snapshot(client, actor, movementId!);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.conflict(error);
    } finally {
      client.release();
    }
  }

  /* An armoured run between two branches. Two legs, one transaction: the
     money is never in both strong rooms and never in neither. */
  async run(actor: LedgerActor, input: RunInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "vault:move");
      if (input.toBranchId === actor.branchId) {
        throw new LedgerError(
          "INVALID_REQUEST",
          "A vault run needs two different branches.",
        );
      }
      /* the destination is somebody else's strong room — the actor has to
         be authorized for it, not merely know its id */
      if (!actor.authorizedBranchIds.includes(input.toBranchId)) {
        throw new LedgerError(
          "AUTHORIZATION_DENIED",
          "You are not authorized for the receiving branch.",
        );
      }
      /* No existence check against `branches` here on purpose: that table
         belongs to the application database, which is not always the same
         database as the ledger. The two checks that follow are stronger
         anyway — the operator must be authorized for the destination, and
         the destination must have stated a vault position. A branch that
         satisfies both is real by construction. */
      const existing = await this.replay(client, actor.branchId, actor, input.idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      await this.requireTracked(client, actor, actor.branchId);
      await this.requireTracked(client, actor, input.toBranchId);

      const now = new Date();
      /* lock the two vaults in a stable order so two runs in opposite
         directions cannot deadlock against each other */
      const [first, second] = [actor.branchId, input.toBranchId].sort();
      await lockVault(client, actor.tenantId, actor.legalEntityId, first!);
      await lockVault(client, actor.tenantId, actor.legalEntityId, second!);

      const outId = `vault_move_${randomUUID()}`;
      const inId = `vault_move_${randomUUID()}`;
      await applyVaultLeg(client, {
        movementId: outId,
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        direction: "out",
        currency: input.currency,
        amount: input.amount,
        counterpartyType: "vault",
        counterpartyRef: input.toBranchId,
        relatedMovementId: inId,
        reason: input.reason,
        actorId: actor.userId,
        idempotencyKey: input.idempotencyKey,
        now,
      });
      await applyVaultLeg(client, {
        movementId: inId,
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: input.toBranchId,
        direction: "in",
        currency: input.currency,
        amount: input.amount,
        counterpartyType: "vault",
        counterpartyRef: actor.branchId,
        relatedMovementId: outId,
        reason: input.reason,
        actorId: actor.userId,
        idempotencyKey: input.idempotencyKey,
        now,
      });
      await this.audit(
        client,
        actor,
        "vault.run",
        outId,
        `${fixed(input.amount)} ${input.currency}; ${actor.branchId} → ${input.toBranchId}; ${input.reason}`,
        now,
      );
      const response = await this.snapshot(client, actor, outId);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw this.conflict(error);
    } finally {
      client.release();
    }
  }

  async movements(actor: LedgerActor, limit: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "vault:view");
      const branchIds = Array.from(
        new Set([actor.branchId, ...actor.authorizedBranchIds]),
      );
      const rows = await client.query(
        `SELECT * FROM ledger_vault_movements
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id = ANY($3)
          ORDER BY created_at DESC, movement_id DESC
          LIMIT $4`,
        [actor.tenantId, actor.legalEntityId, branchIds, limit],
      );
      await client.query("COMMIT");
      return { movements: rows.rows.map(movementJson) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireTracked(
    client: pg.PoolClient,
    actor: LedgerActor,
    branchId: string,
  ) {
    if (!(await vaultIsTracked(client, actor.tenantId, actor.legalEntityId, branchId))) {
      throw new LedgerError(
        "VAULT_NOT_INITIALIZED",
        branchId === actor.branchId
          ? "State this vault's opening position before moving cash through it."
          : "The receiving branch has not stated its vault opening position yet.",
      );
    }
  }

  /* An idempotency key already used at this branch means the caller is
     retrying — hand back what happened the first time rather than moving
     the money twice. */
  private async replay(
    client: pg.PoolClient,
    branchId: string,
    actor: LedgerActor,
    idempotencyKey: string,
  ) {
    const found = await client.query(
      `SELECT movement_id FROM ledger_vault_movements
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND idempotency_key=$4`,
      [actor.tenantId, actor.legalEntityId, branchId, idempotencyKey],
    );
    if (!found.rowCount) return null;
    return this.snapshot(client, actor, found.rows[0].movement_id);
  }

  private async snapshot(
    client: pg.PoolClient,
    actor: LedgerActor,
    movementId: string,
  ) {
    const movement = await client.query(
      "SELECT * FROM ledger_vault_movements WHERE movement_id=$1",
      [movementId],
    );
    const branchIds = Array.from(
      new Set([actor.branchId, ...actor.authorizedBranchIds]),
    );
    const rows = await client.query(
      `SELECT branch_id,currency,available_amount
         FROM ledger_vault_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id = ANY($3)
        ORDER BY branch_id,currency`,
      [actor.tenantId, actor.legalEntityId, branchIds],
    );
    const byBranch: Record<string, Record<string, string>> = {};
    for (const branchId of branchIds) byBranch[branchId] = {};
    for (const row of rows.rows) {
      byBranch[row.branch_id] ??= {};
      byBranch[row.branch_id]![row.currency.trim()] = row.available_amount;
    }
    return {
      movement: movement.rowCount ? movementJson(movement.rows[0]) : null,
      branchId: actor.branchId,
      tracked: Object.keys(byBranch[actor.branchId] ?? {}).length > 0,
      balances: byBranch[actor.branchId] ?? {},
      branches: byBranch,
    };
  }

  private conflict(error: unknown) {
    if ((error as { code?: string }).code === "23505") {
      return new LedgerError(
        "IDEMPOTENCY_CONFLICT",
        "That vault movement was already recorded.",
      );
    }
    return error;
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
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
        actor.workspaceId,
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
