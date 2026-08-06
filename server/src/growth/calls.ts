/* ============================================================
   Outbound lead calls.

   The reservation insert is deliberately before the provider request. If a
   browser retries or an operator double-clicks, only the request that created
   the row may reach a telephone network. A crashed reservation can strand a
   call in `placing`; that is safer than guessing and ringing a person twice.
   ============================================================ */
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "../db/index.js";

export type OutboundCallRequest = {
  toNumber: string;
  agentId: string;
  agentPhoneNumberId: string;
  firstMessage: string;
  prompt: string;
  dynamicVariables: Record<string, string>;
  recordingEnabled: boolean;
};

export type OutboundCallResult = {
  providerCallId: string | null;
  conversationId: string | null;
};

export interface OutboundCallProvider {
  name: string;
  place(request: OutboundCallRequest): Promise<OutboundCallResult>;
}

export type OutboundCallConfig = {
  agentId: string;
  agentPhoneNumberId: string;
  recordingEnabled: boolean;
};

export class CallRefused extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
  }
}

const text = (value: unknown): string | null => {
  const kept = typeof value === "string" ? value.trim() : "";
  return kept || null;
};

export function localHour(at: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const value = Number(parts.find((part) => part.type === "hour")?.value);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function callingEnabled(db: Db): Promise<boolean> {
  const row = (await db.select().from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, "outbound_calling_enabled")).limit(1))[0];
  return row?.value?.enabled === true;
}

async function latestTimezone(db: Db, enquiryId: string): Promise<string | null> {
  const consent = (await db.select().from(schema.enquiryContactConsents)
    .where(eq(schema.enquiryContactConsents.enquiryId, enquiryId))
    .orderBy(desc(schema.enquiryContactConsents.consentedAt)).limit(1))[0];
  if (text(consent?.timezone)) return text(consent?.timezone);

  /* Older applications have no browser-observed timezone. A sourced
     research fact may fill the gap; an unsourced guess may not. */
  const runs = await db.select().from(schema.enquiryResearchRuns)
    .where(and(
      eq(schema.enquiryResearchRuns.enquiryId, enquiryId),
      eq(schema.enquiryResearchRuns.status, "complete"),
    )).orderBy(desc(schema.enquiryResearchRuns.runAt));
  for (const run of runs) {
    const fact = (await db.select().from(schema.enquiryResearchFacts)
      .where(and(
        eq(schema.enquiryResearchFacts.researchId, run.id),
        eq(schema.enquiryResearchFacts.key, "business_timezone"),
      )).limit(1))[0];
    if (text(fact?.sourceUrl) && text(fact?.value)) return text(fact?.value);
  }
  return null;
}

export async function placeOutboundCall(input: {
  db: Db;
  enquiryId: string;
  triggerKey: string;
  createdBy: string;
  provider: OutboundCallProvider;
  config: OutboundCallConfig;
  now?: () => Date;
}): Promise<{ call: typeof schema.enquiryCalls.$inferSelect; replayed: boolean }> {
  const now = input.now?.() ?? new Date();
  if (!(await callingEnabled(input.db))) {
    throw new CallRefused("calling_disabled", "Outbound calling is stopped by the platform kill switch.");
  }

  const enquiry = (await input.db.select().from(schema.enquiries)
    .where(eq(schema.enquiries.id, input.enquiryId)).limit(1))[0];
  if (!enquiry || enquiry.kind !== "early_access") {
    throw new CallRefused("not_found", "Application not found.", 404);
  }
  if (enquiry.doNotContact) {
    throw new CallRefused("do_not_contact", "This applicant asked not to be contacted.");
  }

  const consent = (await input.db.select().from(schema.enquiryContactConsents)
    .where(eq(schema.enquiryContactConsents.enquiryId, enquiry.id))
    .orderBy(desc(schema.enquiryContactConsents.consentedAt)).limit(1))[0];
  if (!consent) {
    throw new CallRefused("consent_absent", "No recorded permission to contact this applicant.");
  }

  /* The only dialable number is the one the applicant submitted. Research
     can discover numbers, but discovery is not consent. */
  const phone = text((enquiry.details as Record<string, unknown> | null)?.phone);
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    throw new CallRefused("phone_absent", "The applicant did not provide a dialable number.");
  }

  const timezone = await latestTimezone(input.db, enquiry.id);
  if (!timezone) {
    throw new CallRefused("timezone_absent", "The lead's timezone is unknown, so a lawful call window cannot be proved.");
  }
  const hour = localHour(now, timezone);
  if (hour == null) {
    throw new CallRefused("timezone_invalid", "The lead's timezone is not valid.");
  }
  if (hour < 9 || hour >= 21) {
    throw new CallRefused("outside_call_window", `Calls are allowed from 09:00 to 21:00 in ${timezone}; it is currently ${String(hour).padStart(2, "0")}:00.`);
  }

  const research = (await input.db.select().from(schema.enquiryResearchRuns)
    .where(and(
      eq(schema.enquiryResearchRuns.enquiryId, enquiry.id),
      eq(schema.enquiryResearchRuns.status, "complete"),
    )).orderBy(desc(schema.enquiryResearchRuns.runAt)).limit(1))[0];
  if (!research?.summary) {
    throw new CallRefused("research_absent", "Research this application before calling.");
  }

  const triggerKey = `${enquiry.id}:${input.triggerKey.trim()}`;
  if (!input.triggerKey.trim() || triggerKey.length > 220) {
    throw new CallRefused("invalid_trigger", "A bounded idempotency key is required.", 400);
  }
  const callId = randomUUID();
  const inserted = await input.db.insert(schema.enquiryCalls).values({
    id: callId,
    enquiryId: enquiry.id,
    researchId: research.id,
    triggerKey,
    provider: input.provider.name,
    agentId: input.config.agentId,
    phone,
    timezone,
    status: "placing",
    requestedAt: now,
    createdBy: input.createdBy,
  }).onConflictDoNothing({ target: schema.enquiryCalls.triggerKey }).returning();

  if (!inserted[0]) {
    const existing = (await input.db.select().from(schema.enquiryCalls)
      .where(eq(schema.enquiryCalls.triggerKey, triggerKey)).limit(1))[0];
    if (!existing) throw new Error("Call reservation disappeared.");
    return { call: existing, replayed: true };
  }

  const applicantName = text(enquiry.name) ?? "there";
  const recorded = input.config.recordingEnabled ? " This call is being recorded." : "";
  const firstMessage = `Hello ${applicantName}. I'm SAM, an AI assistant calling from CurrencyDesk about the application you submitted.${recorded} Is now still a good time?`;
  const prompt = [
    "You are SAM, CurrencyDesk's AI sales assistant.",
    "You must identify yourself as an AI and announce recording in the opening line when recording is enabled.",
    "The person asked to be contacted through CurrencyDesk's early-access form.",
    "If they ask not to be contacted, confirm immediately, end politely, and invoke the configured do-not-contact tool.",
    "Never claim an inferred fact came from the applicant. Treat the research below as sourced background, not as their own words.",
    "Research context:",
    research.summary,
  ].join("\n");

  try {
    const placed = await input.provider.place({
      toNumber: phone,
      agentId: input.config.agentId,
      agentPhoneNumberId: input.config.agentPhoneNumberId,
      firstMessage,
      prompt,
      dynamicVariables: {
        enquiry_id: enquiry.id,
        enquiry_reference: enquiry.reference,
        applicant_name: applicantName,
        research_summary: research.summary,
      },
      recordingEnabled: input.config.recordingEnabled,
    });
    await input.db.update(schema.enquiryCalls).set({
      status: "placed",
      placedAt: now,
      providerCallId: placed.providerCallId,
      conversationId: placed.conversationId,
    }).where(eq(schema.enquiryCalls.id, callId));
  } catch (error) {
    await input.db.update(schema.enquiryCalls).set({
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 1000) : "Provider request failed.",
    }).where(eq(schema.enquiryCalls.id, callId));
    throw new CallRefused("provider_failed", "The call provider did not accept the call.", 502);
  }

  const call = (await input.db.select().from(schema.enquiryCalls)
    .where(eq(schema.enquiryCalls.id, callId)).limit(1))[0]!;
  return { call, replayed: false };
}
