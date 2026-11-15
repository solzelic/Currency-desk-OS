/* The deal hold is the server's. A teller response carries the neutral
   sentence and nothing about the list. A list change re-screens clients. */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { TELLER_HOLD_MESSAGE } from "../src/screening/gate.js";
import { rescreenAll } from "../src/screening/gate.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId];

postgres("sanctions hold and review", () => {
  let pool: pg.Pool;
  let handle: DbHandle;
  let app: FastifyInstance;

  const cookie = async (staffId: string) => {
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { staffId, password: DEMO.password },
    });
    const session = login.cookies.find((item) => item.name === "cdos_session");
    if (!session) throw new Error(`${staffId} login ${login.statusCode} ${login.body}`);
    return { cdos_session: session.value };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    await desk();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM sanctions_screenings");
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await pool.query("DELETE FROM client_pep_answers");
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  async function desk() {
    const s = scope;
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [s[0]]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO UPDATE SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1`,
      [s[1], s[0]],
    );
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
      [s[2], s[0], s[1]],
    );
    await pool.query(
      "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),($1||':j.masri',$1,$2,$3,$4,$5,'administrator','[\"br-yorkville\"]') ON CONFLICT DO NOTHING",
      [...s, "till-01"],
    );
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ('cust-hold',$1,$2,$3,$4,'Hold Subject','Normal','verified')
       ON CONFLICT (customer_id) DO NOTHING`,
      s,
    );
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,'till-01','CAD',25000),($1,$2,$3,$4,'till-01','USD',12000) ON CONFLICT DO NOTHING",
      s,
    );
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at)
       VALUES ('session-hold',$1,$2,$3,$4,'till-01',1,current_date,'open',$1||':m.costa',now())
       ON CONFLICT DO NOTHING`,
      s,
    );
    await pool.query(
      "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-hold','test','{\"USD\":1.4}',now()) ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
       VALUES ('board-hold',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','snap-hold',now())
       ON CONFLICT DO NOTHING`,
      s.slice(0, 3),
    );
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await pool.query(
      `INSERT INTO sanctions_list_snapshots
        (snapshot_id,source_key,source_url,fetched_at,last_checked_at,content_sha256,entry_count,status,added_count,removed_count)
       VALUES ('snp-hold','ca-sema','https://example.test/list',now(),now(),'abc',1,'good',1,0)`,
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold',$1,'["Hold Subject"]','[]')`,
      [`ca|hold-${Date.now()}`],
    );
    await pool.query(
      "UPDATE legal_entities SET compliance_officer_staff_id = 'j.masri' WHERE id = $1",
      [DEMO.legalEntityId],
    );
  }

  async function postDeal(staffId = "m.costa", customerId = "cust-hold") {
    const cookies = await cookie(staffId);
    const made = await app.inject({
      method: "POST", url: "/api/quotes", cookies,
      payload: {
        customerId, from: "CAD", to: "USD", inputAmount: "100.00",
        feeCad: "0.00", direction: "customer_buy_foreign",
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    return app.inject({
      method: "POST", url: `/api/quotes/${made.json().quoteId}/post`, cookies,
      payload: {
        idempotencyKey: `hold-${Date.now()}-${Math.random()}`,
        purpose: "Personal travel", sourceOfFunds: "Employment income",
      },
    });
  }

  it("holds the deal on the server and does not tell the teller why", async () => {
    const stamp = Date.now();
    const customerId = `cust-${stamp}`;
    const name = `Listed Person ${stamp}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified')`,
      [customerId, ...scope, name],
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold',$1,$2::jsonb,'[]')`,
      [`ca|${stamp}`, JSON.stringify([name])],
    );
    const beforeHold = await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE customer_id = $1", [customerId]);
    const held = await postDeal("m.costa", customerId);
    expect(held.statusCode).toBe(422);
    const body = held.json();
    expect(body).toEqual({ code: "NEEDS_REVIEW", message: TELLER_HOLD_MESSAGE });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/ca-sema|sourceKey|score|sanctions|Hold Subject/i);
    const posted = await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE customer_id = $1", [customerId]);
    expect(posted.rows[0].n).toBe(beforeHold.rows[0].n);

    const teller = await cookie("m.costa");
    const queue = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: teller });
    expect(queue.statusCode).toBe(403);
    expect(queue.json()).toEqual({ error: "forbidden" });

    const owner = await cookie("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    expect(reviews.statusCode).toBe(200);
    const item = reviews.json().items.find((row: { subjectName: string; status: string }) => row.subjectName === name && row.status === "open");
    if (!item) throw new Error("missing review");
    expect(item.subjectName).toBe(name);
    expect(item.matchedName).toBe(name);
    expect(reviews.json().threshold.signedOff).toBe(false);
    expect(reviews.json().threshold.note).toMatch(/pending Compliance Officer sign-off/);

    const cleared = await app.inject({
      method: "POST", url: `/api/screening/reviews/${item.reviewId}/clear`, cookies: owner,
      payload: { reason: "Same name, different date of birth on the file." },
    });
    expect(cleared.statusCode).toBe(200);
    const decision = await pool.query(
      "SELECT actor_id, action, reason FROM sanctions_review_decisions WHERE review_id=$1",
      [item.reviewId],
    );
    expect(decision.rows[0]).toMatchObject({ actor_id: "j.masri", action: "clear" });
    expect(decision.rows[0].reason).toMatch(/different date of birth/);

    const again = await postDeal("m.costa", customerId);
    expect(again.statusCode, again.body).toBe(201);
  });

  it("keeps a confirmed match held and tells the teller the same neutral line", async () => {
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ('cust-confirm',$1,$2,$3,$4,'Confirm Subject','Normal','verified')
       ON CONFLICT (customer_id) DO NOTHING`,
      scope,
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold','ca|confirm','["Confirm Subject"]','[]')
       ON CONFLICT DO NOTHING`,
    );
    const held = await postDeal("m.costa", "cust-confirm");
    expect(held.statusCode).toBe(422);
    const owner = await cookie("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    const reviewId = reviews.json().items[0].reviewId;
    const confirmed = await app.inject({
      method: "POST", url: `/api/screening/reviews/${reviewId}/confirm`, cookies: owner,
      payload: { reason: "The name and the date of birth agree." },
    });
    expect(confirmed.statusCode).toBe(200);
    const still = await postDeal("m.costa", "cust-confirm");
    expect(still.statusCode).toBe(422);
    expect(still.json()).toEqual({ code: "NEEDS_REVIEW", message: "This needs review. Your compliance officer will review this." });
    expect(JSON.stringify(still.json())).not.toMatch(/LPEPR|FINTRAC|RCMP|CSIS/);
    const refused = await app.inject({
      method: "POST", url: `/api/screening/reviews/${reviewId}/clear`, cookies: owner,
      payload: { reason: "Trying to clear a confirmed match." },
    });
    expect(refused.statusCode).toBe(409);
    const task = await pool.query(
      "SELECT task_id, instruction, retain_until > now() + interval '4 years' AS kept FROM sanctions_officer_tasks WHERE review_id = $1",
      [reviewId],
    );
    expect(task.rows[0].instruction).toBe("File a listed person or entity property report (LPEPR) with FINTRAC without delay, and disclose to the RCMP and CSIS.");
    expect(task.rows[0].kept).toBe(true);
    const done = await app.inject({
      method: "POST", url: `/api/screening/tasks/${task.rows[0].task_id}/done`, cookies: owner,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().doneBy).toBe("j.masri");
    const again = await app.inject({
      method: "POST", url: `/api/screening/tasks/${task.rows[0].task_id}/done`, cookies: owner,
    });
    expect(again.statusCode).toBe(409);
    await expect(pool.query("UPDATE sanctions_review_decisions SET reason = 'changed'")).rejects.toThrow(/append-only/);
  });

  it("re-screens clients when a list changes and screens every id check tier", async () => {
    const teller = await cookie("m.costa");
    const created = await app.inject({
      method: "POST", url: "/api/clients", cookies: teller,
      payload: { legalName: "Rescreen Person", dateOfBirth: "1980-01-02" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const clientId = created.json().clientId as string;
    const before = await pool.query("SELECT count(*)::int AS n FROM sanctions_reviews WHERE client_id=$1", [clientId]);
    expect(before.rows[0].n).toBe(0);

    await pool.query(
      `INSERT INTO sanctions_list_snapshots
        (snapshot_id,source_key,source_url,fetched_at,last_checked_at,content_sha256,entry_count,status,added_count,removed_count)
       VALUES ('snp-new','ca-cc','https://example.test/page',now(),now(),'def',1,'good',1,0)`,
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-new','cc|9','["Rescreen Person"]','[]')`,
    );
    const held = await rescreenAll(pool);
    expect(held).toBeGreaterThan(0);
    const after = await pool.query(
      "SELECT status FROM sanctions_reviews WHERE client_id=$1 AND status='open'",
      [clientId],
    );
    expect(after.rowCount).toBe(1);

    const missing = await app.inject({
      method: "POST", url: "/api/screening/id-check", cookies: teller,
      payload: { clientId, tier: "1" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("pep_answer_required");

    for (const tier of ["1", "2", "quick", "verify", "3", "plus"]) {
      const body: Record<string, unknown> = { clientId, tier };
      if (tier === "1" || tier === "2" || tier === "quick" || tier === "verify") body.pepAnswer = false;
      const screened = await app.inject({
        method: "POST", url: "/api/screening/id-check", cookies: teller, payload: body,
      });
      expect(screened.statusCode, `${tier} ${screened.body}`).toBe(200);
      expect(screened.json().screened).toBe(true);
      const raw = JSON.stringify(screened.json());
      expect(raw).not.toMatch(/ca-sema|ca-cc|sourceKey|matchedName|score/);
      if (screened.json().state === "needs_review") expect(screened.json().message).toBe(TELLER_HOLD_MESSAGE);
    }
    const pep = await pool.query("SELECT is_pep, tier, answered_by FROM client_pep_answers WHERE client_id=$1", [clientId]);
    expect(pep.rows[0].is_pep).toBe(false);
    expect(pep.rows[0].answered_by).toBe("m.costa");
    expect(readFileSync(new URL("../src/screening/provider.ts", import.meta.url), "utf8")).not.toMatch(/fetch\(/);
  });

  it("refuses the owner until the shop names them, and a teller always", async () => {
    await pool.query("UPDATE legal_entities SET compliance_officer_staff_id = NULL WHERE id = $1", [DEMO.legalEntityId]);
    const owner = await cookie("j.masri");
    const teller = await cookie("m.costa");
    const unnamed = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    expect(unnamed.statusCode).toBe(403);
    expect(unnamed.json()).toEqual({
      error: "name_compliance_officer",
      message: "Name your compliance officer. Every MSB must have one.",
    });
    expect((await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: teller })).statusCode).toBe(403);
    await pool.query("UPDATE legal_entities SET compliance_officer_staff_id = 'j.masri' WHERE id = $1", [DEMO.legalEntityId]);
    expect((await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner })).statusCode).toBe(200);
  });

  it("records not_screened when the list is missing or older than 24 hours", async () => {
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ('cust-stale',$1,$2,$3,$4,'Stale Subject','Normal','verified')
       ON CONFLICT (customer_id) DO NOTHING`,
      scope,
    );
    await pool.query("UPDATE sanctions_list_snapshots SET last_checked_at = now() - interval '25 hours' WHERE status = 'good'");
    const stale = await postDeal("m.costa", "cust-stale");
    expect(stale.statusCode, stale.body).toBe(201);
    expect(stale.json().screening).toBe("Not screened");
    const staleRow = await pool.query("SELECT outcome FROM sanctions_screenings ORDER BY created_at DESC LIMIT 1");
    expect(staleRow.rows[0].outcome).toBe("not_screened");
    await pool.query("DELETE FROM sanctions_list_entries WHERE snapshot_id = 'snp-hold'");
    await pool.query("DELETE FROM sanctions_list_snapshots WHERE snapshot_id = 'snp-hold'");
    const missing = await postDeal("m.costa", "cust-stale");
    expect(missing.statusCode, missing.body).toBe(201);
    expect(missing.json().screening).toBe("Not screened");
    const teller = await cookie("m.costa");
    const created = await app.inject({
      method: "POST", url: "/api/clients", cookies: teller,
      payload: { legalName: "Unscreened Person" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().screeningOutcome).toBe("not_screened");
    await pool.query(
      `INSERT INTO sanctions_list_snapshots
        (snapshot_id,source_key,source_url,fetched_at,last_checked_at,content_sha256,entry_count,status,added_count,removed_count)
       VALUES ('snp-hold','ca-sema','https://example.test/list',now(),now(),'abc',1,'good',1,0)`,
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold','ca|hold','["Hold Subject"]','[]')`,
    );
  });

  it("holds every other candidate after the best match is cleared", async () => {
    const stamp = Date.now();
    const customerId = `cust-two-${stamp}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,'Ivan Petrov','Normal','verified')`,
      [customerId, ...scope],
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs) VALUES
        ('snp-hold',$1,'["Ivan Petrov"]','[]'),
        ('snp-hold',$2,'["Ivan Ivanovich Petrov"]','[]')`,
      [`ca|ivan-${stamp}`, `ca|ivanovich-${stamp}`],
    );
    const held = await postDeal("m.costa", customerId);
    expect(held.statusCode, held.body).toBe(422);
    const owner = await cookie("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    const items = reviews.json().items.filter((row: { subjectName: string; status: string }) => row.subjectName === "Ivan Petrov" && row.status === "open");
    expect(items).toHaveLength(2);
    const first = await app.inject({
      method: "POST", url: `/api/screening/reviews/${items[0].reviewId}/clear`, cookies: owner,
      payload: { reason: "The first listed person is a different man." },
    });
    expect(first.statusCode).toBe(200);
    const still = await postDeal("m.costa", customerId);
    expect(still.statusCode).toBe(422);
    const second = await app.inject({
      method: "POST", url: `/api/screening/reviews/${items[1].reviewId}/clear`, cookies: owner,
      payload: { reason: "The second listed person is a different man." },
    });
    expect(second.statusCode).toBe(200);
    const posted = await postDeal("m.costa", customerId);
    expect(posted.statusCode, posted.body).toBe(201);
  });

  it("refuses teller, supervisor, auditor, and branch manager on every queue route", async () => {
    await handle.db.execute(sql`
      INSERT INTO staff_users (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, authorized_branch_ids, password_hash, active)
      SELECT ${DEMO.tenantId} || ':l.berg', tenant_id, legal_entity_id, branch_id, 'l.berg', 'L. Berg', 'auditor', authorized_branch_ids, password_hash, true
        FROM staff_users WHERE staff_id = 'm.costa'
      ON CONFLICT (id) DO UPDATE
        SET password_hash = EXCLUDED.password_hash, role = 'auditor', active = true
    `);
    const roles = ["m.costa", "a.singh", "l.berg", "r.haddad"];
    for (const staffId of roles) {
      const cookies = await cookie(staffId);
      expect((await app.inject({ method: "GET", url: "/api/screening/reviews", cookies })).statusCode, staffId).toBe(403);
      expect((await app.inject({
        method: "POST", url: "/api/screening/reviews/rev-missing/clear", cookies,
        payload: { reason: "Not this person." },
      })).statusCode, staffId).toBe(403);
      expect((await app.inject({
        method: "POST", url: "/api/screening/reviews/rev-missing/confirm", cookies,
        payload: { reason: "Not this person." },
      })).statusCode, staffId).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/screening/tasks/task-missing/done", cookies })).statusCode, staffId).toBe(403);
    }
  });

  it("returns 404 for a review or task that belongs to another shop", async () => {
    await pool.query(
      `INSERT INTO sanctions_reviews
        (review_id, tenant_id, legal_entity_id, screening_id, subject_name, status)
       VALUES ('rev-other-shop','other-tenant','other-entity','scr-other','Other Shop','open')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO sanctions_officer_tasks (task_id, review_id, tenant_id, legal_entity_id, instruction)
       VALUES ('task-other-shop','rev-other-shop','other-tenant','other-entity','Do not show this.')
       ON CONFLICT DO NOTHING`,
    );
    const owner = await cookie("j.masri");
    const clear = await app.inject({
      method: "POST", url: "/api/screening/reviews/rev-other-shop/clear", cookies: owner,
      payload: { reason: "Wrong shop." },
    });
    expect(clear.statusCode).toBe(404);
    const missing = await app.inject({
      method: "POST", url: "/api/screening/reviews/rev-does-not-exist/clear", cookies: owner,
      payload: { reason: "Nobody." },
    });
    expect(missing.statusCode).toBe(404);
    const task = await app.inject({ method: "POST", url: "/api/screening/tasks/task-other-shop/done", cookies: owner });
    expect(task.statusCode).toBe(404);
  });

  it("does not record a clear while the score is unsigned, and not when one list is stale", async () => {
    await pool.query(
      `INSERT INTO sanctions_list_snapshots
        (snapshot_id,source_key,source_url,fetched_at,last_checked_at,content_sha256,entry_count,status)
       VALUES
        ('snp-un','un-sc','https://example.test/un',now(),now(),'un',1,'good'),
        ('snp-cc','ca-cc','https://example.test/cc',now(),now(),'cc',1,'good')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs) VALUES
        ('snp-un','un|quiet','["Somebody Else"]','[]'),
        ('snp-cc','cc|quiet','["Somebody Else"]','[]')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query("UPDATE sanctions_list_snapshots SET last_checked_at = now() WHERE snapshot_id IN ('snp-hold','snp-un','snp-cc')");
    const quiet = `cust-quiet-${Date.now()}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,'Quiet Person','Normal','verified')`,
      [quiet, ...scope],
    );
    const unsigned = await postDeal("m.costa", quiet);
    expect(unsigned.statusCode, unsigned.body).toBe(201);
    expect(unsigned.json().screening).toBe("Not screened");
    const unsignedRow = await pool.query(
      "SELECT outcome FROM sanctions_screenings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [quiet],
    );
    expect(unsignedRow.rows[0].outcome).toBe("not_screened");
    await pool.query(
      `INSERT INTO sanctions_score_settings (legal_entity_id, score_threshold, signed_off)
       VALUES ($1, 0.92, true)
       ON CONFLICT (legal_entity_id) DO UPDATE SET signed_off = true`,
      [DEMO.legalEntityId],
    );
    const signed = await postDeal("m.costa", quiet);
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json().screening).toBeUndefined();
    const signedRow = await pool.query(
      "SELECT outcome FROM sanctions_screenings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [quiet],
    );
    expect(signedRow.rows[0].outcome).toBe("clear");
    await pool.query("UPDATE sanctions_list_snapshots SET last_checked_at = now() - interval '25 hours' WHERE snapshot_id = 'snp-un'");
    const stale = await postDeal("m.costa", quiet);
    expect(stale.statusCode, stale.body).toBe(201);
    expect(stale.json().screening).toBe("Not screened");
    const staleRow = await pool.query(
      "SELECT outcome FROM sanctions_screenings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [quiet],
    );
    expect(staleRow.rows[0].outcome).toBe("not_screened");
    await pool.query("UPDATE sanctions_score_settings SET signed_off = false WHERE legal_entity_id = $1", [DEMO.legalEntityId]);
    await pool.query("UPDATE sanctions_list_snapshots SET last_checked_at = now() WHERE snapshot_id = 'snp-un'");
  });

  it("holds cheque, remittance, bill, and money order posts with one guard", async () => {
    const stamp = Date.now();
    const customerId = `cust-money-${stamp}`;
    const name = `Money Subject ${stamp}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified')`,
      [customerId, ...scope, name],
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold',$1,$2::jsonb,'[]')`,
      [`ca|money-${stamp}`, JSON.stringify([name])],
    );
    const cookies = await cookie("m.costa");
    const routes: Array<[string, Record<string, unknown>, string]> = [
      ["/api/ledger/cheques", {
        customerId, chequeNumber: "004821", maker: "Northbridge", draweeBank: "RBC",
        chequeType: "business", typeLabel: "Business", currency: "CAD", faceAmount: "100.00",
        feeAmount: "0.00", holdDays: 0,
      }, "ledger_cheques"],
      ["/api/ledger/remittances/send", {
        customerId, reference: "RM-1", principalAmount: "10.00", feeAmount: "0.00",
        payoutCurrency: "USD", payoutAmount: "7.00", corridor: "US", partner: "Partner",
        beneficiaryName: "Ann", purpose: "Family support", sourceOfFunds: "Salary",
      }, "ledger_obligations"],
      ["/api/ledger/remittances/receive", {
        customerId, reference: "RR-1", sentCurrency: "USD", sentAmount: "10.00",
        payoutAmount: "10.00", feeAmount: "0.00", corridor: "US", partner: "Partner",
      }, "ledger_obligations"],
      ["/api/ledger/bill-payments", {
        customerId, reference: "BP-1", billAmount: "10.00", feeAmount: "0.00",
        biller: "Hydro", accountRef: "acct-1",
      }, "ledger_obligations"],
      ["/api/ledger/money-orders", {
        customerId, reference: "MO-1", faceAmount: "10.00", feeAmount: "0.00",
        payee: "Ann Payee", serial: `MO-${stamp}`,
      }, "ledger_obligations"],
    ];
    for (const [url, payload, table] of routes) {
      const before = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      const held = await app.inject({
        method: "POST", url, cookies,
        payload: { ...payload, idempotencyKey: `money-${url}-${stamp}` },
      });
      expect(held.statusCode, `${url} ${held.body}`).toBe(422);
      expect(held.json()).toEqual({ code: "NEEDS_REVIEW", message: TELLER_HOLD_MESSAGE });
      const after = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(after.rows[0].n, url).toBe(before.rows[0].n);
    }

    const quiet = `cust-settle-${stamp}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,'Settle Later','Normal','verified')`,
      [quiet, ...scope],
    );
    await pool.query("UPDATE rate_boards SET published_at = now()");
    const received = await app.inject({
      method: "POST", url: "/api/ledger/remittances/receive", cookies,
      payload: {
        idempotencyKey: `recv-${stamp}`,
        customerId: quiet,
        reference: `RR-${stamp}`,
        sentCurrency: "USD",
        sentAmount: "10.00",
        payoutAmount: "10.00",
        feeAmount: "0.00",
        corridor: "US",
        partner: "Partner",
      },
    });
    expect(received.statusCode, received.body).toBe(201);
    const obligationId = received.json().obligationId as string;
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold',$1,'["Settle Later"]','[]')`,
      [`ca|settle-${stamp}`],
    );
    const manager = await cookie("r.haddad");
    const beforeSettle = await pool.query(
      "SELECT status FROM ledger_obligations WHERE obligation_id = $1",
      [obligationId],
    );
    const settled = await app.inject({
      method: "POST", url: `/api/ledger/obligations/${obligationId}/settlement`, cookies: manager,
      payload: { idempotencyKey: `settle-${stamp}`, amountHome: "10.00" },
    });
    expect(settled.statusCode, settled.body).toBe(422);
    expect(settled.json()).toEqual({ code: "NEEDS_REVIEW", message: TELLER_HOLD_MESSAGE });
    const afterSettle = await pool.query(
      "SELECT status FROM ledger_obligations WHERE obligation_id = $1",
      [obligationId],
    );
    expect(afterSettle.rows[0].status).toBe(beforeSettle.rows[0].status);
  });

  it("opens a review when the screen fails, matches an alias, and holds a blank name", async () => {
    const teller = await cookie("m.costa");
    const created = await app.inject({
      method: "POST", url: "/api/clients", cookies: teller,
      payload: { legalName: "Alias Person", dateOfBirth: "1981-02-02" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const clientId = created.json().clientId as string;
    const refused = await app.inject({
      method: "PATCH", url: `/api/clients/${clientId}`, cookies: teller,
      payload: { screeningOutcome: "clear" },
    });
    expect(refused.statusCode).toBe(422);
    const aliased = await app.inject({
      method: "POST", url: `/api/clients/${clientId}/aliases`, cookies: teller,
      payload: { alias: "Hold Subject" },
    });
    expect(aliased.statusCode, aliased.body).toBe(200);
    expect(aliased.json().screeningOutcome).toBe("possible");
    const aliasReviews = await pool.query(
      "SELECT count(*)::int AS n FROM sanctions_reviews WHERE client_id = $1 AND status = 'open'",
      [clientId],
    );
    expect(aliasReviews.rows[0].n).toBeGreaterThan(0);

    const blank = `cust-blank-${Date.now()}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,' ','Normal','verified')`,
      [blank, ...scope],
    );
    const unnamed = await postDeal("m.costa", blank);
    expect(unnamed.statusCode, unnamed.body).toBe(422);
    expect(unnamed.json().code).toBe("NEEDS_REVIEW");

    const broken = `cust-broken-${Date.now()}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,'Broken Subject','Normal','verified')`,
      [broken, ...scope],
    );
    (globalThis as { __cdScreeningFail?: boolean }).__cdScreeningFail = true;
    try {
      const failed = await postDeal("m.costa", broken);
      expect(failed.statusCode, failed.body).toBe(422);
    } finally {
      delete (globalThis as { __cdScreeningFail?: boolean }).__cdScreeningFail;
    }
    const opened = await pool.query(
      "SELECT count(*)::int AS n FROM sanctions_reviews WHERE customer_id = $1 AND status = 'open'",
      [broken],
    );
    expect(opened.rows[0].n).toBeGreaterThan(0);
  });

  it("agrees the open-review count with the client file and the desk tile", async () => {
    const owner = await cookie("j.masri");
    const desk = await app.inject({ method: "GET", url: "/api/screening/desk", cookies: owner });
    expect(desk.statusCode).toBe(200);
    const counted = await pool.query(
      "SELECT count(*)::int AS n FROM sanctions_reviews WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'",
      [DEMO.tenantId, DEMO.legalEntityId],
    );
    expect(desk.json().openReviews).toBe(counted.rows[0].n);
    expect(desk.json().label).toBe(counted.rows[0].n > 0 ? `${counted.rows[0].n} to review` : "Not screened");
    const teller = await cookie("m.costa");
    const listed = await app.inject({ method: "GET", url: "/api/clients", cookies: teller });
    const alias = listed.json().clients.find((row: { legalName: string }) => row.legalName === "Alias Person");
    expect(alias.screeningOutcome).toBe("possible");
    const openFor = await pool.query(
      "SELECT count(*)::int AS n FROM sanctions_reviews WHERE client_id = $1 AND status = 'open'",
      [alias.clientId],
    );
    expect(alias.screeningOpenReviews).toBe(openFor.rows[0].n);
    const screened = await pool.query(
      "SELECT list_snapshots FROM sanctions_screenings WHERE customer_id LIKE 'cust-two-%' ORDER BY created_at DESC LIMIT 1",
    );
    expect(JSON.stringify(screened.rows[0].list_snapshots)).toMatch(/snp-hold/);
  });

  it("keeps holds until the owner names themselves, and a manager still cannot decide", async () => {
    await pool.query("UPDATE rate_boards SET published_at = now()");
    await pool.query("UPDATE legal_entities SET compliance_officer_staff_id = NULL WHERE id = $1", [DEMO.legalEntityId]);
    const stamp = Date.now();
    const customerId = `cust-self-${stamp}`;
    const name = `Self Officer ${stamp}`;
    await pool.query(
      `INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified')`,
      [customerId, ...scope, name],
    );
    await pool.query(
      `INSERT INTO sanctions_list_entries (snapshot_id,entry_key,names,dobs)
       VALUES ('snp-hold',$1,$2::jsonb,'[]')`,
      [`ca|self-${stamp}`, JSON.stringify([name])],
    );
    const held = await postDeal("m.costa", customerId);
    expect(held.statusCode, held.body).toBe(422);
    const again = await postDeal("m.costa", customerId);
    expect(again.statusCode).toBe(422);

    const owner = await cookie("j.masri");
    const prompt = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    expect(prompt.statusCode).toBe(403);
    expect(prompt.json()).toEqual({
      error: "name_compliance_officer",
      message: "Name your compliance officer. Every MSB must have one.",
    });
    const desk = await app.inject({ method: "GET", url: "/api/screening/desk", cookies: owner });
    expect(desk.json().officerNamed).toBe(false);

    const manager = await cookie("r.haddad");
    expect((await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: manager })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/screening/officer", cookies: manager, payload: {} })).statusCode).toBe(403);

    const named = await app.inject({ method: "PUT", url: "/api/screening/officer", cookies: owner, payload: {} });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().staffId).toBe("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    expect(reviews.statusCode).toBe(200);
    const item = reviews.json().items.find((row: { subjectName: string; status: string }) => row.subjectName === name && row.status === "open");
    if (!item) throw new Error("missing review");
    const cleared = await app.inject({
      method: "POST", url: `/api/screening/reviews/${item.reviewId}/clear`, cookies: owner,
      payload: { reason: "The owner is the compliance officer and this is not the listed person." },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await app.inject({
      method: "POST", url: `/api/screening/reviews/${item.reviewId}/confirm`, cookies: manager,
      payload: { reason: "A manager must not decide." },
    })).statusCode).toBe(403);
    await pool.query("UPDATE legal_entities SET compliance_officer_staff_id = 'j.masri' WHERE id = $1", [DEMO.legalEntityId]);
  });
});
