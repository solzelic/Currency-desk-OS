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

  it("stores America/Toronto when a branch is created without a zone", async () => {
    const column = await pool.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'branches' AND column_name = 'timezone'`,
    );
    expect(column.rows[0].is_nullable).toBe("NO");
    expect(String(column.rows[0].column_default)).toContain("America/Toronto");
    const seeded = await pool.query("SELECT timezone FROM branches WHERE id=$1", [DEMO.branchId]);
    expect(seeded.rows[0].timezone).toBe("America/Toronto");
    await expect(
      pool.query("UPDATE branches SET timezone = NULL WHERE id=$1", [DEMO.branchId]),
    ).rejects.toMatchObject({ code: "23502" });
  });

  async function login() {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(res.statusCode).toBe(200);
    return {
      cdos_session: res.cookies.find((cookie) => cookie.name === "cdos_session")!.value,
    };
  }

  async function openTill(zone: string) {
    await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [DEMO.branchId, zone]);
    const cookies = await login();
    return app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies,
      headers: { "x-workspace-id": DEMO.workspaceId },
    });
  }

  it("refuses to open a till when the zone is blank", async () => {
    const opened = await openTill("   ");
    expect(opened.statusCode, opened.body).toBe(409);
    expect(opened.json().code).toBe("BRANCH_TIMEZONE_UNSET");
  });

  it("refuses a zone Intl cannot read, instead of failing the request", async () => {
    const opened = await openTill("Not/AZone");
    expect(opened.statusCode, opened.body).toBe(409);
    expect(opened.json().code).toBe("BRANCH_TIMEZONE_UNSET");
  });

  it("refuses to read an open session when the zone is not a real zone", async () => {
    await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [
      DEMO.branchId,
      "America/Toronto",
    ]);
    const next = await pool.query(
      `SELECT COALESCE(max(session_number),0)+1 AS n
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND branch_id=$2 AND workspace_id=$3`,
      [DEMO.tenantId, DEMO.branchId, DEMO.workspaceId],
    );
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ($1,$2,$3,$4,$5,'till-01',$6,'2026-10-11','open',$7,'2026-10-11T14:00:00Z')`,
      [
        `till_session_bad_zone_${next.rows[0].n}`,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        DEMO.workspaceId,
        next.rows[0].n,
        `${DEMO.tenantId}:j.masri`,
      ],
    );
    await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [DEMO.branchId, "Not/AZone"]);
    const cookies = await login();
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies,
      headers: { "x-workspace-id": DEMO.workspaceId },
    });
    expect(read.statusCode, read.body).toBe(409);
    expect(read.json().code).toBe("BRANCH_TIMEZONE_UNSET");
  });

  it("keeps the business date already stored on an open till", async () => {
    await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [
      DEMO.branchId,
      "Asia/Jerusalem",
    ]);
    const next = await pool.query(
      `SELECT COALESCE(max(session_number),0)+1 AS n
         FROM ledger_till_sessions
        WHERE tenant_id=$1 AND branch_id=$2 AND workspace_id=$3`,
      [DEMO.tenantId, DEMO.branchId, DEMO.workspaceId],
    );
    const sessionId = `till_session_already_open_${next.rows[0].n}`;
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ($1,$2,$3,$4,$5,'till-01',$6,'2026-10-11','open',$7,'2026-10-11T07:00:00Z')`,
      [
        sessionId,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        DEMO.workspaceId,
        next.rows[0].n,
        `${DEMO.tenantId}:j.masri`,
      ],
    );
    const cookies = await login();
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies,
      headers: {
        "x-workspace-id": DEMO.workspaceId,
        "x-cd-now": "2026-10-12T00:30:00+03:00",
      },
    });
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json();
    expect(body.session.businessDate).toBe("2026-10-11");
    expect(body.day.businessDate).toBe("2026-10-11");
    expect(body.day.timeZone).toBe("Asia/Jerusalem");
    const from = zonedClock(body.day.from, "Asia/Jerusalem");
    expect(from).toEqual({ date: "2026-10-11", hour: "00", minute: "00" });
    const stored = await pool.query(
      `SELECT business_date, business_date::text AS text
         FROM ledger_till_sessions WHERE session_id=$1`,
      [sessionId],
    );
    expect(stored.rows[0].text).toBe("2026-10-11");
    expect(readDateOnly(stored.rows[0].business_date)).toBe("2026-10-11");
    expect(body.session.businessDate).toBe(readDateOnly(stored.rows[0].business_date));
    const utcSlice = (stored.rows[0].business_date as Date).toISOString().slice(0, 10);
    if (utcSlice !== "2026-10-11") {
      expect(body.session.businessDate).not.toBe(utcSlice);
    }
  });
});
