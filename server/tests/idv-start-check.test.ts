/* Sandbox start-check. The provider is stubbed. No live keys and no network. */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { reserveIdvCredit } from "../src/idv/credit.js";
import { PERSONA_API_BASE_DEFAULT, createPersonaProvider } from "../src/idv/providers/persona/index.js";
import { insertIdvInquiry } from "../src/idv/store.js";

const SECRET = "fixture-webhook-secret";
const ENV = { PERSONA_API_KEY: "fixture-api-key", PERSONA_TEMPLATE_ID: "itmpl_fixture" };
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
  calls += 1;
  attempt += 1;
  const body = String(init?.body ?? "");
  const referenceId = (JSON.parse(body) as { data: { attributes: { "reference-id": string } } }).data.attributes["reference-id"];
  expect(String(input)).toBe(`${PERSONA_API_BASE_DEFAULT}/inquiries`);
  expect(body).not.toContain(DEMO.legalEntityId);
  expect(body).not.toContain("secret@example.com");
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
  INSERT INTO idv_shop_config (shop_id, provider, checks_enabled) VALUES (${shopId}, 'persona', ${checksEnabled})
  ON CONFLICT (shop_id) DO UPDATE SET checks_enabled = ${checksEnabled}
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
  await handle.db.insert(schema.branches).values({ id: B.branchId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, name: "Shop B counter" });
  await handle.db.insert(schema.staffUsers).values({
    id: B.userId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, branchId: B.branchId,
    staffId: B.staffId, name: "B Owner", role: "administrator", authorizedBranchIds: [B.branchId], passwordHash: owner[0]!.passwordHash,
  });
  const opts = { persona, fetch: fetchStub, sleep: async (ms: number) => { sleeps.push(ms); } };
  app = await buildApp(handle.db, {}, undefined, { ...opts, env: ENV });
  bare = await buildApp(handle.db, {}, undefined, { ...opts, env: {} });
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
});
