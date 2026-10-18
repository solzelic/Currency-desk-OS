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
     "" is an empty field. "2." is still being typed. "2.123" is not a fee percent. */
  function feePctText(value) {
    var text = String(value);
    if (text === "") return "";
    return /^\d{0,6}(?:\.\d{0,2})?$/.test(text) ? text : null;
  }

  /* The digits of a percent or a money figure, with an exponent expanded.
     1e-7 is 0.0000001. 1e2 is 100. This is string arithmetic, not a float compare. */
  function plainDecimal(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return expandDecimal(String(value));
    }
    if (typeof value === "string") return expandDecimal(value.trim());
    return null;
  }

  function expandDecimal(text) {
    var sci = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
    if (sci) {
      var exp = Number(sci[4]);
      if (!Number.isSafeInteger(exp)) return null;
      var digits = sci[2] + (sci[3] || "");
      var point = sci[2].length + exp;
      var sign = sci[1] === "-" ? "-" : "";
      if (point <= 0) return sign + "0." + "0".repeat(-point) + digits;
      if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
      return sign + digits.slice(0, point) + "." + digits.slice(point);
    }
    return /^[+-]?\d+(?:\.\d+)?$/.test(text) ? text : null;
  }

  /* How many digits sit after the point, once trailing zeros are gone.
     Null when the figure is not a decimal. That is not "more than 2". */
  function fractionalDigits(value) {
    var plain = plainDecimal(value);
    if (plain == null) return null;
    var body = plain.replace(/^[+-]/, "");
    return (body.split(".")[1] || "").replace(/0+$/, "").length;
  }

  function feePercentOverTwo(value) {
    var digits = fractionalDigits(value);
    return digits != null && digits > 2;
  }

  function moneyOverTwo(value) {
    var digits = fractionalDigits(value);
    return digits != null && digits > 2;
  }

  /* The percent the table shows and the edit state keeps. 2.125 is 2.13,
     the same half-up figure booking uses. */
  function feePctShown(value) {
    var plain = plainDecimal(value);
    if (plain == null) return null;
    var neg = plain.charAt(0) === "-";
    var body = neg ? plain.slice(1) : plain;
    var match = /^(\d+)(?:\.(\d+))?$/.exec(body);
    if (!match) return null;
    var hundredths = percentHundredths(match[1], (match[2] || "").replace(/0+$/, ""));
    if (hundredths == null) return null;
    var whole = Math.floor(hundredths / 100);
    var frac = hundredths % 100;
    var text = frac === 0 ? String(whole) : (frac % 10 === 0 ? whole + "." + (frac / 10) : whole + "." + String(frac).padStart(2, "0"));
    return neg ? "-" + text : text;
  }

  return {
    chequeScheduleFee: chequeScheduleFee,
    moneyCents: moneyCents,
    percentParts: percentParts,
    divHalfUp: divHalfUp,
    centsText: centsText,
    feePctText: feePctText,
    feePercentOverTwo: feePercentOverTwo,
    moneyOverTwo: moneyOverTwo,
    feePctShown: feePctShown,
  };
})();
