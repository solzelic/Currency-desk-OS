/* The clocks a compliance window is allowed to use.

   A rolling window is an instant: `at` minus a number of hours. It does
   not have a time zone. A calendar day, and a static 24-hour period
   anchored at midnight, are named in the branch's zone. The midnight
   helper is the one the till session already uses
   (`business-date.ts`). This file does not invent a second one.

   FINTRAC's 24-hour rule (guidance updated 2023-10-23) is the static
   period: 24 consecutive hours from the anchor, which this desk keeps
   at branch midnight. The end is that instant plus 24 hours. It is not
   the next local midnight, which is 23 or 25 hours when the clocks
   change. It is not a rolling lookback from each deal. */
import { addCalendarDays, businessDate, zonedMidnight } from "./business-date.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InstantWindow = { start: Date; end: Date };

/** Midnight in the branch zone, then 24 consecutive hours. */
export function staticAggregationWindow(at: Date, timeZone: string): InstantWindow {
  const start = zonedMidnight(businessDate(at, timeZone), timeZone);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Rolling window ending at `at`. Inclusive of `at`. No zone. */
export function rollingWindow(at: Date, hours: number): InstantWindow {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("A rolling window needs a positive number of hours.");
  }
  return { start: new Date(at.getTime() - hours * 60 * 60 * 1000), end: new Date(at.getTime()) };
}

/** One calendar day, [branch midnight, next branch midnight). */
export function calendarDayWindow(isoDate: string, timeZone: string): InstantWindow {
  return {
    start: zonedMidnight(isoDate, timeZone),
    end: zonedMidnight(addCalendarDays(isoDate, 1), timeZone),
  };
}

/** Start of a rolling watch of `days` × 24 hours ending at `at`.
    A deal 23 hours earlier is inside, including when that instant
    falls on the previous calendar date. The window has no zone.
    The screen still calls this an N-day rolling watch. */
export function structuringWatchStart(at: Date, days: number): Date {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("A structuring watch needs a whole number of days.");
  }
  return rollingWindow(at, days * 24).start;
}

/** "today" or "yesterday" as the branch's calendar date. */
export function searchDay(at: Date, timeZone: string, which: "today" | "yesterday"): string {
  const today = businessDate(at, timeZone);
  if (which === "today") return today;
  if (which === "yesterday") return addCalendarDays(today, -1);
  throw new Error(`Search does not know the day "${which}".`);
}

/** `posted_at >= start AND posted_at < end`, except a rolling window
    includes its end instant (the deal the window was measured from). */
export function instantInWindow(window: InstantWindow, at: Date, inclusiveEnd: boolean): boolean {
  const t = at.getTime();
  if (t < window.start.getTime()) return false;
  return inclusiveEnd ? t <= window.end.getTime() : t < window.end.getTime();
}
