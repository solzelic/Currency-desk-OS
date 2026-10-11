/* Names a compliance screen must not show.

   A word-boundary check written as /\bOFAC\b/ misses another case, a
   plural, a possessive, and a dotted abbreviation. These patterns
   catch those spellings. "unit" and "under" stay allowed: the UN
   token has to stand on its own. "Lin Wei" is a sample beneficiary
   in the transfers book, so this matcher does not flag that order.
   The seam still refuses it on a compliance surface.
   ============================================================ */

const BOUND = String.raw`(?:^|[^A-Za-z0-9])`;
const END = String.raw`(?=$|[^A-Za-z0-9])`;
const edge = (body, flags = "i") => new RegExp(BOUND + body + END, flags);

/** List names, including the spellings a plain word boundary misses.
    The two-letter form is uppercase UN only. A lowercase "un" is a
    variable in the desk bundle ("const un") and the start of ordinary
    words such as "un-patched". The dotted form stays any case, which
    is the "U.N." bypass. */
export const BANNED_NAMES = [
  { name: "OFAC", re: edge(String.raw`o\.?f\.?a\.?c\.?(?:['’]?s)?`) },
  { name: "OSFI", re: edge(String.raw`o\.?s\.?f\.?i\.?(?:['’]?s)?`) },
  { name: "UN", re: edge(String.raw`(?:[Uu]\.[Nn]\.?|UN)`, "") },
  { name: "United Nations", re: /united nations/i },
  { name: "UNSC", re: edge(String.raw`unsc`) },
  { name: "Wei Lin", re: /wei lin/i },
];

/** Phrases the built desk bundle must not contain. */
export const BUNDLE_PHRASES = [
  { name: "screened against", re: /screened against/i },
  { name: "Sanctions hits", re: /sanctions hits/i },
];

function find(text, patterns) {
  const hits = [];
  for (const pattern of patterns) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const at = match.index;
    const sample = text.slice(Math.max(0, at - 24), at + match[0].length + 24).replace(/\s+/g, " ");
    hits.push({ name: pattern.name, match: match[0], sample });
  }
  return hits;
}

export function bannedNameHits(text) {
  return find(String(text), BANNED_NAMES);
}

export function bannedBundleHits(text) {
  return find(String(text), [...BANNED_NAMES, ...BUNDLE_PHRASES]);
}
