/* Health cards are not valid ID.

   Ontario's Health Cards and Numbers Control Act, 1991 bars a business
   outside health care from collecting or using a health number. FINTRAC
   says not to use a health card where provincial law prohibits it.

   PR #108 owns the signed document catalogue
   (server/src/ledger/id-document-types.mjs). That file is not on main,
   and this change does not edit that branch. Its isHealthCardType
   matches the exact name "health card" after trim and lower case.
   This detector is the read-side boundary. It includes that catalogue
   name, any spacing or case of it, and the aliases a desk has typed:
   OHIP, RAMQ, MSP, Alberta Health, Care Card. */

/* Short names match a whole word, so "mspaint" is not MSP. "Care Card"
   matches as a phrase, including "BC Care Card". */
const WORD_ALIASES = new Set(["ohip", "ramq", "msp"]);

export function isHealthCardType(value: unknown): boolean {
  const spaced = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!spaced) return false;
  const compact = spaced.replace(/ /g, "");
  if (compact.includes("healthcard")) return true;
  if (compact.includes("carecard")) return true;
  if (spaced.split(" ").some((word) => WORD_ALIASES.has(word))) return true;
  if (spaced.includes("alberta health")) return true;
  return false;
}
