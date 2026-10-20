/* The rate shown next to a payout.
   The payout is the figure of record. This is the rate that payout
   came from. It always shows at least MIN_RATE_PLACES. It shows one
   more place, up to MAX_RATE_PLACES, only when that rate times the
   amount equals the payout with nothing left over. A rate smaller
   than 0.001 keeps four significant digits, so 0.0007254 stays
   0.0007254 and is not cut to 0.0007 or 0.0001. When no exact rate
   fits, it shows that figure and the note. It is not the board rate.
   The board field keeps the computed figure, trailing zeros dropped.
   Display only. The stored rate and the payout stay as they are. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
  var MIN_RATE_PLACES = 4;
  var MAX_RATE_PLACES = 6;
  var SIGNIFICANT_DIGITS = 4;
  var ABSOLUTE_CAP = 12;
  var RATE_NOTE = "Rate rounded. The amounts are exact.";

  function decimalsOf(text) {
    var s = String(text);
    var i = s.indexOf(".");
    return i < 0 ? 0 : s.length - i - 1;
  }

  function scaled(text, scale) {
    var raw = String(text).trim();
    var neg = raw.charAt(0) === "-";
    if (neg || raw.charAt(0) === "+") raw = raw.slice(1);
    var parts = raw.split(".");
    var whole = (parts[0] || "0").replace(/\D/g, "") || "0";
    var frac = (parts[1] || "").replace(/\D/g, "");
    var padded = (frac + "000000000000").slice(0, scale);
    var n = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded || "0");
    return neg ? -n : n;
  }

  function halfUpDiv(num, den) {
    var sign = (num < 0n) === (den < 0n) ? 1n : -1n;
    var an = num < 0n ? -num : num;
    var ad = den < 0n ? -den : den;
    if (ad === 0n) return null;
    var q = an / ad;
    var rem = an % ad;
    return sign * (rem * 2n >= ad ? q + 1n : q);
  }

  function scaledText(n, scale) {
    var neg = n < 0n;
    var abs = (neg ? -n : n).toString().padStart(scale + 1, "0");
    var body = scale === 0 ? abs : abs.slice(0, abs.length - scale) + "." + abs.slice(abs.length - scale);
    return (neg ? "-" : "") + body;
  }

  function moneyText(value) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && isFinite(value)) {
      return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    }
    return "";
  }

  function knownPlaces(minorPlaces) {
    return Number.isInteger(minorPlaces) && minorPlaces >= 0 && minorPlaces <= 8;
  }

  /* The candidate at `places`, half up from the true ratio. */
  function rateAt(amountText, payoutRaw, places) {
    var aScale = decimalsOf(amountText);
    var pScale = decimalsOf(payoutRaw);
    var aInt = scaled(amountText, aScale);
    if (aInt === 0n) return "";
    var num = scaled(payoutRaw, pScale) * (10n ** BigInt(aScale + places));
    var den = aInt * (10n ** BigInt(pScale));
    var rounded = halfUpDiv(num, den);
    if (rounded == null) return "";
    return scaledText(rounded, places);
  }

  /* True when rate × amount is the payout, with no leftover fraction. */
  function multipliesExactly(amountText, rateText, payoutRaw) {
    if (!rateText) return false;
    var aScale = decimalsOf(amountText);
    var rScale = decimalsOf(rateText);
    var pScale = decimalsOf(payoutRaw);
    var prod = scaled(amountText, aScale) * scaled(rateText, rScale);
    var prodScale = aScale + rScale;
    var payout = scaled(payoutRaw, pScale);
    if (prodScale >= pScale) {
      var div = 10n ** BigInt(prodScale - pScale);
      return prod % div === 0n && prod / div === payout;
    }
    return prod * (10n ** BigInt(pScale - prodScale)) === payout;
  }

  /* Places that keep four significant digits. 0.7221 stays at four.
     0.0007254 needs seven. The search still stops at six for an
     ordinary rate, and extends only when four places would hide the
     digits. */
  function significantPlaces(amountText, payoutRaw) {
    var aScale = decimalsOf(amountText);
    var pScale = decimalsOf(payoutRaw);
    var amount = scaled(amountText, aScale);
    var payout = scaled(payoutRaw, pScale);
    if (amount <= 0n || payout <= 0n) return MIN_RATE_PLACES;
    var k = 1;
    for (; k <= ABSOLUTE_CAP; k += 1) {
      if (payout * (10n ** BigInt(aScale + k)) >= amount * (10n ** BigInt(pScale))) break;
    }
    /* 0.0118 and anything at least 0.001 already has its digits inside
       four places. Only a smaller rate grows the figure. */
    if (k <= 3) return MIN_RATE_PLACES;
    var need = k + SIGNIFICANT_DIGITS - 1;
    if (need < MIN_RATE_PLACES) need = MIN_RATE_PLACES;
    if (need > ABSOLUTE_CAP) need = ABSOLUTE_CAP;
    return need;
  }

  function effectiveRate(amount, payout, minorPlaces) {
    if (!knownPlaces(minorPlaces)) return { text: "", rounded: false };
    var amountText = moneyText(amount);
    var payoutRaw = moneyText(payout);
    if (!amountText || !payoutRaw || payoutRaw === "-" || payoutRaw === ".") return { text: "", rounded: false };
    var show = significantPlaces(amountText, payoutRaw);
    var ceiling = show > MAX_RATE_PLACES ? show : MAX_RATE_PLACES;
    var exact = "";
    var places = MIN_RATE_PLACES;
    for (; places <= ceiling; places += 1) {
      var candidate = rateAt(amountText, payoutRaw, places);
      if (multipliesExactly(amountText, candidate, payoutRaw)) {
        exact = candidate;
        break;
      }
    }
    if (exact) return { text: exact, rounded: false };
    return { text: rateAt(amountText, payoutRaw, show), rounded: true };
  }

  /* The Board rate field. 0.00098 stays 0.00098. Four-place rounding
     would show 0.0010, and Override would start from that. */
  function boardRateText(rate) {
    var n = +rate;
    if (!(n > 0) || !isFinite(n)) return "";
    return n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  }

  return {
    MIN_RATE_PLACES: MIN_RATE_PLACES,
    MAX_RATE_PLACES: MAX_RATE_PLACES,
    RATE_NOTE: RATE_NOTE,
    effectiveRate: effectiveRate,
    boardRateText: boardRateText,
  };
});
