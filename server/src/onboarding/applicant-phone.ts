/* The mobile a shop types while opening a desk is stored on the desk
   setup blob. The number placeOutboundCall dials is enquiries.details.phone.
   Those were two different places, so a shop that left the application
   phone blank could not be called after they signed up.

   This copies the applicant's own mobile onto that enquiry field when it
   is still empty. It is not research, and it does not place a call.

   Canada pack only. The country is the one they stated (CA or Canada) —
   an unnamed country is not treated as Canada. The number is the local
   shape the early-access form already stores: ten digits, country code 1.
   A number that does not normalize to that shape is left absent. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { normalizePhone } from "../routes/enquiries.js";

const CANADA = new Set(["ca", "canada"]);

export function canadaDeskMobile(setup: unknown): string | null {
  if (!setup || typeof setup !== "object") return null;
  const record = setup as Record<string, unknown>;
  const country = typeof record.country === "string" ? record.country.trim().toLowerCase() : "";
  if (!CANADA.has(country)) return null;
  const tel = normalizePhone(record.phone);
  if (!tel?.ok || !/^\+1\d{10}$/.test(tel.phone)) return null;
  return tel.phone;
}

const statedPhone = (details: Record<string, unknown>): string => {
  const value = details.phone;
  if (value == null) return "";
  return String(value).trim();
};

/* An application phone, even one we could not parse, is the number they
   already asked us to use. The setup mobile is only a stand-in for a
   shop that never gave one. Replacing either would dial somebody else. */
export async function landApplicantStatedPhone(
  db: Db,
  rows: Array<typeof schema.enquiries.$inferSelect>,
  setup: unknown,
  actor: string,
): Promise<void> {
  const phone = canadaDeskMobile(setup);
  if (!phone) return;
  for (const row of rows) {
    const details = { ...((row.details ?? {}) as Record<string, unknown>) };
    if (statedPhone(details)) continue;
    details.phone = phone;
    await db.update(schema.enquiries).set({ details }).where(eq(schema.enquiries.id, row.id));
    /* Process history otherwise shows the number with no origin, and an
       operator cannot tell it from a researched one. The event is the
       origin: desk setup, not research, and not a call. */
    await db.insert(schema.enquiryGrowthEvents).values({
      id: randomUUID(),
      enquiryId: row.id,
      type: "applicant_phone_on_call_path",
      detail: { source: "desk_setup" },
      actor,
    });
  }
}
