/* ============================================================
   When SAM calls, Early Access v2.1 (CD-180, CD-181).

     POST /api/enquiries/:reference/sam  { at: ISO time | null }
       → 200 { ok, at, zone }

   The "Call later" picker on the You're in screen. `at` is the time the
   applicant tapped, or null for "as soon as calling hours allow". The
   server moves it into calling hours in the applicant's own zone
   (enquiries/sam.ts) and keeps it on the application, in UTC with the
   zone. The answer is the time it kept, which the page shows.

   Only an accepted v2.1 application, with consent on record for the
   number it gave and no stop after it. Anything else is 404 or 409, and
   says nothing about whose reference it is. Public: the reference is the
   setup code the applicant was handed, and the address is rate limited.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { clientIp } from "../auth/client-ip.js";
import { allowBooking, clampToCallingHours, zoneFor } from "../enquiries/sam.js";

const REFERENCE = /^CD-[2-9A-HJ-NP-Z]{6}$/;
const AHEAD_MS = 14 * 24 * 3600 * 1000;
const body = z.object({ at: z.string().datetime({ offset: true }).nullable().optional() }).strict();

export function registerEnquirySamRoutes(app: FastifyInstance, db: Db): void {
  app.post<{ Params: { reference: string } }>("/api/enquiries/:reference/sam", async (req, reply) => {
    const reference = String(req.params.reference ?? "").trim().toUpperCase();
    if (!REFERENCE.test(reference)) return reply.code(404).send({ error: "not_found" });
    if (!allowBooking(clientIp(req))) return reply.code(429).send({ error: "too_many", detail: "Give it a minute, then try again." });
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_time" });

    const [row] = await db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, reference)).limit(1);
    if (!row || row.status !== "invited" || !row.cdId || row.waitlistReason) {
      return reply.code(404).send({ error: "not_found" });
    }

    /* consent for the number they gave, and no stop since */
    const details = (row.details ?? {}) as Record<string, unknown>;
    const [latest] = await db.select().from(schema.enquiryCallConsents)
      .where(eq(schema.enquiryCallConsents.enquiryId, row.id))
      .orderBy(desc(schema.enquiryCallConsents.at)).limit(1);
    if (!latest || latest.event !== "consent" || latest.phone !== String(details.phone ?? "")) {
      return reply.code(409).send({ error: "no_consent", detail: "SAM has no permission to call this number." });
    }

    const now = Date.now();
    const asked = parsed.data.at ? new Date(parsed.data.at) : new Date(now);
    if (asked.getTime() > now + AHEAD_MS) return reply.code(400).send({ error: "invalid_time", detail: "Pick a time in the next two weeks." });
    const [browser] = await db.select({ timezone: schema.enquiryContactConsents.timezone }).from(schema.enquiryContactConsents)
      .where(eq(schema.enquiryContactConsents.enquiryId, row.id))
      .orderBy(desc(schema.enquiryContactConsents.consentedAt)).limit(1);
    const zone = zoneFor(browser?.timezone, typeof details.province === "string" ? details.province : null);
    /* never in the past: a time already gone is "now" */
    const at = clampToCallingHours(new Date(Math.max(asked.getTime(), now)), zone);

    await db.update(schema.enquiries).set({ samCallAt: at, samCallZone: zone }).where(eq(schema.enquiries.id, row.id));
    return { ok: true, at: at.toISOString(), zone };
  });
}
