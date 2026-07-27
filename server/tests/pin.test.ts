/* Staff PINs. The desk used to hold the expected PIN in the browser and
   compare it there, which made the gate decorative. The PIN lives here now,
   hashed, and only the server says whether one is right. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { generatePin } from "../src/routes/pin.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
let costaCookie: Record<string, string> = {};

const ADMIN = "j.masri";
const staffRow = (staffId: string) =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(1).then((r) => r[0]!);
const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const out: Record<string, string> = {};
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (c) out.cdos_session = c.value;
  return out;
};
const signIn = (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: "tnt-yorkfx" } });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  adminCookie = cookieOf(await signIn(ADMIN));
  costaCookie = cookieOf(await signIn("m.costa"));
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("generated PINs", () => {
  it("are never the ones people guess first", () => {
    for (let i = 0; i < 300; i++) {
      const pin = generatePin();
      expect(pin).toMatch(/^\d{4}$/);
      expect(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999"]).not.toContain(pin);
      expect(pin).not.toBe("1234");
      expect(pin).not.toBe("4321");
      expect(pin.startsWith("19")).toBe(false);   // not a birth year
      expect(pin.startsWith("20")).toBe(false);
    }
  });
});

describe("PINs are checked by the server", () => {
  it("says so plainly when nobody has set one, so the desk can cope", async () => {
    const res = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "1357" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_pin");
  });

  it("support resets it, and only the right one passes", async () => {
    const costa = await staffRow("m.costa");
    const reset = await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: adminCookie });
    expect(reset.statusCode).toBe(200);
    const pin = reset.json().pin as string;
    expect(pin).toMatch(/^\d{4}$/);

    // and it is stored hashed — a database leak must not hand over a keypad
    const row = await staffRow("m.costa");
    expect(row.pinHash).toBeTruthy();
    expect(row.pinHash).not.toContain(pin);

    const wrong = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: pin === "1357" ? "2468" : "1357" } });
    expect(wrong.statusCode).toBe(401);
    const right = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin } });
    expect(right.statusCode).toBe(200);
  });

  it("locks out after a run of wrong ones — four digits is only ten thousand guesses", async () => {
    const singh = await staffRow("a.singh");
    const pin = (await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/reset-pin`, cookies: adminCookie })).json().pin as string;
    const singhCookie = cookieOf(await signIn("a.singh"));
    const wrong = pin === "1357" ? "2468" : "1357";

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: wrong } })).statusCode);
    }
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.at(-1)).toBe(429);

    // and the right PIN is refused while locked — otherwise the lockout is theatre
    const locked = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin } });
    expect(locked.statusCode).toBe(429);

    // a reset clears the lockout, which is how support gets someone working again
    await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/reset-pin`, cookies: adminCookie });
    const after = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: wrong } });
    expect(after.statusCode).toBe(401);
  });

  it("switching accounts proves the other person's PIN, but only within your own desk", async () => {
    const haddad = await staffRow("r.haddad");
    const pin = (await app.inject({ method: "POST", url: `/api/admin/staff/${haddad.id}/reset-pin`, cookies: adminCookie })).json().pin as string;

    const asCosta = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { staffId: "r.haddad", pin } });
    expect(asCosta.statusCode).toBe(200);

    // somebody at another desk is simply not found — no probing across tenants
    const stranger = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { staffId: "nobody.here", pin } });
    expect(stranger.statusCode).toBe(404);
  });

  it("a person can set their own, and must prove the old one to change it", async () => {
    const costa = await staffRow("m.costa");
    const current = (await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: adminCookie })).json().pin as string;

    const noProof = await app.inject({ method: "POST", url: "/api/staff/pin", cookies: costaCookie, payload: { pin: "8642" } });
    expect(noProof.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url: "/api/staff/pin", cookies: costaCookie, payload: { pin: "8642", currentPin: current } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "8642" } })).statusCode).toBe(200);
  });

  it("the owner reissues a teller's PIN without ringing support", async () => {
    const tellerCookie = cookieOf(await signIn("a.singh"));
    const issued = await app.inject({ method: "POST", url: "/api/staff/a.singh/pin", cookies: adminCookie });
    expect(issued.statusCode).toBe(200);
    const pin = issued.json().pin as string;
    expect(pin).toMatch(/^\d{4}$/);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: tellerCookie, payload: { pin } })).statusCode).toBe(200);

    // a teller cannot reissue anyone's, including their own — that would make
    // the gate something you can simply walk around
    expect((await app.inject({ method: "POST", url: "/api/staff/m.costa/pin", cookies: tellerCookie })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/staff/a.singh/pin", cookies: tellerCookie })).statusCode).toBe(403);
    // and a manager may not quietly reissue their own to skip the current one
    expect((await app.inject({ method: "POST", url: `/api/staff/${ADMIN}/pin`, cookies: adminCookie })).statusCode).toBe(403);
  });

  it("takes PINs out of the desk snapshot the browser downloads", async () => {
    // a desk arriving from before PINs were held here: nothing on the records
    await handle.db.update(schema.staffUsers).set({ pinHash: null });
    const state = {
      cdos_settings: {
        deskName: "Desk 1",
        employees: [
          { id: "e1", name: "Maria Costa", code: "m.costa", pin: "4913", requirePin: true },
          { id: "e2", name: "Rana Haddad", code: "r.haddad", pin: "0000", requirePin: true },
        ],
      },
    };
    const put = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: costaCookie, payload: { state } as Record<string, unknown> });
    expect(put.statusCode).toBe(200);

    // nothing that came back down carries a PIN
    const back = (await app.inject({ method: "GET", url: "/api/tenant/state", cookies: costaCookie })).json();
    const saved = back.state.cdos_settings.employees as Record<string, unknown>[];
    expect(saved.every((e) => !("pin" in e))).toBe(true);
    expect(JSON.stringify(back)).not.toContain("4913");

    // the chosen one moved to the staff record and now works
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "4913" } })).statusCode).toBe(200);
    // but the placeholder everyone ships with was dropped, not adopted, so the
    // panel keeps saying "no PIN" — which is the truth
    const haddad = await staffRow("r.haddad");
    await handle.db.update(schema.staffUsers).set({ pinHash: null }).where(eq(schema.staffUsers.id, haddad.id));
    await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: costaCookie, payload: { state } as Record<string, unknown> });
    expect((await staffRow("r.haddad")).pinHash).toBeFalsy();
  });

  it("a stale snapshot cannot roll a PIN back to an old one", async () => {
    const singh = await staffRow("a.singh");
    const current = (await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/reset-pin`, cookies: adminCookie })).json().pin as string;
    const stale = { cdos_settings: { employees: [{ id: "e3", name: "Amrit Singh", code: "a.singh", pin: "7391" }] } };
    await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: costaCookie, payload: { state: stale } as Record<string, unknown> });

    const singhCookie = cookieOf(await signIn("a.singh"));
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: "7391" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: current } })).statusCode).toBe(200);
  });

  it("tells you whether you have one, and never what it is", async () => {
    const mine = await app.inject({ method: "GET", url: "/api/staff/pin", cookies: costaCookie });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().hasPin).toBe(true);
    // whether, and when — never the code itself, nor its hash
    expect(Object.keys(mine.json()).sort()).toEqual(["hasPin", "setAt"]);
    expect((await app.inject({ method: "GET", url: "/api/staff/pin" })).statusCode).toBe(401);
  });

  it("support sees a shut keypad, but the panel never carries the PIN itself", async () => {
    const haddad = await staffRow("r.haddad");
    const pin = (await app.inject({ method: "POST", url: `/api/admin/staff/${haddad.id}/reset-pin`, cookies: adminCookie })).json().pin as string;
    const haddadCookie = cookieOf(await signIn("r.haddad"));
    const wrong = pin === "1357" ? "2468" : "1357";
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: haddadCookie, payload: { pin: wrong } });
    }
    const page = await app.inject({ method: "GET", url: `/api/admin/staff/${haddad.id}`, cookies: adminCookie });
    expect(page.json().person.hasPin).toBe(true);
    expect(page.json().person.pinLockedUntil).toBeTruthy();
    expect(page.body).not.toContain(pin);
  });

  it("refuses anything that is not four digits, and anyone without a session", async () => {
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "86420" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "abcd" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", payload: { pin: "8642" } })).statusCode).toBe(401);
    const costa = await staffRow("m.costa");
    expect((await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: costaCookie })).statusCode).toBe(403);
  });
});
