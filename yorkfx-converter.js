/* ============================================================
   YORK FX — shared currency data + converter widget
   Used by the homepage and the rates page.
   ============================================================ */
var CUR = [
  { code:'CAD', name:'Canadian Dollar',   flag:'🇨🇦', perCad:1,        chg: 0.00 },
  { code:'USD', name:'US Dollar',         flag:'🇺🇸', perCad:0.7331,   chg: 0.12 },
  { code:'EUR', name:'Euro',              flag:'🇪🇺', perCad:0.6798,   chg:-0.08 },
  { code:'GBP', name:'British Pound',     flag:'🇬🇧', perCad:0.5779,   chg: 0.20 },
  { code:'CHF', name:'Swiss Franc',       flag:'🇨🇭', perCad:0.6512,   chg: 0.05 },
  { code:'AUD', name:'Australian Dollar', flag:'🇦🇺', perCad:1.1190,   chg:-0.14 },
  { code:'JPY', name:'Japanese Yen',      flag:'🇯🇵', perCad:109.90,   chg: 0.31 },
  { code:'CNY', name:'Chinese Yuan',      flag:'🇨🇳', perCad:5.284,    chg:-0.03 },
  { code:'INR', name:'Indian Rupee',      flag:'🇮🇳', perCad:60.31,    chg: 0.04 },
  { code:'AED', name:'UAE Dirham',        flag:'🇦🇪', perCad:2.6926,   chg:-0.02 },
  { code:'PHP', name:'Philippine Peso',   flag:'🇵🇭', perCad:41.15,    chg: 0.09 },
  { code:'MXN', name:'Mexican Peso',      flag:'🇲🇽', perCad:12.42,    chg: 0.17 },
  { code:'KRW', name:'South Korean Won',  flag:'🇰🇷', perCad:982.4,    chg:-0.11 },
  { code:'HKD', name:'Hong Kong Dollar',  flag:'🇭🇰', perCad:5.731,    chg: 0.01 },
  { code:'SGD', name:'Singapore Dollar',  flag:'🇸🇬', perCad:0.9912,   chg: 0.06 },
  { code:'NZD', name:'New Zealand Dollar',flag:'🇳🇿', perCad:1.2204,   chg:-0.09 },
  { code:'HUF', name:'Hungarian Forint',  flag:'🇭🇺', perCad:262.3,    chg: 0.22 },
  { code:'TWD', name:'Taiwan Dollar',     flag:'🇹🇼', perCad:23.45,    chg:-0.05 },
  { code:'DKK', name:'Danish Krone',      flag:'🇩🇰', perCad:5.071,    chg: 0.03 },
  { code:'ILS', name:'Israeli Shekel',    flag:'🇮🇱', perCad:2.701,    chg:-0.07 },
  { code:'SEK', name:'Swedish Krona',     flag:'🇸🇪', perCad:7.842,    chg: 0.10 },
  { code:'NOK', name:'Norwegian Krone',   flag:'🇳🇴', perCad:7.815,    chg:-0.06 },
  { code:'ZAR', name:'South African Rand',flag:'🇿🇦', perCad:13.48,    chg: 0.28 },
  { code:'BRL', name:'Brazilian Real',    flag:'🇧🇷', perCad:3.951,    chg:-0.19 },
  { code:'THB', name:'Thai Baht',         flag:'🇹🇭', perCad:26.38,    chg: 0.08 },
  { code:'PLN', name:'Polish Zloty',      flag:'🇵🇱', perCad:2.931,    chg: 0.04 },
  { code:'TRY', name:'Turkish Lira',      flag:'🇹🇷', perCad:23.82,    chg:-0.33 },
  { code:'SAR', name:'Saudi Riyal',       flag:'🇸🇦', perCad:2.749,    chg: 0.01 },
  { code:'PKR', name:'Pakistani Rupee',   flag:'🇵🇰', perCad:204.3,    chg:-0.15 }
];
var BY = {};
CUR.forEach(function (c) { BY[c.code] = c; });
// remember the factory mid for every currency before any staff override is applied
CUR.forEach(function (c) { c.perCadDefault = c.perCad; });

/* ---------- apply the staff-saved board ORDER (localStorage) ----------
   Written by the Rate Editor when staff drag-reorder the board. Shape:
   ['CAD','USD','EUR', …] — a full list of codes in display order. Every
   consumer (homepage's first-six, the rates page's full list, the desk)
   reads CUR in array order, so reordering CUR here propagates everywhere.
   CAD is always pinned first; any code missing from the saved order keeps
   its original relative position at the end.                              */
(function applyBoardOrder() {
  applyBoardOrder.run = function () {
    try {
      var raw = localStorage.getItem('yorkfx_board_order');
      if (!raw) return;
      var order = JSON.parse(raw);
      if (!Array.isArray(order) || !order.length) return;
      var rank = {};
      order.forEach(function (code, i) { rank[code] = i + 1; });   // 1-based; CAD forced to 0 below
      var orig = {};
      CUR.forEach(function (c, i) { orig[c.code] = i; });
      CUR.sort(function (a, b) {
        if (a.code === 'CAD') return -1;
        if (b.code === 'CAD') return 1;
        var ra = (a.code in rank) ? rank[a.code] : 100000 + orig[a.code];
        var rb = (b.code in rank) ? rank[b.code] : 100000 + orig[b.code];
        return ra - rb;
      });
    } catch (e) { /* malformed order — keep current order */ }
  };
  applyBoardOrder.run();
  // exposed so a page can re-apply the order live (e.g. on a cross-tab storage event)
  if (typeof window !== 'undefined') window.applyBoardOrder = applyBoardOrder.run;
})();

var SPREAD = 0.015;          // legacy symmetric margin (kept for compatibility)
var BUY_MARGIN = SPREAD;     // we buy this far UNDER mid-market
var SELL_MARGIN = SPREAD;    // we sell this far OVER mid-market
var RATE_CONFIG = null;      // last published config, if any

/* ---------- apply the staff-published rate board (localStorage) ----------
   Written by the Rate Editor (YorkFX Staff.html). Shape:
   { buyMargin, sellMargin, rows: { USD:{ mid, show }, ... }, publishedAt, publishedBy }
   `mid` is CAD per 1 unit of the currency.                                  */
(function applyRateConfig() {
  applyRateConfig.run = function () {
    try {
      var raw = localStorage.getItem('yorkfx_rates_v1');
      if (!raw) return;
      var cfg = JSON.parse(raw);
      RATE_CONFIG = cfg;
      if (typeof cfg.buyMargin === 'number') { BUY_MARGIN = cfg.buyMargin; }
      if (typeof cfg.sellMargin === 'number') { SELL_MARGIN = cfg.sellMargin; }
      if (cfg.rows) {
        Object.keys(cfg.rows).forEach(function (code) {
          var c = BY[code];
          if (!c) return;
          var r = cfg.rows[code];
          if (typeof r.mid === 'number' && r.mid > 0) { c.perCad = 1 / r.mid; }
          c.show = (r.show !== false);
        });
      }
    } catch (e) { /* malformed config — fall back to factory rates */ }
  };
  applyRateConfig.run();
  if (typeof window !== 'undefined') window.applyRateConfig = applyRateConfig.run;
})();

/* ---------- pull the published board from the backend (server/) ----------
   The backend's rate_boards table is the source of truth when the API is
   reachable (served prototype / deployed app). The published board lands in
   the same localStorage key the Rate Editor writes, then the same apply +
   storage-event path runs — so standalone/offline behaviour is unchanged. */
(function syncRatesFromBackend() {
  try {
    if (typeof fetch !== 'function' || typeof window === 'undefined') return;
    if (window.location.protocol === 'file:') return;
    fetch('/api/rates', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.board || !data.board.rows) return;
        var cfg = data.board;
        var str = JSON.stringify(cfg);
        try { localStorage.setItem('yorkfx_rates_v1', str); } catch (e) {}
        if (cfg.order && cfg.order.length) {
          try { localStorage.setItem('yorkfx_board_order', JSON.stringify(cfg.order)); } catch (e) {}
          if (window.applyBoardOrder) window.applyBoardOrder();
        }
        if (window.applyRateConfig) window.applyRateConfig();
        // same event the Rate Editor fires on publish — every open view re-renders
        try { window.dispatchEvent(new StorageEvent('storage', { key: 'yorkfx_rates_v1', newValue: str })); } catch (e) {}
      })
      .catch(function () { /* backend not running — factory/local rates stand */ });
  } catch (e) {}
})();

function cadValue(code) { return 1 / BY[code].perCad; }      // 1 unit -> CAD (mid)
function convRate(from, to) { return BY[to].perCad / BY[from].perCad; }
function rowSpread(code) {
  if (RATE_CONFIG && RATE_CONFIG.rows && RATE_CONFIG.rows[code] &&
      typeof RATE_CONFIG.rows[code].spread === 'number') {
    return RATE_CONFIG.rows[code].spread;   // per-currency override
  }
  return null;
}
function buyCad(code) { var s = rowSpread(code); return cadValue(code) * (1 - (s != null ? s : BUY_MARGIN)); }   // what we pay
function sellCad(code) { var s = rowSpread(code); return cadValue(code) * (1 + (s != null ? s : SELL_MARGIN)); } // what we charge

function fmtCad(v) {
  var d = v >= 100 ? 2 : (v >= 1 ? 4 : 5);
  return v.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtChg(c) {
  return (c > 0 ? '▲ ' : (c < 0 ? '▼ ' : '· ')) + Math.abs(c).toFixed(2) + '%';
}

/* ---------- custom currency select ---------- */
function buildSelect(slotId, value, onChange) {
  var slot = document.getElementById(slotId);
  slot.innerHTML =
    '<div class="cur-trigger" tabindex="0" role="button" aria-haspopup="listbox">' +
      '<span class="flag"></span><span class="code"></span><span class="caret">▼</span>' +
    '</div>' +
    '<div class="cur-menu" role="listbox">' +
      '<input class="cur-search" type="text" placeholder="Search…" autocomplete="off" />' +
      '<div class="cur-opts"></div>' +
    '</div>';

  var trigger = slot.querySelector('.cur-trigger');
  var search = slot.querySelector('.cur-search');
  var optsWrap = slot.querySelector('.cur-opts');

  optsWrap.innerHTML = CUR.map(function (c) {
    return '<div class="cur-opt" data-code="' + c.code + '" role="option">' +
      '<span class="flag">' + c.flag + '</span>' +
      '<span class="meta"><span class="c">' + c.code + '</span><span class="n">' + c.name + '</span></span>' +
    '</div>';
  }).join('');

  var state = { value: value };

  function paint() {
    var c = BY[state.value];
    trigger.querySelector('.flag').textContent = c.flag;
    trigger.querySelector('.code').textContent = c.code;
    optsWrap.querySelectorAll('.cur-opt').forEach(function (o) {
      o.classList.toggle('active', o.dataset.code === state.value);
    });
  }
  function open() { slot.classList.add('open'); search.value = ''; filter(''); setTimeout(function () { search.focus(); }, 10); }
  function close() { slot.classList.remove('open'); }
  function filter(q) {
    q = q.trim().toLowerCase();
    optsWrap.querySelectorAll('.cur-opt').forEach(function (o) {
      var c = BY[o.dataset.code];
      var hit = !q || c.code.toLowerCase().indexOf(q) > -1 || c.name.toLowerCase().indexOf(q) > -1;
      o.classList.toggle('hide', !hit);
    });
  }

  trigger.addEventListener('click', function () { if (slot.classList.contains('open')) close(); else open(); });
  trigger.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  search.addEventListener('input', function () { filter(search.value); });
  optsWrap.addEventListener('click', function (e) {
    var o = e.target.closest('.cur-opt');
    if (!o) return;
    state.value = o.dataset.code;
    paint(); close(); onChange(state.value);
  });

  paint();
  return { get: function () { return state.value; }, set: function (v) { state.value = v; paint(); } };
}

/* close any open menu on outside click (attach once) */
if (!window.__curOutsideBound) {
  window.__curOutsideBound = true;
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.cur-select')) {
      document.querySelectorAll('.cur-select.open').forEach(function (s) { s.classList.remove('open'); });
    }
  });
}

/* ---------- wire a converter card ---------- */
function initConverter(cfg) {
  var amountEl = document.getElementById(cfg.amountId);
  var resultEl = document.getElementById(cfg.resultId);
  var rateEl = document.getElementById(cfg.rateLabelId);

  function update() {
    var from = fromSel.get(), to = toSel.get();
    var amt = parseFloat(amountEl.value.replace(/,/g, '')) || 0;
    var rate = convRate(from, to);
    resultEl.textContent = (amt * rate).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    rateEl.textContent = '1 ' + from + ' = ' + rate.toFixed(4) + ' ' + to;
    // brief pulse so the result feels responsive
    if (resultEl.classList) {
      resultEl.classList.remove('bump');
      void resultEl.offsetWidth;
      resultEl.classList.add('bump');
    }
  }

  var fromSel = buildSelect(cfg.fromSlot, cfg.from || 'CAD', update);
  var toSel = buildSelect(cfg.toSlot, cfg.to || 'USD', update);

  amountEl.addEventListener('input', update);
  if (cfg.swapId) {
    var sw = document.getElementById(cfg.swapId);
    sw.addEventListener('click', function () { var f = fromSel.get(); fromSel.set(toSel.get()); toSel.set(f); update(); });
    sw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });
  }
  update();
  return { update: update, fromSel: fromSel, toSel: toSel };
}
