/* Asking for the confirmation code during setup.

   Three things went wrong here at once, and all three were the same
   mistake in different clothes: the screen said something that was not
   true.

     · a send that FAILED still came back as ok, so the page said "we've
       emailed a 6-digit code" and somebody sat waiting for an email that
       was never coming
     · two of the refusals carried no reason, so the page fell back to
       "we couldn't send that code just now" — the least useful sentence
       in the product, shown identically for a rate limit, a missing
       address and a provider outage
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forget as forgetCooldown } from "../src/cooldown.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const ADMIN = "j.masri";
let reference = "";
const OWNER = "owner@sendtest.example";

const send = () =>
  app.inject({ method: "POST", url: `/api/onboarding/${reference}/verify/send`, payload: { data: {} } as Record<string, unknown> });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};

  await app.inject({ method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email: "applicant@sendtest.example", name: "Jakob Subotic", details: { jurisdiction: "CA" } } as Record<string, unknown> });
  const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "applicant@sendtest.example")!;
  reference = row.reference;
  await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: admin, payload: { status: "invited" } as Record<string, unknown> });
  await app.inject({ method: "PUT", url: `/api/onboarding/${reference}/state`,
    payload: { at: 3, data: { ownerEmail: OWNER, operatingName: "Send Test FX" } } as Record<string, unknown> });
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

/* The two-minute gap between codes is real now (src/cooldown.ts), and a
   test that asks for two in a row is not a person double-clicking — it is
   a suite deliberately exercising the second one. Clear it between tests,
   and inline wherever one test genuinely needs two sends. */
beforeEach(() => forgetCooldown());
describe("when it works", () => {
  it("says where it went", async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sentTo: OWNER });
  });
});

describe("when the provider refuses it", () => {
  /* The bug: `await sendEmail(...)` with the result thrown away. The mail
     never left and the screen said it had. */
  it("does not claim the code was sent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 422 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.RESEND_API_KEY = "re_test"; process.env.EMAIL_FROM = "SAM <sam@mail.example>";
    try {
      const res = await send();
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("send_failed");
      // and it says what to do about it, rather than just that it broke
      expect(res.json().detail).toMatch(/try again|reply/i);
    } finally {
      delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
      fetchSpy.mockRestore(); errSpy.mockRestore();
    }
  });
});

describe("when it is refused for a reason", () => {
  it("gives one, so the page has something true to show", async () => {
    /* Every non-200 from this route has to carry a detail. The page shows
       `detail` and falls back to a sentence that explains nothing. */
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${reference}/verify/send`, payload: { data: {} } as Record<string, unknown> });
    if (res.statusCode !== 200) expect(res.json().detail).toBeTruthy();

    // the one that has no owner address on it yet
    await app.inject({ method: "POST", url: "/api/enquiries",
      payload: { kind: "early_access", email: "noaddr@sendtest.example", name: "No Addr", details: { jurisdiction: "CA" } } as Record<string, unknown> });
    const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "noaddr@sendtest.example")!;
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: admin, payload: { status: "invited" } as Record<string, unknown> });
    await app.inject({ method: "PUT", url: `/api/onboarding/${row.reference}/state`,
      payload: { at: 3, data: { ownerEmail: "not-an-address" } } as Record<string, unknown> });
    const bad = await app.inject({ method: "POST", url: `/api/onboarding/${row.reference}/verify/send`, payload: { data: {} } as Record<string, unknown> });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toBeTruthy();
  });

  it("stops asking after enough goes in an hour, and says that is what happened", async () => {
    /* The HOURLY cap, which is a different limit from the two-minute gap
       and catches a different person: this one is somebody hammering it
       all afternoon rather than double-clicking once. The gap is cleared
       between goes so this reaches the cap it means to test. */
    let last: { statusCode: number; json: () => { detail?: string } } | null = null;
    for (let i = 0; i < 12; i++) {
      forgetCooldown();
      last = await send();
      if (last.statusCode === 429 && /hold on|wait a moment/i.test(last.json().detail ?? "")) break;
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json().detail).toMatch(/hold on|wait/i);
  });
});
