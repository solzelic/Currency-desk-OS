/* Sign out ends the server session, after the desk is saved.

   The desk's Sign out used to reset the page and stop. The httpOnly
   session cookie stayed valid, so a reload went straight back to the
   desk with no PIN (issue #794). These cases pin the order (save, then
   revoke) and what happens when the revoke does not land: the browser
   remembers that a sign-out is owed, as a time and nothing else, so it
   never reopens the desk on that cookie and tries the revoke again. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const signout = () => require(path.join(root, "os-src/desk-signout.js"));

const T = Date.parse("2026-11-16T15:00:00.000Z");
const HOUR = 3_600_000;

function memory() {
  const items = new Map();
  return {
    items,
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

/* A fetch that records each call and answers with `answer`. */
function server(answer, log = []) {
  const fn = async (url, init) => {
    log.push({ url, init });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(url, init);
    return { ok: answer >= 200 && answer < 300, status: answer };
  };
  fn.log = log;
  return fn;
}
/* A fetch that never answers on its own and gives up only when aborted. */
function hanging(log = []) {
  const fn = (url, init) => {
    log.push({ url, init });
    return new Promise((_, reject) => {
      const signal = init && init.signal;
      if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  fn.log = log;
  return fn;
}

test("the key, the longest session and the wait are fixed", () => {
  const { KEY, MAX_AGE_MS, WAIT_MS } = signout();
  assert.equal(KEY, "cdos.signout.pending");
  /* staging quick sign-in lasts three days; an ordinary desk session 12 hours */
  assert.equal(MAX_AGE_MS, 3 * 24 * HOUR);
  assert.equal(WAIT_MS, 10_000);
});

test("the desk is saved before the session is revoked", async () => {
  const { signOut } = signout();
  const order = [];
  const persist = {
    end: async () => {
      order.push("save started");
      await new Promise((r) => setTimeout(r, 20));
      order.push("save finished");
    },
  };
  const fetch = server((url, init) => {
    order.push(`${init.method} ${url}`);
    return { ok: true, status: 200 };
  });
  const result = await signOut({ fetch, persist, storage: memory(), now: () => T });
  assert.deepEqual(order, ["save started", "save finished", "POST /api/auth/logout"]);
  assert.equal(result.revoked, true);
});

test("the revoke is a same-origin POST to /api/auth/logout", async () => {
  const { signOut } = signout();
  const fetch = server(200);
  await signOut({ fetch, persist: { end: async () => {} }, storage: memory(), now: () => T });
  assert.equal(fetch.log.length, 1);
  assert.equal(fetch.log[0].url, "/api/auth/logout");
  assert.equal(fetch.log[0].init.method, "POST");
  assert.equal(fetch.log[0].init.credentials, "same-origin");
});

test("a revoke the server confirms leaves nothing owed", async () => {
  const { signOut, pending, KEY } = signout();
  const storage = memory();
  const result = await signOut({ fetch: server(200), persist: { end: async () => {} }, storage, now: () => T });
  assert.deepEqual(result, { revoked: true, remembered: false });
  assert.equal(pending(storage, T), false);
  assert.equal(storage.items.has(KEY), false);
});

test("the sign-out is remembered before the revoke goes out", async () => {
  const { signOut, pending } = signout();
  const storage = memory();
  let owedWhenSent = null;
  const fetch = server(() => {
    owedWhenSent = pending(storage, T);
    return { ok: true, status: 200 };
  });
  await signOut({ fetch, persist: { end: async () => {} }, storage, now: () => T });
  /* a reload while the revoke is in flight must not reopen the desk */
  assert.equal(owedWhenSent, true);
});

test("offline: the revoke fails and the sign-out stays owed", async () => {
  const { signOut, pending, KEY } = signout();
  const storage = memory();
  const result = await signOut({
    fetch: server(new TypeError("Failed to fetch")), persist: { end: async () => {} }, storage, now: () => T,
  });
  assert.deepEqual(result, { revoked: false, remembered: true });
  assert.equal(pending(storage, T + 1), true);
  /* a time and nothing else: no staff id, no name, no shop */
  assert.match(storage.items.get(KEY), /^[0-9]+$/);
});

test("a refusal (503, 500, 429) is not a revoke", async () => {
  const { signOut, pending } = signout();
  for (const status of [503, 500, 429, 403]) {
    const storage = memory();
    const result = await signOut({ fetch: server(status), persist: { end: async () => {} }, storage, now: () => T });
    assert.equal(result.revoked, false, String(status));
    assert.equal(pending(storage, T), true, String(status));
  }
});

test("a revoke that never answers is given up after the wait", async () => {
  const { signOut, pending } = signout();
  const storage = memory();
  const fetch = hanging();
  const started = Date.now();
  const result = await signOut({ fetch, persist: { end: async () => {} }, storage, now: () => T, waitMs: 30 });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(fetch.log.length, 1);
  assert.equal(result.revoked, false);
  assert.equal(pending(storage, T), true);
});

test("a save that never finishes does not hold the sign-out forever", async () => {
  const { signOut } = signout();
  const fetch = server(200);
  const result = await signOut({
    fetch, persist: { end: () => new Promise(() => {}) }, storage: memory(), now: () => T, waitMs: 30,
  });
  assert.equal(fetch.log.length, 1);
  assert.equal(result.revoked, true);
});

test("a save that throws, or no save bridge at all, still revokes", async () => {
  const { signOut } = signout();
  for (const persist of [{ end: async () => { throw new Error("save broke"); } }, { end: () => { throw new Error("sync"); } }, {}, null, undefined]) {
    const fetch = server(200);
    const result = await signOut({ fetch, persist, storage: memory(), now: () => T });
    assert.equal(fetch.log.length, 1);
    assert.equal(result.revoked, true);
  }
});

test("storage that refuses: the revoke still runs and nothing throws", async () => {
  const { signOut, pending } = signout();
  const ok = await signOut({ fetch: server(200), persist: {}, storage: throwing, now: () => T });
  assert.deepEqual(ok, { revoked: true, remembered: false });
  const failed = await signOut({ fetch: server(new TypeError("offline")), persist: {}, storage: throwing, now: () => T });
  assert.deepEqual(failed, { revoked: false, remembered: false });
  assert.equal(pending(throwing, T), false);
  assert.equal(pending(null, T), false);
});

test("a second press while the first is in flight sends one revoke", async () => {
  const { signOut } = signout();
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = server(async () => { await gate; return { ok: true, status: 200 }; });
  const persist = { end: async () => {} };
  const first = signOut({ fetch, persist, storage: memory(), now: () => T });
  const second = signOut({ fetch, persist, storage: memory(), now: () => T });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fetch.log.length, 1);
  assert.deepEqual(a, b);
  /* and once it is over, a later sign-out goes out again */
  const later = server(200);
  await signOut({ fetch: later, persist, storage: memory(), now: () => T });
  assert.equal(later.log.length, 1);
});

test("owed for up to three days, then the session it names has ended", () => {
  const { pending, MAX_AGE_MS, KEY } = signout();
  const storage = memory();
  storage.setItem(KEY, String(T));
  assert.equal(pending(storage, T), true);
  assert.equal(pending(storage, T + MAX_AGE_MS - 1), true);
  assert.equal(pending(storage, T + MAX_AGE_MS), false);
});

test('"abc", "", a future time and junk are not owed', () => {
  const { pending, KEY } = signout();
  for (const stored of ["abc", "", " ", "NaN", "1e3", "-5", String(T + 1), "12.5"]) {
    const storage = memory();
    storage.setItem(KEY, stored);
    assert.equal(pending(storage, T), false, JSON.stringify(stored));
  }
});

test("retry: owed and confirmed clears it", async () => {
  const { retry, pending, KEY } = signout();
  const storage = memory();
  storage.setItem(KEY, String(T));
  const fetch = server(200);
  assert.equal(await retry({ fetch, storage, now: () => T + HOUR }), true);
  assert.equal(fetch.log.length, 1);
  assert.equal(fetch.log[0].url, "/api/auth/logout");
  assert.equal(pending(storage, T + HOUR), false);
});

test("retry: owed and still offline stays owed", async () => {
  const { retry, pending, KEY } = signout();
  const storage = memory();
  storage.setItem(KEY, String(T));
  assert.equal(await retry({ fetch: server(new TypeError("offline")), storage, now: () => T + HOUR }), false);
  assert.equal(pending(storage, T + HOUR), true);
  assert.equal(await retry({ fetch: server(503), storage, now: () => T + HOUR }), false);
  assert.equal(pending(storage, T + HOUR), true);
});

test("retry: nothing owed sends nothing, and an expired mark is dropped", async () => {
  const { retry, KEY, MAX_AGE_MS } = signout();
  const none = server(200);
  assert.equal(await retry({ fetch: none, storage: memory(), now: () => T }), true);
  assert.equal(none.log.length, 0);

  const storage = memory();
  storage.setItem(KEY, String(T));
  const stale = server(200);
  assert.equal(await retry({ fetch: stale, storage, now: () => T + MAX_AGE_MS }), true);
  assert.equal(stale.log.length, 0);
  assert.equal(storage.items.has(KEY), false);
});

test("retry: owed on the page alone (storage refused) still sends", async () => {
  const { retry } = signout();
  const fetch = server(200);
  assert.equal(await retry({ fetch, storage: throwing, now: () => T, owed: true }), true);
  assert.equal(fetch.log.length, 1);
  assert.equal(await retry({ fetch: server(new TypeError("offline")), storage: throwing, now: () => T, owed: true }), false);
});

test("forget removes the mark, and a refusing storage does not throw", () => {
  const { forget, pending, KEY } = signout();
  const storage = memory();
  storage.setItem(KEY, String(T));
  forget(storage);
  assert.equal(pending(storage, T), false);
  forget(throwing);
  forget(null);
});
