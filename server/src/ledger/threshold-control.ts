/* ============================================================
   Reading and changing the desk's own thresholds.

   Separate from thresholds.ts because this half needs the actor, the
   permission table and the audit log, and the posting path must be able
   to resolve a threshold without dragging any of that in. See the header
   there.

   Changing one of these changes what the desk reports to a regulator. So
   it takes a deliberate permission, and it writes `ledger_audit_events`:
   who moved the line, when, and from what to what. "We stopped filing
   reports at some point last spring and nobody knows why" is the failure
   this exists to prevent — and unlike a costing method, which an
   accountant can reconstruct from the lots, a threshold leaves no trace
   in the book at all. The only record that it ever moved is the one
   written here.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { AU_V1_PACK_ID, AU_V2_PACK_ID } from "./australia-rules.js";
import { EU_AMLR_PACK_ID, EU_V1_PACK_ID, resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, requireInstalledPack, type LedgerActor } from "./service.js";
import { readDeskThresholds, type DeskThresholds } from "./thresholds.js";
import { UK_PACK_V1, UK_PACK_V2 } from "./uk-mlr.js";

/* What a caller may change, and what it maps to on the row. The desk's
   `home_currency`, its regulator and its report name are all the pack's to
   state and appear nowhere here — a desk does not get to rename its own
   regulator. */
const FIELDS = {
  reportThreshold: "report_threshold",
  idThreshold: "id_threshold",
  aggregationHours: "aggregation_hours",
  retentionYears: "retention_years",
} as const;

export type ThresholdField = keyof typeof FIELDS;

/** A change to one line: a number, or "follow the pack". */
export type ThresholdChange = number | string | null;

export type ThresholdChanges = Partial<Record<ThresholdField, ThresholdChange>>;

/* How each field reads in an audit row. Spelled out rather than derived
   from the key, because the person reading this row a year from now is a
   compliance officer with a regulator's letter in front of them, not
   somebody who knows what `idThreshold` is called in our database. */
const LABEL: Readonly<Record<ThresholdField, string>> = {
  reportThreshold: "reporting threshold",
  idThreshold: "identification threshold",
  aggregationHours: "aggregation window (hours)",
  retentionYears: "record retention (years)",
};

/**
 * pack-gb-v2. £12,000 or more is the occasional customer due
 * diligence floor. Settings may store a lower number. It may not
 * store a number that would raise that floor. The posting gate
 * ignores a stored number at or above the statute as well, so a
 * row written some other way still cannot lift it.
 */
function refuseUnitedKingdomFloor(
  packId: string,
  packLine: string,
  idThreshold: ThresholdChange | undefined,
): void {
  if (packId !== UK_PACK_V2 || idThreshold == null) return;
  let typed: Decimal;
  let floor: Decimal;
  try {
    typed = new Decimal(String(idThreshold));
    floor = new Decimal(packLine);
  } catch {
    return;
  }
  if (!typed.isFinite() || !floor.isFinite() || !typed.gt(0)) return;
  if (typed.gte(floor)) {
    throw new LedgerError(
      "IDENTIFICATION_FLOOR",
      "The occasional customer due diligence line stays at £12,000 or more. A number of £12,000 or higher is not saved. A lower number is this desk's own policy.",
    );
  }
}

const shown = (setting: { deskChoice: unknown; effective: unknown }) =>
  setting.deskChoice === null
    ? `pack default (${setting.effective ?? "none"})`
    : String(setting.deskChoice);

export class ThresholdService {
  constructor(private readonly pool: pg.Pool) {}

  async current(actor: LedgerActor): Promise<DeskThresholds> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const thresholds = await readDeskThresholds(client, actor.legalEntityId);
      await client.query("COMMIT");
      return thresholds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move one or more of the desk's lines, or hand any of them back to the
   * pack with a null.
   *
   * Nothing already posted is re-judged. A deal that cleared under the old
   * identification line stays cleared, and a report already filed stays
   * filed — what changes is the next deal. That is the honest behaviour
   * and it is also the only safe one: retroactively deciding that last
   * Tuesday's deals were reportable would create obligations nobody can
   * discharge, against customers who have long since walked out.
   *
   * A desk is allowed to set a line LOOSER than its pack requires. That is
   * deliberate, and it is not an endorsement — the resolved posture says
   * "looser" and the desk is told, unmissably, on the screen where it made
   * the change. Refusing the write instead would be worse in two ways: it
   * would put this server in the position of adjudicating law it holds a
   * cached copy of, and a pack corrected downward would silently turn a
   * desk's saved settings into an unwritable row rather than into a
   * visible problem somebody can fix.
   */
  async set(actor: LedgerActor, changes: ThresholdChanges): Promise<DeskThresholds> {
    const entries = Object.entries(changes).filter(([, value]) =>
      value !== undefined,
    ) as [ThresholdField, ThresholdChange][];
    if (!entries.length)
      throw new LedgerError(
        "INVALID_REQUEST",
        "Nothing to change — name at least one threshold.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      /* No pack means there is no line to tighten. Writing one here would
         open a hole: the desk could name a huge identification line and
         then post under it. The editors on the screen are hidden for the
         same reason. */
      const pack = await resolvePack(client, actor.legalEntityId);
      requireInstalledPack(pack);
      refuseUnitedKingdomFloor(pack.packId, pack.idThreshold, changes.idThreshold);
      const before = await readDeskThresholds(client, actor.legalEntityId);
      const assignments = entries.map(
        ([field], index) => `${FIELDS[field]}=$${index + 2}`,
      );
      const updated = await client.query(
        `UPDATE legal_entities SET ${assignments.join(",")} WHERE id=$1`,
        [actor.legalEntityId, ...entries.map(([, value]) => value)],
      );
      if (!updated.rowCount)
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its thresholds cannot be set here.",
        );
      const after = await readDeskThresholds(client, actor.legalEntityId);
      /* Audited even where the effective number does not move — switching
         from "follow the pack" to the same figure spelled out is a real
         decision about who owns it, and a reader six months later needs to
         see that somebody made it. The posture rides along because it is
         the part that matters at a glance: a line that went LOOSER than
         the mandate is the row an auditor is looking for. */
      const summary = entries
        .map(([field]) => {
          const was = before[field];
          const now = after[field];
          return `${LABEL[field]} ${shown(was)} → ${shown(now)} (${now.posture})`;
        })
        .join("; ");
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'compliance.thresholds.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          summary,
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

  /**
   * Move this desk from the Canada pack version 1 onto version 2.
   *
   * One way, and only from version 1. The desk's own identification
   * number is left as it is: NULL still means follow the pack, and a
   * number the owner already saved stays saved. Posted deals keep the
   * pack version stamped on them. Nothing else on the book moves.
   */
  async optInCanadaV2(actor: LedgerActor): Promise<DeskThresholds> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const installed = await client.query(
        "SELECT 1 FROM jurisdiction_packs WHERE pack_id = 'pack-ca-v2'",
      );
      if (!installed.rowCount) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "The current Canada pack is not installed on this database.",
        );
      }
      const moved = await client.query(
        `UPDATE legal_entities
            SET jurisdiction_pack_id = 'pack-ca-v2',
                jurisdiction_pack_version = 2
          WHERE id = $1
            AND jurisdiction_pack_id = 'pack-ca-v1'`,
        [actor.legalEntityId],
      );
      if (!moved.rowCount) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "Only a desk on the Canada pack version 1 can move to version 2.",
        );
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'compliance.pack.opt_in',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          "Owner moved this desk from pack-ca-v1 to pack-ca-v2. Posted deals keep the pack they were stamped with.",
          randomUUID(),
        ],
      );
      const after = await readDeskThresholds(client, actor.legalEntityId);
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move this desk from the European Union pack version 1 onto the
   * 2027 pack. One way, and only from version 1. The desk's own
   * identification number is left as it is. Posted deals keep the
   * pack version stamped on them.
   */
  async optInEuAmlr(actor: LedgerActor): Promise<DeskThresholds> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const installed = await client.query(
        "SELECT 1 FROM jurisdiction_packs WHERE pack_id = $1",
        [EU_AMLR_PACK_ID],
      );
      if (!installed.rowCount) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "The 2027 European Union pack is not installed on this database.",
        );
      }
      const moved = await client.query(
        `UPDATE legal_entities
            SET jurisdiction_pack_id = $2,
                jurisdiction_pack_version = 2
          WHERE id = $1
            AND jurisdiction_pack_id = $3`,
        [actor.legalEntityId, EU_AMLR_PACK_ID, EU_V1_PACK_ID],
      );
      if (!moved.rowCount) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "Only a desk on the European Union pack version 1 can move to the 2027 rules.",
        );
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'compliance.pack.opt_in',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          "Owner moved this desk from pack-eu-v1 to pack-eu-v2. Posted deals keep the pack they were stamped with.",
          randomUUID(),
        ],
      );
      const after = await readDeskThresholds(client, actor.legalEntityId);
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move an Australian desk from pack-au-v1 to pack-au-v2.
   *
   * One way. A desk on any other pack is refused. The desk's own
   * identification number is left where the owner set it. Posted deals
   * keep the pack id and version they were stamped with. This update
   * touches the legal entity only.
   */
  async optInAustraliaV2(actor: LedgerActor): Promise<DeskThresholds> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const pack = await client.query(
        "SELECT pack_id FROM jurisdiction_packs WHERE pack_id=$1",
        [AU_V2_PACK_ID],
      );
      if (!pack.rowCount) {
        throw new LedgerError(
          "PACK_NOT_INSTALLED",
          "The current Australia rules are not installed on this ledger.",
        );
      }
      const entity = await client.query(
        `SELECT jurisdiction_pack_id
           FROM legal_entities
          WHERE id=$1
          FOR UPDATE`,
        [actor.legalEntityId],
      );
      if (!entity.rowCount) {
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its rules cannot be changed here.",
        );
      }
      const current = String(entity.rows[0].jurisdiction_pack_id ?? "");
      if (current === AU_V2_PACK_ID) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "This desk is already on the current Australia rules.",
        );
      }
      if (current !== AU_V1_PACK_ID) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "Only a desk on the previous Australia rules can switch to the current ones.",
        );
      }
      const updated = await client.query(
        `UPDATE legal_entities
            SET jurisdiction_pack_id=$2, jurisdiction_pack_version=2
          WHERE id=$1 AND jurisdiction_pack_id=$3`,
        [actor.legalEntityId, AU_V2_PACK_ID, AU_V1_PACK_ID],
      );
      if (!updated.rowCount) {
        throw new LedgerError(
          "PACK_OPT_IN_REFUSED",
          "Only a desk on the previous Australia rules can switch to the current ones.",
        );
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'compliance.pack.opt_in',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          "Australia rules pack-au-v1 to pack-au-v2. Posted deals keep the pack they were stamped with.",
          randomUUID(),
        ],
      );
      const after = await readDeskThresholds(client, actor.legalEntityId);
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Move a desk from pack-gb-v1 to pack-gb-v2.
   *
   * One way, and only from that pack. Already being on v2 is a no-op.
   * Any other pack is refused. The desk's own identification and
   * reporting numbers are left alone, and nothing already posted is
   * rewritten: the pack id on a deal is a stamp, not a live pointer.
   */
  async adoptUnitedKingdomV2(actor: LedgerActor): Promise<DeskThresholds> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const found = await client.query(
        `SELECT jurisdiction_pack_id FROM legal_entities WHERE id=$1 FOR UPDATE`,
        [actor.legalEntityId],
      );
      if (!found.rowCount) {
        throw new LedgerError("LEGAL_ENTITY_NOT_FOUND", "This desk's legal entity is not on the ledger, so its pack cannot be changed here.");
      }
      const current = String(found.rows[0].jurisdiction_pack_id ?? "");
      if (current === UK_PACK_V2) {
        const thresholds = await readDeskThresholds(client, actor.legalEntityId);
        await client.query("COMMIT");
        return thresholds;
      }
      if (current !== UK_PACK_V1) {
        throw new LedgerError("JURISDICTION_PACK_CONFLICT", "Only a desk on the first United Kingdom pack can move to the current one. This does not change another country, and it does not rewrite a deal already posted.");
      }
      const updated = await client.query(
        `UPDATE legal_entities SET jurisdiction_pack_id=$2, jurisdiction_pack_version=2 WHERE id=$1 AND jurisdiction_pack_id=$3`,
        [actor.legalEntityId, UK_PACK_V2, UK_PACK_V1],
      );
      if (!updated.rowCount) {
        throw new LedgerError("JURISDICTION_PACK_CONFLICT", "Only a desk on the first United Kingdom pack can move to the current one. This does not change another country, and it does not rewrite a deal already posted.");
      }
      await client.query(
        `INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id, action,target_id,reason,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,'compliance.jurisdiction_pack.adopt',$7,$8,$9,now())`,
        [randomUUID(), actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, actor.userId, actor.legalEntityId, "United Kingdom pack pack-gb-v1 to pack-gb-v2. The desk's own identification and reporting numbers were left as they were. Posted deals keep the pack stamped on them.", randomUUID()],
      );
      const after = await readDeskThresholds(client, actor.legalEntityId);
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
