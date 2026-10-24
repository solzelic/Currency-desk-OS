/* The desk has one clock. These cases are hardcoded so a locale
   change or a UTC slice cannot go green. Asia/Jerusalem just after
   UTC midnight is already the next civil day. America/Toronto late
   in the evening is still the previous one. Toronto's spring
   change skips the 2 o'clock hour. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function clock() {
  return require(path.join(root, "os-src/cdos-desk-time.js"));
}

const JERUSALEM_NIGHT = Date.parse("2026-10-20T21:05:00.000Z");
const TORONTO_NIGHT = Date.parse("2026-10-21T03:30:00.000Z");
const AFTERNOON = Date.parse("2026-06-18T19:43:00.000Z");
const BEFORE_SPRING = Date.parse("2026-03-08T06:30:00.000Z");
const AFTER_SPRING = Date.parse("2026-03-08T07:30:00.000Z");

test("3:43 pm in Toronto and 10:43 pm in Jerusalem are the same instant", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(deskTime(AFTERNOON, "12h", "America/Toronto"), "3:43 pm");
  assert.equal(deskDay(AFTERNOON, "America/Toronto"), "2026-06-18");
  assert.equal(deskTime(AFTERNOON, "12h", "Asia/Jerusalem"), "10:43 pm");
  assert.equal(deskDay(AFTERNOON, "Asia/Jerusalem"), "2026-06-18");
  assert.equal(deskTime(AFTERNOON, "24h", "America/Toronto"), "15:43");
  assert.equal(deskTime(new Date(AFTERNOON), "12h", "America/Toronto"), "3:43 pm");
});

test("a Jerusalem minute after UTC midnight is the next branch day", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(new Date(JERUSALEM_NIGHT).toISOString().slice(0, 10), "2026-10-20");
  assert.equal(deskDay(JERUSALEM_NIGHT, "Asia/Jerusalem"), "2026-10-21");
  assert.equal(deskTime(JERUSALEM_NIGHT, "12h", "Asia/Jerusalem"), "12:05 am");
});

test("a Toronto evening is still the previous branch day", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(new Date(TORONTO_NIGHT).toISOString().slice(0, 10), "2026-10-21");
  assert.equal(deskDay(TORONTO_NIGHT, "America/Toronto"), "2026-10-20");
  assert.equal(deskTime(TORONTO_NIGHT, "12h", "America/Toronto"), "11:30 pm");
});

test("Toronto spring forward skips the 2 o'clock hour", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(deskDay(BEFORE_SPRING, "America/Toronto"), "2026-03-08");
  assert.equal(deskTime(BEFORE_SPRING, "12h", "America/Toronto"), "1:30 am");
  assert.equal(deskDay(AFTER_SPRING, "America/Toronto"), "2026-03-08");
  assert.equal(deskTime(AFTER_SPRING, "12h", "America/Toronto"), "3:30 am");
  assert.notEqual(deskTime(AFTER_SPRING, "12h", "America/Toronto"), "2:30 am");
});

const NOON = Date.parse("2026-10-24T09:00:00.000Z");
const LAST_MINUTE = Date.parse("2026-06-19T03:59:00.000Z");
const JERUSALEM_BEFORE = Date.parse("2026-03-26T23:30:00.000Z");
const JERUSALEM_AFTER = Date.parse("2026-03-27T00:30:00.000Z");

test("noon is 12:00 pm and the last minute of the day is 11:59 pm", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(deskDay(NOON, "Asia/Jerusalem"), "2026-10-24");
  assert.equal(deskTime(NOON, "12h", "Asia/Jerusalem"), "12:00 pm");
  assert.equal(deskTime(NOON, "24h", "Asia/Jerusalem"), "12:00");
  assert.equal(deskDay(LAST_MINUTE, "America/Toronto"), "2026-06-18");
  assert.equal(deskTime(LAST_MINUTE, "12h", "America/Toronto"), "11:59 pm");
  assert.equal(deskTime(LAST_MINUTE, "24h", "America/Toronto"), "23:59");
});

test("Jerusalem spring forward skips the 2 o'clock hour", () => {
  const { deskTime, deskDay } = clock();
  assert.equal(deskDay(JERUSALEM_BEFORE, "Asia/Jerusalem"), "2026-03-27");
  assert.equal(deskTime(JERUSALEM_BEFORE, "12h", "Asia/Jerusalem"), "1:30 am");
  assert.equal(deskDay(JERUSALEM_AFTER, "Asia/Jerusalem"), "2026-03-27");
  assert.equal(deskTime(JERUSALEM_AFTER, "12h", "Asia/Jerusalem"), "3:30 am");
  assert.notEqual(deskTime(JERUSALEM_AFTER, "12h", "Asia/Jerusalem"), "2:30 am");
});

test("a stored 24-hour reading shows as 12-hour", () => {
  const { deskClockText, deskRow } = clock();
  assert.equal(deskClockText("04:25", "12h"), "4:25 am");
  assert.equal(deskClockText("23:26", "12h"), "11:26 pm");
  assert.equal(deskClockText("3:43 pm", "12h"), "3:43 pm");
  const row = deskRow({ at: AFTERNOON, date: "2026-06-17", time: "19:43" }, "12h", "America/Toronto");
  assert.deepEqual(row, { day: "2026-06-18", time: "3:43 pm" });
});

test("an unreadable zone still returns a clock", () => {
  const { deskTime, deskDay } = clock();
  assert.match(deskTime(AFTERNOON, "12h", "Mars/Olympus"), /^\d{1,2}:\d{2} [ap]m$/);
  assert.match(deskDay(AFTERNOON, "Mars/Olympus"), /^\d{4}-\d{2}-\d{2}$/);
});

test("the ledger row takes its day and clock from the helper", () => {
  const src = readFileSync(path.join(root, "os-src/cdos-backend.js"), "utf8");
  const fn = src.slice(src.indexOf("function transactionToRow"), src.indexOf("async function loadLedger"));
  assert.match(fn, /deskDay\(/);
  assert.match(fn, /deskTime\(/);
  assert.doesNotMatch(fn, /toLocaleTimeString/);
  assert.doesNotMatch(fn, /toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/);
});

test("the shell loads the helper before the screens that call it", () => {
  const modules = readFileSync(path.join(root, "os-src/cdos-modules.jsx"), "utf8");
  const shell = readFileSync(path.join(root, "CurrencyDesk OS.html"), "utf8");
  assert.doesNotMatch(modules, /function deskTime/);
  const at = shell.indexOf('src="os-src/cdos-desk-time.js"');
  assert.ok(at > 0);
  assert.ok(at < shell.indexOf('src="os-src/cdos-base.jsx"'));
  assert.ok(at < shell.indexOf('src="os-src/cdos-modules.jsx"'));
});

/* Counts of the display calls. The helper is not in this list.
   A new call outside it fails. A call removed here lowers the count
   in the same change. Computation that was already here stays until
   that file moves onto the helper.
   getHours has no baseline. A call outside the helper fails. */
const BASELINE = {
  "YorkFX/yorkfx-staff.js": { time: 1, day: 0 },
  "design/kyc-handoff/kyc-verification-states.html": { time: 0, day: 2 },
  "os-src/cdos-backend.js": { time: 0, day: 1 },
  "os-src/cdos-cheques.jsx": { time: 0, day: 1 },
  "os-src/cdos-import.jsx": { time: 0, day: 2 },
  "os-src/cdos-kyc.jsx": { time: 0, day: 1 },
  "os-src/cdos-search.jsx": { time: 0, day: 1 },
  "os-src/cdos-settings.jsx": { time: 0, day: 2 },
  "os-src/cdos-till.jsx": { time: 2, day: 0 },
  "os-src/cdos-txmodal.jsx": { time: 2, day: 1 },
};

const TIME = /toLocaleTimeString/g;
const DAY = /toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/g;
const HOURS = /\.getHours\s*\(/g;
const HELPER = "os-src/cdos-desk-time.js";

function countText(text) {
  return {
    time: (text.match(TIME) || []).length,
    day: (text.match(DAY) || []).length,
    hours: (text.match(HOURS) || []).length,
  };
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!/\.(js|jsx|mjs|html)$/.test(name)) continue;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel === HELPER) continue;
    const found = countText(readFileSync(abs, "utf8"));
    /* getHours is counted on the desk screens. A stored patch needle in
       design HTML is not a screen, and it gets no baseline count. */
    if (!rel.startsWith("os-src/")) found.hours = 0;
    if (found.time || found.day || found.hours) out[rel] = found;
  }
}

function displayCalls() {
  const out = {};
  for (const dir of ["os-src", "YorkFX", "design"]) walk(path.join(root, dir), out);
  return out;
}

function sameCalls(actual, expected) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const misses = [];
  for (const key of [...keys].sort()) {
    const got = actual[key] || { time: 0, day: 0, hours: 0 };
    const want = expected[key] || { time: 0, day: 0, hours: 0 };
    const wantHours = want.hours || 0;
    if (got.time !== want.time || got.day !== want.day || (got.hours || 0) !== wantHours) {
      misses.push(`${key} time ${got.time} day ${got.day} hours ${got.hours || 0}, want time ${want.time} day ${want.day} hours ${wantHours}`);
    }
  }
  return misses;
}

test("a new display call outside the helper fails the check", () => {
  const actual = displayCalls();
  actual["os-src/new-screen.jsx"] = { time: 1, day: 0, hours: 1 };
  const misses = sameCalls(actual, BASELINE);
  assert.ok(misses.some((line) => line.startsWith("os-src/new-screen.jsx") && line.includes("hours 1")));
});

test("browser display calls match the helper baseline", () => {
  const misses = sameCalls(displayCalls(), BASELINE);
  assert.deepEqual(misses, []);
});

test("the helper does not call the display APIs it replaces", () => {
  const src = readFileSync(path.join(root, HELPER), "utf8");
  assert.equal(countText(src).time, 0);
  assert.equal(countText(src).day, 0);
});
