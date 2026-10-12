/* Shared phone formatters. Run with: node --test tests/phone-format.test.mjs
   A calendar day must stay on that day in every zone. An instant is
   shown in the zone the caller passes, which defaults to the desk zone. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { formatPhoneTime, formatPhoneDate, formatPhoneMoney } = require("../os-src/phone/format.js");

const TORONTO = "America/Toronto";
const KIRITIMATI = "Pacific/Kiritimati";
const HONOLULU = "Pacific/Honolulu";

test("3:02 pm is twelve-hour with lowercase am and pm", () => {
  assert.equal(formatPhoneTime("15:02"), "3:02 pm");
  assert.equal(formatPhoneTime("15:02", KIRITIMATI), "3:02 pm");
  assert.equal(formatPhoneTime("3:02 PM"), "3:02 pm");
  assert.equal(formatPhoneTime("3:02 am"), "3:02 am");
  assert.equal(formatPhoneTime("00:00"), "12:00 am");
  assert.equal(formatPhoneTime("12:00"), "12:00 pm");
  assert.equal(formatPhoneTime("12:00 am"), "12:00 am");
  assert.equal(formatPhoneTime("12:00 pm"), "12:00 pm");
});

test("a wall clock does not move when the branch zone changes", () => {
  assert.equal(formatPhoneTime("2026-06-18 15:02", KIRITIMATI), "3:02 pm");
  assert.equal(formatPhoneTime("2026-06-18T15:02:00", HONOLULU), "3:02 pm");
  assert.equal(formatPhoneDate("2026-06-18 15:02", KIRITIMATI), "Jun 18, 2026");
});

test("an instant is shown in the branch time zone", () => {
  const instant = "2026-06-18T19:02:00Z";
  const date = new Date(instant);
  assert.equal(formatPhoneTime(instant), "3:02 pm");
  assert.equal(formatPhoneTime(instant, TORONTO), "3:02 pm");
  assert.equal(formatPhoneTime(date, TORONTO), "3:02 pm");
  assert.equal(formatPhoneDate(instant, TORONTO), "Jun 18, 2026");
  assert.equal(formatPhoneTime(instant, "UTC"), "7:02 pm");
  assert.equal(formatPhoneDate(instant, "UTC"), "Jun 18, 2026");
  assert.equal(formatPhoneTime("2026-06-18T03:30:00Z", TORONTO), "11:30 pm");
  assert.equal(formatPhoneDate("2026-06-18T03:30:00Z", TORONTO), "Jun 17, 2026");
  assert.equal(formatPhoneTime(instant, KIRITIMATI), "9:02 am");
  assert.equal(formatPhoneDate(instant, KIRITIMATI), "Jun 19, 2026");
});

test("a calendar date never shifts through UTC", () => {
  for (const zone of [TORONTO, "UTC", HONOLULU, KIRITIMATI]) {
    assert.equal(formatPhoneDate("2026-06-18", zone), "Jun 18, 2026");
    assert.equal(formatPhoneDate("2026-06-08", zone), "Jun 8, 2026");
  }
  assert.equal(formatPhoneDate(new Date("2026-06-18T00:00:00Z"), TORONTO), "Jun 17, 2026");
});

test("blank, bad, and zoneless values stay absent", () => {
  assert.equal(formatPhoneTime(""), "");
  assert.equal(formatPhoneTime(null), "");
  assert.equal(formatPhoneDate(""), "");
  assert.equal(formatPhoneDate("not-a-date"), "");
  assert.equal(formatPhoneTime("2026-06-18"), "");
  assert.equal(formatPhoneDate("15:02"), "");
  assert.equal(formatPhoneTime(new Date("nope")), "");
  assert.equal(formatPhoneTime("15:02", "Not/AZone"), "");
  assert.equal(formatPhoneDate("2026-06-18", "Not/AZone"), "");
  assert.equal(formatPhoneDate("2026-06-18T19:02:00Z", "Not/AZone"), "");
  assert.equal(formatPhoneTime("25:00"), "");
});

test("money prints the code after grouped digits", () => {
  assert.equal(formatPhoneMoney(1765.05, "CAD"), "1,765.05 CAD");
  assert.equal(formatPhoneMoney(1200, "JPY"), "1,200 JPY");
  assert.equal(formatPhoneMoney(1.234, "BHD"), "1.234 BHD");
  assert.equal(formatPhoneMoney(null, "CAD"), "");
  assert.equal(formatPhoneMoney("", "CAD"), "");
  assert.equal(formatPhoneMoney("nope", "USD"), "");
  assert.equal(formatPhoneMoney(-5, "USD"), "\u22125.00 USD");
  assert.equal(formatPhoneMoney(0, "JPY"), "0 JPY");
  assert.equal(formatPhoneMoney(0, "CAD"), "0.00 CAD");
  assert.equal(formatPhoneMoney(1765.05, "cad"), "1,765.05 CAD");
  assert.equal(formatPhoneMoney(1765.05, "$"), "");
  assert.equal(formatPhoneMoney(1765.05, "CAD").includes("$"), false);
});
