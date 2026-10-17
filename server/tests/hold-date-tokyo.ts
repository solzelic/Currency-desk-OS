/* Run with TZ=Asia/Tokyo. A local midnight is the previous UTC day,
   so toISOString would report 12 October for 13 October. */
import { addCalendarDays, calendarDate } from "../src/ledger/cheque-money.js";

const local = new Date(2026, 9, 13, 0, 0, 0);
const iso = local.toISOString().slice(0, 10);
const calendar = calendarDate(local);
if (iso === "2026-10-13") {
  console.error("this process is not east of UTC: " + iso);
  process.exit(3);
}
if (calendar !== "2026-10-13") {
  console.error("calendar date shifted: " + calendar);
  process.exit(2);
}
if (addCalendarDays("2026-10-12", 1) !== "2026-10-13") {
  console.error("hold shifted");
  process.exit(4);
}
console.log(calendar);
