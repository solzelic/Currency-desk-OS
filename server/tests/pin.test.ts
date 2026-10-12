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
    expect(Object.keys(mine.json()).sort()).toEqual(["hasPin", "mustChange", "setAt"]);
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

  it("you can get back in on your own, with the password the owner doesn't have", async () => {
    const costa = await staffRow("m.costa");
    await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: adminCookie });

    // a wrong password is not a way in
    const wrongPw = await app.inject({ method: "POST", url: "/api/staff/pin/reset", cookies: costaCookie, payload: { password: "not-it", pin: "7412" } });
    expect(wrongPw.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "7412" } })).statusCode).toBe(401);

    // the right one is — without anybody having to be told the new PIN
    const ok = await app.inject({ method: "POST", url: "/api/staff/pin/reset", cookies: costaCookie, payload: { password: "yorkville", pin: "7412" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain("7412");
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "7412" } })).statusCode).toBe(200);
  });

  it("a PIN somebody else issued is marked temporary until its owner picks their own", async () => {
    const singh = await staffRow("a.singh");
    const issued = (await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/reset-pin`, cookies: adminCookie })).json().pin as string;
    const singhCookie = cookieOf(await signIn("a.singh"));

    // support read it out, so support knows it — the desk must be able to say so
    expect((await staffRow("a.singh")).pinMustChange).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/staff/pin", cookies: singhCookie })).json().mustChange).toBe(true);
    // the gate still opens — nobody is stranded mid-deal — but it says to fix it
    const opened = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: issued } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().mustChange).toBe(true);

    await app.inject({ method: "POST", url: "/api/staff/pin", cookies: singhCookie, payload: { pin: "6053", currentPin: issued } });
    expect((await staffRow("a.singh")).pinMustChange).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: singhCookie, payload: { pin: "6053" } })).json().mustChange).toBe(false);
  });

  it("the forgot-my-PIN door is not a quieter way to stand at the keypad", async () => {
    const haddad = await staffRow("r.haddad");
    await app.inject({ method: "POST", url: `/api/admin/staff/${haddad.id}/reset-pin`, cookies: adminCookie });
    const haddadCookie = cookieOf(await signIn("r.haddad"));

    // wrong passwords here count against the same lockout as wrong PINs
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/api/staff/pin/reset", cookies: haddadCookie, payload: { password: "guess", pin: "1470" } });
    }
    const locked = await app.inject({ method: "POST", url: "/api/staff/pin/reset", cookies: haddadCookie, payload: { password: "yorkville", pin: "1470" } });
    expect(locked.statusCode).toBe(429);
    // and the keypad it guards is shut too, not just this door
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: haddadCookie, payload: { pin: "1470" } })).statusCode).toBe(429);
  });

  it("refuses anything that is not four digits, and anyone without a session", async () => {
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "86420" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: "abcd" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/staff/pin/verify", payload: { pin: "8642" } })).statusCode).toBe(401);
    const costa = await staffRow("m.costa");
    expect((await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: costaCookie })).statusCode).toBe(403);
  });

  it("a burst of wrong guesses stops at five", async () => {
    const burst = async (staffId: string, n: number) => {
      const row = await staffRow(staffId);
      const issued = await app.inject({
        method: "POST", url: `/api/admin/staff/${row.id}/reset-pin`, cookies: adminCookie,
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const pin = issued.json().pin as string;
      const cookie = cookieOf(await signIn(staffId));
      const wrong = pin === "1111" ? "2222" : "1111";
      const replies = await Promise.all(Array.from({ length: n }, () =>
        app.inject({
          method: "POST", url: "/api/staff/pin/verify", cookies: cookie, payload: { pin: wrong },
        }),
      ));
      const codes = replies.map((res) => res.statusCode);
      expect(codes.filter((code) => code === 401), codes.join(",")).toHaveLength(5);
      expect(codes.filter((code) => code === 429)).toHaveLength(n - 5);
      const again = await app.inject({
        method: "POST", url: "/api/staff/pin/verify", cookies: cookie, payload: { pin: wrong },
      });
      expect(again.statusCode, again.body).toBe(429);
    };
    await burst("a.singh", 40);
    await burst("m.costa", 150);
  });

  const EASY = ["0000", "1111", "1234", "9876", "1999"];

  const issuePin = async (staffId: string) => {
    const row = await staffRow(staffId);
    const issued = await app.inject({
      method: "POST", url: `/api/admin/staff/${row.id}/reset-pin`, cookies: adminCookie,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const pin = issued.json().pin as string;
    return { pin, cookie: cookieOf(await signIn(staffId)), wrong: pin === "1111" ? "2222" : "1111" };
  };

  it("a right PIN on the keypad gives that guess back", async () => {
    const { pin, cookie, wrong } = await issuePin("s.iqbal");
    const right = await app.inject({
      method: "POST", url: "/api/staff/pin/verify", cookies: cookie, payload: { pin },
    });
    expect(right.statusCode, right.body).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({
        method: "POST", url: "/api/staff/pin/verify", cookies: cookie, payload: { pin: wrong },
      })).statusCode);
    }
    expect(codes.filter((code) => code === 401), codes.join(",")).toHaveLength(5);
    expect(codes.at(-1)).toBe(429);
  });

  it("a wrong current PIN counts, and a correct one is given back before a later refusal", async () => {
    const first = await issuePin("a.singh");
    const burst = await Promise.all(Array.from({ length: 40 }, () =>
      app.inject({
        method: "POST", url: "/api/staff/pin", cookies: first.cookie,
        payload: { pin: "4829", currentPin: first.wrong },
      }),
    ));
    const codes = burst.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 401), codes.join(",")).toHaveLength(5);
    expect(codes.filter((code) => code === 429)).toHaveLength(35);

    const fresh = await issuePin("a.singh");
    for (let i = 0; i < 4; i++) {
      const wrong = await app.inject({
        method: "POST", url: "/api/staff/pin", cookies: fresh.cookie,
        payload: { pin: "4829", currentPin: fresh.wrong },
      });
      expect(wrong.statusCode, wrong.body).toBe(401);
    }
    for (const easy of EASY) {
      const res = await app.inject({
        method: "POST", url: "/api/staff/pin", cookies: fresh.cookie,
        payload: { pin: easy, currentPin: fresh.pin },
      });
      expect(res.statusCode, `${easy} ${res.body}`).toBe(422);
      expect(res.json().error).toBe("weak_pin");
    }
    const fifth = await app.inject({
      method: "POST", url: "/api/staff/pin", cookies: fresh.cookie,
      payload: { pin: "4829", currentPin: fresh.wrong },
    });
    expect(fifth.statusCode, fifth.body).toBe(401);
    const locked = await app.inject({
      method: "POST", url: "/api/staff/pin", cookies: fresh.cookie,
      payload: { pin: "4829", currentPin: fresh.wrong },
    });
    expect(locked.statusCode, locked.body).toBe(429);
  });

  it("a wrong forgot-PIN password counts, and the right one is given back before a later refusal", async () => {
    const first = await issuePin("r.haddad");
    const burst = await Promise.all(Array.from({ length: 40 }, () =>
      app.inject({
        method: "POST", url: "/api/staff/pin/reset", cookies: first.cookie,
        payload: { password: "not-the-password", pin: "4829" },
      }),
    ));
    const codes = burst.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 401), codes.join(",")).toHaveLength(5);
    expect(codes.filter((code) => code === 429)).toHaveLength(35);

    const fresh = await issuePin("r.haddad");
    for (let i = 0; i < 4; i++) {
      const wrong = await app.inject({
        method: "POST", url: "/api/staff/pin/reset", cookies: fresh.cookie,
        payload: { password: "not-the-password", pin: "4829" },
      });
      expect(wrong.statusCode, wrong.body).toBe(401);
    }
    for (const easy of EASY) {
      const res = await app.inject({
        method: "POST", url: "/api/staff/pin/reset", cookies: fresh.cookie,
        payload: { password: "yorkville", pin: easy },
      });
      expect(res.statusCode, `${easy} ${res.body}`).toBe(422);
      expect(res.json().error).toBe("weak_pin");
    }
    const fifth = await app.inject({
      method: "POST", url: "/api/staff/pin/reset", cookies: fresh.cookie,
      payload: { password: "not-the-password", pin: "4829" },
    });
    expect(fifth.statusCode, fifth.body).toBe(401);
    const locked = await app.inject({
      method: "POST", url: "/api/staff/pin/reset", cookies: fresh.cookie,
      payload: { password: "yorkville", pin: "4829" },
    });
    expect(locked.statusCode, locked.body).toBe(429);
    expect((await app.inject({
      method: "POST", url: "/api/staff/pin/verify", cookies: fresh.cookie, payload: { pin: fresh.pin },
    })).statusCode).toBe(429);
  });

  it("five easy new PINs with the right current PIN do not lock M. Costa", async () => {
    const costa = await staffRow("m.costa");
    const issued = await app.inject({
      method: "POST", url: `/api/admin/staff/${costa.id}/reset-pin`, cookies: adminCookie,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const current = issued.json().pin as string;
    for (const easy of EASY) {
      const res = await app.inject({
        method: "POST", url: "/api/staff/pin", cookies: costaCookie,
        payload: { pin: easy, currentPin: current },
      });
      expect(res.statusCode, `${easy} ${res.body}`).toBe(422);
      expect(res.json().error).toBe("weak_pin");
      if (easy === "0000") expect(res.json().detail).toBe("0000 is too easy to guess. Pick a different PIN.");
    }
    const again = await app.inject({
      method: "POST", url: "/api/staff/pin", cookies: costaCookie,
      payload: { pin: "0000", currentPin: current },
    });
    expect(again.statusCode, again.body).toBe(422);
    const wrong = current === "1111" ? "2222" : "1111";
    const next = await app.inject({
      method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: wrong },
    });
    expect(next.statusCode, next.body).toBe(401);
    expect(next.json().locked).toBe(false);
    expect((await app.inject({
      method: "POST", url: "/api/staff/pin/verify", cookies: costaCookie, payload: { pin: current },
    })).statusCode).toBe(200);
  });
});
