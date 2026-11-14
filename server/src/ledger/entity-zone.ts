import { randomUUID } from "node:crypto";
import type pg from "pg";
import { civilTodayInZone } from "../civil-date.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type EntityReportZone = {
  zone: string;
  source: "entity" | "shared_branches" | "first_branch" | "default";
  mixed: boolean;
};
export type EntityZoneSetting = EntityReportZone & { setting: string | null };
const DEFAULT_ZONE = "America/Toronto";

function validZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (!zone || zone.length > 64) return null;
  // Intl also accepts numeric UTC offsets on newer runtimes. Those are
  // not named IANA zones and cannot describe civil daylight-saving rules.
  if (/^[+-]/.test(zone)) return null;
  try {
    civilTodayInZone(new Date(), zone);
    return zone;
  } catch {
    return null;
  }
}

/* Only a missing application table is optional. Release on both paths so
   repeated fallbacks do not accumulate savepoints. Every other SQL error
   escapes, with the caller's transaction still usable. */
async function optionalRows(client: pg.PoolClient, query: string, entityId: string) {
  await client.query("SAVEPOINT entity_report_zone");
  try {
    const found = await client.query(query, [entityId]);
    await client.query("RELEASE SAVEPOINT entity_report_zone");
    return found.rows;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT entity_report_zone");
    await client.query("RELEASE SAVEPOINT entity_report_zone");
    if ((error as { code?: string }).code !== "42P01") throw error;
    return [];
  }
}

/** Resolve on the caller's held client, inside its open transaction.
 * The caller authorizes the globally unique entity id. Never check out a
 * second connection, commit, or roll back the caller's transaction here.
 * This contract is available for shop-wide reporting; no consumer is
 * switched from its branch clock by introducing this resolver.
 */
export async function entityReportZone(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<EntityReportZone> {
  const entities = await optionalRows(client, "SELECT timezone FROM legal_entities WHERE id=$1", legalEntityId);
  const entityZone = validZone(entities[0]?.timezone);
  if (entityZone) return { zone: entityZone, source: "entity", mixed: false };

  // created_at is the branch row's insertion time. This deterministic
  // ordering is an implementation convention, not a regulatory rule.
  const branches = await optionalRows(client,
    "SELECT timezone FROM branches WHERE legal_entity_id=$1 ORDER BY created_at,id", legalEntityId);
  const zones = branches.map(row => validZone(row.timezone));
  const mixed = new Set(zones).size > 1;
  const first = zones[0];
  if (first) return { zone: first, source: mixed ? "first_branch" : "shared_branches", mixed };
  // An invalid earliest branch is not silently skipped in favour of a
  // later branch. Invalid values are one unavailable category for mixed.
  return { zone: DEFAULT_ZONE, source: "default", mixed };
}

export class EntityZoneService {
  constructor(private readonly pool: pg.Pool) {}

  private async lockSetting(client: pg.PoolClient, actor: LedgerActor, write: boolean): Promise<string | null> {
    const found = await client.query(
      `SELECT timezone FROM legal_entities WHERE id=$1 AND tenant_id=$2 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
      [actor.legalEntityId, actor.tenantId],
    );
    if (!found.rowCount) throw new LedgerError("LEGAL_ENTITY_NOT_FOUND", "This desk's legal entity is not on the ledger.");
    return found.rows[0].timezone;
  }

  async current(actor: LedgerActor): Promise<EntityZoneSetting> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const setting = await this.lockSetting(client, actor, false);
      const result = { ...await entityReportZone(client, actor.legalEntityId), setting };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async set(actor: LedgerActor, choice: string | null): Promise<EntityZoneSetting> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const zone = choice === null ? null : validZone(choice);
      if (choice !== null && zone === null) throw new LedgerError("INVALID_REQUEST", "Not a time zone.");
      // Lock before reading the before value: different owners can change
      // the same entity, so their principal locks alone are insufficient.
      const setting = await this.lockSetting(client, actor, true);
      const before = { ...await entityReportZone(client, actor.legalEntityId), setting };
      await client.query("UPDATE legal_entities SET timezone=$1 WHERE id=$2 AND tenant_id=$3", [zone, actor.legalEntityId, actor.tenantId]);
      const after = { ...await entityReportZone(client, actor.legalEntityId), setting: zone };
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'entity_timezone.change',$7,$8,$9,now())`,
        [randomUUID(), actor.tenantId, actor.legalEntityId, actor.branchId,
          actor.workspaceId, actor.userId, actor.legalEntityId,
          JSON.stringify({ before, after }), randomUUID()],
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
