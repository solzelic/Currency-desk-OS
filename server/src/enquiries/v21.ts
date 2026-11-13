/* ============================================================
   The Early Access v2.1 application, parsed at the edge (CD-179 to
   CD-183).

   The v2.1 page posts `form: "early-access-v2.1"` with every answer in
   `details`. This is that shape, strict: an answer the form cannot give
   is refused, not stored. The page's own `waitlist` and `waitlistReason`
   are read and thrown away; the server decides (waitlistFor). The SAM
   consent is evidence, kept apart from the answers.

   The waitlist (13 Nov build doc, §6 and §9):
     · outside Canada              → "Your place is held"
     · in Canada, not registered   → "Your address is held"
     · in Canada, registered or in progress → accepted
   ============================================================ */
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { randomCharacters, type RandomBytes, secureBytes } from "./cd-id.js";

export const V21_FORM = "early-access-v2.1";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();

export const v21Details = z
  .object({
    firstName: text(60).min(1),
    lastName: text(60).min(1),
    shopName: text(120).min(1),
    /* The full host, `<slug>.currencydeskos.com`, with the same slug rule
       as reserved-slugs.ts. */
    workspace: z.string().trim().toLowerCase().max(80).regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]\.currencydeskos\.com$/),
    website: optionalText(200),
    mode: z.enum(["early_access", "open"]),
    jurisdiction: z.enum(["CA", "outside-canada"]),
    province: optionalText(8),
    country: optionalText(80),
    state: optionalText(80),
    fintracRegistered: z.enum(["Yes", "In progress", "Not yet"]).nullable().optional(),
    msbNumber: z.string().max(40).nullable().optional(),
    /* The page's opinion. Never trusted; see waitlistFor. */
    waitlist: z.boolean().optional(),
    waitlistReason: z.string().max(60).nullable().optional(),
    role: optionalText(120),
    employees: optionalText(60),
    monthlyVolume: optionalText(60),
    branches: optionalText(30),
    runningOn: optionalText(500),
    timeline: optionalText(60),
    phone: text(40).min(1),
    bestTime: z.enum(["call now", "no call"]),
    samConsent: z
      .object({ phone: text(40).min(1), text: text(200).min(1), at: z.string().datetime() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((d) => d.jurisdiction !== "CA" || (!!d.province && !!d.fintracRegistered), {
    message: "A shop in Canada needs its province and its FINTRAC answer",
  })
  .refine((d) => d.jurisdiction !== "outside-canada" || !!d.country, {
    message: "A shop outside Canada needs its country",
  });
export type V21Details = z.infer<typeof v21Details>;

export type WaitlistReason = "outside-canada" | "not-fintrac-registered";

export function waitlistFor(d: Pick<V21Details, "jurisdiction" | "fintracRegistered">): WaitlistReason | null {
  if (d.jurisdiction === "outside-canada") return "outside-canada";
  if (d.fintracRegistered === "Not yet") return "not-fintrac-registered";
  return null;
}

/* The answers as stored: what the applicant typed, without the page's
   waitlist opinion or the consent evidence. */
export function answersOf(d: V21Details): Record<string, unknown> {
  const { waitlist: _waitlist, waitlistReason: _reason, samConsent: _consent, ...answers } = d;
  return answers;
}

/* The waitlister's code to give another shop: the first word of the shop
   name (letters and digits, up to 8, or SHOP) and four characters from
   the ID alphabet, easy to say over the phone. Unique. */
export function inviteWord(shopName: string): string {
  const first = shopName.trim().split(/\s+/)[0] ?? "";
  return first.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "SHOP";
}

export async function issueInviteCode(db: Db, shopName: string, random: RandomBytes = secureBytes): Promise<string> {
  const word = inviteWord(shopName);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = `${word}-${randomCharacters(4, random)}`;
    const taken = await db.select({ id: schema.enquiries.id }).from(schema.enquiries).where(eq(schema.enquiries.inviteCode, code)).limit(1);
    if (!taken.length) return code;
  }
  throw new Error(`No free invite code for ${word} after 8 tries`);
}

/* A shop outside Canada's place in line for its own country: one after
   the highest place given in that country, so a declined application
   does not hand its place to the next. Display only; two applications
   in the same instant may share a number, which nothing depends on. */
export async function nextPlaceInLine(db: Db, country: string): Promise<number> {
  const [row] = await db
    .select({ top: sql<number | null>`max(${schema.enquiries.placeInLine})` })
    .from(schema.enquiries)
    .where(and(
      eq(schema.enquiries.waitlistReason, "outside-canada"),
      ne(schema.enquiries.status, "declined"),
      sql`lower(${schema.enquiries.details} ->> 'country') = ${country.trim().toLowerCase()}`,
    ));
  return Number(row?.top ?? 0) + 1;
}
