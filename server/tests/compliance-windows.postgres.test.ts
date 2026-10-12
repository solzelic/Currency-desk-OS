/* Compliance windows against a real Postgres clock.

   Two cash deals of 5,000, at 23:50 and 00:10 local, are twenty minutes
   apart. A rolling 24-hour window contains both. A calendar day, and
   FINTRAC's static window anchored at branch midnight, contain one
   each. The same pair is posted in America/Toronto and Asia/Jerusalem,
   including a daylight-saving night, and the rows are counted with the
   window bounds. A UTC date would put both Jerusalem deals on one day. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { zonedWallTime } from "../src/ledger/business-date.js";
import { branchStaticWindow } from "../src/ledger/canada-rules.js";
import {
  calendarDayWindow,
  instantInWindow,
  rollingWindow,
  searchDay,
  staticAggregationWindow,
  structuringWatchStart,
} from "../src/ledger/compliance-windows.js";
import { euAmlrNotice, EU_AMLR_NOTICE } from "../src/ledger/eu-amlr.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const TENANT = "tnt-win";
const ENTITY = "le-win";
const BRANCH = "br-win";
const ZONES = ["America/Toronto", "Asia/Jerusalem"] as const;

let handle: DbHandle;
let pool: pg.Pool;

async function countIn(
  client: pg.PoolClient,
  ids: string[],
  start: Date,
  end: Date,
  inclusiveEnd: boolean,
): Promise<number> {
  const found = await client.query(
    `SELECT count(*)::int AS n
       FROM ledger_transactions
      WHERE transaction_id = ANY($1::text[])
        AND posted_at >= $2
        AND posted_at ${inclusiveEnd ? "<=" : "<"} $3`,
    [ids, start, end],
  );
  return Number(found.rows[0].n);
}

async function postPair(
  client: pg.PoolClient,
  ids: [string, string],
  at: [Date, Date],
) {
  for (let i = 0; i < ids.length; i++) {
    await client.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
          customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
          fee_cad, spread_cad, purpose, source_of_funds, posted_at,
          deal_kind, received_instrument, disbursed_instrument,
          cash_in_home, home_currency)
       VALUES ($1,$2,$3,$4,$5,'ws-win','till-win',
               'cust-win','actor-win','CAD','USD',5000,5000,1,
               0,0,'Travel','Salary',$6,
               'exchange','cash','cash',
               5000,'CAD')`,
      [ids[i], `ref-${ids[i]}`, TENANT, ENTITY, BRANCH, at[i]],
    );
  }
}

postgres("compliance windows on PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING",
      [TENANT],
    );
    await pool.query(
      `INSERT INTO legal_entities (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1, $2, $1, 'CAD', 'pack-ca-v2', 2)
       ON CONFLICT (id) DO NOTHING`,
      [ENTITY, TENANT],
    );
    await pool.query(
      `INSERT INTO branches (id, tenant_id, legal_entity_id, name, timezone)
       VALUES ($1, $2, $3, 'Window', 'America/Toronto')
       ON CONFLICT (id) DO UPDATE SET timezone = EXCLUDED.timezone`,
      [BRANCH, TENANT, ENTITY],
    );
    await pool.query(
      `INSERT INTO ledger_customers
         (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id, name, risk, id_status)
       VALUES ('cust-win', $1, $2, $3, 'ws-win', 'Window Customer', 'normal', 'verified')
       ON CONFLICT DO NOTHING`,
      [TENANT, ENTITY, BRANCH],
    );
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  for (const zone of ZONES) {
    it(`splits 23:50 and 00:10 in ${zone} under a calendar day and aggregates them under 24 rolling hours`, async () => {
      const late = zonedWallTime("2026-10-11", "23:50:00", zone);
      const early = zonedWallTime("2026-10-12", "00:10:00", zone);
      expect(early.getTime() - late.getTime()).toBe(20 * 60 * 1000);

      const rolling = rollingWindow(early, 24);
      expect(instantInWindow(rolling, late, true)).toBe(true);
      expect(instantInWindow(rolling, early, true)).toBe(true);

      const calendar = calendarDayWindow("2026-10-12", zone);
      expect(instantInWindow(calendar, early, false)).toBe(true);
      expect(instantInWindow(calendar, late, false)).toBe(false);

      const fintrac = staticAggregationWindow(early, zone);
      expect(fintrac.start.toISOString()).toBe(calendar.start.toISOString());
      expect(fintrac.end.getTime() - fintrac.start.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(instantInWindow(fintrac, early, false)).toBe(true);
      expect(instantInWindow(fintrac, late, false)).toBe(false);

      const client = await pool.connect();
      const ids: [string, string] = [`win-late-${zone}`, `win-early-${zone}`];
      try {
        await client.query("BEGIN");
        await client.query("UPDATE branches SET timezone = $2 WHERE id = $1", [BRANCH, zone]);
        await postPair(client, ids, [late, early]);
        const fromBranch = await branchStaticWindow(client, BRANCH, early);
        expect(fromBranch.timeZone).toBe(zone);
        expect(fromBranch.start.toISOString()).toBe(fintrac.start.toISOString());
        expect(await countIn(client, ids, rolling.start, rolling.end, true)).toBe(2);
        expect(await countIn(client, ids, fintrac.start, fintrac.end, false)).toBe(1);
        expect(await countIn(client, ids, calendar.start, calendar.end, false)).toBe(1);
        /* A UTC date of 00:10 in Jerusalem is still the previous day, so
           both deals would land in one UTC day. */
        const utcLate = late.toISOString().slice(0, 10);
        const utcEarly = early.toISOString().slice(0, 10);
        if (zone === "Asia/Jerusalem") expect(utcLate).toBe(utcEarly);
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });

    it(`keeps the static window at 24 hours on a daylight-saving night in ${zone}`, async () => {
      const night = dstNight(zone);
      const start = staticAggregationWindow(zonedWallTime(night, "12:00:00", zone), zone);
      const calendar = calendarDayWindow(night, zone);
      expect(start.end.getTime() - start.start.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(calendar.end.getTime() - calendar.start.getTime()).not.toBe(24 * 60 * 60 * 1000);

      const gap = new Date(Math.min(start.end.getTime(), calendar.end.getTime()) + 30 * 60 * 1000);
      const later = new Date(Math.max(start.end.getTime(), calendar.end.getTime()) - 1000);
      expect(gap.getTime()).toBeLessThan(later.getTime());
      const inStatic = instantInWindow(start, gap, false);
      const inCalendar = instantInWindow(calendar, gap, false);
      expect(inStatic).not.toBe(inCalendar);

      const client = await pool.connect();
      const id = `win-dst-${zone}`;
      try {
        await client.query("BEGIN");
        await postPair(client, [id, `${id}-b`], [gap, later]);
        const staticCount = await countIn(client, [id], start.start, start.end, false);
        const calendarCount = await countIn(client, [id], calendar.start, calendar.end, false);
        expect(staticCount).toBe(inStatic ? 1 : 0);
        expect(calendarCount).toBe(inCalendar ? 1 : 0);
        expect(staticCount).not.toBe(calendarCount);
        await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  it("names the structuring watch and search yesterday from the branch date", () => {
    const jerusalem = new Date("2026-10-12T00:10:00+03:00");
    expect(jerusalem.toISOString().slice(0, 10)).toBe("2026-10-11");
    expect(structuringWatchStart(jerusalem, "Asia/Jerusalem", 1)).toBe("2026-10-11");
    expect(searchDay(jerusalem, "Asia/Jerusalem", "today")).toBe("2026-10-12");
    expect(searchDay(jerusalem, "Asia/Jerusalem", "yesterday")).toBe("2026-10-11");

    const toronto = new Date("2026-10-11T23:50:00-04:00");
    expect(toronto.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(structuringWatchStart(toronto, "America/Toronto", 1)).toBe("2026-10-10");
    expect(searchDay(toronto, "America/Toronto", "today")).toBe("2026-10-11");
    expect(searchDay(toronto, "America/Toronto", "yesterday")).toBe("2026-10-10");
  });

  it("drops the EU notice on the branch's 10 July, not the UTC date", () => {
    const stillNinthInToronto = new Date("2027-07-10T03:30:00Z");
    expect(stillNinthInToronto.toISOString().slice(0, 10)).toBe("2027-07-10");
    expect(euAmlrNotice("2027-07-10", stillNinthInToronto, "America/Toronto")).toBe(EU_AMLR_NOTICE);
    const alreadyTenthInJerusalem = new Date("2027-07-09T21:30:00Z");
    expect(alreadyTenthInJerusalem.toISOString().slice(0, 10)).toBe("2027-07-09");
    expect(euAmlrNotice("2027-07-10", alreadyTenthInJerusalem, "Asia/Jerusalem")).toBeNull();
  });
});

/** A calendar date in `zone` whose next midnight is not 24 hours later. */
function dstNight(zone: string): string {
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= 28; day++) {
      const iso = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const span = calendarDayWindow(iso, zone);
      if (span.end.getTime() - span.start.getTime() !== 24 * 60 * 60 * 1000) return iso;
    }
  }
  throw new Error(`No daylight-saving night in ${zone} during 2026.`);
}
