/* The owner's till settings (#617), on the server and audited. No row
   means the defaults. Anyone at the desk may read them; only the owner
   (`compliance:thresholds`) changes them, and each changed field writes
   one audit row with the old value, the new value and the actor. */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { withSerializationRetry } from "./retry.js";
import type { LedgerActor } from "./service.js";

export type TillSettings = {
  requireCountOnSwitch: boolean;
  largeDifferenceAlert: boolean;
  largeDifferenceAmount: string | null;
  morningFloat: "ask" | "skip";
};

const DEFAULTS: TillSettings = {
  requireCountOnSwitch: false,
  largeDifferenceAlert: false,
  largeDifferenceAmount: null,
  morningFloat: "ask",
};

export async function readTillSettings(
  client: Pick<pg.PoolClient, "query">,
  tenantId: string,
  legalEntityId: string,
): Promise<TillSettings> {
  const row = (await client.query(
    `SELECT require_count_on_switch, large_difference_alert,
            large_difference_amount::text AS amount, morning_float
       FROM ledger_till_settings WHERE tenant_id=$1 AND legal_entity_id=$2`,
    [tenantId, legalEntityId],
  )).rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    requireCountOnSwitch: row.require_count_on_switch,
    largeDifferenceAlert: row.large_difference_alert,
    largeDifferenceAmount: row.amount ?? null,
    morningFloat: row.morning_float,
  };
}

export class TillSettingsService {
  constructor(private readonly pool: pg.Pool) {}

  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  get(actor: LedgerActor) {
    return this.inTransaction(async (client) => {
      await authorizeLedgerActor(client, actor, "ledger:view");
      return readTillSettings(client, actor.tenantId, actor.legalEntityId);
    });
  }

  set(actor: LedgerActor, patch: Partial<TillSettings>) {
    return withSerializationRetry(() => this.inTransaction(async (client) => {
      const role = await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const before = await readTillSettings(client, actor.tenantId, actor.legalEntityId);
      const after: TillSettings = { ...before, ...patch };
      if (after.largeDifferenceAmount != null) {
        after.largeDifferenceAmount = new Decimal(after.largeDifferenceAmount).toFixed(2);
      }
      await client.query(
        `INSERT INTO ledger_till_settings
          (tenant_id,legal_entity_id,require_count_on_switch,large_difference_alert,
           large_difference_amount,morning_float,updated_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
         ON CONFLICT (tenant_id,legal_entity_id) DO UPDATE SET
           require_count_on_switch=EXCLUDED.require_count_on_switch,
           large_difference_alert=EXCLUDED.large_difference_alert,
           large_difference_amount=EXCLUDED.large_difference_amount,
           morning_float=EXCLUDED.morning_float,
           updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [actor.tenantId, actor.legalEntityId, after.requireCountOnSwitch, after.largeDifferenceAlert,
          after.largeDifferenceAmount, after.morningFloat, actor.userId],
      );
      for (const field of Object.keys(patch) as (keyof TillSettings)[]) {
        if (before[field] === after[field]) continue;
        await client.query(
          `INSERT INTO ledger_audit_events
            (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
             action,target_id,reason,correlation_id,created_at,actor_role,detail)
           VALUES ($1,$2,$3,$4,$5,$6,'till.settings.change','till-settings',$7,$8,clock_timestamp(),$9,$10::jsonb)`,
          [randomUUID(), actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, actor.userId,
            `${field} changed`, randomUUID(), role, JSON.stringify({ field, old: before[field], new: after[field] })],
        );
      }
      return after;
    }));
  }
}
