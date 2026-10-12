/* Opening a till just after midnight names that branch's calendar date.

   The UTC date is still the previous day in a zone ahead of UTC, and a
   DATE read back through toISOString moves a day wherever the process
   zone is ahead of UTC. Both have to come back as the branch date.
   America/Toronto just after midnight shares the UTC calendar day, so
   that case pins the session to the new local date. Asia/Jerusalem is
   the one where UTC is still yesterday. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { readDateOnly } from "../src/ledger/business-date.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
const clockBefore = process.env.CD_TEST_CLOCK;

const CASES = [
  {
    zone: "America/Toronto",
    at: "2026-10-12T00:30:00-04:00",
    businessDate: "2026-10-12",
    utcDate: "2026-10-12",
  },
  {
    zone: "Asia/Jerusalem",
    at: "2026-10-12T00:30:00+03:00",
    businessDate: "2026-10-12",
    utcDate: "2026-10-11",
  },
] as const;

function zonedClock(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    hour,
    minute: pick("minute"),
  };
}

postgres("a till opened after midnight takes the branch calendar date", () => {
  beforeAll(async () => {
    process.env.CD_TEST_CLOCK = "1";
    /* One database for the desk and the ledger. The branch row the till
       reads has to be the row this test dates. */
    process.env.DATABASE_URL = url;
    delete process.env.LEDGER_DATABASE_URL;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query("UPDATE branches SET timezone='America/Toronto' WHERE id=$1", [
      DEMO.branchId,
    ]);
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
    if (clockBefore === undefined) delete process.env.CD_TEST_CLOCK;
    else process.env.CD_TEST_CLOCK = clockBefore;
  });

  beforeEach(async () => {
    await pool.query(
      `UPDATE ledger_till_sessions
          SET status='closed', closed_by=$1, closed_at=now()
        WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
          AND workspace_id=$5 AND status='open'`,
      [
        `${DEMO.tenantId}:test`,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        DEMO.workspaceId,
      ],
    );
  });

  for (const item of CASES) {
    it(`opens on ${item.businessDate} in ${item.zone} at ${item.at}`, async () => {
      const dated = await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [
        DEMO.branchId,
        item.zone,
      ]);
      expect(dated.rowCount).toBe(1);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { staffId: "j.masri", password: DEMO.password, tenantId: DEMO.tenantId },
      });
      expect(login.statusCode).toBe(200);
      const cookies = {
        cdos_session: login.cookies.find((cookie) => cookie.name === "cdos_session")!.value,
      };
      const headers = {
        "x-workspace-id": DEMO.workspaceId,
        "x-cd-now": item.at,
      };

      const opened = await app.inject({
        method: "POST",
        url: "/api/ledger/till-sessions/open",
        cookies,
        headers,
      });
      expect(opened.statusCode, opened.body).toBe(201);
      const body = opened.json();
      expect(body.session.businessDate).toBe(item.businessDate);
      expect(body.session.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.day).toMatchObject({
        businessDate: item.businessDate,
        timeZone: item.zone,
      });
      expect(new Date(item.at).toISOString().slice(0, 10)).toBe(item.utcDate);
      if (item.utcDate !== item.businessDate) {
        expect(body.session.businessDate).not.toBe(item.utcDate);
      }
      expect(body.session.openedAt).toBe(new Date(item.at).toISOString());

      const from = zonedClock(body.day.from, item.zone);
      expect(from).toEqual({ date: item.businessDate, hour: "00", minute: "00" });
      expect(new Date(body.day.to).getTime()).toBeGreaterThan(new Date(item.at).getTime());

      const again = await app.inject({
        method: "GET",
        url: "/api/ledger/till-session",
        cookies,
        headers,
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().session.businessDate).toBe(item.businessDate);
      expect(again.json().day.businessDate).toBe(item.businessDate);

      const stored = await pool.query(
        `SELECT business_date, business_date::text AS text
           FROM ledger_till_sessions
          WHERE session_id=$1`,
        [body.session.sessionId],
      );
      expect(stored.rows[0].text).toBe(item.businessDate);
      expect(readDateOnly(stored.rows[0].business_date)).toBe(item.businessDate);
    });
  }
});
