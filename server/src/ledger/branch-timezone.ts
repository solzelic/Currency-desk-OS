/* The branch time zone the Settings screen can change.

   The column has always defaulted to America/Toronto, and the
   dropdown used to write only the browser's saved settings, so the
   row never moved. Till open reads this column. An open session
   keeps the date and the zone it stored; the value written here is
   what the next open uses. */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

const EXAMPLE = "America/Toronto";

export type BranchTimeZone = {
  branchId: string;
  timezone: string;
};

/** A real IANA zone, or a 422. Blank and a string Intl rejects are
    both refused. A RangeError from Intl is that refusal; anything
    else is still a fault. */
export function requireIanaTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LedgerError(
      "INVALID_TIMEZONE",
      `A time zone is required. Use a name such as ${EXAMPLE}.`,
    );
  }
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new LedgerError(
        "INVALID_TIMEZONE",
        `${timeZone} is not a time zone. Use a name such as ${EXAMPLE}.`,
      );
    }
    throw error;
  }
  return timeZone;
}

export class BranchTimeZoneService {
  constructor(private readonly pool: pg.Pool) {}

  async current(actor: LedgerActor): Promise<BranchTimeZone> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const found = await client.query(
        `SELECT timezone FROM branches WHERE id=$1 AND tenant_id=$2`,
        [actor.branchId, actor.tenantId],
      );
      if (!found.rowCount) {
        throw new LedgerError("INVALID_REQUEST", "This branch is not on the desk.");
      }
      await client.query("COMMIT");
      return { branchId: actor.branchId, timezone: String(found.rows[0].timezone) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async set(actor: LedgerActor, raw: unknown): Promise<BranchTimeZone> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await authorizeLedgerActor(client, actor, "desk:timezone");
      } catch (error) {
        if (error instanceof LedgerError && error.code === "AUTHORIZATION_DENIED") {
          throw new LedgerError(
            "AUTHORIZATION_DENIED",
            "Only an owner or a manager can change the branch time zone.",
          );
        }
        throw error;
      }
      const timeZone = requireIanaTimeZone(raw);
      const before = await client.query(
        `SELECT timezone FROM branches WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [actor.branchId, actor.tenantId],
      );
      if (!before.rowCount) {
        throw new LedgerError("INVALID_REQUEST", "This branch is not on the desk.");
      }
      const previous = String(before.rows[0].timezone);
      if (previous !== timeZone) {
        await client.query(
          `UPDATE branches SET timezone=$3 WHERE id=$1 AND tenant_id=$2`,
          [actor.branchId, actor.tenantId, timeZone],
        );
        await client.query(
          `INSERT INTO ledger_audit_events
            (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
             action,target_id,reason,correlation_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'branch.timezone.change',$7,$8,$9,now())`,
          [
            randomUUID(),
            actor.tenantId,
            actor.legalEntityId,
            actor.branchId,
            actor.workspaceId,
            actor.userId,
            actor.branchId,
            `${previous} → ${timeZone}`,
            randomUUID(),
          ],
        );
      }
      await client.query("COMMIT");
      return { branchId: actor.branchId, timezone: timeZone };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
