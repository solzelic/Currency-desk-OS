import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { mintCdId } from "../src/enquiries/cd-id.js";
import { confirmDesk, openFromSetupIntent, SERVICE_AGREEMENT_SOURCE_HASH, type SignupStripe } from "../src/onboarding/signup-open.js";

let handle: DbHandle, app: FastifyInstance;
const intents = new Map<string, { id: string; customer: string; metadata: Record<string, string>; client_secret: string }>();
const stripe: SignupStripe = {
  customers: { create: async () => ({ id: `cus_${randomUUID()}` }) },
  setupIntents: { create: async (p, key) => {
    let intent = intents.get(key.idempotencyKey);
    if (!intent) { const id = `seti_${randomUUID()}`; intent = { id, customer: p.customer, metadata: p.metadata, client_secret: `${id}_secret_synthetic` }; intents.set(key.idempotencyKey, intent); }
    return intent;
  } },
};
const choice = { plan: "full", term: "monthly", extras: { brief: false, call: false, website: false, setupWeek: false } };
beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb(); app = Fastify(); await app.register(cookie);
  registerSignupDeskRoutes(app, handle.db, createIdDoor({ db: handle.db, logRefusal: () => {} }), { stripe: () => stripe });
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
async function ready() {
  const id = randomUUID(), cdId = mintCdId("Assent"), token = randomBytes(32).toString("base64url");
  await handle.db.insert(schema.enquiries).values({ id, reference: id, cdId, kind: "early_access", status: "invited", email: `${id}@example.test`, name: "Synthetic Owner", details: { jurisdiction: "CA" } });
  await loadAccount(handle.db, id);
  await handle.db.update(schema.signupAccounts).set({ state: "verified", pinHash: "synthetic-test-hash", emailVerifiedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, id));
  await handle.db.insert(schema.signupCredentials).values({ id: randomUUID(), enquiryId: id, kind: "password", passwordHash: "synthetic-test-hash", attemptHash: "synthetic", verifiedAt: new Date() });
  await handle.db.insert(schema.enrolmentSessions).values({ enquiryId: id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60000) });
  await handle.db.insert(schema.onboarding).values({ enquiryId: id, answers: { operatingName: `Assent ${id}`, bizName: "Synthetic Inc.", street: "1 Test", city: "Toronto", region: "ON", postal: "M1A 1A1", complianceMode: "me", currencies: ["CAD"], idOver: "0", team: [] } });
  expect(await confirmDesk(handle.db, id, "Synthetic Owner")).toBe(true);
  const base = `/api/onboarding/${cdId}`;
  const post = (suffix: string, payload: unknown, authenticated = true) => app.inject({ method: "POST", url: base + suffix, payload: payload as object, cookies: authenticated ? { cd_enrol: token } : {} });
  const records = () => handle.db.select().from(schema.signupAgreements).where(and(eq(schema.signupAgreements.enquiryId, id), eq(schema.signupAgreements.kind, "plan")));
  return { id, post, records };
}
function succeeded(id: string) {
  const intent = [...intents.values()].find(v => v.id === id);
  if (!intent) throw new Error("test intent missing");
  return { ...intent, status: "succeeded", paymentMethod: "pm_synthetic" };
}
describe("card preparation is not service agreement assent", () => {
  it("cannot activate or insert acceptance until Open explicitly binds the displayed terms to the intent", async () => {
    const r = await ready();
    const prepare = await r.post("/payment", choice);
    expect(prepare.statusCode, prepare.body).toBe(200);
    expect(await r.records()).toHaveLength(0);
    const { setupIntentId, termsSourceHash } = prepare.json();
    expect(termsSourceHash).toBe(SERVICE_AGREEMENT_SOURCE_HASH);
    expect(await openFromSetupIntent(handle.db, succeeded(setupIntentId))).toEqual({ opened: false, reason: "not_confirmed" });
    const assent = { setupIntentId, termsSourceHash, agreed: true };
    expect((await r.post("/agreement", assent, false)).statusCode).toBe(401);
    expect((await r.post("/agreement", { ...assent, agreed: false })).statusCode).toBe(400);
    expect((await r.post("/agreement", { ...assent, termsSourceHash: "0".repeat(64) })).statusCode).toBe(400);
    expect(await r.records()).toHaveLength(0);
    expect((await r.post("/agreement", assent)).statusCode).toBe(200);
    expect((await r.post("/agreement", assent)).statusCode).toBe(200);
    const evidence = await r.records();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.record).toMatchObject({ agreed: true, setupIntentId, termsSourceHash, selected: { plan: "full", term: "monthly", locations: 1 } });
    expect((await openFromSetupIntent(handle.db, succeeded(setupIntentId))).opened).toBe(true);
  });
  it("rejects an old intent after choices change, and never carries assent into the new choice", async () => {
    const r = await ready();
    const first = await r.post("/payment", choice);
    expect(first.statusCode, first.body).toBe(200);
    const initial = first.json();
    expect((await r.post("/agreement", { setupIntentId: initial.setupIntentId, termsSourceHash: initial.termsSourceHash, agreed: true })).statusCode).toBe(200);
    const second = await r.post("/payment", { ...choice, term: "annual" });
    expect(second.statusCode).toBe(200);
    expect(second.json().setupIntentId).not.toBe(initial.setupIntentId);
    expect((await r.post("/agreement", { setupIntentId: initial.setupIntentId, termsSourceHash: initial.termsSourceHash, agreed: true })).statusCode).toBe(409);
    expect(await openFromSetupIntent(handle.db, succeeded(second.json().setupIntentId))).toEqual({ opened: false, reason: "not_confirmed" });
    expect(await r.records()).toHaveLength(1);
  });
  it("keeps the legacy explicit /plan agreement contract strict", async () => {
    const r = await ready();
    expect((await r.post("/plan", choice)).statusCode).toBe(400);
    expect((await r.post("/plan", { ...choice, agreed: false })).statusCode).toBe(400);
    expect((await r.post("/plan", { ...choice, agreed: true })).statusCode).toBe(200);
    expect(await r.records()).toHaveLength(1);
  });
});
