/* A suspicious report in the desk snapshot: an id or key starting with
   STR-, a basis of structuring, or a kind from the pack reports.
   Those codes are read from the jurisdiction_reports inserts. The JSX
   regime table cannot be imported, and it only names STR and SAR.
   If the migration files cannot be read, the smallest shared export is
   shared/regime-str-codes.js exporting suspiciousReportCodes().
   ackStr and ackStrInfo stay with the watch set. A save from a role
   outside a set leaves the stored value in place. */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { canSeeStr, canSeeStructuringWatch } = createRequire(import.meta.url)("../../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  canSeeStructuringWatch: (role: string) => boolean;
};

const WATCH_KEYS = new Set(["ackStr", "ackStrInfo"]);
const CODE_ROW = /'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'suspicious'/g;

function loadStrCodes(): Set<string> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
  let names: string[];
  try { names = readdirSync(dir); }
  catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error("The server cannot load the regime list (" + why + "). Smallest shared export: shared/regime-str-codes.js exporting suspiciousReportCodes().");
  }
  const codes = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".sql")) continue;
    for (const match of readFileSync(join(dir, name), "utf8").matchAll(CODE_ROW)) {
      const code = match[3]!.trim().toUpperCase();
      if (code) codes.add(code);
    }
  }
  if (codes.size === 0) throw new Error("The regime migrations named no suspicious report code. Smallest shared export: shared/regime-str-codes.js exporting suspiciousReportCodes().");
  return codes;
}

const CODES = loadStrCodes();
export function suspiciousCodes(): ReadonlySet<string> { return CODES; }

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function strKey(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("STR-");
}
function kindish(value: unknown): boolean {
  return typeof value === "string" && CODES.has(value.trim().toUpperCase());
}

/* History stores the code on type, and the title can be "STR · subject".
   The desk writes basis on the sealed filing. */
export function suspiciousReport(key: string | null, value: unknown): boolean {
  if (key && strKey(key)) return true;
  if (!plain(value)) return false;
  if (strKey(value.id) || strKey(value.key) || value.basis === "structuring") return true;
  if (["kind", "reportCode", "code", "type"].some((field) => kindish(value[field]))) return true;
  if (typeof value.title === "string" && [...CODES].some((code) => (value.title as string).startsWith(code + " ·"))) return true;
  const sealed = plain(value.sealed) ? value.sealed : null;
  return !!sealed && (sealed.basis === "structuring" || strKey(sealed.reportId) || kindish(sealed.kind) || kindish(sealed.type));
}

function parsedJson(value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function stripValue(role: string, value: unknown): { value: unknown; changed: boolean } {
  const parsed = parsedJson(value);
  if (typeof value === "string" && parsed) {
    const next = stripValue(role, parsed);
    return next.changed ? { value: JSON.stringify(next.value), changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      if (!canSeeStr(role) && suspiciousReport(null, item)) { changed = true; continue; }
      const next = stripValue(role, item);
      changed = changed || next.changed;
      out.push(next.value);
    }
    return { value: changed ? out : value, changed };
  }
  if (!plain(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!canSeeStr(role) && suspiciousReport(key, item)) { changed = true; continue; }
    if (!canSeeStructuringWatch(role) && WATCH_KEYS.has(key)) { changed = true; continue; }
    const next = stripValue(role, item);
    changed = changed || next.changed;
    out[key] = next.value;
  }
  return { value: changed ? out : value, changed };
}

export function presentStrSnapshot(role: string, state: Record<string, unknown>): Record<string, unknown> {
  return stripValue(role, structuredClone(state)).value as Record<string, unknown>;
}

function marker(item: unknown): string | null {
  if (!plain(item)) return null;
  if (item.id != null) return "i:" + String(item.id);
  if (item.key != null) return "k:" + String(item.key);
  return null;
}

function keepValue(role: string, stored: unknown, incoming: unknown): unknown {
  const incomingParsed = parsedJson(incoming);
  if (typeof incoming === "string" && incomingParsed) {
    const next = keepValue(role, typeof stored === "string" ? parsedJson(stored) : stored, incomingParsed);
    return JSON.stringify(next) === JSON.stringify(incomingParsed) ? incoming : JSON.stringify(next);
  }
  if (Array.isArray(incoming)) {
    const prior = Array.isArray(stored) ? stored : [];
    const by = new Map<string, unknown>();
    for (const item of prior) { const mark = marker(item); if (mark) by.set(mark, item); }
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of incoming) {
      const mark = marker(item);
      const prev = mark ? by.get(mark) : undefined;
      if (mark) seen.add(mark);
      if (!canSeeStr(role) && (suspiciousReport(null, item) || suspiciousReport(null, prev))) {
        if (prev !== undefined && suspiciousReport(null, prev)) out.push(prev);
        continue;
      }
      out.push(keepValue(role, prev, item));
    }
    if (!canSeeStr(role)) {
      for (const item of prior) {
        if (!suspiciousReport(null, item)) continue;
        const mark = marker(item);
        if (!mark || !seen.has(mark)) out.push(item);
      }
    }
    return out;
  }
  if (!plain(incoming)) return incoming;
  const prior = plain(stored) ? stored : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(incoming)) {
    const prev = prior ? prior[key] : undefined;
    if (!canSeeStr(role) && (suspiciousReport(key, item) || suspiciousReport(key, prev))) {
      if (prev !== undefined && suspiciousReport(key, prev)) out[key] = prev;
      continue;
    }
    if (!canSeeStructuringWatch(role) && WATCH_KEYS.has(key)) {
      if (prior && key in prior) out[key] = prior[key];
      continue;
    }
    out[key] = keepValue(role, prev, item);
  }
  if (prior) {
    for (const [key, item] of Object.entries(prior)) {
      if (key in out) continue;
      if (!canSeeStr(role) && suspiciousReport(key, item)) out[key] = item;
      else if (!canSeeStructuringWatch(role) && WATCH_KEYS.has(key)) out[key] = item;
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
