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

  /* A till count, read from the text the teller typed or pasted (#558).

     Read exactly or refused, never rounded and never guessed. 1.999 CAD is
     refused, because sending 2.00 is a count nobody made. A pasted 1500² is
     refused, because reading the ² as a 2 is a count of 15002. Only the
     ASCII digits 0 to 9 and one point are read, so a superscript, a
     full-width or an Arabic-Indic digit is refused, not normalised.

     The work is on the text, not on a Number, so no binary rounding can
     reach the value. The value is the decimal string the handover sends,
     padded to the currency's places. The server checks the same rule
     again: decimalString in server/src/ledger/routes.ts, then the
     currency's minor unit. Grouping commas are refused here; reading them
     is issue #556. */
  var COUNT_MAX_WHOLE_DIGITS = 10;   // a till holds at most 1,000,000,000

  function parseCount(text, currency) {
    var ccy = String(currency || "").toUpperCase();
    var raw = String(text == null ? "" : text).trim();
    if (raw === "") return { ok: false, reason: "Type the " + ccy + " count." };
    var m = /^([0-9]*)(?:\.([0-9]*))?$/.exec(raw);
    if (!m || (m[1] === "" && !m[2])) {
      return { ok: false, reason: "Type the " + ccy + " count with the digits 0 to 9 and one decimal point." };
    }
    var places = displayPlaces(ccy);
    var whole = m[1].replace(/^0+(?=[0-9])/, "") || "0";
    var fraction = m[2] == null ? "" : m[2];
    if (places === 0 && m[2] != null) {
      return { ok: false, reason: ccy + " has no decimal places. Count whole " + ccy + "." };
    }
    if (fraction.length > places) {
      return { ok: false, reason: ccy + " counts to " + places + " decimal places. " + raw + " has " + fraction.length + ". Nothing was rounded." };
    }
    while (fraction.length < places) fraction += "0";
    var tooBig = whole.length > COUNT_MAX_WHOLE_DIGITS ||
      (whole.length === COUNT_MAX_WHOLE_DIGITS && (whole > "1000000000" || (whole === "1000000000" && /[1-9]/.test(fraction))));
    if (tooBig) return { ok: false, reason: ccy + " " + raw + " is more than a till can hold." };
    return { ok: true, value: places === 0 ? whole : whole + "." + fraction };
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
