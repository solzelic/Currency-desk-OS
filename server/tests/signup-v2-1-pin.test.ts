/* Sign-up v2.1, PR 4: the counter PIN (SIGNUP-LOGIC §3.3; build doc §6, §10).
   Refused on the server: four of the same and 1234. Other weak PINs pass
   with the strength label. Only on this reservation's enrolment session. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { checkPin, pinStrength } from "../src/onboarding/signup-pin.js";
import { verifyPassword } from "../src/auth/password.js";

let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
let n = 0;

/* A reservation whose email code has passed: verified, with a session. */
async function enrolled(state: "verified" | "enrolling" = "verified") {
  n++;
  const id = `enq-${randomUUID()}`;
  const A = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const cdId = `CD-PINS-${A[n % 31]}${A[(n * 3) % 31]}${A[(n * 5) % 31]}${A[(n * 7) % 31]}`;
  await handle.db.insert(schema.enquiries).values({ id, reference: `CD-P${String(n).padStart(5, "0")}`, kind: "early_access", email: `pin${n}@yorkfx.test`, status: "invited", cdId, details: { shopName: "Harbour Exchange" } });
  await loadAccount(handle.db, id);
  await handle.db.update(schema.signupAccounts).set({ state }).where(eq(schema.signupAccounts.enquiryId, id));
  const token = randomBytes(32).toString("base64url");
  await handle.db.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId: id, expiresAt: new Date(Date.now() + 60_000) });
  return { id, cdId, session: { cd_enrol: token } };
}
const pin = (cdId: string, body: unknown, cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: `/api/onboarding/${cdId}/pin`, payload: body as object, cookies });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handle = await createDb();
  app = Fastify();
  await app.register(cookie);
  door = createIdDoor({ db: handle.db, logRefusal: () => {} });
  registerSignupDeskRoutes(app, handle.db, door);
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => door.reset());

describe("the rule", () => {
  it("refuses four of the same and 1234, and labels the rest", () => {
    for (const p of ["0000", "1111", "9999"]) expect(checkPin(p, p)).toMatchObject({ ok: false, reason: "repeat" });
    expect(checkPin("1234", "1234")).toEqual({ ok: false, reason: "one_two_three_four", detail: "Not that one. 1234 is the first thing anyone tries." });
    expect(checkPin("12a4", "12a4")).toMatchObject({ ok: false, reason: "not_four_digits" });
    expect(checkPin("4821", "4812")).toMatchObject({ ok: false, reason: "mismatch" });
    expect(checkPin("4567", "4567")).toEqual({ ok: true, strength: "easy" });
    expect(checkPin("1999", "1999")).toEqual({ ok: true, strength: "easy" });
    expect(pinStrength("1212")).toBe("okay");
    expect(pinStrength("4821")).toBe("strong");
  });
});

describe("POST /pin", () => {
  it("saves a hash for a verified owner, never the PIN", async () => {
    const r = await enrolled();
    const res = await pin(r.cdId, { pin: "4821", confirm: "4821" }, r.session);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, strength: "strong" });
    const account = await loadAccount(handle.db, r.id);
    expect(account.pinHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword("4821", account.pinHash!)).toBe(true);
    expect(account.pinSetAt).not.toBeNull();
  });

  it("refuses 1111 and 1234 with 422 and saves nothing", async () => {
    const r = await enrolled();
    for (const p of ["1111", "1234"]) {
      const res = await pin(r.cdId, { pin: p, confirm: p }, r.session);
      expect(res.statusCode).toBe(422);
    }
    expect((await loadAccount(handle.db, r.id)).pinHash).toBeNull();
  });

  it("needs this reservation's enrolment session (401 otherwise) and a verified account", async () => {
    const a = await enrolled();
    const b = await enrolled();
    expect((await pin(a.cdId, { pin: "4821", confirm: "4821" }, {})).statusCode).toBe(401);
    expect((await pin(a.cdId, { pin: "4821", confirm: "4821" }, b.session)).statusCode).toBe(401);
    const early = await enrolled("enrolling");
    expect((await pin(early.cdId, { pin: "4821", confirm: "4821" }, early.session)).statusCode).toBe(409);
  });
});
