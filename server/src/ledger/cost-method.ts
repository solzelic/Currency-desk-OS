/* ============================================================
   How this desk costs its inventory.

   Weighted average and FIFO both value fungible stock legitimately, and
   on the same trades they report different profit in the short run. That
   makes the choice the owner's, not the code's and not the country's: a
   jurisdiction pack may SUGGEST a default, but a desk anywhere may run
   FIFO if it wants to.

   Two places hold the answer:

     jurisdiction_packs.default_cost_method   what the pack suggests
     legal_entities.cost_method               what this desk actually uses

   NULL on the entity is not a missing value. It means "follow the pack",
   which is where every desk starts and where it stays until somebody
   decides otherwise.

   This module is deliberately free of the ledger's service and
   authorization imports: cost-basis.ts reads it on every disposal, and
   service.ts already imports cost-basis.ts, so anything pulled in here
   would close a cycle. Changing the setting — which needs an actor, a
   permission and an audit row — lives in cost-method-control.ts.
   ============================================================ */
import type pg from "pg";

export type CostMethod = "weighted_average" | "fifo";

export const COST_METHODS: readonly CostMethod[] = ["weighted_average", "fifo"];

const asMethod = (value: unknown): CostMethod | null =>
  value === "fifo" ? "fifo" : value === "weighted_average" ? "weighted_average" : null;

export type CostMethodSetting = {
  /** what disposals are actually priced under */
  method: CostMethod;
  /** the entity's own choice, or null where it is following the pack */
  entityChoice: CostMethod | null;
  /** what the pack suggests, which is what null falls back to */
  packDefault: CostMethod;
};

/**
 * The entity's setting, resolved, inside the caller's transaction.
 *
 * Falls back to weighted average when the entity cannot be found at all.
 * The ledger is not always in the same database as the application tables
 * (see LEDGER_DATABASE_URL), and a book that silently switched method
 * because a lookup missed would be far worse than one that kept costing
 * the way it always has.
 */
export async function readCostMethod(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<CostMethodSetting> {
  const found = await client.query(
    `SELECT e.cost_method AS entity_method, p.default_cost_method AS pack_method
       FROM legal_entities e
       LEFT JOIN jurisdiction_packs p ON p.pack_id = e.jurisdiction_pack_id
      WHERE e.id = $1`,
    [legalEntityId],
  );
  const entityChoice = asMethod(found.rows[0]?.entity_method);
  const packDefault = asMethod(found.rows[0]?.pack_method) ?? "weighted_average";
  return { method: entityChoice ?? packDefault, entityChoice, packDefault };
}

/**
 * What this entity's disposals are priced under.
 *
 * Read per disposal rather than cached, for the same reason the
 * jurisdiction pack is: it is one small indexed read, and a stale answer
 * would misprice a sale — a worse thing to be wrong about than a query is
 * to spend.
 */
export async function resolveCostMethod(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<CostMethod> {
  return (await readCostMethod(client, legalEntityId)).method;
}
