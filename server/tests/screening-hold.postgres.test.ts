/* The deal hold is the server's. A teller response carries the neutral
   sentence and nothing about the list. A list change re-screens clients. */
import { readFileSync } from "node:fs";
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
    return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
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
    await pool.query("DELETE FROM sanctions_review_decisions");
    await pool.query("DELETE FROM sanctions_reviews");
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
       VALUES ('snp-hold','ca|hold','["Hold Subject"]','[]')`,
    );
  }

  async function postDeal(staffId = "m.costa") {
    const cookies = await cookie(staffId);
    const made = await app.inject({
      method: "POST", url: "/api/quotes", cookies,
      payload: {
        customerId: "cust-hold", from: "CAD", to: "USD", inputAmount: "100.00",
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
    const held = await postDeal();
    expect(held.statusCode).toBe(422);
    const body = held.json();
    expect(body).toEqual({ code: "NEEDS_REVIEW", message: TELLER_HOLD_MESSAGE });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/ca-sema|sourceKey|score|sanctions|Hold Subject/i);
    const posted = await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE tenant_id=$1", [DEMO.tenantId]);
    expect(posted.rows[0].n).toBe(0);

    const teller = await cookie("m.costa");
    const queue = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: teller });
    expect(queue.statusCode).toBe(403);
    expect(queue.json()).toEqual({ error: "forbidden" });

    const owner = await cookie("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    expect(reviews.statusCode).toBe(200);
    const item = reviews.json().items[0];
    expect(item.subjectName).toBe("Hold Subject");
    expect(item.matchedName).toBe("Hold Subject");
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

    const again = await postDeal();
    expect(again.statusCode, again.body).toBe(201);
  });

  it("keeps a confirmed match held", async () => {
    await pool.query("DELETE FROM sanctions_review_decisions");
    await pool.query("DELETE FROM sanctions_reviews");
    const held = await postDeal();
    expect(held.statusCode).toBe(422);
    const owner = await cookie("j.masri");
    const reviews = await app.inject({ method: "GET", url: "/api/screening/reviews", cookies: owner });
    const reviewId = reviews.json().items[0].reviewId;
    const confirmed = await app.inject({
      method: "POST", url: `/api/screening/reviews/${reviewId}/confirm`, cookies: owner,
      payload: { reason: "The name and the date of birth agree." },
    });
    expect(confirmed.statusCode).toBe(200);
    const still = await postDeal();
    expect(still.statusCode).toBe(422);
    expect(still.json()).toEqual({ code: "NEEDS_REVIEW", message: TELLER_HOLD_MESSAGE });
  });

  it("re-screens clients when a list changes and screens every id check tier", async () => {
    await pool.query("DELETE FROM sanctions_review_decisions");
    await pool.query("DELETE FROM sanctions_reviews");
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
});
