/* ============================================================
   The SAM call, Early Access v2.1 (CD-180, CD-181).

   The box on step 4 reads "SAM can call this number to help set up my
   desk." Ticking it is consent to be called, at that number, and the
   server keeps it as evidence in enquiry_call_consents: the number, the
   exact sentence, the address it came from and that address's country,
   the browser, and when. Rows are only ever inserted. A stop is another
   row, and the latest row for an application is its answer.

   When SAM calls is the applicant's to choose, inside calling hours in
   their own zone:
     weekdays  9:00 to 21:30
     weekends 10:00 to 18:00
   and a call starts no later than five minutes before the end, as the
   page offers it. A time outside the hours moves to the next opening.
   The wall clock is read and set through Intl and wallInstant
   (shared/rolling-24h.js), so a day with a clock change is still right.

   Placing the call is not here (growth/calls.ts, and not part of this
   build).
   ============================================================ */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wallInstant } = require("../../../shared/rolling-24h.js") as {
  wallInstant: (date: string, time: string, timeZone: string) => Date | null;
};

/* The sentence the page shows beside the box, word for word. Consent to
   anything else is not consent the page asked for. */
export const SAM_CONSENT_TEXT = "SAM can call this number to help set up my desk.";

const WEEKDAY: readonly [number, number] = [9 * 60, 21 * 60 + 30];
const WEEKEND: readonly [number, number] = [10 * 60, 18 * 60];
const LAST_START_BEFORE_END = 5; // minutes

/* A province's zone, for an applicant whose browser did not say. Quebec
   and Ontario share Toronto's clock; the territories go by their
   capitals. */
const PROVINCE_ZONES: Record<string, string> = {
  ON: "America/Toronto", QC: "America/Toronto", BC: "America/Vancouver", AB: "America/Edmonton",
  MB: "America/Winnipeg", SK: "America/Regina", NS: "America/Halifax", PE: "America/Halifax",
  NB: "America/Moncton", NL: "America/St_Johns", YT: "America/Whitehorse", "NT/NU": "America/Yellowknife",
};

const realZone = (zone: string | null | undefined): string | null => {
  const z = String(zone ?? "").trim();
  if (!z) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
};

/* The applicant's zone: their browser's when it is a real zone, else
   their province's, else Toronto's. */
export function zoneFor(browserZone: string | null | undefined, province: string | null | undefined): string {
  return realZone(browserZone) ?? PROVINCE_ZONES[String(province ?? "").trim().toUpperCase()] ?? "America/Toronto";
}

/* The civil date, minutes past midnight and weekday of an instant, on
   the wall in `zone`. */
function onTheWall(at: Date, zone: string): { date: string; minutes: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  const hour = Number(p("hour")) % 24;
  return {
    date: `${p("year")}-${p("month")}-${p("day")}`,
    minutes: hour * 60 + Number(p("minute")),
    weekend: p("weekday") === "Sat" || p("weekday") === "Sun",
  };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const nextDay = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/* The first moment at or after `at` that is inside calling hours in
   `zone`. */
export function clampToCallingHours(at: Date, zone: string): Date {
  let cursor = new Date(at.getTime());
  for (let day = 0; day < 8; day++) {
    const wall = onTheWall(cursor, zone);
    const [open, close] = wall.weekend ? WEEKEND : WEEKDAY;
    if (wall.minutes < open) return wallInstant(wall.date, hhmm(open), zone) ?? cursor;
    if (wall.minutes <= close - LAST_START_BEFORE_END) return cursor;
    /* past the last start: the next day, from its midnight (or the first
       hour that exists, on a day whose midnight a clock change skips) */
    const tomorrow = nextDay(wall.date);
    cursor = wallInstant(tomorrow, "00:00", zone) ?? wallInstant(tomorrow, "01:00", zone) ?? new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  throw new Error(`No calling hours within a week of ${at.toISOString()} in ${zone}`);
}

/* Bookings per client address, in memory: the endpoint is public and
   needs only the reference. */
const BOOKINGS_PER_HOUR = 30;
const booked = new Map<string, number[]>();
export function allowBooking(address: string, now = Date.now()): boolean {
  const recent = (booked.get(address) ?? []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= BOOKINGS_PER_HOUR) return false;
  booked.set(address, [...recent, now]);
  for (const [key, times] of booked) if (!times.some((t) => now - t < 3600 * 1000)) booked.delete(key);
  return true;
}
/* For tests, which reuse one server. */
export function resetSamThrottle(): void { booked.clear(); }
