/* Name comparison for in-house list screening.

   The score threshold is a placeholder. It is not a Compliance Officer
   sign-off. Do not describe it as final. */

/** Placeholder until the Compliance Officer signs off. Not a final threshold. */
export const SCORE_THRESHOLD_PLACEHOLDER = 0.92;

export const THRESHOLD_SIGNOFF = "pending Compliance Officer sign-off";

const VOWELS = /[aeiouy]/g;

const TRANSLIT: ReadonlyArray<readonly [string, string]> = [
  ["ph", "f"],
  ["kh", "h"],
  ["zh", "j"],
  ["ts", "c"],
  ["ou", "u"],
  ["oe", "o"],
  ["ae", "a"],
  ["ue", "u"],
  ["ij", "y"],
  ["ck", "k"],
  ["qu", "k"],
];

export function normalizeName(input: string): string {
  const folded = input.normalize("NFD").replace(/\p{M}/gu, "");
  return folded
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function translitToken(token: string): string {
  let s = token;
  for (const [from, to] of TRANSLIT) s = s.split(from).join(to);
  s = s.replace(/w/g, "v");
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

export function nameTokens(input: string): string[] {
  return normalizeName(input).split(" ").filter(Boolean).sort();
}

function skeleton(tokens: readonly string[]): string {
  return tokens.map((token) => translitToken(token).replace(VOWELS, "")).filter(Boolean).sort().join(" ");
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** 1 is the same tokens. 0.97 is a transliteration fold. 0.93 is a vowel skeleton. */
export function scoreNames(left: string, right: string): number {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.length || !b.length) return 0;
  if (a.join(" ") === b.join(" ")) return 1;
  const foldedA = a.map(translitToken).sort();
  const foldedB = b.map(translitToken).sort();
  if (foldedA.join(" ") === foldedB.join(" ")) return 0.97;
  const boneA = skeleton(a);
  const boneB = skeleton(b);
  if (boneA.length >= 3 && boneA === boneB) return 0.93;
  return jaccard(foldedA, foldedB);
}

export type DobConstraint =
  | { kind: "date"; value: string }
  | { kind: "month"; value: string }
  | { kind: "year"; value: string };

/** Pull usable dates out of a list field. A ship note or "Sep-99" adds nothing. */
export function parseDobField(raw: string | null | undefined): DobConstraint[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text || /^sep-\d+$/i.test(text)) return [];
  const out: DobConstraint[] = [];
  for (const part of text.split(/\s+or\s+|;\s*/i)) {
    const bit = part.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(bit)) out.push({ kind: "date", value: bit });
    else if (/^\d{4}-\d{2}$/.test(bit)) out.push({ kind: "month", value: bit });
    else if (/^\d{4}$/.test(bit)) out.push({ kind: "year", value: bit });
    else {
      const range = /^(\d{4})-(\d{4})$/.exec(bit);
      if (!range) continue;
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start || end - start > 5) continue;
      for (let year = start; year <= end; year += 1) out.push({ kind: "year", value: String(year) });
    }
  }
  return out;
}

/** True when both sides have a date and one constraint fits. Null when either side has none. */
export function dobAgrees(subjectDob: string | null | undefined, constraints: readonly DobConstraint[]): boolean | null {
  if (!subjectDob || !constraints.length) return null;
  const dob = subjectDob.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  return constraints.some((item) => {
    if (item.kind === "date") return item.value === dob;
    return dob.startsWith(item.value);
  });
}

/** A full date on both sides, and none of those days are the same.
    A missing date, a year-only date, or any one matching day is not a conflict. */
export function dobConflict(subjectDob: string | null | undefined, constraints: readonly DobConstraint[]): boolean {
  if (!subjectDob || !constraints.length) return false;
  const dob = subjectDob.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const full = constraints.filter((item) => item.kind === "date");
  if (!full.length) return false;
  return !full.some((item) => item.value === dob);
}
