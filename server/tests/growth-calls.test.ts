/* The failure this suite starts with reaches a real person: a retry or a
   double-click must never make their phone ring twice. Keep this test at the
   service boundary so every HTTP caller inherits the same reservation rule. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import {
  placeOutboundCall,
  type OutboundCallRequest,
  type OutboundCallProvider,
} from "../src/growth/calls.js";

let handle: DbHandle;

const NOW = new Date("2026-08-06T15:00:00.000Z"); // 11:00 in Toronto

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
});

afterAll(async () => {
  await handle.close();
});

describe("growth outbound calls", () => {
  it("the same trigger fired concurrently places one call", async () => {
    const enquiryId = "enq-call-idempotency";
    await handle.db.insert(schema.enquiries).values({
      id: enquiryId,
      reference: "CD-CALL01",
      kind: "early_access",
      email: "owner@example.test",
      name: "Amina Rahman",
      details: {
        shopName: "Amina FX",
        phone: "+14165550148",
        monthlyVolume: "$2M – $10M",
      },
      status: "reviewing",
    });
    await handle.db.insert(schema.enquiryContactConsents).values({
      id: "consent-call-idempotency",
      enquiryId,
      formVersion: "early-access-2026-08-06",
      ipAddress: "203.0.113.42",
      timezone: "America/Toronto",
      timezoneSource: "browser",
      consentedAt: new Date("2026-08-06T14:00:00.000Z"),
    });
    await handle.db.insert(schema.enquiryResearchRuns).values({
      id: "research-call-idempotency",
      enquiryId,
      runAt: new Date("2026-08-06T14:30:00.000Z"),
      provider: "fixture",
      model: "fixture-v1",
      status: "complete",
      summary: "Registered Canadian MSB with a staffed Toronto storefront.",
      brief: {
        executiveSummary: "Registered Canadian MSB with a staffed Toronto storefront.",
        sourceCount: 1, registryStatus: "possible_match", talkingPoints: [], openQuestions: [],
        identity: { businessName: "Amina FX", websiteHost: null, verification: "exact_business_name" },
        callerContext: {
          goal: "Qualify the business for CurrencyDesk early access.",
          publicBusinessContext: ["A public source independently names Amina FX as the stated business."],
          suggestedQuestions: ["Confirm the operating locations and next step."],
        },
        operatorOnly: { matchingEmailApplications: 4, matchingPhoneApplications: 2, matchingBusinessApplications: 1 },
      },
      creditsUsed: 3,
      costCents: 3,
      createdBy: "platform-owner",
    });
    await handle.db.insert(schema.enquiryResearchFacts).values({
      id: "fact-call-timezone",
      researchId: "research-call-idempotency",
      key: "business_timezone",
      value: "America/Toronto",
      sourceUrl: "https://example.test/contact",
      confidence: 0.98,
      method: "website_read",
    });
    await handle.db.insert(schema.enquiryResearchReviews).values({
      id: "review-call-idempotency",
      researchId: "research-call-idempotency",
      reviewedBy: "platform-owner",
    });
    await handle.db.insert(schema.platformSettings).values({
      key: "outbound_calling_enabled",
      value: { enabled: true },
      updatedBy: "platform-owner",
    });

    const dial = vi.fn(async (_request: OutboundCallRequest) => ({
      providerCallId: "CA-test-1",
      conversationId: "conv-test-1",
    }));
    const provider: OutboundCallProvider = { name: "fixture", place: dial };
    const request = {
      db: handle.db,
      enquiryId,
      triggerKey: "call-button-7d4f",
      createdBy: "platform-owner",
      provider,
      now: () => NOW,
      config: {
        agentId: "agent-test",
        agentPhoneNumberId: "phone-test",
        recordingEnabled: true,
      },
    };

    const [left, right] = await Promise.all([
      placeOutboundCall(request),
      placeOutboundCall(request),
    ]);

    expect(dial).toHaveBeenCalledTimes(1);
    expect(left.call.id).toBe(right.call.id);
    expect(left.replayed || right.replayed).toBe(true);
    expect(dial.mock.calls[0]?.[0]).toMatchObject({
      toNumber: "+14165550148",
      agentId: "agent-test",
      agentPhoneNumberId: "phone-test",
    });
    expect(dial.mock.calls[0]?.[0].firstMessage).toMatch(/AI/i);
    expect(dial.mock.calls[0]?.[0].firstMessage).toMatch(/record/i);
    expect(dial.mock.calls[0]?.[0].prompt).toContain("Qualify the business for CurrencyDesk early access.");
    expect(dial.mock.calls[0]?.[0].prompt).toContain("A public source independently names Amina FX");
    expect(dial.mock.calls[0]?.[0].prompt).not.toContain("operatorOnly");
    expect(dial.mock.calls[0]?.[0].prompt).not.toContain("matchingEmailApplications");

    const calls = await handle.db.select().from(schema.enquiryCalls)
      .where(eq(schema.enquiryCalls.enquiryId, enquiryId));
    expect(calls).toHaveLength(1);

    const [enquiry] = await handle.db.select().from(schema.enquiries)
      .where(eq(schema.enquiries.id, enquiryId));
    expect(enquiry?.details).toEqual({
      shopName: "Amina FX",
      phone: "+14165550148",
      monthlyVolume: "$2M – $10M",
    });
  });

  it("refuses do-not-contact and calls outside the lead's local window", async () => {
    await handle.db.update(schema.enquiries).set({ doNotContact: true })
      .where(eq(schema.enquiries.id, "enq-call-idempotency"));
    const provider: OutboundCallProvider = {
      name: "fixture",
      place: vi.fn(async (_request: OutboundCallRequest) => ({ providerCallId: "never", conversationId: "never" })),
    };
    const base = {
      db: handle.db,
      enquiryId: "enq-call-idempotency",
      createdBy: "platform-owner",
      provider,
      config: { agentId: "agent-test", agentPhoneNumberId: "phone-test", recordingEnabled: false },
    };
    await expect(placeOutboundCall({ ...base, triggerKey: "dnc", now: () => NOW }))
      .rejects.toMatchObject({ code: "do_not_contact" });
    expect(provider.place).not.toHaveBeenCalled();

    // Reset only inside this isolated test database to exercise the separate
    // time gate. Product routes deliberately never clear this automatically.
    await handle.db.update(schema.enquiries).set({ doNotContact: false })
      .where(eq(schema.enquiries.id, "enq-call-idempotency"));
    await expect(placeOutboundCall({
      ...base,
      triggerKey: "late-night",
      now: () => new Date("2026-08-07T02:00:00.000Z"), // 22:00 Toronto
    })).rejects.toMatchObject({ code: "outside_call_window" });
    expect(provider.place).not.toHaveBeenCalled();
  });
});
