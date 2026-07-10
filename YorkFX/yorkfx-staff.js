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
  var DEMO_PASSWORD = 'york';
  var PULL_MS = 3600000;                // upstream feed refresh cadence — one update per hour

  /* ---------------- currencies (everything except CAD) ---------------- */
  var LIST = CUR.filter(function (c) { return c.code !== 'CAD'; });
  /* the rate feed provides the catalog of currencies; staff add / remove from it.
     A 'removed' currency is off the board (and off the public boards). */
  var KEY_REMOVED = 'yorkfx_board_removed';
  var removed = (function () { try { var r = JSON.parse(localStorage.getItem(KEY_REMOVED)); return new Set(Array.isArray(r) ? r : []); } catch (e) { return new Set(); } })();
  function saveRemoved() { try { localStorage.setItem(KEY_REMOVED, JSON.stringify([].slice.call(removed))); } catch (e) {} }
  function boardList() { return LIST.filter(function (c) { return !removed.has(c.code); }); }
  function feedAvailable() { return LIST.filter(function (c) { return removed.has(c.code); }); }

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

  document.getElementById('signinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('signinError');
    var pw = document.getElementById('pw').value.trim();
    var user = document.getElementById('user').value.trim();
    if (!user) { err.textContent = 'Enter your username.'; return; }
    if (pw.toLowerCase() !== DEMO_PASSWORD) { err.textContent = 'Incorrect password. Try again.'; return; }
    err.textContent = '';
    sessionStorage.setItem(KEY_AUTH, '1');
    sessionStorage.setItem('yorkfx_staff_user', user);
    feed.nextPull = Date.now() + PULL_MS;   // fresh feed window on login
    showApp();
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
      '<div class="et-row data" data-code="' + c.code + '">' +
        '<div class="cur-cell">' +
          '<span class="rt-grip" title="Drag to reorder — the first six show on your homepage" aria-label="Drag to reorder">' +
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>' +
          '</span>' +
          '<span class="flag">' + c.flag + '</span>' +
          '<span class="stack"><span class="code">' + c.code + '</span>' +
          '<span class="name">' + c.name + '</span></span>' +
        '</div>' +
        '<div class="mid-cell">' +
          '<span class="klabel">Spot · CAD/unit</span>' +
          '<input class="mid-input" inputmode="decimal" data-code="' + c.code + '" aria-label="Spot rate for ' + c.code + '" />' +
          '<span class="chg" data-code="' + c.code + '"></span>' +
        '</div>' +
        '<div class="spread-cell">' +
          '<span class="klabel">Spread</span>' +
          '<span class="sp-dot" title="Custom spread active"></span>' +
          '<span class="sp-wrap"><input class="sp-input" inputmode="decimal" data-code="' + c.code + '" placeholder="auto" aria-label="Custom spread for ' + c.code + '" /><span class="sp-pct">%</span></span>' +
        '</div>' +
        '<div class="out buy" data-k="We buy" data-code="' + c.code + '">\u2014</div>' +
        '<div class="out sell" data-k="We sell" data-code="' + c.code + '">\u2014</div>' +
        '<div class="tg-cell"><button class="tg" data-code="' + c.code + '" type="button">Show</button><button class="rm" data-code="' + c.code + '" type="button" title="Remove ' + c.code + ' from the board" aria-label="Remove ' + c.code + '">\u00d7</button></div>' +
      '</div>';
  }
  function wireRow(row) {
    rowEls[row.dataset.code] = {
      row: row,
      input: row.querySelector('.mid-input'),
      chg: row.querySelector('.chg'),
      sp: row.querySelector('.sp-input'),
      buy: row.querySelector('.out.buy'),
      sell: row.querySelector('.out.sell'),
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
      var f = e.target.closest('.mid-input, .sp-input');
      if (f) paintRow(f.dataset.code, true);
    }, true);
    // show / hide toggle
    body.addEventListener('click', function (e) {
      var rm = e.target.closest('.rm');
      if (rm) {
        var rc = rm.dataset.code;
        removed.add(rc); saveRemoved();
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
    el.buy.innerHTML = fmtMid(r.mid * (1 - bsp)) + ' <span class="unit">CAD</span>';
    el.sell.innerHTML = fmtMid(r.mid * (1 + ssp)) + ' <span class="unit">CAD</span>';

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
    el.tg.textContent = r.show ? 'On board' : 'Hidden';
    el.row.classList.toggle('off', !r.show);
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
    LIST.forEach(function (c) {
      var code = c.code;
      var prev = market[code];
      var next = round(Math.max(0.00001, prev + (Math.random() - 0.5) * prev * 0.004), 6); // ±0.2%
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
    var stale = now > feed.nextPull + 8000; // timer overdue (tab backgrounded) → disconnected
    feedBar.classList.toggle('stale', stale);
    feedLabel.textContent = stale ? 'Feed reconnecting…' : 'Feed connected · updates hourly';
    feedLastWrap.innerHTML = 'Rates as of <b>' + fmtClock(feed.lastPull) + '</b>';
    feedNextWrap.innerHTML = 'Next update in <b>' + (stale ? '—' : fmtCountdown(feed.nextPull - now)) + '</b>';
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

  function refresh() { syncMarginInputs(); paintAll(); refreshStatus(); tickSince(); renderFeed(); }

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
      try { localStorage.setItem(KEY_PUB, JSON.stringify(payload)); } catch (e) {}
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
    removed.delete(code); saveRemoved();
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
    var PROVIDERS = ['OANDA \u00b7 fxTrade rates', 'XE Currency Data', 'Refinitiv (Reuters) FX', 'European Central Bank', 'Wise rates'];
    var saved = null; try { saved = localStorage.getItem(KEY_PROV); } catch (e) {}
    sel.innerHTML = PROVIDERS.map(function (p) { return '<option value="' + p + '">' + p + '</option>'; }).join('');
    if (saved && PROVIDERS.indexOf(saved) === -1) { sel.insertAdjacentHTML('afterbegin', '<option value="' + saved + '">' + saved + '</option>'); }
    sel.value = saved || PROVIDERS[0];
    sel.addEventListener('change', function () { try { localStorage.setItem(KEY_PROV, sel.value); } catch (e) {} });
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
})();
