/* Owner-only desk settings.

   A teller session called PUT /api/tenant/state and moved the shop's
   large-cash threshold from 10000 to 999999. The ledger route already
   refuses that. The desk snapshot is one document, saved whole.

   Non-owners may change an allowlist: the keys their own screens write
   (a customer is not in here — that is a different snapshot key — these
   are fields inside cdos_settings). Everything else in that object is
   the owner's. Sending one of those with a different value refuses the
   whole save. An equal value is the desk echoing its copy. A missing
   value was not sent, including the two keys the client derives on
   sign-in (cdos_perms, billingPlan) and must not upload. Those are
   copied back from what is stored, and the rest of the document saves. */
import { hasBackendPermission } from "../auth/permissions.js";

export const OWNER_ONLY_REFUSAL =
  "Only the owner can change that setting. Nothing was saved.";

/* What a teller or a manager screen actually writes into cdos_settings.
   My account, the people a sign-in adopts, and the app-settings tabs a
   manager is allowed to open. Shop, compliance, billing, hours, and the
   two keys called out as the owner's (the handoff count, the default
   spread) are not on this list. */
export const NON_OWNER_MAY_CHANGE = [
  "staff", "employees",
  "defaultClientRisk", "idExpiryWarnDays", "riskTierNotes", "escalateMediumRisk",
  "requireClientEmail", "requireClientPhone",
  "vaultLowAlert", "vaultBasis", "vaultFloors", "floatCcys",
  "tillCountMode", "tillBlindCount", "tillVarianceTol", "requireCountOnClose",
  "pinOnSwitch", "pinOnTill", "pinOnVoid",
  "transferRequirePurpose", "chequeMinHoldDays",
  "autoTagRisk", "autoTagNew",
  "spreads", "marginTargetPct", "marginFloorPct", "marginEnforce",
  "rateProvider", "defaultFee", "rateRounding", "rateLockMins",
  "payoutRoundTo", "payoutRoundMode", "spotOverride",
  "receiptHeader", "receiptFooter", "receiptDisclaimer", "showLogoOnReceipt", "showMsbOnReceipt",
] as const;

const ALLOWED = new Set<string>(NON_OWNER_MAY_CHANGE);

export const OWNER_ONLY_GROUPS = {
  shop: [
    "bizName", "operatingName", "msbNumber", "deskName",
    "bizPhone", "bizEmail", "bizAddress", "bizCity", "bizRegion", "bizPostal", "logo",
    "reportingEntityNumber", "locationNumber", "activitySector", "fintracContactName",
  ],
  compliance: [
    "threshold", "idRequiredOver", "retentionYears", "aggHours", "aggWindowStart", "regime",
    "largeTxCheck", "structuringDays", "escalateHighRisk", "requireIdPhoto",
    "reverifyDays", "recheckDays", "kycProvider", "screenSanctions",
  ],
  localization: ["baseCurrency", "dateFormat", "timeFormat", "bizCountry"],
  billing: ["billingPlan", "billingCycle", "billingEmail"],
  hours: ["hours", "timezone"],
  rates: ["defaultSpread"],
  till: ["requireCountOnHandoff"],
} as const;

export type OwnerGroup = keyof typeof OWNER_ONLY_GROUPS | "rolePresets" | "settings";

const FIELD_GROUP = new Map<string, OwnerGroup>();
for (const [group, fields] of Object.entries(OWNER_ONLY_GROUPS)) {
  for (const field of fields) FIELD_GROUP.set(field, group as OwnerGroup);
}

/** Every named owner-only field. Anything not on the allowlist is too. */
export const OWNER_ONLY_FIELDS = Object.values(OWNER_ONLY_GROUPS).flat();

const ROW_LABEL: Record<string, string> = {
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
export function editableOwnerRows(role: string): { id: string; label: string }[] {
  if (!ownsSettings(role)) return [];
  return Object.keys(ROW_LABEL).map((id) => ({ id, label: ROW_LABEL[id]! }));
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

function groupOf(field: string): OwnerGroup {
  return FIELD_GROUP.get(field) ?? "settings";
}

/**
 * Owner-only fields the incoming document would change.
 * Absent is not a change. Equal is the desk echoing its copy, or the
 * client omitting a key it only derived. A different value is a change.
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
      hits.push({ group: "settings", field: "cdos_settings" });
    }
  } else if (sentSettings && after.kind === "none" && before.kind === "record") {
    for (const field of Object.keys(before.record)) {
      if (!ALLOWED.has(field)) hits.push({ group: groupOf(field), field });
    }
  } else if (after.kind === "record") {
    const prior = before.kind === "record" ? before.record : {};
    for (const field of Object.keys(after.record)) {
      if (ALLOWED.has(field)) continue;
      const previous = has(prior, field) ? prior[field] : undefined;
      if (stable(previous) !== stable(after.record[field])) hits.push({ group: groupOf(field), field });
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
 * Copy stored owner-only fields the document did not mention, so leaving
 * one out cannot erase it. Not used when the caller sent a different
 * value — that save is refused whole.
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
    for (const field of Object.keys(before.record)) {
      if (ALLOWED.has(field)) continue;
      if (!has(after.record, field)) {
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
