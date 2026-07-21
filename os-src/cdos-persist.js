/* ============================================================
   CurrencyDesk OS — per-tenant persistence bridge
   The OS keeps its live state in ~30 browser keys (cdos_* / yorkfx_*).
   This bridge makes a signed-in desk REAL: on entry it loads the tenant's
   saved snapshot from the server into those keys, and while the desk is used
   it writes the snapshot back (debounced), scoped to that one tenant.

   Backend: GET/PUT /api/tenant/state (see server/src/routes/tenantState.ts),
   always scoped to the session's own tenant. No backend / no session → the
   bridge no-ops and the offline demo keeps running on localStorage alone.
   ============================================================ */
window.CDOS_PERSIST = (function () {
  var KEY_RE = /^(cdos_|yorkfx_)/;
  var tenantId = null;
  var lastSig = '';
  var timer = null;

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

  // Load this tenant's snapshot into localStorage.
  //   'restored' — the server had saved state; it's now in localStorage
  //   'empty'    — no saved state yet; caller decides the starting desk
  //   'offline'  — no backend / not signed in; demo continues untouched
  async function begin(tid) {
    tenantId = tid || null;
    if (!tenantId) return 'offline';
    var res;
    try {
      var r = await fetch('/api/tenant/state', { credentials: 'same-origin' });
      if (!r.ok) { tenantId = null; return 'offline'; }
      res = await r.json();
    } catch (e) { tenantId = null; return 'offline'; }
    if (res && res.state && Object.keys(res.state).length) {
      applyState(res.state);
      lastSig = JSON.stringify(snapshot());
      return 'restored';
    }
    lastSig = ''; // empty — the caller seeds a fresh (or demo) desk, then save()
    return 'empty';
  }

  async function save() {
    if (!tenantId) return;
    var snap = snapshot();
    var sig = JSON.stringify(snap);
    if (sig === lastSig) return; // unchanged since the last successful save
    try {
      var r = await fetch('/api/tenant/state', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ state: snap }),
      });
      if (r.ok) lastSig = sig;
    } catch (e) { /* keep lastSig so we retry on the next tick */ }
  }

  function startAutosave() {
    if (timer || !tenantId) return;
    timer = setInterval(save, 4000);
    window.addEventListener('beforeunload', function () {
      if (!tenantId) return;
      var snap = snapshot();
      if (JSON.stringify(snap) === lastSig) return;
      try {
        fetch('/api/tenant/state', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ state: snap }), keepalive: true,
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
  }

  // let the caller mark the current localStorage as the saved baseline
  // (after seeding a fresh desk we save() explicitly, which sets this)
  function markClean() { lastSig = JSON.stringify(snapshot()); }

  return {
    begin: begin, save: save, end: end, startAutosave: startAutosave,
    snapshot: snapshot, applyState: applyState, clearKeys: clearKeys,
    markClean: markClean, tenant: function () { return tenantId; },
  };
})();
