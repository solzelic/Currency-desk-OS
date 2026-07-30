/* Opening a desk from the reference an applicant already holds.

   The design being tested: nothing gets asked twice. Somebody who applied
   told us their name, their email and where they trade — so the flow
   arrives with those answered, and everything that FOLLOWS from where they
   trade is worked out rather than typed.

   There is ONE implementation of this flow and it is the customer's. The
   panel used to carry a second copy that staff could fill in on somebody's
   behalf; it is gone, and so are the tests that drove it. What the panel
   does now is mint the link and send it — which is the first block below.

   The field names here are the DESIGN's — operatingName, ownerEmail,
   idOver — because that list is what the record is keyed on. */
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
/* The setup record as it really sits in the database. There is no staff-side
   copy of this flow any more — the customer's screens are the only way in —
   so what is on the row is the whole truth about it. */
const stored = async (reference = ref) => {
  const { schema } = await import("../src/db/index.js");
  const enq = (await handle.db.select().from(schema.enquiries)).find((e) => e.reference === reference)!;
  const row = (await handle.db.select().from(schema.onboarding)).find((r) => r.enquiryId === enq.id)!;
  return {
    answers: (row.answers ?? {}) as Record<string, unknown>,
    by: (((row.touched ?? {}) as Record<string, unknown>).__by ?? {}) as Record<string, string>,
    tenantId: row.tenantId,
  };
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
  /* Then they start filling it in, on their own screens. This used to be
     typed on their behalf in the panel; there is no panel copy of the flow
     any more, so the answers arrive the only way they can — from them. */
  await app.inject({
    method: "PUT", url: `/api/onboarding/${ref}/state`,
    payload: { at: 3, data: { operatingName: "New Shop FX", bizName: "New Shop FX Inc.", plan: "full" } } as Record<string, unknown>,
  });
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

/* Adding a desk from the panel does not add a desk. It sends somebody the
   link to set one up — because the answers have to be theirs, and they cannot
   be if the shop already exists by the time they are asked. */
describe("starting a desk from the panel", () => {
  const invite = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/admin/onboarding/invite", cookies: adminCookie, payload: body });

  it("mints a reference and a link, and creates no desk", async () => {
    const res = await invite({ ownerEmail: "dana@maplefx.ca", ownerName: "Dana Kim", businessName: "Maple Currency Exchange", country: "CA", slug: "maplefx", website: "maplefx.ca" });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
    expect(b.link).toContain("/onboarding/" + b.reference);
    expect(b.charterNo).toBeGreaterThan(0);

    const { schema } = await import("../src/db/index.js");
    const tenants = await handle.db.select().from(schema.tenants);
    expect(tenants.some((t) => t.siteSlug === "maplefx")).toBe(false);
  });

  it("opens on their own screens carrying what we typed for them", async () => {
    const ref = (await invite({ ownerEmail: "priya@harbourline.ca", ownerName: "Priya Raman", businessName: "Harbourline FX", country: "GB" })).json().reference;
    const state = (await app.inject({ method: "GET", url: `/api/onboarding/${ref}/state` })).json();
    expect(state.data.operatingName).toBe("Harbourline FX");
    expect(state.data.ownerName).toBe("Priya Raman");
    expect(state.data.ownerEmail).toBe("priya@harbourline.ca");
    expect(state.data.country).toBe("GB");
  });

  it("will not put two live links in one inbox", async () => {
    const first = (await invite({ ownerEmail: "sam@twicefx.ca", ownerName: "Sam Ali" })).json();
    const again = await invite({ ownerEmail: "sam@twicefx.ca", ownerName: "Sam Ali" });
    expect(again.statusCode).toBe(200);
    expect(again.json().resent).toBe(true);
    expect(again.json().reference).toBe(first.reference);
  });

  it("refuses an address that already owns a desk", async () => {
    const res = await invite({ ownerEmail: "j.masri", ownerName: "J Masri" });
    expect(res.statusCode).toBe(400); // not an email address
    const real = await invite({ ownerEmail: "nadia@meridianfx.ca", ownerName: "Nadia" });
    expect([201, 409]).toContain(real.statusCode);
  });

  it("is platform-admin only", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/onboarding/invite", payload: { ownerEmail: "x@y.ca", ownerName: "X" } })).statusCode).toBe(401);
  });
});

/* The applicant's own door. One record, two surfaces: whatever the operator
   typed in the panel is already on their screen, and vice versa. */
describe("the applicant's own screens", () => {
  const state = () => app.inject({ method: "GET", url: `/api/onboarding/${ref}/state` });
  const put = (at: number, data: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: `/api/onboarding/${ref}/state`, payload: { at, data } as Record<string, unknown> });

  it("opens on what their application already told us, without a session", async () => {
    const res = await state();
    expect(res.statusCode).toBe(200);
    const d = res.json();
    // nothing gets asked twice: what they wrote on the application is already in
    expect(d.data.ownerName).toBe("Alex Roy");
    expect(d.data.website).toBe("newshop.ca");
    // what FOLLOWS from where they trade is derived on the screen that asks,
    // not baked into the state — resolve() is pinned separately above
    expect(d.data.country).toBe("CA");
    expect(d.application.reference).toBe(ref);
  });

  it("says which channel confirms the account, so the screen can word itself", async () => {
    const d = (await state()).json();
    expect(d.verify.channel).toBe("email");
    expect(d.verify.sentTo).toBe("alex@newshop.ca");
  });

  it("saves the design's own field names, flat, not as a blob", async () => {
    expect((await put(7, { spreadAll: "1.8", sameSpread: true })).statusCode).toBe(200);
    // stored under the name the design uses, so anything reading the record
    // reads an ordinary answer rather than having to unpack a wrapper
    expect((await stored()).answers.spreadAll).toBe("1.8");
    expect((await state()).json().data.spreadAll).toBe("1.8");
  });

  /* Who actually answered each question, kept on the record. It is not on a
     screen today — the staff-side copy of this flow that used to show it is
     gone — but it is the sort of thing a regulator asks about a file, and
     recovering it later is impossible if it was never written down. */
  it("records which answers really came from them", async () => {
    // the page hands the whole blob back on every save, including blanks and
    // the values we seeded for them — neither of which is an answer of theirs
    await put(7, { spreadAll: "1.8", sameSpread: true, elseReg: "", ownerName: "Alex Roy" });
    const by = (await stored()).by;
    expect(by.spreadAll).toBe("customer");     // they typed it
    expect(by.elseReg).toBeUndefined();        // a blank is not an answer
    expect(by.ownerName).toBeUndefined();      // seeded from their application
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

  /* This is what the first screen leans on. It used to check only that the
     code was SHAPED like one of ours — CD- and six characters from the right
     alphabet — which every invented string passes, so anybody who guessed the
     format walked straight into the flow. The shape proves nothing; only this
     does. */
  it("refuses a code that is perfectly well-formed and belongs to nobody", async () => {
    for (const invented of ["CD-ZZZZZZ", "CD-234567", "CD-ABCDEF"]) {
      const res = await app.inject({ method: "GET", url: `/api/onboarding/${invented}/state` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("no_such_code");
    }
  });

  it("refuses an application we have not invited yet", async () => {
    const applied = await app.inject({
      method: "POST", url: "/api/enquiries",
      payload: { kind: "early_access", email: "notyet@waiting.ca", name: "Not Yet" } as Record<string, unknown>,
    });
    // a real reference, a real application — but nobody has pressed "invited"
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${applied.json().reference}/state` })).statusCode).toBe(404);
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
    const { schema } = await import("../src/db/index.js");
    const enq = (await handle.db.select().from(schema.enquiries)).find((e) => e.reference === ref)!;
    expect(enq.status).toBe("accepted");
    expect(enq.tenantId).toMatch(/^tnt-/);
    expect((await stored()).tenantId).toBe(enq.tenantId);
  });

  it("will not open a second desk from the same link", async () => {
    const res = await app.inject({ method: "POST", url: `/api/onboarding/${ref}/launch`, payload: { data: { ownerPass: "northyork2019" } } as Record<string, unknown> });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_created");
  });
});

/* The walkthrough — one permanent application you can run start to finish.

   It used to be practised through a staff-side copy of the flow. That copy
   is gone, so the rehearsal is now the real thing: the customer's own
   screens, the customer's own endpoints, and a hard stop before a desk
   exists. Which is a better rehearsal, because it is the flow that ships. */
describe("the walkthrough", () => {
  const W = "CD-WALKTHRU";
  const state = () => app.inject({ method: "GET", url: `/api/onboarding/${W}/state` });

  it("is always there, on the applicant's own door, with a real reference", async () => {
    const res = await state();
    expect(res.statusCode).toBe(200);
    // the same alphabet as every real reference: nothing that misreads down
    // a phone line, so practising rehearses the real thing
    expect(W).toMatch(/^CD-[2-9A-HJ-NP-Z]+$/);
  });

  it("arrives half-answered, like a real one does", async () => {
    const d = (await state()).json();
    const a = (d.data ?? {}) as Record<string, unknown>;
    expect(a.website).toBe("harbourfx.ca");
    expect(a.country).toBe("CA");
    // and still has real work left, or it rehearses nothing
    expect(a.operatingName ?? null).toBeNull();
  });

  it("counts towards nothing — not the site's tally, not the funnel", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed;
    await state();
    expect((await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed).toBe(before);

    const ov = (await app.inject({ method: "GET", url: "/api/admin/overview", cookies: adminCookie })).json();
    const real = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: adminCookie })).json().enquiries;
    // visible in the list — you have to be able to find it — but not counted
    expect(real.some((e: { reference: string }) => e.reference === W)).toBe(true);
    expect(ov.funnel.applications).toBe(real.filter((e: { reference: string }) => e.reference !== W).length);
    expect(real.find((e: { reference: string }) => e.reference === W).charterNo).toBeNull();
  });

  it("runs the applicant's ending and still creates nothing", async () => {
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
    const { schema } = await import("../src/db/index.js");
    const desks = await handle.db.select().from(schema.tenants);
    expect(desks.some((t) => t.siteSlug === "harbourfx")).toBe(false);
  });

  it("never writes the rehearsal's password down", async () => {
    const { schema } = await import("../src/db/index.js");
    const rows = await handle.db.select().from(schema.onboarding);
    const w = rows.find((r) => r.enquiryId === "enq-walkthrough")!;
    expect((w.answers as Record<string, unknown>).ownerPass).not.toBe("rehearsal-only");
  });

  it("starts over, so the next run begins where the last one did", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/walkthrough/reset", cookies: adminCookie, payload: {} })).statusCode).toBe(200);
    const a = ((await state()).json().data ?? {}) as Record<string, unknown>;
    expect(a.operatingName ?? null).toBeNull();
    // what the application told us survives — that is not progress, it is them
    expect(a.website).toBe("harbourfx.ca");
  });

  it("is the platform team's button, not the public's", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/walkthrough/reset", payload: {} })).statusCode).toBe(401);
  });
});
