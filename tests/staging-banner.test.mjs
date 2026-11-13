/* The staging bar can be hidden for ten minutes, and only ten. The clock
   is passed in, so these cases do not depend on when they run. Anything
   the bar cannot read as a past moment means the bar shows: a staging
   desk that forgets to say so is worse than one that says it twice. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bar = () => require(path.join(root, "os-src/staging-banner.js"));

const T = Date.parse("2026-11-02T15:00:00.000Z");
const MINUTE = 60_000;

function memory() {
  const items = new Map();
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { items.set(k, String(v)); },
    removeItem: (k) => { items.delete(k); },
  };
}
const throwing = {
  getItem() { throw new Error("storage is off"); },
  setItem() { throw new Error("storage is off"); },
  removeItem() { throw new Error("storage is off"); },
};

test("the key and the ten minutes are fixed", () => {
  const { KEY, HIDE_MS } = bar();
  assert.equal(KEY, "cdos.stagingBanner.hiddenAt");
  assert.equal(HIDE_MS, 600_000);
});

test("nothing stored: the bar shows", () => {
  const { isHidden, hiddenNow } = bar();
  assert.equal(isHidden(null, T), false);
  assert.equal(isHidden(undefined, T), false);
  assert.equal(hiddenNow(memory(), T), false);
});

test("hidden at t, still hidden at t+9:59, shown again at t+10:00", () => {
  const { hide, hiddenNow, isHidden } = bar();
  const store = memory();
  hide(store, T);
  assert.equal(hiddenNow(store, T), true);
  assert.equal(hiddenNow(store, T + 9 * MINUTE + 59_000), true);
  assert.equal(hiddenNow(store, T + 10 * MINUTE), false);
  assert.equal(isHidden(T, T + 10 * MINUTE - 1), true);
  assert.equal(isHidden(T, T + 10 * MINUTE), false);
});

test('"abc", "", NaN and a future time all show the bar', () => {
  const { isHidden, hiddenNow, KEY } = bar();
  for (const stored of ["abc", "", "  ", NaN, "NaN", Infinity, "1e3", "-5", T + 1, String(T + MINUTE)]) {
    assert.equal(isHidden(stored, T), false, JSON.stringify(String(stored)));
  }
  const store = memory();
  store.setItem(KEY, "abc");
  assert.equal(hiddenNow(store, T), false);
  store.setItem(KEY, String(T + MINUTE));
  assert.equal(hiddenNow(store, T), false);
  /* A stored number, as text, is read exactly. */
  store.setItem(KEY, String(T));
  assert.equal(hiddenNow(store, T + MINUTE), true);
});

test("storage that throws shows the bar, and hiding does not throw", () => {
  const { hiddenNow, hide } = bar();
  assert.equal(hiddenNow(throwing, T), false);
  assert.doesNotThrow(() => hide(throwing, T));
  assert.equal(hiddenNow(null, T), false);
  assert.doesNotThrow(() => hide(null, T));
});

test("invalid stored timestamps cannot hide the bar near the start of the clock", () => {
  const { isHidden } = bar();
  for (const stored of ["-5", -5, "1.5", 1.5, "9".repeat(400), { t: 1 }, "0", 0]) {
    assert.equal(isHidden(stored, 2), false, JSON.stringify(stored));
  }
});

test("unsafe integers are not exact stored timestamps", () => {
  const { isHidden } = bar();
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(isHidden(unsafe, unsafe), false);
  assert.equal(isHidden(String(unsafe), unsafe), false);
});

test("a missing, coerced or fractional current clock shows the bar", () => {
  const { isHidden } = bar();
  for (const now of [undefined, null, true, "2", [2], { t: 2 }, NaN, Infinity, -1, 0, 1.5]) {
    assert.equal(isHidden(1, now), false, String(now));
  }
});

test("small positive and safe-boundary integers retain the exact interval", () => {
  const { isHidden, HIDE_MS } = bar();
  for (const at of [1, T, Number.MAX_SAFE_INTEGER - HIDE_MS]) {
    for (const stored of [at, String(at)]) {
      assert.equal(isHidden(stored, at), true);
      assert.equal(isHidden(stored, at + HIDE_MS - 1), true);
      assert.equal(isHidden(stored, at + HIDE_MS), false);
    }
  }
});

test("invalid storage values are visible without changing the saved value", () => {
  const { hiddenNow, KEY } = bar();
  const store = memory();
  for (const stored of ["-5", "1.5", "9".repeat(400), '{"t":1}', "0"]) {
    store.setItem(KEY, stored);
    assert.equal(hiddenNow(store, 2), false, stored);
    assert.equal(store.getItem(KEY), stored);
  }
});

test("hide does not persist an invalid clock, and valid hiding still works", () => {
  const { hide, hiddenNow, KEY } = bar();
  const store = memory();
  for (const now of [undefined, null, true, "2", -5, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    hide(store, now);
    assert.equal(store.getItem(KEY), null, String(now));
  }
  hide(store, T);
  assert.equal(store.getItem(KEY), String(T));
  assert.equal(hiddenNow(store, T), true);
});
