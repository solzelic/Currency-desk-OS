/* Settings can set the branch time zone.

   The dropdown used to write the browser's saved settings, so
   branches.timezone stayed America/Toronto. An owner or a manager
   can set a real IANA zone. A teller cannot. An invalid zone is
   422. The change is an audit row. An open till keeps the business
   date and the zone it opened with; the next open uses the new zone. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { businessDate } from "../src/ledger/business-date.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
const clockBefore = process.env.CD_TEST_CLOCK;

const AT = "2026-10-12T03:30:00.000Z";

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((item) => item.name === "cdos_session");
  return cookie ? { cdos_session: cookie.value } : {};
}

postgres("a branch time zone can be set from the desk", () => {
  beforeAll(async () => {
    process.env.CD_TEST_CLOCK = "1";
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
    await pool.query("UPDATE branches SET timezone='America/Toronto' WHERE id=$1", [
      DEMO.branchId,
    ]);
    await pool.query(
      `UPDATE ledger_till_sessions
          SET status='closed', closed_by=$1, closed_at=now()
        WHERE tenant_id=$2 AND branch_id=$3 AND workspace_id=$4 AND status='open'`,
      [`${DEMO.tenantId}:test`, DEMO.tenantId, DEMO.branchId, DEMO.workspaceId],
    );
  });

  async function login(staffId: string): Promise<Record<string, string>> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(res.statusCode).toBe(200);
    const cookies = cookieOf(res);
    if (!cookies.cdos_session) throw new Error("login did not set a session");
    return cookies;
  }

  function putZone(cookies: Record<string, string>, timezone: string, at?: string) {
    return app.inject({
      method: "PUT",
      url: "/api/ledger/branch-timezone",
      cookies,
      headers: {
        "x-workspace-id": DEMO.workspaceId,
        ...(at ? { "x-cd-now": at } : {}),
      },
      payload: { timezone },
    });
  }

  async function storedZone() {
    const row = await pool.query("SELECT timezone FROM branches WHERE id=$1", [DEMO.branchId]);
    return row.rows[0].timezone as string;
  }

  it("lets an owner set the zone and writes who changed it, from what, and when", async () => {
    const owner = await login("j.masri");
    const res = await putZone(owner, "Europe/London");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ branchId: DEMO.branchId, timezone: "Europe/London" });
    expect(await storedZone()).toBe("Europe/London");

    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/branch-timezone",
      cookies: owner,
      headers: { "x-workspace-id": DEMO.workspaceId },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().timezone).toBe("Europe/London");

    const audit = await pool.query(
      `SELECT actor_id, reason, created_at
         FROM ledger_audit_events
        WHERE action='branch.timezone.change' AND branch_id=$1
        ORDER BY created_at DESC
        LIMIT 1`,
      [DEMO.branchId],
    );
    expect(audit.rows[0].actor_id).toBe(`${DEMO.tenantId}:j.masri`);
    expect(audit.rows[0].reason).toBe("America/Toronto → Europe/London");
    const when = new Date(audit.rows[0].created_at);
    expect(Math.abs(Date.now() - when.getTime())).toBeLessThan(120_000);
  });

  it("lets a manager set the zone", async () => {
    const manager = await login("r.haddad");
    const res = await putZone(manager, "America/Vancouver");
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedZone()).toBe("America/Vancouver");
  });

  it("refuses a zone Intl cannot read, and leaves the row alone", async () => {
    const owner = await login("j.masri");
    const res = await putZone(owner, "Not/AZone");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe("INVALID_TIMEZONE");
    expect(res.json().message).toMatch(/not a time zone/i);
    expect(await storedZone()).toBe("America/Toronto");
  });

  it("refuses a teller and a supervisor", async () => {
    for (const staffId of ["m.costa", "a.singh"]) {
      const res = await putZone(await login(staffId), "Europe/London");
      expect(res.statusCode, res.body).toBe(403);
      expect(await storedZone()).toBe("America/Toronto");
    }
  });

  it("keeps an open session's business date and applies the zone on the next open", async () => {
    const at = new Date(AT);
    const openedAs = businessDate(at, "America/Toronto");
    const nextAs = businessDate(at, "Asia/Jerusalem");
    expect(openedAs).not.toBe(nextAs);

    const owner = await login("j.masri");
    const headers = { "x-workspace-id": DEMO.workspaceId, "x-cd-now": AT };
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: owner,
      headers,
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const sessionId = opened.json().session.sessionId as string;
    expect(opened.json().session.businessDate).toBe(openedAs);
    expect(opened.json().day.timeZone).toBe("America/Toronto");

    const changed = await putZone(owner, "Asia/Jerusalem", AT);
    expect(changed.statusCode, changed.body).toBe(200);

    const still = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: owner,
      headers,
    });
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().session.businessDate).toBe(openedAs);
    expect(still.json().day.timeZone).toBe("America/Toronto");
    expect(still.json().day.businessDate).toBe(openedAs);

    const stored = await pool.query(
      `SELECT business_date::text AS text, opened_timezone
         FROM ledger_till_sessions WHERE session_id=$1`,
      [sessionId],
    );
    expect(stored.rows[0].text).toBe(openedAs);
    expect(stored.rows[0].opened_timezone).toBe("America/Toronto");
    expect(await storedZone()).toBe("Asia/Jerusalem");

    await pool.query(
      `UPDATE ledger_till_sessions
          SET status='closed', closed_by=$2, closed_at=now()
        WHERE session_id=$1`,
      [sessionId, `${DEMO.tenantId}:j.masri`],
    );
    const again = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: owner,
      headers,
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().session.businessDate).toBe(nextAs);
    expect(again.json().day.timeZone).toBe("Asia/Jerusalem");
    expect(again.json().session.sessionId).not.toBe(sessionId);
  });
});
