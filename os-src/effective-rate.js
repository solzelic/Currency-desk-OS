/* The rate shown next to a payout.
   The payout is the figure of record. This is the rate that payout
   came from, rounded half up to DISPLAY_RATE_PLACES. It never shows
   more places than that, and it is not the board rate.
   Change DISPLAY_RATE_PLACES here. The receipt sentence uses it.
   Display only. The stored rate and the payout stay as they are. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
  var DISPLAY_RATE_PLACES = 4;
  var RECEIPT_RATE_NOTE = "Rate rounded to " + DISPLAY_RATE_PLACES + " places. The amounts above are exact.";

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

  function effectiveRate(amount, payout, minorPlaces) {
    if (!knownPlaces(minorPlaces)) return { text: "" };
    var amountText = moneyText(amount);
    var payoutRaw = moneyText(payout);
    if (!amountText || !payoutRaw || payoutRaw === "-" || payoutRaw === ".") return { text: "" };
    var aScale = decimalsOf(amountText);
    var pScale = decimalsOf(payoutRaw);
    var aInt = scaled(amountText, aScale);
    if (aInt === 0n) return { text: "" };
    var pInt = scaled(payoutRaw, pScale);
    var num = pInt * (10n ** BigInt(aScale + DISPLAY_RATE_PLACES));
    var den = aInt * (10n ** BigInt(pScale));
    var rounded = halfUpDiv(num, den);
    if (rounded == null) return { text: "" };
    return { text: scaledText(rounded, DISPLAY_RATE_PLACES) };
  }

  function effectiveRateText(amount, payout, minorPlaces) {
    return effectiveRate(amount, payout, minorPlaces).text;
  }

  return {
    DISPLAY_RATE_PLACES: DISPLAY_RATE_PLACES,
    RECEIPT_RATE_NOTE: RECEIPT_RATE_NOTE,
    effectiveRate: effectiveRate,
    effectiveRateText: effectiveRateText,
  };
});
