/* Opening a desk, from both doors. The point of this record is that the
   platform team and the owner are working the SAME list — a desk set up in
   the shop on Tuesday is finished by its owner on Wednesday, and neither has
   to ask the other where they got to. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { REQUIRED_IDS, STEPS } from "../src/onboarding/steps.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
let ownerCookie: Record<string, string> = {};
const ADMIN = "j.masri";
const DESK = "tnt-yorkfx";

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const signIn = (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: DESK } });

const asOperator = (stepId: string, body?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/admin/desks/${DESK}/onboarding/${stepId}`, cookies: adminCookie, payload: (body ?? {}) as Record<string, unknown> });
const asOwner = (stepId: string, body?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/onboarding/${stepId}`, cookies: ownerCookie, payload: (body ?? {}) as Record<string, unknown> });
const panelView = () => app.inject({ method: "GET", url: `/api/admin/desks/${DESK}/onboarding`, cookies: adminCookie });
const ownerView = () => app.inject({ method: "GET", url: "/api/onboarding", cookies: ownerCookie });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  adminCookie = cookieOf(await signIn(ADMIN));
  ownerCookie = cookieOf(await signIn("r.haddad"));
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("opening a desk", () => {
  it("every desk has a record, whether or not anyone has opened the screen", async () => {
    const res = await panelView();
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.steps.length).toBe(STEPS.length);
    expect(d.progress.requiredTotal).toBe(REQUIRED_IDS.length);
    expect(d.launchedAt).toBeNull();
    // "which of my customers is stuck" is unanswerable if the record only
    // exists once somebody has visited a page
    expect(d.progress.blocking.length).toBeGreaterThan(0);
  });

  it("the shop and the owner are working the same list", async () => {
    // set up in the shop, on their behalf
    const inShop = await asOperator("currencies", { data: { home: "CAD", trades: ["USD", "EUR"] }, note: "Did this at the counter." });
    expect(inShop.statusCode).toBe(200);

    // the owner opens their own screen that evening and sees it already done
    const theirs = (await ownerView()).json();
    const currencies = theirs.steps.find((s: { id: string }) => s.id === "currencies");
    expect(currencies.state.done).toBe(true);
    expect(currencies.state.by).toBe("operator");
    expect(currencies.state.data.trades).toEqual(["USD", "EUR"]);

    // and carries on from there
    expect((await asOwner("registration", { data: { msbNumber: "M20-9988776" } })).statusCode).toBe(200);
    const back = (await panelView()).json();
    expect(back.steps.find((s: { id: string }) => s.id === "registration").state.by).toBe("customer");
  });

  it("records who did each part, because those are different things", async () => {
    const d = (await panelView()).json();
    const by = Object.fromEntries(d.steps.filter((s: { state: unknown }) => s.state).map((s: { id: string; state: { by: string } }) => [s.id, s.state.by]));
    expect(by.currencies).toBe("operator");
    expect(by.registration).toBe("customer");
  });

  it("refuses to let us do the things that stop being true if we do them", async () => {
    // a password we chose is not their password, however helpful the intent
    const res = await asOperator("owner", { data: { name: "Someone" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("customer_only");
    // the owner themselves is fine
    expect((await asOwner("owner", { data: { via: "self" } })).statusCode).toBe(200);
  });

  it("will not open a desk with paperwork outstanding", async () => {
    const early = await app.inject({ method: "POST", url: `/api/admin/desks/${DESK}/onboarding/launch`, cookies: adminCookie });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("not_ready");
    expect(early.json().blocking.length).toBeGreaterThan(0);
    // and it says exactly what is missing, rather than just refusing
    expect(early.json().detail).toContain(early.json().blocking[0]);
  });

  it("opens once everything required is done, and only once", async () => {
    for (const id of REQUIRED_IDS) {
      const spec = STEPS.find((s) => s.id === id)!;
      const res = spec.who === "customer" ? await asOwner(id, { data: { ok: true } }) : await asOperator(id, { data: { ok: true } });
      expect(res.statusCode).toBe(200);
    }
    const ready = (await panelView()).json();
    expect(ready.progress.canLaunch).toBe(true);
    expect(ready.progress.blocking).toEqual([]);

    const open = await app.inject({ method: "POST", url: `/api/admin/desks/${DESK}/onboarding/launch`, cookies: adminCookie });
    expect(open.statusCode).toBe(200);
    expect(open.json().launchedAt).toBeTruthy();

    const twice = await app.inject({ method: "POST", url: `/api/admin/desks/${DESK}/onboarding/launch`, cookies: adminCookie });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("already_launched");
  });

  it("a step can be reopened when something turns out to be wrong", async () => {
    const res = await app.inject({ method: "POST", url: `/api/admin/desks/${DESK}/onboarding/documents/undo`, cookies: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().progress.canLaunch).toBe(false);
    expect(res.json().progress.blocking).toContain("documents");
    await asOperator("documents", { data: { ok: true } });
  });

  it("a desk's setup is nobody else's business", async () => {
    // a teller at the desk sees their OWN desk, never another
    const teller = cookieOf(await signIn("m.costa"));
    expect((await app.inject({ method: "GET", url: "/api/onboarding", cookies: teller })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/admin/desks/${DESK}/onboarding`, cookies: teller })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/onboarding" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/desks/tnt-nope/onboarding", cookies: adminCookie })).statusCode).toBe(404);
  });

  it("refuses a step that does not exist rather than inventing one", async () => {
    expect((await asOperator("not-a-step")).statusCode).toBe(404);
    expect((await asOwner("not-a-step")).statusCode).toBe(404);
  });

  it("a desk that came through the public signup arrives part-done", async () => {
    process.env.EARLY_ACCESS_OPEN = "1";
    const logged: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void }).mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
    await app.inject({
      method: "POST", url: "/api/signup",
      payload: { businessName: "Part Done FX", ownerName: "Sam Ng", email: "sam@partdone.example", password: "a-strong-pass", slug: "partdone",
        onboarding: { country: "CA", regulator: "FINTRAC", msbNumber: "M20-111", city: "Toronto", idThreshold: 10000 } } as Record<string, unknown>,
    });
    const code = logged.reverse().find((l) => l.includes("[email simulated]"))?.match(/(\d{6}) is your/)?.[1];
    const done = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@partdone.example", code } });
    expect(done.statusCode).toBe(201);

    const view = (await app.inject({ method: "GET", url: "/api/admin/desks/tnt-partdone/onboarding", cookies: adminCookie })).json();
    const byId = Object.fromEntries(view.steps.map((s: { id: string; state: unknown }) => [s.id, s.state]));
    // the wizard already asked these — asking again would make it feel like
    // it had not been listening
    expect(byId.jurisdiction.done).toBe(true);
    expect(byId.registration.data.msbNumber).toBe("M20-111");
    expect(byId.thresholds.done).toBe(true);
    expect(byId.owner.done).toBe(true);
    // and it is honestly still not finished
    expect(view.progress.canLaunch).toBe(false);
    expect(view.progress.blocking).toContain("documents");
    delete process.env.EARLY_ACCESS_OPEN;
  });
});
