/* Rate beside a payout. Four places, more when they multiply out, four significant digits below 0.001. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
  var MIN_RATE_PLACES = 4;
  var MAX_RATE_PLACES = 6;
  var SIGNIFICANT_DIGITS = 4;
  var ABSOLUTE_CAP = 12;
  var RATE_NOTE = "Rate shown rounded. Amounts use the exact rate.";

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

  /* Half up, to `places`. This rounds the rate it is given. It does
     not solve a new rate out of the amount and the payout. */
  function roundRate(rate, places) {
    var raw = String(rate == null ? "" : rate).trim();
    if (raw.charAt(0) === "+") raw = raw.slice(1);
    if (!/^\d+(\.\d+)?$/.test(raw)) return "";
    if (!Number.isInteger(places) || places < 0 || places > ABSOLUTE_CAP) return "";
    var scale = decimalsOf(raw);
    var whole = scaled(raw, scale);
    var rounded = whole;
    if (scale > places) {
      rounded = halfUpDiv(whole, 10n ** BigInt(scale - places));
      if (rounded == null) return "";
    } else if (scale < places) {
      rounded = whole * (10n ** BigInt(places - scale));
    }
    return scaledText(rounded, places);
  }

  /* Six places, half up, of the rate the ledger stored. The receipt
     uses this. The card uses quoteCardRate. */
  function exactRateText(rate) {
    return roundRate(rate, MAX_RATE_PLACES);
  }

  /* The figure on the quote card. It is the frozen server rate, rounded
     half up. Four places, then five, then six, and further only when a
     small rate needs four significant digits. The first of those that
     multiplies back to the payout is the one shown, and then there is
     no note. When none of them multiply back, the card keeps the short
     rounding and the note. It never solves a rate from the two amounts:
     7.50 CAD at 0.722103704355 stays 0.7221, not 0.7227. */
  function quoteCardRate(rate, amount, payout) {
    var amountText = moneyText(amount);
    var payoutRaw = moneyText(payout);
    if (!amountText || !payoutRaw || payoutRaw === "-" || payoutRaw === ".") return { text: "", rounded: false };
    var show = significantPlaces(amountText, payoutRaw);
    var ceiling = show > MAX_RATE_PLACES ? show : MAX_RATE_PLACES;
    var places = MIN_RATE_PLACES;
    for (; places <= ceiling; places += 1) {
      var candidate = roundRate(rate, places);
      if (multipliesExactly(amountText, candidate, payoutRaw)) return { text: candidate, rounded: false };
    }
    var display = show > MIN_RATE_PLACES ? show : MIN_RATE_PLACES;
    var text = roundRate(rate, display);
    if (!text) return { text: "", rounded: false };
    return { text: text, rounded: true };
  }

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
    exactRateText: exactRateText,
    quoteCardRate: quoteCardRate,
    boardRateText: boardRateText,
  };
});
