/* Screen places for a currency. ISO minor units when the server table
   has not loaded. Three-place currencies stay at three on the screen.
   The ledger still stores two. The list matches server/src/ledger/currencies.ts. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
  var ISO = {
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
    PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  };

  function displayPlaces(code, scales) {
    var c = String(code || "").toUpperCase();
    var places = 2;
    if (scales && Object.prototype.hasOwnProperty.call(scales, c) && typeof scales[c] === "number") {
      places = scales[c];
    } else if (Object.prototype.hasOwnProperty.call(ISO, c)) {
      places = ISO[c];
    }
    if (typeof places !== "number" || !isFinite(places)) places = 2;
    if (places > 3) places = 3;
    if (places < 0) places = 0;
    return places;
  }

  /* Half up, in the places the screen will actually draw. */
  function roundMinor(n, places) {
    var p = places;
    if (typeof p !== "number" || !isFinite(p)) p = 2;
    if (p > 3) p = 3;
    if (p < 0) p = 0;
    var value = Number(Number(n).toFixed(p));
    return Object.is(value, -0) ? 0 : value;
  }

  /* Add the rows, then round once. Rounding each row to cents and then
     adding is a different number: 1.004 and 1.004 are 2.01 together
     and 2.00 if each row is rounded first. */
  function sumHomeMinor(values, places) {
    var sum = 0;
    var i;
    for (i = 0; i < values.length; i++) {
      var n = Number(values[i]);
      if (!isFinite(n)) return null;
      sum += n;
    }
    return roundMinor(sum, places);
  }

  function unitAmount(n, code, scales) {
    var places = displayPlaces(code, scales);
    return new Intl.NumberFormat("en-CA", {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(roundMinor(n, places));
  }

  /* A takeover count. The field keeps every character the teller
     typed or pasted. This only reads that text: trim the surrounding
     spaces, apply NFKC, then accept a whole number or, for a currency
     with a minor unit, a number of digits and one point. Empty is not
     a count. The value is the string the handover sends. */
  var WHOLE = /^\d+$/;
  var THOUSANDS = /^\d{1,3}(,\d{3})+$/;
  var GROUPED = /^\d{1,3}(,\d{3})+(\.\d*)?$/;

  function canonicalWhole(raw) {
    if (WHOLE.test(raw)) return raw;
    if (THOUSANDS.test(raw)) return raw.replace(/,/g, "");
    return null;
  }

  function decimalValue(raw, places) {
    var body = GROUPED.test(raw) ? raw.replace(/,/g, "") : raw;
    if (!/^\d*\.?\d*$/.test(body) || body === "" || body === ".") return null;
    var amount = Number(body);
    if (!isFinite(amount)) return null;
    return amount.toFixed(places);
  }

  function parseCount(text, currency) {
    var raw = String(text == null ? "" : text).trim().normalize("NFKC");
    if (raw === "") return { ok: false };
    var places = displayPlaces(currency);
    if (places === 0) {
      var whole = canonicalWhole(raw);
      if (whole == null) return { ok: false };
      return { ok: true, value: whole };
    }
    var value = decimalValue(raw, places);
    if (value == null) return { ok: false };
    return { ok: true, value: value };
  }

  function moneyAmount(n, code, scales) {
    if (n == null || n === "" || isNaN(n)) return "";
    var places = displayPlaces(code, scales);
    var ccy = code || "CAD";
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(roundMinor(n, places));
  }

  return { displayPlaces: displayPlaces, roundMinor: roundMinor, sumHomeMinor: sumHomeMinor, unitAmount: unitAmount, moneyAmount: moneyAmount, parseCount: parseCount };
});
