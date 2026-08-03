/* ============================================================
   CurrencyDesk OS — per-tenant persistence bridge
   The OS keeps its live state in ~30 browser keys (cdos_* / yorkfx_*).
   This bridge makes a signed-in desk REAL: on entry it loads the tenant's
   saved snapshot from the server into those keys, and while the desk is used
   it writes the snapshot back (debounced), scoped to that one tenant.

   Backend: GET/PUT /api/tenant/state (see server/src/routes/tenantState.ts),
   always scoped to the session's own tenant. No backend / no session → the
   bridge no-ops and the offline demo keeps running on localStorage alone.

   ---- WHY THE FAILURE HANDLING BELOW IS AS LONG AS THE SAVING ----

   This used to be `if (r.ok) lastSig = sig;` and nothing else. Every other
   outcome fell through to a bare catch, which meant a desk whose saves were
   being refused retried the same doomed payload every four seconds, for the
   rest of the session, without one line in a console or one pixel on the
   screen. A teller kept working. Nothing was being kept.

   Two failures are NOT worth retrying, and telling them apart is the whole
   job:

     • 413 — the document is over the size limit. The next attempt is the
       same size. Retrying is not resilience, it is a loop.
     • 401 — the session is gone. Only signing in fixes it.

   Everything else (network dropped, server restarting, a 500) genuinely is
   worth another go, so those back off instead of hammering, and say so if
   they persist.
   ============================================================ */
window.CDOS_PERSIST = (function () {
  var KEY_RE = /^(cdos_|yorkfx_)/;
  var tenantId = null;
  var lastSig = '';
  var timer = null;

  /* How saving is going. 'ok' | 'retrying' | 'stopped' — 'stopped' means we
     have given up on purpose and only a person can clear it. */
  var health = 'ok';
  var failures = 0;
  var lastTrouble = null;
  var listeners = [];
  var warnedNearLimit = false;

  /* What the server had when we last agreed with it: the version number, and
     the document itself. The document is the baseline a three-way merge is
     measured against — without it we cannot tell "I changed this" from "they
     changed this", and every conflict would have to be resolved by one side
     losing everything. */
  var version = 0;
  var baseline = {};

  var SAVE_EVERY_MS = 4000;
  /* Back off rather than hammer a server that is already unhappy, but never
     so far that a recovered connection waits minutes to notice. */
  var BACKOFF_MS = [0, 4000, 8000, 15000, 30000, 60000];
  var nextAttemptAt = 0;
  /* Two misses can be a deploy restarting. Four is a problem worth a screen. */
  var SPEAK_AFTER = 4;

  function keys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && KEY_RE.test(k)) out.push(k);
    }
    return out;
  }
  function snapshot() {
    var o = {};
    keys().forEach(function (k) { o[k] = localStorage.getItem(k); });
    return o;
  }
  function clearKeys() { keys().forEach(function (k) { localStorage.removeItem(k); }); }
  function applyState(obj) {
    clearKeys();
    Object.keys(obj || {}).forEach(function (k) {
      if (KEY_RE.test(k) && obj[k] != null) localStorage.setItem(k, obj[k]);
    });
  }

  /* ---- telling somebody ------------------------------------------------
     A listener gets every change of state. The banner below is the default
     one; the OS can register its own and render this properly in-shell. */
  function onTrouble(fn) { if (typeof fn === 'function') listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  function announce(info) {
    lastTrouble = info;
    listeners.forEach(function (fn) { try { fn(info); } catch (e) {} });
    try { banner(info); } catch (e) {}
    if (info.level === 'stopped') console.error('[CurrencyDesk] saving stopped —', info.detail);
    else if (info.level === 'retrying') console.warn('[CurrencyDesk] save failing —', info.detail);
  }

  /* Drawn in plain DOM, deliberately.

     This is the one message that must survive everything, including React
     having thrown — the entire point of it is that this failure is never
     silent again, and a banner that depends on the app being healthy is not
     that. Kept visually quiet but impossible to miss, and it does not steal
     focus or block the screen: a teller mid-transaction should finish. */
  function banner(info) {
    var id = 'cdos-persist-banner';
    var el = document.getElementById(id);
    if (info.level === 'ok') { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'font:500 13px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
        'padding:10px 16px', 'display:flex', 'gap:10px', 'align-items:center',
        'box-shadow:0 -1px 0 rgba(0,0,0,.12), 0 -8px 24px rgba(0,0,0,.10)',
      ].join(';');
      document.body.appendChild(el);
    }
    var stopped = info.level === 'stopped';
    el.style.background = stopped ? '#7f1d1d' : '#78350f';
    el.style.color = '#fff';
    el.textContent = '';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:' + (stopped ? '#fca5a5' : '#fcd34d');
    var msg = document.createElement('span');
    msg.textContent = info.detail;
    el.appendChild(dot);
    el.appendChild(msg);
  }

  /* ---- merging two people's work ---------------------------------------

     Both browsers hold the whole document, so a refused save has to be
     reconciled rather than simply retried — retrying is what would erase
     the other person.

     Decided per key, against the baseline we last agreed on:

       we did not touch it     → take theirs, including their deletion
       we changed or made it   → ours stands
       we deleted it           → stays deleted

     Two tellers working on different things — one adding a client, one
     changing settings — therefore both keep their work.

     WHAT THIS CANNOT DO. If both changed the SAME key, ours wins and
     theirs is lost. `cdos_rows_v1` is one key holding every transaction, so
     two tellers trading at once is exactly that case. The merge does not
     save us there and is not pretending to: the real answer is that
     transactions belong in a table, one row each, which is why promoting
     them is the next piece of work (docs/ARCHITECTURE.md §3). This makes
     the common case safe and makes the remaining one smaller. */
  function merge(base, mine, theirs) {
    var out = {}, all = {};
    [base, mine, theirs].forEach(function (o) {
      Object.keys(o || {}).forEach(function (k) { all[k] = 1; });
    });
    Object.keys(all).forEach(function (k) {
      var b = base ? base[k] : undefined;
      var m = mine ? mine[k] : undefined;
      var t = theirs ? theirs[k] : undefined;
      if (m === b) { if (t !== undefined) out[k] = t; return; }  // not ours to decide
      if (m !== undefined) out[k] = m;                            // ours stands
    });
    return out;
  }

  // Load this tenant's snapshot into localStorage.
  //   'restored' — the server had saved state; it's now in localStorage
  //   'empty'    — no saved state yet; caller decides the starting desk
  //   'offline'  — no backend / not signed in; demo continues untouched
  async function begin(tid) {
    tenantId = tid || null;
    health = 'ok'; failures = 0; nextAttemptAt = 0; warnedNearLimit = false;
    version = 0; baseline = {};
    announce({ level: 'ok', detail: '' });
    if (!tenantId) return 'offline';
    var res;
    try {
      var r = await fetch('/api/tenant/state', { credentials: 'same-origin' });
      if (!r.ok) { tenantId = null; return 'offline'; }
      res = await r.json();
    } catch (e) { tenantId = null; return 'offline'; }
    version = (res && res.version) || 0;
    if (res && res.state && Object.keys(res.state).length) {
      applyState(res.state);
      baseline = snapshot();
      lastSig = JSON.stringify(baseline);
      return 'restored';
    }
    baseline = {};
    lastSig = ''; // empty — the caller seeds a fresh (or demo) desk, then save()
    return 'empty';
  }

  async function save() {
    if (!tenantId) return;
    if (health === 'stopped') return;           // a person has to clear this
    if (Date.now() < nextAttemptAt) return;     // backing off
    var snap = snapshot();
    var sig = JSON.stringify(snap);
    if (sig === lastSig) return; // unchanged since the last successful save

    var r;
    try {
      r = await fetch('/api/tenant/state', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ state: snap, version: version }),
      });
    } catch (e) {
      return transient('CurrencyDesk cannot reach the server. Your recent work is not saved yet.');
    }

    /* Somebody else saved while we were working. Merge their document with
       ours against the baseline, put the result back on screen, and let the
       next tick save it — deliberately NOT saving here, so a room full of
       browsers cannot turn one conflict into a storm of retries. */
    if (r.status === 409) {
      var conflict = null;
      try { conflict = await r.json(); } catch (e) {}
      if (conflict && conflict.state) {
        var merged = merge(baseline, snap, conflict.state);
        applyState(merged);
        baseline = snapshot();
        version = conflict.version || 0;
        lastSig = '';            // the merged document still needs saving
        failures = 0; nextAttemptAt = 0;
      }
      return;
    }

    if (r.ok) {
      lastSig = sig;
      baseline = snap;
      failures = 0; nextAttemptAt = 0;
      if (health !== 'ok') { health = 'ok'; announce({ level: 'ok', detail: '' }); }
      var body = null;
      try { body = await r.json(); } catch (e) {}
      // the version our next save will be built on
      if (body && typeof body.version === 'number') version = body.version;
      /* Said once, not every four seconds — a warning repeated on a loop is
         one people learn to ignore. */
      if (body && body.nearingLimit && !warnedNearLimit) {
        warnedNearLimit = true;
        announce({ level: 'retrying', code: 'nearing_limit', detail: "This desk's saved records are approaching the size limit. Everything is saved — but tell CurrencyDesk before it reaches it." });
      }
      return;
    }

    /* Over the limit. The next attempt is the same size as this one, so
       retrying is a loop, not resilience. Stop, and say so in words that
       point at a person rather than at a button. */
    if (r.status === 413) {
      var over = null;
      try { over = await r.json(); } catch (e) {}
      health = 'stopped';
      return announce({
        level: 'stopped', code: 'state_too_large',
        detail: (over && over.detail) || "This desk's records are too large to save. Nothing is being saved. Contact CurrencyDesk.",
      });
    }

    /* Session gone. Retrying cannot fix it either; the OS handles the
       sign-out, we just stop pretending we are saving. */
    if (r.status === 401) {
      health = 'stopped';
      return announce({ level: 'stopped', code: 'unauthenticated', detail: 'Your session ended. Sign in again — recent work on this screen is not saved.' });
    }

    return transient('CurrencyDesk could not save the last few minutes of work. Still trying.');
  }

  function transient(detail) {
    failures += 1;
    health = 'retrying';
    nextAttemptAt = Date.now() + (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
    if (failures >= SPEAK_AFTER) announce({ level: 'retrying', code: 'unreachable', detail: detail });
  }

  function startAutosave() {
    if (timer || !tenantId) return;
    timer = setInterval(save, SAVE_EVERY_MS);
    window.addEventListener('beforeunload', function () {
      if (!tenantId || health === 'stopped') return;
      var snap = snapshot();
      if (JSON.stringify(snap) === lastSig) return;
      try {
        /* Carries the version like any other save. There is no chance to
           merge during an unload, so a stale flush is refused and lost —
           which is the right way round: losing this browser's last few
           seconds beats erasing everything the other teller did. */
        fetch('/api/tenant/state', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ state: snap, version: version }), keepalive: true,
        });
      } catch (e) {}
    });
  }

  // called on sign-out: flush once, then detach so the next sign-in re-binds
  async function end() {
    try { await save(); } catch (e) {}
    if (timer) { clearInterval(timer); timer = null; }
    tenantId = null;
    lastSig = '';
    health = 'ok'; failures = 0; nextAttemptAt = 0;
    announce({ level: 'ok', detail: '' });
  }

  // let the caller mark the current localStorage as the saved baseline
  // (after seeding a fresh desk we save() explicitly, which sets this)
  function markClean() { baseline = snapshot(); lastSig = JSON.stringify(baseline); }

  return {
    begin: begin, save: save, end: end, startAutosave: startAutosave,
    snapshot: snapshot, applyState: applyState, clearKeys: clearKeys,
    markClean: markClean, tenant: function () { return tenantId; },
    onTrouble: onTrouble,
    status: function () { return { health: health, failures: failures, trouble: lastTrouble, version: version }; },
    /* Exposed because it is the one piece of logic in this file worth
       testing on its own: pure, and the thing standing between two tellers
       and a lost afternoon. See server/tests/state-merge.test.ts. */
    _merge: merge,
  };
})();
