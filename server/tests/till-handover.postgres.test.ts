/* A till held by one person stays theirs until somebody counts it
   over. Opening again does not move the hold. A mid-day count does
   not either. The handover is the write that closes the old session
   on a blind count and opens the next one for the person who counted. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

const idOf = (staffId: string) => `${DEMO.tenantId}:${staffId}`;
const headers = { "x-workspace-id": DEMO.workspaceId };
const BLIND = { CAD: "24990.00", USD: "12010.00" };

async function login(staffId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = res.cookies.find((item) => item.name === "cdos_session");
  if (!cookie) throw new Error("sign-in did not set a session cookie");
  return { cdos_session: cookie.value };
}

async function resetLedger() {
  await pool.query(
    "TRUNCATE ledger_till_counts, ledger_till_count_batches, ledger_till_sessions, ledger_audit_events, ledger_till_balances, ledger_till_balance_generations, ledger_principals CASCADE",
  );
  await pool.query(
    "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'CAD','25000.00'), ($1,$2,$3,$4,$5,'USD','12000.00')",
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"],
  );
}

async function openAs(staffId: string) {
  const cookies = await login(staffId);
  const opened = await app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/open",
    cookies,
    headers,
  });
  expect(opened.statusCode, opened.body).toBe(201);
  return { cookies, body: opened.json() };
}

async function handover(cookies: Record<string, string>, counts: Record<string, string>, key: string) {
  return app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/handover",
    cookies,
    headers,
    payload: { idempotencyKey: key, counts },
  });
}

postgres("a second teller takes a held till by counting it", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    /* The name on a refusal is read from the ledger connection, which
       in production is the same database as the staff table. This file
       keeps the app on PGlite, so the two names have to be written here. */
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name) VALUES ($1,$2,'York FX Canada') ON CONFLICT DO NOTHING`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
      [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query(
      `INSERT INTO staff_users (id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash)
       VALUES ($1,$2,$3,$4,'a.singh','A. Singh','supervisor','[]'::jsonb,'x'),
              ($5,$2,$3,$4,'m.costa','M. Costa','teller','[]'::jsonb,'x')
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
      [idOf("a.singh"), DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, idOf("m.costa")],
    );
    app = await buildApp(handle.db);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(resetLedger);

  it("opening again leaves the first teller as the holder, and handover moves it", async () => {
    const first = await openAs("a.singh");
    expect(first.body.session.openedBy).toBe(idOf("a.singh"));
    const second = await openAs("m.costa");
    expect(second.body.session.openedBy).toBe(idOf("a.singh"));
    expect(second.body.session.sessionId).toBe(first.body.session.sessionId);

    const taken = await handover(second.cookies, BLIND, "handover-costa");
    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json().session.openedBy).toBe(idOf("m.costa"));
    expect(taken.json().session.sessionId).not.toBe(first.body.session.sessionId);
    expect(JSON.stringify(taken.json())).not.toContain("expected");

    const closed = await pool.query(
      "SELECT status, opened_by, closed_by FROM ledger_till_sessions WHERE session_id=$1",
      [first.body.session.sessionId],
    );
    expect(closed.rows[0]).toMatchObject({
      status: "closed",
      opened_by: idOf("a.singh"),
      closed_by: idOf("m.costa"),
    });
    const open = await pool.query(
      "SELECT opened_by FROM ledger_till_sessions WHERE status='open'",
    );
    expect(open.rows.map((row) => row.opened_by)).toEqual([idOf("m.costa")]);
  });

  it("records the blind count on the old session and who handed it to whom", async () => {
    const first = await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-blind");
    expect(taken.statusCode, taken.body).toBe(201);

    const lines = await pool.query(
      `SELECT c.currency, c.counted_amount::text AS counted
         FROM ledger_till_counts c
         JOIN ledger_till_count_batches b ON b.batch_id = c.batch_id
        WHERE b.session_id=$1 AND b.count_kind='close' AND b.actor_id=$2
        ORDER BY c.currency`,
      [first.body.session.sessionId, idOf("m.costa")],
    );
    expect(lines.rows).toEqual([
      { currency: "CAD", counted: "24990.00" },
      { currency: "USD", counted: "12010.00" },
    ]);
    const audit = await pool.query(
      "SELECT actor_id, reason FROM ledger_audit_events WHERE action='till.session.handover'",
    );
    expect(audit.rows).toEqual([
      { actor_id: idOf("m.costa"), reason: `from=${idOf("a.singh")}` },
    ]);
  });

  it("TILL_HELD carries the code and the holder's display name", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const refused = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: costa,
      headers,
      payload: { idempotencyKey: "costa-midday", counts: { CAD: "1.00" } },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "TILL_HELD",
      holderName: "A.\u00A0Singh",
      message: "Count the till to take it over from A.\u00A0Singh.",
    });
  });

  it("the new holder can record a count after the handover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-then-count");
    expect(taken.statusCode, taken.body).toBe(201);
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: costa,
      headers,
      payload: { idempotencyKey: "costa-after", counts: { CAD: "24990.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    expect(counted.json().session.openedBy).toBe(idOf("m.costa"));
    const batch = await pool.query(
      "SELECT actor_id, count_kind FROM ledger_till_count_batches WHERE idempotency_key='costa-after'",
    );
    expect(batch.rows).toEqual([{ actor_id: idOf("m.costa"), count_kind: "interim" }]);
  });

  it("the old holder is refused after the handover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-then-refuse");
    expect(taken.statusCode, taken.body).toBe(201);
    const singh = await login("a.singh");
    const refused = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: singh,
      headers,
      payload: { idempotencyKey: "singh-after", counts: { CAD: "1.00" } },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "TILL_HELD",
      holderName: "M.\u00A0Costa",
    });
    const still = await pool.query(
      "SELECT opened_by FROM ledger_till_sessions WHERE status='open'",
    );
    expect(still.rows.map((row) => row.opened_by)).toEqual([idOf("m.costa")]);
  });

  it("a count that skips a currency leaves the original holder", async () => {
    const first = await openAs("a.singh");
    const costa = await login("m.costa");
    const missed = await handover(costa, { CAD: "24990.00" }, "handover-short");
    expect(missed.statusCode, missed.body).toBe(422);
    expect(missed.json().code).toBe("INCOMPLETE_TILL_COUNT");
    const open = await pool.query(
      "SELECT session_id, opened_by FROM ledger_till_sessions WHERE status='open'",
    );
    expect(open.rows).toEqual([
      { session_id: first.body.session.sessionId, opened_by: idOf("a.singh") },
    ]);
  });
});
