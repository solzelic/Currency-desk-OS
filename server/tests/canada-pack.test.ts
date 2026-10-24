/* The parts of the Canada pack that do not need a database.
   Deadlines, the 24 consecutive hours, and the promise that
   migration 029 inserts a new pack and does not rewrite a
   published one. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTLEMENT_DEAL_KINDS } from "../src/ledger/cheques.js";
import {
  NOT_A_DEAL_SQL,
  deadlineDate,
  isoDay,
  staticWindow,
} from "../src/ledger/canada-rules.js";

const require = createRequire(import.meta.url);
const { wallInstant, rollingWindow, inRollingWindow } = require("../../shared/rolling-24h.js") as {
  wallInstant: (date: string, time: string, zone: string) => Date | null;
  rollingWindow: (at: Date, hours?: number) => { start: Date; end: Date };
  inRollingWindow: (earlier: Date, later: Date, hours?: number) => boolean;
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const HOUR = 60 * 60 * 1000;

describe("Canada pack deadlines and the 24 hour window", () => {
  it("counts 15 calendar days from the day after receipt", () => {
    /* s.132(3): within 15 days after the day the cash was received.
       1 October plus 15 days is 16 October. */
    expect(isoDay(deadlineDate(day("2026-10-01"), 15, "calendar_days"))).toBe(
      "2026-10-16",
    );
  });

  it("counts working days as Monday to Friday and does not invent holidays", () => {
    /* Friday 2 October 2026. One working day is Monday 5 October.
       Five working days is Friday 9 October. */
    expect(isoDay(deadlineDate(day("2026-10-02"), 1, "business_days"))).toBe(
      "2026-10-05",
    );
    expect(isoDay(deadlineDate(day("2026-10-02"), 5, "business_days"))).toBe(
      "2026-10-09",
    );
    /* Monday 12 October 2026 is Thanksgiving in Canada. FINTRAC would
       skip it. This calculator does not, because the pack has no
       holiday calendar and guessing one would be wrong. */
    expect(isoDay(deadlineDate(day("2026-10-09"), 1, "business_days"))).toBe(
      "2026-10-12",
    );
  });

  it("keeps midnight as a calendar date, not as the cash lookback", () => {
    /* 15:00 UTC on 15 June 2026 is 11:00 in Toronto (EDT, UTC-4).
       Midnight there is 04:00 UTC. A calendar date still starts
       there. The large-cash total does not. */
    const summer = staticWindow(
      new Date("2026-06-15T15:00:00Z"),
      "America/Toronto",
    );
    expect(summer.start.toISOString()).toBe("2026-06-15T04:00:00.000Z");
    expect(summer.end.toISOString()).toBe("2026-06-16T04:00:00.000Z");

    /* 15 January is EST, UTC-5, so midnight is 05:00 UTC. */
    const winter = staticWindow(
      new Date("2026-01-15T15:00:00Z"),
      "America/Toronto",
    );
    expect(winter.start.toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(winter.end.toISOString()).toBe("2026-01-16T05:00:00.000Z");

    /* 23:30 is before that midnight, so a midnight window misses it. */
    const prior = wallInstant("2026-06-15", "23:30", "America/Toronto");
    const deal = wallInstant("2026-06-16", "00:30", "America/Toronto");
    expect(prior).not.toBeNull();
    expect(deal).not.toBeNull();
    const midnight = staticWindow(deal!, "America/Toronto");
    expect(prior!.getTime() < midnight.start.getTime()).toBe(true);
  });

  it("reads 23:59 and 00:01 in the branch zone as two minutes apart", () => {
    const left = wallInstant("2026-06-15", "23:59", "America/Toronto");
    const right = wallInstant("2026-06-16", "00:01", "America/Toronto");
    expect(left?.toISOString()).toBe("2026-06-16T03:59:00.000Z");
    expect(right?.toISOString()).toBe("2026-06-16T04:01:00.000Z");
    expect(right!.getTime() - left!.getTime()).toBe(2 * 60 * 1000);
    expect(inRollingWindow(left!, right!, 24)).toBe(true);
    /* The same two minutes in January, when Toronto is UTC-5. */
    const winterLeft = wallInstant("2026-01-15", "23:59", "America/Toronto");
    const winterRight = wallInstant("2026-01-16", "00:01", "America/Toronto");
    expect(winterRight!.getTime() - winterLeft!.getTime()).toBe(2 * 60 * 1000);
    expect(inRollingWindow(winterLeft!, winterRight!, 24)).toBe(true);
  });

  it("includes a receipt exactly 24 hours earlier and excludes one millisecond past that", () => {
    const end = wallInstant("2026-06-16", "12:00:00.000", "America/Toronto")!;
    const exact = new Date(end.getTime() - 24 * HOUR);
    const past = new Date(exact.getTime() - 1);
    const window = rollingWindow(end, 24);
    expect(window.start.toISOString()).toBe(exact.toISOString());
    expect(window.end.toISOString()).toBe(end.toISOString());
    expect(inRollingWindow(exact, end, 24)).toBe(true);
    expect(inRollingWindow(past, end, 24)).toBe(false);
    /* Noon the day before is outside the midnight window of this noon. */
    const midnight = staticWindow(end, "America/Toronto");
    expect(exact.getTime() < midnight.start.getTime()).toBe(true);
  });

  it("has no instant for a spring-forward gap", () => {
    expect(wallInstant("2026-03-08", "02:30", "America/Toronto")).toBeNull();
  });

  it("keeps cheque settlement out of the cash window, in step with the cheque list", () => {
    expect(NOT_A_DEAL_SQL).toBe(
      SETTLEMENT_DEAL_KINDS.map((kind) => `'${kind}'`).join(","),
    );
  });

  it("does not rewrite a published pack or a desk already on one", () => {
    const sql = readFileSync(
      new URL("../src/db/migrations/029_pack_ca_v2.sql", import.meta.url),
      "utf8",
    );
    /* Comments may say the word. The statements must not. */
    const statements = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(sql).toMatch(/'pack-ca-v2'/);
    expect(statements).not.toMatch(/UPDATE\s+legal_entities/i);
    expect(statements).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(statements).not.toMatch(/UPDATE\s+jurisdiction_reports/i);
    expect(statements).not.toMatch(/UPDATE\s+jurisdiction_id_thresholds/i);
  });
});
