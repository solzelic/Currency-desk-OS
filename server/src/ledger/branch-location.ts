/* Whether this counter is airside or inside a casino.

   Serbia's exchange decision (Point 21, notice item 4) requires the
   customer's name and identity number on every buy and every sell at
   those places. The flag lives on the branch because it is a fact
   about the counter, not about the legal entity. It is off until
   somebody turns it on, and the posting path only reads it for the
   Serbia pack. */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export class BranchLocationService {
  constructor(private readonly pool: pg.Pool) {}

  async current(actor: LedgerActor): Promise<{ airsideOrCasino: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const found = await client.query(
        `SELECT airside_or_casino FROM branches WHERE id=$1 AND tenant_id=$2`,
        [actor.branchId, actor.tenantId],
      );
      await client.query("COMMIT");
      return { airsideOrCasino: found.rows[0]?.airside_or_casino === true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async set(actor: LedgerActor, airsideOrCasino: boolean): Promise<{ airsideOrCasino: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const before = await client.query(
        `SELECT airside_or_casino FROM branches WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [actor.branchId, actor.tenantId],
      );
      if (!before.rowCount) {
        throw new LedgerError("INVALID_REQUEST", "This branch is not on the ledger.");
      }
      await client.query(
        `UPDATE branches SET airside_or_casino=$3 WHERE id=$1 AND tenant_id=$2`,
        [actor.branchId, actor.tenantId, airsideOrCasino],
      );
      const now = airsideOrCasino ? "yes" : "no";
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'compliance.location.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.branchId,
          `Airside or casino: ${before.rows[0].airside_or_casino === true ? "yes" : "no"} to ${now}`,
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
      return { airsideOrCasino };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
