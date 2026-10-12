/* Owner-only desk settings.

   A teller session called PUT /api/tenant/state and moved the shop's
   large-cash threshold from 10000 to 999999. The ledger route already
   refuses that (`compliance:thresholds`, administrator only). The desk
   snapshot does not: it is one document, saved whole, by whoever is
   signed in. The number the counter reads lives in that document until
   the ledger answers, and a direct call never has to open Settings.

   The same permission covers every owner-only group. A branch manager
   does not hold it. Sending one of these fields with a different value
   refuses the whole save. Dropping the field and keeping the rest
   would hide the attempt, so the document is left exactly as it was. */
import { hasBackendPermission } from "../auth/permissions.js";

export const OWNER_ONLY_REFUSAL =
  "Only the owner can change that setting. Nothing was saved.";

export const OWNER_ONLY_GROUPS = {
  shop: [
    "bizName", "operatingName", "msbNumber", "deskName",
    "bizPhone", "bizEmail", "bizAddress", "bizCity", "bizRegion", "bizPostal", "logo",
    "reportingEntityNumber", "locationNumber", "activitySector", "fintracContactName",
  ],
  compliance: [
    "threshold", "idRequiredOver", "retentionYears", "aggHours", "aggWindowStart", "regime",
  ],
  localization: ["baseCurrency", "dateFormat", "timeFormat", "bizCountry"],
  billing: ["billingPlan", "billingCycle"],
  hours: ["hours", "timezone"],
} as const;

export type OwnerGroup = keyof typeof OWNER_ONLY_GROUPS | "rolePresets";

const FIELD_GROUP = new Map<string, OwnerGroup>();
for (const [group, fields] of Object.entries(OWNER_ONLY_GROUPS)) {
  for (const field of fields) FIELD_GROUP.set(field, group as OwnerGroup);
}

const ROW_LABEL: Record<OwnerGroup, string> = {
  shop: "Shop settings",
  compliance: "Compliance thresholds",
  localization: "Localization",
  billing: "Billing",
  hours: "Hours and timezone",
  rolePresets: "Role presets",
};

export interface OwnerEdit {
  group: OwnerGroup;
  field: string;
}

export function ownsSettings(role: string): boolean {
  return hasBackendPermission(role, "compliance:thresholds");
}

/** Rows the settings screen may offer for editing. Tellers get none of these. */
export function editableOwnerRows(role: string): { id: OwnerGroup; label: string }[] {
  if (!ownsSettings(role)) return [];
  return (Object.keys(ROW_LABEL) as OwnerGroup[]).map((id) => ({ id, label: ROW_LABEL[id] }));
}

type SettingsRead =
  | { kind: "none" }
  | { kind: "record"; record: Record<string, unknown> }
  | { kind: "opaque"; raw: string };

function readSettings(value: unknown): SettingsRead {
  if (value === undefined || value === null) return { kind: "none" };
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { kind: "record", record: parsed as Record<string, unknown> };
      }
    } catch {
      /* not JSON — compared as text below */
    }
    return { kind: "opaque", raw: value };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { kind: "record", record: value as Record<string, unknown> };
  }
  return { kind: "opaque", raw: JSON.stringify(value) };
}

function order(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = order(src[key]);
    return out;
  }
  return value;
}

function stable(value: unknown): string {
  return JSON.stringify(order(value));
}

function unwrap(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function has(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Owner-only fields the incoming document would change.
 * A field that is absent was not sent. A field that is present and
 * equal to what is stored is the desk echoing its own copy.
 */
export function ownerOnlyEdits(
  stored: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): OwnerEdit[] {
  const hits: OwnerEdit[] = [];
  const before = readSettings(stored?.cdos_settings);
  const sentSettings = has(incoming, "cdos_settings");
  const after = readSettings(sentSettings ? incoming.cdos_settings : undefined);

  if (sentSettings && (after.kind === "opaque" || before.kind === "opaque")) {
    if (stable(stored?.cdos_settings) !== stable(incoming.cdos_settings)) {
      hits.push({ group: "compliance", field: "cdos_settings" });
    }
  } else if (sentSettings && after.kind === "none" && before.kind === "record") {
    for (const [field, group] of FIELD_GROUP) {
      if (has(before.record, field)) hits.push({ group, field });
    }
  } else if (after.kind === "record") {
    const prior = before.kind === "record" ? before.record : {};
    for (const [field, group] of FIELD_GROUP) {
      if (!has(after.record, field)) continue;
      const previous = has(prior, field) ? prior[field] : undefined;
      if (stable(previous) !== stable(after.record[field])) hits.push({ group, field });
    }
  }

  if (has(incoming, "cdos_perms")) {
    const prior = stored && has(stored, "cdos_perms") ? stored.cdos_perms : undefined;
    if (stable(unwrap(prior)) !== stable(unwrap(incoming.cdos_perms))) {
      hits.push({ group: "rolePresets", field: "cdos_perms" });
    }
  }
  return hits;
}

/**
 * A partial snapshot that simply does not mention an owner-only field
 * must not erase it. This copies stored fields back. It is not used
 * when the caller sent a different value — that save is refused whole.
 */
export function keepOwnerFields(
  stored: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!stored) return incoming;
  const next: Record<string, unknown> = { ...incoming };
  const before = readSettings(stored.cdos_settings);
  const sentSettings = has(incoming, "cdos_settings");
  const after = readSettings(sentSettings ? incoming.cdos_settings : undefined);

  if (!sentSettings && before.kind !== "none") {
    next.cdos_settings = stored.cdos_settings;
  } else if (before.kind === "record" && after.kind === "record") {
    let copied = false;
    const merged: Record<string, unknown> = { ...after.record };
    for (const field of FIELD_GROUP.keys()) {
      if (!has(after.record, field) && has(before.record, field)) {
        merged[field] = before.record[field];
        copied = true;
      }
    }
    if (copied) {
      next.cdos_settings = typeof incoming.cdos_settings === "string" ? JSON.stringify(merged) : merged;
    }
  }

  if (has(stored, "cdos_perms") && !has(incoming, "cdos_perms")) {
    next.cdos_perms = stored.cdos_perms;
  }
  return next;
}
