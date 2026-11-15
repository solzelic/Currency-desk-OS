import { dobConflict, scoreNames, type DobConstraint } from "./names.js";

export type ListEntry = {
  key: string;
  names: string[];
  dobs: DobConstraint[];
};

export type NameHit = {
  score: number;
  entry: ListEntry;
  matchedName: string;
};

function subjectNames(subject: { name: string; aliases?: readonly string[] }): string[] {
  const names = [subject.name, ...(subject.aliases ?? [])];
  return names.map((name) => name.trim()).filter(Boolean);
}

/** Every list entry at or above the threshold. A cleared key is the caller's to skip. */
export function matchesAbove(
  subject: { name: string; aliases?: readonly string[]; dob?: string | null },
  entries: readonly ListEntry[],
  threshold: number,
): NameHit[] {
  const names = subjectNames(subject);
  const hits: NameHit[] = [];
  for (const entry of entries) {
    if (!names.length) continue;
    let top = 0;
    let matchedName = entry.names[0] ?? "";
    for (const name of names) {
      for (const listed of entry.names) {
        const score = scoreNames(name, listed);
        if (score > top) {
          top = score;
          matchedName = listed;
        }
      }
    }
    if (dobConflict(subject.dob, entry.dobs)) continue;
    if (top >= threshold) hits.push({ score: top, entry, matchedName });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits;
}

export function bestMatch(
  subject: { name: string; aliases?: readonly string[]; dob?: string | null },
  entries: readonly ListEntry[],
  threshold: number,
): NameHit | null {
  return matchesAbove(subject, entries, threshold)[0] ?? null;
}

export function diffKeys(previous: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((key) => !before.has(key)),
    removed: previous.filter((key) => !after.has(key)),
  };
}
