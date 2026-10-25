/* A reversal leaves the cash in the LCTR total.
   The one exception is a booking error: no cash was received.
   Only a role with transaction:reverse may record that reason.
   The server requires this file. The desk shell loads it too. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.lctrReversal = api;
    /* A missing rule cannot prove the booking-error exception, so the reversal stays in the total. */
    cdos.countsForLctr = function (row) {
      var rule = cdos.lctrReversal;
      if (!rule || typeof rule.countsTowardLctr !== "function") return true;
      return !row || row.status !== "void" || !!rule.countsTowardLctr(row.voidReason);
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var BOOKING_ERROR_REASON = "booking error, cash not received";
  var LEFT_OUT_LINE = "left out: booking error, cash not received";
  var IN_REPORT_MESSAGE = "This deal is already in a report. Ask your compliance officer.";

  function isBookingErrorReason(reason) {
    return String(reason == null ? "" : reason).trim().toLowerCase() === BOOKING_ERROR_REASON;
  }

  function countsTowardLctr(reason) {
    return !isBookingErrorReason(reason);
  }

  function reversedTag(row) {
    if (!row || row.status !== "void" || !countsTowardLctr(row.voidReason)) return "";
    return "reversed";
  }

  function staffDisplayName(actorId, people, actorName) {
    var named = String(actorName == null ? "" : actorName).trim();
    if (named) return named;
    var id = String(actorId == null ? "" : actorId);
    var list = people || [];
    for (var i = 0; i < list.length; i++) {
      var person = list[i];
      if (!person) continue;
      if (person.code !== id && person.id !== id) continue;
      var name = String(person.name || "").trim();
      if (name) return name;
    }
    return "";
  }

  function setByLine(name, clock) {
    return "Set by " + String(name || "").trim() + ", " + String(clock || "").trim() + ".";
  }

  return {
    BOOKING_ERROR_REASON: BOOKING_ERROR_REASON,
    LEFT_OUT_LINE: LEFT_OUT_LINE,
    IN_REPORT_MESSAGE: IN_REPORT_MESSAGE,
    isBookingErrorReason: isBookingErrorReason,
    countsTowardLctr: countsTowardLctr,
    reversedTag: reversedTag,
    staffDisplayName: staffDisplayName,
    setByLine: setByLine,
  };
});
