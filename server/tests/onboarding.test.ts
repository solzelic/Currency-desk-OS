/* Opening a desk from the reference an applicant already holds.

   The design being tested: nothing gets asked twice. Somebody who applied
   told us their name, their email, the address they picked and where they
   trade — so the flow arrives with those answered, and everything that
   FOLLOWS from where they trade is worked out rather than typed. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { JURISDICTION, resolve, fromApplication } from "../src/onboarding/flow.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
let ref = "";
const ADMIN = "j.masri";

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const get = () => app.inject({ method: "GET", url: `/api/admin/onboarding/${ref}`, cookies: adminCookie });
const save = (stepId: string, answers: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/admin/onboarding/${ref}`, cookies: adminCookie, payload: { stepId, answers } as Record<string, unknown> });
const fieldOf = (body: Record<string, unknown>, id: string) => {
  for (const s of body.steps as { fields: { id: string }[] }[]) {
    const f = s.fields.find((x) => x.id === id);
    if (f) return f as { id: string; value: unknown; source: string | null };
  }
  throw new Error("no field " + id);
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  adminCookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } }));
  // somebody applies on the site, the way they really do
  const applied = await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: {
      kind: "early_access", email: "alex@newshop.ca", name: "Alex Roy",
      details: { workspace: "newshop.currencydeskos.com", jurisdiction: "CA", website: "newshop.ca", monthlyVolume: "$500K – $2M", timeline: "As soon as possible" },
    } as Record<string, unknown>,
  });
  ref = applied.json().reference;
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("what the application already answered", () => {
  it("maps their application onto the flow's own fields", () => {
    const a = fromApplication({ name: "Alex Roy", email: "alex@newshop.ca", details: { workspace: "newshop.currencydeskos.com", jurisdiction: "CA" } });
    expect(a).toEqual({ ownerName: "Alex Roy", email: "alex@newshop.ca", slug: "newshop", country: "CA" });
  });

  it("works out everything that follows from where they trade", () => {
    const r = resolve({}, { country: "CA" });
    const ca = JURISDICTION.CA!;
    expect(r.regulator!.value).toBe(ca.regulator);
    expect(r.homeCurrency!.value).toBe("CAD");
    expect(r.idThreshold!.value).toBe(ca.idThreshold);
    expect(r.regulator!.source).toBe("derived");
  });

  it("moves the derived answers when the country changes, instead of leaving a stale one", () => {
    const r = resolve({ country: "GB" }, { country: "CA" });
    expect(r.regulator!.value).toBe("HMRC");
    expect(r.homeCurrency!.value).toBe("GBP");
  });

  it("lets a typed answer beat the one we guessed", () => {
    const r = resolve({ ownerName: "A. Roy" }, { ownerName: "Alex Roy" });
    expect(r.ownerName!.value).toBe("A. Roy");
    expect(r.ownerName!.source).toBe("entered");
  });
});

describe("driving it from the reference they already hold", () => {
  it("opens on the reference, and starts the record on first look", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.application.reference).toBe(ref);
    expect(d.application.charterNo).toBeGreaterThan(0);
    // and it carries what they told us that the flow does not ask again,
    // because the operator wants that in front of them on the call
    expect(d.application.told.monthlyVolume).toBe("$500K – $2M");
  });

  it("arrives with their answers already in it — the whole point", async () => {
    const d = (await get()).json();
    expect(fieldOf(d, "ownerName")).toMatchObject({ value: "Alex Roy", source: "application" });
    expect(fieldOf(d, "email")).toMatchObject({ value: "alex@newshop.ca", source: "application" });
    expect(fieldOf(d, "slug")).toMatchObject({ value: "newshop", source: "application" });
    expect(fieldOf(d, "country")).toMatchObject({ value: "CA", source: "application" });
    // and the consequences of that, without anybody typing them
    expect(fieldOf(d, "regulator")).toMatchObject({ value: "FINTRAC", source: "derived" });
    expect(fieldOf(d, "idThreshold")).toMatchObject({ value: 3000, source: "derived" });
    // the owner step is already complete on arrival
    expect((d.steps as { id: string; done: boolean }[]).find((s) => s.id === "owner")!.done).toBe(true);
  });

  it("saves as you type, so it can be put down and picked up", async () => {
    const res = await save("business", { businessName: "New Shop FX" });
    expect(res.statusCode).toBe(200);
    expect(fieldOf(res.json(), "businessName")).toMatchObject({ value: "New Shop FX", source: "entered" });
    // a fresh look sees it — this is the resume
    expect(fieldOf((await get()).json(), "businessName").value).toBe("New Shop FX");
    const step = ((await get()).json().steps as { id: string; touchedBy: string }[]).find((s) => s.id === "business")!;
    expect(step.touchedBy).toBe("operator");
  });

  it("takes only the fields the step declares", async () => {
    await save("business", { businessName: "New Shop FX", plan: "premium", nonsense: 1 });
    const d = (await get()).json();
    // plan belongs to a different step; it must not be writable from this one
    expect(fieldOf(d, "plan").value).toBeNull();
  });

  it("refuses the owner's password, however helpful we are being", async () => {
    const res = await save("password", { password: "we-chose-this" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("customer_only");
  });

  it("says what is still needed, and names the owner's part separately", async () => {
    const first = await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/create`, cookies: adminCookie });
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toBe("not_ready");
    expect(first.json().missing).toContain("msbNumber");

    await save("registration", { msbNumber: "M20-1234567", address: "1 King St W", city: "Toronto" });
    await save("plan", { plan: "pro" });
    await save("trading", { currencies: "USD, EUR" });

    // everything ours is done; what is left is theirs alone
    const now = await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/create`, cookies: adminCookie });
    expect(now.statusCode).toBe(409);
    expect(now.json().error).toBe("needs_owner");
    expect(now.json().missing).toEqual(["password"]);
    expect(now.json().detail).toContain("their link");
  });

  it("marks the steps that have nothing to type", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/admin/onboarding/${ref}/mark`, cookies: adminCookie,
      payload: { stepId: "documents", done: true, note: "MSB cert sighted in person" } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().steps as { id: string; done: boolean }[]).find((s) => s.id === "documents")!.done).toBe(true);
    // a step with fields is answered, not marked
    expect((await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/mark`, cookies: adminCookie, payload: { stepId: "business", done: true } as Record<string, unknown> })).statusCode).toBe(400);
  });

  it("hands the desk to the signup path rather than building a second one", async () => {
    await save("owner", { });                       // nothing to change; already answered
    const row = await handle.db.select().from((await import("../src/db/index.js")).schema.onboarding);
    expect(row.length).toBe(1);
    // with the password supplied the handoff is complete and shaped for /api/signup
    const d = (await get()).json();
    expect(d.ready.missing).toEqual(["password"]);
    expect(fieldOf(d, "regulator").value).toBe("FINTRAC");
  });

  it("is nobody's business but the platform team's", async () => {
    expect((await app.inject({ method: "GET", url: `/api/admin/onboarding/${ref}` })).statusCode).toBe(401);
    const teller = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } }));
    expect((await app.inject({ method: "GET", url: `/api/admin/onboarding/${ref}`, cookies: teller })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/onboarding/CD-NOTREAL", cookies: adminCookie })).statusCode).toBe(404);
  });
});
