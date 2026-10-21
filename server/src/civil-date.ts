/** A calendar day, YYYY-MM-DD, with no clock and no zone.

    node-pg parses a Postgres `date` as local midnight (`new Date(y, m-1, d)`).
    `toISOString()` then prints the previous day wherever the process is
    east of UTC. A calendar day is the year, month, and day it was given.

    A `YYYY-MM-DD` string is taken as written. It is not parsed with
    `new Date("2030-04-01")`, which is UTC midnight and is the previous
    local day in zones west of UTC.

    Reverting this to `toISOString().slice(0, 10)` fails
    `civil dates` under Asia/Jerusalem and Pacific/Auckland. Parsing the
    string as UTC midnight and then reading local fields fails that same
    test under America/Toronto.
*/
export function civilDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid date");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const text = String(value).trim();
  const day = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  throw new Error(`Not a civil date: ${text}`);
}

export function civilToday(now: Date = new Date()): string {
  const day = civilDate(now);
  if (!day) throw new Error("Invalid date");
  return day;
}

/* The calendar day of `now` in an IANA zone. The process zone is not
   consulted. A till opened at 00:05 in Asia/Jerusalem is that city's
   day when the process is on UTC, and 23:55 in America/Toronto is
   still that city's day after UTC has rolled. */
export function civilTodayInZone(now: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    throw new Error(`Not a timezone: ${timeZone}`);
  }
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new Error(`Not a timezone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}
