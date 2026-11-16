/* Sign out ends the server session (issue #794).

   The desk session is an httpOnly cookie, so the page cannot delete it.
   Only POST /api/auth/logout ends it: the server revokes the session,
   writes auth.logout and clears the cookies. Resetting the page alone
   left that cookie valid, and a reload went straight back to the desk.

   Order: save the desk first (CDOS_PERSIST.end flushes while the cookie
   can still save), then revoke. Neither wait is unbounded: a save or a
   revoke that never answers is given up after WAIT_MS, so a bad network
   cannot hold the person at the counter.

   A revoke that does not land (offline, or the server refuses) leaves a
   sign-out owed. That is kept in storage as the time it was asked for,
   and nothing else: no staff id, no name, no shop. While one is owed the
   desk does not reopen on this browser's cookie, and the revoke is sent
   again. The mark lapses after MAX_AGE_MS, the longest desk session
   (three days, staging quick sign-in; an ordinary session is 12 hours),
   because by then the session it names has ended on its own.

   Lock desk is not this. The lock keeps the session for the same person
   at a shared counter; Sign out ends it. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, { deskSignout: api });
})(typeof window !== "undefined" ? window : globalThis, function () {
  var KEY = "cdos.signout.pending";
  var MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
  var WAIT_MS = 10000;
  var inflight = null;

  /* Settles with the work's answer (or `failed` if it throws), or with
     `failed` once ms have passed, whichever is first. */
  function within(work, ms, failed) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(failed); }, ms);
      Promise.resolve(work).then(function (value) { clearTimeout(timer); resolve(value); },
        function () { clearTimeout(timer); resolve(failed); });
    });
  }

  function owedAt(stored) {
    return typeof stored === "string" && /^[0-9]+$/.test(stored) ? Number(stored) : NaN;
  }
  function pending(storage, now) {
    try {
      if (!storage) return false;
      var at = owedAt(storage.getItem(KEY));
      return isFinite(at) && isFinite(now) && at <= now && now - at < MAX_AGE_MS;
    } catch (e) { return false; }   // storage is off: nothing can be owed in it
  }
  function remember(storage, now) {
    try {
      if (!storage) return false;
      storage.setItem(KEY, String(now));
      return storage.getItem(KEY) === String(now);
    } catch (e) { return false; }
  }
  function forget(storage) {
    try { if (storage) storage.removeItem(KEY); } catch (e) { /* storage is off */ }
  }

  /* True only when the server answered 2xx. A refusal is not a revoke. */
  function revoke(fetchFn, waitMs) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var asked;
    try {
      asked = fetchFn("/api/auth/logout", {
        method: "POST", credentials: "same-origin", signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) { asked = Promise.reject(e); }
    var answer = Promise.resolve(asked).then(function (r) { return !!(r && r.ok); });
    return within(answer, waitMs, false).then(function (ok) {
      if (!ok && ctl) ctl.abort();   // a request still out is stopped, not left to land later
      return ok;
    });
  }

  function endDesk(persist) {
    try { return persist && typeof persist.end === "function" ? persist.end() : null; }
    catch (e) { return null; }
  }

  /* deps: { fetch, persist, storage, now, waitMs }. A second call while
     one is running gets the same answer and sends nothing more. */
  function signOut(deps) {
    if (inflight) return inflight;
    var d = deps || {};
    var waitMs = typeof d.waitMs === "number" ? d.waitMs : WAIT_MS;
    var now = typeof d.now === "function" ? d.now : Date.now;
    inflight = (async function () {
      /* Owed from the moment it is asked: a reload mid-way must not
         reopen the desk. */
      var remembered = remember(d.storage, now());
      await within(endDesk(d.persist), waitMs, null);
      var ok = await revoke(d.fetch, waitMs);
      if (ok) { forget(d.storage); return { revoked: true, remembered: false }; }
      return { revoked: false, remembered: remembered };
    })();
    return inflight.then(function (result) { inflight = null; return result; },
      function (error) { inflight = null; throw error; });
  }

  /* Send an owed revoke. True when nothing is owed afterwards. `owed`
     sends it even when storage holds no mark (storage refused it, and
     only the open page remembers). */
  async function retry(deps) {
    var d = deps || {};
    var now = typeof d.now === "function" ? d.now : Date.now;
    if (!d.owed && !pending(d.storage, now())) { forget(d.storage); return true; }
    var ok = await revoke(d.fetch, typeof d.waitMs === "number" ? d.waitMs : WAIT_MS);
    if (ok) forget(d.storage);
    return ok;
  }

  return {
    KEY: KEY, MAX_AGE_MS: MAX_AGE_MS, WAIT_MS: WAIT_MS,
    signOut: signOut, retry: retry, pending: pending, forget: forget,
  };
});
