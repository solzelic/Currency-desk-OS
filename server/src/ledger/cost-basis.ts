/* ============================================================
   What the cash cost, and what the desk made selling it.

   One rule, applied everywhere money enters or leaves a box:

     arriving   the average re-weights toward what was actually paid
     leaving    the average does not move; the difference between what
                was received and what those units cost is realized

   Nothing here estimates. A unit cost is either something that was paid,
   or it is an average of things that were paid, or the event says out loud
   that it was estimated. See docs/COST_BASIS.md.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";

export type LocationKind = "till" | "vault";

export type CostEventKind =
  | "opening"
  | "opening_estimated"
  | "purchase"
  | "delivery"
  | "transfer_in"
  | "transfer_out"
  | "sale"
  | "withdrawal"
  | "reversal";

/* A till is identified here by its till id rather than its workspace id,
   while `ledger_till_balances` is keyed by both. That is safe only because
   `workspaces_branch_till_idx` makes (branch, till) unique — so within a
   branch a till id names exactly one row. If that index is ever relaxed,
   this scope must carry the workspace id too, or one till's basis would be
   read while both tills' rows were written. */
type Scope = {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  locationKind: LocationKind;
  locationId: string;
  currency: string;
};

/* An average is a ratio, not a money amount. Rounding it to cents on every
   acquisition drifts the basis measurably over a day of trading, so it is
   carried at twelve places and only the money that comes out of it rounds. */
const COST_PLACES = 12;
const cost = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(COST_PLACES).toFixed(COST_PLACES);
const money = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2).toFixed(2);

const balanceTable = (kind: LocationKind) =>
  kind === "till" ? "ledger_till_balances" : "ledger_vault_balances";

/**
 * The average this box currently carries for this currency, and how much of
 * it there is. `avgCost` is null where the balance predates cost tracking —
 * which is not zero, because zero claims the cash was free.
 */
export async function currentBasis(
  client: pg.PoolClient,
  scope: Scope,
): Promise<{ quantity: Decimal; avgCost: Decimal | null }> {
  /* A vault has no till column to filter on, so its placeholders have to
     close up rather than leave a hole where $4 was: PostgreSQL refuses to
     prepare a statement that skips a parameter number ("could not determine
     data type of parameter $4"), so every vault read failed outright. */
  const where =
    scope.locationKind === "till"
      ? `tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND till_id=$4 AND currency=$5`
      : `tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND currency=$4`;
  const params =
    scope.locationKind === "till"
      ? [scope.tenantId, scope.legalEntityId, scope.branchId, scope.locationId, scope.currency]
      : [scope.tenantId, scope.legalEntityId, scope.branchId, scope.currency];
  const result = await client.query(
    `SELECT available_amount, avg_cost FROM ${balanceTable(scope.locationKind)}
      WHERE ${where}`,
    params,
  );
  if (!result.rowCount) return { quantity: new Decimal(0), avgCost: null };
  const row = result.rows[0];
  return {
    quantity: new Decimal(row.available_amount),
    avgCost: row.avg_cost == null ? null : new Decimal(row.avg_cost),
  };
}

async function writeAverage(
  client: pg.PoolClient,
  scope: Scope,
  avgCost: Decimal | null,
) {
  // same closed-up numbering as currentBasis, and for the same reason
  const where =
    scope.locationKind === "till"
      ? `tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND till_id=$5 AND currency=$6`
      : `tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND currency=$5`;
  const params =
    scope.locationKind === "till"
      ? [
          avgCost === null ? null : cost(avgCost),
          scope.tenantId,
          scope.legalEntityId,
          scope.branchId,
          scope.locationId,
          scope.currency,
        ]
      : [
          avgCost === null ? null : cost(avgCost),
          scope.tenantId,
          scope.legalEntityId,
          scope.branchId,
          scope.currency,
        ];
  await client.query(
    `UPDATE ${balanceTable(scope.locationKind)} SET avg_cost=$1 WHERE ${where}`,
    params,
  );
}

async function record(
  client: pg.PoolClient,
  scope: Scope,
  row: {
    eventKind: CostEventKind;
    direction: "in" | "out";
    quantity: Decimal;
    unitCost: Decimal;
    avgBefore: Decimal | null;
    avgAfter: Decimal | null;
    qtyBefore: Decimal;
    qtyAfter: Decimal;
    proceeds?: Decimal | null;
    realized?: Decimal | null;
    sourceKind: string;
    sourceId?: string | null;
    reversesEventId?: string | null;
    actorId: string;
    now: Date;
  },
): Promise<string> {
  const eventId = `cost_${randomUUID()}`;
  await client.query(
    `INSERT INTO ledger_cost_events
      (event_id,tenant_id,legal_entity_id,branch_id,location_kind,location_id,
       currency,event_kind,direction,quantity,unit_cost_home,
       avg_cost_before,avg_cost_after,quantity_before,quantity_after,
       proceeds_home,realized_pnl_home,source_kind,source_id,
       reverses_event_id,actor_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      eventId,
      scope.tenantId,
      scope.legalEntityId,
      scope.branchId,
      scope.locationKind,
      scope.locationId,
      scope.currency,
      row.eventKind,
      row.direction,
      money(row.quantity),
      cost(row.unitCost),
      row.avgBefore === null ? null : cost(row.avgBefore),
      row.avgAfter === null ? null : cost(row.avgAfter),
      money(row.qtyBefore),
      money(row.qtyAfter),
      row.proceeds == null ? null : money(row.proceeds),
      row.realized == null ? null : money(row.realized),
      row.sourceKind,
      row.sourceId ?? null,
      row.reversesEventId ?? null,
      row.actorId,
      row.now,
    ],
  );
  return eventId;
}

/**
 * Give cash that predates cost tracking a basis, once, before anything is
 * sold out of it.
 *
 * A desk that has been trading since before this existed holds real money
 * whose purchase price was never recorded. There are only bad options: refuse
 * to trade until somebody reconstructs it, or call it free and book the whole
 * of the next sale as profit. Both are worse than applying the best figure
 * available — the market mid at the moment it is first needed — and saying
 * plainly, in the event, that this is what was done.
 *
 * `opening_estimated` is queryable for exactly that reason: every basis still
 * carrying an assumption can be found and corrected, rather than passing
 * silently as something anybody paid.
 *
 * Does nothing when a basis is already known, or when there is nothing there.
 */
export async function ensureBasis(
  client: pg.PoolClient,
  scope: Scope,
  input: {
    fallbackUnitCostHome: Decimal.Value;
    quantity: Decimal;
    avgCost: Decimal | null;
    actorId: string;
    now: Date;
    sourceKind: string;
    sourceId?: string | null;
  },
): Promise<Decimal | null> {
  if (input.avgCost !== null) return input.avgCost;
  if (input.quantity.lte(0)) return null;
  const unitCost = new Decimal(input.fallbackUnitCostHome);
  await writeAverage(client, scope, unitCost);
  await record(client, scope, {
    eventKind: "opening_estimated",
    direction: "in",
    quantity: input.quantity,
    unitCost,
    avgBefore: null,
    avgAfter: unitCost,
    qtyBefore: new Decimal(0),
    qtyAfter: input.quantity,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    actorId: input.actorId,
    now: input.now,
  });
  return unitCost;
}

/**
 * Cash arrived. Re-weight the average toward what was actually paid for it.
 *
 * The caller has already moved the quantity; this is told the quantity that
 * was there BEFORE so the arithmetic is the real weighted average rather
 * than one taken against a balance that has already changed.
 */
export async function acquire(
  client: pg.PoolClient,
  scope: Scope,
  input: {
    quantity: Decimal.Value;
    unitCostHome: Decimal.Value;
    quantityBefore: Decimal;
    avgCostBefore: Decimal | null;
    eventKind: CostEventKind;
    sourceKind: string;
    sourceId?: string | null;
    actorId: string;
    now: Date;
  },
): Promise<{ eventId: string; avgCost: Decimal }> {
  const quantity = new Decimal(input.quantity);
  const unitCost = new Decimal(input.unitCostHome);
  const qtyBefore = input.quantityBefore;
  const qtyAfter = qtyBefore.add(quantity);

  /* A box holding nothing has no average to blend with, and a box whose
     basis is unknown cannot pretend the unknown part was free — in both
     cases the arriving cost becomes the average outright. */
  const blendable = input.avgCostBefore !== null && qtyBefore.gt(0);
  const avgAfter = blendable
    ? qtyBefore
        .mul(input.avgCostBefore!)
        .add(quantity.mul(unitCost))
        .div(qtyAfter)
    : unitCost;

  await writeAverage(client, scope, avgAfter);
  const eventId = await record(client, scope, {
    eventKind: input.eventKind,
    direction: "in",
    quantity,
    unitCost,
    avgBefore: input.avgCostBefore,
    avgAfter,
    qtyBefore,
    qtyAfter,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    actorId: input.actorId,
    now: input.now,
  });
  return { eventId, avgCost: avgAfter };
}

/**
 * Cash left. The average does not move — what moves is the money, and the
 * difference between what was received for those units and what they cost
 * is realized here and nowhere else.
 *
 * `proceeds` is what the desk actually received in home currency. Omit it
 * for a movement that is not a sale (a float, a return, a run): those carry
 * the cost out with them and realize nothing.
 */
export async function dispose(
  client: pg.PoolClient,
  scope: Scope,
  input: {
    quantity: Decimal.Value;
    quantityBefore: Decimal;
    avgCostBefore: Decimal | null;
    proceedsHome?: Decimal.Value | null;
    eventKind: CostEventKind;
    sourceKind: string;
    sourceId?: string | null;
    actorId: string;
    now: Date;
  },
): Promise<{
  eventId: string;
  unitCost: Decimal;
  costOfSale: Decimal;
  realized: Decimal | null;
}> {
  const quantity = new Decimal(input.quantity);
  const qtyBefore = input.quantityBefore;
  const qtyAfter = qtyBefore.minus(quantity);
  /* A basis of zero would book the whole proceeds as profit, which is the
     exact overstatement this file exists to prevent — so a disposal never
     reaches here with an unknown one. `ensureBasis` gives cash that predates
     cost tracking an opening basis first, recorded as estimated so it can be
     found and corrected. */
  if (input.avgCostBefore === null) {
    throw new Error(
      `cost basis missing for ${scope.currency} at ${scope.locationKind} ${scope.locationId}: call ensureBasis before disposing`,
    );
  }
  const unitCost = input.avgCostBefore;
  const costOfSale = quantity.mul(unitCost).toDecimalPlaces(2);
  const realized =
    input.proceedsHome == null
      ? null
      : new Decimal(input.proceedsHome).minus(costOfSale).toDecimalPlaces(2);

  /* Emptying the box does not clear its history, but it does clear its
     average — the next arrival starts a fresh basis rather than blending
     with the cost of cash that is no longer there. */
  const avgAfter = qtyAfter.lte(0) ? null : input.avgCostBefore;
  if (avgAfter === null) await writeAverage(client, scope, null);

  const eventId = await record(client, scope, {
    eventKind: input.eventKind,
    direction: "out",
    quantity,
    unitCost,
    avgBefore: input.avgCostBefore,
    avgAfter,
    qtyBefore,
    qtyAfter,
    proceeds: input.proceedsHome == null ? null : new Decimal(input.proceedsHome),
    realized,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    actorId: input.actorId,
    now: input.now,
  });
  return { eventId, unitCost, costOfSale, realized };
}

/**
 * Undo a cost event. A disposal being reversed puts the units back at the
 * cost they left at — not at today's average — and unwinds the realized
 * amount with them, which is why the events are kept.
 */
export async function reverseEvent(
  client: pg.PoolClient,
  eventId: string,
  input: { sourceKind: string; sourceId?: string | null; actorId: string; now: Date },
): Promise<{ eventId: string; realizedUnwound: Decimal | null } | null> {
  const found = await client.query(
    "SELECT * FROM ledger_cost_events WHERE event_id=$1",
    [eventId],
  );
  if (!found.rowCount) return null;
  const original = found.rows[0];
  const scope: Scope = {
    tenantId: original.tenant_id,
    legalEntityId: original.legal_entity_id,
    branchId: original.branch_id,
    locationKind: original.location_kind,
    locationId: original.location_id,
    currency: String(original.currency).trim(),
  };
  const basis = await currentBasis(client, scope);
  const quantity = new Decimal(original.quantity);
  const unitCost = new Decimal(original.unit_cost_home);

  if (original.direction === "out") {
    // the units come back, at what they left at
    const qtyBefore = basis.quantity.minus(quantity);
    const avgAfter =
      basis.avgCost !== null && qtyBefore.gt(0)
        ? qtyBefore.mul(basis.avgCost).add(quantity.mul(unitCost)).div(basis.quantity)
        : unitCost;
    await writeAverage(client, scope, avgAfter);
    const id = await record(client, scope, {
      eventKind: "reversal",
      direction: "in",
      quantity,
      unitCost,
      avgBefore: basis.avgCost,
      avgAfter,
      qtyBefore,
      qtyAfter: basis.quantity,
      realized:
        original.realized_pnl_home == null
          ? null
          : new Decimal(original.realized_pnl_home).neg(),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      reversesEventId: eventId,
      actorId: input.actorId,
      now: input.now,
    });
    return {
      eventId: id,
      realizedUnwound:
        original.realized_pnl_home == null
          ? null
          : new Decimal(original.realized_pnl_home).neg(),
    };
  }

  // an acquisition being undone: the units go back out at the cost they came in at
  const qtyBefore = basis.quantity.add(quantity);
  const avgAfter = basis.quantity.lte(0) ? null : basis.avgCost;
  if (avgAfter === null) await writeAverage(client, scope, null);
  const id = await record(client, scope, {
    eventKind: "reversal",
    direction: "out",
    quantity,
    unitCost,
    avgBefore: basis.avgCost,
    avgAfter,
    qtyBefore,
    qtyAfter: basis.quantity,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    reversesEventId: eventId,
    actorId: input.actorId,
    now: input.now,
  });
  return { eventId: id, realizedUnwound: null };
}

/** The events behind a basis, newest first — "explain this number". */
export async function basisHistory(
  client: pg.PoolClient,
  scope: Scope,
  limit: number,
) {
  const result = await client.query(
    `SELECT * FROM ledger_cost_events
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        AND location_kind=$4 AND location_id=$5 AND currency=$6
      ORDER BY created_at DESC, event_id DESC
      LIMIT $7`,
    [
      scope.tenantId,
      scope.legalEntityId,
      scope.branchId,
      scope.locationKind,
      scope.locationId,
      scope.currency,
      limit,
    ],
  );
  return result.rows;
}
