/* ============================================================
   Early Access v2.1 on the server (CD-179, CD-181, CD-182, CD-183).

   The v2.1 page sends the whole application in one typed shape and the
   server owns every value the applicant is handed back:
     · the CurrencyDesk ID, `CD-` + four letters from the shop name + `-`
       + four random characters with no 0, O, 1, I or L, minted from a
       secure random source, unique, never reused;
     · the waitlist decision, recomputed here, never taken from the page
       (outside Canada, or in Canada and not yet registered with FINTRAC);
     · for a shop outside Canada, its place in line for its country and
       an invite code it can give to another shop.
   The MSB number is normalised to M plus 8 digits, or refused. The old
   page's flat answers still post until /signup switches over.
   ============================================================ */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { CD_ID_ALPHABET, cdIdLetters, mintCdId, normalizeCdIdInput } from "../src/enquiries/cd-id.js";
import { normalizeMsb } from "../src/enquiries/msb.js";
import { enquiryIpMax, resetEnquiryThrottle } from "../src/routes/enquiries.js";
import { CallRefused, placeOutboundCall } from "../src/growth/calls.js";

let handle: DbHandle;
let app: FastifyInstance;
const NEW_ID = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;

/* A seeded byte source, so the ID tests are the same every run. */
function seeded(seed: number): (n: number) => Uint8Array {
  let x = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  };
}

/* What the v2.1 page posts (the prototype's sendEnquiry), Canada and registered. */
const v21 = (email: string, over: Record<string, unknown> = {}, kind = "early_access") => ({
  kind,
  form: "early-access-v2.1",
  email,
  name: "Daniel Okafor",
  details: {
    firstName: "Daniel", lastName: "Okafor", shopName: "York Currency Exchange",
    workspace: "york-currency-exchange.currencydeskos.com", website: "none yet", mode: kind === "signup" ? "open" : "early_access",
    jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "Yes", msbNumber: "m 1234-5678", waitlist: false, waitlistReason: null,
    role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
    runningOn: "Excel or Google Sheets", timeline: "This month",
    phone: "+1 4165550148", bestTime: "call now",
    samConsent: { phone: "+1 4165550148", text: "SAM can call this number to help set up my desk.", at: "2026-11-13T19:00:00.000Z" },
    ...over,
  },
  contactContext: { timezone: "America/Toronto" },
});
const send = (body: Record<string, unknown>, ip = "203.0.113.20") =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: body, remoteAddress: ip });
const rowOf = async (reference: string) =>
  (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => resetEnquiryThrottle());

describe("the CurrencyDesk ID", () => {
  it("is CD, four letters from the shop name, and four characters from the unambiguous alphabet", () => {
    expect(CD_ID_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    const random = seeded(7);
    for (let i = 0; i < 200; i++) expect(mintCdId("York Currency Exchange", random)).toMatch(/^CD-YORK-[2-9A-HJKMNP-Z]{4}$/);
  });

  it("takes the letters from the shop name, accents folded", () => {
    expect(cdIdLetters("York Currency Exchange")).toBe("YORK");
    expect(cdIdLetters("A&B Échange")).toBe("ABEC");
    expect(cdIdLetters("77 Money Mart")).toBe("MONE");
  });

  /* Sol, 14 Nov: an ID reading CD-XXXX-U3FZ looks like a placeholder.
     A shop name with fewer than four letters borrows them from the shop's
     address, then from the owner's name; X only when nothing has a letter. */
  it("borrows letters from the address, then the owner's name, before it ever pads with X", () => {
    expect(cdIdLetters(["34343", "34343-exchange", "Daniel Okafor"])).toBe("EXCH");
    expect(cdIdLetters(["Wu", "wu-fx", "Li Wu"])).toBe("WUFX");
    expect(cdIdLetters(["東京両替", "tokyo-ryogae", "Kenji Sato"])).toBe("TOKY");
    expect(cdIdLetters(["123", "123", "Daniel Okafor"])).toBe("DANI");
    expect(cdIdLetters(["123", "456", "李"])).toBe("XXXX");
    expect(cdIdLetters("Wu")).toBe("WUXX");
  });

  it("uses every character of the alphabet about equally (no modulo bias)", () => {
    const random = seeded(42);
    const seen = new Map<string, number>();
    for (let i = 0; i < 6200; i++) {
      for (const ch of mintCdId("York", random).slice(-4)) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
    expect([...seen.keys()].sort().join("")).toBe(CD_ID_ALPHABET.split("").sort().join(""));
    for (const n of seen.values()) expect(n).toBeGreaterThan(600);
  });

  it("reads what a person types back into the ID's shape", () => {
    expect(normalizeCdIdInput("cdyork7k42")).toBe("CD-YORK-7K42");
    expect(normalizeCdIdInput("  cd-york-7k42 ")).toBe("CD-YORK-7K42");
    expect(normalizeCdIdInput("CD YORK 7K42")).toBe("CD-YORK-7K42");
    expect(normalizeCdIdInput("cd-york-0042")).toBeNull();
    expect(normalizeCdIdInput("york7k42")).toBeNull();
  });
});

describe("the MSB number", () => {
  it("is normalised to M plus 8 digits, or left empty", () => {
    expect(normalizeMsb("m 1234-5678")).toEqual({ ok: true, value: "M12345678" });
    expect(normalizeMsb("12345678")).toEqual({ ok: true, value: "M12345678" });
    expect(normalizeMsb("")).toEqual({ ok: true, value: null });
    expect(normalizeMsb(null)).toEqual({ ok: true, value: null });
    expect(normalizeMsb("M1234567").ok).toBe(false);
    expect(normalizeMsb("X12345678").ok).toBe(false);
  });
});

describe("POST /api/enquiries, v2.1", () => {
  it("accepts a registered Canadian shop: a minted ID, stored, and no place in line", async () => {
    const res = await send(v21("daniel@yorkcurrency.example"));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { reference: string; charterNo: number | null; cdId: string | null; invite?: unknown; place?: unknown };
    expect(body.cdId).toMatch(/^CD-YORK-[2-9A-HJKMNP-Z]{4}$/);
    expect(body.charterNo).toBeGreaterThan(0);
    expect(body.invite).toBeUndefined();
    expect(body.place).toBeUndefined();
    const row = await rowOf(body.reference);
    expect(row.cdId).toBe(body.cdId);
    expect(row.waitlistReason).toBeNull();
    expect(row.details).toMatchObject({ firstName: "Daniel", lastName: "Okafor", msbNumber: "M12345678", fintracRegistered: "Yes", phone: "+14165550148" });
    /* The consent is evidence, not an answer: it is not kept in the answers. */
    expect(row.details).not.toHaveProperty("samConsent");
    expect(row.details).not.toHaveProperty("waitlist");
  });

  it("a shop called only by digits still gets a real word in its ID", async () => {
    const body = (await send(v21("digits@example.com", { shopName: "34343", workspace: "34343-exchange.currencydeskos.com" }))).json();
    expect(body.cdId).toMatch(/^CD-EXCH-[2-9A-HJKMNP-Z]{4}$/);
  });

  it("an application in progress with FINTRAC is accepted too", async () => {
    const body = (await send(v21("inprogress@example.com", { fintracRegistered: "In progress", msbNumber: null }))).json();
    expect(body.cdId).toMatch(NEW_ID);
    expect((await rowOf(body.reference)).waitlistReason).toBeNull();
  });

  it("decides the waitlist itself: a Canadian shop not yet registered is held, whatever the page said", async () => {
    const res = await send(v21("notyet@example.com", { fintracRegistered: "Not yet", msbNumber: null, waitlist: false, waitlistReason: null }));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.cdId).toBeNull();
    expect(body.charterNo).toBeNull();
    expect(body.place).toBeUndefined();
    expect((await rowOf(body.reference)).waitlistReason).toBe("not-fintrac-registered");
  });

  it("a waitlisted shop takes no place in the founding count", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed;
    await send(v21("notyet2@example.com", { fintracRegistered: "Not yet", msbNumber: null }));
    const after = (await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed;
    expect(after).toBe(before);
  });

  it("a shop outside Canada is held with its place in line for its country and an invite code", async () => {
    const outside = (email: string, shopName: string, country: string) =>
      send(v21(email, { jurisdiction: "outside-canada", province: null, country, fintracRegistered: null, msbNumber: null, shopName, waitlist: false }));
    const first = (await outside("mx1@example.com", "Cambio Azteca", "Mexico")).json();
    const second = (await outside("mx2@example.com", "Casa de Cambio Sur", "Mexico")).json();
    const elsewhere = (await outside("de1@example.com", "Wechselstube Mitte", "Germany")).json();
    expect(first.place).toBe(1);
    expect(second.place).toBe(2);
    expect(elsewhere.place).toBe(1);
    expect(first.invite.code).toMatch(/^CAMBIO-[2-9A-HJKMNP-Z]{4}$/);
    expect(first.cdId).toBeNull();
    const row = await rowOf(first.reference);
    expect(row).toMatchObject({ waitlistReason: "outside-canada", placeInLine: 1, inviteCode: first.invite.code });
  });

  it("refuses an answer the form cannot give", async () => {
    expect((await send(v21("maybe@example.com", { fintracRegistered: "Maybe" }))).statusCode).toBe(400);
    expect((await send(v21("badmsb@example.com", { msbNumber: "M123" }))).statusCode).toBe(400);
    expect((await send(v21("badtime@example.com", { bestTime: "whenever" }))).statusCode).toBe(400);
    expect((await send(v21("badhost@example.com", { workspace: "evil.example.com" }))).statusCode).toBe(400);
    expect((await send(v21("noname@example.com", { firstName: "" }))).statusCode).toBe(400);
  });

  it("open sign-up is kind signup: an ID, and no place in the founding cohort", async () => {
    const res = await send(v21("open@example.com", {}, "signup"));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.cdId).toMatch(NEW_ID);
    expect(body.charterNo).toBeNull();
    expect((await rowOf(body.reference)).kind).toBe("signup");
  });

  it("never hands two applications the same ID: the database refuses a second", async () => {
    const one = (await send(v21("unique1@example.com"))).json();
    await expect(handle.db.insert(schema.enquiries).values({
      id: "enq-clash", reference: "CD-CLASH1", kind: "early_access", email: "clash@example.com", cdId: one.cdId,
    })).rejects.toThrow();
  });

  it("slows down one address that applies too often, and not another", async () => {
    expect(enquiryIpMax()).toBe(20);
    for (let i = 0; i < enquiryIpMax(); i++) expect((await send(v21(`burst${i}@example.com`), "198.51.100.30")).statusCode).toBe(201);
    expect((await send(v21("burst-over@example.com"), "198.51.100.30")).statusCode).toBe(429);
    expect((await send(v21("other-ip@example.com"), "198.51.100.31")).statusCode).toBe(201);
  });
});

/* "No call, thanks" has to mean no call. The growth caller dials only an
   application with a contact consent on record (growth/calls.ts), so a
   v2.1 applicant who declined the SAM call must not get one. */
describe("the call choice", () => {
  const consentsOf = async (reference: string) => {
    const row = await rowOf(reference);
    return handle.db.select().from(schema.enquiryContactConsents).where(eq(schema.enquiryContactConsents.enquiryId, row.id));
  };

  it("records the contact consent when they said SAM can call", async () => {
    const { reference } = (await send(v21("callme@example.com"))).json();
    expect(await consentsOf(reference)).toHaveLength(1);
  });

  it("records none after No call, thanks, so the caller refuses them", async () => {
    const { reference } = (await send(v21("nocall@example.com", { bestTime: "no call", samConsent: null }))).json();
    expect(await consentsOf(reference)).toHaveLength(0);

    await handle.db.insert(schema.platformSettings).values({ key: "outbound_calling_enabled", value: { enabled: true }, updatedBy: "test" })
      .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: { enabled: true } } });
    const dial = async () => ({ providerCallId: "never", conversationId: null });
    const refused = await placeOutboundCall({
      db: handle.db, enquiryId: (await rowOf(reference)).id, triggerKey: "no-call-test", createdBy: "test",
      provider: { name: "fixture", place: dial },
      config: { agentId: "agent", agentPhoneNumberId: "number", recordingEnabled: false },
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CallRefused);
    expect((refused as CallRefused).code).toBe("consent_absent");
  });

  /* Only the consent depends on the call choice. Every application is
     still received and researched, as before. */
  it("still records the application and queues its research without a call", async () => {
    for (const body of [v21("nocall-growth@example.com", { bestTime: "no call", samConsent: null }), v21("held-growth@example.com", { fintracRegistered: "Not yet", msbNumber: null })]) {
      const { reference } = (await send(body)).json();
      const row = await rowOf(reference);
      const events = await handle.db.select().from(schema.enquiryGrowthEvents).where(eq(schema.enquiryGrowthEvents.enquiryId, row.id));
      expect(events.map((e) => e.type).sort()).toEqual(["application_received", "research_queued"]);
      expect(await handle.db.select().from(schema.enquiryGrowthJobs).where(eq(schema.enquiryGrowthJobs.enquiryId, row.id))).toHaveLength(1);
    }
  });

  it("records none for a waitlisted shop, which the page offers no call", async () => {
    const { reference } = (await send(v21("held-call@example.com", { fintracRegistered: "Not yet", msbNumber: null }))).json();
    expect(await consentsOf(reference)).toHaveLength(0);
  });

  it("refuses a call now with no consent behind it", async () => {
    expect((await send(v21("nodetail@example.com", { bestTime: "call now", samConsent: null }))).statusCode).toBe(400);
  });
});

describe("what still posts the old way", () => {
  it("the current page's flat answers are kept as before, with no ID", async () => {
    const res = await send({
      kind: "early_access", email: "legacy@example.com", name: "Old Page",
      details: { workspace: "legacy.currencydeskos.com", jurisdiction: "CA", employees: "2-5", phone: "416 555 0148" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
    expect(body.cdId).toBeUndefined();
  });

  it("a contact message is unchanged", async () => {
    const res = await send({ kind: "contact", email: "hello@example.com", details: { topic: "Pricing", message: "Hi" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().charterNo).toBeNull();
  });
});
