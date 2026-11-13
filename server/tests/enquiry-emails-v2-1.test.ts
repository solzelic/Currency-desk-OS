/* ============================================================
   What a v2.1 applicant hears, and where the application lands
   (CD-181, CD-182, CD-183; Sol, 13 Nov: accept at once).

     · registered or in progress with FINTRAC, in Canada → Invited at
       once, and A2 goes straight away carrying the CurrencyDesk ID and
       the setup link. No A1: there is nothing left to review.
     · in Canada, not registered → On hold, with "Your address is held":
       the address they reserved, the FINTRAC page, what FINTRAC asks for.
     · outside Canada → On hold, with "Your place is held": their place
       for their country and their invite code.
     · the old page and an open sign-up are reviewed as before (A1).

   Moving somebody to On hold by hand still sends nothing.
   ============================================================ */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { resetEnquiryThrottle } from "../src/routes/enquiries.js";
import { moveTo } from "../src/onboarding/pipeline.js";
import { addressHeld, placeHeld, youreIn } from "../src/emails/design.js";
import { DISPATCHES } from "../src/comms.js";

let handle: DbHandle;
let app: FastifyInstance;
const NEW_ID = /CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}/;
const FINTRAC_REGISTER = "https://fintrac-canafe.canada.ca/msb-esm/register-inscrire/reg-ins-eng";

const v21 = (email: string, over: Record<string, unknown> = {}, kind = "early_access") => ({
  kind,
  form: "early-access-v2.1",
  email,
  name: "Daniel Okafor",
  details: {
    firstName: "Daniel", lastName: "Okafor", shopName: "York Currency Exchange",
    workspace: "york-currency-exchange.currencydeskos.com", website: "none yet", mode: kind === "signup" ? "open" : "early_access",
    jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "Yes", msbNumber: "M12345678", waitlist: false, waitlistReason: null,
    role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
    runningOn: "Excel or Google Sheets", timeline: "This month",
    phone: "+1 4165550148", bestTime: "call now",
    samConsent: { phone: "+1 4165550148", text: "SAM can call this number to help set up my desk.", at: "2026-11-13T19:00:00.000Z" },
    ...over,
  },
  contactContext: { timezone: "America/Toronto" },
});
const outside = (email: string, over: Record<string, unknown> = {}) => v21(email, {
  jurisdiction: "outside-canada", province: null, country: "Mexico", fintracRegistered: null, msbNumber: null,
  shopName: "Cambio Azteca", workspace: "cambio-azteca.currencydeskos.com", ...over,
});
const send = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: body, remoteAddress: "203.0.113.40" });
const rowOf = async (reference: string) =>
  (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;

/* With no mail provider set, every send is written to the log as
   "[email simulated] to=… :: subject :: text". That line is the letter. */
const log = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));
function mailTo(email: string): { subject: string; text: string }[] {
  return log()
    .filter((l) => l.startsWith(`[email simulated] to=${email} :: `))
    .map((l) => {
      const [, subject = "", ...text] = l.split(" :: ");
      return { subject, text: text.join(" :: ") };
    });
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => resetEnquiryThrottle());

describe("accepted at once", () => {
  it("a registered Canadian shop is Invited on submit and gets A2 with its ID and setup link, and no A1", async () => {
    const res = await send(v21("accepted@example.com"));
    expect(res.statusCode, res.body).toBe(201);
    const { reference, cdId } = res.json() as { reference: string; cdId: string };
    const row = await rowOf(reference);
    expect(row.status).toBe("invited");
    expect(row.decidedBy).toBe("system");

    const mail = mailTo("accepted@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("Your CurrencyDesk ID is inside");
    expect(mail[0]!.text).toContain(cdId);
    expect(mail[0]!.text).toContain(`/onboarding/${reference}`);
    expect(mail[0]!.text).toContain("You're in, Daniel.");
  });

  it("in progress with FINTRAC is accepted the same way", async () => {
    const { reference } = (await send(v21("inprogress@example.com", { fintracRegistered: "In progress", msbNumber: null }))).json();
    expect((await rowOf(reference)).status).toBe("invited");
    expect(mailTo("inprogress@example.com")[0]!.subject).toBe("Your CurrencyDesk ID is inside");
  });

  it("promises no call to somebody who said No call, thanks", async () => {
    await send(v21("nocall@example.com", { bestTime: "no call", samConsent: null }));
    const text = mailTo("nocall@example.com")[0]!.text;
    expect(text).not.toMatch(/phone call|we'll use this number/i);
    expect(text).toContain("TWO THINGS WORTH KNOWING");
  });
});

describe("the waitlist", () => {
  it("a Canadian shop not yet registered is On hold and told its address is held, with FINTRAC's page", async () => {
    const { reference } = (await send(v21("notyet@example.com", { fintracRegistered: "Not yet", msbNumber: null }))).json();
    expect((await rowOf(reference)).status).toBe("hold");

    const mail = mailTo("notyet@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("Your address is held");
    expect(mail[0]!.text).toContain("york-currency-exchange.currencydeskos.com");
    expect(mail[0]!.text).toContain(FINTRAC_REGISTER);
    expect(mail[0]!.text).toContain(reference);
    /* Not in yet: no ID, and no door into setup. */
    expect(mail[0]!.text).not.toMatch(NEW_ID);
    expect(mail[0]!.text).not.toContain("/onboarding/");
  });

  it("a shop outside Canada is On hold and told its place for its country, with its invite code", async () => {
    const res = (await send(outside("mx@example.com"))).json() as { reference: string; place: number; invite: { code: string } };
    expect((await rowOf(res.reference)).status).toBe("hold");

    const mail = mailTo("mx@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe("Your place is held");
    expect(mail[0]!.text).toContain(`Nº ${res.place}`);
    expect(mail[0]!.text).toContain("Mexico");
    expect(mail[0]!.text).toContain(res.invite.code);
    expect(mail[0]!.text).not.toContain("/onboarding/");
  });

  it("holding somebody by hand still sends nothing", async () => {
    const { reference } = (await send({ kind: "early_access", email: "byhand@example.com", details: { workspace: "byhand.currencydeskos.com" } })).json();
    const before = mailTo("byhand@example.com").length;
    const moved = await moveTo(handle.db, await rowOf(reference), "hold", "j.masri");
    expect(moved.ok && moved.email).toBeNull();
    expect(mailTo("byhand@example.com")).toHaveLength(before);
  });
});

describe("what is reviewed as before", () => {
  it("the old page's application is In review and gets A1", async () => {
    const { reference } = (await send({ kind: "early_access", email: "oldpage@example.com", name: "Amir Rostami", details: { workspace: "yorkville.currencydeskos.com" } })).json();
    expect((await rowOf(reference)).status).toBe("reviewing");
    expect(mailTo("oldpage@example.com").map((m) => m.subject)).toEqual(["We're looking at your shop"]);
  });

  /* What an open sign-up hears is not decided yet (nobody has said what
     it costs), and OPEN_SIGNUP is off. Until it is, it is reviewed. */
  it("an open sign-up is In review and gets A1", async () => {
    const { reference } = (await send(v21("open@example.com", {}, "signup"))).json();
    expect((await rowOf(reference)).status).toBe("reviewing");
    expect(mailTo("open@example.com").map((m) => m.subject)).toEqual(["We're looking at your shop"]);
  });
});

describe("the letters", () => {
  const A2 = () => youreIn({
    name: "Daniel Okafor", shopName: "York Currency Exchange", reference: "CD-KLCU73", cdId: "CD-YORK-7K42",
    setupUrl: "https://www.currencydeskos.com/onboarding/CD-KLCU73", cohortNo: 42, place: "Canada", call: true,
  });
  const W1 = () => addressHeld({ name: "Daniel Okafor", shopName: "York Currency Exchange", workspace: "york-currency-exchange.currencydeskos.com", reference: "CD-KLCU74" });
  const W2 = () => placeHeld({ name: "Ana Ruiz", shopName: "Cambio Azteca", country: "Mexico", place: 7, inviteCode: "CAMBIO-7K42", reference: "CD-KLCU75" });

  it("A2 puts the ID on the plate, keeps the reference, and does not call the ID a sign-in", () => {
    const m = A2();
    expect(m.html).toContain("Your CurrencyDesk ID");
    expect(m.html).toContain("CD-YORK-7K42");
    expect(m.text).toContain("CD-KLCU73");
    expect(m.html).not.toMatch(/sign[ -]?in/i);
    expect(m.text).not.toMatch(/sign[ -]?in/i);
  });

  it("the v2.1 letters make no claims about how long anything takes", () => {
    for (const m of [A2(), W1(), W2()]) expect(`${m.text} ${m.html}`).not.toMatch(/\bminutes?\b|\bhours?\b|\bweeks?\b|\bwithin\b/i);
  });

  it("the waitlist letters carry no em or en dash", () => {
    for (const m of [W1(), W2()]) expect(`${m.subject} ${m.text} ${m.html}`).not.toMatch(/—|–|&mdash;|&ndash;/);
  });

  /* The page shows rewards for passing the code on. Nothing honours them
     yet: no checkout takes the code and places do not move. A letter
     printing a reward the system does not give is the failure design.ts
     refuses for the founding code. */
  it("the place letter gives the code and promises no reward for it", () => {
    const m = W2();
    expect(m.text).toContain("CAMBIO-7K42");
    expect(`${m.text} ${m.html}`).not.toMatch(/months? free|move up|places? for every/i);
  });

  for (const [name, mail] of [["W1", W1], ["W2", W2]] as const) {
    it(`${name} is built the way every other letter is: tables, no custom properties, a preheader, a text part`, () => {
      const m = mail();
      expect(m.html).toContain('role="presentation"');
      expect(m.html).not.toMatch(/display\s*:\s*(flex|grid|inline-flex)/i);
      expect(m.html).not.toMatch(/var\(--/);
      expect(m.html).toMatch(/max-height:0;overflow:hidden/);
      expect(m.text.length).toBeGreaterThan(200);
      expect(m.text).not.toMatch(/<[a-z]/i);
    });
  }

  it("the catalogue lists both waitlist letters as automatic, and the invitation as automatic too now", () => {
    const by = (id: string) => DISPATCHES.find((d) => d.id === id);
    expect(by("address_held")).toMatchObject({ audience: "applicant", automatic: true });
    expect(by("place_held")).toMatchObject({ audience: "applicant", automatic: true });
    expect(by("address_held")!.stage).toBeUndefined();
    expect(by("invite")!.automatic).toBe(true);
  });
});
