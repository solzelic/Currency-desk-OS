/* Shared phone formatters. Run with: node --test tests/phone-format.test.mjs
   A calendar day must stay on that day in every zone. An instant is
   shown in the zone the caller passes. There is no Toronto default.
   A value that cannot be read is an em dash. Blank stays blank. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { formatPhoneTime, formatPhoneDate, formatPhoneListGroup, formatPhoneMoney, formatPhoneWait, formatPhoneLock } = require("../os-src/phone/format.js");

const TORONTO = "America/Toronto";
const KIRITIMATI = "Pacific/Kiritimati";
const HONOLULU = "Pacific/Honolulu";

test("3:02 PM is twelve-hour with uppercase AM and PM", () => {
  assert.equal(formatPhoneTime("15:02"), "3:02 PM");
  assert.equal(formatPhoneTime("15:02", KIRITIMATI), "3:02 PM");
  assert.equal(formatPhoneTime("3:02 PM"), "3:02 PM");
  assert.equal(formatPhoneTime("3:02 am"), "3:02 AM");
  assert.equal(formatPhoneTime("00:00"), "12:00 AM");
  assert.equal(formatPhoneTime("12:00"), "12:00 PM");
  assert.equal(formatPhoneTime("12:00 am"), "12:00 AM");
  assert.equal(formatPhoneTime("12:00 pm"), "12:00 PM");
});

test("a wall clock does not move when the branch zone changes", () => {
  assert.equal(formatPhoneTime("2026-06-18 15:02", KIRITIMATI), "3:02 PM");
  assert.equal(formatPhoneTime("2026-06-18T15:02:00", HONOLULU), "3:02 PM");
  assert.equal(formatPhoneDate("2026-06-18 15:02", KIRITIMATI), "Jun 18, 2026");
});

test("an instant is shown in the branch time zone", () => {
  const instant = "2026-06-18T19:02:00Z";
  const date = new Date(instant);
  assert.equal(formatPhoneTime(instant), "Unknown");
  assert.equal(formatPhoneDate(instant), "Unknown");
  assert.equal(formatPhoneTime(date), "Unknown");
  assert.equal(formatPhoneTime(instant, TORONTO), "3:02 PM");
  assert.equal(formatPhoneTime(date, TORONTO), "3:02 PM");
  assert.equal(formatPhoneDate(instant, TORONTO), "Jun 18, 2026");
  assert.equal(formatPhoneTime(instant, "UTC"), "7:02 PM");
  assert.equal(formatPhoneDate(instant, "UTC"), "Jun 18, 2026");
  assert.equal(formatPhoneTime("2026-06-18T03:30:00Z", TORONTO), "11:30 PM");
  assert.equal(formatPhoneDate("2026-06-18T03:30:00Z", TORONTO), "Jun 17, 2026");
  assert.equal(formatPhoneTime(instant, KIRITIMATI), "9:02 AM");
  assert.equal(formatPhoneDate(instant, KIRITIMATI), "Jun 19, 2026");
});

test("a calendar date never shifts through UTC", () => {
  for (const zone of [TORONTO, "UTC", HONOLULU, KIRITIMATI]) {
    assert.equal(formatPhoneDate("2026-06-18", zone), "Jun 18, 2026");
    assert.equal(formatPhoneDate("2026-06-08", zone), "Jun 8, 2026");
  }
  assert.equal(formatPhoneDate(new Date("2026-06-18T00:00:00Z"), TORONTO), "Jun 17, 2026");
});

test("blank stays blank and a bad clock or date is Unknown", () => {
  assert.equal(formatPhoneTime(""), "");
  assert.equal(formatPhoneTime(null), "");
  assert.equal(formatPhoneDate(""), "");
  assert.equal(formatPhoneDate(null), "");
  assert.equal(formatPhoneDate("not-a-date"), "Unknown");
  assert.equal(formatPhoneTime("2026-06-18"), "Unknown");
  assert.equal(formatPhoneDate("15:02"), "Unknown");
  assert.equal(formatPhoneTime(new Date("nope")), "Unknown");
  assert.equal(formatPhoneTime("15:02", "Not/AZone"), "Unknown");
  assert.equal(formatPhoneDate("2026-06-18", "Not/AZone"), "Unknown");
  assert.equal(formatPhoneDate("2026-06-18T19:02:00Z", "Not/AZone"), "Unknown");
  assert.equal(formatPhoneTime("25:00"), "Unknown");
  assert.equal(formatPhoneTime("13:02 AM"), "Unknown");
  assert.equal(formatPhoneTime("13:02 PM"), "Unknown");
  assert.equal(formatPhoneTime("13:02"), "1:02 PM");
  assert.equal(formatPhoneDate("2026-02-31"), "Unknown");
  assert.equal(formatPhoneDate("2026-02-29"), "Unknown");
  assert.equal(formatPhoneDate("2024-02-29"), "Feb 29, 2024");
  assert.equal(formatPhoneDate("2026-04-31"), "Unknown");
  assert.equal(formatPhoneListGroup("2026-02-31", "2026-10-11"), "Unknown");
  assert.equal(formatPhoneListGroup("2026-06-18T19:02:00Z", "2026-06-18"), "Unknown");
});

test("junk is Unknown, not a clock or a date parsed out of it", () => {
  for (const value of ["junk 9:05 junk", "ref 12:34", "2026-10-11 junk", "0000-01-01"]) {
    assert.equal(formatPhoneTime(value), "Unknown", value);
    assert.equal(formatPhoneDate(value), "Unknown", value);
    assert.equal(formatPhoneListGroup(value, "2026-10-11"), "Unknown", value);
    assert.equal(formatPhoneTime(value, "America/Toronto"), "Unknown", value);
    assert.equal(formatPhoneDate(value, "Asia/Jerusalem"), "Unknown", value);
  }
  assert.notEqual(formatPhoneTime("junk 9:05 junk"), "9:05 AM");
  assert.notEqual(formatPhoneTime("ref 12:34"), "12:34 PM");
  assert.notEqual(formatPhoneDate("2026-10-11 junk"), "Oct 11, 2026");
  assert.notEqual(formatPhoneDate("0000-01-01"), "Jan 1, 0");
});

test("a list group for the business day is Today, Oct 11", () => {
  assert.equal(formatPhoneListGroup("2026-10-11", "2026-10-11"), "Today, Oct 11");
  assert.equal(formatPhoneListGroup("2026-06-18", "2026-10-11"), "Jun 18, 2026");
  assert.equal(formatPhoneListGroup("2026-10-08", "2026-10-11"), "Oct 8, 2026");
  assert.equal(formatPhoneDate("2026-06-18"), "Jun 18, 2026");
  assert.equal(formatPhoneListGroup("", "2026-10-11"), "");
  assert.equal(formatPhoneListGroup("2026-10-11", ""), "Oct 11, 2026");
});

test("money prints the code after grouped digits", () => {
  assert.equal(formatPhoneMoney(1765.05, "CAD"), "1,765.05 CAD");
  assert.equal(formatPhoneMoney(1200, "JPY"), "1,200 JPY");
  assert.equal(formatPhoneMoney(1.234, "BHD"), "1.234 BHD");
  assert.equal(formatPhoneMoney(null, "CAD"), "");
  assert.equal(formatPhoneMoney("", "CAD"), "");
  assert.equal(formatPhoneMoney("nope", "USD"), "\u2014");
  assert.equal(formatPhoneMoney("0x10", "CAD"), "\u2014");
  assert.equal(formatPhoneMoney("1,2,3", "CAD"), "\u2014");
  assert.equal(formatPhoneMoney("1e2", "CAD"), "\u2014");
  assert.equal(formatPhoneMoney("1,200.00", "CAD"), "1,200.00 CAD");
  assert.equal(formatPhoneMoney("9007199254740993.25", "CAD"), "9,007,199,254,740,993.25 CAD");
  assert.equal(formatPhoneMoney(Number.MAX_SAFE_INTEGER + 2, "CAD"), "\u2014");
  assert.equal(formatPhoneMoney(-5, "USD"), "\u22125.00 USD");
  assert.equal(formatPhoneMoney(0, "JPY"), "0 JPY");
  assert.equal(formatPhoneMoney(0, "CAD"), "0.00 CAD");
  assert.equal(formatPhoneMoney(1765.05, "cad"), "1,765.05 CAD");
  assert.equal(formatPhoneMoney(1765.05, "$"), "");
  assert.equal(formatPhoneMoney(1765.05, "CAD").includes("$"), false);
});

test("a wait under an hour is m:ss, and an hour or more is h:mm:ss", () => {
  assert.equal(formatPhoneWait(299), "4:59");
  assert.equal(formatPhoneWait(61), "1:01");
  assert.equal(formatPhoneWait(3599), "59:59");
  assert.equal(formatPhoneWait(3600), "1:00:00");
  assert.equal(formatPhoneWait(86400), "24:00:00");
  assert.equal(formatPhoneWait(0), "");
  assert.equal(formatPhoneWait(-1), "");
  assert.equal(formatPhoneWait(Number.NaN), "");
});

test("a finished or past lock says the keypad is back, in 12-hour time", () => {
  const back = "The keypad is back.";
  assert.equal(formatPhoneLock(0, "2026-10-12T15:00:00.000Z", TORONTO), back);
  assert.equal(formatPhoneLock(-5, "2026-10-12T14:00:00.000Z", TORONTO), back);
  assert.equal(formatPhoneLock(Number.NaN, "2020-01-01T00:00:00.000Z", TORONTO), back);
  assert.equal(
    formatPhoneLock(299, "2026-10-12T15:04:59.000Z", TORONTO),
    "Too many wrong tries. The till PIN is locked too. Try again in 4:59. The keypad comes back at 11:04 AM.",
  );
  assert.equal(
    formatPhoneLock(86400, "2026-10-13T15:00:00.000Z", TORONTO),
    "Too many wrong tries. The till PIN is locked too. Try again in 24:00:00. The keypad comes back at 11:00 AM.",
  );
  assert.equal(formatPhoneLock(86400, "2026-10-13T15:00:00.000Z", TORONTO).includes("1440"), false);
});
