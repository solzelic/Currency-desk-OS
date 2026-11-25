/* Sandbox start-check. The provider is stubbed. No live keys and no network. */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { reserveIdvCredit } from "../src/idv/credit.js";
import type { IdvProvider } from "../src/idv/provider.js";
import { personaPassLabel } from "../src/idv/providers/persona.js";
import { PERSONA_API_BASE_DEFAULT, PERSONA_VERSION, createPersonaProvider } from "../src/idv/providers/persona/index.js";
import { countOpenInquiries, insertIdvInquiry } from "../src/idv/store.js";

const SECRET = "fixture-webhook-secret";
const ENV = { PERSONA_API_KEY: "fixture-api-key" };
const persona = createPersonaProvider({ PERSONA_WEBHOOK_SECRET: SECRET });
if (!persona) throw new Error("fixture provider");
const ROUTE = "/api/idv/start-check";
const B = { tenantId: "tnt-idv-b", legalEntityId: "le-idv-b", branchId: "br-idv-b", userId: "tnt-idv-b:b.owner", staffId: "b.owner" };
const EVENTS = [
  ["inquiry.created", "pending", "in progress"],
  ["inquiry.started", "pending", "in progress"],
  ["inquiry.completed", "pending", undefined],
  ["inquiry.approved", "approved", undefined],
  ["inquiry.declined", "declined", undefined],
  ["inquiry.marked-for-review", "review", "needs review"],
  ["inquiry.failed", "failed", undefined],
  ["inquiry.expired", "expired", undefined],
] as const;

let handle: DbHandle;
let app: FastifyInstance;
let bare: FastifyInstance;
let calls = 0;
let attempt = 0;
let plan = [201];
const sleeps: number[] = [];
const cookies: Record<string, Record<string, string>> = {};

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}
const mac = (body: Buffer, t: number) => createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest("hex");
function payload(name: string, eventId: string, referenceId: string, providerRef: string) {
  return JSON.stringify({
    data: { id: eventId, attributes: { name, payload: { data: {
      id: providerRef,
      attributes: { status: name.replace("inquiry.", ""), "reference-id": referenceId, name: "Not Stored", email: "secret@example.com" },
    } } } },
  });
}

const fetchStub: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") {
    return new Response(JSON.stringify({
      data: { id: "inq_get", type: "inquiry", attributes: { status: "approved" } },
      included: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  calls += 1;
  attempt += 1;
  const body = String(init?.body ?? "");
  const sent = JSON.parse(body) as {
    data: { attributes: Record<string, string> };
    meta: { "auto-create-account": boolean };
  };
  const referenceId = sent.data.attributes["reference-id"] ?? "";
  const headers = init?.headers as Record<string, string>;
  expect(String(input)).toBe(`${PERSONA_API_BASE_DEFAULT}/inquiries`);
  expect(init?.method).toBe("POST");
  expect(headers.authorization).toBe("Bearer fixture-api-key");
  expect(headers["persona-version"]).toBe(PERSONA_VERSION);
  expect(headers["key-inflection"]).toBe("kebab");
  expect(headers["idempotency-key"]).toBe(referenceId);
  expect(Object.keys(sent).sort()).toEqual(["data", "meta"]);
  expect(sent.meta["auto-create-account"]).toBe(false);
  expect(Object.keys(sent.data).sort()).toEqual(["attributes"]);
  expect(Object.keys(sent.data.attributes).sort()).toEqual(["inquiry-template-id", "reference-id"]);
  expect(sent.data.attributes["inquiry-template-id"]).toBe("itmpl_fixture");
  expect(body).not.toContain(DEMO.legalEntityId);
  expect(body).not.toContain("secret@example.com");
  expect(body).not.toMatch(/name-first|birthdate|email-address/);
  const open = await handle.db.execute(sql`
    SELECT reference_id, shop_id, teller_id, provider_ref FROM idv_inquiries WHERE reference_id = ${referenceId}
  `);
  const row = open.rows[0] as { reference_id: string; shop_id: string; teller_id: string; provider_ref: string };
  expect(row.provider_ref).toBe(row.reference_id);
  expect(row.reference_id).not.toContain(row.shop_id);
  expect(row.reference_id).not.toContain(row.teller_id);
  const status = plan[Math.min(attempt, plan.length) - 1] ?? 201;
  if (status !== 201) return new Response("", { status });
  return new Response(JSON.stringify({
    data: { id: `inq_${calls}`, attributes: { name: "Not Stored", email: "secret@example.com", phone: "+14165550199" } },
  }), { status: 201, headers: { "content-type": "application/json" } });
};

async function signIn(target: FastifyInstance, staffId: string, tenantId: string) {
  const res = await target.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password, tenantId } });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
}
const start = (who: string, payloadBody: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: ROUTE, cookies: cookies[who], payload: payloadBody });
const enable = (shopId: string, checksEnabled: boolean) => handle.db.execute(sql`
  INSERT INTO idv_shop_config (shop_id, provider, api_key_ref, template_id, checks_enabled)
  VALUES (${shopId}, 'persona', 'PERSONA_API_KEY', 'itmpl_fixture', ${checksEnabled})
  ON CONFLICT (shop_id) DO UPDATE
    SET provider = 'persona', api_key_ref = 'PERSONA_API_KEY', template_id = 'itmpl_fixture', checks_enabled = ${checksEnabled}
`);

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.execute(sql`
    CREATE TABLE IF NOT EXISTS idv_shop_config (
      shop_id text PRIMARY KEY,
      provider text NOT NULL DEFAULT 'persona',
      checks_enabled boolean NOT NULL DEFAULT false
    )
  `);
  const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "j.masri")).limit(1);
  await handle.db.insert(schema.tenants).values({ id: B.tenantId, name: "Shop B" });
  await handle.db.insert(schema.legalEntities).values({ id: B.legalEntityId, tenantId: B.tenantId, name: "Shop B", jurisdiction: "FINTRAC" });
  await handle.db.insert(schema.branches).values({ id: B.branchId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, name: "Shop B counter", province: "ON" });
  await handle.db.insert(schema.staffUsers).values({
    id: B.userId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, branchId: B.branchId,
    staffId: B.staffId, name: "B Owner", role: "administrator", authorizedBranchIds: [B.branchId], passwordHash: owner[0]!.passwordHash,
  });
  const opts = { persona, fetch: fetchStub, sleep: async (ms: number) => { sleeps.push(ms); } };
  const room = { ratePerMinute: 1000, rateLimitStore: new Map<string, number[]>() };
  app = await buildApp(handle.db, {}, undefined, { ...opts, env: ENV, ...room });
  bare = await buildApp(handle.db, {}, undefined, { ...opts, env: {}, ratePerMinute: 1000, rateLimitStore: new Map() });
  cookies.a = await signIn(app, "m.costa", DEMO.tenantId);
  cookies.b = await signIn(app, B.staffId, B.tenantId);
});
afterAll(async () => { await app.close(); await bare.close(); await handle.close(); });

describe("sandbox start-check", () => {
  it("refuses a shop whose checks are off", async () => {
    const before = calls;
    const res = await start("a", { shopId: B.legalEntityId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "IDV_OFF", message: "Identity checks are off for this shop." });
    expect(calls).toBe(before);
  });

  it("answers not connected when the keys are unset", async () => {
    await enable(DEMO.legalEntityId, true);
    const before = calls;
    const res = await bare.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, message: "Identity checks are not connected." });
    expect(calls).toBe(before);
  });

  it("shop A cannot start a check for shop B", async () => {
    attempt = 0;
    plan = [201];
    const res = await start("a", { shopId: B.legalEntityId, branchId: B.branchId, tellerId: B.userId, email: "ada@example.com", phone: "+14165550100", name: "Ada" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providerRef).toMatch(/^inq_\d+$/);
    expect(body.referenceId).not.toContain("ada");
    expect(body.referenceId).not.toContain(DEMO.legalEntityId);
    expect(body.referenceId).not.toContain("+1416");
    expect(JSON.stringify(body)).not.toContain("Not Stored");
    expect(JSON.stringify(body)).not.toContain("secret@example.com");
    const stored = await handle.db.execute(sql`SELECT shop_id, branch_id, provider_ref, status FROM idv_inquiries WHERE reference_id = ${body.referenceId}`);
    expect(stored.rows[0]).toMatchObject({ shop_id: DEMO.legalEntityId, branch_id: DEMO.branchId, provider_ref: body.providerRef, status: "starting" });
    expect(JSON.stringify(stored.rows[0])).not.toContain("secret@example.com");
    const other = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_inquiries WHERE shop_id = ${B.legalEntityId}`);
    expect(Number((other.rows[0] as { n: number }).n)).toBe(0);
  });

  it("keeps the check on that client and shows the webhook status on the file", async () => {
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_idv_a', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Ada Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_idv_b', ${B.tenantId}, ${B.legalEntityId}, 'Bea Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    await enable(DEMO.legalEntityId, true);
    const before = calls;
    const missing = await start("a", { clientId: "cli_idv_b", name: "Bea Client" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe("That client is not on this shop.");
    expect(calls).toBe(before);
    const started = await start("a", { clientId: "cli_idv_a", name: "Ada Client", email: "ada@example.com" });
    expect(started.statusCode, started.body).toBe(200);
    const body = started.json();
    expect(JSON.stringify(body)).not.toContain("Ada");
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
    const row = await handle.db.execute(sql`SELECT client_id, status FROM idv_inquiries WHERE reference_id = ${body.referenceId}`);
    expect(row.rows[0]).toMatchObject({ client_id: "cli_idv_a", status: "starting" });
    const open = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_a", cookies: cookies.a });
    expect(open.json()).toMatchObject({ status: "starting", checksEnabled: true });
    const raw = payload("inquiry.approved", "evt_cli_a", body.referenceId, body.providerRef);
    const t = Math.floor(Date.now() / 1000);
    const hook = await app.inject({
      method: "POST", url: "/api/webhooks/idv/persona", payload: raw,
      headers: { "content-type": "application/json", "persona-signature": `t=${t},v1=${mac(Buffer.from(raw), t)}` },
    });
    expect(hook.statusCode, hook.body).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_a", cookies: cookies.a });
    expect(after.json()).toMatchObject({ status: "Check passed", checksEnabled: true });
    expect(JSON.stringify(after.json())).not.toContain("Approved");
    expect(JSON.stringify(after.json())).not.toContain("Not Stored");
    const otherShop = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_a", cookies: cookies.b });
    expect(otherShop.statusCode).toBe(404);
    const empty = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_b", cookies: cookies.b });
    expect(empty.json()).toMatchObject({ status: null, provider: "persona", ready: "off", checksEnabled: false });
  });

  it("tells a teller the provider and why a check is not ready", async () => {
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_idv_b', ${B.tenantId}, ${B.legalEntityId}, 'Bea Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    const off = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_b", cookies: cookies.b });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ provider: "persona", ready: "off", checksEnabled: false });
    await enable(B.legalEntityId, true);
    await handle.db.execute(sql`
      UPDATE idv_shop_config SET provider = 'didit', checks_enabled = true WHERE shop_id = ${B.legalEntityId}
    `);
    const notTest = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_b", cookies: cookies.b });
    expect(notTest.json()).toMatchObject({ provider: "didit", ready: "not_test_shop", checksEnabled: true });
    await handle.db.execute(sql`UPDATE tenants SET is_test_shop = true WHERE id = ${B.tenantId}`);
    const missing = await app.inject({ method: "GET", url: "/api/idv/clients/cli_idv_b", cookies: cookies.b });
    expect(missing.json()).toMatchObject({ provider: "didit", ready: "not_configured", checksEnabled: true });
    await handle.db.execute(sql`UPDATE tenants SET is_test_shop = false WHERE id = ${B.tenantId}`);
    await enable(B.legalEntityId, false);
  });

  it("reads the client from the ledger connection when that is where the file lives", async () => {
    const seen: string[] = [];
    const local = await buildApp(handle.db, {}, undefined, {
      env: ENV,
      fetch: fetchStub,
      sleep: async () => {},
      clients: {
        query: async (text, values) => {
          seen.push(String(values[0]));
          return { rowCount: text.includes("tenant_id") && values[0] === "cli_ledger" && values[2] === DEMO.tenantId ? 1 : 0 };
        },
      },
    });
    try {
      await enable(DEMO.legalEntityId, true);
      const missing = await local.inject({ method: "GET", url: "/api/idv/clients/cli_missing", cookies: cookies.a });
      expect(missing.statusCode).toBe(404);
      const found = await local.inject({ method: "GET", url: "/api/idv/clients/cli_ledger", cookies: cookies.a });
      expect(found.statusCode, found.body).toBe(200);
      expect(found.json()).toMatchObject({ status: null, checksEnabled: true });
      expect(seen).toEqual(["cli_missing", "cli_ledger"]);
      const before = calls;
      const started = await local.inject({
        method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_ledger" },
      });
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json().connected).toBe(true);
      expect(calls).toBe(before + 1);
      const row = await handle.db.execute(sql`
        SELECT client_id FROM idv_inquiries WHERE reference_id = ${started.json().referenceId}
      `);
      expect(row.rows[0]).toMatchObject({ client_id: "cli_ledger" });
      const localOnly = await handle.db.execute(sql`
        SELECT 1 FROM desk_clients WHERE client_id = 'cli_ledger'
      `);
      expect(localOnly.rows).toEqual([]);
    } finally {
      await local.close();
    }
  });

  it("refuses an auditor and a client id that is too long", async () => {
    const teller = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "m.costa")).limit(1);
    await handle.db.insert(schema.staffUsers).values({
      id: `${DEMO.tenantId}:l.berg`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
      staffId: "l.berg", name: "L. Berg", role: "auditor", authorizedBranchIds: [DEMO.branchId], passwordHash: teller[0]!.passwordHash,
    }).onConflictDoNothing();
    cookies.auditor = await signIn(app, "l.berg", DEMO.tenantId);
    const before = calls;
    const refused = await start("auditor");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden", message: "You cannot start an identity check." });
    expect(calls).toBe(before);
    await enable(DEMO.legalEntityId, true);
    const longId = await start("a", { clientId: "c".repeat(81) });
    expect(longId.statusCode).toBe(400);
    expect(longId.json()).toEqual({ error: "invalid_client", message: "That client id is not valid." });
    expect(calls).toBe(before);
  });

  it("says Check passed (test) for a sandbox key and Check passed for a production key", async () => {
    const STAGING = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" };
    expect(personaPassLabel({ PERSONA_API_KEY: "persona_sandbox_fixture" }, "PERSONA_API_KEY", "YORKFX")).toBe("Check passed (test)");
    expect(personaPassLabel({ PERSONA_API_KEY: "persona_production_fixture" }, "PERSONA_API_KEY", "YORKFX")).toBe("Check passed");
    expect(personaPassLabel({ ...STAGING, PERSONA_API_KEY: "persona_production_fixture" }, null, "YORKFX")).toBe("Check passed");
    expect(personaPassLabel({ ...STAGING, PERSONA_API_KEY: "fixture-api-key" }, "", "YORKFX")).toBe("Check passed (test)");
    expect(personaPassLabel({ PERSONA_API_KEY: "fixture-api-key" }, "PERSONA_API_KEY", "YORKFX")).toBe("Check passed");
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_idv_a', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Ada Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    await enable(DEMO.legalEntityId, true);
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, status, client_id)
      VALUES ('ref-pass', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'teller', 'persona', 'inq_pass', 'approved', 'cli_idv_a')
      ON CONFLICT (reference_id) DO UPDATE SET status = 'approved', client_id = 'cli_idv_a'
    `);
    const sandbox = await buildApp(handle.db, {}, undefined, {
      env: { PERSONA_API_KEY: "persona_sandbox_fixture" },
      fetch: fetchStub,
      sleep: async () => {},
    });
    try {
      const res = await sandbox.inject({ method: "GET", url: "/api/idv/clients/cli_idv_a", cookies: cookies.a });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ status: "Check passed (test)", checksEnabled: true });
      expect(res.body).not.toContain("Approved");
    } finally {
      await sandbox.close();
    }
  });

  it("refuses a shop that is already at the cap", async () => {
    await enable(B.legalEntityId, true);
    for (let i = 0; i < 5; i += 1) {
      await insertIdvInquiry(handle.db, { referenceId: `cap-${i}`, shopId: B.legalEntityId, branchId: B.branchId, tellerId: B.userId, provider: "persona", providerRef: `cap-${i}` });
    }
    const before = calls;
    const res = await start("b", { shopId: DEMO.legalEntityId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "IDV_CAP", message: "This shop already has the maximum number of identity checks in progress." });
    expect(calls).toBe(before);
  });

  it("retries a 429 and a 500, and the inquiry row exists before each call", async () => {
    attempt = 0;
    plan = [429, 500, 201];
    const before = sleeps.length;
    const res = await start("a");
    expect(res.statusCode).toBe(200);
    expect(res.json().providerRef).toMatch(/^inq_\d+$/);
    expect(attempt).toBe(3);
    expect(sleeps.slice(before)).toEqual([25, 50]);
  });

  it("reserve is idempotent and writes nothing when no credit ledger exists", async () => {
    const before = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_inquiries`);
    expect([reserveIdvCredit("inq-once"), reserveIdvCredit("inq-once")]).toEqual(["no_ledger", "no_ledger"]);
    const after = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_inquiries`);
    expect(after.rows).toEqual(before.rows);
  });

  it("starts a new inquiry after a failed start and after a finished check", async () => {
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_again', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Again Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    let fail = true;
    const localFetch: typeof fetch = async () => {
      if (fail) return new Response("", { status: 502 });
      return new Response(JSON.stringify({ data: { id: `inq_again_${Date.now()}` } }), { status: 201 });
    };
    const local = await buildApp(handle.db, {}, undefined, {
      env: ENV, fetch: localFetch, sleep: async () => {}, cap: 1000, ratePerMinute: 1000, rateLimitStore: new Map(),
    });
    try {
      await enable(DEMO.legalEntityId, true);
      const first = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_again" } });
      expect(first.statusCode).toBe(502);
      fail = false;
      const second = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_again" } });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().referenceId).not.toBeUndefined();
      await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'approved' WHERE reference_id = ${second.json().referenceId}`);
      const third = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_again" } });
      expect(third.statusCode, third.body).toBe(200);
      expect(third.json().referenceId).not.toBe(second.json().referenceId);
      const rows = await handle.db.execute(sql`SELECT reference_id, status FROM idv_inquiries WHERE client_id = 'cli_again'`);
      expect(rows.rows).toHaveLength(3);
      const statuses = (rows.rows as Array<{ status: string }>).map((row) => row.status).sort();
      expect(statuses).toEqual(["approved", "failed", "starting"]);
    } finally {
      await local.close();
    }
  });

  it("stops after 3 tries and answers 502", async () => {
    attempt = 0;
    plan = [429, 500, 429, 500, 429, 201];
    const before = sleeps.length;
    const res = await start("a");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "provider_unavailable", message: "The identity check could not be started. Nothing from the provider was saved." });
    expect(attempt).toBe(3);
    expect(sleeps.slice(before)).toEqual([25, 50]);
  });

  it("starts through a fake provider and does not need provider env vars", async () => {
    let seen = 0;
    const fake: IdvProvider = {
      name: "fixture",
      startCheck: async () => { seen += 1; return { providerRef: "fix_1" }; },
      verifyWebhook: () => false,
      parseResult: () => null,
    };
    const local = await buildApp(handle.db, {}, undefined, { providers: { fixture: fake }, env: {} });
    try {
      await enable(DEMO.legalEntityId, true);
      await handle.db.execute(sql`UPDATE idv_shop_config SET provider = 'fixture' WHERE shop_id = ${DEMO.legalEntityId}`);
      const res = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: {} });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ connected: true, providerRef: "fix_1" });
      expect(seen).toBe(1);
    } finally {
      await handle.db.execute(sql`UPDATE idv_shop_config SET provider = 'persona' WHERE shop_id = ${DEMO.legalEntityId}`);
      await local.close();
    }
  });

  it("uses shop A's key name for shop A and shop B's for shop B", async () => {
    const seen: string[] = [];
    const env = {
      PERSONA_API_KEY: "fixture-shared",
      PERSONA_API_KEY_YORKFX: "fixture-shop-a",
      PERSONA_API_KEY_SHOP_B: "fixture-shop-b",
    };
    const localFetch: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push(headers.authorization ?? "");
      return new Response(JSON.stringify({ data: { id: `inq_ref_${seen.length}` } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    };
    const local = await buildApp(handle.db, {}, undefined, { env, fetch: localFetch, sleep: async () => {} });
    try {
      await handle.db.execute(sql`DELETE FROM idv_events WHERE shop_id IN (${DEMO.legalEntityId}, ${B.legalEntityId})`);
      await handle.db.execute(sql`DELETE FROM idv_inquiries WHERE shop_id IN (${DEMO.legalEntityId}, ${B.legalEntityId})`);
      await handle.db.execute(sql`
        INSERT INTO idv_shop_config (shop_id, provider, api_key_ref, template_id, checks_enabled)
        VALUES (${DEMO.legalEntityId}, 'persona', 'PERSONA_API_KEY_YORKFX', 'itmpl_fixture', true)
        ON CONFLICT (shop_id) DO UPDATE
          SET provider = 'persona', api_key_ref = 'PERSONA_API_KEY_YORKFX', template_id = 'itmpl_fixture', checks_enabled = true
      `);
      await handle.db.execute(sql`
        INSERT INTO idv_shop_config (shop_id, provider, api_key_ref, template_id, checks_enabled)
        VALUES (${B.legalEntityId}, 'persona', 'PERSONA_API_KEY_SHOP_B', 'itmpl_fixture', true)
        ON CONFLICT (shop_id) DO UPDATE
          SET provider = 'persona', api_key_ref = 'PERSONA_API_KEY_SHOP_B', template_id = 'itmpl_fixture', checks_enabled = true
      `);
      const shopA = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { shopId: B.legalEntityId } });
      const shopB = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.b, payload: { shopId: DEMO.legalEntityId } });
      expect(shopA.statusCode, shopA.body).toBe(200);
      expect(shopB.statusCode, shopB.body).toBe(200);
      expect(shopA.json().connected).toBe(true);
      expect(shopB.json().connected).toBe(true);
      expect(seen).toEqual(["Bearer fixture-shop-a", "Bearer fixture-shop-b"]);
      expect(seen.join("")).not.toContain("fixture-shared");
      await handle.db.execute(sql`UPDATE idv_shop_config SET api_key_ref = NULL WHERE shop_id = ${DEMO.legalEntityId}`);
      const shared = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: {} });
      expect(shared.statusCode, shared.body).toBe(200);
      expect(shared.json().connected).toBe(true);
      expect(seen[2]).toBe("Bearer fixture-shared");
    } finally {
      await handle.db.execute(sql`
        UPDATE idv_shop_config SET api_key_ref = 'PERSONA_API_KEY', provider = 'persona'
         WHERE shop_id IN (${DEMO.legalEntityId}, ${B.legalEntityId})
      `);
      await local.close();
    }
  });

  it("reuses one open inquiry and keeps the idempotency key", async () => {
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli_once', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Once Client')
      ON CONFLICT (client_id) DO NOTHING
    `);
    await enable(DEMO.legalEntityId, true);
    const keys: string[] = [];
    const localFetch: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      keys.push(headers["idempotency-key"] ?? "");
      return new Response(JSON.stringify({ data: { id: "inq_once" } }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const local = await buildApp(handle.db, {}, undefined, {
      env: ENV, fetch: localFetch, sleep: async () => {}, cap: 100, ratePerMinute: 1000, rateLimitStore: new Map(),
    });
    try {
      const first = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_once" } });
      const second = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: { clientId: "cli_once" } });
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().referenceId).toBe(first.json().referenceId);
      expect(second.json().reused).toBe(true);
      const rows = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_inquiries WHERE client_id = 'cli_once'`);
      expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);
      expect(keys).toEqual([first.json().referenceId]);
      const audited = await handle.db.execute(sql`
        SELECT action FROM audit_events WHERE action = 'idv.check_started' AND detail->>'referenceId' = ${first.json().referenceId}
      `);
      expect(audited.rows).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it("refuses a sandbox key off staging and a production key on staging", async () => {
    await enable(DEMO.legalEntityId, true);
    const staging = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" };
    let issued = 0;
    const run = async (env: NodeJS.ProcessEnv) => {
      let hits = 0;
      const local = await buildApp(handle.db, {}, undefined, {
        env, fetch: async () => { hits += 1; issued += 1; return new Response(JSON.stringify({ data: { id: `inq_key_${issued}` } }), { status: 201 }); },
        sleep: async () => {}, cap: 100, ratePerMinute: 1000, rateLimitStore: new Map(),
      });
      try {
        const res = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: {} });
        return { status: res.statusCode, body: res.json(), hits };
      } finally {
        await local.close();
      }
    };
    const sandboxOffStaging = await run({ PERSONA_API_KEY: "persona_sandbox_fixture" });
    expect(sandboxOffStaging.status).toBe(409);
    expect(sandboxOffStaging.body.message).toBe("This shop's identity key does not match this server.");
    expect(sandboxOffStaging.hits).toBe(0);
    const productionOnStaging = await run({ ...staging, PERSONA_API_KEY: "persona_production_fixture" });
    expect(productionOnStaging.status).toBe(409);
    expect(productionOnStaging.hits).toBe(0);
    const sandboxOnStaging = await run({ ...staging, PERSONA_API_KEY: "persona_sandbox_fixture" });
    expect(sandboxOnStaging.status).toBe(200);
    expect(sandboxOnStaging.hits).toBe(1);
    const unsetSandbox = await run({ PERSONA_API_KEY: "persona_sandbox_fixture" });
    expect(unsetSandbox.status).toBe(409);
    expect(unsetSandbox.hits).toBe(0);
    const unsetProduction = await run({ PERSONA_API_KEY: "persona_production_fixture" });
    expect(unsetProduction.status).toBe(409);
    expect(unsetProduction.hits).toBe(0);
    const live = { RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com" };
    const sandboxOnLive = await run({ ...live, PERSONA_API_KEY: "persona_sandbox_fixture" });
    expect(sandboxOnLive.status).toBe(409);
    expect(sandboxOnLive.hits).toBe(0);
  });

  let keyIssued = 0;
  async function keyStart(env: NodeJS.ProcessEnv) {
    let hits = 0;
    const local = await buildApp(handle.db, {}, undefined, {
      env,
      fetch: async () => {
        hits += 1;
        keyIssued += 1;
        return new Response(JSON.stringify({ data: { id: `inq_guard_${keyIssued}` } }), { status: 201 });
      },
      sleep: async () => {}, cap: 1000, ratePerMinute: 1000, rateLimitStore: new Map(),
    });
    try {
      const res = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.a, payload: {} });
      return { status: res.statusCode, body: res.json() as { code?: string }, hits };
    } finally {
      await local.close();
    }
  }

  it("refuses a live key on a live host", async () => {
    await enable(DEMO.legalEntityId, true);
    const refused = await keyStart({ RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com", PERSONA_API_KEY: "persona_production_fixture" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("IDV_KEY");
    expect(refused.hits).toBe(0);
  });

  it("refuses a live key on staging", async () => {
    await enable(DEMO.legalEntityId, true);
    const refused = await keyStart({
      STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com", PERSONA_API_KEY: "persona_production_fixture",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("IDV_KEY");
    expect(refused.hits).toBe(0);
  });

  it("refuses an unknown key prefix", async () => {
    await enable(DEMO.legalEntityId, true);
    const refused = await keyStart({ PERSONA_API_KEY: "persona_other_fixture" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("IDV_KEY");
    expect(refused.hits).toBe(0);
  });

  it("refuses a sandbox key on a live host", async () => {
    await enable(DEMO.legalEntityId, true);
    const refused = await keyStart({ RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com", PERSONA_API_KEY: "persona_sandbox_fixture" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("IDV_KEY");
    expect(refused.hits).toBe(0);
  });

  it("allows a sandbox key on staging", async () => {
    await enable(DEMO.legalEntityId, true);
    const allowed = await keyStart({
      STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com", PERSONA_API_KEY: "persona_sandbox_fixture",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.hits).toBe(1);
  });

  it("stops a shop after 10 starts in a minute", async () => {
    await handle.db.execute(sql`DELETE FROM idv_events WHERE shop_id = ${B.legalEntityId}`);
    await handle.db.execute(sql`DELETE FROM idv_inquiries WHERE shop_id = ${B.legalEntityId}`);
    await enable(B.legalEntityId, true);
    const local = await buildApp(handle.db, {}, undefined, {
      env: ENV, fetch: fetchStub, sleep: async () => {}, cap: 20, ratePerMinute: 10, rateLimitStore: new Map(),
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.b, payload: {} });
        expect(res.statusCode, res.body).toBe(200);
      }
      const blocked = await local.inject({ method: "POST", url: ROUTE, cookies: cookies.b, payload: {} });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().message).toBe("Too many identity checks were started. Wait a minute and try again.");
    } finally {
      await local.close();
    }
  });
});

describe("inquiry progress events", () => {
  function post(name: string, eventId: string, referenceId: string, providerRef: string) {
    const raw = payload(name, eventId, referenceId, providerRef);
    const t = Math.floor(Date.now() / 1000);
    return app.inject({
      method: "POST", url: "/api/webhooks/idv/persona", payload: raw,
      headers: { "content-type": "application/json", "persona-signature": `t=${t},v1=${mac(Buffer.from(raw), t)}` },
    });
  }
  async function statusOf(referenceId: string) {
    const found = await handle.db.execute(sql`SELECT status FROM idv_inquiries WHERE reference_id = ${referenceId}`);
    return (found.rows[0] as { status: string }).status;
  }

  it("maps each locked event name", () => {
    for (const [name, outcome, inquiryStatus] of EVENTS) {
      const parsed = persona.parseResult(JSON.parse(payload(name, "evt", "ref", "inq")));
      expect(parsed?.outcome).toBe(outcome);
      expect(parsed?.inquiryStatus).toBe(inquiryStatus);
      expect(JSON.stringify(parsed)).not.toContain("Not Stored");
      expect(JSON.stringify(parsed)).not.toContain("secret@example.com");
    }
  });

  async function deliver(name: string, referenceId: string) {
    await insertIdvInquiry(handle.db, { referenceId, shopId: DEMO.legalEntityId, branchId: DEMO.branchId, tellerId: "teller-a", provider: "persona", providerRef: `inq_${referenceId}` });
    return post(name, `evt_${referenceId}`, referenceId, `inq_${referenceId}`);
  }

  it("created marks the inquiry in progress and does nothing else", async () => {
    expect((await deliver("inquiry.created", "ref-created")).json()).toEqual({ received: true, duplicate: false });
    expect((await post("inquiry.created", "evt_ref-created", "ref-created", "inq_ref-created")).json()).toEqual({ received: true, duplicate: true });
    expect(await statusOf("ref-created")).toBe("in progress");
  });

  it("started marks the inquiry in progress and does nothing else", async () => {
    expect((await deliver("inquiry.started", "ref-started")).json()).toEqual({ received: true, duplicate: false });
    expect(await statusOf("ref-started")).toBe("in progress");
  });

  it("marked-for-review sets needs review and does not pass the inquiry", async () => {
    expect((await deliver("inquiry.marked-for-review", "ref-review")).statusCode).toBe(200);
    expect(await statusOf("ref-review")).toBe("needs review");
    const event = await handle.db.execute(sql`SELECT outcome FROM idv_events WHERE reference_id = 'ref-review'`);
    expect((event.rows[0] as { outcome: string }).outcome).toBe("review");
    expect(reserveIdvCredit("ref-review")).toBe("no_ledger");
  });

  it("does not move needs review back to in progress", async () => {
    const referenceId = "ref-review-late";
    await insertIdvInquiry(handle.db, {
      referenceId, shopId: DEMO.legalEntityId, branchId: DEMO.branchId, tellerId: "teller-a",
      provider: "persona", providerRef: "inq_review_late",
    });
    await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'needs review' WHERE reference_id = ${referenceId}`);
    expect((await post("inquiry.created", "evt_review_late_created", referenceId, "inq_review_late")).statusCode).toBe(200);
    expect((await post("inquiry.started", "evt_review_late_started", referenceId, "inq_review_late")).statusCode).toBe(200);
    expect(await statusOf(referenceId)).toBe("needs review");
  });

  it("does not move a final status backwards or take the cap slot again", async () => {
    const referenceId = "ref-final";
    await insertIdvInquiry(handle.db, {
      referenceId, shopId: DEMO.legalEntityId, branchId: DEMO.branchId, tellerId: "teller-a",
      provider: "persona", providerRef: "inq_final",
    });
    await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'approved' WHERE reference_id = ${referenceId}`);
    const openBefore = await countOpenInquiries(handle.db, DEMO.legalEntityId);
    const created = await post("inquiry.created", "evt_final_created", referenceId, "inq_final");
    expect(created.json()).toEqual({ received: true, duplicate: false });
    const startedLate = await post("inquiry.started", "evt_final_started", referenceId, "inq_final");
    expect(startedLate.statusCode).toBe(200);
    const declined = await post("inquiry.declined", "evt_final_declined", referenceId, "inq_final");
    expect(declined.statusCode).toBe(200);
    expect(await statusOf(referenceId)).toBe("approved");
    expect(await countOpenInquiries(handle.db, DEMO.legalEntityId)).toBe(openBefore);
    const replay = await post("inquiry.approved", "evt_final_created", referenceId, "inq_final");
    expect(replay.json()).toEqual({ received: true, duplicate: true });
    expect(await statusOf(referenceId)).toBe("approved");
    const flipped = "ref-declined";
    await insertIdvInquiry(handle.db, {
      referenceId: flipped, shopId: DEMO.legalEntityId, branchId: DEMO.branchId, tellerId: "teller-a",
      provider: "persona", providerRef: "inq_declined",
    });
    await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'declined' WHERE reference_id = ${flipped}`);
    await post("inquiry.approved", "evt_flip_approved", flipped, "inq_declined");
    expect(await statusOf(flipped)).toBe("declined");
    const events = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_events WHERE reference_id = ${referenceId}`);
    expect(Number((events.rows[0] as { n: number }).n)).toBe(3);
    const other = await post("inquiry.declined", "evt_other_provider", referenceId, "inq_final");
    expect(other.statusCode).toBe(200);
    await handle.db.execute(sql`
      UPDATE idv_inquiries SET provider = 'other' WHERE reference_id = ${referenceId}
    `);
    await post("inquiry.started", "evt_final_started", referenceId, "inq_final");
    const moved = await handle.db.execute(sql`
      SELECT status FROM idv_inquiries WHERE provider = 'other' AND reference_id = ${referenceId}
    `);
    expect((moved.rows[0] as { status: string }).status).toBe("approved");
  });
});
