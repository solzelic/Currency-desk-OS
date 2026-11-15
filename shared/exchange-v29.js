/* Exchange v2.9 rules shared by the server and the desk.

   Amounts are whole cents. A float never decides a threshold.
   The review lock is at most 60 seconds. The owner may store 1 to 300.
   Anything above 60 is stored as a wish and issued as 60.

   A held deal counts once any cash has moved, even when the post is
   still pending. A hold where no cash changed hands is not in the total.
   The meter lists that hold as "held, not counted". Quotes never count.

   Returning client reads this shop only. No earlier check here uses one
   sentence, the same sentence as a first visit. The loader has no
   parameter for any other legal entity. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.exchangeV29 = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var FX_ID = "3000.00";
  var LARGE_CASH = "10000.00";
  var CLIENT_DECLINED = "Client declined";
  var NO_EARLIER_CHECK = "No earlier check at this shop. A new check is needed.";
  var HELD_NOT_COUNTED = "Held, not counted";
  var HOLD_FOOTER = "Holds count once any cash moves.";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function cents(value) {
    var text = String(value == null ? "" : value).trim();
    var match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) return null;
    var frac = (match[3] || "").padEnd(2, "0");
    var n = Number(match[1] + match[2] + frac);
    return Number.isSafeInteger(n) ? n : null;
  }

  function gteMoney(amount, line) {
    var left = cents(amount);
    var right = cents(line);
    if (left == null || right == null) return false;
    return left >= right;
  }

  function isCanadaPack(packId, home) {
    var id = String(packId || "");
    var ccy = String(home || "").trim().toUpperCase();
    return ccy === "CAD" && (id === "pack-ca-v1" || id === "pack-ca-v2");
  }

  function reviewLockSeconds(choice) {
    var n = Number(choice);
    var chosen = Number.isFinite(n) && n >= 1 && n <= 300 ? Math.floor(n) : 60;
    return Math.min(60, chosen);
  }

  function purposeRequired(dealAmount, windowAmount) {
    return gteMoney(dealAmount, LARGE_CASH) || gteMoney(windowAmount, LARGE_CASH);
  }

  function fxNeedsId(dealAmount) {
    return gteMoney(dealAmount, FX_ID);
  }

  function fieldAnswer(value, declined) {
    if (declined === true) return { ok: true, stored: CLIENT_DECLINED, declined: true };
    var text = String(value == null ? "" : value).trim();
    if (text.length > 500) return { ok: false, tooLong: true, stored: "", declined: false };
    if (text.toLowerCase() === CLIENT_DECLINED.toLowerCase()) {
      return { ok: true, stored: CLIENT_DECLINED, declined: true };
    }
    if (!text) return { ok: false, stored: "", declined: false };
    return { ok: true, stored: text, declined: false };
  }

  function occupationAnswer(input) {
    var text = String(input && input.text || "").trim();
    var code = String(input && input.code || "").trim();
    if (text.toLowerCase() === CLIENT_DECLINED.toLowerCase()) return { ok: false, reason: "declined" };
    var allowed = (input && input.allowedCodes) || [];
    if (code && allowed.indexOf(code) < 0) return { ok: false, reason: "code" };
    if (code === "other" && !text) return { ok: false, reason: "text" };
    if (!code && !text) return { ok: false, reason: "missing" };
    return { ok: true, code: code || null, text: text || null };
  }

  function holdCounts(hold) {
    return !!(hold && hold.cashMoved && !hold.superseded);
  }

  function holdMeterLabel(hold) {
    if (!hold || hold.cashMoved) return null;
    return HELD_NOT_COUNTED;
  }

  var NOTE_DENOMS = [100, 50, 20, 10, 5];

  function formatCents(value) {
    var abs = Math.abs(value);
    var whole = Math.floor(abs / 100);
    var frac = String(abs % 100).padStart(2, "0");
    return (value < 0 ? "-" : "") + whole + "." + frac;
  }

  /* Note counts are whole notes. The sum is cents, then compared to the
     customer-pays figure. Nothing here uses a binary float. */
  function addMoney(left, right) {
    var a = cents(left);
    var b = cents(right);
    if (a == null || b == null) return null;
    return formatCents(a + b);
  }

  function countReceived(counts, customerPays) {
    var total = 0;
    for (var i = 0; i < NOTE_DENOMS.length; i += 1) {
      var denom = NOTE_DENOMS[i];
      var raw = counts && (counts[denom] != null ? counts[denom] : counts[String(denom)]);
      var notes = Math.floor(Number(raw));
      if (!Number.isFinite(notes) || notes < 0) notes = 0;
      total += notes * denom * 100;
    }
    var pays = cents(customerPays);
    if (pays == null) return { status: "unknown", counted: formatCents(total), difference: null, label: "" };
    var diff = total - pays;
    if (diff === 0) return { status: "matches", counted: formatCents(total), difference: "0.00", label: "Matches" };
    var gap = formatCents(Math.abs(diff));
    if (diff < 0) return { status: "short", counted: formatCents(total), difference: gap, label: "$" + gap + " short" };
    return { status: "over", counted: formatCents(total), difference: gap, label: "$" + gap + " over" };
  }

  function addYears(iso, years) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match) return null;
    var at = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (Number.isNaN(at.getTime())) return null;
    at.setUTCFullYear(at.getUTCFullYear() + years);
    var month = String(at.getUTCMonth() + 1).padStart(2, "0");
    var day = String(at.getUTCDate()).padStart(2, "0");
    return at.getUTCFullYear() + "-" + month + "-" + day;
  }

  /* checkedOn is this shop's own check. A missing date is a first visit. */
  function returningDecision(input) {
    var checkedOn = input && input.checkedOn;
    var today = input && input.today;
    if (!checkedOn) return { offered: false, recommended: false, reason: NO_EARLIER_CHECK };
    if (input.doubt) {
      return { offered: false, recommended: false, reason: "Something looks off. Re-check before this deal." };
    }
    if (input.confirmedHigh) {
      return { offered: false, recommended: false, reason: "Rated High. A new check is needed." };
    }
    var limit = addYears(checkedOn, 5);
    var soon = addYears(checkedOn, 3);
    if (!limit || !today) return { offered: false, recommended: false, reason: NO_EARLIER_CHECK };
    if (today > limit) {
      return { offered: false, recommended: false, reason: "Last ID check over 5 years ago. A new check is needed." };
    }
    var recommended = !!(soon && today >= soon);
    return { offered: true, recommended: recommended, reason: recommended ? "Re-check recommended" : "" };
  }

  function formatCheckedDay(iso) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match) return "";
    return Number(match[3]) + " " + MONTHS[Number(match[2]) - 1] + " " + match[1];
  }

  /* Whole years from the check to today. The day it turns a year counts. */
  function idAge(checkedOn, today) {
    if (!checkedOn || !today) return null;
    var years = 0;
    while (years < 80) {
      var next = addYears(checkedOn, years + 1);
      if (!next || next > today) break;
      years += 1;
    }
    if (years <= 0) return "under a year";
    return years === 1 ? "1 year" : years + " years";
  }

  function methodTitle(label) {
    var text = String(label || "").trim();
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* Staff screens only. Client receipts, texts, emails, the storefront
     and client links must not use this sentence. */
  function idBadge(checkedOn, methodLabel, today) {
    var method = methodTitle(methodLabel);
    var age = idAge(checkedOn, today);
    if (!method || !age) return null;
    return "Verified, " + method + ", " + age;
  }

  function maskIdNumber(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;
    var last = text.slice(-4);
    return text.length <= 4 ? last : "..." + last;
  }

  function riskLabel(suggested, confirmed) {
    function title(value) {
      var text = String(value || "").trim().toLowerCase();
      if (!text) return "";
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    if (confirmed) return title(confirmed);
    if (suggested) return "Suggested: " + title(suggested);
    return null;
  }

  function revealNoteOk(reason, note) {
    if (!reason || reason.active === false) return false;
    var text = String(note == null ? "" : note).trim();
    if (!reason.requiresNote) return true;
    var min = Number(reason.minNoteLength);
    if (!Number.isFinite(min) || min < 1) min = 1;
    return text.length >= min;
  }

  return {
    FX_ID: FX_ID,
    LARGE_CASH: LARGE_CASH,
    CLIENT_DECLINED: CLIENT_DECLINED,
    NO_EARLIER_CHECK: NO_EARLIER_CHECK,
    HELD_NOT_COUNTED: HELD_NOT_COUNTED,
    HOLD_FOOTER: HOLD_FOOTER,
    cents: cents,
    gteMoney: gteMoney,
    isCanadaPack: isCanadaPack,
    reviewLockSeconds: reviewLockSeconds,
    purposeRequired: purposeRequired,
    fxNeedsId: fxNeedsId,
    fieldAnswer: fieldAnswer,
    occupationAnswer: occupationAnswer,
    holdCounts: holdCounts,
    holdMeterLabel: holdMeterLabel,
    NOTE_DENOMS: NOTE_DENOMS,
    addMoney: addMoney,
    countReceived: countReceived,
    addYears: addYears,
    returningDecision: returningDecision,
    formatCheckedDay: formatCheckedDay,
    idAge: idAge,
    idBadge: idBadge,
    maskIdNumber: maskIdNumber,
    riskLabel: riskLabel,
    revealNoteOk: revealNoteOk,
  };
});
