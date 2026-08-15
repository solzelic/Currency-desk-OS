/* Growth pipeline seam at the HTTP boundary: applicant statements remain
   untouched while sourced research and call history accumulate beside them. */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import type { OutboundCallRequest } from "../src/growth/calls.js";
import type { LeadResearchProvider } from "../src/growth/research.js";
import { seed } from "../src/seed.js";

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string> = {};
const ADMIN = "j.masri";
const NOW = new Date("2026-08-06T15:00:00.000Z");
const dial = vi.fn(async (_request: OutboundCallRequest) => ({ providerCallId: "CA-growth-1", conversationId: "conv-growth-1" }));

const research: LeadResearchProvider = {
  name: "fixture-search",
  model: "fixture-v1",
  async research() {
    return {
      summary: "The public FINTRAC registry lists the business as registered. Source: https://registry.example/msb/42",
      brief: {
        executiveSummary: "The public FINTRAC registry lists the business as registered.",
        sourceCount: 1, registryStatus: "possible_match", talkingPoints: [], openQuestions: [],
        identity: { businessName: "North Star FX", websiteHost: "northstar.example", verification: "exact_business_name" },
      },
      facts: [{
        key: "fintrac_registration",
        value: "Registration M123456 is listed as active.",
        sourceUrl: "https://registry.example/msb/42",
        confidence: 0.99,
        method: "registry",
      }],
      creditsUsed: 3,
      costCents: 6,
    };
  },
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db, {
    researchProvider: research,
    callProvider: { name: "fixture-calls", place: dial },
    callConfig: { agentId: "agent-fixture", agentPhoneNumberId: "phone-fixture", recordingEnabled: true },
    webhookSecret: "webhook-secret",
    toolSecret: "tool-secret",
    now: () => NOW,
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const cookie = login.cookies.find((item) => item.name === "cdos_session");
  admin = cookie ? { cdos_session: cookie.value } : {};
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  vi.restoreAllMocks();
});

const apply = async (email: string) => {
  const details = { shopName: "North Star FX", website: "northstar.example", phone: "+14165550191", monthlyVolume: "$500K – $2M" };
  const response = await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email, name: "Mira Chen", details, contactContext: { timezone: "America/Toronto" } },
    headers: { "user-agent": "growth-test-browser" },
    remoteAddress: "203.0.113.55",
  });
  expect(response.statusCode).toBe(201);
  const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)).limit(1))[0]!;
  return { row, details };
};

describe("lead research and outbound calling", () => {
  it("stores consent evidence and sourced research without touching applicant details", async () => {
    const { row, details } = await apply("research@northstar.example");
    await handle.db.insert(schema.enquiries).values({
      id: "enq-prior-matching-lead",
      reference: "CD-PRIOR01",
      kind: "early_access",
      email: "research@northstar.example",
      name: "Earlier application",
      details,
      status: "reviewing",
    });
    const before = row.details;
    const first = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/research`, cookies: admin, payload: {} });
    const second = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/research`, cookies: admin, payload: {} });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const view = await app.inject({ method: "GET", url: `/api/admin/enquiries/${row.id}/growth`, cookies: admin });
    expect(view.statusCode).toBe(200);
    expect(view.json().research).toHaveLength(2);
    expect(view.json().research[0].facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceUrl: "https://registry.example/msb/42", confidence: 0.99, method: "registry" }),
    ]));
    expect(view.json().research[0].brief.operatorOnly).toEqual({
      matchingEmailApplications: 1,
      matchingPhoneApplications: 1,
      matchingBusinessApplications: 1,
    });
    expect(view.json().consent).toMatchObject({ formVersion: "early-access-2026-08-06", timezone: "America/Toronto", timezoneSource: "browser" });

    const after = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, row.id)).limit(1))[0]!;
    expect(after.details).toEqual(before);
    expect(after.details).toEqual(details);
    expect(after.details).not.toHaveProperty("contactContext");
  });

  it("places once over HTTP and writes an authenticated transcript back", async () => {
    const { row } = await apply("call@northstar.example");
    const researched = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/research`, cookies: admin, payload: {} });
    await app.inject({ method: "PATCH", url: "/api/admin/growth/calling", cookies: admin, payload: { enabled: true } });
    const unreviewed = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/call`, cookies: admin, headers: { "idempotency-key": "before-review" }, payload: {} });
    expect(unreviewed.statusCode).toBe(409);
    expect(unreviewed.json().error).toBe("research_unreviewed");
    expect(dial).not.toHaveBeenCalled();
    await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/research/${researched.json().runId}/review`, cookies: admin, payload: {} });
    const first = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/call`, cookies: admin, headers: { "idempotency-key": "same-click" }, payload: {} });
    const retry = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/call`, cookies: admin, headers: { "idempotency-key": "same-click" }, payload: {} });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial.mock.calls[0]?.[0].toNumber).toBe("+14165550191");

    const event = {
      type: "post_call_transcription",
      event_timestamp: Math.floor(NOW.getTime() / 1000),
      data: {
        conversation_id: "conv-growth-1",
        status: "done",
        transcript: [{ role: "agent", message: "I'm SAM, an AI assistant. This call is being recorded." }, { role: "user", message: "Yes." }],
        metadata: { call_duration_secs: 42 },
        analysis: { call_successful: true, transcript_summary: "Applicant wants a walkthrough next week." },
      },
    };
    const raw = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "webhook-secret").update(`${timestamp}.${raw}`).digest("hex");
    const webhook = await app.inject({
      method: "POST", url: "/api/webhooks/elevenlabs", payload: raw,
      headers: { "content-type": "application/json", "elevenlabs-signature": `t=${timestamp},v0=${signature}` },
    });
    expect(webhook.statusCode).toBe(200);
    const calls = await handle.db.select().from(schema.enquiryCalls).where(eq(schema.enquiryCalls.enquiryId, row.id));
    expect(calls[0]).toMatchObject({ status: "completed", durationSeconds: 42, outcome: "true", summary: "Applicant wants a walkthrough next week." });
    expect(calls[0]?.transcript).toHaveLength(2);
  });

  it("honours do-not-contact from the panel and from the agent tool", async () => {
    const { row } = await apply("stop@northstar.example");
    await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/research`, cookies: admin, payload: {} });
    const stopped = await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}/contact`, cookies: admin, payload: { doNotContact: true, reason: "asked by owner" } });
    expect(stopped.statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/call`, cookies: admin, headers: { "idempotency-key": "must-not-dial" }, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("do_not_contact");

    // A real call may also set the permanent flag through the agent's
    // authenticated tool, but only when the conversation belongs to the lead.
    const called = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "call@northstar.example")).limit(1))[0]!;
    const tool = await app.inject({
      method: "POST", url: "/api/webhooks/elevenlabs/do-not-contact",
      headers: { authorization: "Bearer tool-secret" },
      payload: { enquiryId: called.id, conversationId: "conv-growth-1", reason: "requested during call" },
    });
    expect(tool.statusCode).toBe(200);
    const after = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, called.id)).limit(1))[0]!;
    expect(after.doNotContact).toBe(true);
  });

  it("rejects unsigned webhook payloads", async () => {
    const result = await app.inject({ method: "POST", url: "/api/webhooks/elevenlabs", payload: { type: "post_call_transcription", data: {} } });
    expect(result.statusCode).toBe(401);
  });
});
