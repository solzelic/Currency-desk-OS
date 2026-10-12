/* The trading day is a calendar date in the branch's time zone.

   It is not the UTC date, and it is not the date on the machine that
   happens to be running this process. A shop in Jerusalem just after
   midnight is already on the next calendar day while UTC, and a Toronto
   server, are still on the previous one. The sign-off sheet was reading
   that UTC date and then asking the browser to turn it into a window,
   which is how a deal posted at 00:30 local landed on yesterday's sheet
   with no transactions.

   `businessDate` is the one answer. The till session stores it when the
   session opens, and the session keeps it after midnight. */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function businessDate(at: Date, timeZone: string): string {
  if (Number.isNaN(at.getTime())) throw new Error("businessDate needs a real instant");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!year || !month || !day) throw new Error(`businessDate could not read ${timeZone}`);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/* node-pg parses a DATE column as local midnight (`new Date(y, m, d)`).
   `toISOString()` then moves the day backward wherever the process zone
   is ahead of UTC. The calendar fields are the date that was stored. */
export function readDateOnly(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("business date is not a date");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const match = DATE.exec(String(value ?? "").slice(0, 10));
  if (!match) throw new Error(`business date is not a date: ${String(value)}`);
  return match[0];
}

/** YYMMDD from a calendar date, for a reference. The date is already
    the business date. It is not read back out of an instant. */
export function refDay(isoDate: string): string {
  return readDateOnly(isoDate).slice(2).replace(/-/g, "");
}

/** True when calendar date `left` is before `right`. The same day is not
    before. Both sides are YYYY-MM-DD. A Date contributes its calendar
    fields, and a string contributes its date prefix. Nothing here is
    parsed as a UTC instant. */
export function calendarBefore(left: unknown, right: unknown): boolean {
  return readDateOnly(left) < readDateOnly(right);
}

/** Whole days from `on` until `expiry`. Zero on the expiry date, negative
    after it. The count uses the year, month and day fields. It does not
    convert either date through a time zone. */
export function calendarDaysUntil(expiry: unknown, on: unknown): number {
  const [fromYear, fromMonth, fromDay] = readDateOnly(on).split("-").map(Number);
  const [toYear, toMonth, toDay] = readDateOnly(expiry).split("-").map(Number);
  const ms =
    Date.UTC(toYear!, toMonth! - 1, toDay!) - Date.UTC(fromYear!, fromMonth! - 1, fromDay!);
  return Math.round(ms / 86_400_000);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  let hour = pick("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), hour, pick("minute"), pick("second"));
  if (Number.isNaN(asUtc)) throw new Error(`business day could not read ${timeZone}`);
  return asUtc - at.getTime();
}

/** Midnight at the start of `isoDate` in `timeZone`. */
export function zonedMidnight(isoDate: string, timeZone: string): Date {
  const match = DATE.exec(isoDate);
  if (!match) throw new Error(`business day is not a date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  let start = guess - offset;
  const corrected = zoneOffsetMs(new Date(start), timeZone);
  if (corrected !== offset) start = guess - corrected;
  const result = new Date(start);
  if (businessDate(result, timeZone) !== isoDate) {
    throw new Error(`no midnight for ${isoDate} in ${timeZone}`);
  }
  return result;
}

function nextCalendarDate(isoDate: string): string {
  const match = DATE.exec(isoDate);
  if (!match) throw new Error(`business day is not a date: ${isoDate}`);
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  utc.setUTCDate(utc.getUTCDate() + 1);
  return utc.toISOString().slice(0, 10);
}

/* The window the sign-off asks the ledger for.

   It starts at branch midnight of the session's business date. It ends
   at the next branch midnight, which is 23 or 25 hours across a
   daylight-saving change. A session that is still open after that
   midnight keeps its business date, so the end moves out to the close
   (or to now, while it is still open) and the deals posted after
   midnight stay on this sheet. */
export function signOffWindow(input: {
  businessDate: string;
  timeZone: string;
  closedAt: Date | null;
  now: Date;
}): { from: string; to: string } {
  const from = zonedMidnight(input.businessDate, input.timeZone);
  let end = zonedMidnight(nextCalendarDate(input.businessDate), input.timeZone);
  const sessionEnd = input.closedAt ?? input.now;
  if (sessionEnd.getTime() > end.getTime()) end = new Date(sessionEnd.getTime());
  /* The summary uses posted_at < to. An open session read in the same
     instant a deal was posted has to include that deal. */
  if (!input.closedAt && end.getTime() <= input.now.getTime()) {
    end = new Date(input.now.getTime() + 1);
  }
  return { from: from.toISOString(), to: end.toISOString() };
}
