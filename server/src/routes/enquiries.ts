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
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { contactReceivedEmail, replyToAddress, sendEmail } from "../email.js";
import { moveTo } from "../onboarding/pipeline.js";
import { forgetClaimedCount } from "./early-access.js";

/* Free-text the sender controls. Kept as a blob because the two forms ask
   very different questions and both will keep changing in design; what
   matters server-side is that it is small, flat and printable. */
const detailShape = z.record(
  z.string().max(40),
  z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
);

const enquiryBody = z.object({
  kind: z.enum(["early_access", "contact"]),
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().max(120).optional(),
  details: detailShape.optional(),
});

const THROTTLE_MS = 60 * 1000;
const THROTTLE_MAX = 3;

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
  // one bucket per sender, swept lazily — this endpoint is low-traffic and
  // the map only ever holds addresses seen in the last minute
  const recent = new Map<string, number[]>();

  app.post("/api/enquiries", async (req, reply) => {
    const parsed = enquiryBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    }
    const { kind, email, name, details } = parsed.data;

    const now = Date.now();
    const hits = (recent.get(email) ?? []).filter((t) => now - t < THROTTLE_MS);
    if (hits.length >= THROTTLE_MAX) {
      return reply.code(429).send({ error: "too_many", detail: "Give it a minute, then try again." });
    }
    recent.set(email, [...hits, now]);
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < THROTTLE_MS)) recent.delete(key);
    }

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
    if (kind === "early_access") {
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
    const tel = normalizePhone(kept.phone);
    if (tel) {
      kept.phone = tel.phone;
      if (!tel.ok) kept.phoneUnparsed = String((details ?? {}).phone ?? "");
    }

    // the site's "N of 100 claimed" counts this row — show it straight away
    forgetClaimedCount();
    const [row] = await db.insert(schema.enquiries).values({
      id: randomUUID(),
      reference,
      kind,
      email,
      name: name ?? null,
      details: kept,
      charterNo,
    }).returning();

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
    if (kind === "early_access" && row) {
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
        ...Object.entries(details ?? {})
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
    return reply.code(201).send({ ok: true, reference, charterNo });
  });
}
