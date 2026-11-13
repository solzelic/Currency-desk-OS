/* ============================================================
   The CurrencyDesk ID an applicant is handed (Early Access v2.1, CD-181).

     CD-YORK-7K42
     CD + four letters from the shop name + four random characters

   The four characters come from an alphabet with no 0, O, 1, I or L,
   so it can be read out over the phone. They are drawn from a secure
   random source by rejection sampling: 31 does not divide 256, and
   `byte % 31` would favour the first nine characters.

   Minted by the server when an application is accepted, and never by a
   browser (AGENTS.md: never invent IDs in the browser). It is the
   person's, not the shop's. It is unique across applications and staff
   (`enquiries.cd_id` and `staff_users.cd_id` both carry a unique index,
   and issueCdId checks both) and never reused.

   Today's staff IDs are numbered per desk, `CD-YORK-0042`
   (auth/cdid.ts). The two shapes meet when the sign-up build makes this
   ID the owner's sign-in; that build widens the sign-in format check.
   Nothing here touches sign-in.

   Open (SIGNUP-LOGIC §14 Q1): the letters for a shop name that is short,
   numeric or not in Latin script. Until it is decided, the letters are
   padded with X: "Wu" is WUXX, "123" and "東京両替" are XXXX.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

export const CD_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CD_ID_RE = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;

/* A source of random bytes. The default is the platform's secure one;
   tests pass a seeded one. */
export type RandomBytes = (count: number) => Uint8Array;
export const secureBytes: RandomBytes = (count) => {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/* 31 × 8 = 248: a byte at or above it is thrown away, so every
   character is equally likely. */
const ACCEPT_BELOW = CD_ID_ALPHABET.length * Math.floor(256 / CD_ID_ALPHABET.length);

export function randomCharacters(count: number, random: RandomBytes = secureBytes): string {
  let out = "";
  while (out.length < count) {
    for (const byte of random(count * 2)) {
      if (byte >= ACCEPT_BELOW) continue;
      out += CD_ID_ALPHABET[byte % CD_ID_ALPHABET.length];
      if (out.length === count) break;
    }
  }
  return out;
}

/* The first four Latin letters of the shop name, accents folded, X-padded. */
export function cdIdLetters(shopName: string): string {
  const letters = shopName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return (letters + "XXXX").slice(0, 4);
}

export function mintCdId(shopName: string, random: RandomBytes = secureBytes): string {
  return `CD-${cdIdLetters(shopName)}-${randomCharacters(4, random)}`;
}

/* What a person types back, in the ID's shape: `cdyork7k42`,
   `cd york 7k42` and `CD-YORK-7K42` are the same ID. Null when it is not
   one. The sign-up build reuses this. */
export function normalizeCdIdInput(raw: unknown): string | null {
  const compact = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 10 || !compact.startsWith("CD")) return null;
  const id = `CD-${compact.slice(2, 6)}-${compact.slice(6)}`;
  return CD_ID_RE.test(id) ? id : null;
}

/* A fresh ID that no application and no staff member holds. Eight tries
   is far more than enough (31^4 = 923,521 per set of letters); running
   out means something is wrong and says so. The unique indexes are the
   last word if two requests race. */
export async function issueCdId(db: Db, shopName: string, random: RandomBytes = secureBytes): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = mintCdId(shopName, random);
    const asApplication = await db.select({ id: schema.enquiries.id }).from(schema.enquiries).where(eq(schema.enquiries.cdId, id)).limit(1);
    if (asApplication.length) continue;
    const asStaff = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.cdId, id)).limit(1);
    if (asStaff.length) continue;
    return id;
  }
  throw new Error(`No free CurrencyDesk ID for ${cdIdLetters(shopName)} after 8 tries`);
}
