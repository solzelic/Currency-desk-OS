/* A shop's rate page: the record, its address, and what the shop wrote.

   Every shop has one from the day it opens (ensureRatePage), private until
   the owner turns it on. Its address starts as the shop's own site slug,
   or one made from its name; when another shop holds it, the next free
   one (-2, -3, ...). What the shop wrote is validated here (contentPatch)
   and resolved with its defaults on read (resolvedContent), so a page with
   nothing written still says the right thing. */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import type { OpeningDay, RatePageContent } from "../db/schema.js";

export const SLUG_RULE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/* A name as an address: lowercase letters and digits, joined by single
   hyphens, 3 to 40 long. */
export function slugFrom(text: string): string {
  const base = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base.length >= 3 ? base : `${base || "shop"}-fx`.replace(/^-/, "");
}

/* The shop's page, made the first time anyone asks for it. A second
   caller at the same moment, or a shop already holding the address, is
   not an error: the insert does nothing and the loop looks again. */
export async function ensureRatePage(db: Db, tenantId: string) {
  const mine = async () => (await db.select().from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, tenantId)).limit(1))[0];
  const found = await mine();
  if (found) return found;
  const shop = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  if (!shop) throw new Error(`no shop ${tenantId}`);
  const base = shop.siteSlug && SLUG_RULE.test(shop.siteSlug) ? shop.siteSlug : slugFrom(shop.name);
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const slug = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    await db.insert(schema.shopRatePages).values({ tenantId, slug, live: false }).onConflictDoNothing();
    const made = await mine();
    if (made) return made;
  }
  throw new Error(`no free rate page address for ${tenantId}`);
}

/* ---- what the shop writes ---- */
const half = z.number().min(0).max(24).refine((v) => Number.isInteger(v * 2), "Hours go in half hours.");
const day = z.union([
  z.null(),
  z.tuple([half, half]).refine(([opens, closes]) => opens < closes, "A day closes after it opens."),
]);
export const weekShape = z.array(day).length(7);
const codes = z.array(z.string().regex(/^[A-Z]{3}$/)).max(40)
  .refine((list) => new Set(list).size === list.length, "Each currency once.");

/* The business profile fields the editor shares with Settings
   (tenants.site_config). */
export const profileShape = z.object({
  phone: z.string().trim().max(30),
  email: z.string().trim().max(120),
  address: z.string().trim().max(160),
  city: z.string().trim().max(80),
  region: z.string().trim().max(40),
  postal: z.string().trim().max(16),
  week: weekShape,
}).partial().strict();

export const contentPatch = z.object({
  name: z.string().trim().min(1).max(80),
  tagline: z.string().trim().max(120),
  show: z.object({ converter: z.boolean(), hours: z.boolean(), compliance: z.boolean() }).partial().strict(),
  codes: codes.nullable(),
  regulator: z.object({ name: z.string().trim().max(60), number: z.string().trim().max(40), officer: z.string().trim().max(80) }).strict(),
  profile: profileShape,
}).partial().strict().refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");
export type ContentPatch = z.infer<typeof contentPatch>;

/* ---- what the page says, defaults filled in ---- */
export type ResolvedContent = {
  name: string;
  tagline: string;
  show: { converter: boolean; hours: boolean; compliance: boolean };
  codes: string[] | null;
  regulator: { name: string; number: string; officer: string };
};

/* The regulator block starts as the one the shop opened with: its legal
   entity's regulator and registration number. */
async function openedWith(db: Db, tenantId: string) {
  const entity = (await db
    .select({ regulator: schema.legalEntities.jurisdiction, number: schema.legalEntities.msbNumber })
    .from(schema.legalEntities)
    .where(eq(schema.legalEntities.tenantId, tenantId))
    .orderBy(asc(schema.legalEntities.id))
    .limit(1))[0];
  return { name: entity?.regulator ?? "", number: entity?.number ?? "", officer: "" };
}

export async function resolvedContent(db: Db, tenantId: string, shopName: string, content: RatePageContent): Promise<ResolvedContent> {
  return {
    name: content.name || shopName,
    tagline: content.tagline ?? "",
    show: { converter: content.show?.converter ?? true, hours: content.show?.hours ?? true, compliance: content.show?.compliance ?? true },
    codes: content.codes ?? null,
    regulator: content.regulator ?? await openedWith(db, tenantId),
  };
}

/* The week as lines of text, for the storefront's Visit page, which shows
   rows of days and hours: Monday first, equal days joined ("Mon to Fri"),
   a single day by its name, a closed day as "Closed". The same lines the
   rate page draws, so both public sites say the same. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function clock(hours: number): string {
  const h = Math.floor(hours), m = Math.round((hours - h) * 60), h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 || h === 24 ? "am" : "pm"}`;
}
export function hoursFromWeek(week: OpeningDay[]): { days: string; hours: string }[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const key = (day: OpeningDay) => (day ? `${day[0]}-${day[1]}` : "closed");
  const lines: { days: string; hours: string }[] = [];
  for (let i = 0; i < 7;) {
    let j = i;
    while (j + 1 < 7 && key(week[order[j + 1]!]!) === key(week[order[i]!]!)) j++;
    const day = week[order[i]!]!;
    lines.push({
      days: i === j ? DAY_NAMES[order[i]!]! : `${DAY_SHORT[order[i]!]} to ${DAY_SHORT[order[j]!]}`,
      hours: day ? `${clock(day[0])} to ${clock(day[1])}` : "Closed",
    });
    i = j + 1;
  }
  return lines;
}

/* A week read back from storage is used only if it is still the right
   shape: seven days of half hours, each closing after it opens. */
export function validWeek(week: unknown): OpeningDay[] | null {
  const parsed = weekShape.safeParse(week);
  return parsed.success ? (parsed.data as OpeningDay[]) : null;
}
