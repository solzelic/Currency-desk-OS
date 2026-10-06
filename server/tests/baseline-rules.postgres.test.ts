/* The international baseline: a desk with no country pack can quote and
   post, USD lines convert at the market snapshot, and a missing or stale
   snapshot means identification on every deal. */
import Decimal from "decimal.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { BASELINE_NOTICE } from "../src/ledger/jurisdiction.js";

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

async function signup(slug: string, email: string, onboarding: Record<string, unknown>) {
  logged = [];
  const created = await app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      businessName: slug,
      ownerName: "Owner",
      email,
      password: "a-strong-pass",
      slug,
      onboarding,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const verified = await app.inject({
    method: "POST",
    url: "/api/signup/verify",
    payload: { email, code: codeFromLog() },
  });
  expect(verified.statusCode, verified.body).toBe(201);
  const cookie = verified.cookies.find((item) => item.name === "cdos_session")?.value;
  if (!cookie) throw new Error("no session");
  return cookie;
}

async function removeDesk(slug: string, email: string) {
  const tenant = `tnt-${slug}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    /* Cheque events are append-only. Cleanup is not a ledger write. */
    await client.query("SET LOCAL session_replication_role = replica");
    const run = (sql: string, values: unknown[]) => client.query(sql, values);
    await run("DELETE FROM quote_events WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM quote_overrides WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM quotes WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_cheque_events WHERE cheque_id IN (SELECT cheque_id FROM ledger_cheques WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_cheques WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_obligation_events WHERE obligation_id IN (SELECT obligation_id FROM ledger_obligations WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_obligations WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_movements WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_cost_events WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_journal_entries WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_transactions WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_idempotency WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_sessions WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_balances WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_customers WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_principals WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM desk_clients WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM staff_users WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM rate_boards WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM workspaces WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM branches WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM legal_entities WHERE id=$1", [`le-${slug}`]);
    await run("DELETE FROM audit_events WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM tenants WHERE id=$1", [tenant]);
    await run("DELETE FROM pending_signups WHERE email=$1", [email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

postgres("the international baseline", () => {
  const usd = { slug: "intl-usd", email: "owner@intl-usd.example", cookie: "", customerId: "" };
  const gbp = { slug: "intl-gbp", email: "owner@intl-gbp.example", cookie: "", customerId: "" };
  const rsd = { slug: "intl-rsd", email: "owner@intl-rsd.example", cookie: "", customerId: "" };

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
    await removeDesk(usd.slug, usd.email);
    await removeDesk(gbp.slug, gbp.email);
    await removeDesk(rsd.slug, rsd.email);
    usd.cookie = await signup(usd.slug, usd.email, { country: "XX" });
    gbp.cookie = await signup(gbp.slug, gbp.email, { country: "XX", homeCurrency: "GBP" });
    rsd.cookie = await signup(rsd.slug, rsd.email, { country: "XX", homeCurrency: "RSD" });
    for (const desk of [usd, gbp, rsd]) {
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
        payload: { legalName: "Walk In" },
      });
      expect(client.statusCode, client.body).toBe(201);
      const counter = await app.inject({
        method: "POST",
        url: `/api/clients/${client.json().clientId}/counter-record`,
        cookies: { cdos_session: desk.cookie },
      });
      expect(counter.statusCode, counter.body).toBe(200);
      desk.customerId = counter.json().customerId;
      const home = desk === usd ? "USD" : desk === gbp ? "GBP" : "RSD";
      await pool.query(
        `INSERT INTO ledger_till_balances
           (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
         VALUES ($1,$2,$3,$4,'till-01',$5,100000)`,
        [`tnt-${desk.slug}`, `le-${desk.slug}`, `br-${desk.slug}-main`, `ws-${desk.slug}-till-01`, home],
      );
    }
  });

  afterAll(async () => {
    await removeDesk(usd.slug, usd.email);
    await removeDesk(gbp.slug, gbp.email);
    await removeDesk(rsd.slug, rsd.email);
    await app.close();
    await handle.close();
    await pool.end();
    vi.restoreAllMocks();
    if (earlyAccess === undefined) delete process.env.EARLY_ACCESS_OPEN;
    else process.env.EARLY_ACCESS_OPEN = earlyAccess;
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  async function cheque(desk: typeof usd, amount: string, key: string) {
    return app.inject({
      method: "POST",
      url: "/api/ledger/cheques",
      cookies: { cdos_session: desk.cookie },
      payload: {
        idempotencyKey: key,
        customerId: desk.customerId,
        chequeNumber: key,
        maker: "Walk In",
        chequeType: "personal",
        typeLabel: "Personal",
        currency: desk === usd ? "USD" : "GBP",
        faceAmount: amount,
        feeAmount: "0.00",
        holdDays: 0,
      },
    });
  }

  async function send(
    desk: typeof usd,
    amount: string,
    key: string,
    facts: { purpose: string; sourceOfFunds: string } = {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    },
    fee = "0.00",
  ) {
    return app.inject({
      method: "POST",
      url: "/api/ledger/remittances/send",
      cookies: { cdos_session: desk.cookie },
      payload: {
        idempotencyKey: key,
        customerId: desk.customerId,
        reference: key,
        principalAmount: amount,
        feeAmount: fee,
        payoutCurrency: "EUR",
        payoutAmount: "1.00",
        corridor: "DE",
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
        purpose: facts.purpose,
        sourceOfFunds: facts.sourceOfFunds,
      },
    });
  }

  it("shows the disclaimer, quotes, and keeps the regulator blank", async () => {
    const jurisdiction = await app.inject({
      method: "GET",
      url: "/api/ledger/jurisdiction",
      cookies: { cdos_session: usd.cookie },
    });
    expect(jurisdiction.statusCode, jurisdiction.body).toBe(200);
    const body = jurisdiction.json();
    expect(body.notice).toBe(BASELINE_NOTICE);
    expect(body.pack.regulator).toBe("");
    expect(body.pack.regulator).not.toBe("FINTRAC");
    expect(body.pack.packId).toBe("pack-intl-v1");
    expect(body.pack.baseline).toBe(true);
    expect(body.pack.homeCurrency).toBe("USD");

    const lines = await pool.query(
      `SELECT deal_kind, threshold, currency, cash_only
         FROM jurisdiction_id_thresholds WHERE pack_id='pack-intl-v1' ORDER BY deal_kind`,
    );
    expect(
      lines.rows.map((row) => ({
        deal_kind: row.deal_kind,
        threshold: row.threshold,
        currency: String(row.currency).trim(),
        cash_only: row.cash_only,
      })),
    ).toEqual([
      { deal_kind: "eft", threshold: "1000.00", currency: "USD", cash_only: false },
      { deal_kind: "fx", threshold: "3000.00", currency: "USD", cash_only: true },
      { deal_kind: "remittance", threshold: "1000.00", currency: "USD", cash_only: false },
      { deal_kind: "virtual_currency", threshold: "1000.00", currency: "USD", cash_only: false },
    ]);

    const quote = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: { cdos_session: usd.cookie },
      payload: {
        customerId: usd.customerId,
        from: "USD",
        to: "EUR",
        inputAmount: "100.00",
        feeCad: "0.00",
        direction: "customer_buy_foreign",
      },
    });
    expect(quote.statusCode, quote.body).toBe(201);
  });

  it("identifies a USD cash exchange at 3,000 and a remittance at 1,000", async () => {
    const underFx = await cheque(usd, "2999.99", "usd-fx-under");
    expect(underFx.statusCode, underFx.body).toBe(201);
    const atFx = await cheque(usd, "3000.00", "usd-fx-at");
    expect(atFx.statusCode, atFx.body).toBe(422);
    expect(atFx.json().code).toBe("COMPLIANCE_BLOCKED");

    const underSend = await send(usd, "999.99", "usd-rm-under");
    expect(underSend.statusCode, underSend.body).toBe(201);
    const atSend = await send(usd, "1000.00", "usd-rm-at");
    expect(atSend.statusCode, atSend.body).toBe(422);
    expect(atSend.json().code).toBe("COMPLIANCE_BLOCKED");

    const stamp = (
      await pool.query(
        `SELECT compliance_threshold_rate, compliance_threshold_rate_at
           FROM ledger_transactions WHERE transaction_id=$1`,
        [underFx.json().transactionId],
      )
    ).rows[0];
    expect(stamp.compliance_threshold_rate).toBe("1.000000000000");
    expect(stamp.compliance_threshold_rate_at).toBeNull();
  });

  it("converts the GBP line at the market snapshot and ignores the board mid", async () => {
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-intl','test','{"USD":1.36,"GBP":1.70}', now())`,
    );
    await pool.query(
      `UPDATE rate_boards
          SET board_rows = jsonb_set(board_rows, '{USD,mid}', '2')
        WHERE branch_id=$1`,
      [`br-${gbp.slug}-main`],
    );
    const under = await cheque(gbp, "2399.99", "gbp-fx-under");
    expect(under.statusCode, under.body).toBe(201);
    const at = await cheque(gbp, "2400.00", "gbp-fx-at");
    expect(at.statusCode, at.body).toBe(422);
    expect(at.json().code).toBe("COMPLIANCE_BLOCKED");
    const underSend = await send(gbp, "799.99", "gbp-rm-under");
    expect(underSend.statusCode, underSend.body).toBe(201);
    const atSend = await send(gbp, "800.00", "gbp-rm-at");
    expect(atSend.statusCode, atSend.body).toBe(422);
    /* The fee is part of the cash. 790.00 + 9.99 = 799.99. 790.01 + 9.99 = 800.00. */
    const underFee = await send(gbp, "790.00", "gbp-rm-fee-under", {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    }, "9.99");
    expect(underFee.statusCode, underFee.body).toBe(201);
    const atFee = await send(gbp, "790.01", "gbp-rm-fee-at", {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    }, "9.99");
    expect(atFee.statusCode, atFee.body).toBe(422);
    expect(atFee.json().code).toBe("COMPLIANCE_BLOCKED");

    const stamp = (
      await pool.query(
        `SELECT compliance_threshold_rate, compliance_threshold_rate_at
           FROM ledger_transactions WHERE transaction_id=$1`,
        [under.json().transactionId],
      )
    ).rows[0];
    expect(stamp.compliance_threshold_rate).toBe("0.800000000000");
    expect(stamp.compliance_threshold_rate_at).toBeTruthy();
    const snap = await pool.query("SELECT fetched_at FROM market_rates WHERE id='snap-intl'");
    expect(new Date(stamp.compliance_threshold_rate_at).toISOString()).toBe(
      new Date(snap.rows[0].fetched_at).toISOString(),
    );
  });

  it("converts the RSD remittance line and counts the fee toward it", async () => {
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-intl-rsd','test','{"USD":1.36,"RSD":0.0136}', now())`,
    );
    const line = new Decimal(1000)
      .mul(new Decimal("1.36").div("0.0136"))
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    expect(line.toFixed(2)).toBe("100000.00");
    const lines = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: rsd.cookie },
    });
    expect(lines.statusCode, lines.body).toBe(200);
    expect(lines.json().currency).toBe("RSD");
    expect(lines.json().remittanceIdThreshold.effective).toBe(line.toFixed(2));
    expect(lines.json().idThreshold.effective).toBe("300000.00");

    const fee = "9.99";
    const underPrincipal = line.minus(fee).minus("0.01").toFixed(2);
    const atPrincipal = line.minus(fee).toFixed(2);
    expect(underPrincipal).toBe("99990.00");
    expect(atPrincipal).toBe("99990.01");
    const under = await send(rsd, underPrincipal, "rsd-rm-under", {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    }, fee);
    expect(under.statusCode, under.body).toBe(201);
    const at = await send(rsd, atPrincipal, "rsd-rm-at", {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    }, fee);
    expect(at.statusCode, at.body).toBe(422);
    expect(at.json().code).toBe("COMPLIANCE_BLOCKED");
  });

  it("requires identification on every deal when the market rate is stale or missing", async () => {
    await pool.query(
      "UPDATE market_rates SET fetched_at = now() - interval '25 hours'",
    );
    const stale = await cheque(gbp, "1.00", "gbp-stale");
    expect(stale.statusCode, stale.body).toBe(422);
    expect(stale.json().code).toBe("COMPLIANCE_BLOCKED");
    const staleSend = await send(gbp, "1.00", "gbp-stale-rm");
    expect(staleSend.statusCode, staleSend.body).toBe(422);
    expect(staleSend.json().code).toBe("COMPLIANCE_BLOCKED");

    await pool.query(
      "UPDATE ledger_customers SET id_status='verified' WHERE customer_id=$1",
      [gbp.customerId],
    );
    const verified = await cheque(gbp, "1.00", "gbp-stale-verified");
    expect(verified.statusCode, verified.body).toBe(201);
    const staleStamp = (
      await pool.query(
        "SELECT compliance_threshold_rate FROM ledger_transactions WHERE transaction_id=$1",
        [verified.json().transactionId],
      )
    ).rows[0];
    expect(staleStamp.compliance_threshold_rate).toBeNull();

    await pool.query("DELETE FROM market_rates");
    await pool.query(
      "UPDATE ledger_customers SET id_status='missing' WHERE customer_id=$1",
      [gbp.customerId],
    );
    const missing = await cheque(gbp, "1.00", "gbp-missing");
    expect(missing.statusCode, missing.body).toBe(422);
    expect(missing.json().code).toBe("COMPLIANCE_BLOCKED");
  });

  it("converts the 10,000 USD line and the ID line into GBP, and fails closed when the rate is stale", async () => {
    await pool.query("DELETE FROM market_rates");
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-intl-lines','test','{"USD":1.36,"GBP":1.70}', now())`,
    );
    await pool.query(
      "UPDATE ledger_customers SET id_status='missing' WHERE customer_id=$1",
      [gbp.customerId],
    );

    const lines = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: gbp.cookie },
    });
    expect(lines.statusCode, lines.body).toBe(200);
    expect(lines.json().currency).toBe("GBP");
    expect(lines.json().reportThreshold).toMatchObject({
      effective: "8000.00",
      packValue: "8000.00",
      deskChoice: null,
      posture: "following",
    });
    expect(lines.json().idThreshold).toMatchObject({
      effective: "2400.00",
      packValue: "2400.00",
      deskChoice: null,
      posture: "following",
    });
    expect(lines.json().remittanceIdThreshold).toMatchObject({
      effective: "800.00",
      packValue: "800.00",
      deskChoice: null,
      posture: "following",
    });

    const usdLines = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: usd.cookie },
    });
    expect(usdLines.json().reportThreshold.effective).toBe("10000.00");
    expect(usdLines.json().idThreshold.effective).toBe("3000.00");
    expect(usdLines.json().remittanceIdThreshold.effective).toBe("1000.00");

    const underId = await cheque(gbp, "2399.99", "gbp-id-under-2");
    expect(underId.statusCode, underId.body).toBe(201);
    const atId = await cheque(gbp, "2400.00", "gbp-id-at-2");
    expect(atId.statusCode, atId.body).toBe(422);
    expect(atId.json().code).toBe("COMPLIANCE_BLOCKED");

    await pool.query(
      "UPDATE ledger_customers SET id_status='verified' WHERE customer_id=$1",
      [gbp.customerId],
    );
    const underReport = await send(gbp, "7999.99", "gbp-rpt-under", {
      purpose: "",
      sourceOfFunds: "",
    });
    expect(underReport.statusCode, underReport.body).toBe(201);
    const atReport = await send(gbp, "8000.00", "gbp-rpt-at", {
      purpose: "",
      sourceOfFunds: "",
    });
    expect(atReport.statusCode, atReport.body).toBe(422);
    expect(atReport.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(atReport.json().message).toMatch(/compliance policy blocked/i);
    const atReportNamed = await send(gbp, "8000.00", "gbp-rpt-at-named", {
      purpose: "Family support",
      sourceOfFunds: "Salary",
    });
    expect(atReportNamed.statusCode, atReportNamed.body).toBe(201);

    await pool.query(
      "UPDATE market_rates SET fetched_at = now() - interval '25 hours'",
    );
    const staleLines = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: gbp.cookie },
    });
    expect(staleLines.json().reportThreshold.effective).toBeNull();
    expect(staleLines.json().idThreshold.effective).toBeNull();
    expect(staleLines.json().remittanceIdThreshold.effective).toBeNull();
    expect(staleLines.json().remittanceIdThreshold.packValue).toBeNull();
    const staleReport = await send(gbp, "1.00", "gbp-stale-purpose", {
      purpose: "",
      sourceOfFunds: "",
    });
    expect(staleReport.statusCode, staleReport.body).toBe(422);
    expect(staleReport.json().message).toMatch(/no reporting threshold/i);

    await pool.query(
      "UPDATE ledger_customers SET id_status='missing' WHERE customer_id=$1",
      [gbp.customerId],
    );
    const staleId = await cheque(gbp, "1.00", "gbp-stale-id-2");
    expect(staleId.statusCode, staleId.body).toBe(422);
    expect(staleId.json().code).toBe("COMPLIANCE_BLOCKED");
  });
});
