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

   Every one of those movements now carries COST as well as quantity, in the
   same transaction. A vault that moves cash without moving what the cash
   cost hands the receiving box units it cannot price, and the first sale out
   of that box is either refused or booked as pure profit. See
   docs/COST_BASIS.md.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { acquire, currentBasis, dispose, ensureBasis } from "./cost-basis.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type VaultCurrency = "CAD" | "USD" | "EUR" | "GBP";
export type VaultBalances = Partial<Record<VaultCurrency, string>>;
/* What a unit of the opening position cost, where the desk knows. Separate
   from `balances` rather than folded into it because the existing request
   shape — `{ balances: { CAD: "50000.00" } }` — is what every caller sends
   today, and a desk that cannot reconstruct what its safe cost must still be
   able to state what is in it. */
export type VaultUnitCosts = Partial<Record<VaultCurrency, string>>;

type ReceiveInput = {
  idempotencyKey: string;
  direction: "in" | "out";
  currency: VaultCurrency;
  amount: string;
  counterpartyType: "supplier" | "bank" | "other";
  counterpartyRef: string;
  reason: string;
  /* The home-currency price of the WHOLE movement: the supplier's invoice on
     a delivery in, the sum credited by the bank on a deposit out. A unit
     cost is this over the amount. Optional because a receipt can reach the
     desk before the invoice does. */
  costHome?: string;
};

/** One box that carries an average: a branch's vault, or one of its tills. */
export type CostBox = {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  locationKind: "till" | "vault";
  locationId: string;
};

/* A branch has exactly one vault, so the branch id IS the location id.
   `ledger_cost_events.location_id` is not nullable and should not be — an
   event that cannot say which box it moved explains nothing. */
export const vaultBox = (
  tenantId: string,
  legalEntityId: string,
  branchId: string,
): CostBox => ({
  tenantId,
  legalEntityId,
  branchId,
  locationKind: "vault",
  locationId: branchId,
});

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
   transaction — a float must see the same vault the run sees. Exported for
   the same reason the cost work needs it: the average a float carries out
   is taken against the vault's balance BEFORE the float, and reading that
   without holding the lock is reading a number that can still change. */
export async function lockVault(
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

/**
 * A unit cost to fall back on when cash has to leave a box whose basis was
 * never recorded — a float out of a safe that predates cost tracking, say.
 *
 * The desk's own published board rate is the only price on this server that
 * somebody actually stood behind, so it is what gets used. `ensureBasis`
 * labels the event `opening_estimated`, which is the whole point: a basis
 * still carrying this assumption can be found and corrected later instead of
 * passing as a price somebody paid.
 *
 * `units_per_cad` is units of the currency per Canadian dollar, so the home
 * cost of one unit is its reciprocal — but only while the home currency IS
 * the Canadian dollar. A London entity books in sterling, and a rate quoted
 * against somebody else's money is not a cost; that desk gets null here and
 * the caller skips the cost leg rather than invent a number.
 *
 * Null too when the branch has never published a rate for this currency.
 */
export async function boardUnitCostHome(
  client: pg.PoolClient,
  args: {
    tenantId: string;
    legalEntityId: string;
    branchId: string;
    currency: string;
    homeCurrency: string;
  },
): Promise<Decimal | null> {
  if (args.homeCurrency !== "CAD") return null;
  /* The board is published per workspace and the vault belongs to the whole
     branch, so there is no one workspace to ask. Every workspace at a branch
     quotes the same board in practice; taking the first by id at least makes
     the answer the same one every time it is asked. */
  const found = await client.query(
    `SELECT units_per_cad FROM ledger_rates
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND currency=$4
      ORDER BY workspace_id
      LIMIT 1`,
    [args.tenantId, args.legalEntityId, args.branchId, args.currency],
  );
  if (!found.rowCount) return null;
  const unitsPerCad = new Decimal(found.rows[0].units_per_cad);
  if (unitsPerCad.lte(0)) return null;
  return new Decimal(1).div(unitsPerCad);
}

/**
 * Carry cost from one box to another, inside the caller's transaction.
 *
 * A float, a return and an armoured run are TRANSFERS. Nothing is sold, so
 * nothing is realized: the sending box gives up units at its average and the
 * receiving box takes them in at that same unit cost, which is what the cash
 * cost the desk and has not changed by being carried down a corridor.
 *
 * Both bases must be the ones that stood BEFORE the quantities moved. The
 * weighted average is taken against the sending and receiving quantities as
 * they were; taken against balances that have already moved it is simply the
 * wrong number, and wrong in a way nothing ever complains about.
 *
 * Returns the unit cost that travelled, or null when none could — which is
 * not a failure. A vault whose basis was never recorded and whose currency
 * the branch has never published a rate for has nothing to send, and a made-up
 * figure would be worse than an absent one.
 */
export async function transferCost(
  client: pg.PoolClient,
  args: {
    from: CostBox;
    to: CostBox;
    currency: string;
    amount: Decimal.Value;
    fromBefore: { quantity: Decimal; avgCost: Decimal | null };
    toBefore: { quantity: Decimal; avgCost: Decimal | null };
    fallbackUnitCostHome: Decimal | null;
    sourceKind: string;
    sourceId: string;
    actorId: string;
    now: Date;
  },
): Promise<Decimal | null> {
  const from = { ...args.from, currency: args.currency };
  const to = { ...args.to, currency: args.currency };

  let unitCost = args.fromBefore.avgCost;
  if (unitCost === null && args.fromBefore.quantity.gt(0)) {
    if (args.fallbackUnitCostHome === null) return null;
    unitCost = await ensureBasis(client, from, {
      fallbackUnitCostHome: args.fallbackUnitCostHome,
      quantity: args.fromBefore.quantity,
      avgCost: null,
      actorId: args.actorId,
      now: args.now,
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
    });
  }
  if (unitCost === null) return null;

  const sent = await dispose(client, from, {
    quantity: args.amount,
    quantityBefore: args.fromBefore.quantity,
    avgCostBefore: unitCost,
    // no proceeds: moving your own cash between your own boxes earns nothing
    eventKind: "transfer_out",
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    actorId: args.actorId,
    now: args.now,
  });
  /* What the units ACTUALLY left at, which under FIFO is what the sending
     box's oldest lots cost and not its average. Acquiring at the average
     instead would change the book value of inventory as cash crosses
     between two of the desk's own boxes — money appearing or vanishing in
     a corridor. Under weighted average the two are the same number, which
     is exactly why this was invisible until FIFO existed. */
  await acquire(client, to, {
    quantity: args.amount,
    unitCostHome: sent.unitCost,
    quantityBefore: args.toBefore.quantity,
    avgCostBefore: args.toBefore.avgCost,
    eventKind: "transfer_in",
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    actorId: args.actorId,
    now: args.now,
  });
  return sent.unitCost;
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
     recorded movement.

     A desk may know what that cash cost and may not: the safe can predate
     this system entirely. Where a unit cost is given it is recorded as an
     `opening` event and becomes the basis. Where it is not, the basis stays
     unset — NOT zero, which would claim the money was free, and not the
     board mid either, because nothing is being priced yet. `ensureBasis`
     applies a figure at the first moment one is actually needed, and labels
     it as estimated so it can be found again. */
  async initialize(
    actor: LedgerActor,
    balances: VaultBalances,
    unitCosts: VaultUnitCosts = {},
  ) {
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
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;
      const box = vaultBox(actor.tenantId, actor.legalEntityId, actor.branchId);
      for (const [currency, amount] of Object.entries(balances)) {
        await client.query(
          `INSERT INTO ledger_vault_balances
            (tenant_id,legal_entity_id,branch_id,currency,available_amount)
           VALUES ($1,$2,$3,$4,$5)`,
          [...branchScope(actor), currency, fixed(amount!)],
        );
        const stated = unitCosts[currency as VaultCurrency];
        const quantity = new Decimal(fixed(amount!));
        /* The home currency is the unit everything else is measured in, so
           its cost is one by definition and it never carries an average — a
           cost stated for it is ignored rather than written. */
        if (!stated || currency === home || quantity.lte(0)) continue;
        await acquire(client, { ...box, currency }, {
          quantity,
          unitCostHome: stated,
          quantityBefore: new Decimal(0),
          avgCostBefore: null,
          eventKind: "opening",
          sourceKind: "vault_opening_position",
          sourceId: actor.branchId,
          actorId: actor.userId,
          now,
        });
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
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;
      const box = vaultBox(actor.tenantId, actor.legalEntityId, actor.branchId);
      const amount = new Decimal(fixed(input.amount));
      /* Lock and read before anything moves. The average this movement is
         weighted against is the one that stood BEFORE it, and a read taken
         after the balance changed is a different number that nothing
         downstream would flag. */
      await lockVault(client, actor.tenantId, actor.legalEntityId, actor.branchId);
      const priced = input.currency !== home;
      const before = priced
        ? await currentBasis(client, { ...box, currency: input.currency })
        : null;

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
      if (before) {
        await this.applyReceiptCost(client, actor, {
          box,
          input,
          amount,
          before,
          home,
          movementId: movementId!,
          now,
        });
      }
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

  /**
   * The cost side of a receipt, in the same transaction as the quantity.
   *
   * A delivery IN is an acquisition and the invoice is what it cost. A
   * deposit OUT is a disposal — the cash left the desk for good, so the gap
   * between what the bank credited and what those units cost is realized
   * here exactly as it would be on a sale over the counter.
   */
  private async applyReceiptCost(
    client: pg.PoolClient,
    actor: LedgerActor,
    args: {
      box: CostBox;
      input: ReceiveInput;
      amount: Decimal;
      before: { quantity: Decimal; avgCost: Decimal | null };
      home: string;
      movementId: string;
      now: Date;
    },
  ) {
    const scope = { ...args.box, currency: args.input.currency };
    const costHome = args.input.costHome ?? null;
    const common = {
      sourceKind: "vault_movement",
      sourceId: args.movementId,
      actorId: actor.userId,
      now: args.now,
    };
    if (args.amount.lte(0)) return;

    if (args.input.direction === "in") {
      /* What a delivery cost is knowable — somebody invoiced for it — so a
         stated price is used outright and nothing here estimates.

         With no price stated, the arriving cash takes the average already in
         the safe. That leaves the basis exactly where it was (blending an
         average into itself returns it), which is the point: the alternative
         is either inventing a price or letting the quantity move with no cost
         event at all, and the second one silently breaks the chain that lets
         anybody explain the number afterwards.

         A safe with no average and no stated price gets nothing — there is
         no figure to carry and no reason yet to guess one. */
      const unitCost = costHome
        ? new Decimal(costHome).div(args.amount)
        : args.before.avgCost;
      if (unitCost === null) return;
      await acquire(client, scope, {
        quantity: args.amount,
        unitCostHome: unitCost,
        quantityBefore: args.before.quantity,
        avgCostBefore: args.before.avgCost,
        eventKind: "delivery",
        ...common,
      });
      return;
    }

    /* Banking cash the desk has held since before cost tracking: give it a
       basis before disposing of it, rather than let a null basis book the
       entire deposit as profit. Where the branch has never published a rate
       for the currency there is nothing honest to fall back on, so the cost
       leg is skipped and the quantity moves alone — visibly incomplete
       rather than confidently wrong. */
    let avgCost = args.before.avgCost;
    if (avgCost === null && args.before.quantity.gt(0)) {
      const fallback = await boardUnitCostHome(client, {
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: args.box.branchId,
        currency: args.input.currency,
        homeCurrency: args.home,
      });
      if (fallback === null) return;
      avgCost = await ensureBasis(client, scope, {
        fallbackUnitCostHome: fallback,
        quantity: args.before.quantity,
        avgCost: null,
        ...common,
      });
    }
    if (avgCost === null) return;
    await dispose(client, scope, {
      quantity: args.amount,
      quantityBefore: args.before.quantity,
      avgCostBefore: avgCost,
      // what the bank actually credited, where the caller said. Without it
      // the units leave at cost and nothing is realized, which is the honest
      // answer to "we do not yet know what we got for this".
      proceedsHome: costHome,
      eventKind: "withdrawal",
      ...common,
    });
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

      /* A run is a transfer between two of the desk's own strong rooms, so
         the cash carries its cost across and nothing is realized — the money
         has not been sold, it has been driven somewhere. Both averages are
         read here, under the locks and before either balance moves, because
         a weighted average taken against a quantity that has already changed
         is wrong without ever looking wrong. */
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;
      const sending = vaultBox(actor.tenantId, actor.legalEntityId, actor.branchId);
      const receiving = vaultBox(
        actor.tenantId,
        actor.legalEntityId,
        input.toBranchId,
      );
      const priced = input.currency !== home;
      const sendingBefore = priced
        ? await currentBasis(client, { ...sending, currency: input.currency })
        : null;
      const receivingBefore = priced
        ? await currentBasis(client, { ...receiving, currency: input.currency })
        : null;

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
      if (sendingBefore && receivingBefore) {
        await transferCost(client, {
          from: sending,
          to: receiving,
          currency: input.currency,
          amount: new Decimal(fixed(input.amount)),
          fromBefore: sendingBefore,
          toBefore: receivingBefore,
          fallbackUnitCostHome: await boardUnitCostHome(client, {
            tenantId: actor.tenantId,
            legalEntityId: actor.legalEntityId,
            branchId: actor.branchId,
            currency: input.currency,
            homeCurrency: home,
          }),
          sourceKind: "vault_movement",
          sourceId: outId,
          actorId: actor.userId,
          now,
        });
      }
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
