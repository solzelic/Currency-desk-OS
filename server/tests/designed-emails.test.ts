/* The two emails a founding operator actually receives.

   They were plain text in a box for months, and the first one to reach a
   real inbox looked nothing like the design that had been signed off —
   which is how "we have designs" and "our customers have seen them" turn
   out to be different claims.

   These pin the parts that were wrong, or that would be wrong again:

     · the design's own words, so a rewrite is a deliberate act
     · nested tables and inline styles only, because flexbox and CSS
       custom properties do not survive Outlook and the design is full of
       both
     · the shop's name, which the form did not collect at all — the whole
       first line of A1 and most of the charter card are that name
     · a name that is not a name. People type phone numbers into name
       boxes, and "445454, you're through" is worse than no greeting
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { applicationReceived, youreIn } from "../src/emails/design.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const ADMIN = "j.masri";
const logged = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));

const A1 = () => applicationReceived({ name: "Amir Rostami", shopName: "Yorkville Currency", reference: "CD-KLCU73", place: "Canada" });
const A2 = () => youreIn({
  name: "Amir Rostami", shopName: "Yorkville Currency", reference: "CD-KLCU73",
  setupUrl: "https://www.currencydeskos.com/onboarding/CD-KLCU73", cohortNo: 42, place: "Toronto",
  issuedOn: new Date(Date.UTC(2026, 6, 30)),
});

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

/* Everything a mail client will actually throw away. Each of these is in
   the design, and each of them had to be rebuilt rather than copied. */
describe("what survives the trip", () => {
  for (const [name, mail] of [["A1", A1], ["A2", A2]] as const) {
    describe(name, () => {
      it("lays out in tables, never in flex or grid", () => {
        const html = mail().html;
        expect(html).not.toMatch(/display\s*:\s*(flex|grid|inline-flex)/i);
        expect(html).toContain('role="presentation"');
      });

      it("carries no CSS custom properties, which Outlook does not resolve", () => {
        // var(--e-ink) would render as nothing at all, so the design's
        // fallbacks are simply the values here
        expect(mail().html).not.toMatch(/var\(--/);
      });

      it("has no stylesheet for layout and no external anything", () => {
        const html = mail().html;
        expect(html).not.toMatch(/<link\b/i);
        expect(html).not.toMatch(/<script\b/i);
        // background images are the other thing that silently does not load
        expect(html).not.toMatch(/background-image\s*:/i);
      });

      it("has a plain-text version that is not the HTML", () => {
        const m = mail();
        expect(m.text.length).toBeGreaterThan(200);
        expect(m.text).not.toMatch(/<[a-z]/i);
      });

      it("has a preheader, or the client invents one from the first words", () => {
        expect(mail().html).toMatch(/max-height:0;overflow:hidden/);
      });
    });
  }
});

describe("A1 · we're looking at your shop", () => {
  it("says what the design says", () => {
    const m = A1();
    expect(m.subject).toBe("We're looking at your shop");
    expect(m.text).toContain("look at your shop the way one of your customers would");
    expect(m.text).toContain("about ten minutes, mostly us listening");
    expect(m.text).toContain("— SAM");
  });

  it("thanks them by shop, which is the whole first line", () => {
    expect(A1().text).toContain("Amir — thanks for putting Yorkville Currency forward.");
  });

  it("still reads when we never learned the shop's name", () => {
    const m = applicationReceived({ name: "Amir Rostami", reference: "CD-1" });
    expect(m.text).toContain("thanks for putting your shop forward");
    expect(m.text).not.toMatch(/undefined|null|\{\{/);
  });
});

describe("A2 · you're in", () => {
  it("says what the design says, and carries the card", () => {
    const m = A2();
    expect(m.html).toContain("You're in, Amir.");
    expect(m.html).toContain("Yorkville Currency");
    expect(m.html).toContain("Nº 042 of 100");
    expect(m.html).toContain("ISSUED 30 JUL 2026");
    expect(m.text).toContain("Three months, free, all of it.");
  });

  it("puts the setup link on the button and in the text", () => {
    const m = A2();
    expect(m.html).toContain('href="https://www.currencydeskos.com/onboarding/CD-KLCU73"');
    expect(m.text).toContain("https://www.currencydeskos.com/onboarding/CD-KLCU73");
  });

  /* The design's card is labelled "CurrencyDesk ID · Sign-in". At the
     moment this email is sent there is no account and no ID — what they
     hold opens their setup and nothing else, and it stops working if the
     invitation is taken back. */
  it("calls the reference what it is, rather than a sign-in they do not have", () => {
    const html = A2().html;
    expect(html).toContain("Your reference");
    expect(html).toContain("Opens your setup");
    expect(html).not.toMatch(/CurrencyDesk ID/i);
  });

  /* Neither of these exists yet: there is no promo code and no checkout
     for one to work at, and no server-rendered card to link to. A
     beautiful email carrying a code that does nothing is the failure this
     codebase keeps refusing everywhere else. */
  it("does not promise a founding code or a card download", () => {
    const html = A2().html;
    expect(html).not.toMatch(/FOUNDING-/);
    expect(html).not.toMatch(/Save your card/i);
    expect(html).not.toMatch(/payment step/i);
  });
});

/* Nobody's name is 445454 — but people type phone numbers, shop names and
   nothing at all into a name box, and the greeting is the first thing
   anybody reads. */
describe("when the name is not a name", () => {
  it("greets them without it rather than reading out digits", () => {
    const m = youreIn({ name: "445454", reference: "CD-2", setupUrl: "https://x/y" });
    expect(m.html).toContain("You're in.");
    expect(m.html).not.toContain("445454, ");
    expect(applicationReceived({ name: "445454", reference: "CD-2" }).text)
      .toContain("Thanks for putting your shop forward.");
  });

  it("uses the first name only, the way the design writes it", () => {
    expect(youreIn({ name: "Amir Rostami", reference: "CD-3", setupUrl: "https://x/y" }).text)
      .toContain("You're in, Amir.");
  });
});

/* The chain the emails depend on: the form asks, the server keeps it, and
   the send reads it back. Any break in that and the most personal line in
   the email quietly empties. */
describe("the shop's name, from the form to the send", () => {
  it("is kept exactly as the applicant typed it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/enquiries",
      payload: {
        kind: "early_access", email: "chain@shop.ca", name: "Rea Vue",
        details: { shopName: "Bay & Bloor Exchange", workspace: "bayfx.currencydeskos.com", jurisdiction: "CA" },
      } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(201);
    const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "chain@shop.ca")!;
    expect((row.details as Record<string, unknown>).shopName).toBe("Bay & Bloor Exchange");
  });

  it("reaches the acknowledgement that goes out on its own", () => {
    expect(logged().find((l) => l.includes("to=chain@shop.ca"))).toContain("Bay & Bloor Exchange");
  });

  it("reaches the invitation, with their place in the cohort", async () => {
    const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "chain@shop.ca")!;
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: admin, payload: { status: "invited" } as Record<string, unknown> });
    const sent = logged().find((l) => l.includes("to=chain@shop.ca"))!;
    expect(sent).toContain("Bay & Bloor Exchange");
    expect(sent).toContain(row.reference);
  });

  /* Applications lodged before the form asked have nothing to put there,
     and there are real ones. The workspace they chose was typed by
     somebody thinking of their shop, so tidied up it usually is one. */
  it("falls back to the workspace for applications that predate the question", async () => {
    await app.inject({
      method: "POST", url: "/api/enquiries",
      payload: {
        kind: "early_access", email: "old@shop.ca", name: "Pri Or",
        details: { workspace: "harbour-fx.currencydeskos.com", jurisdiction: "CA" },
      } as Record<string, unknown>,
    });
    expect(logged().find((l) => l.includes("to=old@shop.ca"))).toContain("Harbour Fx");
  });
});
