/* A shop's address on CurrencyDesk, `<slug>.currencydeskos.com`: what one
   may look like, and the words no shop can have.

   Sign-up (routes/signup.ts) and desk creation (onboarding/provision.ts)
   each kept their own list, and the two had drifted: desk creation
   refused "onboarding", sign-up did not. The address check on the Early
   Access page (routes/workspaces.ts) needs the same answer as both, so
   there is one list now, and one shape. "early-access" is new: it is a
   page of ours. */
import { z } from "zod";

const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "app", "www", "sites", "admin", "administrator", "currencydesk", "static",
  "assets", "os-src", "public", "help", "support", "status", "signup", "login",
  "onboarding", "early-access",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/* Two to forty lowercase letters, digits and hyphens, starting and ending
   with a letter or digit. Trimmed and lower-cased on the way in. */
export const slugShape = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug: lowercase letters, digits and hyphens");
