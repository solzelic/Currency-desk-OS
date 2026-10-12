/* The branch's time zone is the authority for a business date.

   One lookup. Till open, the sign-off window, a post that needs today's
   calendar date, and an ID expiry all ask here. A missing zone and a
   zone Intl cannot read are the same refusal: the desk cannot name a
   day, and the request stops before a date is invented. */
import type pg from "pg";
import { businessDate } from "./business-date.js";
import { now as clockNow } from "./clock.js";

/** The column default, and the zone written when a new branch does not
    name one. Matches `branches.timezone` in the desk DDL. */
export const DEFAULT_BRANCH_TIMEZONE = "America/Toronto";

const UNSET =
  "This branch has no time zone, so its business date cannot be named.";

export class BranchTimeZoneUnset extends Error {
  readonly code = "BRANCH_TIMEZONE_UNSET";
  constructor(message = UNSET) {
    super(message);
    this.name = "BranchTimeZoneUnset";
  }
}

/** A zone the server can use. Blank is unset. A string Intl rejects is
    the same refusal, not a 500. */
export function assertBranchTimeZone(zone: unknown): string {
  if (typeof zone !== "string" || zone.trim() === "") {
    throw new BranchTimeZoneUnset();
  }
  const timeZone = zone.trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch (error) {
    if (error instanceof RangeError) throw new BranchTimeZoneUnset();
    throw error;
  }
  return timeZone;
}

type BranchScope = {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
};

export async function loadBranchTimeZone(
  client: pg.PoolClient,
  actor: BranchScope,
): Promise<string> {
  const result = await client.query(
    `SELECT timezone FROM branches
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND id=$3`,
    [actor.tenantId, actor.legalEntityId, actor.branchId],
  );
  return assertBranchTimeZone(result.rows[0]?.timezone);
}

/** Today's calendar date in the branch's zone. Used where a deal does
    not require an open till, so there is no session date to borrow. */
export async function branchCalendarDate(
  client: pg.PoolClient,
  actor: BranchScope,
): Promise<string> {
  return businessDate(clockNow(), await loadBranchTimeZone(client, actor));
}
