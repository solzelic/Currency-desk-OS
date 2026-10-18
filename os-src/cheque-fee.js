/* One cheque fee, in integer cents, half up.
   The screen and the server both call this. A float multiply is wrong
   here: 1000.25 * 2 / 100 is not 20.005 in binary, and toFixed says 20.00.
   Returns a two-place decimal string, or null when a figure is not a fee.

   Limits. Face and minimum: at most 12 digits before the point, and 1 or 2
   after. "1000.5" is 1000.50. A third digit after the point is not money.
   Percent: at most 6 digits before the point, and at most 12 after. More
   than 2 digits after the point round half up to 2 on this read. This read
   does not refuse them. The save does. Half up: a remainder of half a cent
   or more adds one cent. */
var CDOS_CHEQUE_FEE = (function () {
  function chequeScheduleFee(face, feePct, feeMin) {
    var faceCents = moneyCents(face);
    var minCents = moneyCents(feeMin == null || feeMin === "" ? 0 : feeMin);
    var pct = percentParts(feePct == null || feePct === "" ? 0 : feePct);
    if (faceCents == null || minCents == null || pct == null) return null;
    if (faceCents < 0 || minCents < 0 || pct.num < 0) return null;
    var numer = faceCents * pct.num;
    if (!Number.isSafeInteger(numer)) return null;
    var percentCents = divHalfUp(numer, pct.scale * 100);
    if (percentCents == null) return null;
    var due = percentCents > minCents ? percentCents : minCents;
    return centsText(due);
  }

  function moneyCents(value) {
    var match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
    if (!match) return null;
    var cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    return Number.isSafeInteger(cents) ? cents : null;
  }

  /* A stored percent with more than 2 digits after the point becomes 2
     digits, half up, before the fee is taken. 2.125 is 2.13. 2.12345 is 2.12. */
  function percentParts(value) {
    var match = /^(\d{1,6})(?:\.(\d{1,12}))?$/.exec(String(value).trim());
    if (!match) return null;
    var hundredths = percentHundredths(match[1], match[2] || "");
    if (hundredths == null) return null;
    return { num: hundredths, scale: 100 };
  }

  function percentHundredths(whole, frac) {
    var head = (frac + "00").slice(0, 2);
    var hundredths = Number(whole) * 100 + Number(head);
    var extra = frac.length > 2 ? frac.charAt(2) : "";
    if (extra !== "" && extra >= "5") hundredths += 1;
    return Number.isSafeInteger(hundredths) ? hundredths : null;
  }

  function divHalfUp(numer, denom) {
    if (!Number.isSafeInteger(numer) || !Number.isSafeInteger(denom) || denom <= 0) return null;
    var q = Math.floor(numer / denom);
    var r = numer % denom;
    if (r * 2 >= denom) q += 1;
    return q;
  }

  function centsText(cents) {
    return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
  }

  /* What the Fee % field may hold while someone is typing.
     At most 6 digits, then an optional point and at most 2 digits.
     "2." is still being typed. "2.123" is not a fee percent. */
  function feePctText(value) {
    var text = String(value);
    if (text === "") return "";
    return /^\d{0,6}(?:\.\d{0,2})?$/.test(text) ? text : null;
  }

  /* True when a percent already has more than 2 digits after the point.
     Trailing zeros do not count: "2.120" is 2.12.
     An unreadable figure is not this case. Booking refuses that itself. */
  function feePercentOverTwo(value) {
    var text = null;
    if (typeof value === "number" && Number.isFinite(value)) text = String(value);
    else if (typeof value === "string") text = value.trim();
    if (text == null || /e/i.test(text)) return false;
    var match = /^(\d{1,6})(?:\.(\d+))?$/.exec(text);
    if (!match) return false;
    var frac = (match[2] || "").replace(/0+$/, "");
    return frac.length > 2;
  }

  return {
    chequeScheduleFee: chequeScheduleFee,
    moneyCents: moneyCents,
    percentParts: percentParts,
    divHalfUp: divHalfUp,
    centsText: centsText,
    feePctText: feePctText,
    feePercentOverTwo: feePercentOverTwo,
  };
})();
