/* ============================================================
   What the cash cost, and what the desk made selling it.

   Money arriving always does the same thing: it re-weights the box's
   average toward what was actually paid, and it opens a LOT — one row
   saying how much arrived, what a unit of it cost, and how much of it is
   left. Money leaving draws those lots down oldest first.

   What differs between the two costing methods is only how a disposal is
   PRICED:

     weighted average   units leave at the box's running average
     FIFO               units leave at what the oldest lots actually cost

   Both are legitimate, they report different profit on identical trades
   in the short run, and the desk chooses — see cost-method.ts. Lots are
   maintained under both, always, because a desk that switches after a
   year of trading must have real acquisitions to compute from rather
   than an invented history.

   Nothing here estimates. A unit cost is either something that was paid,
   or it is an average of things that were paid, or the event says out loud
   that it was estimated. See docs/COST_BASIS.md.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { resolveCostMethod, type CostMethod } from "./cost-method.js";

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
    costMethod?: CostMethod | null;
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
       reverses_event_id,actor_id,created_at,cost_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
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
      row.costMethod ?? null,
    ],
  );
  return eventId;
}

/* ------------------------------------------------------------
   Lots — one row per acquisition, drawn down oldest first.
   ------------------------------------------------------------ */

const LOT_SCOPE = `tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
   AND location_kind=$4 AND location_id=$5 AND currency=$6`;

const lotScopeParams = (scope: Scope) => [
  scope.tenantId,
  scope.legalEntityId,
  scope.branchId,
  scope.locationKind,
  scope.locationId,
  scope.currency,
];

type OpenLot = { lotId: string; unitCost: Decimal; remaining: Decimal };

/**
 * Record an acquisition as a lot. Called on every arrival under both
 * methods — see the header for why the FIFO-only version of this is a trap.
 */
async function openLot(
  client: pg.PoolClient,
  scope: Scope,
  input: {
    quantity: Decimal;
    unitCost: Decimal;
    acquiredAt: Date;
    eventId: string | null;
  },
): Promise<string | null> {
  // nothing arrived, so there is no acquisition to record
  if (input.quantity.lte(0)) return null;
  const lotId = `lot_${randomUUID()}`;
  await client.query(
    `INSERT INTO ledger_cost_lots
      (lot_id,tenant_id,legal_entity_id,branch_id,location_kind,location_id,
       currency,quantity,unit_cost_home,remaining_quantity,acquired_at,event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      lotId,
      ...lotScopeParams(scope),
      money(input.quantity),
      cost(input.unitCost),
      // a lot that has just been opened has had nothing taken out of it yet
      money(input.quantity),
      input.acquiredAt,
      input.eventId,
    ],
  );
  return lotId;
}

/**
 * The box's open lots, oldest first, locked for the length of the caller's
 * transaction.
 *
 * `acquired_at, lot_id` rather than `acquired_at` alone: two lots can share
 * a timestamp to the microsecond — a cross posts both legs at one `now` —
 * and FIFO that consumes them in whatever order the planner returned would
 * price the same trades differently on two identical databases.
 */
async function openLots(
  client: pg.PoolClient,
  scope: Scope,
): Promise<OpenLot[]> {
  const found = await client.query(
    `SELECT lot_id, unit_cost_home, remaining_quantity
       FROM ledger_cost_lots
      WHERE ${LOT_SCOPE} AND remaining_quantity > 0
      ORDER BY acquired_at, lot_id
      FOR UPDATE`,
    lotScopeParams(scope),
  );
  return found.rows.map((row) => ({
    lotId: row.lot_id,
    unitCost: new Decimal(row.unit_cost_home),
    remaining: new Decimal(row.remaining_quantity),
  }));
}

/**
 * Make the lots account for everything the box is holding, so a disposal
 * cannot draw against stock no lot knows about.
 *
 * Two ways a box comes to hold units with no lot behind them. It was
 * trading before any of this existed — migration 014 reconstructs those
 * once. Or cash moved through a path that had no cost to carry: a float
 * out of a safe with no basis moves the quantity and writes no cost event
 * at all, deliberately, because inventing a price is worse. Either way the
 * only figure that exists for the shortfall is the average the box already
 * carries, which is what it gets.
 *
 * The reconstructed lot is dated `now` rather than backdated ahead of the
 * known ones. Backdating would push it to the front of the FIFO queue and
 * let a figure nobody recorded displace lots whose cost was actually
 * observed; all that is really known about this shortfall is that it is
 * here now.
 */
async function ensureLotCoverage(
  client: pg.PoolClient,
  scope: Scope,
  input: { quantityBefore: Decimal; unitCost: Decimal; now: Date },
) {
  const found = await client.query(
    `SELECT COALESCE(sum(remaining_quantity),0) AS qty
       FROM ledger_cost_lots
      WHERE ${LOT_SCOPE} AND remaining_quantity > 0`,
    lotScopeParams(scope),
  );
  const covered = new Decimal(found.rows[0].qty);
  const shortfall = input.quantityBefore.minus(covered);
  if (shortfall.lte(0)) return;
  await openLot(client, scope, {
    quantity: shortfall,
    unitCost: input.unitCost,
    acquiredAt: input.now,
    eventId: null,
  });
}

/**
 * Take `quantity` out of the open lots, oldest first, and say what each
 * take cost. Nothing is written — the disposal event has to exist before
 * the consumption rows can point at it.
 */
function planConsumption(
  lots: OpenLot[],
  quantity: Decimal,
): { lot: OpenLot; taken: Decimal }[] {
  const plan: { lot: OpenLot; taken: Decimal }[] = [];
  let left = quantity;
  for (const lot of lots) {
    if (left.lte(0)) break;
    const taken = Decimal.min(lot.remaining, left);
    if (taken.lte(0)) continue;
    plan.push({ lot, taken });
    left = left.minus(taken);
  }
  return plan;
}

async function applyConsumption(
  client: pg.PoolClient,
  eventId: string,
  plan: { lot: OpenLot; taken: Decimal }[],
  now: Date,
) {
  for (const { lot, taken } of plan) {
    await client.query(
      `UPDATE ledger_cost_lots
          SET remaining_quantity = remaining_quantity - $1
        WHERE lot_id = $2`,
      [money(taken), lot.lotId],
    );
    await client.query(
      `INSERT INTO ledger_cost_lot_consumption
        (consumption_id,event_id,lot_id,quantity,unit_cost_home,cost_home,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        `lotuse_${randomUUID()}`,
        eventId,
        lot.lotId,
        money(taken),
        cost(lot.unitCost),
        money(taken.mul(lot.unitCost)),
        now,
      ],
    );
  }
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
  const eventId = await record(client, scope, {
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
  /* This stock needs a lot as much as a purchase does. It is the whole of
     what the box holds, and without a lot a FIFO disposal would find the
     box empty of acquisitions and price the sale against nothing. The lot
     carries the same estimated figure the event does — the estimate is
     labelled once, in the event, and is not laundered into fact here. */
  await openLot(client, scope, {
    quantity: input.quantity,
    unitCost,
    acquiredAt: input.now,
    eventId,
  });
  return unitCost;
}

/**
 * Cash arrived. Re-weight the average toward what was actually paid for it,
 * and open a lot for it.
 *
 * The caller has already moved the quantity; this is told the quantity that
 * was there BEFORE so the arithmetic is the real weighted average rather
 * than one taken against a balance that has already changed.
 *
 * The lot is opened under both costing methods. Nothing about an
 * acquisition depends on which one is switched on — what a unit cost is
 * what was paid for it either way — and a desk with no lots is a desk that
 * cannot turn FIFO on without inventing a past.
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
  await openLot(client, scope, {
    quantity,
    unitCost,
    acquiredAt: input.now,
    eventId,
  });
  return { eventId, avgCost: avgAfter };
}

/**
 * Cash left. The difference between what was received for those units and
 * what they cost is realized here and nowhere else.
 *
 * What "what they cost" means is the desk's choice:
 *
 *   weighted average   the box's running average, which does not move
 *   FIFO               the oldest lots, at what those lots actually cost
 *
 * The method is looked up here rather than passed in. Every call site —
 * a customer sale, a float, an armoured run, a bank deposit — would
 * otherwise have to fetch and thread through a setting that none of them
 * has any business knowing about, and a single one that forgot would
 * quietly price its disposals under the wrong method.
 *
 * `proceeds` is what the desk actually received in home currency. Omit it
 * for a movement that is not a sale (a float, a return, a run): those carry
 * the cost out with them and realize nothing.
 *
 * The returned figures are what the disposal ACTUALLY applied, which under
 * FIFO is not the box's average, and callers must post from them rather
 * than doing the arithmetic again for themselves. A transfer's receiving
 * leg acquires at `unitCost` — anything else changes the value of the cash
 * as it crosses between two of the desk's own boxes — and a sale's journal
 * carries `costOfSale` and `realized`, or the journal and the cost events
 * describe the same deal differently.
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
  const method = await resolveCostMethod(client, scope.legalEntityId);

  /* The lots are drawn down under BOTH methods, so they never fall out of
     step with the balance and a desk that switches later finds a true
     position rather than a half-consumed one. Coverage is topped up first
     for the same reason. */
  await ensureLotCoverage(client, scope, {
    quantityBefore: qtyBefore,
    unitCost: input.avgCostBefore,
    now: input.now,
  });
  const lots = await openLots(client, scope);
  const plan = planConsumption(lots, quantity);
  const takenFromLots = plan.reduce(
    (total, entry) => total.add(entry.taken),
    new Decimal(0),
  );
  const lotCost = plan.reduce(
    (total, entry) => total.add(entry.taken.mul(entry.lot.unitCost)),
    new Decimal(0),
  );

  /* Under FIFO the cost of sale is what those specific lots cost. Where
     the lots cannot cover the whole disposal — the caller's `quantityBefore`
     disagreed with the position, which is a bug elsewhere, not a licence to
     book free stock — the shortfall falls back to the average rather than
     costing nothing. */
  const shortfall = quantity.minus(takenFromLots);
  const fifoCost = lotCost.add(shortfall.mul(input.avgCostBefore));
  const costOfSale =
    method === "fifo"
      ? fifoCost.toDecimalPlaces(2)
      : quantity.mul(input.avgCostBefore).toDecimalPlaces(2);
  /* The unit cost this disposal actually applied. Under weighted average
     that is the running average, exactly — taken from the rounded cost of
     sale instead it would come back as 1.200004508414, a ratio nobody
     carries. Under FIFO it is the blend of the lots consumed, which is a
     fact about this sale and not a basis anything else prices against. */
  const unitCost =
    method === "fifo" && quantity.gt(0)
      ? fifoCost.div(quantity)
      : input.avgCostBefore;
  const realized =
    input.proceedsHome == null
      ? null
      : new Decimal(input.proceedsHome).minus(costOfSale).toDecimalPlaces(2);

  /* Emptying the box does not clear its history, but it does clear its
     average — the next arrival starts a fresh basis rather than blending
     with the cost of cash that is no longer there.

     Under FIFO the average is informational only: the Vault's position
     screen shows it, and nothing prices against it. It is what the lots
     that are LEFT are worth per unit, computed from the plan rather than
     re-read afterwards, because a cost event is append-only and cannot be
     told its own outcome once it has been written. */
  const remainingAfter = lots
    .reduce((total, lot) => total.add(lot.remaining), new Decimal(0))
    .minus(takenFromLots);
  const valueAfter = lots
    .reduce((total, lot) => total.add(lot.remaining.mul(lot.unitCost)), new Decimal(0))
    .minus(lotCost);
  const avgAfter = qtyAfter.lte(0)
    ? null
    : method === "fifo"
      ? remainingAfter.gt(0)
        ? valueAfter.div(remainingAfter)
        : input.avgCostBefore
      : input.avgCostBefore;
  /* Weighted average leaves the column alone unless the box emptied; FIFO
     rewrites it every time, because which lots are left has changed. */
  if (avgAfter === null || method === "fifo") {
    await writeAverage(client, scope, avgAfter);
  }

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
    costMethod: method,
    actorId: input.actorId,
    now: input.now,
  });
  await applyConsumption(client, eventId, plan, input.now);
  return { eventId, unitCost, costOfSale, realized };
}

/** What the open lots hold, and what that is worth, in one read. */
async function openLotTotals(
  client: pg.PoolClient,
  scope: Scope,
): Promise<{ quantity: Decimal; value: Decimal }> {
  const found = await client.query(
    `SELECT COALESCE(sum(remaining_quantity),0) AS qty,
            COALESCE(sum(remaining_quantity * unit_cost_home),0) AS value
       FROM ledger_cost_lots
      WHERE ${LOT_SCOPE} AND remaining_quantity > 0`,
    lotScopeParams(scope),
  );
  return {
    quantity: new Decimal(found.rows[0].qty),
    value: new Decimal(found.rows[0].value),
  };
}

/**
 * Undo a cost event. A disposal being reversed puts the units back at the
 * cost they left at — not at today's average — and unwinds the realized
 * amount with them, which is why the events are kept.
 *
 * Under FIFO "at the cost they left at" is not one number. The sale drew
 * from particular lots at particular prices, and putting the units back
 * means putting each one back where it came from — otherwise the next sale
 * prices against a queue that no longer matches the cash. That is what the
 * consumption rows are for, and it is why they are written under weighted
 * average too: a desk can sell under one method and reverse under the
 * other, and the reversal has to undo what actually happened rather than
 * what today's setting would have done.
 *
 * Reversing twice restores nothing twice: a consumption row is marked with
 * the reversal that put it back and is never considered again.
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
  const method = await resolveCostMethod(client, scope.legalEntityId);
  const lotsBefore = await openLotTotals(client, scope);

  if (original.direction === "out") {
    // the units come back, into the lots they were taken out of
    const restoring = await client.query(
      `SELECT consumption_id, lot_id, quantity, unit_cost_home
         FROM ledger_cost_lot_consumption
        WHERE event_id=$1 AND reversed_by_event_id IS NULL
        FOR UPDATE`,
      [eventId],
    );
    const restored = restoring.rows.reduce(
      (total, row) => total.add(new Decimal(row.quantity)),
      new Decimal(0),
    );
    const restoredValue = restoring.rows.reduce(
      (total, row) =>
        total.add(new Decimal(row.quantity).mul(new Decimal(row.unit_cost_home))),
      new Decimal(0),
    );

    const qtyBefore = basis.quantity.minus(quantity);
    /* Weighted average blends the returning units into what is there now.
       FIFO reads the position it will actually have once the lots are put
       back — the same figure, arrived at from the lots rather than from an
       average that FIFO never prices against anyway. */
    const lotAverage = lotsBefore.quantity.add(restored).gt(0)
      ? lotsBefore.value.add(restoredValue).div(lotsBefore.quantity.add(restored))
      : null;
    const avgAfter =
      method === "fifo"
        ? (lotAverage ?? unitCost)
        : basis.avgCost !== null && qtyBefore.gt(0)
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
      /* the method the ORIGINAL sale was priced under, because that is what
         this event unwinds — not whatever is switched on today */
      costMethod: original.cost_method ?? null,
      actorId: input.actorId,
      now: input.now,
    });
    for (const row of restoring.rows) {
      await client.query(
        `UPDATE ledger_cost_lots
            SET remaining_quantity = remaining_quantity + $1
          WHERE lot_id = $2`,
        [row.quantity, row.lot_id],
      );
      await client.query(
        "UPDATE ledger_cost_lot_consumption SET reversed_by_event_id=$1 WHERE consumption_id=$2",
        [id, row.consumption_id],
      );
    }
    return {
      eventId: id,
      realizedUnwound:
        original.realized_pnl_home == null
          ? null
          : new Decimal(original.realized_pnl_home).neg(),
    };
  }

  /* An acquisition being undone: the units go back out at the cost they
     came in at, which means out of the lot that acquisition opened.

     If a later sale has already eaten into that lot, only what is left of
     it can be taken back — the rest is genuinely gone, and taking it from
     some other lot would charge one purchase's reversal against a different
     purchase's cash. */
  const lotOfEvent = await client.query(
    `SELECT lot_id, unit_cost_home, remaining_quantity
       FROM ledger_cost_lots
      WHERE event_id=$1
      FOR UPDATE`,
    [eventId],
  );
  const plan = planConsumption(
    lotOfEvent.rows.map((row) => ({
      lotId: row.lot_id,
      unitCost: new Decimal(row.unit_cost_home),
      remaining: new Decimal(row.remaining_quantity),
    })),
    quantity,
  );
  const withdrawn = plan.reduce((total, entry) => total.add(entry.taken), new Decimal(0));
  const withdrawnValue = plan.reduce(
    (total, entry) => total.add(entry.taken.mul(entry.lot.unitCost)),
    new Decimal(0),
  );

  const qtyBefore = basis.quantity.add(quantity);
  const lotQtyAfter = lotsBefore.quantity.minus(withdrawn);
  const avgAfter = basis.quantity.lte(0)
    ? null
    : method === "fifo"
      ? lotQtyAfter.gt(0)
        ? lotsBefore.value.minus(withdrawnValue).div(lotQtyAfter)
        : basis.avgCost
      : basis.avgCost;
  if (avgAfter === null || method === "fifo") {
    await writeAverage(client, scope, avgAfter);
  }
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
  await applyConsumption(client, id, plan, input.now);
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
