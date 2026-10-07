/* Serbia pack-rs-v1.

   Euro lines convert at the market snapshot. 5,000 EUR is the exchange
   identification line. A sale of 50 or 100 US dollar notes needs serial
   numbers. An airside counter needs identity on every buy and sell.
   A missing or stale rate refuses an unidentified customer. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import {
  SERBIA_AIRSIDE_REQUIRED,
  SERBIA_RECEIPT_IDENTITY,
  SERBIA_USD_NOTES_PROMPT,
  SERBIA_USD_NOTES_REQUIRED,
} from "../src/ledger/serbia.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
let logged: string[] = [];
let earlyAccess: string | undefined;

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((entry) => entry.includes("[email simulated]"));
  const match = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!match) throw new Error("no signup code in log");
  return match[1]!;
};

postgres("Serbia pack-rs-v1", () => {
  const desk = {
    slug: "serbia-pack",
    email: "owner@serbia-pack.example",
    cookie: "",
    customerId: "",
  };

  beforeAll(async () => {
    earlyAccess = process.env.EARLY_ACCESS_OPEN;
    process.env.EARLY_ACCESS_OPEN = "1";
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-serbia','test','{"USD":1.36,"RSD":0.0125,"EUR":1.25}', now())
       ON CONFLICT (id) DO UPDATE SET mids = EXCLUDED.mids, fetched_at = now()`,
    );
    logged = [];
    const created = await appSafeSignup();
    expect(created.statusCode, created.body).toBe(201);
    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: desk.email, code: codeFromLog() },
    });
    expect(verified.statusCode, verified.body).toBe(201);
    desk.cookie = verified.cookies.find((item) => item.name === "cdos_session")?.value ?? "";
    expect(desk.cookie).not.toBe("");
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: { cdos_session: desk.cookie },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies: { cdos_session: desk.cookie },
      payload: { legalName: "Ana Petrovic" },
    });
    expect(client.statusCode, client.body).toBe(201);
    const counter = await app.inject({
      method: "POST",
      url: `/api/clients/${client.json().clientId}/counter-record`,
      cookies: { cdos_session: desk.cookie },
    });
    expect(counter.statusCode, counter.body).toBe(200);
    desk.customerId = counter.json().customerId;
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES
         ($1,$2,$3,$4,'till-01','RSD',5000000),
         ($1,$2,$3,$4,'till-01','USD',10000),
         ($1,$2,$3,$4,'till-01','EUR',10000)
       ON CONFLICT (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency)
       DO UPDATE SET available_amount = EXCLUDED.available_amount`,
      [`tnt-${desk.slug}`, `le-${desk.slug}`, `br-${desk.slug}-main`, `ws-${desk.slug}-till-01`],
    );
  });

  async function appSafeSignup() {
    return app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Beograd Menjacnica",
        ownerName: "Owner",
        email: desk.email,
        password: "a-strong-pass",
        slug: desk.slug,
        onboarding: { country: "Serbia", regulator: "NBS / APML" },
      },
    });
  }

  afterAll(async () => {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        const tenant = `tnt-${desk.slug}`;
        await client.query("DELETE FROM quote_events WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
        await client.query("DELETE FROM quote_overrides WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
        await client.query("DELETE FROM quotes WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_till_movements WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
        await client.query("DELETE FROM ledger_journal_entries WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
        await client.query("DELETE FROM ledger_transactions WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_idempotency WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_till_sessions WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_till_balances WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_customers WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM ledger_principals WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE tenant_id=$1)", [tenant]);
        await client.query("DELETE FROM staff_users WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM workspaces WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM branches WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM legal_entities WHERE tenant_id=$1", [tenant]);
        await client.query("DELETE FROM tenants WHERE id=$1", [tenant]);
        await client.query("DELETE FROM market_rates WHERE id='snap-serbia'");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await pool.end();
    }
    if (app) await app.close();
    if (handle) await handle.close();
    vi.restoreAllMocks();
    if (earlyAccess === undefined) delete process.env.EARLY_ACCESS_OPEN;
    else process.env.EARLY_ACCESS_OPEN = earlyAccess;
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  it("stores the euro lines and does not add cash together", async () => {
    const pack = (
      await pool.query(
        `SELECT home_currency, regulator, report_threshold, id_threshold, report_currency, aggregation_hours, retention_years
           FROM jurisdiction_packs WHERE pack_id='pack-rs-v1'`,
      )
    ).rows[0];
    expect(String(pack.home_currency).trim()).toBe("RSD");
    expect(pack.regulator).toBe("NBS / APML");
    expect(pack.report_threshold).toBe("15000.00");
    expect(pack.id_threshold).toBe("5000.00");
    expect(String(pack.report_currency).trim()).toBe("EUR");
    expect(pack.aggregation_hours).toBeNull();
    expect(Number(pack.retention_years)).toBe(5);

    const lines = await pool.query(
      `SELECT deal_kind, threshold, currency, comparator, diligence
         FROM jurisdiction_id_thresholds WHERE pack_id='pack-rs-v1' ORDER BY deal_kind`,
    );
    expect(lines.rows.map((row) => ({
      kind: row.deal_kind,
      threshold: row.threshold,
      currency: String(row.currency).trim(),
      comparator: row.comparator,
      diligence: row.diligence,
    }))).toEqual([
      { kind: "eft", threshold: "1000.00", currency: "EUR", comparator: "gt", diligence: "cdd" },
      { kind: "fx", threshold: "5000.00", currency: "EUR", comparator: "gte", diligence: "cdd" },
      { kind: "remittance", threshold: "1000.00", currency: "EUR", comparator: "gt", diligence: "cdd" },
      { kind: "virtual_currency", threshold: "15000.00", currency: "EUR", comparator: "gte", diligence: "cdd" },
    ]);

    const reports = await pool.query(
      `SELECT code, deadline_unit, deadline_value, window_kind, direction, threshold_currency, cash_only
         FROM jurisdiction_reports WHERE pack_id='pack-rs-v1' ORDER BY code`,
    );
    expect(reports.rows).toEqual([
      expect.objectContaining({
        code: "CTR",
        deadline_unit: "calendar_days",
        deadline_value: 3,
        window_kind: "none",
        direction: "both",
        cash_only: true,
      }),
      expect.objectContaining({
        code: "STR",
        deadline_unit: "before_execution",
        deadline_value: null,
        window_kind: "none",
      }),
    ]);
    expect(String(reports.rows[0].threshold_currency).trim()).toBe("EUR");
  });

  it("opens a new Serbia desk on pack-rs-v1 in dinars, without a euro override", async () => {
    const entity = (
      await pool.query(
        `SELECT jurisdiction_pack_id, home_currency, id_threshold, jurisdiction
           FROM legal_entities WHERE id=$1`,
        [`le-${desk.slug}`],
      )
    ).rows[0];
    expect(entity.jurisdiction_pack_id).toBe("pack-rs-v1");
    expect(String(entity.home_currency).trim()).toBe("RSD");
    expect(entity.id_threshold).toBeNull();
    expect(entity.jurisdiction).toBe("NBS / APML");
  });

  async function sellEur(amount: string, key: string, extra: Record<string, unknown> = {}) {
    const quote = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: { cdos_session: desk.cookie },
      payload: {
        customerId: desk.customerId,
        from: "EUR",
        to: "RSD",
        inputAmount: amount,
        feeCad: "0.00",
        direction: "customer_sell_foreign",
      },
    });
    expect(quote.statusCode, quote.body).toBe(201);
    return app.inject({
      method: "POST",
      url: `/api/quotes/${quote.json().quoteId}/post`,
      cookies: { cdos_session: desk.cookie },
      payload: {
        idempotencyKey: key,
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
        ...extra,
      },
    });
  }

  it("identifies an exchange at 5,000 EUR and lets 4,999.99 through", async () => {
    const under = await sellEur("4999.99", "rs-eur-under");
    expect(under.statusCode, under.body).toBe(201);
    const at = await sellEur("5000.00", "rs-eur-at");
    expect(at.statusCode, at.body).toBe(422);
    expect(at.json().code).toBe("COMPLIANCE_BLOCKED");

    const row = (
      await pool.query(
        `SELECT compliance_threshold_rate, receipt_facts, identity_number
           FROM ledger_transactions WHERE transaction_ref=$1`,
        [under.json().transactionRef],
      )
    ).rows[0];
    expect(row.compliance_threshold_rate).toBe("100.000000000000");
    expect(row.identity_number).toBeNull();
    expect(row.receipt_facts.side).toBe("otkup");
    expect(row.receipt_facts.basis).toBe("796/701");
  });

  it("requires the identity number once the customer is verified and the line is met", async () => {
    await pool.query(
      `UPDATE ledger_customers SET id_status='verified' WHERE customer_id=$1`,
      [desk.customerId],
    );
    const missing = await sellEur("5000.00", "rs-eur-verified-bare");
    expect(missing.statusCode, missing.body).toBe(422);
    expect(missing.json().message).toBe(SERBIA_RECEIPT_IDENTITY);
    const posted = await sellEur("5000.00", "rs-eur-verified", { identityNumber: "0101990712345" });
    expect(posted.statusCode, posted.body).toBe(201);
    const row = (
      await pool.query(
        `SELECT identity_number FROM ledger_transactions WHERE transaction_ref=$1`,
        [posted.json().transactionRef],
      )
    ).rows[0];
    expect(row.identity_number).toBe("0101990712345");
    await pool.query(
      `UPDATE ledger_customers SET id_status='missing' WHERE customer_id=$1`,
      [desk.customerId],
    );
  });

  it("records serial numbers when 50 or 100 US dollar notes are sold", async () => {
    const quote = async (key: string, extra: Record<string, unknown>) => {
      const made = await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: { cdos_session: desk.cookie },
        payload: {
          customerId: desk.customerId,
          from: "RSD",
          to: "USD",
          inputAmount: "1000.00",
          feeCad: "0.00",
          direction: "customer_buy_foreign",
        },
      });
      expect(made.statusCode, made.body).toBe(201);
      return app.inject({
        method: "POST",
        url: `/api/quotes/${made.json().quoteId}/post`,
        cookies: { cdos_session: desk.cookie },
        payload: {
          idempotencyKey: key,
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
          ...extra,
        },
      });
    };
    const unspoken = await quote("rs-usd-unspoken", {});
    expect(unspoken.statusCode, unspoken.body).toBe(422);
    expect(unspoken.json().message).toBe(SERBIA_USD_NOTES_PROMPT);
    const plain = await quote("rs-usd-plain", { usdLargeNotes: false });
    expect(plain.statusCode, plain.body).toBe(201);
    const bare = await quote("rs-usd-bare", { usdLargeNotes: true });
    expect(bare.statusCode, bare.body).toBe(422);
    expect(bare.json().message).toBe(SERBIA_USD_NOTES_REQUIRED);
    const posted = await quote("rs-usd-notes", {
      usdLargeNotes: true,
      identityNumber: "0101990712345",
      usdNoteSerials: ["AB12345678C"],
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const row = (
      await pool.query(
        `SELECT note_serials, receipt_facts FROM ledger_transactions WHERE transaction_ref=$1`,
        [posted.json().transactionRef],
      )
    ).rows[0];
    expect(row.note_serials).toEqual(["AB12345678C"]);
    expect(row.receipt_facts.side).toBe("prodaja");
    expect(row.receipt_facts.basis).toBe("700/701");
  });

  it("demands identity on every buy and sell when the counter is airside", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/ledger/branch-location",
      cookies: { cdos_session: desk.cookie },
      payload: { airsideOrCasino: true },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().airsideOrCasino).toBe(true);
    const blocked = await sellEur("10.00", "rs-air-under");
    expect(blocked.statusCode, blocked.body).toBe(422);
    expect(blocked.json().message).toBe(SERBIA_AIRSIDE_REQUIRED);
    await pool.query(
      `UPDATE ledger_customers SET id_status='verified' WHERE customer_id=$1`,
      [desk.customerId],
    );
    const still = await sellEur("10.00", "rs-air-verified-bare");
    expect(still.json().message).toBe(SERBIA_AIRSIDE_REQUIRED);
    const posted = await sellEur("10.00", "rs-air-ok", { identityNumber: "0101990712345" });
    expect(posted.statusCode, posted.body).toBe(201);
    await app.inject({
      method: "PUT",
      url: "/api/ledger/branch-location",
      cookies: { cdos_session: desk.cookie },
      payload: { airsideOrCasino: false },
    });
    await pool.query(
      `UPDATE ledger_customers SET id_status='missing' WHERE customer_id=$1`,
      [desk.customerId],
    );
  });

  it("refuses an unidentified deal when the rate is older than 24 hours", async () => {
    const prior = await pool.query(`SELECT id, fetched_at FROM market_rates`);
    await pool.query(`UPDATE market_rates SET fetched_at = now() - interval '25 hours'`);
    const stale = await sellEur("10.00", "rs-stale");
    expect(stale.statusCode, stale.body).toBe(422);
    expect(stale.json().code).toBe("COMPLIANCE_BLOCKED");
    for (const row of prior.rows) {
      await pool.query(`UPDATE market_rates SET fetched_at = $2 WHERE id = $1`, [row.id, row.fetched_at]);
    }
  });
});
