import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { mintCdId } from "../src/enquiries/cd-id.js";
import { SAM_CONSENT_TEXT } from "../src/enquiries/sam.js";
let handle: DbHandle, app: FastifyInstance;
beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; handle = await createDb(); app = Fastify(); await app.register(cookie);
  registerSignupDeskRoutes(app, handle.db, createIdDoor({ db: handle.db, logRefusal: () => {} }), { stripe: () => null });
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
async function reservation() {
  const id = randomUUID(), cdId = mintCdId("Consent"), token = randomBytes(32).toString("base64url");
  const accountId = randomUUID();
  await handle.db.insert(schema.enquiries).values({ id, reference: id, cdId, kind: "early_access", status: "invited", email: `${id}@example.test`, details: { jurisdiction: "CA", phone: "+14165550123" } });
  await loadAccount(handle.db, id);
  await handle.db.update(schema.signupAccounts).set({ state: "verified", accountId }).where(eq(schema.signupAccounts.enquiryId, id));
  await handle.db.insert(schema.enrolmentSessions).values({ enquiryId: id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60000) });
  const base = `/api/onboarding/${cdId}`;
  const post = (payload: object, authenticated = true) => app.inject({ method: "POST", url: base + "/preferences", payload, cookies: authenticated ? { cd_enrol: token } : {}, headers: { "user-agent": "synthetic-consent-test" } });
  const resume = () => app.inject({ method: "GET", url: base + "/resume", cookies: { cd_enrol: token } });
  const rows = () => handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, id)).orderBy(asc(schema.enquiryCallConsents.at));
  const accept = async () => { const p = (await resume()).json().callPreference; return { call: true, version: p.version, target: p.target }; };
  return { id, accountId, post, resume, rows, accept };
}
it("does not infer consent from a missing answer or create evidence when merely resuming", async () => {
  const r = await reservation(); const result = await r.resume();
  expect(result.statusCode).toBe(200);
  expect(result.json().callPreference).toMatchObject({ call: false, canCall: true, text: SAM_CONSENT_TEXT, version: sha256(SAM_CONSENT_TEXT) });
  expect(JSON.stringify(result.json().callPreference)).not.toContain("+14165550123");
  expect(await r.rows()).toHaveLength(0);
});
it("requires this reservation's enrolment session and refuses stale displayed terms or phone targets", async () => {
  const r = await reservation();
  expect((await r.post({ call: false }, false)).statusCode).toBe(401);
  expect((await r.post({ call: true })).statusCode).toBe(400);
  const choice = await r.accept();
  expect((await r.post({ ...choice, version: "0".repeat(64) })).statusCode).toBe(409);
  await handle.db.update(schema.enquiries).set({ details: { phone: "+14165550124" } }).where(eq(schema.enquiries.id, r.id));
  expect((await r.post(choice)).statusCode).toBe(409);
  expect(await r.rows()).toHaveLength(0);
});
it("records attributable opt-in, idempotent retries, an immediate stop, and fresh reconsent", async () => {
  const r = await reservation(), choice = await r.accept();
  expect((await r.post(choice)).statusCode).toBe(200);
  expect((await r.post(choice)).statusCode).toBe(200);
  await handle.db.update(schema.enquiries).set({ samCallAt: new Date(Date.now() + 60000) }).where(eq(schema.enquiries.id, r.id));
  expect((await r.post({ call: false })).statusCode).toBe(200);
  expect((await r.post({ call: false })).statusCode).toBe(200);
  const enquiry = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, r.id)))[0];
  expect(enquiry?.samCallAt).toBeNull();
  expect((await r.resume()).json().callPreference.call).toBe(false);
  expect((await r.post(choice)).statusCode).toBe(200);
  const rows = await r.rows();
  expect(rows.map(x => x.event)).toEqual(["consent", "stop", "consent"]);
  expect(rows[0]).toMatchObject({ phone: "+14165550123", consentText: SAM_CONSENT_TEXT, userAgent: "synthetic-consent-test", ipAddress: "127.0.0.1" });
  const times = rows.map(r => r.at.getTime());
  expect(new Set(times).size).toBe(3); expect(times).toEqual([...times].sort((a, b) => a - b));
  const audit = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "sam.consent_given"));
  const evidence = audit.filter(a => a.detail?.enquiryId === r.id);
  expect(evidence).toHaveLength(2);
  expect(evidence[0]?.detail).toMatchObject({ accountId: r.accountId, evidenceId: rows[0]?.id, consentVersion: sha256(SAM_CONSENT_TEXT) });
  expect(JSON.stringify(evidence)).not.toContain("+14165550123");
  expect((await r.resume()).json().callPreference.call).toBe(true);
});
it("preserves an existing exact Early Access consent but requires reconsent if its wording changed", async () => {
  const r = await reservation();
  await handle.db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: r.id, event: "consent", phone: "+14165550123", consentText: SAM_CONSENT_TEXT, at: new Date(Date.now() - 1000) });
  expect((await r.resume()).json().callPreference.call).toBe(true);
  await handle.db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: r.id, event: "consent", phone: "+14165550123", consentText: "An older different purpose" });
  expect((await r.resume()).json().callPreference.call).toBe(false);
});
it("does not re-enable a do-not-contact reservation", async () => {
  const r = await reservation(), choice = await r.accept();
  await handle.db.update(schema.enquiries).set({ doNotContact: true }).where(eq(schema.enquiries.id, r.id));
  expect((await r.post(choice)).statusCode).toBe(409);
  expect((await r.resume()).json().callPreference).toMatchObject({ call: false, canCall: false });
});
it("serializes concurrent retries into one consent event", async () => {
  const r = await reservation(), choice = await r.accept();
  const replies = await Promise.all(Array.from({ length: 6 }, () => r.post(choice)));
  expect(replies.map(r => r.statusCode)).toEqual(Array(6).fill(200));
  expect(await r.rows()).toHaveLength(1);
});
