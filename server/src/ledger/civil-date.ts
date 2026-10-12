/** A calendar day, `YYYY-MM-DD`, with no timezone shift.

    node-pg returns a PostgreSQL `date` as a Date at local midnight.
    `toISOString()` then names the previous day wherever that midnight
    is still the day before in UTC. Asia/Jerusalem is one of those
    zones: local midnight on 1 April is 31 March 21:00 UTC. The civil
    day is the local year, month, and day of that Date.

    A `YYYY-MM-DD` string is already a civil day. An instant (a
    timestamp, or a string with a time) is not a date-only value. */
export function civilDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = value.getMonth() + 1;
    const day = value.getDate();
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return padded(year, month, day);
  }
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function padded(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
