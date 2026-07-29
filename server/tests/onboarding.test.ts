/* Opening a desk from the reference an applicant already holds.

   The design being tested: nothing gets asked twice. Somebody who applied
   told us their name, their email and where they trade — so the flow
   arrives with those answered, and everything that FOLLOWS from where they
   trade is worked out rather than typed.

   The field names here are the DESIGN's — operatingName, ownerEmail,
   idOver — because the panel and the applicant's own screens read and
   write one list. If those two ever disagree again, these break. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { JURISDICTION, resolve, fromApplication } from "../src/onboarding/flow.js";
import { slugFrom, specFromAnswers } from "../src/onboarding/provision.js";

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
  /* The operator presses "invited", which is what opens their own door. Until
     then the code is not a door at all — the panel can work the record, but
     /api/onboarding/:ref answers 404 to everyone. */
  const listed = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: adminCookie })).json();
  const mine = (listed.enquiries as { id: string; reference: string }[]).find((e) => e.reference === ref)!;
  await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${mine.id}`, cookies: adminCookie, payload: { status: "invited" } as Record<string, unknown> });
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("what the application already answered", () => {
  it("maps their application onto the flow's own fields", () => {
    const a = fromApplication({ name: "Alex Roy", email: "alex@newshop.ca", details: { workspace: "newshop.currencydeskos.com", jurisdiction: "CA", website: "newshop.ca" } });
    expect(a).toEqual({ ownerName: "Alex Roy", ownerEmail: "alex@newshop.ca", country: "CA", website: "newshop.ca" });
  });

  it("does not carry 'none yet' through as a website", () => {
    const a = fromApplication({ name: "A", email: "a@b.ca", details: { website: "none yet" } });
    expect(a.website).toBeUndefined();
  });

  it("works out everything that follows from where they trade", () => {
    const r = resolve({}, { country: "CA" });
    const ca = JURISDICTION.CA!;
    expect(r.regulator!.value).toBe(ca.regulator);
    expect(r.homeCurrency!.value).toBe("CAD");
    expect(r.reportThreshold!.value).toBe(ca.reportThreshold);
    expect(r.regulator!.source).toBe("derived");
  });

  it("moves the derived answers when the country changes, instead of leaving a stale one", () => {
    const r = resolve({ country: "GB" }, { country: "CA" });
    expect(r.regulator!.value).toBe("HMRC");
    expect(r.homeCurrency!.value).toBe("GBP");
  });

  it("asks for the regulator when the country is 'somewhere else', and uses what they say", () => {
    const r = resolve({ country: "XX", elseReg: "Bank of Ghana", elseCcy: "GHS" }, {});
    expect(r.regulator!.value).toBe("Bank of Ghana");
    expect(r.homeCurrency!.value).toBe("GHS");
  });

  it("lets a typed answer beat the one we guessed", () => {
    const r = resolve({ ownerName: "A. Roy" }, { ownerName: "Alex Roy" });
    expect(r.ownerName!.value).toBe("A. Roy");
    expect(r.ownerName!.source).toBe("entered");
  });

  it("treats an empty list or object as unanswered, not as an answer", () => {
    const r = resolve({ currencies: [], spreads: {} }, {});
    expect(r.currencies!.value).toBeNull();
    expect(r.spreads!.value).toBeNull();
  });
});

describe("the desk address, which the design never asks for", () => {
  it("makes one out of the shop name", () => {
    expect(slugFrom("York Currency Exchange")).toBe("york-currency-exchange");
    expect(slugFrom("  Café  FX!  ")).toBe("cafe-fx");
  });

  it("prefers the address they were promised on the application", () => {
    const spec = specFromAnswers(
      resolve({ operatingName: "Harbour Currency", bizName: "Harbour Inc." }, {}),
      { details: { workspace: "harbourfx.currencydeskos.com" } },
    );
    expect(spec.slug).toBe("harbourfx");
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
    expect(fieldOf(d, "ownerEmail")).toMatchObject({ value: "alex@newshop.ca", source: "application" });
    expect(fieldOf(d, "country")).toMatchObject({ value: "CA", source: "application" });
    // and the consequences of that, without anybody typing them
    expect(fieldOf(d, "regulator")).toMatchObject({ value: "FINTRAC", source: "derived" });
    expect(fieldOf(d, "reportThreshold")).toMatchObject({ value: 10000, source: "derived" });
    // the owner step is already complete on arrival
    expect((d.steps as { id: string; done: boolean }[]).find((s) => s.id === "account")!.done).toBe(true);
  });

  it("shows the panel the same screens the applicant walks", async () => {
    const d = (await get()).json();
    const steps = d.steps as { id: string; screen: number | null }[];
    // the design's own numbering, so an operator on the phone can say
    // "you're on the one about spreads" without translating
    expect(steps.find((s) => s.id === "spreads")!.screen).toBe(7);
    expect(steps.find((s) => s.id === "compliance")!.screen).toBe(9);
    expect((d.phases as { id: string }[]).map((p) => p.id)).toEqual(["business", "money", "rules", "launch"]);
  });

  it("saves as you type, so it can be put down and picked up", async () => {
    const res = await save("shop", { operatingName: "New Shop FX" });
    expect(res.statusCode).toBe(200);
    expect(fieldOf(res.json(), "operatingName")).toMatchObject({ value: "New Shop FX", source: "entered" });
    // a fresh look sees it — this is the resume
    expect(fieldOf((await get()).json(), "operatingName").value).toBe("New Shop FX");
    const step = ((await get()).json().steps as { id: string; touchedBy: string }[]).find((s) => s.id === "shop")!;
    expect(step.touchedBy).toBe("operator");
  });

  it("takes only the fields the step declares", async () => {
    await save("shop", { operatingName: "New Shop FX", plan: "ai", nonsense: 1 });
    const d = (await get()).json();
    // plan belongs to a different step; it must not be writable from this one
    expect(fieldOf(d, "plan").value).toBeNull();
  });

  it("refuses the owner's password, however helpful we are being", async () => {
    const res = await save("password", { ownerPass: "we-chose-this" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("customer_only");
  });

  it("says what is still needed, and names the owner's part separately", async () => {
    const first = await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/create`, cookies: adminCookie });
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toBe("not_ready");
    expect(first.json().missing).toContain("bizName");

    await save("shop", { operatingName: "New Shop FX", bizName: "New Shop FX Inc." });
    await save("plan", { plan: "full" });
    await save("currencies", { currencies: ["USD", "EUR"] });

    // everything ours is done; what is left is theirs alone
    const now = await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/create`, cookies: adminCookie });
    expect(now.statusCode).toBe(409);
    expect(now.json().error).toBe("needs_owner");
    expect(now.json().missing).toEqual(["ownerPass"]);
    expect(now.json().detail).toContain("their link");
  });

  it("does not hold the doors shut for a registration number that hasn't landed", async () => {
    // plenty of shops apply before FINTRAC comes back; the design lets them
    // skip it, so the readiness check must not quietly require it
    const d = (await get()).json();
    expect(fieldOf(d, "msbNumber").value).toBeNull();
    expect((d.ready as { missing: string[] }).missing).not.toContain("msbNumber");
  });

  it("marks the steps that have nothing to type", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/admin/onboarding/${ref}/mark`, cookies: adminCookie,
      payload: { stepId: "documents", done: true, note: "MSB cert sighted in person" } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().steps as { id: string; done: boolean }[]).find((s) => s.id === "documents")!.done).toBe(true);
    // a step with fields is answered, not marked
    expect((await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/mark`, cookies: adminCookie, payload: { stepId: "shop", done: true } as Record<string, unknown> })).statusCode).toBe(400);
  });

  it("is nobody's business but the platform team's", async () => {
    expect((await app.inject({ method: "GET", url: `/api/admin/onboarding/${ref}` })).statusCode).toBe(401);
    const teller = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } }));
    expect((await app.inject({ method: "GET", url: `/api/admin/onboarding/${ref}`, cookies: teller })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/onboarding/CD-NOTREAL", cookies: adminCookie })).statusCode).toBe(404);
  });
});

/* The applicant's own door. One record, two surfaces: whatever the operator
   typed in the panel is already on their screen, and vice versa. */
describe("the applicant's own screens", () => {
  const state = () => app.inject({ method: "GET", url: `/api/onboarding/${ref}/state` });
  const put = (at: number, data: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/onboarding/${ref}/state`, payload: { at, data } as Record<string, unknown> });

  it("opens on what the panel already knows, without a session", async () => {
    const res = await state();
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.data.operatingName).toBe("New Shop FX"); // typed in the panel above
    expect(d.data.ownerName).toBe("Alex Roy");        // from their application
    expect(d.application.reference).toBe(ref);
  });

  it("says which channel confirms the account, so the screen can word itself", async () => {
    const d = (await state()).json();
    expect(d.verify.channel).toBe("email");
    expect(d.verify.sentTo).toBe("alex@newshop.ca");
  });

  it("saves the design's own field names, flat, where the panel reads them", async () => {
    expect((await put(7, { spreadAll: "1.8", sameSpread: true })).statusCode).toBe(200);
    // the panel sees it as an ordinary answer, not as a blob it cannot read
    expect(fieldOf((await get()).json(), "spreadAll").value).toBe("1.8");
  });

  it("records which surface each answer arrived through", async () => {
    // the page hands the whole blob back on every save, including blanks and
    // the values we seeded for them — neither of which is an answer of theirs
    await put(7, { spreadAll: "1.8", sameSpread: true, elseReg: "", ownerName: "Alex Roy" });
    const d = (await get()).json();
    const field = (id: string) => {
      for (const s of d.steps as { fields: { id: string; filledBy: string | null }[] }[]) {
        const f = s.fields.find((x) => x.id === id);
        if (f) return f;
      }
      throw new Error("no field " + id);
    };
    expect(field("spreadAll").filledBy).toBe("customer");   // came through their screens
    expect(field("operatingName").filledBy).toBe("operator"); // we typed it in the panel
    expect(field("elseReg").filledBy).toBeNull();            // a blank is not an answer
    expect(field("ownerName").filledBy).toBeNull();          // seeded from their application
  });

  it("never stores the card or the password, whatever the page sends", async () => {
    await put(15, { cardNum: "4242424242424242", cardCvc: "123", cardExp: "12/29", ownerPass: "hunter2", city: "Toronto" });
    const d = (await state()).json();
    expect(d.data.cardNum).toBeUndefined();
    expect(d.data.cardCvc).toBeUndefined();
    expect(d.data.ownerPass).toBeUndefined();
    expect(d.data.city).toBe("Toronto"); // ...but everything else is kept
  });

  it("will not let the page mark itself confirmed", async () => {
    await put(14, { __verify: { confirmedAt: Date.now() } });
    const launch = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/launch`, payload: { data: { ownerPass: "northyork2019" } } as Record<string, unknown> });
    expect(launch.statusCode).toBe(403);
    expect(launch.json().error).toBe("not_confirmed");
  });

  it("does not open for a code we never invited", async () => {
    expect((await app.inject({ method: "GET", url: "/api/onboarding/CD-NOTREAL/state" })).statusCode).toBe(404);
  });
});

/* Confirming the account, and the thing the whole flow was missing: at the
   end of it, a desk. */
describe("confirming and opening the desk", () => {
  let code = "";
  const logged: string[] = [];

  beforeAll(() => {
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
  });

  it("sends a code over the channel the server decides, not the one the page assumes", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/onboarding/${ref}/verify/send`,
      payload: { data: { ownerEmail: "alex@newshop.ca", operatingName: "New Shop FX" } } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, channel: "email", sentTo: "alex@newshop.ca" });
    // no provider configured in test, so the code is logged rather than sent
    for (const c of (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      logged.push(String(c[0] ?? ""));
    }
    const line = logged.find((l) => /\b\d{6}\b/.test(l));
    code = line ? line.match(/\b(\d{6})\b/)![1]! : "";
    expect(code).toMatch(/^\d{6}$/);
  });

  it("refuses a wrong code, and says so", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/verify/check`, payload: { code: "000000" === code ? "111111" : "000000" } as Record<string, unknown> });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("wrong_code");
  });

  it("will not open a desk before the code is confirmed", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/launch`, payload: { data: { ownerPass: "northyork2019" } } as Record<string, unknown> });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_confirmed");
  });

  it("takes the right code", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/verify/check`, payload: { code } as Record<string, unknown> });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("will not open a desk without a password, which we never stored", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/launch`, payload: { data: {} } as Record<string, unknown> });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_password");
  });

  it("creates the desk, the owner and the team, and signs them in", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/onboarding/${ref}/launch`,
      payload: {
        data: {
          ownerPass: "northyork2019",
          team: [{ name: "Samira Khan", role: "Manager", email: "samira@newshop.ca" }],
          idOver: "5000", compName: "Alex Roy", compEmail: "alex@newshop.ca",
          currencies: ["USD", "EUR"], float: { CAD: "40000" },
        },
      } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.signedIn).toBe(true);
    expect(body.staffCreated).toBe(1);
    // signed in on the spot — nobody should have to go and find a login page
    expect(res.cookies.some((c) => c.name === "cdos_session")).toBe(true);

    const { schema } = await import("../src/db/index.js");
    const tenants = await handle.db.select().from(schema.tenants);
    const made = tenants.find((t) => t.id === body.tenantId)!;
    expect(made).toBeTruthy();
    expect(made.name).toBe("New Shop FX");
    expect(made.siteSlug).toBe("newshop"); // the address they were promised

    // and everything they told us survived the journey
    const setup = made.setup as Record<string, unknown>;
    expect(setup.plan).toBe("full");
    expect(setup.idThreshold).toBe(5000);
    expect((setup.compliance as Record<string, string>).name).toBe("Alex Roy");
    expect((setup.address as Record<string, string>).city).toBe("Toronto");
    expect(setup.spreadAll).toBe("1.8");
    expect(setup.currencies).toEqual(["USD", "EUR"]);

    const staff = await handle.db.select().from(schema.staffUsers);
    const samira = staff.find((s) => s.staffId === "samira@newshop.ca")!;
    expect(samira.role).toBe("branch_manager");   // "Manager", in the words authorization uses
    expect(samira.mustChangePassword).toBe(true); // we did not invent a password for her
  });

  it("closes the application, so the funnel can say which one became which desk", async () => {
    const d = (await get()).json();
    expect(d.application.status).toBe("accepted");
    expect(d.tenantId).toMatch(/^tnt-/);
  });

  it("will not open a second desk from the same link", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/launch`, payload: { data: { ownerPass: "northyork2019" } } as Record<string, unknown> });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_created");
  });
});

/* The walkthrough. Onboarding is a thing you do TO somebody, so the only way
   to practise used to be inventing a customer and living with the mess. */
describe("the walkthrough", () => {
  const W = "CD-WALKTHRU";
  const open = () => app.inject({ method: "GET", url: `/api/admin/onboarding/${W}`, cookies: adminCookie });

  it("is always there, with a properly-formed reference", async () => {
    const res = await open();
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.application.reference).toBe(W);
    expect(d.application.isWalkthrough).toBe(true);
    // the same alphabet as every real reference: nothing that misreads down
    // a phone line, so practising rehearses the real thing
    expect(W).toMatch(/^CD-[2-9A-HJ-NP-Z]+$/);
    expect(d.application.status).toBe("invited");
  });

  it("arrives half-answered, like a real one does", async () => {
    const d = (await open()).json();
    expect(fieldOf(d, "ownerName").source).toBe("application");
    expect(fieldOf(d, "website")).toMatchObject({ value: "harbourfx.ca", source: "application" });
    expect(fieldOf(d, "regulator")).toMatchObject({ value: "FINTRAC", source: "derived" });
    // and still has real work left, or it rehearses nothing
    expect(d.ready.ok).toBe(false);
    expect(d.ready.missing).toContain("operatingName");
  });

  it("counts towards nothing — not the site's tally, not the funnel", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed;
    await open();  // creating its record must not move anything either
    const after = (await app.inject({ method: "GET", url: "/api/site/early-access" })).json();
    expect(after.claimed).toBe(before);

    const ov = (await app.inject({ method: "GET", url: "/api/admin/overview", cookies: adminCookie })).json();
    const real = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: adminCookie })).json().enquiries;
    // it is visible in the list — you have to be able to find it — but it is
    // not counted among the applications waiting for an answer
    expect(real.some((e: { reference: string }) => e.reference === W)).toBe(true);
    expect(ov.funnel.applications).toBe(real.filter((e: { reference: string }) => e.reference !== W).length);
    // and it never took a founding place
    expect((await open()).json().application.charterNo).toBeNull();
  });

  it("runs the whole way and stops before leaving a real desk behind", async () => {
    const patch = (stepId: string, answers: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/admin/onboarding/${W}`, cookies: adminCookie, payload: { stepId, answers } as Record<string, unknown> });
    await patch("shop", { operatingName: "Harbour FX", bizName: "Harbour FX Inc." });
    await patch("registration", { msbNumber: "M20-7654321" });
    await patch("plan", { plan: "full" });
    await patch("currencies", { currencies: ["USD", "EUR", "GBP"] });
    // the one step a real operator cannot answer — but there is no real owner
    // here, and a rehearsal that cannot reach the ending rehearses nothing
    expect((await patch("password", { ownerPass: "rehearsal-only" })).statusCode).toBe(200);

    const done = await app.inject({ method: "POST", url: `/api/admin/onboarding/${W}/create`, cookies: adminCookie });
    expect(done.statusCode).toBe(200);
    expect(done.json().walkthrough).toBe(true);
    expect(done.json().detail).toContain("No desk was created");
    const desks = await handle.db.select().from((await import("../src/db/index.js")).schema.tenants);
    expect(desks.some((t) => t.siteSlug === "harbourfx")).toBe(false);
  });

  it("never writes the rehearsal's password down", async () => {
    const { schema } = await import("../src/db/index.js");
    const rows = await handle.db.select().from(schema.onboarding);
    const w = rows.find((r) => r.enquiryId === "enq-walkthrough")!;
    expect((w.answers as Record<string, unknown>).ownerPass).toBe("set");
  });

  it("runs the applicant's ending too, and still creates nothing", async () => {
    const send = await app.inject({ method: "POST", url: `/api/onboarding/${W}/verify/send`, payload: { data: {} } as Record<string, unknown> });
    expect(send.statusCode).toBe(200);
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0] ?? ""))
      .reverse()
      .find((l) => l.includes("[walkthrough] confirmation code"))!;
    const code = line.match(/\b(\d{6})\b/)![1]!;
    expect((await app.inject({ method: "POST", url: `/api/onboarding/${W}/verify/check`, payload: { code } as Record<string, unknown> })).statusCode).toBe(200);

    const res = await app.inject({
      method: "POST", url: `/api/onboarding/${W}/launch`,
      payload: { data: { ownerPass: "rehearsal-only", operatingName: "Harbour FX", bizName: "Harbour FX Inc.", plan: "full" } } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().walkthrough).toBe(true);
    const desks = await handle.db.select().from((await import("../src/db/index.js")).schema.tenants);
    expect(desks.some((t) => t.siteSlug === "harbourfx")).toBe(false);
  });

  it("starts over, so the next run begins where the last one did", async () => {
    const res = await app.inject({ method: "POST", url: `/api/admin/onboarding/${W}/reset`, cookies: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(fieldOf(res.json(), "operatingName").value).toBeNull();
    // what the application told us survives — that is not progress, it is them
    expect(fieldOf(res.json(), "ownerName").source).toBe("application");
  });

  it("is the only thing that can be reset — a real applicant's answers are not", async () => {
    const res = await app.inject({ method: "POST", url: `/api/admin/onboarding/${ref}/reset`, cookies: adminCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_the_walkthrough");
  });
});
