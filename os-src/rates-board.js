/* The Rates app's board, as the desk builds it before Publish.

   The server prices every deal and every public number; these are the
   desk's own copies, for the preview on screen and the body Publish sends.
   Spreads are percents on screen (1.5 means 1.5%) and fractions on the wire
   (0.015). A pinned rate (settings.spotOverride, set in Pricing) beats the
   market feed, and the market beats the last publish. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, { ratesBoard: api });
})(typeof window !== "undefined" ? window : globalThis, function () {
  var DEFAULT_SPREAD_PCT = 1.5;
  /* The publish schema refuses a margin over 0.2 (routes/rates.ts). */
  var MAX_SPREAD_PCT = 20;

  /* A positive, finite number, or null. Text from settings is trimmed. */
  function positive(v) {
    var n = typeof v === "string" ? Number(v.trim()) : v;
    return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
  }
  /* A spread may be zero. Blank, missing or negative is "not set". */
  function spreadPct(v) {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    var n = typeof v === "string" ? Number(v.trim()) : v;
    return typeof n === "number" && isFinite(n) && n >= 0 ? n : null;
  }

  /* ---- exact six-place rounding ----
     0.0091 x 0.985 is 0.0089635 on paper and 0.00896349... in floating
     point, which rounds the wrong way. Each figure is read to 15
     significant digits into a scaled integer, and rounding is half-up, the
     same as the server's Decimal. */
  var SCALE = 18;
  function scaled(n) {
    var parts = Number(n).toPrecision(15).split("e");
    var exp = parts.length > 1 ? Number(parts[1]) : 0;
    var digits = parts[0].replace("-", "");
    var dot = digits.indexOf(".");
    var whole = dot < 0 ? digits : digits.slice(0, dot) + digits.slice(dot + 1);
    var places = (dot < 0 ? 0 : digits.length - dot - 1) - exp;
    var shift = SCALE - places;
    return shift >= 0 ? BigInt(whole) * 10n ** BigInt(shift) : BigInt(whole) / 10n ** BigInt(-shift);
  }
  function divHalfUp(a, b) { return (a * 2n + b) / (2n * b); }
  function sixPlaces(value) { return Number(value) / 1e6; }

  /* The desk's lines (quotes/terms.ts): buy at mid x (1 - m), sell at
     mid / (1 - m). Returns plain numbers at six places for display. */
  function deskPair(mid, buyPct, sellPct) {
    var m = scaled(mid);
    var hundred = scaled(100);
    var toSix = 10n ** BigInt(SCALE - 6);
    var buy = divHalfUp(m * (hundred - scaled(buyPct)), hundred * toSix);
    var sell = divHalfUp(m * hundred, (hundred - scaled(sellPct)) * toSix);
    return { buy: sixPlaces(buy), sell: sixPlaces(sell) };
  }

  /* The market in the shop's home currency, from the feed's raw mids
     (GET /api/rates/market: Canadian dollars per 1 unit, every digit).
     A CAD shop takes them as they are; any other shop divides by its own
     currency's mid. Nothing is rounded here: the ticker's six places moved
     the dong 0.56% off the market, and a publish would have carried that.
     A feed that cannot price the home currency gives no market at all, so
     the board falls back to the last publish rather than guess. */
  function homeMarket(mids, home) {
    var code = String(home || "").toUpperCase();
    if (!mids || typeof mids !== "object" || !/^[A-Z]{3}$/.test(code)) return {};
    var per = code === "CAD" ? (positive(mids.CAD) || 1) : positive(mids[code]);
    if (per === null) return {};
    var out = {};
    Object.keys(mids).forEach(function (c) {
      var cad = positive(mids[c]);
      if (c !== code && /^[A-Z]{3}$/.test(c) && cad !== null) out[c] = cad / per;
    });
    if (code !== "CAD" && !out.CAD) out.CAD = 1 / per;
    return out;
  }

  /* One row per currency the desk shows or has published, in the
     published order first, then the desk's other currencies. */
  function draftRows(input) {
    var home = String(input.home || "").toUpperCase();
    var settings = input.settings || {};
    var pinned = settings.spotOverride || {};
    var custom = settings.spreads || {};
    var def = spreadPct(settings.defaultSpread);
    var dflt = def === null ? DEFAULT_SPREAD_PCT : def;
    var board = input.board || null;
    var published = (board && board.rows) || {};
    var market = input.market || {};
    var seen = {};
    var order = [];
    function add(code) {
      var c = String(code || "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(c) || c === home || seen[c]) return;
      seen[c] = true;
      order.push(c);
    }
    ((board && board.order) || []).forEach(add);
    Object.keys(published).forEach(add);
    (input.codes || []).forEach(add);
    return order.map(function (code) {
      var pub = published[code];
      var pin = positive(pinned[code]);
      var own = spreadPct(custom[code]);
      return {
        code: code,
        mid: pin !== null ? pin : (positive(market[code]) !== null ? positive(market[code]) : (pub ? positive(pub.mid) : null)),
        spreadPct: own === null ? dflt : own,
        custom: own !== null,
        pinned: pin !== null,
        show: pub ? pub.show !== false : true,
        published: !!pub
      };
    });
  }

  function fraction(pct) { return Number((pct / 100).toPrecision(12)); }

  /* The body for POST /api/rates/publish, or the reason it cannot go. A
     hidden currency with no rate is left off; a shown one stops the publish. */
  function publishBody(rows, defaultSpreadPct) {
    var missing = [], tooWide = [], out = {}, order = [];
    rows.forEach(function (r) {
      if (r.mid === null) { if (r.show) missing.push(r.code); return; }
      if (r.spreadPct > MAX_SPREAD_PCT) tooWide.push(r.code);
      var row = { mid: r.mid, show: r.show };
      if (r.custom) row.spread = fraction(r.spreadPct);
      out[r.code] = row;
      order.push(r.code);
    });
    if (defaultSpreadPct > MAX_SPREAD_PCT) tooWide.push("default");
    if (missing.length || tooWide.length || !order.length) {
      var refusal = { ok: false, missing: missing };
      if (tooWide.length) refusal.tooWide = tooWide;
      return refusal;
    }
    var margin = fraction(defaultSpreadPct);
    return { ok: true, body: { buyMargin: margin, sellMargin: margin, rows: out, order: order } };
  }

  /* True when Publish would send what customers already see. */
  function sameAsPublished(rows, published, defaultSpreadPct) {
    if (!published || !published.rows) return false;
    var next = publishBody(rows, defaultSpreadPct);
    if (!next.ok) return false;
    var margin = fraction(defaultSpreadPct);
    if (published.buyMargin !== undefined && (Number(published.buyMargin) !== margin || Number(published.sellMargin) !== margin)) return false;
    /* Only codes that are rows. The seed lists the home currency in its
       order, and the home currency is never a row on its own board. */
    var pubOrder = (published.order || Object.keys(published.rows)).filter(function (c) { return !!published.rows[c]; });
    if (pubOrder.join(",") !== next.body.order.join(",")) return false;
    return next.body.order.every(function (code) {
      var a = next.body.rows[code], b = published.rows[code];
      return !!b && Number(b.mid) === a.mid && (b.show !== false) === a.show
        && (b.spread === undefined ? a.spread === undefined : Number(b.spread) === a.spread);
    });
  }

  return { DEFAULT_SPREAD_PCT: DEFAULT_SPREAD_PCT, deskPair: deskPair, homeMarket: homeMarket, draftRows: draftRows, publishBody: publishBody, sameAsPublished: sameAsPublished };
});
