/* ============================================================
   The SAM call, Early Access v2.1 (CD-180, CD-181).

     · Consent is evidence, kept by inserting only: the number, the exact
       sentence they agreed to, their address and its country, their
       browser, and when. A stop is another row, never an edit.
     · POST /api/enquiries/:reference/sam { at } books when SAM calls:
       moved into calling hours in the applicant's own zone (weekdays
       9:00 to 21:30, weekends 10:00 to 18:00, starting no later than
       five minutes before the end), and refused without consent for
       that exact number.
     · The caller (growth/calls.ts) does not ring once a stop is on record.
   ============================================================ */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { resetEnquiryThrottle } from "../src/routes/enquiries.js";
import { clampToCallingHours, resetSamThrottle, SAM_CONSENT_TEXT, zoneFor } from "../src/enquiries/sam.js";
import { CallRefused, placeOutboundCall } from "../src/growth/calls.js";

let handle: DbHandle;
let app: FastifyInstance;

const v21 = (email: string, over: Record<string, unknown> = {}) => ({
  kind: "early_access",
  form: "early-access-v2.1",
  email,
  name: "Daniel Okafor",
  details: {
    firstName: "Daniel", lastName: "Okafor", shopName: "York Currency Exchange",
    workspace: `york-${randomUUID().slice(0, 6)}.currencydeskos.com`, website: "none yet", mode: "early_access",
    jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "Yes", msbNumber: null, waitlist: false, waitlistReason: null,
    role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
    runningOn: "Excel or Google Sheets", timeline: "This month",
    phone: "+1 4165550148", bestTime: "call now",
    samConsent: { phone: "+1 4165550148", text: SAM_CONSENT_TEXT, at: "2026-11-13T19:00:00.000Z" },
    ...over,
  },
  contactContext: { timezone: "America/Toronto" },
});
const apply = async (body: Record<string, unknown>) => {
  const res = await app.inject({
    method: "POST", url: "/api/enquiries", payload: body, remoteAddress: "203.0.113.60",
    headers: { "cf-ipcountry": "CA", "user-agent": "Mozilla/5.0 (test)" },
  });
  return { status: res.statusCode, body: res.json() as { reference: string } };
};
const book = (reference: string, at: string | null) =>
  app.inject({ method: "POST", url: `/api/enquiries/${reference}/sam`, payload: { at }, remoteAddress: "203.0.113.61" });
const rowOf = async (reference: string) =>
  (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)))[0]!;

/* Wall clock in a zone, for reading answers back. */
const wall = (iso: string, zone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => { resetEnquiryThrottle(); resetSamThrottle(); });

describe("calling hours, in the applicant's zone", () => {
  const T = "America/Toronto";
  const at = (iso: string) => clampToCallingHours(new Date(iso), T).toISOString();

  it("keeps a time inside the hours", () => {
    expect(wall(at("2026-11-16T14:00:00Z"), T)).toBe("Mon 2026-11-16 09:00"); // Monday 9:00 EST
    expect(wall(at("2026-11-17T02:25:00Z"), T)).toBe("Mon 2026-11-16 21:25"); // the last start on a weekday
    expect(wall(at("2026-11-15T22:55:00Z"), T)).toBe("Sun 2026-11-15 17:55"); // the last start on a weekend
  });

  it("moves an early time to the opening, the same day", () => {
    expect(wall(at("2026-11-16T12:30:00Z"), T)).toBe("Mon 2026-11-16 09:00");
    expect(wall(at("2026-11-14T13:00:00Z"), T)).toBe("Sat 2026-11-14 10:00");
  });

  it("moves a late time to the next opening, weekend hours on a weekend", () => {
    expect(wall(at("2026-11-17T02:30:00Z"), T)).toBe("Tue 2026-11-17 09:00"); // Monday 21:30
    expect(wall(at("2026-11-21T03:00:00Z"), T)).toBe("Sat 2026-11-21 10:00"); // late Friday
    expect(wall(at("2026-11-21T23:30:00Z"), T)).toBe("Sun 2026-11-22 10:00"); // Saturday 18:30
    expect(wall(at("2026-11-23T00:00:00Z"), T)).toBe("Mon 2026-11-23 09:00"); // Sunday 19:00
  });

  it("holds across both clock changes", () => {
    // spring forward, Sunday 8 March 2026: Saturday evening goes to Sunday 10:00 EDT
    expect(at("2026-03-08T00:00:00Z")).toBe("2026-03-08T14:00:00.000Z");
    // fall back, Sunday 1 November 2026: Saturday evening goes to Sunday 10:00 EST
    expect(at("2026-11-01T00:30:00Z")).toBe("2026-11-01T15:00:00.000Z");
  });

  it("works in another zone", () => {
    const V = "America/Vancouver";
    expect(wall(clampToCallingHours(new Date("2026-11-16T15:00:00Z"), V).toISOString(), V)).toBe("Mon 2026-11-16 09:00");
  });

  it("takes the browser's zone when it is real, else the province's", () => {
    expect(zoneFor("America/Halifax", "ON")).toBe("America/Halifax");
    expect(zoneFor("Not/AZone", "BC")).toBe("America/Vancouver");
    expect(zoneFor(null, "SK")).toBe("America/Regina");
    expect(zoneFor(null, null)).toBe("America/Toronto");
  });
});

describe("consent, kept as evidence", () => {
  it("records the number, the exact sentence, the address and its country, and the browser", async () => {
    const { status, body } = await apply(v21("consent@example.com"));
    expect(status).toBe(201);
    const row = await rowOf(body.reference);
    const [c] = await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, row.id));
    expect(c).toMatchObject({ event: "consent", phone: "+14165550148", consentText: SAM_CONSENT_TEXT, ipAddress: "203.0.113.60", ipCountry: "CA", userAgent: "Mozilla/5.0 (test)" });
  });

  it("refuses consent to a sentence the page does not show", async () => {
    const res = await apply(v21("othertext@example.com", { samConsent: { phone: "+1 4165550148", text: "SAM may call me whenever.", at: "2026-11-13T19:00:00.000Z" } }));
    expect(res.status).toBe(400);
  });

  it("records none after No call, thanks", async () => {
    const { body } = await apply(v21("nocall-sam@example.com", { bestTime: "no call", samConsent: null }));
    const row = await rowOf(body.reference);
    expect(await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, row.id))).toHaveLength(0);
  });
});

describe("POST /api/enquiries/:reference/sam", () => {
  it("books a time inside calling hours, stored in UTC with the zone", async () => {
    const { body } = await apply(v21("book@example.com"));
    const res = await book(body.reference, "2099-01-01T00:00:00Z");
    expect(res.statusCode).toBe(400); // too far ahead

    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const ok = await book(body.reference, soon);
    expect(ok.statusCode, ok.body).toBe(200);
    const answer = ok.json() as { at: string; zone: string };
    expect(answer.zone).toBe("America/Toronto");
    expect(answer.at).toBe(clampToCallingHours(new Date(soon), "America/Toronto").toISOString());
    const row = await rowOf(body.reference);
    expect(row.samCallAt?.toISOString()).toBe(answer.at);
    expect(row.samCallZone).toBe("America/Toronto");
  });

  it("with no time, books the first moment calling hours allow", async () => {
    const { body } = await apply(v21("asap@example.com"));
    const res = await book(body.reference, null);
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().at).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
  });

  it("refuses without consent for that number, and a stop wins", async () => {
    const none = (await apply(v21("noconsent-book@example.com", { bestTime: "no call", samConsent: null }))).body;
    expect((await book(none.reference, null)).statusCode).toBe(409);

    const stopped = (await apply(v21("stopped@example.com"))).body;
    const row = await rowOf(stopped.reference);
    await handle.db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: row.id, event: "stop", phone: "+14165550148" });
    expect((await book(stopped.reference, null)).statusCode).toBe(409);
  });

  it("does not book for a waitlisted application or a reference that does not exist", async () => {
    const held = (await apply(v21("held-book@example.com", { fintracRegistered: "Not yet" }))).body;
    expect((await book(held.reference, null)).statusCode).toBe(404);
    expect((await book("CD-ZZZZZZ", null)).statusCode).toBe(404);
    expect((await book("not-a-reference", null)).statusCode).toBe(404);
  });
});

describe("the caller", () => {
  it("does not ring an applicant whose latest word is stop", async () => {
    const { body } = await apply(v21("caller-stop@example.com"));
    const row = await rowOf(body.reference);
    await handle.db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: row.id, event: "stop", phone: "+14165550148" });
    const latest = (await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, row.id)).orderBy(desc(schema.enquiryCallConsents.at)))[0]!;
    expect(latest.event).toBe("stop");

    await handle.db.insert(schema.platformSettings).values({ key: "outbound_calling_enabled", value: { enabled: true }, updatedBy: "test" })
      .onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: { enabled: true } } });
    const refused = await placeOutboundCall({
      db: handle.db, enquiryId: row.id, triggerKey: "stop-test", createdBy: "test",
      provider: { name: "fixture", place: async () => ({ providerCallId: "never", conversationId: null }) },
      config: { agentId: "agent", agentPhoneNumberId: "number", recordingEnabled: false },
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CallRefused);
    expect((refused as CallRefused).code).toBe("call_stopped");
  });
});
