/* The parts of the Canada pack that do not need a database.
   Deadlines, the static window, and the promise that migration 029
   inserts a new pack and does not rewrite a published one. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTLEMENT_DEAL_KINDS } from "../src/ledger/cheques.js";
import {
  NOT_A_DEAL_SQL,
  deadlineDate,
  isoDay,
  staticWindow,
} from "../src/ledger/canada-rules.js";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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

  it("anchors the window at midnight in the branch zone, for 24 hours", () => {
    /* 15:00 UTC on 15 June 2026 is 11:00 in Toronto (EDT, UTC-4).
       Midnight there is 04:00 UTC, and the window ends 24 hours later,
       not at the same clock time the next calendar day. */
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
