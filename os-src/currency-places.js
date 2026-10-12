/* The one decimal-places table.

   ISO 4217 exponents for the currencies this desk can reach. Anything
   not named here has two places, which is true of most of ISO 4217.
   Zero is a currency with no decimals at all (yen), not "unknown".
   Three is a dinar: the count is still in major units (125.005), and
   the money columns hold two, so a non-zero third place is refused
   rather than rounded.

   server/src/ledger/currencies.ts reads this file. The count sheet
   reads it. The quote helper (os-src/quote-terms.js, the arithmetic
   PR #129 shares with the counter) must call minorUnits from here.
   A second copy of this table is how a dinar and a yen disagree
   about what a typed figure means. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  var host = root.CDOS || (root.CDOS = {});
  host.currencyPlacesTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var EXCEPTIONS = {
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
    PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0,
    XPF: 0,
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  };
  /* The drawer columns are numeric(24, 2). A count past this is not
     a drawer a teller counted. */
  var CAP = "1000000000";

  function minorUnits(code) {
    return EXCEPTIONS[String(code || "").toUpperCase()] ?? 2;
  }

  function canonical(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
    return text;
  }

  function fracOf(text) {
    var dot = text.indexOf(".");
    return dot < 0 ? "" : text.slice(dot + 1);
  }

  function toScaled(value, scale) {
    var text = String(value);
    var neg = text.charAt(0) === "-";
    if (neg) text = text.slice(1);
    var parts = text.split(".");
    var digits = (parts[0] || "0") + (parts[1] || "") + "0".repeat(Math.max(0, scale - (parts[1] || "").length));
    digits = digits.replace(/^0+(?=\d)/, "");
    var n = BigInt(digits || "0");
    return neg ? -n : n;
  }

  function formatScaled(n, scale) {
    var neg = n < 0n;
    var abs = neg ? -n : n;
    var digits = abs.toString().padStart(scale + 1, "0");
    var whole = scale ? digits.slice(0, digits.length - scale) : digits;
    var frac = scale ? digits.slice(digits.length - scale) : "";
    frac = frac.replace(/0+$/, "");
    whole = whole.replace(/^0+(?=\d)/, "") || "0";
    var body = frac ? whole + "." + frac : whole;
    if (body === "0") return "0";
    return neg ? "-" + body : body;
  }

  function sumAmounts(values) {
    var list = values || [];
    if (!list.length) return "0";
    var scale = 0;
    for (var i = 0; i < list.length; i++) {
      var text = canonical(list[i]);
      if (text == null) return null;
      var frac = fracOf(text.charAt(0) === "-" ? text.slice(1) : text);
      if (frac.length > scale) scale = frac.length;
    }
    var total = 0n;
    for (var j = 0; j < list.length; j++) total += toScaled(canonical(list[j]), scale);
    return formatScaled(total, scale);
  }

  function negate(value) {
    var text = canonical(value);
    if (text == null) return null;
    if (text === "0" || text === "-0") return "0";
    return text.charAt(0) === "-" ? text.slice(1) : "-" + text;
  }

  function subtractAmounts(left, right) {
    var minus = negate(right);
    if (minus == null) return null;
    return sumAmounts([left, minus]);
  }

  function amountsEqual(left, right) {
    var gap = subtractAmounts(left, right);
    return gap === "0";
  }

  function greaterThan(left, right) {
    var gap = subtractAmounts(left, right);
    return !!gap && gap !== "0" && gap.charAt(0) !== "-";
  }

  /* Half up, away from zero, in the currency's own places. The same
     rule Decimal.ROUND_HALF_UP applies on the server. "189174.85" yen
     (no decimals) is "189175". */
  function roundHalfUp(amount, places) {
    var text = canonical(amount);
    if (text == null) return null;
    var neg = text.charAt(0) === "-";
    var body = neg ? text.slice(1) : text;
    var parts = body.split(".");
    var whole = parts[0];
    var frac = parts[1] || "";
    var keep = Math.max(0, places);
    if (frac.length <= keep) return text;
    var next = frac.charAt(keep);
    var base = whole + frac.slice(0, keep);
    var rounded = BigInt(base.replace(/^0+(?=\d)/, "") || "0");
    if (next >= "5") rounded += 1n;
    var out = formatScaled(neg ? -rounded : rounded, keep);
    return out;
  }

  /* amount / units-per-CAD. A missing or non-positive rate is null.
     It is not 1. A 1:1 stand-in counts a dong as a dollar. */
  function cadOf(amount, unitsPerCad) {
    var left = canonical(amount);
    var rate = canonical(unitsPerCad);
    if (left == null || rate == null) return null;
    if (rate === "0" || /^-?0(?:\.0+)?$/.test(rate)) return null;
    if (rate.charAt(0) === "-") return null;
    var scale = Math.max(fracOf(left).length, fracOf(rate).length, 2);
    var num = toScaled(left, scale);
    var den = toScaled(rate, scale);
    if (den === 0n) return null;
    var scaled = num * (10n ** BigInt(scale));
    var neg = scaled < 0n;
    var abs = neg ? -scaled : scaled;
    var denAbs = den < 0n ? -den : den;
    var q = abs / denAbs;
    var rem = abs % denAbs;
    if (rem * 2n >= denAbs) q += 1n;
    return formatScaled(neg ? -q : q, scale);
  }

  /* Rows are { amount, unitsPerCad }. A row with no rate is left out.
     The total of the rows that have a rate is what the drawer can say
     in Canadian dollars. Null when none of them can. */
  function cadTotal(rows) {
    var parts = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row) continue;
      var cad = cadOf(row.amount, row.unitsPerCad);
      if (cad == null) continue;
      parts.push(cad);
    }
    if (!parts.length) return null;
    return sumAmounts(parts);
  }

  /* What is wrong with a typed count, as a sentence the cashier can
     act on. Empty when the text is a count in this currency's major
     units. The text is not rewritten: a comma, a minus, or an exponent
     stays on screen and this says so. Decimal is not called. A string
     that fails here must not be parsed. */
  function countProblem(raw, currency) {
    var code = String(currency || "").toUpperCase();
    var text = raw == null ? "" : String(raw);
    if (text === "") return "Enter the " + code + " you counted.";
    if (text.indexOf(",") >= 0) return "Enter " + code + " without commas. Type 1234.50.";
    if (text.indexOf("-") >= 0) return "Enter the " + code + " you counted as zero or more. A minus is not a count.";
    if (/[eE]/.test(text)) return "Enter " + code + " in digits. An exponent is not a count.";
    if (text !== text.trim() || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
      return code + " count must be a number like 1234.50.";
    }
    var places = minorUnits(code);
    var frac = fracOf(text);
    if (places === 0) {
      if (frac && !/^0{1,2}$/.test(frac)) return code + " has no decimals. Enter a whole number.";
    } else if (frac.length > places) {
      var sample = places === 3 ? "125.005" : (places === 2 ? "1234.50" : "1234." + "0".repeat(places));
      return code + " takes " + places + " decimal places. Enter a figure like " + sample + ".";
    }
    if (greaterThan(text, CAP)) return "Enter a " + code + " count of " + CAP + " or less.";
    var significant = frac.replace(/0+$/, "");
    if (significant.length > 2) {
      /* Half-up would turn 125.005 into 125.01. The place that does
         not fit is noted, not added. Truncate toward zero. */
      var truncated = text.split(".")[0] + "." + (frac + "00").slice(0, 2);
      truncated = truncated.replace(/0+$/, "").replace(/\.$/, "");
      if (truncated.indexOf(".") < 0) truncated = text.split(".")[0] + ".00";
      else if (fracOf(truncated).length < 2) truncated = truncated + "0".repeat(2 - fracOf(truncated).length);
      return "Counting " + text + " " + code + " would drop a place. Enter " + truncated + " and note the rest with the owner.";
    }
    return "";
  }

  return {
    EXCEPTIONS: EXCEPTIONS,
    CAP: CAP,
    minorUnits: minorUnits,
    canonical: canonical,
    sumAmounts: sumAmounts,
    subtractAmounts: subtractAmounts,
    amountsEqual: amountsEqual,
    roundHalfUp: roundHalfUp,
    cadOf: cadOf,
    cadTotal: cadTotal,
    countProblem: countProblem,
  };
});
