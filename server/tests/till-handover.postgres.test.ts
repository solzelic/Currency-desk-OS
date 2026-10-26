/* A till held by one person stays theirs until somebody counts it
   over. Opening again does not move the hold. A mid-day count does
   not either. The handover is the write that closes the old session
   on a blind count and opens the next one for the person who counted. */
import { createHash } from "node:crypto";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { staffUsers } from "../src/db/schema.js";
import { hasBackendPermission } from "../src/auth/permissions.js";
import { clearPinAttempts, hashPin, lockState } from "../src/routes/pin.js";
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
    "TRUNCATE ledger_till_counts, ledger_till_count_batches, ledger_till_sessions, ledger_audit_events, ledger_till_balances, ledger_till_balance_generations, ledger_principals, ledger_idempotency CASCADE",
  );
  await pool.query(
    "DELETE FROM quote_events WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)",
    [DEMO.tenantId],
  );
  await pool.query(
    "DELETE FROM quote_overrides WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)",
    [DEMO.tenantId],
  );
  await pool.query("DELETE FROM quotes WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query(
    "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'CAD','25000.00'), ($1,$2,$3,$4,$5,'USD','12000.00')",
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"],
  );
}

async function freezeQuote(quoteId: string, createdBy: string) {
  await pool.query(
    `INSERT INTO quotes (
      quote_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
      customer_id,created_by,direction,from_currency,to_currency,
      input_amount,output_amount,market_mid,customer_rate,buy_or_sell_side,
      fee_cad,spread_cad,rate_board_publication_id,status,expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5,'till-01','cust-walk',$6,'customer_buy_foreign','CAD','USD',
      '100.00','70.00',1.4,1.36,'we_sell','0.00','4.00','board-test','active',
      clock_timestamp() + interval '1 hour', clock_timestamp())`,
    [quoteId, DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, createdBy],
  );
}

function postQuote(cookies: Record<string, string>, quoteId: string) {
  return app.inject({
    method: "POST",
    url: `/api/quotes/${quoteId}/post`,
    cookies,
    headers,
    payload: {
      idempotencyKey: `post-${quoteId}`,
      purpose: "Personal travel",
      sourceOfFunds: "Employment income",
    },
  });
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

async function handover(
  cookies: Record<string, string>,
  counts: Record<string, string>,
  key: string,
  approval?: { approverStaffId: string; approverPin: string },
) {
  return app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/handover",
    cookies,
    headers,
    payload: { idempotencyKey: key, counts, ...approval },
  });
}

async function publishMid(usdMid: string) {
  await pool.query(
    `INSERT INTO rate_boards
      (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,published_at)
     VALUES ('board-handover',$1,$2,$3,0.02,0.03,$4::jsonb,clock_timestamp())
     ON CONFLICT (id) DO UPDATE
       SET board_rows=EXCLUDED.board_rows, published_at=clock_timestamp()`,
    [
      DEMO.tenantId,
      DEMO.legalEntityId,
      DEMO.branchId,
      JSON.stringify({ USD: { mid: Number(usdMid), show: true } }),
    ],
  );
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
    await pool.query("UPDATE legal_entities SET home_currency='CAD' WHERE id=$1", [DEMO.legalEntityId]);
    const singhPin = await hashPin("1357");
    const masriPin = await hashPin("2468");
    await pool.query("UPDATE staff_users SET pin_hash=$1 WHERE id=$2", [singhPin, idOf("a.singh")]);
    await pool.query(
      `INSERT INTO staff_users
        (id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash,pin_hash)
       VALUES ($1,$2,$3,$4,'j.masri','J. Masri','administrator','[]'::jsonb,'x',$5),
              ($6,$2,$3,$4,'r.haddad','R. Haddad','branch_manager','[]'::jsonb,'x',NULL)
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, pin_hash=EXCLUDED.pin_hash, name=EXCLUDED.name`,
      [idOf("j.masri"), DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, masriPin, idOf("r.haddad")],
    );
    /* Compliance and audit sign in on a staging desk. This file's
       app database is not staging, so the two roles are written here
       with the same password as the rest of the demo staff. */
    const [known] = await handle.db.select().from(staffUsers).where(eq(staffUsers.staffId, "a.singh")).limit(1);
    if (!known) throw new Error("demo staff were not seeded");
    for (const person of [
      { staffId: "c.adebayo", name: "C. Adebayo", role: "compliance_officer" as const },
      { staffId: "l.berg", name: "L. Berg", role: "auditor" as const },
    ]) {
      await handle.db.insert(staffUsers).values({
        id: idOf(person.staffId),
        tenantId: DEMO.tenantId,
        legalEntityId: DEMO.legalEntityId,
        branchId: DEMO.branchId,
        staffId: person.staffId,
        name: person.name,
        role: person.role,
        authorizedBranchIds: [DEMO.branchId],
        passwordHash: known.passwordHash,
      }).onConflictDoNothing();
    }
    app = await buildApp(handle.db);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await resetLedger();
    await publishMid("1");
    for (const staffId of ["a.singh", "j.masri", "m.costa", "r.haddad"]) clearPinAttempts(idOf(staffId));
  });

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
    const mids = await pool.query(
      `SELECT b.count_kind, c.currency, c.board_mid_rate::text AS mid
         FROM ledger_till_counts c
         JOIN ledger_till_count_batches b ON b.batch_id = c.batch_id
        WHERE b.idempotency_key='handover-blind'
        ORDER BY b.count_kind, c.currency`,
    );
    expect(mids.rows).toEqual([
      { count_kind: "close", currency: "CAD", mid: "1.000000000000" },
      { count_kind: "close", currency: "USD", mid: "1.000000000000" },
      { count_kind: "handover", currency: "CAD", mid: "1.000000000000" },
      { count_kind: "handover", currency: "USD", mid: "1.000000000000" },
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

  it("a teller who is not the holder gets no till amounts", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const balances = await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies: costa,
      headers,
    });
    expect(balances.statusCode, balances.body).toBe(200);
    const body = balances.json();
    expect(body.balances).toEqual({});
    expect(JSON.stringify(body)).not.toMatch(/25000|12000/);
    const session = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: costa,
      headers,
    });
    expect(session.statusCode, session.body).toBe(200);
    expect(session.json()).not.toHaveProperty("handoverFlags");
    expect(JSON.stringify(session.json())).not.toMatch(/25000|12000|variance/);
    const manager = await login("r.haddad");
    const managerBook = await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies: manager,
      headers,
    });
    expect(managerBook.statusCode, managerBook.body).toBe(200);
    expect(managerBook.json().balances).toEqual({});
    expect(JSON.stringify(managerBook.json())).not.toMatch(/25000|12000/);
  });

  it("the handover audit row stores the old session, the batch, the role and the from-user on the database clock", async () => {
    const first = await openAs("a.singh");
    const costa = await login("m.costa");
    const before = await pool.query("SELECT clock_timestamp() AS t");
    const taken = await handover(costa, BLIND, "handover-audit-fields");
    const after = await pool.query("SELECT clock_timestamp() AS t");
    expect(taken.statusCode, taken.body).toBe(201);
    const audit = await pool.query(
      `SELECT actor_id, reason, prior_session_id, count_batch_id, actor_role, from_user, created_at
         FROM ledger_audit_events WHERE action='till.session.handover'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: idOf("m.costa"),
      reason: `from=${idOf("a.singh")}`,
      prior_session_id: first.body.session.sessionId,
      actor_role: "teller",
      from_user: idOf("a.singh"),
    });
    expect(String(audit.rows[0].count_batch_id)).toMatch(/^till_close_/);
    const at = new Date(audit.rows[0].created_at).getTime();
    expect(at).toBeGreaterThanOrEqual(new Date(before.rows[0].t).getTime() - 1000);
    expect(at).toBeLessThanOrEqual(new Date(after.rows[0].t).getTime() + 1000);
    const linked = await pool.query(
      "SELECT currency, variance_amount::text AS variance FROM ledger_till_counts WHERE batch_id=$1 ORDER BY currency",
      [audit.rows[0].count_batch_id],
    );
    expect(linked.rows).toEqual([
      { currency: "CAD", variance: "-10.00" },
      { currency: "USD", variance: "10.00" },
    ]);
  });

  it("a nonzero handover variance is a flag the closer roles can see and the incoming teller cannot", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-variance-flag");
    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json()).not.toHaveProperty("countResult");
    expect(JSON.stringify(taken.json())).not.toMatch(/"expected"|"variance"|25000\.00|12000\.00|-10\.00/);

    const teller = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: costa,
      headers,
    });
    expect(teller.json()).not.toHaveProperty("handoverFlags");
    expect(JSON.stringify(teller.json())).not.toMatch(/"variance"|25000\.00|12000\.00|-10\.00/);

    const seen = {
      fromName: "A.\u00A0Singh",
      toName: "M.\u00A0Costa",
      lines: [
        { currency: "CAD", variance: "-10.00" },
        { currency: "USD", variance: "10.00" },
      ],
    };
    for (const staffId of ["a.singh", "r.haddad", "j.masri"]) {
      const cookies = await login(staffId);
      const session = await app.inject({
        method: "GET",
        url: "/api/ledger/till-session",
        cookies,
        headers,
      });
      expect(session.statusCode, session.body).toBe(200);
      expect(session.json().handoverFlags).toEqual([seen]);
    }

    await resetLedger();
    await openAs("a.singh");
    const again = await login("m.costa");
    const even = await handover(again, { CAD: "25000.00", USD: "12000.00" }, "handover-even");
    expect(even.statusCode, even.body).toBe(201);
    const quiet = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: await login("a.singh"),
      headers,
    });
    expect(quiet.json().handoverFlags).toEqual([]);
    expect(quiet.json().handoverRecords).toHaveLength(1);
    expect(quiet.json().handoverRecords[0].fromName).toBe("A.\u00A0Singh");
    expect(quiet.json().handoverRecords[0].toName).toBe("M.\u00A0Costa");
    expect(quiet.json().handoverRecords[0].tillId).toBe("till-01");
  });

  it("the old holder cannot post a deal after the handover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-then-deal");
    expect(taken.statusCode, taken.body).toBe(201);
    const singh = await login("a.singh");
    const deal = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: singh,
      headers,
      payload: {
        idempotencyKey: "old-holder-deal",
        customerId: "cust-walk",
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      },
    });
    expect(deal.statusCode, deal.body).toBe(409);
    expect(deal.json().code).toBe("TILL_HELD");
  });

  it("a quote frozen before the handover cannot be posted afterwards", async () => {
    const first = await openAs("a.singh");
    await freezeQuote("qt-before-handover", idOf("a.singh"));
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-drops-quote");
    expect(taken.statusCode, taken.body).toBe(201);
    const stored = await pool.query("SELECT status FROM quotes WHERE quote_id='qt-before-handover'");
    expect(stored.rows[0].status).toBe("cancelled");
    const singh = await login("a.singh");
    const posted = await postQuote(singh, "qt-before-handover");
    expect(posted.statusCode).not.toBe(201);
    expect(posted.json().code).toBe("QUOTE_NOT_ACTIVE");
    const byCosta = await postQuote(costa, "qt-before-handover");
    expect(byCosta.statusCode).not.toBe(201);
    expect(first.body.session.openedBy).toBe(idOf("a.singh"));
  });

  it("handover is open to till:count roles and closed to the others", async () => {
    const allowed = ["j.masri", "r.haddad", "a.singh", "m.costa"];
    for (const staffId of allowed) {
      await resetLedger();
      await openAs(staffId === "a.singh" ? "m.costa" : "a.singh");
      const cookies = await login(staffId);
      const taken = await handover(cookies, BLIND, "role-" + staffId);
      expect(taken.statusCode, staffId + " " + taken.body).toBe(201);
    }
    for (const staffId of ["c.adebayo", "l.berg"]) {
      await resetLedger();
      await openAs("a.singh");
      const cookies = await login(staffId);
      const taken = await handover(cookies, BLIND, "role-" + staffId);
      expect(taken.statusCode, staffId + " " + taken.body).toBe(403);
      expect(taken.json().code).toBe("AUTHORIZATION_DENIED");
    }
  });

  it("another branch and another tenant are out of scope", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    for (const workspaceId of ["ws-other-branch", "ws-other-tenant"]) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/ledger/till-sessions/handover",
        cookies: costa,
        headers: { "x-workspace-id": workspaceId },
        payload: { idempotencyKey: "scope-" + workspaceId, counts: BLIND },
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json().code).toBe("SCOPE_DENIED");
    }
    const open = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(open.rows).toEqual([{ opened_by: idOf("a.singh") }]);
  });

  it("the old holder cannot move cash after the handover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, BLIND, "handover-then-move");
    expect(taken.statusCode, taken.body).toBe(201);
    const singh = await login("a.singh");
    const moved = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: singh,
      headers,
      payload: {
        idempotencyKey: "old-holder-move",
        direction: "out",
        currency: "CAD",
        amount: "10.00",
        counterpartyType: "other",
        counterpartyRef: "drawer",
        reason: "after handover",
      },
    });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().code).toBe("TILL_HELD");
  });

  it("tapping handover twice records one handover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const first = await handover(costa, BLIND, "double-tap");
    const second = await handover(costa, BLIND, "double-tap");
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='till.session.handover'",
    );
    expect(audits.rows[0].n).toBe(1);
    const open = await pool.query("SELECT count(*)::int AS n FROM ledger_till_sessions WHERE status='open'");
    expect(open.rows[0].n).toBe(1);
  });

  it("two people counting at once leave one open session", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const haddad = await login("r.haddad");
    await Promise.all([
      handover(costa, BLIND, "parallel-costa"),
      handover(haddad, BLIND, "parallel-haddad"),
    ]);
    const open = await pool.query("SELECT count(*)::int AS n FROM ledger_till_sessions WHERE status='open'");
    expect(open.rows[0].n).toBe(1);
  });

  it("refuses a count that is finer than the currency and does not round it", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY','1500.00')",
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"],
    );
    const yen = await handover(costa, { CAD: "25000.00", USD: "12000.00", JPY: "1500.5" }, "yen-fraction");
    expect(yen.statusCode, yen.body).toBe(422);
    const cad = await handover(costa, { CAD: "24990.004", USD: "12000.00", JPY: "1500" }, "cad-fraction");
    expect(cad.statusCode, cad.body).toBe(400);
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
    const book = await pool.query(
      "SELECT currency, available_amount::text AS amount FROM ledger_till_balances ORDER BY currency",
    );
    expect(book.rows).toEqual([
      { currency: "CAD", amount: "25000.00" },
      { currency: "JPY", amount: "1500.00" },
      { currency: "USD", amount: "12000.00" },
    ]);
    const whole = await handover(costa, { CAD: "25000.00", USD: "12000.00", JPY: "1500" }, "yen-whole");
    expect(whole.statusCode, whole.body).toBe(201);
  });

  it("CAD 20.00 exactly proceeds, and a short plus an over do not cancel", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const under = await handover(costa, { CAD: "24980.01", USD: "12000.00" }, "under-20");
    expect(under.statusCode, under.body).toBe(201);
    await resetLedger();
    await publishMid("1");
    await openAs("a.singh");
    const atLine = await login("m.costa");
    const exact = await handover(atLine, { CAD: "24980.00", USD: "12000.00" }, "exactly-20");
    expect(exact.statusCode, exact.body).toBe(201);
    expect(exact.json()).not.toHaveProperty("countResult");
    const flagged = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: await login("a.singh"),
      headers,
    });
    expect(flagged.json().handoverFlags[0].lines).toEqual([
      { currency: "CAD", variance: "-20.00" },
      { currency: "USD", variance: "0.00" },
    ]);

    await resetLedger();
    await publishMid("1");
    await openAs("a.singh");
    const cent = await login("m.costa");
    const penny = await handover(cent, { CAD: "24979.99", USD: "12000.00" }, "over-by-a-cent");
    expect(penny.statusCode, penny.body).toBe(403);
    expect(penny.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    const still = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(still.rows).toEqual([{ opened_by: idOf("a.singh") }]);

    await resetLedger();
    await publishMid("1.5");
    await openAs("a.singh");
    const again = await login("m.costa");
    const mixed = await handover(again, BLIND, "mixed-no-cancel");
    expect(mixed.statusCode, mixed.body).toBe(403);
    expect(mixed.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
  });

  it("over CAD 20 with no approver is refused and the till stays held", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const refused = await handover(costa, { CAD: "24970.00", USD: "12000.00" }, "over-20");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    expect(JSON.stringify(refused.json())).not.toMatch(/24970|25000|30\.00|book/);
    const book = await pool.query(
      "SELECT currency, available_amount::text AS amount FROM ledger_till_balances ORDER BY currency",
    );
    expect(book.rows).toEqual([
      { currency: "CAD", amount: "25000.00" },
      { currency: "USD", amount: "12000.00" },
    ]);
  });

  it("the incoming teller cannot approve their own takeover", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const refused = await handover(costa, { CAD: "24970.00", USD: "12000.00" }, "self-approve", {
      approverStaffId: "m.costa",
      approverPin: "1357",
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    expect(lockState(idOf("m.costa")).remaining).toBe(5);
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
  });

  it("a wrong approver PIN leaves the lockout counter where it was", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const refused = await handover(costa, { CAD: "24970.00", USD: "12000.00" }, "wrong-pin", {
      approverStaffId: "a.singh",
      approverPin: "0000",
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    expect(lockState(idOf("a.singh")).remaining).toBe(5);
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
  });

  it("a right approver PIN does not move the till", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const taken = await handover(costa, { CAD: "24970.00", USD: "12010.00" }, "approved", {
      approverStaffId: "a.singh",
      approverPin: "1357",
    });
    expect(taken.statusCode, taken.body).toBe(403);
    expect(taken.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    expect(lockState(idOf("a.singh")).remaining).toBe(5);
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='till.session.handover'",
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it("a branch manager has till:handover:approve", () => {
    expect(hasBackendPermission("branch_manager", "till:handover:approve")).toBe(true);
    expect(hasBackendPermission("teller", "till:handover:approve")).toBe(false);
  });

  it("two handover requests that differ only in the PIN share a hash, and the hash input has no PIN", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const counts: Record<string, string> = { CAD: "24970.00", USD: "12000.00" };
    const pinA = "1357";
    const pinB = "2468";
    const first = await handover(costa, counts, "pin-hash-a", {
      approverStaffId: "a.singh",
      approverPin: pinA,
    });
    const second = await handover(costa, counts, "pin-hash-b", {
      approverStaffId: "a.singh",
      approverPin: pinB,
    });
    expect(first.statusCode, first.body).toBe(403);
    expect(second.statusCode, second.body).toBe(403);
    const stored = await pool.query(
      `SELECT idempotency_key, request_hash
         FROM ledger_idempotency
        WHERE operation='till-handover' AND idempotency_key IN ('pin-hash-a','pin-hash-b')
        ORDER BY idempotency_key`,
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0].request_hash).toBe(stored.rows[1].request_hash);
    const input = JSON.stringify({
      counts: Object.keys(counts).sort().map((currency) => [currency, counts[currency]]),
      approverPresent: true,
    });
    for (const pin of [pinA, pinB]) expect(input).not.toContain(pin);
    expect(input).not.toContain("approverPin");
    const hash = createHash("sha256").update(input).digest("hex");
    expect(stored.rows[0].request_hash).toBe(hash);
    expect(stored.rows[1].request_hash).toBe(hash);
    const withPin = createHash("sha256").update(JSON.stringify({
      counts: Object.keys(counts).sort().map((currency) => [currency, counts[currency]]),
      approverStaffId: "a.singh",
      approverPin: pinA,
    })).digest("hex");
    expect(withPin).not.toBe(stored.rows[0].request_hash);
  });

  it("an approver and a PIN are refused before the PIN is checked", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const before = lockState(idOf("a.singh")).remaining;
    const counts = { CAD: "24970.00", USD: "12000.00" };
    const wrong = await handover(costa, counts, "pin-wrong", {
      approverStaffId: "a.singh",
      approverPin: "0000",
    });
    const right = await handover(costa, counts, "pin-right", {
      approverStaffId: "a.singh",
      approverPin: "1357",
    });
    expect(wrong.statusCode, wrong.body).toBe(403);
    expect(right.statusCode, right.body).toBe(403);
    expect(wrong.json()).toEqual(right.json());
    expect(wrong.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    expect(lockState(idOf("a.singh")).remaining).toBe(before);
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
  });

  it("the first refused count is kept, and a teller cannot submit another", async () => {
    const first = await openAs("a.singh");
    const costa = await login("m.costa");
    const before = await pool.query("SELECT clock_timestamp() AS t");
    const refused = await handover(costa, { CAD: "24970.00", USD: "12000.00" }, "refuse-first");
    const again = await handover(costa, { CAD: "25000.00", USD: "12000.00" }, "refuse-second");
    const after = await pool.query("SELECT clock_timestamp() AS t");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(again.statusCode, again.body).toBe(403);
    expect(again.json()).toEqual(refused.json());
    expect(refused.json()).toEqual({
      code: "HANDOVER_APPROVAL_REQUIRED",
      message: "The count does not match. A supervisor must approve this takeover.",
    });
    const held = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(held.rows).toEqual([{ opened_by: idOf("a.singh") }]);
    const book = await pool.query(
      "SELECT currency, available_amount::text AS amount FROM ledger_till_balances ORDER BY currency",
    );
    expect(book.rows).toEqual([
      { currency: "CAD", amount: "25000.00" },
      { currency: "USD", amount: "12000.00" },
    ]);
    const audits = await pool.query(
      `SELECT actor_id, target_id, prior_session_id, variances, created_at
         FROM ledger_audit_events
        WHERE action='till.handover.refused'
        ORDER BY created_at ASC`,
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[0]).toMatchObject({
      actor_id: idOf("m.costa"),
      target_id: "till-01",
      prior_session_id: first.body.session.sessionId,
      variances: [
        { currency: "CAD", counted: "24970.00" },
        { currency: "USD", counted: "12000.00" },
      ],
    });
    const at = new Date(audits.rows[0].created_at).getTime();
    expect(at).toBeGreaterThanOrEqual(new Date(before.rows[0].t).getTime() - 1000);
    expect(at).toBeLessThanOrEqual(new Date(after.rows[0].t).getTime() + 1000);
  });

  it("a non-holder does not receive the holder's counted figures", async () => {
    await openAs("a.singh");
    const singh = await login("a.singh");
    const recorded = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: singh,
      headers,
      payload: { idempotencyKey: "singh-counted", counts: { CAD: "11111.11", USD: "22222.22" } },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const costa = await login("m.costa");
    const session = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: costa,
      headers,
    });
    expect(session.statusCode, session.body).toBe(200);
    const payload = session.json();
    expect(JSON.stringify(payload)).not.toMatch(/11111\.11|22222\.22/);
    expect(payload.latestCounts.CAD).not.toHaveProperty("counted");
    expect(payload.latestCounts.CAD).not.toHaveProperty("actorId");
    expect(payload.latestCounts.USD).not.toHaveProperty("counted");
    expect(payload.latestCounts.USD).not.toHaveProperty("actorId");
    const own = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: singh,
      headers,
    });
    expect(String(own.json().latestCounts.CAD.counted)).toBe("11111.11");
    expect(own.json().latestCounts.CAD.actorId).toBe(idOf("a.singh"));
  });

  it("a handover key is refused when the actor or the body differs", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const first = await handover(costa, BLIND, "bound-key");
    expect(first.statusCode, first.body).toBe(201);
    const changed = await handover(costa, { CAD: "25000.00", USD: "12000.00" }, "bound-key");
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const haddad = await login("r.haddad");
    const other = await handover(haddad, BLIND, "bound-key");
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='till.session.handover'",
    );
    expect(audits.rows[0].n).toBe(1);
    const open = await pool.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(open.rows).toEqual([{ opened_by: idOf("m.costa") }]);
  });

  it("a same key replays the stored handover body", async () => {
    await openAs("a.singh");
    const costa = await login("m.costa");
    const first = await handover(costa, BLIND, "replay-key");
    const second = await handover(costa, BLIND, "replay-key");
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toEqual(first.json());
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='till.session.handover'",
    );
    expect(audits.rows[0].n).toBe(1);
  });
});
