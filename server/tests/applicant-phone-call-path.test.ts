/* The mobile typed while opening a desk lives on the setup blob. The
   number placeOutboundCall dials is enquiries.details.phone. These tests
   are the join: the number has to arrive there, and a number that was
   already on the application has to stay. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { placeOutboundCall, type OutboundCallRequest } from "../src/growth/calls.js";
import { growthWorkflow } from "../src/growth/workflow.js";
import { canadaDeskMobile } from "../src/onboarding/applicant-phone.js";
import { seed } from "../src/seed.js";
import { acceptOnboardingTerms } from "./accept-onboarding-terms.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let admin: Record<string, string> = {};
const ADMIN = "j.masri";
const NOW = new Date("2026-08-06T15:00:00.000Z"); // 11:00 in Toronto

const codeFor = (email: string): string => {
  const line = [...logged].reverse().find((l) => l.includes(email) && l.includes("verification code"));
  const match = line?.match(/(\d{6}) is your CurrencyDesk verification code/);
  if (!match) throw new Error("no code for " + email);
  return match[1]!;
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const cookie = login.cookies.find((item) => item.name === "cdos_session");
  admin = cookie ? { cdos_session: cookie.value } : {};
  await handle.db.insert(schema.platformSettings).values({
    key: "outbound_calling_enabled",
    value: { enabled: true },
    updatedBy: "platform-owner",
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  vi.restoreAllMocks();
});

describe("which setup mobile can become the number we dial", () => {
  it("uses the local shape the early-access form already stores", () => {
    expect(canadaDeskMobile({ country: "CA", phone: "(416) 555-0148" })).toBe("+14165550148");
    expect(canadaDeskMobile({ country: "Canada", phone: "6475550134" })).toBe("+16475550134");
    expect(canadaDeskMobile({ country: "ca", phone: "+1 416 555 0148" })).toBe("+14165550148");
  });

  it("leaves other packs and non-local numbers alone", () => {
    expect(canadaDeskMobile({ country: "US", phone: "4165550148" })).toBeNull();
    expect(canadaDeskMobile({ country: "United States", phone: "4165550148" })).toBeNull();
    expect(canadaDeskMobile({ country: "CA", phone: "+44 20 7946 0958" })).toBeNull();
    expect(canadaDeskMobile({ country: "CA", phone: "ring the shop" })).toBeNull();
    expect(canadaDeskMobile({ country: "CA" })).toBeNull();
    expect(canadaDeskMobile(null)).toBeNull();
  });
});

describe("the process column after the desk exists", () => {
  const enquiry = (partial: Record<string, unknown>) => ({
    doNotContact: false,
    status: "accepted",
    details: {},
    ...partial,
  }) as typeof schema.enquiries.$inferSelect;

  it("keeps a call visible, and says when the mobile can be dialled", () => {
    expect(growthWorkflow({
      enquiry: enquiry({ details: { phone: "+14165550199" } }),
      jobs: [], research: [], calls: [],
    }).nextAction).toBe("Applicant mobile is on the call path");
    expect(growthWorkflow({
      enquiry: enquiry({ details: {} }),
      jobs: [], research: [], calls: [],
    }).nextAction).toBe("Support the new desk");
    expect(growthWorkflow({
      enquiry: enquiry({ details: { phone: "+14165550199" } }),
      jobs: [], research: [],
      calls: [{ status: "placed" } as typeof schema.enquiryCalls.$inferSelect],
    }).stage).toBe("call_in_progress");
    expect(growthWorkflow({
      enquiry: enquiry({ details: { phone: "+14165550199" } }),
      jobs: [], research: [],
      calls: [{ status: "completed" } as typeof schema.enquiryCalls.$inferSelect],
    }).stage).toBe("call_completed");
  });
});

async function apply(email: string, details: Record<string, unknown>) {
  const applied = await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: {
      kind: "early_access", email, name: "Nadia Haddad", details,
      contactContext: { timezone: "America/Toronto" },
    },
  });
  expect(applied.statusCode).toBe(201);
  const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)))[0]!;
  const invited = await app.inject({
    method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: admin,
    payload: { status: "invited" },
  });
  expect(invited.statusCode).toBe(200);
  return row;
}

async function launch(reference: string, email: string, data: Record<string, unknown>) {
  await acceptOnboardingTerms(app, reference);
  const send = await app.inject({
    method: "POST", url: `/api/onboarding/${reference}/verify/send`,
    payload: { data: { ownerEmail: email, operatingName: data.operatingName } },
  });
  expect(send.statusCode).toBe(200);
  const check = await app.inject({
    method: "POST", url: `/api/onboarding/${reference}/verify/check`,
    payload: { code: codeFor(email) },
  });
  expect(check.statusCode).toBe(200);
  const opened = await app.inject({
    method: "POST", url: `/api/onboarding/${reference}/launch`,
    payload: {
      data: {
        ownerPass: "northyork2019",
        ownerName: "Nadia Haddad",
        ownerEmail: email,
        bizName: String(data.operatingName) + " Inc.",
        plan: "full",
        ...data,
      },
    },
  });
  expect(opened.statusCode).toBe(201);
}

async function signup(email: string, slug: string, onboarding: Record<string, unknown>) {
  const start = await app.inject({
    method: "POST", url: "/api/signup",
    payload: {
      businessName: slug + " FX", ownerName: "Nadia Haddad", email,
      password: "a-strong-pass", slug, onboarding,
    },
  });
  expect(start.statusCode).toBe(201);
  const done = await app.inject({
    method: "POST", url: "/api/signup/verify",
    payload: { email, code: codeFor(email) },
  });
  expect(done.statusCode).toBe(201);
}

async function reload(email: string) {
  return (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)))[0]!;
}

async function callsFor(enquiryId: string) {
  return handle.db.select().from(schema.enquiryCalls).where(eq(schema.enquiryCalls.enquiryId, enquiryId));
}

/* The gates placeOutboundCall already enforces. This does not relax them;
   it only proves which number gets through once they pass. */
async function dial(enquiryId: string, business: string) {
  const researchId = "research-" + enquiryId;
  await handle.db.insert(schema.enquiryResearchRuns).values({
    id: researchId,
    enquiryId,
    provider: "fixture",
    model: "fixture-v1",
    status: "complete",
    summary: "Registered Canadian MSB.",
    brief: {
      executiveSummary: "Registered Canadian MSB.",
      sourceCount: 1, registryStatus: "possible_match", talkingPoints: [], openQuestions: [],
      identity: { businessName: business, websiteHost: null, verification: "exact_business_name" },
    },
    creditsUsed: 1,
    costCents: 1,
    createdBy: "platform-owner",
  });
  await handle.db.insert(schema.enquiryResearchReviews).values({
    id: "review-" + enquiryId,
    researchId,
    reviewedBy: "platform-owner",
  });
  const dialled = vi.fn(async (_request: OutboundCallRequest) => ({
    providerCallId: "CA-" + enquiryId,
    conversationId: "conv-" + enquiryId,
  }));
  const before = await callsFor(enquiryId);
  const result = await placeOutboundCall({
    db: handle.db,
    enquiryId,
    triggerKey: "admin-call",
    createdBy: "platform-owner",
    provider: { name: "fixture", place: dialled },
    config: { agentId: "agent-test", agentPhoneNumberId: "phone-test", recordingEnabled: false },
    now: () => NOW,
  });
  return { dialled, before, result };
}

describe("signup and launch put the mobile on the call", () => {
  it("lands the launch mobile on the number placeOutboundCall dials, and does not dial by itself", async () => {
    const row = await apply("launch@harbour.test", { jurisdiction: "CA", shopName: "Harbour FX" });
    expect((row.details as Record<string, unknown>).phone).toBeUndefined();
    await launch(row.reference, "launch@harbour.test", { operatingName: "Harbour FX", country: "CA", phone: "4165550199" });

    const after = await reload("launch@harbour.test");
    expect((after.details as Record<string, unknown>).phone).toBe("+14165550199");
    expect(await callsFor(row.id)).toHaveLength(0);
    const events = await handle.db.select().from(schema.enquiryGrowthEvents).where(eq(schema.enquiryGrowthEvents.enquiryId, row.id));
    expect(events.some((event) => event.type === "applicant_phone_on_call_path")).toBe(true);

    const { dialled, before, result } = await dial(row.id, "Harbour FX");
    expect(before).toHaveLength(0);
    expect(dialled).toHaveBeenCalledTimes(1);
    expect(dialled.mock.calls[0]?.[0].toNumber).toBe("+14165550199");
    expect(result.call.phone).toBe("+14165550199");

    const pipe = await app.inject({ method: "GET", url: "/api/admin/growth/pipeline", cookies: admin });
    const entry = pipe.json().byEnquiry[row.id];
    expect(entry.workflow).toMatchObject({ stage: "call_in_progress", label: "Call in progress" });
    expect(entry.call).toMatchObject({ status: "placed", phone: "+14165550199", hasTranscript: false });
    expect(entry.call.recordingUrl).toBeUndefined();
  });

  it("does not replace a number the application already had", async () => {
    const row = await apply("kept@harbour.test", { jurisdiction: "CA", shopName: "Kept FX", phone: "+14165550001" });
    await launch(row.reference, "kept@harbour.test", { operatingName: "Kept FX", country: "CA", phone: "6475550199" });
    const after = await reload("kept@harbour.test");
    expect((after.details as Record<string, unknown>).phone).toBe("+14165550001");
    const { dialled } = await dial(row.id, "Kept FX");
    expect(dialled.mock.calls[0]?.[0].toNumber).toBe("+14165550001");
  });

  it("lands the signup mobile the same way", async () => {
    const row = await apply("signup@harbour.test", { jurisdiction: "CA", shopName: "Signup FX" });
    await signup("signup@harbour.test", "signupfx", { country: "Canada", phone: "(647) 555-0134" });
    const after = await reload("signup@harbour.test");
    expect((after.details as Record<string, unknown>).phone).toBe("+16475550134");
    expect(await callsFor(row.id)).toHaveLength(0);
    const { dialled } = await dial(row.id, "Signup FX");
    expect(dialled.mock.calls[0]?.[0].toNumber).toBe("+16475550134");
  });

  it("does not overwrite a number already stored when they sign up", async () => {
    const row = await apply("signup-kept@harbour.test", { jurisdiction: "CA", phone: "+14165550002" });
    await signup("signup-kept@harbour.test", "signupkept", { country: "Canada", phone: "6475550199" });
    expect((await reload("signup-kept@harbour.test")).details).toMatchObject({ phone: "+14165550002" });
    expect(await callsFor(row.id)).toHaveLength(0);
  });

  it("does not copy a mobile from a desk that is not the Canada pack", async () => {
    const launched = await apply("us-launch@harbour.test", { jurisdiction: "US", shopName: "State FX" });
    await launch(launched.reference, "us-launch@harbour.test", { operatingName: "State FX", country: "US", phone: "4165550148" });
    expect((await reload("us-launch@harbour.test")).details).not.toHaveProperty("phone");

    const signed = await apply("us-signup@harbour.test", { jurisdiction: "US" });
    await signup("us-signup@harbour.test", "ussignup", { country: "United States", phone: "4165550148" });
    expect((await reload("us-signup@harbour.test")).details).not.toHaveProperty("phone");
    expect(await callsFor(signed.id)).toHaveLength(0);
  });

  it("does not copy a number that is not a Canadian local mobile", async () => {
    const row = await apply("abroad@harbour.test", { jurisdiction: "CA", shopName: "Abroad FX" });
    await launch(row.reference, "abroad@harbour.test", { operatingName: "Abroad FX", country: "CA", phone: "+44 20 7946 0958" });
    expect((await reload("abroad@harbour.test")).details).not.toHaveProperty("phone");
    expect(await callsFor(row.id)).toHaveLength(0);
  });
});
