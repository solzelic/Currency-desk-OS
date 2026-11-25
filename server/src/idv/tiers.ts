/* Compliance order, 16 Nov 2026. The old words still post.
   quick was the old tier 1. verify was the old tier 2. plus was the old tier 3.
   PEP stays on the two checks that recorded it: returning client, and ID and selfie. */

export type TierNumber = "1" | "2" | "3" | "4";

export const TIER_NUMBER: Record<string, TierNumber> = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  quick: "2",
  verify: "3",
  plus: "4",
};

export const TIER_ALIASES = ["1", "2", "3", "4", "quick", "verify", "plus"] as const;

/* Old numeric 1 and 2 were quick and verify. Those are now 2 and 3. */
export const PEP_TIERS = new Set<TierNumber>(["2", "3"]);

export type CheckMethod = "in_person" | "returning_client" | "id_and_selfie" | "id_selfie_database" | "counter_id_scan" | "counter_full";

export type CheckResult = "pass" | "declined" | "needs_review" | "method_not_completed" | "returning_confirmed" | "expired";

export const METHOD_LABEL: Record<CheckMethod, string> = {
  in_person: "photo ID, in person",
  returning_client: "Returning client",
  id_and_selfie: "ID and selfie, Persona",
  id_selfie_database: "ID, selfie and database, Persona",
  counter_id_scan: "ID scanned at the counter",
  counter_full: "Full check at the counter",
};

export const NO_PHOTO_LINE = "No photo on file";
export const DATABASE_OFF_LINE = "The database step is not on yet. This check runs ID and selfie.";
export const DETAIL_LINE = "Shows the check done on this date. Not a guarantee of identity.";
export const ADVISE_LINE = "A new ID and selfie check is advised.";
export const DUE_LINE = "A new full ID check is needed.";
export const COUNTER_CHOSEN_LINE = "Customer chose the counter check. Inspect the original ID.";
export const QUEBEC_LINE = "Face match is off for this branch. Inspect the original ID.";
export const PROVINCE_LINE = "Set this branch's province before a face match. Inspect the original ID.";
export const REVIEW_LINE = "This needs review. A supervisor will help.";
export const DECLINED_LINE = "Check not passed. Check the ID at the counter.";
export const INCOMPLETE_LINE = "Method not completed. Check the ID at the counter.";
export const NONE_LINE = "No ID check on file";
export const PROGRESS_LINE = "ID check in progress";
export const PASSED_TEST_LINE = "Check passed (test)";
export const VERIFIED_SCAN_BADGE = "ID verified, scan and selfie";

export function verifiedScanChip(date: string, test = false): string {
  return test ? `${VERIFIED_SCAN_BADGE} (test), ${date}` : `${VERIFIED_SCAN_BADGE}, ${date}`;
}

export function resolveTier(input: string): TierNumber | null {
  return TIER_NUMBER[input] ?? null;
}

export function methodLabel(method: CheckMethod, provider = "persona"): string {
  if (method === "counter_id_scan") return METHOD_LABEL.counter_id_scan;
  if (method === "counter_full") return METHOD_LABEL.counter_full;
  if (provider === "didit" && method === "id_and_selfie") return "ID and selfie, Didit";
  if (provider === "didit" && method === "id_selfie_database") return "ID, selfie and database, Didit";
  return METHOD_LABEL[method];
}

export function faceMatchTier(tier: TierNumber | null): boolean {
  return tier === "3" || tier === "4";
}

/* Tier 4 is the database step. It stays off and runs as ID and selfie. */
export function tierMethod(tier: TierNumber): { method: CheckMethod; databaseStep: "off" | "not_applicable"; message: string | null } {
  if (tier === "1") return { method: "in_person", databaseStep: "not_applicable", message: null };
  if (tier === "2") return { method: "returning_client", databaseStep: "not_applicable", message: null };
  if (tier === "4") return { method: "id_and_selfie", databaseStep: "off", message: DATABASE_OFF_LINE };
  return { method: "id_and_selfie", databaseStep: "not_applicable", message: null };
}

const SELFIE_FAILED = new Set(["failed", "declined", "canceled", "cancelled", "expired", "abandoned"]);

/* A document-only counter scan is verified only when the ID feature passed
   and a teller has attested the face match. The two-argument call is the
   ID-and-selfie rule and stays as it was. */
export function classifyCheck(
  outcome: string,
  selfieStatus: string | null,
  context?: { method?: CheckMethod; idPassed?: boolean; attested?: boolean },
): { result: CheckResult; verification: boolean } {
  if (context?.method === "counter_id_scan") {
    if (outcome === "review") return { result: "needs_review", verification: false };
    if (outcome === "declined") return { result: "declined", verification: false };
    if (outcome === "failed" || outcome === "expired") return { result: "method_not_completed", verification: false };
    if (outcome === "approved" && context.idPassed === true && context.attested === true) {
      return { result: "pass", verification: true };
    }
    return { result: "method_not_completed", verification: false };
  }
  const selfie = (selfieStatus ?? "").trim().toLowerCase();
  if (SELFIE_FAILED.has(selfie)) return { result: "method_not_completed", verification: false };
  if (outcome === "review") return { result: "needs_review", verification: false };
  if (outcome === "declined") return { result: "declined", verification: false };
  if (outcome === "failed" || outcome === "expired") return { result: "method_not_completed", verification: false };
  if (outcome === "approved" && (selfie === "passed" || selfie === "completed" || selfie === "approved")) {
    return { result: "pass", verification: true };
  }
  return { result: "method_not_completed", verification: false };
}

export function counterOnly(province: string | null | undefined): { counter: boolean; quebec: boolean; line: string } {
  const raw = (province ?? "").trim();
  if (!raw) return { counter: true, quebec: false, line: PROVINCE_LINE };
  const folded = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (folded === "QC" || folded === "QUEBEC") return { counter: true, quebec: true, line: QUEBEC_LINE };
  return { counter: false, quebec: false, line: "" };
}

export function notPassedLine(date: string): string {
  return `Not passed ${date}`;
}

export function underReviewLine(date: string): string {
  return `Under review since ${date}`;
}

export function idCheckedLine(date: string, methodLabel: string, test: boolean): string {
  const line = `ID checked ${date}, ${methodLabel}`;
  return test ? `${line} (test)` : line;
}

export function returningLine(originalDate: string, methodLabel: string): string {
  return `Returning client, ID checked ${originalDate}, ${methodLabel}`;
}

export function civilDateWords(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split("-");
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${Number(day)} ${name} ${year}`;
}

export function expiredLine(isoDate: string): string {
  return `Expired ${civilDateWords(isoDate)}`;
}

export const HAND_TYPED_LINE = "ID typed by hand, not checked";
export const TOO_OLD_LINE = "This check is too old. A new ID check is needed.";

export function seenInPersonLine(staff: string, type: string, expiry: string, checked: string): string {
  return `ID seen in person by ${staff}, ${type}, expires ${expiry}, checked ${checked}`;
}

export function expiredNextDealLine(expiryWords: string): string {
  return `Expired ${expiryWords}. A new ID check is needed before the next deal of $3,000 or more.`;
}

export function civilToday(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone.trim() || "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function isPastExpiry(isoDate: string | null, timeZone: string, now = new Date()): boolean {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return false;
  return isoDate.slice(0, 10) < civilToday(timeZone, now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* 16 Nov 2026, and a 12-hour clock, both in the branch zone. */
export function branchStamp(when: Date, timeZone: string): { date: string; time: string } {
  const zone = timeZone.trim() || "America/Toronto";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, day: "numeric", month: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(when);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTHS[Number(pick("month")) - 1] ?? pick("month");
  const clock = `${pick("hour")}:${pick("minute")} ${pick("dayPeriod").toLowerCase()}`;
  return { date: `${pick("day")} ${month} ${pick("year")}`, time: clock };
}
