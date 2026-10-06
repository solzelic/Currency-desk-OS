/* A listed jurisdiction cannot open a desk, cannot become a desk's
   country, cannot sit on either end of a transfer, and stops a deal
   with a client who is there. The report code is the pack's. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import {
  countryChangeRefusal,
  lookupSanctionedCurrency,
  lookupSanctionedJurisdiction,
  SANCTIONED_JURISDICTIONS,
  SANCTIONS_LIST_VERSION,
  signupRefusal,
  transferRefusal,
} from "../src/compliance/sanctioned-jurisdictions.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

function plain(text: string) {
  expect(text, text).not.toMatch(/\u2014|\u2013/);
}

describe("sanctioned jurisdiction lookup", () => {
  it("matches listed countries, regions, and currencies, and nothing nearby", () => {
    expect(SANCTIONS_LIST_VERSION).toBe("2026-10-06.1");
    expect(lookupSanctionedJurisdiction("KP")?.name).toBe("North Korea");
    expect(lookupSanctionedJurisdiction("DPRK")?.name).toBe("North Korea");
    expect(lookupSanctionedJurisdiction("North Korea")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("Democratic People's Republic of Korea")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("Korea")).toBeNull();
    expect(lookupSanctionedJurisdiction("South Korea")).toBeNull();
    expect(lookupSanctionedJurisdiction("DPR")?.name).toBe("Donetsk");
    expect(lookupSanctionedJurisdiction("Crimea")?.kind).toBe("region");
    expect(lookupSanctionedJurisdiction("UA-43")?.id).toBe("UA-43");
    expect(lookupSanctionedJurisdiction("ua43")?.id).toBe("UA-43");
    expect(lookupSanctionedJurisdiction("UA")).toBeNull();
    expect(lookupSanctionedJurisdiction("Ukraine")).toBeNull();
    expect(lookupSanctionedJurisdiction("Syria")).toBeNull();
    expect(lookupSanctionedJurisdiction("Russia")).toBeNull();
    expect(lookupSanctionedJurisdiction("Canada")).toBeNull();
    expect(lookupSanctionedJurisdiction("XX")).toBeNull();
    expect(lookupSanctionedJurisdiction("Somewhere else")).toBeNull();
    expect(lookupSanctionedCurrency("KPW")?.id).toBe("KP");
    expect(lookupSanctionedCurrency("cup")?.id).toBe("CU");
    expect(lookupSanctionedCurrency("IRR")?.id).toBe("IR");
    expect(lookupSanctionedCurrency("MMK")?.id).toBe("MM");
    expect(lookupSanctionedCurrency("USD")).toBeNull();
    expect(lookupSanctionedCurrency("RUB")).toBeNull();
    expect(lookupSanctionedCurrency("SYP")).toBeNull();
    expect(lookupSanctionedJurisdiction("CUP")).toBeNull();
    for (const entry of SANCTIONED_JURISDICTIONS) {
      plain(signupRefusal(entry).detail);
      plain(countryChangeRefusal(entry).detail);
      plain(transferRefusal(entry, "send").message);
      plain(transferRefusal(entry, "receive").message);
      expect(entry.sources.every((source) => source.url.startsWith("https://") && source.asOf)).toBe(true);
    }
  });
});

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
    await run("DELETE FROM desk_client_images WHERE client_id IN (SELECT client_id FROM desk_clients WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM desk_client_identity_documents WHERE client_id IN (SELECT client_id FROM desk_clients WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM desk_client_aliases WHERE client_id IN (SELECT client_id FROM desk_clients WHERE tenant_id=$1)", [tenant]);
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

async function removeEnquiry(id: string) {
  await pool.query("DELETE FROM onboarding WHERE enquiry_id=$1", [id]);
  await pool.query("DELETE FROM enquiries WHERE id=$1", [id]);
}

postgres("sanctioned jurisdictions on the book", () => {
  const stamp = Date.now().toString(36);
  const baseline = { slug: `sb${stamp}`, email: `owner-${stamp}@sanctioned.example`, cookie: "" };
  const canada = { slug: `sc${stamp}`, email: `canada-${stamp}@sanctioned.example`, cookie: "" };
  const enquiryId = `enq-sanc-${stamp}`;
  const enquiryRef = `SANC${stamp}`.toUpperCase();

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
    await removeDesk(baseline.slug, baseline.email);
    await removeDesk(canada.slug, canada.email);
    await removeEnquiry(enquiryId);
  });

  afterAll(async () => {
    if (pool) {
      await removeDesk(baseline.slug, baseline.email);
      await removeDesk(canada.slug, canada.email);
      await removeEnquiry(enquiryId);
      await pool.end();
    }
    if (app) await app.close();
    if (handle) await handle.close();
    if (earlyAccess === undefined) delete process.env.EARLY_ACCESS_OPEN;
    else process.env.EARLY_ACCESS_OPEN = earlyAccess;
    vi.restoreAllMocks();
  });

  async function refusedSignup(slug: string, email: string, onboarding: Record<string, unknown>, name: string) {
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
    expect(created.statusCode, created.body).toBe(403);
    expect(created.json().error).toBe("sanctioned_country");
    expect(created.json().detail).toContain(name);
    expect(created.json().detail).toContain("cannot be opened");
    plain(created.json().detail);
    const pending = await pool.query("SELECT count(*)::int AS n FROM pending_signups WHERE email=$1", [email]);
    const tenant = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE site_slug=$1", [slug]);
    expect(pending.rows[0].n).toBe(0);
    expect(tenant.rows[0].n).toBe(0);
  }

  it("refuses signup in a listed country and still accepts Canada and somewhere else", async () => {
    await refusedSignup(`skp${stamp}`, `kp-${stamp}@sanctioned.example`, { country: "KP" }, "North Korea");
    await refusedSignup(`scu${stamp}`, `cu-${stamp}@sanctioned.example`, { country: "Cuba" }, "Cuba");
    await refusedSignup(
      `smm${stamp}`,
      `mm-${stamp}@sanctioned.example`,
      { country: "XX", elseCountry: "Myanmar" },
      "Myanmar",
    );
    baseline.cookie = await signup(baseline.slug, baseline.email, { country: "XX" });
    canada.cookie = await signup(canada.slug, canada.email, { country: "Canada" });
    const pack = await pool.query(
      "SELECT jurisdiction_pack_id, home_currency FROM legal_entities WHERE id=$1",
      [`le-${canada.slug}`],
    );
    expect(pack.rows[0].jurisdiction_pack_id).toBe("pack-ca-v1");
    expect(pack.rows[0].home_currency).toBe("CAD");
  });

  it("refuses setting the country, and refuses launch, without saving it", async () => {
    await pool.query(
      `INSERT INTO enquiries (id, reference, kind, email, name, status)
       VALUES ($1, $2, 'early_access', $3, 'Applicant', 'invited')`,
      [enquiryId, enquiryRef, `apply-${stamp}@sanctioned.example`],
    );
    const iran = await app.inject({
      method: "PUT",
      url: `/api/onboarding/${enquiryRef}/state`,
      payload: { at: 1, data: { country: "XX", elseCountry: "Iran" } },
    });
    expect(iran.statusCode, iran.body).toBe(403);
    expect(iran.json().detail).toContain("cannot set its country");
    expect(iran.json().detail).toContain("Iran");
    plain(iran.json().detail);
    const saved = await pool.query("SELECT answers FROM onboarding WHERE enquiry_id=$1", [enquiryId]);
    expect(JSON.stringify(saved.rows[0]?.answers ?? {})).not.toContain("Iran");

    const allowed = await app.inject({
      method: "PUT",
      url: `/api/onboarding/${enquiryRef}/state`,
      payload: { at: 2, data: { country: "CA" } },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    const kp = await app.inject({
      method: "PUT",
      url: `/api/onboarding/${enquiryRef}/state`,
      payload: { at: 3, data: { country: "KP" } },
    });
    expect(kp.statusCode, kp.body).toBe(403);
    expect(kp.json().detail).toContain("North Korea");
    const still = await pool.query("SELECT answers->>'country' AS country FROM onboarding WHERE enquiry_id=$1", [enquiryId]);
    expect(still.rows[0].country).toBe("CA");

    const launchIran = await app.inject({
      method: "POST",
      url: `/api/onboarding/${enquiryRef}/launch`,
      payload: { data: { country: "Iran" } },
    });
    expect(launchIran.statusCode, launchIran.body).toBe(403);
    expect(launchIran.json().detail).toContain("cannot be opened");
    plain(launchIran.json().detail);

    const launchCuba = await app.inject({
      method: "POST",
      url: `/api/onboarding/${enquiryRef}/launch`,
      payload: { data: { country: "XX", elseCountry: "Cuba" } },
    });
    expect(launchCuba.statusCode, launchCuba.body).toBe(403);
    expect(launchCuba.json().detail).toContain("Cuba");
    const desks = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE name=$1", [enquiryRef]);
    expect(desks.rows[0].n).toBe(0);
  });

  async function openTill(cookie: string, slug: string, home: string) {
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: { cdos_session: cookie },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES ($1,$2,$3,$4,'till-01',$5,100000)`,
      [`tnt-${slug}`, `le-${slug}`, `br-${slug}-main`, `ws-${slug}-till-01`, home],
    );
  }

  async function makeClient(cookie: string, legalName: string, extra: Record<string, unknown> = {}) {
    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies: { cdos_session: cookie },
      payload: { legalName, ...extra },
    });
    expect(client.statusCode, client.body).toBe(201);
    const counter = await app.inject({
      method: "POST",
      url: `/api/clients/${client.json().clientId}/counter-record`,
      cookies: { cdos_session: cookie },
    });
    expect(counter.statusCode, counter.body).toBe(200);
    return counter.json().customerId as string;
  }

  function send(cookie: string, customerId: string, corridor: string, key: string) {
    return app.inject({
      method: "POST",
      url: "/api/ledger/remittances/send",
      cookies: { cdos_session: cookie },
      payload: {
        idempotencyKey: key,
        customerId,
        reference: key,
        principalAmount: "10.00",
        feeAmount: "0.00",
        payoutCurrency: "EUR",
        payoutAmount: "1.00",
        corridor,
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
  }

  function receive(cookie: string, customerId: string, corridor: string, key: string) {
    return app.inject({
      method: "POST",
      url: "/api/ledger/remittances/receive",
      cookies: { cdos_session: cookie },
      payload: {
        idempotencyKey: key,
        customerId,
        reference: key,
        sentCurrency: "EUR",
        sentAmount: "10.00",
        payoutAmount: "10.00",
        feeAmount: "0.00",
        corridor,
        partner: "Corridor partner",
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
  }

  async function dealsFor(slug: string, customerId: string) {
    const found = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE tenant_id=$1 AND customer_id=$2",
      [`tnt-${slug}`, customerId],
    );
    return found.rows[0].n as number;
  }

  it("blocks a transfer to or from a listed country and still posts an ordinary one", async () => {
    await openTill(baseline.cookie, baseline.slug, "USD");
    const clean = await makeClient(baseline.cookie, "Clean Client");
    const toKp = await send(baseline.cookie, clean, "KP", `send-kp-${stamp}`);
    expect(toKp.statusCode, toKp.body).toBe(422);
    expect(toKp.json().code).toBe("SANCTIONED_JURISDICTION");
    expect(toKp.json().message).toContain("sent to North Korea");
    plain(toKp.json().message);
    const fromIr = await receive(baseline.cookie, clean, "IR", `recv-ir-${stamp}`);
    expect(fromIr.statusCode, fromIr.body).toBe(422);
    expect(fromIr.json().code).toBe("SANCTIONED_JURISDICTION");
    expect(fromIr.json().message).toContain("received from Iran");
    plain(fromIr.json().message);
    expect(await dealsFor(baseline.slug, clean)).toBe(0);
    const ordinary = await send(baseline.cookie, clean, "DE", `send-de-${stamp}`);
    expect(ordinary.statusCode, ordinary.body).toBe(201);
    expect(await dealsFor(baseline.slug, clean)).toBe(1);
  });

  it("stops a deal with a listed client under SANCTIONS-STOP, and leaves the neighbours alone", async () => {
    const iran = await makeClient(baseline.cookie, "Iran Client", { country: "Iran" });
    const stopped = await send(baseline.cookie, iran, "DE", `deal-ir-${stamp}`);
    expect(stopped.statusCode, stopped.body).toBe(422);
    expect(stopped.json().code).toBe("SANCTIONS-STOP");
    expect(stopped.json().message).toContain("stopped");
    expect(stopped.json().message).toContain("SANCTIONS-STOP");
    plain(stopped.json().message);
    expect(await dealsFor(baseline.slug, iran)).toBe(0);

    const crimea = await makeClient(baseline.cookie, "Crimea Client", { country: "Ukraine", region: "Crimea" });
    const regionStop = await send(baseline.cookie, crimea, "DE", `deal-crimea-${stamp}`);
    expect(regionStop.statusCode, regionStop.body).toBe(422);
    expect(regionStop.json().code).toBe("SANCTIONS-STOP");
    expect(regionStop.json().message).toContain("Crimea and Sevastopol");

    const incorporated = await makeClient(baseline.cookie, "DPRK Co", {
      kind: "business",
      country: "Singapore",
      incorporationJurisdiction: "DPRK",
    });
    const incStop = await send(baseline.cookie, incorporated, "DE", `deal-dprk-${stamp}`);
    expect(incStop.statusCode, incStop.body).toBe(422);
    expect(incStop.json().code).toBe("SANCTIONS-STOP");

    const kyiv = await makeClient(baseline.cookie, "Kyiv Client", { country: "Ukraine", region: "Kyiv" });
    const kyivSend = await send(baseline.cookie, kyiv, "DE", `deal-kyiv-${stamp}`);
    expect(kyivSend.statusCode, kyivSend.body).toBe(201);

    const syria = await makeClient(baseline.cookie, "Syria Client", { country: "Syria" });
    const syriaSend = await send(baseline.cookie, syria, "DE", `deal-sy-${stamp}`);
    expect(syriaSend.statusCode, syriaSend.body).toBe(201);

    const russia = await makeClient(baseline.cookie, "Russia Client", { country: "Russia" });
    const russiaSend = await send(baseline.cookie, russia, "DE", `deal-ru-${stamp}`);
    expect(russiaSend.statusCode, russiaSend.body).toBe(201);
  });

  it("uses the Canada pack's TPR code for the same stop", async () => {
    await openTill(canada.cookie, canada.slug, "CAD");
    const cuba = await makeClient(canada.cookie, "Cuba Client", { country: "Cuba" });
    const stopped = await send(canada.cookie, cuba, "DE", `deal-ca-cu-${stamp}`);
    expect(stopped.statusCode, stopped.body).toBe(422);
    expect(stopped.json().code).toBe("TPR");
    expect(stopped.json().message).toContain("TPR");
    expect(stopped.json().message).toContain("Cuba");
    plain(stopped.json().message);
    expect(await dealsFor(canada.slug, cuba)).toBe(0);
  });
});
