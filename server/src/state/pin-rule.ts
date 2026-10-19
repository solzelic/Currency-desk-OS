/* Role and permissions use ROLE_RANK from the staff route, the same
   table PIN issuing uses. There is no second table. For anyone who is
   not the owner, that person has to rank strictly below the one who
   is signed in. A peer does not. The owner is the signed-in
   administrator. A permission is not that. The route skips this check
   for that session, so the owner is not locked out of their own row.
   Removing a stored row, or putting a known person back, is an edit
   of that person. The first copy of an empty list is the same edit
   when it sets a role or a permission, so a teller cannot name the
   owner. */
import { ROLE_RANK } from "../routes/staff.js";

export const PIN_RULE_REFUSAL =
  "Only someone senior to this person can change their role or permissions.";

export const PIN_ROW_REMOVAL =
  "Only someone senior to this person can remove them.";

/* caps is the permissions object the Employees screen writes.
   permissions is the same rule under the other name. */
const GUARDED = ["role", "caps", "permissions"] as const;

export function isSessionOwner(role: string): boolean {
  return role === "administrator";
}

export function ranksBelow(actorRole: string, targetRole: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, actorRole)) return false;
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, targetRole)) return false;
  const actor = ROLE_RANK[actorRole as keyof typeof ROLE_RANK];
  const target = ROLE_RANK[targetRole as keyof typeof ROLE_RANK];
  return target < actor;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSettings(state: unknown): Record<string, unknown> | null {
  const root = asRecord(state);
  if (!root) return null;
  const raw = root.cdos_settings;
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  return asRecord(raw);
}

function employeesOf(settings: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!settings) return [];
  let raw: unknown = settings.employees;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  }
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  return values.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[];
}

function codeOf(emp: Record<string, unknown>): string | null {
  if (typeof emp.code === "string" && emp.code) return emp.code;
  if (typeof emp.staffId === "string" && emp.staffId) return emp.staffId;
  return null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    return `{${Object.keys(src).sort().map((key) => `${JSON.stringify(key)}:${stable(src[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/* A role or a permission on the row is a rank edit. A PIN on its own
   is not. Require PIN is a different rule and is not decided here. */
function setsRule(emp: Record<string, unknown>): boolean {
  return has(emp, "role") || has(emp, "caps") || has(emp, "permissions");
}

/* A field the stored row did not have is a change. Leaving the field
   off the incoming row is not. */
function changed(before: Record<string, unknown> | undefined, after: Record<string, unknown>, field: string): boolean {
  if (!has(after, field)) return false;
  if (!before || !has(before, field)) return true;
  return stable(before[field]) !== stable(after[field]);
}

/* code, staffId, or id. A new row can name a stored person in any of these. */
function personKeys(emp: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of ["code", "staffId", "id"] as const) {
    const value = emp[key];
    if (typeof value === "string" && value && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

/* guarded: people whose role or permissions this save would change,
   including a removed row, a known person put back, and a first copy
   that sets a role or a permission.
   removed: the subset who are absent from the incoming list.
   knownStaffIds is this desk's roster, so a person who is not in the
   stored list is still that person. */
export function staffRuleChanges(stored: unknown, incoming: unknown, knownStaffIds: Iterable<string> = []): { guarded: string[]; removed: string[] } {
  const prior = new Map<string, Record<string, unknown>>();
  for (const emp of employeesOf(readSettings(stored))) {
    const code = codeOf(emp);
    if (code && !prior.has(code)) prior.set(code, emp);
  }
  const known = new Set(knownStaffIds);
  const referenced = new Set<string>();
  const guarded: string[] = [];
  const seen = new Set<string>();
  const flag = (code: string) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    guarded.push(code);
  };
  for (const emp of employeesOf(readSettings(incoming))) {
    const keys = personKeys(emp);
    const match = keys.find((key) => prior.has(key) || known.has(key));
    if (!match) continue;
    referenced.add(match);
    const before = prior.get(match);
    /* A row that names someone by another key is that person.
       An empty stored list does not make the first copy free:
       setting a role or a permission on a known person is an edit. */
    if (codeOf(emp) !== match) flag(match);
    else if (!before) {
      if (setsRule(emp)) flag(match);
    } else if (GUARDED.some((field) => changed(before, emp, field))) flag(match);
  }
  const removed: string[] = [];
  for (const code of prior.keys()) {
    if (referenced.has(code)) continue;
    removed.push(code);
    flag(code);
  }
  return { guarded, removed };
}

export const OWNER_PIN_REQUIRE = "Only the owner can change whether this person needs a PIN.";
export const OWNER_PIN_SWITCH = "Only the owner can change whether a PIN is needed to switch accounts.";
export const OWNER_PIN_TILL = "Only the owner can change whether a PIN is needed to take a till.";
export const OWNER_PIN_VOID = "Only the owner can change whether a PIN is needed to void a deal.";
export const OWNER_PIN_HASH = "Use Issue a new PIN to give someone a new PIN.";
export const OWNER_PIN_MUST = "Only the owner can change whether this person must pick a new PIN.";
export const OWNER_PERMISSION_GRANT = "Only the owner can grant that permission.";

const SWITCH_MSG: Record<string, string> = {
  pinOnSwitch: OWNER_PIN_SWITCH,
  pinOnTill: OWNER_PIN_TILL,
  pinOnVoid: OWNER_PIN_VOID,
};

function differs(prior: Record<string, unknown> | undefined, next: Record<string, unknown>, key: string): boolean {
  const had = !!prior && has(prior, key);
  const hasNext = has(next, key);
  if (!had && !hasNext) return false;
  if (!had || !hasNext) return true;
  return stable(prior![key]) !== stable(next[key]);
}

function tillPinValue(value: unknown): boolean {
  if (value === "0000" || value === 0) return true;
  if (typeof value === "string") return /^\d{4}$/.test(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999;
}

/* True when this save turns compliance:thresholds on. That permission
   is not what makes someone the owner. */
function grantsOwnerPermission(before: Record<string, unknown> | undefined, emp: Record<string, unknown>): boolean {
  for (const field of ["caps", "permissions"]) {
    if (!has(emp, field)) continue;
    const next = asRecord(emp[field]);
    const prev = asRecord(before?.[field]);
    if (next?.["compliance:thresholds"] === true && prev?.["compliance:thresholds"] !== true) return true;
  }
  return false;
}

function hashChanged(prior: Record<string, unknown> | undefined, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(prior ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    if (!/^pinhash$/i.test(key)) continue;
    if (!differs(prior, next, key)) continue;
    if (has(next, key) && tillPinValue(next[key])) continue;
    return true;
  }
  return false;
}

function readIncomingSettings(incoming: Record<string, unknown>): Record<string, unknown> | null {
  const raw = incoming.cdos_settings;
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  return asRecord(raw);
}

/* Require PIN, the switches, a non-digit pinHash, pinMustChange, and
   granting compliance:thresholds. A four digit pin stays with the
   snapshot strip. */
export function pinOwnerRefusal(stored: unknown, incoming: Record<string, unknown>): string | null {
  const prior = readSettings(stored);
  const settings = readIncomingSettings(incoming);
  const priorEmp = new Map<string, Record<string, unknown>>();
  for (const emp of employeesOf(prior)) {
    const code = codeOf(emp);
    if (code && !priorEmp.has(code)) priorEmp.set(code, emp);
  }
  for (const emp of employeesOf(settings)) {
    const before = priorEmp.get(codeOf(emp) ?? "");
    if (grantsOwnerPermission(before, emp)) return OWNER_PERMISSION_GRANT;
    if ((before?.requirePin === false) !== (emp.requirePin === false)) return OWNER_PIN_REQUIRE;
    if (differs(before, emp, "pinMustChange")) return OWNER_PIN_MUST;
    if (hashChanged(before, emp)) return OWNER_PIN_HASH;
  }
  if (hashChanged(prior ?? undefined, settings ?? {})) return OWNER_PIN_HASH;
  const storedRoot = asRecord(stored) ?? undefined;
  if (hashChanged(storedRoot, incoming)) return OWNER_PIN_HASH;
  if (settings) {
    for (const key of ["pinOnSwitch", "pinOnTill", "pinOnVoid"] as const) {
      if (differs(prior ?? undefined, settings, key)) return SWITCH_MSG[key] ?? OWNER_PIN_SWITCH;
    }
  }
  return null;
}
