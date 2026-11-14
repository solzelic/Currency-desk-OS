import type pg from "pg";
import { cashReceivedGroups, deskMoney, largeCashRule, shopDayWindow, type Axis } from "./canada-rules.js";
import { entityReportZone, type EntityReportZone } from "./entity-zone.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type LctrGroups = {
  day: string;
  zone: string;
  zoneSource: EntityReportZone["source"];
  mixed: boolean;
  window: { start: string; end: string; startOffset: string; endOffset: string };
  trigger: string | null;
  groups: {
    axis: Axis; key: string; total: string; transactionIds: string[]; branchIds: string[];
    /** null is unknown, never a claim that no report is needed. */
    needsReport: boolean | null;
  }[];
};

export class LctrGroupsService {
  constructor(private readonly pool: pg.Pool) {}

  async forDay(actor: LedgerActor, day: string): Promise<LctrGroups> {
    const client = await this.pool.connect();
    try {
      // One held connection and snapshot: zone, threshold and receipts must
      // not come from different versions of this entity's book/configuration.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await authorizeLedgerActor(client, actor, "filing:view");
      const entity = await client.query("SELECT id FROM legal_entities WHERE id=$1 AND tenant_id=$2", [actor.legalEntityId, actor.tenantId]);
      if (!entity.rowCount) throw new LedgerError("LEGAL_ENTITY_NOT_FOUND", "This desk's legal entity is not on the ledger.");
      const zone = await entityReportZone(client, actor.legalEntityId);
      const window = shopDayWindow(day, zone.zone);
      const pack = await resolvePack(client, actor.legalEntityId);
      const rule = await largeCashRule(client, pack.packId);
      const desk = await deskMoney(client, actor.legalEntityId, "report_threshold");
      // Identical precedence to countryIdentification. A desk number alone
      // cannot establish a missing large-cash rule.
      const trigger = rule ? (desk && desk.lt(rule.trigger) ? desk : rule.trigger) : null;
      const groups = await cashReceivedGroups(client, actor.legalEntityId, window);
      const result: LctrGroups = {
        day, zone: zone.zone, zoneSource: zone.source, mixed: zone.mixed,
        window: { ...window, start: window.start.toISOString(), end: window.end.toISOString() },
        trigger: trigger?.toFixed(2) ?? null,
        groups: groups.map(group => ({ ...group, total: group.total.toFixed(2), needsReport: trigger ? group.total.gte(trigger) : null })),
      };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
