/* STR draft and status, and the structuring acknowledgement, inside the
   desk snapshot. The server reads shared/str-role.js for the two sets.
   A role outside a set does not receive those fields, and a save from
   that role leaves the stored fields as they were. */
import { createRequire } from "node:module";

const { canSeeStr, canSeeStructuringWatch } = createRequire(import.meta.url)("../../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  canSeeStructuringWatch: (role: string) => boolean;
};

const STR_KEYS = new Set(["strDraft", "strStatus", "strTag", "strLink"]);
const WATCH_KEYS = new Set(["ackStr", "ackStrInfo", "structuring", "structuringTotal"]);

let reads = 0;

export function structuringReads() {
  return reads;
}

export function resetStructuringReads() {
  reads = 0;
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strRecord(value: unknown): boolean {
  if (!plain(value)) return false;
  for (const key of ["kind", "reportCode", "code"]) {
    if (String(value[key] ?? "").trim().toUpperCase() === "STR") return true;
  }
  return false;
}

function parsedJson(value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/* The watch is read off the saved rows. Roles outside the watch set
   never reach this. The result is not written back onto the snapshot. */
export function queryStructuring(state: Record<string, unknown>): number {
  reads += 1;
  const raw = parsedJson(state.cdos_rows_v1) ?? state.cdos_rows_v1;
  if (!Array.isArray(raw)) return 0;
  let found = 0;
  for (const item of raw) {
    if (!plain(item)) continue;
    const cash = Number(item.cashInHome ?? item.inAmt ?? 0);
    if (cash > 0 && cash < 10000) found += 1;
  }
  return found;
}

function stripValue(role: string, value: unknown): { value: unknown; changed: boolean } {
  const parsed = parsedJson(value);
  if (typeof value === "string" && parsed) {
    const next = stripValue(role, parsed);
    if (!next.changed) return { value, changed: false };
    return { value: JSON.stringify(next.value), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (!canSeeStr(role) && strRecord(item)) {
        changed = true;
        continue;
      }
      const next = stripValue(role, item);
      changed = changed || next.changed;
      out.push(next.value);
    }
    return { value: changed ? out : value, changed };
  }
  if (!plain(value)) return { value, changed: false };
  const hideStr = !canSeeStr(role);
  const hideWatch = !canSeeStructuringWatch(role);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (hideStr && (STR_KEYS.has(key) || strRecord(item))) {
      changed = true;
      continue;
    }
    if (hideWatch && WATCH_KEYS.has(key)) {
      changed = true;
      continue;
    }
    const next = stripValue(role, item);
    changed = changed || next.changed;
    out[key] = next.value;
  }
  return { value: changed ? out : value, changed };
}

export function stripStrSnapshot(role: string, state: Record<string, unknown>): Record<string, unknown> {
  return stripValue(role, state).value as Record<string, unknown>;
}

export function presentStrSnapshot(role: string, state: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(state);
  if (canSeeStructuringWatch(role)) queryStructuring(copy);
  return stripStrSnapshot(role, copy);
}

function keepValue(role: string, stored: unknown, incoming: unknown): unknown {
  const incomingParsed = parsedJson(incoming);
  if (typeof incoming === "string" && incomingParsed) {
    const next = keepValue(role, parsedJson(stored), incomingParsed);
    if (JSON.stringify(next) === JSON.stringify(incomingParsed)) return incoming;
    return JSON.stringify(next);
  }
  if (Array.isArray(incoming)) {
    const prior = Array.isArray(stored) ? stored : [];
    const byId = new Map<string, unknown>();
    for (const item of prior) if (plain(item) && item.id != null) byId.set(String(item.id), item);
    const hideStr = !canSeeStr(role);
    const out = incoming.map((item) => {
      const prev = plain(item) && item.id != null ? byId.get(String(item.id)) : undefined;
      if (hideStr && strRecord(item)) return strRecord(prev) ? prev : undefined;
      return keepValue(role, prev, item);
    }).filter((item) => item !== undefined);
    if (hideStr) {
      for (const item of prior) {
        if (!strRecord(item) || !plain(item) || item.id == null) continue;
        const id = String(item.id);
        if (!out.some((entry) => plain(entry) && String(entry.id) === id)) out.push(item);
      }
    }
    return out;
  }
  if (!plain(incoming)) return incoming;
  const prior = plain(stored) ? stored : undefined;
  const hideStr = !canSeeStr(role);
  const hideWatch = !canSeeStructuringWatch(role);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(incoming)) {
    if (hideStr && STR_KEYS.has(key)) {
      if (prior && key in prior) out[key] = prior[key];
      continue;
    }
    if (hideStr && strRecord(item)) {
      if (prior && strRecord(prior[key])) out[key] = prior[key];
      continue;
    }
    if (hideWatch && WATCH_KEYS.has(key)) {
      if (prior && key in prior) out[key] = prior[key];
      continue;
    }
    out[key] = keepValue(role, prior ? prior[key] : undefined, item);
  }
  if (prior) {
    for (const [key, item] of Object.entries(prior)) {
      if (key in out) continue;
      if (hideStr && (STR_KEYS.has(key) || strRecord(item))) out[key] = item;
      else if (hideWatch && WATCH_KEYS.has(key)) out[key] = item;
    }
  }
  return out;
}

export function keepStrSnapshot(
  role: string,
  stored: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return keepValue(role, stored, incoming) as Record<string, unknown>;
}
