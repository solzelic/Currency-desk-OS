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
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { sendEmail } from "../email.js";
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
function makeReference(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return "CD-" + [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const LABELS: Record<string, string> = {
  early_access: "Early access application",
  contact: "Contact form",
};

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
    // the site's "N of 100 claimed" counts this row — show it straight away
    forgetClaimedCount();
    await db.insert(schema.enquiries).values({
      id: randomUUID(),
      reference,
      kind,
      email,
      name: name ?? null,
      details: details ?? {},
    });

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

    return reply.code(201).send({ ok: true, reference });
  });
}
