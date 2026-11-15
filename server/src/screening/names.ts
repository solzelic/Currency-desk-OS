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

/** One substitution, insertion, or deletion. Longer distances stop at 2. */
function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  const prev = new Array<number>(right.length + 1);
  const next = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) prev[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    next[0] = i;
    let rowMin = next[0] ?? i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (next[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      const best = Math.min(del, ins, sub);
      next[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > 1) return 2;
    for (let j = 0; j <= right.length; j += 1) prev[j] = next[j] ?? 0;
  }
  return (prev[right.length] ?? 2) > 1 ? 2 : prev[right.length] ?? 2;
}

/** Exact, a transliteration fold, or one edit on a token of at least 6 letters. */
function tokenClose(left: string, right: string): boolean {
  if (left === right) return true;
  const a = translitToken(left);
  const b = translitToken(right);
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  return levenshtein(a, b) <= 1;
}

/** A shorter name whose every token is on the longer name. One token is not enough. */
function subsetScore(left: readonly string[], right: readonly string[]): number | null {
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  if (short.length < 2 || short.length >= long.length) return null;
  const used = new Set<number>();
  for (const token of short) {
    const index = long.findIndex((other, i) => !used.has(i) && tokenClose(token, other));
    if (index < 0) return null;
    used.add(index);
  }
  return 0.95;
}

/** The same number of tokens, with at least one one-edit difference. */
function alignedScore(left: readonly string[], right: readonly string[]): number | null {
  if (left.length !== right.length) return null;
  const used = new Set<number>();
  let edits = 0;
  for (const token of left) {
    const exact = right.findIndex((other, i) => !used.has(i) && (token === other || translitToken(token) === translitToken(other)));
    if (exact >= 0) {
      used.add(exact);
      continue;
    }
    const near = right.findIndex((other, i) => !used.has(i) && tokenClose(token, other));
    if (near < 0) return null;
    used.add(near);
    edits += 1;
  }
  return edits > 0 ? 0.94 : null;
}

/** 1 is the same tokens. 0.97 is a transliteration fold. 0.95 is a missing
    middle name or a shorter name against a multi-part list name. 0.94 is
    one edit on a token. 0.93 is a vowel skeleton. */
export function scoreNames(left: string, right: string): number {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.length || !b.length) return 0;
  if (a.join(" ") === b.join(" ")) return 1;
  const foldedA = a.map(translitToken).sort();
  const foldedB = b.map(translitToken).sort();
  if (foldedA.join(" ") === foldedB.join(" ")) return 0.97;
  const subset = subsetScore(a, b);
  if (subset !== null) return subset;
  const aligned = alignedScore(a, b);
  if (aligned !== null) return aligned;
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

/** A full date on both sides, and none of the listed days, months, or years agree.
    A missing date or a year-only list is not a conflict. One agreeing day or
    year, including a full day plus an alternative year, keeps the match. */
export function dobConflict(subjectDob: string | null | undefined, constraints: readonly DobConstraint[]): boolean {
  if (!subjectDob || !constraints.length) return false;
  const dob = subjectDob.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const full = constraints.filter((item) => item.kind === "date");
  if (!full.length) return false;
  if (full.some((item) => item.value === dob)) return false;
  const year = dob.slice(0, 4);
  const month = dob.slice(0, 7);
  if (constraints.some((item) => item.kind === "year" && item.value === year)) return false;
  if (constraints.some((item) => item.kind === "month" && item.value === month)) return false;
  return true;
}
