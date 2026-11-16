/* Sign-up v2.1, PR 1: the CurrencyDesk ID is the identifier (SIGNUP-LOGIC
   §2.1, §2.2, §7; build doc §6 "The ID", §9.1 to §9.3, §9.8).

   What is being proved:
   - a typed ID, in any case, with or without hyphens and spaces, finds
     the reservation and gives back the shop's name and nothing else;
   - unknown IDs 404, and 10 misses in 15 minutes close that connection,
     and that ID, for 15 minutes (429), counted separately;
   - "Send it again" is 202 whatever the email, sends the same ID only to
     the email on file, and stops at 3 per email and 10 per connection an
     hour;
   - support's reissue mints a new ID and the old one 404s at once;
   - nothing logged carries a whole ID or a whole email. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { reissueSignupId } from "../src/onboarding/reissue-id.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { issueCdId, CD_ID_ALPHABET } from "../src/enquiries/cd-id.js";
import { loadAccount, saveCredential } from "../src/onboarding/signup-account.js";
import { hashCode } from "../src/email.js";
import { seed } from "../src/seed.js";
import { buildApp, maskCdIds } from "../src/app.js";
import { resetEnquiryThrottle } from "../src/routes/enquiries.js";
import { resetIdDoor } from "../src/routes/onboarding-public.js";
import { LOCK_MS, Throttle, createIdDoor, emailHash, idTail, type Refusal } from "../src/onboarding/cd-id-door.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
const ADMIN = "j.masri";

const v21 = (email: string, over: Record<string, unknown> = {}) => ({
  kind: "early_access",
  form: "early-access-v2.1",
  email,
  name: "Daniel Okafor",
  details: {
    firstName: "Daniel", lastName: "Okafor", shopName: "York Currency Exchange",
    workspace: "york-currency-exchange.currencydeskos.com", website: "none yet", mode: "early_access",
    jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "Yes", msbNumber: "m 1234-5678", waitlist: false, waitlistReason: null,
    role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
    runningOn: "Excel or Google Sheets", timeline: "This month",
    phone: "+1 4165550148", bestTime: "no call", samConsent: null,
    ...over,
  },
  contactContext: { timezone: "America/Toronto" },
});

async function apply(email: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/enquiries", payload: v21(email, over), remoteAddress: "203.0.113.20" });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { reference: string; cdId: string | null };
}
const stateOf = (id: string, ip = "198.51.100.7") =>
  app.inject({ method: "GET", url: `/api/onboarding/${encodeURIComponent(id)}/state`, remoteAddress: ip });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = login.cookies.find((x) => x.name === "cdos_session");
  adminCookie = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => { resetEnquiryThrottle(); resetIdDoor(); });

describe("typing the ID", () => {
  it("finds the reservation however it is typed, and says only the shop's name", async () => {
    const { cdId } = await apply("owner.one@yorkfx.test");
    expect(cdId).toMatch(/^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const id = cdId!;
    const compact = id.replace(/-/g, "");
    for (const typed of [id, id.toLowerCase(), compact.toLowerCase(), `cd ${id.slice(3, 7).toLowerCase()} ${id.slice(8)}`]) {
      const res = await stateOf(typed);
      expect(res.statusCode, typed).toBe(200);
      expect(res.json()).toEqual({ valid: true, operatingName: "York Currency Exchange", state: "reserved" });
    }
    /* nothing personal before the email code: no email, name, mobile or country */
    const body = (await stateOf(id)).body;
    for (const secret of ["owner.one", "Daniel", "Okafor", "4165550148", "Canada", "ON"]) expect(body).not.toContain(secret);
  });

  it("is a 404 for an ID nobody holds, and for a waitlisted or declined application", async () => {
    expect((await stateOf("CD-ZZZZ-2222")).statusCode).toBe(404);
    expect((await stateOf("CD-ZZZZ-2222")).json()).toEqual({ error: "no_such_id" });
    const { cdId, reference } = await apply("declined.one@yorkfx.test");
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;
    await handle.db.update(schema.enquiries).set({ status: "declined" }).where(eq(schema.enquiries.id, row.id));
    expect((await stateOf(cdId!)).statusCode).toBe(404);
  });

  it("says the desk is already open once the application has become a desk", async () => {
    const { cdId, reference } = await apply("open.one@yorkfx.test");
    await handle.db.update(schema.enquiries).set({ status: "accepted" }).where(eq(schema.enquiries.reference, reference));
    expect((await stateOf(cdId!)).json()).toEqual({ valid: true, operatingName: "York Currency Exchange", state: "active" });
  });

  it("leaves the older setup reference path as it was", async () => {
    const { reference } = await apply("legacy.one@yorkfx.test");
    const res = await stateOf(reference);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("application");
  });
});

describe("misses", () => {
  it("closes a connection for 15 minutes after 10 misses, with a 429 distinct from a 404", async () => {
    const ip = "198.51.100.50";
    for (let i = 0; i < 9; i++) expect((await stateOf(`CD-MISS-${"23456789A"[i]}222`, ip)).statusCode).toBe(404);
    expect((await stateOf("CD-MISS-B222", ip)).statusCode).toBe(404);
    const { cdId } = await apply("locked.conn@yorkfx.test");
    const locked = await stateOf(cdId!, ip);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: "slow_down" });
    /* another connection is unaffected */
    expect((await stateOf(cdId!, "198.51.100.51")).statusCode).toBe(200);
  });

  it("counts per ID too: one ID tried from 10 connections is closed on the 11th", async () => {
    for (let i = 0; i < 10; i++) expect((await stateOf("CD-PERI-D222", `192.0.2.${10 + i}`)).statusCode).toBe(404);
    expect((await stateOf("CD-PERI-D222", "192.0.2.99")).statusCode).toBe(429);
  });

  it("opens again after the 15-minute cool-off", async () => {
    let now = 1_000_000;
    const door = createIdDoor({ db: handle.db, now: () => now, logRefusal: () => {} });
    for (let i = 0; i < 10; i++) await door.state("CD-COOL-2222", "10.0.0.1");
    expect((await door.state("CD-COOL-2222", "10.0.0.1")).status).toBe(429);
    now += LOCK_MS - 1;
    expect((await door.state("CD-COOL-2222", "10.0.0.1")).status).toBe(429);
    now += 2;
    expect((await door.state("CD-COOL-2222", "10.0.0.1")).status).toBe(404);
  });

  it("logs each refusal with a reason code and the ID's last four characters only", async () => {
    const refusals: Refusal[] = [];
    const door = createIdDoor({ db: handle.db, logRefusal: (r) => refusals.push(r) });
    for (let i = 0; i < 11; i++) await door.state("CD-LOGS-7K42", "10.0.0.2");
    expect(refusals.map((r) => r.reason)).toEqual([...Array(9).fill("id_unknown"), "id_miss_lock", "id_locked"]);
    for (const r of refusals) {
      expect(r.id).toBe("…7K42");
      expect(JSON.stringify(r)).not.toContain("CD-LOGS");
    }
  });
});

describe("Can't find your ID? Send it again", () => {
  it("is 202 whatever the email, and refuses only a malformed one", async () => {
    for (const email of ["nobody@nowhere.test", "owner.two@yorkfx.test"]) {
      const res = await app.inject({ method: "POST", url: "/api/onboarding/resend-id", payload: { email } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
    }
    expect((await app.inject({ method: "POST", url: "/api/onboarding/resend-id", payload: { email: "not an email" } })).statusCode).toBe(400);
  });

  it("sends the same ID, only to the email on file, and logs it hashed", async () => {
    const { cdId } = await apply("Owner.Three@YorkFX.test");
    const sent: { to: string; text: string }[] = [];
    const door = createIdDoor({ db: handle.db, send: async (to, m) => { sent.push({ to, text: m.text }); return "simulated"; }, logRefusal: () => {} });
    await door.resend("owner.three@yorkfx.test", "10.0.1.1", "https://example.test/onboarding");
    await door.resend("stranger@yorkfx.test", "10.0.1.1", "https://example.test/onboarding");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe("owner.three@yorkfx.test");
    expect(sent[0]!.text).toContain(cdId!);
    expect(sent[0]!.text).not.toMatch(/token|\?t=/i);
    const logged = (await handle.db.select().from(schema.auditEvents)).filter((e) => e.action === "cd_id.resent");
    const mine = logged.find((e) => (e.detail as Record<string, unknown>).email === emailHash("owner.three@yorkfx.test"))!;
    expect(mine.detail).toMatchObject({ id: idTail(cdId!), delivery: "simulated" });
    expect(JSON.stringify(mine.detail)).not.toContain(cdId!);
    expect(JSON.stringify(mine.detail)).not.toContain("owner.three");
  });

  it("stops at 3 per email and 10 per connection an hour", async () => {
    await apply("owner.four@yorkfx.test");
    let count = 0;
    const door = createIdDoor({ db: handle.db, send: async () => { count++; return "simulated"; }, logRefusal: () => {} });
    for (let i = 0; i < 5; i++) await door.resend("owner.four@yorkfx.test", `10.0.2.${i}`, "u");
    expect(count).toBe(3);
    count = 0;
    for (let i = 0; i < 12; i++) await door.resend(`someone${i}@nowhere.test`, "10.0.3.1", "u");
    await door.resend("owner.four@yorkfx.test", "10.0.3.1", "u");
    expect(count).toBe(0);
  });
});

describe("support reissues an ID", () => {
  it("mints a new ID; the old one stops working at once and both are logged as last four", async () => {
    const { cdId: old, reference } = await apply("owner.five@yorkfx.test");
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;
    expect((await stateOf(old!)).statusCode).toBe(200);
    await loadAccount(handle.db, row.id);
    await saveCredential(handle.db, row.id, { kind: "password", attemptHash: "stale-browser", passwordHash: "synthetic" });
    await handle.db.update(schema.signupAccounts).set({ codeHash: hashCode("123456") }).where(eq(schema.signupAccounts.enquiryId, row.id));
    await handle.db.insert(schema.signupChallenges).values({ id: "stale-challenge", enquiryId: row.id, purpose: "passkey", challenge: "stale", attemptHash: "stale-browser", expiresAt: new Date(Date.now() + 60000) });
    const res = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/reissue-cd-id`, cookies: adminCookie });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(old!);
    const fresh = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, row.id)))[0]!.cdId!;
    expect(fresh).not.toBe(old);
    const oldBytes = [...old!.slice(-4)].map(c => CD_ID_ALPHABET.indexOf(c));
    await expect(issueCdId(handle.db, "York", count => Uint8Array.from({ length: count }, (_, i) => oldBytes[i % 4]!))).rejects.toThrow("No free CurrencyDesk ID");
    expect(await saveCredential(handle.db, row.id, { kind: "password", attemptHash: "late-save", passwordHash: "synthetic" }, old!)).toBeNull();
    expect((await loadAccount(handle.db, row.id)).codeHash).toBeNull();
    expect(await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, row.id))).toHaveLength(0);
    expect(await handle.db.select().from(schema.signupChallenges).where(eq(schema.signupChallenges.enquiryId, row.id))).toHaveLength(0);
    expect(fresh.slice(0, 7)).toBe("CD-YORK");
    expect((await stateOf(old!)).statusCode).toBe(404);
    expect((await stateOf(fresh)).statusCode).toBe(200);
    const event = (await handle.db.select().from(schema.auditEvents)).find((e) => e.action === "cd_id.reissued" && (e.detail as Record<string, unknown>).enquiryId === row.id)!;
    expect(event.detail).toMatchObject({ was: idTail(old!), now: idTail(fresh) });
    expect(JSON.stringify(event.detail)).not.toContain(old!);
  });

  it("is refused without a platform session", async () => {
    const { reference } = await apply("owner.six@yorkfx.test");
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;
    const res = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/reissue-cd-id` });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("logs", () => {
  it("keep a CurrencyDesk ID's last four characters, however it was typed in the path", () => {
    expect(maskCdIds("/api/onboarding/CD-YORK-7K42/state")).toBe("/api/onboarding/CD-…7K42/state");
    expect(maskCdIds("/api/onboarding/cdyork7k42/state")).toBe("/api/onboarding/CD-…7k42/state");
    expect(maskCdIds("/api/onboarding/cd%20york%207k42/state")).toBe("/api/onboarding/CD-…7k42/state");
    expect(maskCdIds("/api/onboarding/CD-A3V5ZE/state")).toBe("/api/onboarding/CD-A3V5ZE/state");
  });

  it("a throttle counts inside its window and forgets outside it", () => {
    let now = 0;
    const t = new Throttle(3, 1000, 0, () => now);
    expect([t.take("k"), t.take("k"), t.take("k"), t.take("k")]).toEqual([true, true, true, false]);
    now = 1001;
    expect(t.take("k")).toBe(true);
  });
});

/* A throttle remembers 10,000 keys. Filling it must never refuse, or stop
   counting, a key it has not seen: that let one crowd lock everyone out. */
describe("a full throttle", () => {
  const fill = (t: Throttle, count: (key: string) => unknown) => { for (let i = 0; i <= 10_000; i++) count(`k${i}`); };

  it("forgets the key it saw longest ago, and still gives a new key its room", () => {
    const t = new Throttle(1, 60_000, 0, () => 0);
    fill(t, (k) => t.take(k));
    expect(t.take("fresh")).toBe(true);
    expect(t.take("fresh")).toBe(false);
    expect(t.take("k10000")).toBe(false);
    expect(t.take("k0")).toBe(true);
  });

  it("still counts a new key's misses and locks it at the limit", () => {
    const t = new Throttle(3, 60_000, 60_000, () => 0);
    fill(t, (k) => t.hit(k));
    expect([t.hit("guess"), t.hit("guess"), t.hit("guess")]).toEqual([false, false, true]);
    expect(t.locked("guess")).toBe(true);
  });

  it("keeps the lock on a key that keeps knocking while the crowd passes", () => {
    const t = new Throttle(1, 60_000, 60_000, () => 0);
    t.hit("guess");
    fill(t, (k) => { t.hit(k); t.locked("guess"); });
    expect(t.locked("guess")).toBe(true);
  });
});


describe("issuance shares the returning-login namespace", () => {
  const fixed = (char: string) => (count: number) => new Uint8Array(count).fill(CD_ID_ALPHABET.indexOf(char));
  async function legacyUsername(staffId: string) {
    const template = (await handle.db.select().from(schema.staffUsers).limit(1))[0]!;
    const id = `issuance-${staffId}`;
    await handle.db.insert(schema.staffUsers).values({ ...template, id, staffId, cdId: null, active: false });
    return id;
  }
  it.each(["CD-NAME-2222", "cd-name-2222", "Cd-NaMe-2222"])("refuses an existing username %s, including inactive staff", async (staffId) => {
    const id = await legacyUsername(staffId);
    try { await expect(issueCdId(handle.db, "Name", fixed("2"))).rejects.toThrow("No free CurrencyDesk ID"); }
    finally { await handle.db.delete(schema.staffUsers).where(eq(schema.staffUsers.id, id)); }
  });
  it("retries a collision instead of discarding a free next candidate", async () => {
    const id = await legacyUsername("cd-next-2222");
    let attempt = 0;
    try { expect(await issueCdId(handle.db, "Next", count => fixed(attempt++ ? "3" : "2")(count))).toBe("CD-NEXT-3333"); }
    finally { await handle.db.delete(schema.staffUsers).where(eq(schema.staffUsers.id, id)); }
  });
  it("support reissue applies the same exclusion and preserves the old ID on exhaustion", async () => {
    const { reference, cdId } = await apply("collision.reissue@example.test", { shopName: "Reissue" });
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;
    const id = await legacyUsername("cd-reis-2222");
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(array => {
      (array as Uint8Array).fill(0); return array;
    });
    try {
      await expect(reissueSignupId(handle.db, row.id, "synthetic-reviewer")).rejects.toThrow("No free CurrencyDesk ID");
      expect((await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, row.id)))[0]!.cdId).toBe(cdId);
    } finally { random.mockRestore(); await handle.db.delete(schema.staffUsers).where(eq(schema.staffUsers.id, id)); }
  });
});
