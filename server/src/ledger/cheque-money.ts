/* The cheque fee and the hold date. Both used to be whatever the
   browser sent. The fee is the desk's rule, rounded half up to the
   cent. The hold is a calendar day on the business date, not an
   instant run through toISOString. */
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type ChequeFeeRule = {
  id: string;
  feePct: string;
  feeMin: string;
};

/* The same figures the desk ships as its starting schedule
   (os-src/cdos-cheques.jsx defaultSchedule). A saved schedule
   replaces this. A type that is not on the schedule has no rule. */
export const DEFAULT_CHEQUE_SCHEDULE: readonly ChequeFeeRule[] = [
  { id: "government", feePct: "1.5", feeMin: "4" },
  { id: "payroll", feePct: "2.0", feeMin: "5" },
  { id: "certified", feePct: "1.0", feeMin: "5" },
  { id: "money_order", feePct: "1.5", feeMin: "4" },
  { id: "business", feePct: "3.0", feeMin: "10" },
  { id: "personal", feePct: "3.5", feeMin: "10" },
];

/** Percent of the face, or the minimum, whichever is larger.
    Half up to the cent: 1,000.25 at 2% is 20.005, which is 20.01.
    A float times toFixed gets that half cent wrong. */
export function chequeFeeAmount(face: Decimal.Value, feePct: Decimal.Value, feeMin: Decimal.Value): Decimal {
  const percent = new Decimal(face).mul(feePct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const minimum = new Decimal(feeMin).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return Decimal.max(minimum, percent);
}

export function ruleFor(schedule: readonly ChequeFeeRule[] | null | undefined, chequeType: string): ChequeFeeRule | null {
  const list = schedule && schedule.length ? schedule : DEFAULT_CHEQUE_SCHEDULE;
  const id = String(chequeType || "").trim();
  const found = list.find((item) => item && String(item.id) === id);
  return found ?? null;
}

/** A DATE from node-pg is local midnight. toISOString moves that day
    back one in any zone east of UTC. Read the calendar fields. */
export function calendarDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const text = String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match?.[1] ?? text.slice(0, 10);
}

/** Add whole days to a YYYY-MM-DD date. UTC fields on a UTC midnight,
    so the zone of this process cannot move the day. */
export function addCalendarDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
