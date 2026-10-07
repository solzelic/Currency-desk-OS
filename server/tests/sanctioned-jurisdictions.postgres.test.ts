/* A blocked jurisdiction cannot open a desk, cannot become a desk's
   country, cannot sit on either end of a transfer, and stops a deal
   with a client who is there. The stop code is SANCTIONS-STOP on
   every pack. Myanmar is enhanced due diligence, not a block. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import {
  blockedDeskCountry,
  countryChangeRefusal,
  lookupSanctionedCurrency,
  lookupSanctionedJurisdiction,
  markSanctionsStop,
  missingCorridorMessage,
  recordSanctionsStop,
  type SanctionsStopAudit,
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

function listed(id: string) {
  const entry = SANCTIONED_JURISDICTIONS.find((item) => item.id === id);
  if (!entry) throw new Error(`the sanctions list has no ${id}`);
  return entry;
}

function requiredString(body: unknown, field: string): string {
  if (typeof body !== "object" || body === null) throw new Error(`expected an object with ${field}`);
  const value = Reflect.get(body, field);
  if (typeof value !== "string" || value.length === 0) throw new Error(`expected ${field}`);
  return value;
}

describe("sanctioned jurisdiction lookup", () => {
  it("matches listed countries, regions, and currencies, and nothing nearby", () => {
    expect(SANCTIONS_LIST_VERSION).toBe("2026-10-07.1");
    expect(lookupSanctionedJurisdiction("KP")?.name).toBe("North Korea");
    expect(lookupSanctionedJurisdiction("DPRK")?.name).toBe("North Korea");
    expect(lookupSanctionedJurisdiction("North Korea")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("Democratic People's Republic of Korea")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("Korea, Democratic People's Republic of")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("  north   korea ")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("Irán")?.id).toBe("IR");
    expect(lookupSanctionedJurisdiction("Iran, Islamic Republic of")?.id).toBe("IR");
    expect(lookupSanctionedJurisdiction("NK")).toBeNull();
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
    expect(lookupSanctionedCurrency("MMK")?.tier).toBe("enhanced_due_diligence");
    expect(lookupSanctionedCurrency("USD")).toBeNull();
    expect(lookupSanctionedCurrency("RUB")).toBeNull();
    expect(lookupSanctionedCurrency("SYP")).toBeNull();
    expect(lookupSanctionedJurisdiction("CUP")).toBeNull();
    /* A two-letter code is a country. A region field does not read it,
       so the Pakistani region KP is not North Korea. */
    expect(lookupSanctionedJurisdiction("KP", "country")?.id).toBe("KP");
    expect(lookupSanctionedJurisdiction("KP", "region")).toBeNull();
    expect(lookupSanctionedJurisdiction("Donetsk Oblast", "region")?.id).toBe("UA-14");
    expect(lookupSanctionedJurisdiction("Kherson Region", "region")?.id).toBe("UA-65");
    expect(lookupSanctionedJurisdiction("Zaporizhzhia Province", "region")?.id).toBe("UA-23");
    expect(lookupSanctionedJurisdiction("Sevastopol City", "region")?.id).toBe("UA-43");
    expect(lookupSanctionedJurisdiction("Myanmar (Burma)")?.id).toBe("MM");
    expect(lookupSanctionedJurisdiction("Burma")?.tier).toBe("enhanced_due_diligence");
    expect(lookupSanctionedJurisdiction("Myanmar")?.tier).toBe("enhanced_due_diligence");
    expect(blockedDeskCountry({ country: "Myanmar" })).toBeNull();
    expect(blockedDeskCountry({ country: "MM" })).toBeNull();
    expect(blockedDeskCountry({ region: "KP" })).toBeNull();
    expect(blockedDeskCountry({ country: "KP" })?.id).toBe("KP");
    expect(blockedDeskCountry({ region: "Donetsk Oblast" })?.id).toBe("UA-14");
    plain(missingCorridorMessage("send"));
    plain(missingCorridorMessage("receive"));
    expect(missingCorridorMessage("send")).toContain("destination country");
    expect(missingCorridorMessage("receive")).toContain("source country");
    for (const entry of SANCTIONED_JURISDICTIONS) {
      if (entry.tier === "blocked") {
        plain(signupRefusal(entry).detail);
        plain(countryChangeRefusal(entry).detail);
        plain(transferRefusal(entry, "send").message);
        plain(transferRefusal(entry, "receive").message);
      }
      expect(entry.sources.every((source) => source.url.startsWith("https://") && source.asOf)).toBe(true);
    }
    const kherson = listed("UA-65");
    const zap = listed("UA-23");
    const donetsk = listed("UA-14");
    const luhansk = listed("UA-09");
    for (const region of [kherson, zap]) {
      expect(region.sources.some((source) => source.instrument.includes("14065"))).toBe(false);
      expect(region.sources.some((source) => source.authority === "US-OFAC")).toBe(false);
    }
    expect(donetsk.sources.some((source) => source.instrument.includes("14065"))).toBe(true);
    expect(luhansk.sources.some((source) => source.instrument.includes("14065"))).toBe(true);
    for (const region of [donetsk, luhansk, kherson, zap]) {
      expect(region.sources.every((source) => source.note?.includes("deliberately broader"))).toBe(true);
    }
    const cuba = listed("CU");
    expect(cuba.tier).toBe("blocked");
    expect(cuba.sources[0]?.note).toContain("business choice");
  });
});

describe("sanctions stop audit write", () => {
  it("fails when the audit row cannot be written", async () => {
    const audit: SanctionsStopAudit = {
      jurisdictionId: "IR",
      jurisdictionName: "Iran",
      listVersion: SANCTIONS_LIST_VERSION,
      dealKind: "send",
      direction: "send",
      corridor: "IR",
      currency: null,
      customerId: "cus-audit",
      blocked: "client",
    };
    const stopped = new Error("stopped");
    markSanctionsStop(stopped, audit);
    const writer = {
      query: async () => {
        throw new Error("audit insert refused");
      },
    };
    const lines: unknown[][] = [];
    const log = {
      error(context: Record<string, unknown>, message: string) {
        lines.push([message, context]);
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordSanctionsStop(writer, {
        userId: "usr-1",
        tenantId: "tnt-1",
        legalEntityId: "le-1",
        branchId: "br-1",
        workspaceId: "ws-1",
        tillId: "till-1",
      }, stopped, log)).rejects.toThrow("audit insert refused");
      const text = JSON.stringify(lines);
      expect(text).toContain("sanctions.stop");
      expect(text).toContain("IR");
      expect(text).toContain("cus-audit");
      expect(text).toContain("usr-1");
      expect(text).not.toContain("Iran Client");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
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
  if (!match?.[1]) throw new Error("no signup code in log");
  return match[1];
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
    /* Myanmar is enhanced due diligence. A desk can open there. */
    const myanmar = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: `smm${stamp}`,
        ownerName: "Owner",
        email: `mm-${stamp}@sanctioned.example`,
        password: "a-strong-pass",
        slug: `smm${stamp}`,
        onboarding: { country: "XX", elseCountry: "Myanmar (Burma)" },
      },
    });
    expect(myanmar.statusCode, myanmar.body).toBe(201);
    await pool.query("DELETE FROM pending_signups WHERE email=$1", [`mm-${stamp}@sanctioned.example`]);
    baseline.cookie = await signup(baseline.slug, baseline.email, { country: "XX" });
    canada.cookie = await signup(canada.slug, canada.email, { country: "Canada" });
    const pack = await pool.query(
      "SELECT jurisdiction_pack_id, home_currency FROM legal_entities WHERE id=$1",
      [`le-${canada.slug}`],
    );
    /* A new Canada desk opens on the current pack. Version 1 stays for desks already on it. */
    expect(pack.rows[0].jurisdiction_pack_id).toBe("pack-ca-v2");
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
    return requiredString(counter.json(), "customerId");
  }

  function send(
    cookie: string,
    customerId: string,
    corridor: string,
    key: string,
    payoutCurrency = "EUR",
    purpose = "Family support",
    sourceOfFunds = "Salary",
  ) {
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
        payoutCurrency,
        payoutAmount: "1.00",
        corridor,
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
        purpose,
        sourceOfFunds,
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
    const count = found.rows[0]?.n;
    if (typeof count !== "number") throw new Error("expected a deal count");
    return count;
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

  it("stops a Canada desk on the same SANCTIONS-STOP code and writes an audit row", async () => {
    await openTill(canada.cookie, canada.slug, "CAD");
    const cuba = await makeClient(canada.cookie, "Cuba Client", { country: "Cuba" });
    const stopped = await send(canada.cookie, cuba, "DE", `deal-ca-cu-${stamp}`);
    expect(stopped.statusCode, stopped.body).toBe(422);
    expect(stopped.json().code).toBe("SANCTIONS-STOP");
    expect(stopped.json().message).toContain("SANCTIONS-STOP");
    expect(stopped.json().message).toContain("Cuba");
    plain(stopped.json().message);
    expect(await dealsFor(canada.slug, cuba)).toBe(0);
    const audit = await pool.query(
      `SELECT action, actor_id, detail
         FROM audit_events
        WHERE tenant_id=$1 AND action='sanctions.stop'`,
      [`tnt-${canada.slug}`],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const detail = audit.rows[0].detail;
    expect(detail.jurisdictionId).toBe("CU");
    expect(detail.listVersion).toBe(SANCTIONS_LIST_VERSION);
    expect(detail.customerId).toBe(cuba);
    expect(detail.blocked).toBe("client");
    expect(audit.rows[0].actor_id).toBeTruthy();
  });

  it("refuses a patched onboarding country and does not save it", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/onboarding/${enquiryRef}`,
      payload: { stepId: "jurisdiction", answers: { country: "KP" } },
    });
    expect(patched.statusCode, patched.body).toBe(403);
    expect(patched.json().detail).toContain("North Korea");
    plain(patched.json().detail);
    const still = await pool.query(
      "SELECT answers->>'country' AS country FROM onboarding WHERE enquiry_id=$1",
      [enquiryId],
    );
    expect(still.rows[0].country).toBe("CA");
    const cuba = await app.inject({
      method: "PATCH",
      url: `/api/onboarding/${enquiryRef}`,
      payload: { stepId: "jurisdiction", answers: { elseCountry: "Cuba" } },
    });
    expect(cuba.statusCode, cuba.body).toBe(403);
    const saved = await pool.query("SELECT answers FROM onboarding WHERE enquiry_id=$1", [enquiryId]);
    expect(JSON.stringify(saved.rows[0].answers)).not.toContain("Cuba");
    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/onboarding/${enquiryRef}`,
      payload: { stepId: "jurisdiction", answers: { elseCountry: "Germany" } },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it("provisionDesk refuses a listed country that skipped the signup check", async () => {
    const email = `net-${stamp}@sanctioned.example`;
    const slug = `snet${stamp}`;
    logged = [];
    const started = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: slug,
        ownerName: "Owner",
        email,
        password: "a-strong-pass",
        slug,
        onboarding: { country: "XX" },
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    await pool.query(
      "UPDATE pending_signups SET onboarding = '{\"country\":\"KP\"}'::jsonb WHERE email=$1",
      [email],
    );
    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email, code: codeFromLog() },
    });
    expect(verified.statusCode, verified.body).toBe(403);
    expect(verified.json().error).toBe("sanctioned_country");
    expect(verified.json().detail).toContain("cannot be opened");
    plain(verified.json().detail);
    const tenant = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE site_slug=$1", [slug]);
    expect(tenant.rows[0].n).toBe(0);
    await pool.query("DELETE FROM pending_signups WHERE email=$1", [email]);
  });

  function postJson(cookie: string, url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      cookies: { cdos_session: cookie },
      payload,
    });
  }

  it("stops quotes, exchanges, cheques, bills, money orders and receives for a listed client", async () => {
    const iran = await makeClient(baseline.cookie, "Iran Deal Client", { country: "IR" });
    const quote = await postJson(baseline.cookie, "/api/quotes", {
      customerId: iran,
      from: "USD",
      to: "EUR",
      inputAmount: "10.00",
      feeCad: "0.00",
      direction: "customer_buy_foreign",
    });
    expect(quote.statusCode, quote.body).toBe(201);
    const quoted = await postJson(baseline.cookie, `/api/quotes/${quote.json().quoteId}/post`, {
      idempotencyKey: `q-ir-${stamp}`,
      purpose: "Travel",
      sourceOfFunds: "Salary",
    });
    expect(quoted.statusCode, quoted.body).toBe(422);
    expect(quoted.json().code).toBe("SANCTIONS-STOP");

    const exchange = await postJson(baseline.cookie, "/api/ledger/exchanges", {
      idempotencyKey: `ex-ir-${stamp}`,
      customerId: iran,
      from: "USD",
      to: "EUR",
      inputAmount: "10.00",
      feeCad: "0.00",
      purpose: "Travel",
      sourceOfFunds: "Salary",
    });
    expect(exchange.statusCode, exchange.body).toBe(422);
    expect(exchange.json().code).toBe("SANCTIONS-STOP");

    const cheque = await postJson(baseline.cookie, "/api/ledger/cheques", {
      idempotencyKey: `ch-ir-${stamp}`,
      customerId: iran,
      chequeNumber: "1001",
      maker: "Iran Deal Client",
      chequeType: "personal",
      typeLabel: "Personal",
      currency: "USD",
      faceAmount: "10.00",
      feeAmount: "0.00",
      holdDays: 0,
    });
    expect(cheque.statusCode, cheque.body).toBe(422);
    expect(cheque.json().code).toBe("SANCTIONS-STOP");

    const bill = await postJson(baseline.cookie, "/api/ledger/bill-payments", {
      idempotencyKey: `bill-ir-${stamp}`,
      customerId: iran,
      reference: `bill-ir-${stamp}`,
      billAmount: "10.00",
      feeAmount: "0.00",
      biller: "Hydro",
      accountRef: "acct-1",
    });
    expect(bill.statusCode, bill.body).toBe(422);
    expect(bill.json().code).toBe("SANCTIONS-STOP");

    const moneyOrder = await postJson(baseline.cookie, "/api/ledger/money-orders", {
      idempotencyKey: `mo-ir-${stamp}`,
      customerId: iran,
      reference: `mo-ir-${stamp}`,
      faceAmount: "10.00",
      feeAmount: "0.00",
      payee: "Ann Payee",
      serial: "MO-100",
    });
    expect(moneyOrder.statusCode, moneyOrder.body).toBe(422);
    expect(moneyOrder.json().code).toBe("SANCTIONS-STOP");

    const incoming = await receive(baseline.cookie, iran, "DE", `recv-ir-client-${stamp}`);
    expect(incoming.statusCode, incoming.body).toBe(422);
    expect(incoming.json().code).toBe("SANCTIONS-STOP");
    expect(await dealsFor(baseline.slug, iran)).toBe(0);

    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=$1 AND action='sanctions.stop'
          AND detail->>'customerId'=$2`,
      [`tnt-${baseline.slug}`, iran],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it("stops a payout or sent currency on a clean corridor, and does not treat region KP as North Korea", async () => {
    const clean = await makeClient(baseline.cookie, "Currency Client");
    const irr = await send(baseline.cookie, clean, "DE", `pay-irr-${stamp}`, "IRR");
    expect(irr.statusCode, irr.body).toBe(422);
    expect(irr.json().code).toBe("SANCTIONED_JURISDICTION");
    expect(irr.json().message).toContain("IRR");
    expect(irr.json().message).toContain("Iran");
    plain(irr.json().message);
    const cup = await app.inject({
      method: "POST",
      url: "/api/ledger/remittances/receive",
      cookies: { cdos_session: baseline.cookie },
      payload: {
        idempotencyKey: `recv-cup-${stamp}`,
        customerId: clean,
        reference: `recv-cup-${stamp}`,
        sentCurrency: "CUP",
        sentAmount: "10.00",
        payoutAmount: "10.00",
        feeAmount: "0.00",
        corridor: "DE",
        partner: "Corridor partner",
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
    expect(cup.statusCode, cup.body).toBe(422);
    expect(cup.json().code).toBe("SANCTIONED_JURISDICTION");
    expect(cup.json().message).toContain("CUP");
    expect(await dealsFor(baseline.slug, clean)).toBe(0);

    const pakistan = await makeClient(baseline.cookie, "Peshawar Client", { country: "Pakistan", region: "KP" });
    const ordinary = await send(baseline.cookie, pakistan, "DE", `pk-kp-${stamp}`);
    expect(ordinary.statusCode, ordinary.body).toBe(201);

    const omitted = await app.inject({
      method: "POST",
      url: "/api/ledger/remittances/send",
      cookies: { cdos_session: baseline.cookie },
      payload: {
        idempotencyKey: `no-corridor-${stamp}`,
        customerId: clean,
        reference: `no-corridor-${stamp}`,
        principalAmount: "10.00",
        feeAmount: "0.00",
        payoutCurrency: "EUR",
        payoutAmount: "1.00",
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
      },
    });
    expect(omitted.statusCode, omitted.body).toBe(400);
  });

  it("requires full identification and a reason before an enhanced-diligence deal posts", async () => {
    const unverified = await makeClient(baseline.cookie, "Myanmar Client", { country: "Myanmar" });
    const gap = await send(baseline.cookie, unverified, "DE", `mm-gap-${stamp}`, "EUR", "", "");
    expect(gap.statusCode, gap.body).toBe(422);
    expect(gap.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(gap.json().message).toContain("enhanced due diligence");
    expect(gap.json().message).toContain("Myanmar");
    plain(gap.json().message);
    expect(await dealsFor(baseline.slug, unverified)).toBe(0);
    const notedOnly = await send(baseline.cookie, unverified, "DE", `mm-note-${stamp}`);
    expect(notedOnly.statusCode, notedOnly.body).toBe(422);
    expect(notedOnly.json().message).toContain("enhanced due diligence");

    const identified = await makeClient(baseline.cookie, "Myanmar Identified", { country: "MM" });
    /* The ledger's word for papers on file. The desk's "identified"
       and "verified" both land here; this is what the gate reads. */
    await pool.query(
      "UPDATE ledger_customers SET id_status='verified' WHERE customer_id=$1",
      [identified],
    );
    const still = await send(baseline.cookie, identified, "DE", `mm-blank-${stamp}`, "EUR", "", "");
    expect(still.statusCode, still.body).toBe(422);
    expect(still.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(still.json().message).toContain("enhanced due diligence");

    const posted = await send(baseline.cookie, identified, "DE", `mm-ok-${stamp}`, "EUR", "Family support", "Salary");
    expect(posted.statusCode, posted.body).toBe(201);
    const row = await pool.query(
      "SELECT purpose, source_of_funds FROM ledger_transactions WHERE tenant_id=$1 AND customer_id=$2",
      [`tnt-${baseline.slug}`, identified],
    );
    expect(row.rows[0].purpose).toBe("Family support");
    expect(row.rows[0].source_of_funds).toBe("Salary");

    const viaCurrency = await makeClient(baseline.cookie, "Kyat Client");
    const kyat = await send(baseline.cookie, viaCurrency, "DE", `mmk-gap-${stamp}`, "MMK", "", "");
    expect(kyat.statusCode, kyat.body).toBe(422);
    expect(kyat.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(kyat.json().message).toContain("Myanmar");

    const iran = await makeClient(baseline.cookie, "Iran Over Myanmar", { country: "Iran" });
    const blockedWins = await send(baseline.cookie, iran, "MM", `ir-mm-${stamp}`, "MMK");
    expect(blockedWins.statusCode, blockedWins.body).toBe(422);
    expect(blockedWins.json().code).toBe("SANCTIONS-STOP");
  });

  it("stops when any client field is blocked, even if another field is only due diligence", async () => {
    const myanmarIncorporatedInKorea = await makeClient(baseline.cookie, "Myanmar Incorporated in Korea", {
      kind: "business",
      country: "MM",
      incorporationJurisdiction: "KP",
    });
    const stopped = await send(
      baseline.cookie,
      myanmarIncorporatedInKorea,
      "DE",
      `mm-kp-${stamp}`,
      "EUR",
      "Family support",
      "Salary",
    );
    expect(stopped.statusCode, stopped.body).toBe(422);
    expect(stopped.json().code).toBe("SANCTIONS-STOP");
    const firstAudit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=$1 AND action='sanctions.stop' AND detail->>'customerId'=$2`,
      [`tnt-${baseline.slug}`, myanmarIncorporatedInKorea],
    );
    expect(firstAudit.rows[0].n).toBe(1);

    const koreaIncorporatedInMyanmar = await makeClient(baseline.cookie, "Korea Incorporated in Myanmar", {
      kind: "business",
      country: "KP",
      incorporationJurisdiction: "MM",
    });
    const reverse = await send(
      baseline.cookie,
      koreaIncorporatedInMyanmar,
      "DE",
      `kp-mm-${stamp}`,
      "EUR",
      "Family support",
      "Salary",
    );
    expect(reverse.statusCode, reverse.body).toBe(422);
    expect(reverse.json().code).toBe("SANCTIONS-STOP");
    const secondAudit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=$1 AND action='sanctions.stop' AND detail->>'customerId'=$2`,
      [`tnt-${baseline.slug}`, koreaIncorporatedInMyanmar],
    );
    expect(secondAudit.rows[0].n).toBe(1);
  });

  it("does not post a stopped deal when the audit row cannot be written", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION refuse_sanctions_stop_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'sanctions.stop' THEN
          RAISE EXCEPTION 'audit insert refused';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await pool.query("DROP TRIGGER IF EXISTS refuse_sanctions_stop_audit ON audit_events");
    await pool.query(`
      CREATE TRIGGER refuse_sanctions_stop_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION refuse_sanctions_stop_audit()
    `);
    try {
      const iran = await makeClient(baseline.cookie, "Iran Unrecorded", { country: "Iran" });
      const stopped = await send(baseline.cookie, iran, "DE", `deal-unrecorded-${stamp}`);
      expect(stopped.statusCode, stopped.body).toBe(500);
      expect(stopped.json().code).toBe("INTERNAL_ERROR");
      expect(await dealsFor(baseline.slug, iran)).toBe(0);
      const audit = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE tenant_id=$1 AND action='sanctions.stop' AND detail->>'customerId'=$2`,
        [`tnt-${baseline.slug}`, iran],
      );
      expect(audit.rows[0].n).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS refuse_sanctions_stop_audit ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS refuse_sanctions_stop_audit()");
    }
  });
});
