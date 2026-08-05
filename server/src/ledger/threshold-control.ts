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
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";
import { readDeskThresholds, type DeskThresholds } from "./thresholds.js";

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
}
