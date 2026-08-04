/* ============================================================
   Reading and changing the desk's costing method.

   Separate from cost-method.ts because this half needs the actor, the
   permission table and the audit log, and cost-basis.ts must be able to
   read the setting without dragging any of that in. See the header there.

   Changing the method changes reported profit. So it takes an owner or
   manager permission, and it writes `ledger_audit_events`: who flipped
   it, when, and from what to what. "The margin moved last month and
   nobody knows why" is the failure this exists to prevent.
   ============================================================ */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";
import {
  readCostMethod,
  type CostMethod,
  type CostMethodSetting,
} from "./cost-method.js";

export class CostMethodService {
  constructor(private readonly pool: pg.Pool) {}

  async current(actor: LedgerActor): Promise<CostMethodSetting> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const setting = await readCostMethod(client, actor.legalEntityId);
      await client.query("COMMIT");
      return setting;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Set what the desk costs by, or hand the decision back to the pack with
   * a `choice` of null.
   *
   * Nothing already posted is restated. The lots and the events behind
   * every existing sale stay exactly as they were; what changes is how the
   * NEXT disposal is priced. That is the honest behaviour and it is also
   * the only safe one — rewriting a month of realized P&L because a switch
   * was flipped would silently move numbers somebody has already reported.
   */
  async set(
    actor: LedgerActor,
    choice: CostMethod | null,
  ): Promise<CostMethodSetting> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "accounting:cost_method");
      const before = await readCostMethod(client, actor.legalEntityId);
      const updated = await client.query(
        "UPDATE legal_entities SET cost_method=$1 WHERE id=$2",
        [choice, actor.legalEntityId],
      );
      if (!updated.rowCount) {
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its costing method cannot be set here.",
        );
      }
      const after = await readCostMethod(client, actor.legalEntityId);
      /* Audited even when the effective method does not move — switching
         from "follow the pack" to the same method spelled out is a real
         decision about who owns it, and a reader six months later needs to
         see that somebody made it. */
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'cost_method.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          `${before.entityChoice ?? "pack_default"} (${before.method}) → ${
            after.entityChoice ?? "pack_default"
          } (${after.method})`,
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
