/* ============================================================
   YORK FX — Staff Rate Editor logic
   Requires yorkfx-converter.js (CUR, BY, cadValue, fmtCad) loaded first.
   Publishes to localStorage('yorkfx_rates_v1'); the public boards read it.

   Features: global spread + per-row spread override, live data-feed
   status with auto-pull countdown, per-row change arrows, an optional
   member-rate column, and amber highlighting for unsaved manual edits.
   ============================================================ */
(function () {
  'use strict';

  var KEY_PUB = 'yorkfx_rates_v1';      // published — what the live site reads
  var KEY_DRAFT = 'yorkfx_rates_draft'; // work-in-progress — survives refresh
  var KEY_AUTH = 'yorkfx_staff_auth';   // simple demo session
  var DEMO_PASSWORD = 'york';           // offline fallback ONLY (no backend at all)
  var PULL_MS = 60000;                  // backend poll cadence — the converter refreshes every minute

  /* ---------------- currencies (everything except CAD) ---------------- */
  var LIST = CUR.filter(function (c) { return c.code !== 'CAD'; });
  /* the rate feed provides the catalog of currencies; staff add / remove from it.
     A 'removed' currency is off the board (and off the public boards). */
  var KEY_REMOVED = 'yorkfx_board_removed';
  var removed = (function () { try { var r = JSON.parse(localStorage.getItem(KEY_REMOVED)); return new Set(Array.isArray(r) ? r : []); } catch (e) { return new Set(); } })();
  function saveRemoved() { try { localStorage.setItem(KEY_REMOVED, JSON.stringify(Array.from(removed))); } catch (e) {} }
  function boardList() { return LIST.filter(function (c) { return !removed.has(c.code); }); }
  function feedAvailable() { return LIST.filter(function (c) { return removed.has(c.code); }); }
  /* membership edits awaiting Publish — reconciliation must not undo them */
  var pendingAdd = new Set(), pendingRemove = new Set();

  function round(v, dp) { var f = Math.pow(10, dp); return Math.round(v * f) / f; }
  function midDp(v) { return v >= 100 ? 2 : (v >= 1 ? 4 : 5); }
  function fmtMid(v) { return Number(v).toLocaleString('en-CA', { minimumFractionDigits: midDp(v), maximumFractionDigits: midDp(v) }); }
  function fmtDelta(v) { var dp = v >= 1 ? 4 : 5; return Number(v).toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }

  /* factory config — original mids straight from the data file */
  function factoryConfig() {
    var rows = {};
    LIST.forEach(function (c) {
      rows[c.code] = { mid: round(1 / c.perCadDefault, 6), show: true, spread: null, manual: false };
    });
    return { buyMargin: 0.015, sellMargin: 0.015, rows: rows, publishedAt: null, publishedBy: null };
  }

  /* fill any gaps so every currency has a complete row (stable compare) */
  function normalize(cfg) {
    var base = factoryConfig();
    var out = {
      buyMargin: typeof cfg.buyMargin === 'number' ? cfg.buyMargin : base.buyMargin,
      sellMargin: typeof cfg.sellMargin === 'number' ? cfg.sellMargin : base.sellMargin,
      rows: {},
      publishedAt: cfg.publishedAt || null,
      publishedBy: cfg.publishedBy || null
    };
    LIST.forEach(function (c) {
      var r = (cfg.rows && cfg.rows[c.code]) || base.rows[c.code];
      out.rows[c.code] = {
        mid: typeof r.mid === 'number' && r.mid > 0 ? r.mid : base.rows[c.code].mid,
        show: r.show !== false,
        spread: (typeof r.spread === 'number' && r.spread >= 0) ? r.spread : null,
        manual: !!r.manual
      };
    });
    return out;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function readJSON(key) { try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function readPublished() { var c = readJSON(KEY_PUB); return normalize(c || factoryConfig()); }
  function readDraft() { var d = readJSON(KEY_DRAFT); return normalize(d || readPublished()); }

  /* signature for the "unpublished changes" check */
  function sig(cfg) {
    var parts = [cfg.buyMargin, cfg.sellMargin];
    LIST.forEach(function (c) {
      var r = cfg.rows[c.code];
      parts.push(c.code + ':' + r.mid + ':' + (r.show ? 1 : 0) + ':' + (typeof r.spread === 'number' ? r.spread : 'g'));
    });
    return parts.join('|');
  }

  /* ====================== STATE ====================== */
  var draft = readDraft();
  var published = readPublished();

  /* simulated upstream market feed (runtime only) */
  var market = {};      // latest pulled market mid, per code
  var pullDelta = {};   // change applied on the most recent pull, per code
  LIST.forEach(function (c) { market[c.code] = draft.rows[c.code].mid; pullDelta[c.code] = 0; });
  var feed = { lastPull: Date.now(), nextPull: Date.now() + PULL_MS };

  /* ====================== AUTH ====================== */
  var signin = document.getElementById('signin');
  var dash = document.getElementById('dash');
  var signoutBtn = document.getElementById('signout');

  function isAuthed() { return sessionStorage.getItem(KEY_AUTH) === '1'; }

  function showApp() {
    var authed = isAuthed();
    signin.hidden = authed;
    dash.hidden = !authed;
    signoutBtn.style.display = authed ? '' : 'none';
    if (authed) { buildTable(); refresh(); }
  }

  function enterAs(user) {
    sessionStorage.setItem(KEY_AUTH, '1');
    sessionStorage.setItem('yorkfx_staff_user', user);
    feed.nextPull = Date.now() + PULL_MS;   // fresh feed window on login
    showApp();
  }

  // the rate board lives INSIDE CurrencyDesk OS. Embedded (the OS iframe) it
  // opens via single sign-on; reached standalone while the backend is up, it
  // routes through the one OS door instead of offering its own sign-in. With
  // no backend at all (static demo, file://) the offline sign-in stays.
  var EMBEDDED = window.self !== window.top || /(\?|&|#)embed/.test(window.location.search + window.location.hash);
  var BACKEND = false;   // set once /api/auth/me answers — any HTTP status
  function showOsDoor() {
    var form = document.getElementById('signinForm');
    if (!form || !form.parentElement) return;
    form.parentElement.innerHTML = '<h1>One door for the whole desk</h1>' +
      '<div class="si-sub">CurrencyDesk \u00b7 back office</div>' +
      '<div style="font-size:13px; line-height:1.6; color:var(--mute); margin:14px 0 18px;">The rate board now lives inside <b style="color:var(--ink)">CurrencyDesk OS</b> \u2014 sign in there and it\u2019s the first app in the dock.</div>' +
      '<a class="si-go" style="display:block; text-align:center; text-decoration:none; box-sizing:border-box;" href="/">Open CurrencyDesk OS \u2192</a>';
  }
  (function autoAuth() {
    if (window.location.protocol === 'file:' || typeof fetch !== 'function') return;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) {
        BACKEND = true;
        if (r.ok) { return r.json().then(function (d) { if (d && d.user && !isAuthed()) enterAs(d.user.id); }); }
        // backend up, no OS session: standalone visitors go through the OS
        // door; embedded, the OS lock screen already owns authentication
        if (!EMBEDDED && !isAuthed()) showOsDoor();
      })
      .catch(function () { /* no backend \u2014 static demo keeps its own sign-in */ });
  })();

  document.getElementById('signinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (BACKEND && !EMBEDDED) { showOsDoor(); return; }
    var err = document.getElementById('signinError');
    var pw = document.getElementById('pw').value.trim();
    var user = document.getElementById('user').value.trim();
    if (!user) { err.textContent = 'Enter your username.'; return; }
    err.textContent = 'Checking\u2026 (first sign-in of the day can take ~30s while the server wakes)';
    // backend is the door when reachable; the demo password only exists offline
    fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ staffId: user, password: pw }),
    }).then(function (r) {
      if (r.ok) { err.textContent = ''; enterAs(user); }
      else if (r.status === 401) { err.textContent = 'Incorrect staff ID or password \u2014 check both and try again.'; }
      else { err.textContent = 'Sign-in service error (' + r.status + ') \u2014 try again in a moment.'; }
    }).catch(function () {
      if (pw.toLowerCase() !== DEMO_PASSWORD) { err.textContent = 'Incorrect password. Try again.'; return; }
      err.textContent = '';
      enterAs(user);
    });
  });

  signoutBtn.addEventListener('click', function () {
    sessionStorage.removeItem(KEY_AUTH);
    document.getElementById('pw').value = '';
    showApp();
    window.scrollTo({ top: 0 });
  });

  /* ====================== EDITOR DOM ====================== */
  var body = document.getElementById('etBody');
  var table = document.getElementById('edTable');
  var buyInput = document.getElementById('buyMargin');
  var sellInput = document.getElementById('sellMargin');
  var searchInput = document.getElementById('search');
  var publishBtn = document.getElementById('publishBtn');
  var statusEl = document.getElementById('edStatus');
  var sinceEl = document.getElementById('edSince');
  var savedNote = document.getElementById('savedNote');
  var memToggle = document.getElementById('lockToggle');
  var rowEls = {};

  function rowHTML(c) {
    return '' +
      '<div class="et-row data rowgrid" data-code="' + c.code + '">' +
        '<span class="rt-grip" draggable="true" title="Drag to reorder — the first six show on your homepage" aria-label="Drag to reorder">\u283f</span>' +
        '<span style="display: flex; align-items: center; gap: 11px; min-width: 0;">' +
          '<span class="flagbox">' + c.flag + '</span>' +
          '<span style="min-width: 0;"><span style="display: block; font-family: var(--m); font-size: 13.5px; font-weight: 700;">' + c.code + '</span>' +
          '<span style="display: block; font-size: 12px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + c.name + '</span></span>' +
        '</span>' +
        '<span><input class="mid-input" inputmode="decimal" data-code="' + c.code + '" aria-label="Spot rate for ' + c.code + '" /><span class="chg" data-code="' + c.code + '"></span></span>' +
        '<span><span class="sp-wrap"><input class="sp-input" inputmode="decimal" data-code="' + c.code + '" placeholder="auto" aria-label="Custom spread for ' + c.code + '" /><span class="sp-pct">%</span></span></span>' +
        '<span><input class="bs-input buy-input" inputmode="decimal" data-code="' + c.code + '" aria-label="We-buy price for ' + c.code + '" /></span>' +
        '<span><input class="bs-input sell-input" inputmode="decimal" data-code="' + c.code + '" aria-label="We-sell price for ' + c.code + '" /></span>' +
        '<span style="text-align: center;"><button class="tg" data-code="' + c.code + '" type="button"></button></span>' +
        '<button class="rm" data-code="' + c.code + '" type="button" title="Remove ' + c.code + ' from the board" aria-label="Remove ' + c.code + '">\u00d7</button>' +
      '</div>';
  }
  function wireRow(row) {
    rowEls[row.dataset.code] = {
      row: row,
      input: row.querySelector('.mid-input'),
      chg: row.querySelector('.chg'),
      sp: row.querySelector('.sp-input'),
      buy: row.querySelector('.buy-input'),
      sell: row.querySelector('.sell-input'),
      tg: row.querySelector('.tg')
    };
  }
  function appendRow(c) {
    var tmp = document.createElement('div'); tmp.innerHTML = rowHTML(c);
    var row = tmp.firstChild; body.appendChild(row); wireRow(row); paintRow(c.code, true);
  }

  function buildTable() {
    if (body.dataset.built) return;
    body.dataset.built = '1';
    body.innerHTML = boardList().map(rowHTML).join('');
    body.querySelectorAll('.et-row.data').forEach(wireRow);

    // edits: mid + per-row spread
    body.addEventListener('input', function (e) {
      var mi = e.target.closest('.mid-input');
      if (mi) {
        var code = mi.dataset.code;
        var v = parseFloat(mi.value.replace(/,/g, ''));
        if (!isNaN(v) && v > 0) {
          // a manual spot must stay within ±2% of the feed rate; buy/sell then
          // recompute automatically from the margins/spread
          var mkt = market[code] || v;
          var lo = round(mkt * 0.98, 6), hi = round(mkt * 1.02, 6);
          var cl = Math.min(hi, Math.max(lo, v));
          if (cl !== v) toast(code + ' spot held within ±2% of the feed rate (' + fmtMid(mkt) + ').');
          draft.rows[code].mid = cl; draft.rows[code].manual = true;
        }
        paintRow(code, false); onChange(); return;
      }
      var bs = e.target.closest('.bs-input');
      if (bs) {
        var c3 = bs.dataset.code;
        var pv = parseFloat(bs.value.replace(/,/g, ''));
        var mid = draft.rows[c3].mid;
        if (!isNaN(pv) && pv > 0 && mid > 0) {
          // implied margin from the typed price, held to a sane 0–20%
          var sp = bs.classList.contains('buy-input') ? (mid - pv) / mid : (pv - mid) / mid;
          sp = Math.min(0.2, Math.max(0, sp));
          draft.rows[c3].spread = round(sp, 4);
        }
        paintRow(c3, false); onChange(); return;
      }
      var si = e.target.closest('.sp-input');
      if (si) {
        var c2 = si.dataset.code;
        var raw = si.value.trim();
        if (raw === '') { draft.rows[c2].spread = null; }
        else { var p = parseFloat(raw); if (!isNaN(p)) draft.rows[c2].spread = Math.max(0, p) / 100; }
        paintRow(c2, false); onChange(); return;
      }
    });
    // reformat fields on blur
    body.addEventListener('blur', function (e) {
      var f = e.target.closest('.mid-input, .sp-input, .bs-input');
      if (f) paintRow(f.dataset.code, true);
    }, true);
    // show / hide toggle
    body.addEventListener('click', function (e) {
      var rm = e.target.closest('.rm');
      if (rm) {
        var rc = rm.dataset.code;
        removed.add(rc); pendingRemove.add(rc); pendingAdd.delete(rc); saveRemoved();
        if (draft.rows[rc]) draft.rows[rc].show = false;
        var rEl = rowEls[rc]; if (rEl && rEl.row && rEl.row.parentNode) rEl.row.parentNode.removeChild(rEl.row);
        delete rowEls[rc];
        onChange(); renderAddMenu();
        toast(rc + ' removed from the board.');
        return;
      }
      var tg = e.target.closest('.tg');
      if (!tg) return;
      var code = tg.dataset.code;
      draft.rows[code].show = !draft.rows[code].show;
      paintRow(code, true); onChange();
    });

    /* ---- drag to reorder (grip handle) ----
       Reordering the DOM rows defines the board order; on drop we persist the
       full code list to localStorage('yorkfx_board_order') and reorder the live
       CUR array so the homepage's first-six and the rates page follow suit. */
    var dragCode = null;
    body.addEventListener('pointerdown', function (e) {
      var grip = e.target.closest('.rt-grip'); if (!grip) return;
      var row = grip.closest('.et-row.data'); if (row) row.setAttribute('draggable', 'true');
    });
    body.addEventListener('dragstart', function (e) {
      var row = e.target.closest('.et-row.data'); if (!row) return;
      dragCode = row.dataset.code; row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragCode); } catch (_) {}
    });
    body.addEventListener('dragover', function (e) {
      if (!dragCode) return;
      e.preventDefault();
      var over = e.target.closest('.et-row.data');
      var dragging = rowEls[dragCode] && rowEls[dragCode].row;
      if (!over || !dragging || over === dragging) return;
      var rect = over.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      body.insertBefore(dragging, after ? over.nextSibling : over);
    });
    body.addEventListener('drop', function (e) { e.preventDefault(); });
    body.addEventListener('dragend', function () {
      var row = rowEls[dragCode] && rowEls[dragCode].row;
      if (row) { row.classList.remove('dragging'); row.removeAttribute('draggable'); }
      persistOrder();
      dragCode = null;
    });
  }

  function reorderCUR(order) {
    var rank = {}; order.forEach(function (c, i) { rank[c] = i; });
    CUR.sort(function (a, b) {
      var ra = (a.code in rank) ? rank[a.code] : 100000;
      var rb = (b.code in rank) ? rank[b.code] : 100000;
      return ra - rb;
    });
  }
  function persistOrder() {
    var codes = [].slice.call(body.querySelectorAll('.et-row.data')).map(function (r) { return r.dataset.code; });
    var full = ['CAD'];
    codes.forEach(function (c) { if (full.indexOf(c) < 0) full.push(c); });
    CUR.forEach(function (c) { if (full.indexOf(c.code) < 0) full.push(c.code); });
    try { localStorage.setItem('yorkfx_board_order', JSON.stringify(full)); } catch (_) {}
    reorderCUR(full);
    toast('Board order saved — homepage shows the top six.');
  }

  function paintRow(code, reformat) {
    var el = rowEls[code];
    if (!el) return;
    var r = draft.rows[code];

    if (reformat || document.activeElement !== el.input) { el.input.value = fmtMid(r.mid); }

    var custom = (typeof r.spread === 'number');
    if (reformat || document.activeElement !== el.sp) { el.sp.value = custom ? pct(r.spread) : ''; }
    el.row.classList.toggle('has-custom', custom);

    var bsp = custom ? r.spread : draft.buyMargin;
    var ssp = custom ? r.spread : draft.sellMargin;
    if (reformat || document.activeElement !== el.buy) { el.buy.value = fmtMid(r.mid * (1 - bsp)); }
    if (reformat || document.activeElement !== el.sell) { el.sell.value = fmtMid(r.mid * (1 + ssp)); }

    // change arrow (feed-driven) or pinned marker (manual)
    if (r.manual) {
      el.chg.className = 'chg pinned';
      el.chg.innerHTML = '\u25cf pinned';
    } else {
      var d = pullDelta[code] || 0;
      if (Math.abs(d) < 1e-7) { el.chg.className = 'chg'; el.chg.innerHTML = ''; }
      else {
        el.chg.className = 'chg ' + (d > 0 ? 'up' : 'down');
        el.chg.innerHTML = (d > 0 ? '\u25b2' : '\u25bc') + ' ' + fmtDelta(Math.abs(d));
      }
    }

    // amber: unsaved manual edit
    var pub = published.rows[code];
    var amber = r.manual && pub && Math.abs(pub.mid - r.mid) > 1e-9;
    el.row.classList.toggle('amber', amber);
    el.input.classList.toggle('edited', amber);

    el.tg.classList.toggle('on', r.show);
    el.tg.classList.toggle('off', !r.show);
    el.tg.innerHTML = r.show
      ? '<span style="width: 6px; height: 6px; border-radius: 50%; background: var(--green-live);"></span>ON BOARD'
      : 'HIDDEN';
    el.row.classList.toggle('off', !r.show);
    el.row.classList.toggle('hidden-row', !r.show);
  }

  function paintAll() { LIST.forEach(function (c) { paintRow(c.code, true); }); }

  /* margins (shown as %, stored as fraction) */
  function pct(frac) { return (frac * 100).toFixed(2).replace(/\.?0+$/, ''); }
  function syncMarginInputs() { buyInput.value = pct(draft.buyMargin); sellInput.value = pct(draft.sellMargin); }

  function bindMargin(input, which) {
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (!isNaN(v)) { draft[which] = Math.max(0, v) / 100; paintAll(); onChange(); }
    });
    input.addEventListener('blur', function () { syncMarginInputs(); });
  }
  bindMargin(buyInput, 'buyMargin');
  bindMargin(sellInput, 'sellMargin');

  document.querySelectorAll('.num button[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      var parts = b.dataset.step.split(':');
      var which = parts[0] === 'buy' ? 'buyMargin' : 'sellMargin';
      var dir = parts[1] === '+' ? 1 : -1;
      draft[which] = Math.max(0, round(draft[which] + dir * 0.0005, 5));
      syncMarginInputs(); paintAll(); onChange();
    });
  });

  /* search filter */
  searchInput.addEventListener('input', function () {
    var q = searchInput.value.trim().toLowerCase();
    var any = false;
    LIST.forEach(function (c) {
      var hit = !q || c.code.toLowerCase().indexOf(q) > -1 || c.name.toLowerCase().indexOf(q) > -1;
      if (rowEls[c.code]) rowEls[c.code].row.style.display = hit ? '' : 'none';
      if (hit) any = true;
    });
    var empty = document.getElementById('etEmpty');
    if (empty) empty.style.display = any ? 'none' : '';
  });

  /* member-rate column removed — the table uses the standard 6-column layout */

  /* ====================== RATE LOCK ====================== */
  var KEY_LOCK = 'yorkfx_rates_locked';
  var KEY_LOCKAT = 'yorkfx_locked_at';
  var locked = localStorage.getItem(KEY_LOCK) === '1';
  var lockedAt = parseInt(localStorage.getItem(KEY_LOCKAT) || '0', 10) || feed.lastPull;
  var lockBtn = memToggle; // repurposed button

  function applyLock() {
    lockBtn.classList.toggle('on', locked);
    lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lockBtn.querySelector('.lock-label').textContent = locked ? 'Rates locked' : 'Lock rates';
    document.body.classList.toggle('rates-locked', locked);   // board-wide amber — same colour as the lock state
  }
  function setLock(state) {
    locked = state;
    try { localStorage.setItem(KEY_LOCK, locked ? '1' : '0'); } catch (e) {}
    if (locked) {
      lockedAt = Date.now();
      try { localStorage.setItem(KEY_LOCKAT, String(lockedAt)); } catch (e) {}
    } else {
      feed.nextPull = Date.now() + PULL_MS; // resume the cadence on unlock
    }
    applyLock();
    renderFeed();
  }
  lockBtn.addEventListener('click', function () { setLock(!locked); });
  applyLock();

  /* ====================== LIVE FEED ====================== */
  function doPull() {
    // REAL market data: the converter's backend poller maintains
    // window.MARKET.mids (CAD per unit, from the live provider). No backend
    // (standalone/offline) → mids simply hold at their last values.
    var live = (window.MARKET && window.MARKET.mids) || null;
    LIST.forEach(function (c) {
      var code = c.code;
      var prev = market[code];
      var next = (live && typeof live[code] === 'number' && live[code] > 0) ? round(live[code], 6) : prev;
      pullDelta[code] = next - prev;
      market[code] = next;
      if (!draft.rows[code].manual) { draft.rows[code].mid = next; } // pinned rows keep staff value
    });
    feed.lastPull = Date.now();
    feed.nextPull = feed.lastPull + PULL_MS;
    saveDraft();
    paintAll();
    refreshStatus();
    renderFeed();
  }

  /* ---- catalog & board membership (deterministic, not timing-based) ----
     The board's contents = the currencies in the PUBLISHED config's rows
     (raw localStorage — normalize() fabricates rows for every known code,
     so it must never be used for membership checks). Everything else in
     the provider catalog sits in the "available to add" list. */
  function reconcileMembership() {
    var pubRaw = readJSON(KEY_PUB);
    if (!pubRaw || !pubRaw.rows) return;
    var changed = false;
    LIST.forEach(function (c) {
      var onBoard = !!pubRaw.rows[c.code];
      if (onBoard) { pendingAdd.delete(c.code); } else if (pendingRemove.has(c.code)) { pendingRemove.delete(c.code); }
      if (!onBoard && !removed.has(c.code) && !pendingAdd.has(c.code)) { removed.add(c.code); changed = true; }
      if (onBoard && removed.has(c.code) && !pendingRemove.has(c.code)) { removed.delete(c.code); changed = true; }
    });
    if (changed) {
      saveRemoved();
      if (isAuthed()) { buildTable(); refresh(); }
    }
  }

  // fold newly fetched catalog currencies into the working set
  function foldCatalog() {
    var known = {}; LIST.forEach(function (c) { known[c.code] = 1; });
    var grew = false;
    CUR.forEach(function (c) {
      if (c.code === 'CAD' || known[c.code]) return;
      LIST.push(c);
      market[c.code] = round(1 / c.perCad, 6);
      pullDelta[c.code] = 0;
      grew = true;
    });
    if (grew) {
      draft = normalize(draft);          // give new codes complete rows
      published = normalize(published);
    }
    reconcileMembership();
    if (grew && isAuthed()) { buildTable(); refresh(); }
  }
  foldCatalog();
  window.addEventListener('yorkfx:catalog', foldCatalog);
  // republished board (this tab's converter poll, or another tab) → re-derive
  window.addEventListener('storage', function (e) {
    if (e && e.key === KEY_PUB) { reconcileMembership(); }
  });

  function fmtClock(ts) { return new Date(ts).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }); }
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60); s -= m * 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var feedBar = document.getElementById('feedBar');
  var feedLastWrap = document.getElementById('feedLastWrap');
  var feedNextWrap = document.getElementById('feedNextWrap');
  var feedLabel = document.getElementById('feedLabel');

  function fmtStamp(ts) {
    return new Date(ts).toLocaleString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }

  function renderFeed() {
    var now = Date.now();
    if (locked) {
      feedBar.classList.add('locked');
      feedBar.classList.remove('stale');
      feedLabel.textContent = 'Rates locked';
      feedLastWrap.innerHTML = 'Locked at <b>' + fmtStamp(lockedAt) + '</b>';
      feedNextWrap.innerHTML = 'Held for <b>' + fmtAgo(now - lockedAt) + '</b> · not refreshing';
      return;
    }
    feedBar.classList.remove('locked');
    var mk = window.MARKET || null;
    var stale = !mk && now > feed.nextPull + 8000;
    feedBar.classList.toggle('stale', stale);
    if (mk && mk.fetchedAt) {
      // truth: the provider is polled hourly by the server; pages check for
      // fresh data every minute (free — our own backend, not the provider)
      var nextProvider = mk.fetchedAt + 3600000;
      var pname = mk.provider === 'openexchangerates.org' ? 'OPEN EXCHANGE RATES' : String(mk.provider || 'LIVE FEED').toUpperCase();
      feedLabel.textContent = 'FEED LIVE · ' + pname;
      feedLastWrap.innerHTML = 'Provider rates as of <b>' + fmtClock(mk.fetchedAt) + '</b> · feed healthy · hourly';
      feedNextWrap.innerHTML = now < nextProvider
        ? 'Next refresh <b>' + fmtCountdown(nextProvider - now) + '</b>'
        : 'Refresh due <b>any moment</b>';
    } else {
      feedLabel.textContent = stale ? 'FEED OFFLINE — RATES HELD' : 'STANDALONE · RATES HELD';
      feedLastWrap.innerHTML = 'Rates as of <b>' + fmtClock(feed.lastPull) + '</b> · live feed needs the backend';
      feedNextWrap.innerHTML = 'Offline';
    }
  }

  function feedTick() {
    if (!isAuthed()) return;
    if (locked) { renderFeed(); return; }      // frozen — no pulls while locked
    if (Date.now() >= feed.nextPull) { doPull(); }
    else { renderFeed(); }
  }

  /* ====================== STATUS / PERSIST ====================== */
  function isDirty() { return sig(draft) !== sig(published); }
  function saveDraft() { try { localStorage.setItem(KEY_DRAFT, JSON.stringify(draft)); } catch (e) {} }

  function onChange() { saveDraft(); refreshStatus(); flashSaved(); }

  var savedTimer;
  function flashSaved() {
    savedNote.textContent = 'Draft saved';
    savedNote.classList.add('flash');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { savedNote.classList.remove('flash'); }, 1200);
  }

  function refreshStatus() {
    var dirty = isDirty();
    statusEl.classList.toggle('dirty', dirty);
    statusEl.querySelector('.label').textContent = dirty ? 'Unpublished changes' : 'All changes published';
    if (!publishing) { publishBtn.disabled = false; publishBtn.textContent = dirty ? 'Publish' : 'Re-publish'; }
  }

  function fmtAgo(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  function tickSince() {
    if (!published.publishedAt) {
      sinceEl.classList.remove('fresh');
      sinceEl.innerHTML = '<span class="tdot"></span>Not yet published';
      return;
    }
    var diff = Math.max(0, Date.now() - new Date(published.publishedAt).getTime());
    sinceEl.classList.toggle('fresh', diff < 60000);
    sinceEl.innerHTML = '<span class="tdot"></span>Updated <b>' + fmtAgo(diff) + '</b> ago' +
      (published.publishedBy ? ' \u00b7 ' + published.publishedBy : '');
  }

  function refresh() { syncMarginInputs(); paintAll(); refreshStatus(); tickSince(); renderFeed(); renderAddMenu(); paintPreview(); paintWorked(); }

  /* ====================== PUBLISH / RESET ====================== */
  var publishing = false;
  publishBtn.addEventListener('click', function () {
    if (publishBtn.disabled || publishing) return;   // can't double-click
    publishing = true;
    publishBtn.classList.add('arming');               // black → red (committing)
    publishBtn.textContent = 'Publishing…';
    setTimeout(function () {
      var user = sessionStorage.getItem('yorkfx_staff_user') || 'staff';
      draft.publishedAt = new Date().toISOString();
      draft.publishedBy = user.charAt(0).toUpperCase() + user.slice(1);
      var payload = normalize(draft);
      // the published config carries ONLY board currencies — catalog-only
      // codes must never leak onto the public boards
      payload.rows = (function () {
        var rows = {};
        boardList().forEach(function (c) {
          var full = normalize(draft).rows[c.code];
          if (full) rows[c.code] = full;
        });
        return rows;
      })();
      try { localStorage.setItem(KEY_PUB, JSON.stringify(payload)); } catch (e) {}
      // publish to the backend (append-only rate_boards + audit)
      try {
        var apiRows = {};
        boardList().forEach(function (c) {
          var r = payload.rows[c.code]; if (!r) return;
          apiRows[c.code] = { mid: r.mid, show: r.show !== false };
          if (typeof r.spread === 'number') { apiRows[c.code].spread = r.spread; }
        });
        var order = null;
        try { order = JSON.parse(localStorage.getItem('yorkfx_board_order') || 'null'); } catch (e2) {}
        fetch('/api/rates/publish', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ buyMargin: payload.buyMargin, sellMargin: payload.sellMargin, rows: apiRows, order: order || undefined }),
        }).catch(function () {});
      } catch (e3) {}
      published = normalize(payload);
      draft = normalize(payload);
      saveDraft();
      refresh();
      publishBtn.classList.remove('arming');
      publishBtn.classList.add('done');               // red → green (published)
      publishBtn.textContent = 'Published \u2713';
      toast('Published \u2014 the live boards now show these rates.');
      setTimeout(function () {
        publishBtn.classList.remove('done');
        publishBtn.textContent = 'Publish';
        publishing = false;
        refreshStatus();                              // re-disables (now all clean)
      }, 1500);
    }, 340);
  });

  /* ---- add a currency from the feed's catalog (replaces manual entry) ---- */
  var addBtn = null, addMenu = null;
  function renderAddMenu() {
    if (!addMenu) return;
    var avail = feedAvailable();
    if (addBtn) addBtn.disabled = avail.length === 0;
    var fc = document.getElementById('feedCount');
    if (fc) fc.textContent = boardList().length + ' of ' + LIST.length + ' currencies on the board';
    addMenu.innerHTML = avail.length
      ? avail.map(function (c) {
          return '<button class="add-item" data-code="' + c.code + '" type="button"><span class="ai-flag">' + c.flag + '</span><span class="ai-code">' + c.code + '</span><span class="ai-name">' + c.name + '</span><span class="ai-plus">+</span></button>';
        }).join('')
      : '<div class="add-empty">Every currency from your feed is already on the board.</div>';
  }
  function addCurrency(code) {
    var c = BY[code]; if (!c) return;
    removed.delete(code); pendingAdd.add(code); pendingRemove.delete(code); saveRemoved();
    if (!draft.rows[code]) draft.rows[code] = { mid: round(1 / c.perCadDefault, 6), show: true, spread: null, manual: false };
    else draft.rows[code].show = true;
    market[code] = draft.rows[code].mid; pullDelta[code] = 0;
    appendRow(c);
    onChange(); renderAddMenu();
    toast(code + ' added to the board.');
  }
  (function () {
    addBtn = document.getElementById('addBtn');
    addMenu = document.getElementById('addMenu');
    if (!addBtn) return;
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!addMenu.hidden) { addMenu.hidden = true; addBtn.classList.remove('on'); }
      else { renderAddMenu(); addMenu.hidden = false; addBtn.classList.add('on'); }
    });
    addMenu.addEventListener('click', function (e) {
      var it = e.target.closest('.add-item'); if (!it) return;
      addCurrency(it.dataset.code);
    });
    document.addEventListener('click', function (e) {
      if (!addMenu.hidden && !addMenu.contains(e.target) && !addBtn.contains(e.target)) { addMenu.hidden = true; addBtn.classList.remove('on'); }
    });
    renderAddMenu();
  })();

  /* ---- rate feed provider: owner-set in Settings, shared via localStorage ---- */
  (function () {
    var sel = document.getElementById('rateProvider');
    if (!sel) return;
    var KEY_PROV = 'yorkfx_rate_provider';
    // the ACTIVE provider is whatever the backend actually pulls from;
    // the rest are roadmap, shown but not selectable
    var COMING = ['OANDA \u00b7 fxTrade rates', 'XE Currency Data', 'Refinitiv (Reuters) FX', 'European Central Bank', 'Wise rates'];
    function renderProviders() {
      var activeName = (window.MARKET && window.MARKET.provider === 'openexchangerates.org')
        ? 'Open Exchange Rates \u00b7 live'
        : (window.MARKET && window.MARKET.provider ? window.MARKET.provider + ' \u00b7 live' : 'Open Exchange Rates');
      sel.innerHTML = '<option value="active" selected>' + activeName + '</option>' +
        COMING.map(function (p) { return '<option value="" disabled>' + p + ' \u2014 coming soon</option>'; }).join('');
    }
    renderProviders();
    window.addEventListener('yorkfx:catalog', renderProviders);
  })();

  document.getElementById('resetBtn').addEventListener('click', function () {
    if (!confirm('Reset every rate, spread and margin back to the factory defaults? This clears your unpublished edits.')) return;
    draft = factoryConfig();
    LIST.forEach(function (c) { market[c.code] = draft.rows[c.code].mid; pullDelta[c.code] = 0; });
    saveDraft();
    refresh();
    flashSaved();
  });

  /* toast */
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg) {
    toastEl.querySelector('.msg').textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }

  /* ====================== GO ====================== */
  setInterval(function () { tickSince(); feedTick(); }, 1000);
  showApp();

  /* ====================== V2 UI GLUE (brand design) ====================== */

  // right-rail live site preview — mirrors the top six of the board
  function paintPreview() {
    var wrap = document.getElementById('sitePrevRows');
    var more = document.getElementById('sitePrevMore');
    if (!wrap) return;
    var shown = boardList().filter(function (c) { return draft.rows[c.code] && draft.rows[c.code].show !== false; });
    var six = shown.slice(0, 6);
    wrap.innerHTML = six.map(function (c) {
      var r = draft.rows[c.code];
      var sp = (typeof r.spread === 'number');
      var b = r.mid * (1 - (sp ? r.spread : draft.buyMargin));
      var sl = r.mid * (1 + (sp ? r.spread : draft.sellMargin));
      return '<div style="display: grid; grid-template-columns: 1fr 62px 62px; gap: 8px; align-items: center; padding: 6.5px 0; border-top: 1px solid rgba(247,244,237,0.08);">' +
        '<span style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 12px;">' + c.flag + '</span><span style="font-family: var(--m); font-size: 11px; font-weight: 700; color: #F7F4ED;">' + c.code + '</span></span>' +
        '<span style="font-family: var(--m); font-size: 11px; color: #b5aea3; text-align: right; font-variant-numeric: tabular-nums;">' + fmtMid(b) + '</span>' +
        '<span style="font-family: var(--m); font-size: 11px; font-weight: 700; color: #2EA36B; text-align: right; font-variant-numeric: tabular-nums;">' + fmtMid(sl) + '</span>' +
      '</div>';
    }).join('');
    if (more) more.textContent = shown.length > 6 ? ('+ ' + (shown.length - 6) + ' MORE ON THE RATES PAGE') : '';
  }

  // "USD worked out" example under the margins strip
  function paintWorked() {
    var el = document.getElementById('workedOut');
    if (!el || !draft.rows.USD) return;
    var r = draft.rows.USD;
    var sp = (typeof r.spread === 'number');
    el.innerHTML = 'USD worked out: <b style="color: var(--mute);">' + fmtMid(r.mid) + '</b> spot \u2192 buy <b style="color: var(--mute);">' +
      fmtMid(r.mid * (1 - (sp ? r.spread : draft.buyMargin))) + '</b> \u00b7 sell <b style="color: var(--mute);">' +
      fmtMid(r.mid * (1 + (sp ? r.spread : draft.sellMargin))) + '</b>';
  }

  // feed popover open/close
  (function feedPopover() {
    var pop = document.getElementById('feedPop');
    var bar = document.getElementById('feedBar');
    if (!pop || !bar) return;
    bar.addEventListener('click', function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; });
    var close = document.getElementById('feedPopClose');
    if (close) close.addEventListener('click', function () { pop.hidden = true; });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
  })();

  // ---- setup tour: first visit per browser, replayable from ↻ TOUR ----
  (function tour() {
    var KEY_TOUR = 'cdos_tour_rateboard_done';
    var root = document.getElementById('tour');
    if (!root) return;
    var cards = Array.prototype.slice.call(root.querySelectorAll('.tour-card'));
    var step = 1;
    function showStep(n) {
      step = n;
      cards.forEach(function (c) { c.hidden = c.dataset.step !== String(n); });
    }
    function openTour() {
      // live numbers inside the tour, so it teaches with today's rates
      try {
        var r = draft.rows.USD;
        if (r) {
          var sl = document.getElementById('tourSpotLine');
          if (sl) sl.innerHTML = 'USD spot <b style="color: var(--ink);">' + fmtMid(r.mid) + '</b> \u00b7 arrives hourly, automatically';
          var ml = document.getElementById('tourMathLine');
          if (ml) ml.innerHTML = fmtMid(r.mid) + ' spot \u2192 we buy <b style="color: var(--ink);">' + fmtMid(r.mid * (1 - draft.buyMargin)) + '</b> \u00b7 we sell <b style="color: var(--ink);">' + fmtMid(r.mid * (1 + draft.sellMargin)) + '</b>';
        }
      } catch (e) {}
      showStep(1);
      root.hidden = false;
    }
    function closeTour() {
      root.hidden = true;
      try { localStorage.setItem(KEY_TOUR, '1'); } catch (e) {}
    }
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-tour-next]')) { showStep(Math.min(4, step + 1)); return; }
      if (e.target.closest('[data-tour-finish]')) { closeTour(); return; }
      if (e.target.closest('[data-tour-skip]')) { closeTour(); return; }
    });
    var replay = document.getElementById('tourBtn');
    if (replay) replay.addEventListener('click', openTour);
    // first visit: show once the dashboard is actually on screen
    var seen = null; try { seen = localStorage.getItem(KEY_TOUR); } catch (e) {}
    if (!seen) {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (isAuthed() && !dash.hidden) { clearInterval(t); openTour(); }
        else if (tries > 40) { clearInterval(t); }
      }, 250);
    }
  })();

})();
