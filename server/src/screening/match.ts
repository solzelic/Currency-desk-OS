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

export function bestMatch(
  subject: { name: string; dob?: string | null },
  entries: readonly ListEntry[],
  threshold: number,
): NameHit | null {
  let best: NameHit | null = null;
  for (const entry of entries) {
    let top = 0;
    let matchedName = entry.names[0] ?? "";
    for (const name of entry.names) {
      const score = scoreNames(subject.name, name);
      if (score > top) {
        top = score;
        matchedName = name;
      }
    }
    if (dobConflict(subject.dob, entry.dobs)) top = 0;
    if (top >= threshold && (!best || top > best.score)) best = { score: top, entry, matchedName };
  }
  return best;
}

export function diffKeys(previous: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((key) => !before.has(key)),
    removed: previous.filter((key) => !after.has(key)),
  };
}
