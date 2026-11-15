import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { SHOP_CHECK_SQL, loadShopCheck } from "../src/exchange/id-check.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
let who = "cust-v29";

const quoteBody = (amount: string, id = who, extra: Record<string, unknown> = {}) => ({
  customerId: id,
  from: "CAD",
  to: "USD",
  inputAmount: amount,
  feeCad: "0.00",
  direction: "customer_buy_foreign",
  ...extra,
});
const postBody = (idempotencyKey: string, extra: Record<string, unknown> = {}) => ({
  idempotencyKey,
  purpose: "Travel",
  sourceOfFunds: "Employment",
  occupationText: "Nurse",
  ...extra,
});

async function cookie(staffId = "m.costa") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function reset() {
  await pool.query(
    `TRUNCATE ledger_vault_balances, ledger_vault_movements, ledger_cost_lot_consumption, ledger_cost_lots,
            ledger_cost_events, quote_events, quote_overrides, quotes, ledger_operational_cash_movements,
            ledger_till_counts, ledger_till_count_batches, ledger_till_sessions, ledger_audit_events,
            ledger_reversal_entries, ledger_reversals, ledger_till_movements, ledger_journal_entries,
            ledger_transactions, ledger_idempotency, ledger_till_balances, ledger_rates, ledger_customers,
            ledger_principals, rate_boards, market_rates CASCADE`,
  );
  const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','[\"br-yorkville\"]')",
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified'),($5,$1,$2,$3,$4,'V29 Customer','Normal','verified')",
    [...scope.slice(0, 4), who],
  );
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  for (const [code, amount] of [["CAD", 25000], ["USD", 12000], ["EUR", 7000], ["GBP", 3500]] as const) {
    await pool.query("INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)", [...scope, code, amount]);
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
       (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, session_number, business_date, status, opened_by, opened_at)
     VALUES ('session-v29',$1,$2,$3,$4,$5,1,current_date,'open',$1||':m.costa',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id, provider, mids, fetched_at) VALUES ('snap-v29','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, market_snapshot_id, published_at)
     VALUES ('board-v29',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','snap-v29',now())`,
    scope.slice(0, 3),
  );
}

async function addCustomer(id: string) {
  await pool.query(
    "INSERT INTO ledger_customers VALUES ($5,$1,$2,$3,$4,$6,'Normal','verified') ON CONFLICT DO NOTHING",
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, id, `Customer ${id}`],
  );
}

async function quote(amount: string, id = who) {
  const made = await app.inject({
    method: "POST",
    url: "/api/quotes",
    cookies: await cookie(),
    payload: quoteBody(amount, id),
  });
  expect(made.statusCode, made.body).toBe(201);
  return made.json();
}

async function post(quoteId: string, key: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/quotes/${quoteId}/post`,
    cookies: await cookie(),
    payload: postBody(key, extra),
  });
}

postgres("exchange v2.9 against PostgreSQL", () => {
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
  });
  beforeEach(async () => {
    who = `c${Math.random().toString(16).slice(2, 10)}`;
    await reset();
    await addCustomer(who);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await handle.close();
  });

  it("issues a review lock of at most 60 seconds and refuses an expired or second post", async () => {
    const first = await quote("100.00");
    const row = await pool.query("SELECT expires_at, created_at FROM quotes WHERE quote_id=$1", [first.quoteId]);
    const seconds = (new Date(row.rows[0].expires_at).getTime() - new Date(row.rows[0].created_at).getTime()) / 1000;
    expect(seconds).toBe(60);
    await pool.query(
      `INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET state = EXCLUDED.state`,
      [DEMO.tenantId, JSON.stringify({ cdos_settings: { reviewLockSeconds: 300 } })],
    );
    const capped = await quote("110.00");
    const cappedRow = await pool.query("SELECT expires_at, created_at FROM quotes WHERE quote_id=$1", [capped.quoteId]);
    expect((new Date(cappedRow.rows[0].expires_at).getTime() - new Date(cappedRow.rows[0].created_at).getTime()) / 1000).toBe(60);
    await pool.query(
      `UPDATE tenant_state SET state = $2::jsonb WHERE tenant_id = $1`,
      [DEMO.tenantId, JSON.stringify({ cdos_settings: { reviewLockSeconds: 30 } })],
    );
    const shorter = await quote("120.00");
    const shortRow = await pool.query("SELECT expires_at, created_at FROM quotes WHERE quote_id=$1", [shorter.quoteId]);
    expect((new Date(shortRow.rows[0].expires_at).getTime() - new Date(shortRow.rows[0].created_at).getTime()) / 1000).toBe(30);
    await pool.query("UPDATE quotes SET expires_at = now() - interval '1 second' WHERE quote_id=$1", [first.quoteId]);
    const expired = await post(first.quoteId, "expired");
    expect(expired.statusCode).toBe(422);
    expect(expired.json().code).toBe("QUOTE_EXPIRED");
    expect((await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count).toBe("0");
    const posted = await post(capped.quoteId, "once");
    expect(posted.statusCode, posted.body).toBe(201);
    const again = await post(capped.quoteId, "twice");
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe("QUOTE_NOT_ACTIVE");
    expect((await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count).toBe("1");
  });

  it("lets a small exchange post with purpose and source blank", async () => {
    const made = await quote("1000.00");
    const posted = await post(made.quoteId, "blank", { purpose: "", sourceOfFunds: "", occupationText: undefined });
    expect(posted.statusCode, posted.body).toBe(201);
  });

  it("blocks CAD 3000 until this shop has checked ID and taken an occupation", async () => {
    const under = await quote("2999.99");
    expect((await post(under.quoteId, "under", { occupationText: "" })).statusCode).toBe(201);
    const blocked = await quote("3000.00");
    const refused = await post(blocked.quoteId, "no-id");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("ID_CHECK_REQUIRED");
    expect((await pool.query("SELECT count(*) FROM ledger_transactions WHERE quote_id=$1", [blocked.quoteId])).rows[0].count).toBe("0");
    const checked = await app.inject({
      method: "POST",
      url: "/api/exchange/id-check",
      cookies: await cookie(),
      payload: {
        customerId: who,
        docType: "Passport",
        number: "PA-4471902",
        issuerRegion: "Ontario",
        issuerCountry: "Canada",
        expiresOn: "2030-04-01",
        faceMatched: true,
        looksGenuine: true,
      },
    });
    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json().number).toBe("PA-4471902");
    expect(checked.json().badge).toBe("Verified, In person, under a year");
    const read = await app.inject({
      method: "GET",
      url: `/api/exchange/id-check?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(read.json().maskedNumber).toBe("...1902");
    expect(JSON.stringify(read.json())).not.toContain("PA-4471902");
    const declined = await post(blocked.quoteId, "declined-job", { occupationText: "Client declined" });
    expect(declined.statusCode).toBe(422);
    expect(declined.json().code).toBe("OCCUPATION_REQUIRED");
    const posted = await post(blocked.quoteId, "with-job", { occupationCode: "employed" });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(JSON.stringify(posted.json().receipt || {})).not.toContain("Verified");
    const fact = await pool.query("SELECT occupation_code, subject_kind FROM exchange_deal_facts WHERE transaction_id=$1", [posted.json().transactionId]);
    expect(fact.rows[0]).toMatchObject({ occupation_code: "employed", subject_kind: "individual" });
  });

  it("requires purpose at CAD 10000 and still posts when the client declined", async () => {
    const made = await quote("10000.00");
    const open = await post(made.quoteId, "no-purpose", { purpose: "", sourceOfFunds: "" });
    expect(open.statusCode).toBe(422);
    expect(open.json().code).toBe("ID_CHECK_REQUIRED");
    await app.inject({
      method: "POST",
      url: "/api/exchange/id-check",
      cookies: await cookie(),
      payload: {
        customerId: who, docType: "Passport", number: "PA-10000", issuerRegion: "Ontario",
        issuerCountry: "Canada", expiresOn: "2031-01-01", faceMatched: true, looksGenuine: true,
      },
    });
    const missing = await post(made.quoteId, "no-purpose-2", { purpose: "", sourceOfFunds: "" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe("PURPOSE_REQUIRED");
    const declined = await post(made.quoteId, "declined", { purposeDeclined: true, sourceDeclined: true });
    expect(declined.statusCode, declined.body).toBe(201);
    const review = await pool.query(
      "SELECT kind FROM compliance_review_items WHERE transaction_id=$1 ORDER BY kind",
      [declined.json().transactionId],
    );
    expect(review.rows.map((row) => row.kind)).toEqual(["purpose_declined", "source_declined"]);
    const stored = await pool.query(
      "SELECT purpose, source_of_funds FROM ledger_transactions WHERE transaction_id=$1",
      [declined.json().transactionId],
    );
    expect(stored.rows[0]).toEqual({ purpose: "Client declined", source_of_funds: "Client declined" });
  });

  it("counts a held deal once cash moves and lists a no-cash hold as held, not counted", async () => {
    const quiet = await app.inject({
      method: "POST",
      url: "/api/exchange/holds",
      cookies: await cookie(),
      payload: { customerId: who, cashMoved: false },
    });
    expect(quiet.statusCode, quiet.body).toBe(201);
    expect(quiet.json().rate).toBe(null);
    expect(quiet.json().tillUnchanged).toBe(true);
    const window = await app.inject({
      method: "GET",
      url: `/api/exchange/cash-window?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(window.json().total).toBe("0.00");
    expect(window.json().footer).toBe("Holds count once any cash moves.");
    expect(window.json().heldNotCounted).toEqual([
      expect.objectContaining({ holdId: quiet.json().holdId, label: "Held, not counted" }),
    ]);
    const moved = await app.inject({
      method: "POST",
      url: "/api/exchange/holds",
      cookies: await cookie(),
      payload: { customerId: who, cashMoved: true, cashHome: "6000.00" },
    });
    expect(moved.statusCode, moved.body).toBe(201);
    const counted = await app.inject({
      method: "GET",
      url: `/api/exchange/cash-window?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(counted.json().postedTotal).toBe("0.00");
    expect(counted.json().heldCountedTotal).toBe("6000.00");
    expect(counted.json().total).toBe("6000.00");
    const made = await quote("5000.00");
    const refused = await post(made.quoteId, "window", { purpose: "", sourceOfFunds: "" });
    expect(refused.statusCode).toBe(422);
    expect(["ID_CHECK_REQUIRED", "PURPOSE_REQUIRED", "OCCUPATION_REQUIRED"]).toContain(refused.json().code);
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/exchange/holds/${quiet.json().holdId}/cancel`,
      cookies: await cookie(),
    });
    expect(cancelled.json()).toMatchObject({ status: "cancelled", removed: false });
    const after = await app.inject({
      method: "GET",
      url: `/api/exchange/cash-window?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(after.json().total).toBe("6000.00");
    expect(after.json().heldNotCounted).toEqual([]);
    const parked = await quote("9000.00");
    expect(parked.quoteId).toBeTruthy();
    const still = await app.inject({
      method: "GET",
      url: `/api/exchange/cash-window?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(still.json().total).toBe("6000.00");
  });

  it("keeps reversed cash in the 24 hour total", async () => {
    await app.inject({
      method: "POST",
      url: "/api/exchange/id-check",
      cookies: await cookie(),
      payload: {
        customerId: who, docType: "Passport", number: "PA-REV-1", issuerRegion: "Ontario",
        issuerCountry: "Canada", expiresOn: "2031-01-01", faceMatched: true, looksGenuine: true,
      },
    });
    const made = await quote("6000.00");
    const posted = await post(made.quoteId, "rev-post");
    expect(posted.statusCode, posted.body).toBe(201);
    const reversed = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${posted.json().transactionId}/reversal`,
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "rev-v29", reason: "Correction" },
    });
    expect(reversed.statusCode, reversed.body).toBe(201);
    const window = await app.inject({
      method: "GET",
      url: `/api/exchange/cash-window?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(window.json().postedTotal).toBe("6000.00");
  });

  it("flags an LCTR draft when the client has left and does not file it", async () => {
    for (let i = 0; i < 4; i += 1) {
      const made = await quote("2000.00");
      const posted = await post(made.quoteId, `small-${i}`, { occupationText: "" });
      expect(posted.statusCode, posted.body).toBe(201);
    }
    const crossing = await quote("2500.00");
    const blocked = await post(crossing.quoteId, "still-here", { occupationText: "", clientLeft: false });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe("ID_CHECK_REQUIRED");
    const left = await post(crossing.quoteId, "left", { occupationText: "", clientLeft: true });
    expect(left.statusCode, left.body).toBe(201);
    const draft = await pool.query(
      "SELECT status, client_left_gap, gap_note FROM lctr_prepare_drafts WHERE transaction_id=$1",
      [left.json().transactionId],
    );
    expect(draft.rows[0]).toMatchObject({ status: "prepared", client_left_gap: true });
    expect(draft.rows[0].gap_note).toContain("Prepared only");
    const review = await pool.query(
      "SELECT kind FROM compliance_review_items WHERE transaction_id=$1 AND kind='lctr_client_left'",
      [left.json().transactionId],
    );
    expect(review.rowCount).toBe(1);
    const filed = await pool.query(
      "SELECT count(*) FROM ledger_report_filings WHERE subject_customer_ids::text LIKE $1",
      [`%${who}%`],
    );
    expect(filed.rows[0].count).toBe("0");
    await expect(
      pool.query("UPDATE lctr_prepare_drafts SET status='filed' WHERE transaction_id=$1", [left.json().transactionId]),
    ).rejects.toThrow(/not filed/);
  });

  it("reveals an ID number only with a configured reason and writes an append-only log", async () => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/exchange/id-check",
      cookies: await cookie(),
      payload: {
        customerId: who, docType: "Passport", number: "PA-REVEAL-44", issuerRegion: "Ontario",
        issuerCountry: "Canada", expiresOn: "2031-01-01", faceMatched: true, looksGenuine: true,
      },
    });
    const teller = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie(),
      payload: { customerId: who, reasonCode: "fintrac_request", action: "reveal" },
    });
    expect(teller.statusCode).toBe(403);
    expect((await pool.query("SELECT count(*) FROM id_number_access WHERE customer_id=$1", [who])).rows[0].count).toBe("0");
    const manager = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, reasonCode: "fintrac_request", action: "reveal" },
    });
    expect(manager.statusCode, manager.body).toBe(200);
    expect(manager.json().number).toBe("PA-REVEAL-44");
    const logged = await pool.query(
      "SELECT actor_role, reason_code, action FROM id_number_access WHERE customer_id=$1",
      [who],
    );
    expect(logged.rows[0]).toMatchObject({ actor_role: "branch_manager", reason_code: "fintrac_request", action: "reveal" });
    const typo = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, reasonCode: "correct_a_typo", note: "1234567890" },
    });
    expect(typo.statusCode).toBe(400);
    const short = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, reasonCode: "other", note: "123456789", action: "export" },
    });
    expect(short.statusCode).toBe(400);
    await pool.query("UPDATE id_reveal_reasons SET min_note_length=12 WHERE code='other'");
    const stillShort = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, reasonCode: "other", note: "1234567890", action: "export" },
    });
    expect(stillShort.statusCode).toBe(400);
    const exported = await app.inject({
      method: "POST",
      url: "/api/exchange/id-number/reveal",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, reasonCode: "other", note: "123456789012", action: "export" },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json().number).toBe("PA-REVEAL-44");
    await pool.query("UPDATE id_reveal_reasons SET min_note_length=10 WHERE code='other'");
    const accessId = (await pool.query("SELECT access_id FROM id_number_access LIMIT 1")).rows[0].access_id;
    await expect(pool.query("UPDATE id_number_access SET note='changed' WHERE access_id=$1", [accessId])).rejects.toThrow(/append-only/);
  });

  it("does not query or reveal another shop's ID check", async () => {
    expect(SHOP_CHECK_SQL).toMatch(/legal_entity_id = \$1/);
    expect(SHOP_CHECK_SQL.toLowerCase()).not.toContain("or legal_entity");
    await pool.query(
      `INSERT INTO client_id_checks
         (check_id, tenant_id, legal_entity_id, customer_id, method, doc_type, number_last4, number_length,
          checked_on, checked_by, lifts_lock)
       VALUES ('idc-' || $1,'other-tenant','le-other-shop',$1,'photo_id_in_person','Passport','7788',18,'2024-01-01','someone',true)`,
      [who],
    );
    const texts: string[] = [];
    const params: unknown[][] = [];
    const client = await pool.connect();
    const wrapped = {
      query: (text: string, values?: unknown[]) => {
        texts.push(text);
        params.push(values || []);
        return client.query(text, values);
      },
    };
    const found = await loadShopCheck(wrapped as unknown as pg.PoolClient, DEMO.legalEntityId, who);
    client.release();
    expect(found).toBeNull();
    const checks = texts.filter((text) => /client_id_checks/i.test(text));
    expect(checks.length).toBeGreaterThan(0);
    for (const text of checks) {
      const at = texts.indexOf(text);
      expect(text).toMatch(/legal_entity_id = \$1/);
      expect(params[at]?.[0]).toBe(DEMO.legalEntityId);
      expect(params[at]).not.toContain("le-other-shop");
    }
    const read = await app.inject({
      method: "GET",
      url: `/api/exchange/id-check?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(read.json().returning.reason).toBe("No earlier check at this shop. A new check is needed.");
    expect(JSON.stringify(read.json())).not.toContain("7788");
    expect(JSON.stringify(read.json()).toLowerCase()).not.toContain("other shop");
  });

  it("keeps a suggested rating per shop and does not require purpose on a small high-risk deal", async () => {
    const suggested = await app.inject({
      method: "POST",
      url: "/api/exchange/risk",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, suggested: "high" },
    });
    expect(suggested.json().label).toBe("Suggested: High");
    await pool.query(
      `INSERT INTO shop_risk_ratings (legal_entity_id, customer_id, confirmed, confirmed_by, confirmed_at)
       VALUES ('le-other-shop',$1,'high','someone',now())`,
      [who],
    );
    const mine = await app.inject({
      method: "GET",
      url: `/api/exchange/risk?customerId=${who}`,
      cookies: await cookie(),
    });
    expect(mine.json().confirmed).toBe(null);
    expect(mine.json().label).toBe("Suggested: High");
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/exchange/risk",
      cookies: await cookie("r.haddad"),
      payload: { customerId: who, confirmed: "high" },
    });
    expect(confirmed.json().label).toBe("High");
    const made = await quote("100.00");
    const posted = await post(made.quoteId, "high-small", { purpose: "", sourceOfFunds: "", occupationText: "" });
    expect(posted.statusCode, posted.body).toBe(201);
  });
});
