/* ============================================================
   What the public site sends us.

     POST /api/enquiries  { kind, email, name?, ...details }
       → 201 { reference }

   Two forms feed this: the Early Access application and the contact
   page. Both promise the sender a reply, so both have to land somewhere
   a person will actually look — the row is the record, and the platform
   operators get an email so nobody has to remember to check.

   Unauthenticated and public, so it is deliberately narrow: a closed set
   of kinds, a size cap on the free-text details, and a per-address
   throttle. Nothing here creates a tenant or an account — an application
   is an application. The desk itself is created later, from the OS's own
   new-desk wizard, once the operator is invited.

   Early Access v2.1 (CD-179 to CD-183) posts `form: "early-access-v2.1"`
   with every answer typed (enquiries/v21.ts), and may post kind "signup"
   when the site runs open sign-up. The server decides the waitlist, mints
   the CurrencyDesk ID for an accepted application (enquiries/cd-id.ts),
   and gives a waitlisted shop outside Canada its place in line and an
   invite code. The reply carries them:
     → 201 { ok, reference, charterNo, cdId, invite?: { code }, place? }
   The old page's flat answers keep working until /signup switches over.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { contactReceivedEmail, replyToAddress, sendEmail } from "../email.js";
import { clientIp } from "../auth/client-ip.js";
import { issueCdId } from "../enquiries/cd-id.js";
import { normalizeMsb } from "../enquiries/msb.js";
import { answersOf, issueInviteCode, nextPlaceInLine, V21_FORM, v21Details, waitlistFor, type WaitlistReason } from "../enquiries/v21.js";
import { moveTo } from "../onboarding/pipeline.js";
import { forgetClaimedCount } from "./early-access.js";

/* Free-text the sender controls. Kept as a blob because the two forms ask
   very different questions and both will keep changing in design; what
   matters server-side is that it is small, flat and printable. */
const detailShape = z.record(
  z.string().max(40),
  z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
);

/* The envelope. `details` is read in a second step, by the form that sent
   it: the v2.1 shape (strict, typed, nested consent) or the old flat one. */
const enquiryBody = z.object({
  kind: z.enum(["early_access", "signup", "contact"]),
  form: z.literal(V21_FORM).optional(),
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().max(120).optional(),
  details: z.unknown().optional(),
  /* Browser-observed submission context is evidence about consent, not an
     answer the applicant typed, so it never enters `details`. */
  contactContext: z.object({ timezone: z.string().trim().max(100).optional() }).optional(),
});

export const EARLY_ACCESS_FORM_VERSION = "early-access-2026-08-06";
/* The consent evidence written for a v2.1 application names its form. */
export const V21_FORM_VERSION = "early-access-v2.1-2026-11-13";

const validTimezone = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
};

const THROTTLE_MS = 60 * 1000;
const THROTTLE_MAX = 3;

/* Per client address as well as per email: one address cannot post a
   stream of applications under made-up emails. Twenty an hour unless
   ENQUIRY_IP_MAX says otherwise; the browser suite, which posts every
   application from one address, sets it in playwright.config.ts. Render
   does not. */
const ENQUIRY_IP_MAX_DEFAULT = 20;
const IP_WINDOW_MS = 60 * 60 * 1000;
export function enquiryIpMax(): number {
  const raw = process.env.ENQUIRY_IP_MAX;
  if (raw == null || raw.trim() === "") return ENQUIRY_IP_MAX_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : ENQUIRY_IP_MAX_DEFAULT;
}
// one bucket per sender and one per client address, swept lazily — this
// endpoint is low-traffic and the maps only hold keys seen recently
const recent = new Map<string, number[]>();
const byAddress = new Map<string, number[]>();
/* For tests, which reuse one server. */
export function resetEnquiryThrottle(): void {
  recent.clear();
  byAddress.clear();
}

/* Human-quotable, hard to guess, and unique in practice: CD- plus six
   characters from an alphabet with no 0/O/1/I to misread over the phone. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function makeReference(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return "CD-" + [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const LABELS: Record<string, string> = {
  early_access: "Early access application",
  signup: "Open sign-up",
  contact: "Contact form",
};

/* The number we ring.

   Stored E.164-ish — a plus, a country code, digits, nothing else — because
   that is the only shape that can be dialled, texted, and compared for
   "have we already got this person". How it is displayed is the panel's
   business; how it was typed is nobody's.

   Deliberately NOT rejected when it looks wrong. This is a public form and
   a number we cannot parse is still a lead: somebody typing an extension,
   a country we did not list, or their number with a word in it should not
   lose their place in the cohort over it. We keep what they typed, mark it
   unparsed, and let a person look. */
export function normalizePhone(raw: unknown): { phone: string; ok: boolean } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D+/g, "");
  if (!digits) return { phone: s.slice(0, 40), ok: false };
  // a leading + is the caller's own country code; otherwise assume +1, which
  // is where every desk is today and is what the form's default sends
  const plus = s.trimStart().startsWith("+");
  const e164 = plus ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  // 8 is the shortest real national number, 15 the E.164 ceiling
  return { phone: e164.slice(0, 17), ok: digits.length >= 8 && digits.length <= 15 };
}

export function registerEnquiryRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/enquiries", async (req, reply) => {
    const parsed = enquiryBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    }
    const { kind, form, email, name, contactContext } = parsed.data;

    /* The answers, by the form that sent them. Only the v2.1 page may post
       an open sign-up, and only with the v2.1 answers. */
    const isV21 = form === V21_FORM;
    if (!isV21 && kind === "signup") return reply.code(400).send({ error: "invalid_request", detail: "kind" });
    if (isV21 && kind === "contact") return reply.code(400).send({ error: "invalid_request", detail: "kind" });
    let details: Record<string, unknown> | undefined;
    let v21: ReturnType<typeof v21Details.parse> | null = null;
    if (isV21) {
      const typed = v21Details.safeParse(parsed.data.details);
      if (!typed.success) return reply.code(400).send({ error: "invalid_request", detail: typed.error.issues[0]?.message });
      const msb = normalizeMsb(typed.data.msbNumber);
      if (!msb.ok) return reply.code(400).send({ error: "invalid_msb", detail: "An MSB number is M followed by 8 digits." });
      v21 = { ...typed.data, msbNumber: msb.value };
      details = answersOf(v21);
    } else if (parsed.data.details !== undefined) {
      const flat = detailShape.safeParse(parsed.data.details);
      if (!flat.success) return reply.code(400).send({ error: "invalid_request", detail: flat.error.issues[0]?.message });
      details = flat.data;
    }

    const now = Date.now();
    const hits = (recent.get(email) ?? []).filter((t) => now - t < THROTTLE_MS);
    if (hits.length >= THROTTLE_MAX) {
      return reply.code(429).send({ error: "too_many", detail: "Give it a minute, then try again." });
    }
    const address = clientIp(req);
    const fromAddress = (byAddress.get(address) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    if (fromAddress.length >= enquiryIpMax()) {
      return reply.code(429).send({ error: "too_many", detail: "Give it a minute, then try again." });
    }
    recent.set(email, [...hits, now]);
    byAddress.set(address, [...fromAddress, now]);
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < THROTTLE_MS)) recent.delete(key);
    }
    for (const [key, times] of byAddress) {
      if (!times.some((t) => now - t < IP_WINDOW_MS)) byAddress.delete(key);
    }

    /* v2.1: the server's own waitlist decision, never the page's. */
    const waitlistReason: WaitlistReason | null = v21 ? waitlistFor(v21) : null;

    const reference = makeReference();
    /* An applicant's place in the founding cohort, which they keep — it is
       printed on the charter card the page hands them at the end.

       The card used to show a random number between 38 and 64, so two people
       could be handed the same Nº on a thing that says "on the record". It is
       their real position now: the next one nobody has had.

       Counted off the highest ever issued rather than off how many rows
       exist, so a declined application does not hand its number to the next
       applicant — the card in somebody's drawer has to keep meaning them.
       And an address that applies twice keeps the number it was already
       given rather than taking a second place in line. */
    let charterNo: number | null = null;
    /* A waitlisted shop is not a founding operator yet, and an open sign-up
       has no cohort: neither takes a place. */
    if (kind === "early_access" && !waitlistReason) {
      const mine = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)))
        .filter((e) => e.kind === "early_access" && e.charterNo != null);
      if (mine.length) {
        charterNo = Math.min(...mine.map((e) => e.charterNo!));
      } else {
        const issued = (await db.select({ n: schema.enquiries.charterNo }).from(schema.enquiries)).map((r) => r.n ?? 0);
        charterNo = (issued.length ? Math.max(...issued) : 0) + 1;
      }
    }

    /* The phone number is the one field on this form that gets acted on
       rather than read — somebody rings it within minutes of approval — so
       it is stored in a dialable shape, and whether we could make sense of
       it is recorded next to it rather than left for the caller to find
       out. */
    const kept: Record<string, unknown> = { ...(details ?? {}) };
    /* stagingFresh is not an answer. The staging door writes its own row.
       A public post cannot use this key to leave the founding count. */
    delete kept.stagingFresh;
    const tel = normalizePhone(kept.phone);
    if (tel) {
      kept.phone = tel.phone;
      if (!tel.ok) kept.phoneUnparsed = String((details ?? {}).phone ?? "");
    }

    /* v2.1: what the server hands back. An accepted application gets its
       CurrencyDesk ID; a shop outside Canada gets its place in line for its
       country and a code to give another shop. */
    const cdId = v21 && !waitlistReason ? await issueCdId(db, v21.shopName) : null;
    const outside = v21 && waitlistReason === "outside-canada" ? v21 : null;
    const inviteCode = outside ? await issueInviteCode(db, outside.shopName) : null;
    const placeInLine = outside ? await nextPlaceInLine(db, outside.country ?? "") : null;

    // the site's "N of 100 claimed" counts this row — show it straight away
    forgetClaimedCount();
    const enquiryId = randomUUID();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx.insert(schema.enquiries).values({
        id: enquiryId,
        reference,
        kind,
        email,
        name: name ?? null,
        details: kept,
        charterNo,
        cdId,
        waitlistReason,
        inviteCode,
        placeInLine,
      }).returning();
      /* The contact consent is what the growth caller dials on
         (growth/calls.ts). A v2.1 applicant who chose "No call, thanks",
         and every waitlisted one (the page offers them no call), gets
         none: no consent on record, no call. */
      if (kind !== "contact" && (!v21 || (v21.samConsent && !waitlistReason))) {
        await tx.insert(schema.enquiryContactConsents).values({
          id: randomUUID(),
          enquiryId,
          formVersion: v21 ? V21_FORM_VERSION : EARLY_ACCESS_FORM_VERSION,
          /* The applicant's address, through Cloudflare and Render's proxy,
             not the proxy's own (auth/client-ip.ts). */
          ipAddress: address,
          userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null,
          timezone: validTimezone(contactContext?.timezone),
          timezoneSource: validTimezone(contactContext?.timezone) ? "browser" : null,
        });
        /* Provider calls do not belong in a public form request. The lead,
           consent evidence and durable job commit together; a worker can
           retry later without making the applicant wait or submit twice. */
        const jobId = randomUUID();
        await tx.insert(schema.enquiryGrowthJobs).values({ id: jobId, enquiryId, requestedBy: "system" });
        await tx.insert(schema.enquiryGrowthEvents).values([
          { id: randomUUID(), enquiryId, type: "application_received", detail: { reference }, actor: "system" },
          { id: randomUUID(), enquiryId, type: "research_queued", detail: { jobId }, actor: "system" },
        ]);
      }
      return inserted;
    });

    /* An application goes straight into review, and the applicant is told so
       in the same breath.

       There used to be a stage before this one — the row landed unacknowledged
       and waited for somebody to notice it. That is not a stage anybody works,
       it is a gap: the applicant hears nothing while it lasts, and the only
       thing an operator ever did with it was move it to review. So arriving IS
       being in review, and the acknowledgement goes out automatically.

       Through moveTo rather than a second sending path here, so there is one
       answer to "what happens when an application reaches review?" — the same
       one whether a person, this route, or a reviewer agent caused it. Best
       effort: the row is saved, and a mail outage must never cost us the
       application. */
    if (kind !== "contact" && row) {
      await moveTo(db, row, "reviewing", "system").catch(() => null);
    }

    // Tell the operators. Best-effort: the enquiry is already saved, so a
    // mail outage costs a notification, never the application itself.
    const to = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length) {
      const lines = [
        `${LABELS[kind]} — ${reference}`,
        "",
        `From:  ${name ? `${name} <${email}>` : email}`,
        ...(cdId ? [`CurrencyDesk ID:  ${cdId}`] : []),
        ...(waitlistReason ? [`Waitlist:  ${waitlistReason}${placeInLine ? ` (place ${placeInLine})` : ""}`] : []),
        ...Object.entries(kept)
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => `${k}:  ${String(v)}`),
      ];
      const text = lines.join("\n");
      await Promise.all(
        to.map((addr) =>
          sendEmail(addr, `${LABELS[kind]} · ${reference}`, {
            text,
            html: `<pre style="font:14px ui-monospace,monospace;white-space:pre-wrap">${text
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")}</pre>`,
          }).catch(() => "failed" as const),
        ),
      );
    }

    /* A4 · and now tell THEM.

       An application already gets an acknowledgement the moment it lands.
       A message from the contact page got nothing at all: the page said
       somebody would reply within a business day, and then there was
       silence until a person got to it — which over a weekend is two days
       of wondering whether it sent.

       Sent after the operator alert and never allowed to break the
       submission: their note is already recorded, and failing the request
       because our acknowledgement did not send would be losing the thing
       that mattered to protect the thing that did not. */
    if (kind === "contact") {
      const d = (details ?? {}) as Record<string, unknown>;
      const mail = contactReceivedEmail({
        name, reference,
        topic: d.topic == null ? null : String(d.topic),
        message: d.message == null ? null : String(d.message),
      });
      await sendEmail(email, mail.subject, { text: mail.text, html: mail.html, replyTo: replyToAddress() })
        .catch(() => "failed" as const);
    }

    // charterNo is the number printed on their card; null for a message
    if (!v21) return reply.code(201).send({ ok: true, reference, charterNo });
    return reply.code(201).send({
      ok: true, reference, charterNo, cdId,
      ...(inviteCode ? { invite: { code: inviteCode } } : {}),
      ...(placeInLine ? { place: placeInLine } : {}),
    });
  });
}
