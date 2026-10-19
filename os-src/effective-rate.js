/* The rate a person can check by hand.
   The payout on the deal is the figure that is true. This finds the
   shortest rate whose product rounds back to that payout, at the
   currency's own places. It stops at EXACT_RATE_PLACES. When that
   many places still miss the cents, it shows the true rate rounded
   to ROUNDED_RATE_PLACES and sets rounded, and the payout stays.
   Head of Design has not confirmed these two caps. Change them here.
   Display only. It does not change the rate stored on the deal. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
  var EXACT_RATE_PLACES = 6;
  var ROUNDED_RATE_PLACES = 4;
  var ROUNDED_NOTE = "rounded";

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

  function halfUp(n, fromScale, toScale) {
    if (toScale >= fromScale) return n * (10n ** BigInt(toScale - fromScale));
    var div = 10n ** BigInt(fromScale - toScale);
    var sign = n < 0n ? -1n : 1n;
    var abs = n < 0n ? -n : n;
    var q = abs / div;
    var rem = abs % div;
    var rounded = rem * 2n >= div ? q + 1n : q;
    return sign * rounded;
  }

  function scaledText(n, scale) {
    var neg = n < 0n;
    var abs = (neg ? -n : n).toString().padStart(scale + 1, "0");
    var body = scale === 0 ? abs : abs.slice(0, abs.length - scale) + "." + abs.slice(abs.length - scale);
    return (neg ? "-" : "") + body;
  }

  function trimZeros(text) {
    if (text.indexOf(".") < 0) return text;
    return text.replace(/0+$/, "").replace(/\.$/, "");
  }

  function moneyText(value) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && isFinite(value)) {
      return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    }
    return "";
  }

  function productText(amountText, rateText, outPlaces) {
    var aScale = decimalsOf(amountText);
    var rScale = decimalsOf(rateText);
    var prod = scaled(amountText, aScale) * scaled(rateText, rScale);
    return scaledText(halfUp(prod, aScale + rScale, outPlaces), outPlaces);
  }

  function payoutText(payout, places) {
    var raw = moneyText(payout);
    if (!raw || raw === "-" || raw === ".") return "";
    var scale = decimalsOf(raw);
    return scaledText(halfUp(scaled(raw, scale), scale, places), places);
  }

  function knownPlaces(minorPlaces) {
    return Number.isInteger(minorPlaces) && minorPlaces >= 0 && minorPlaces <= 8;
  }

  function blank() {
    return { text: "", rounded: false };
  }

  function effectiveRate(amount, payout, minorPlaces) {
    if (!knownPlaces(minorPlaces)) return blank();
    var amountText = moneyText(amount);
    var places = minorPlaces;
    var target = payoutText(payout, places);
    if (!amountText || scaled(amountText, decimalsOf(amountText)) === 0n || !target) return blank();
    var pRaw = moneyText(payout);
    var pInt = scaled(pRaw, decimalsOf(pRaw));
    var aInt = scaled(amountText, decimalsOf(amountText));
    var pScale = decimalsOf(pRaw);
    var aScale = decimalsOf(amountText);
    for (var d = 0; d <= EXACT_RATE_PLACES; d++) {
      var num = pInt * (10n ** BigInt(aScale + d));
      var den = aInt * (10n ** BigInt(pScale));
      var rounded = halfUpDiv(num, den);
      if (rounded == null) return blank();
      var shown = trimZeros(scaledText(rounded, d));
      if (decimalsOf(shown) <= EXACT_RATE_PLACES && productText(amountText, shown, places) === target) {
        return { text: shown, rounded: false };
      }
    }
    var fallbackNum = pInt * (10n ** BigInt(aScale + ROUNDED_RATE_PLACES));
    var fallbackDen = aInt * (10n ** BigInt(pScale));
    var fallback = halfUpDiv(fallbackNum, fallbackDen);
    if (fallback == null) return blank();
    return { text: scaledText(fallback, ROUNDED_RATE_PLACES), rounded: true };
  }

  function effectiveRateText(amount, payout, minorPlaces) {
    return effectiveRate(amount, payout, minorPlaces).text;
  }

  function rateMultiplies(rateText, amount, payout, minorPlaces) {
    var text = String(rateText == null ? "" : rateText).trim();
    if (!knownPlaces(minorPlaces)) return false;
    var amountText = moneyText(amount);
    if (!text || decimalsOf(text) > EXACT_RATE_PLACES || !amountText) return false;
    return productText(amountText, text, minorPlaces) === payoutText(payout, minorPlaces);
  }

  return {
    EXACT_RATE_PLACES: EXACT_RATE_PLACES,
    ROUNDED_RATE_PLACES: ROUNDED_RATE_PLACES,
    ROUNDED_NOTE: ROUNDED_NOTE,
    effectiveRate: effectiveRate,
    effectiveRateText: effectiveRateText,
    rateMultiplies: rateMultiplies,
  };
});
