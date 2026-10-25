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
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var BOOKING_ERROR_REASON = "booking error, cash not received";
  var LEFT_OUT_LINE = "left out: booking error, cash not received";

  function isBookingErrorReason(reason) {
    return String(reason == null ? "" : reason).trim().toLowerCase() === BOOKING_ERROR_REASON;
  }

  /* Null is no reversal. Any other reason still counts as cash received. */
  function countsTowardLctr(reason) {
    return !isBookingErrorReason(reason);
  }

  return {
    BOOKING_ERROR_REASON: BOOKING_ERROR_REASON,
    LEFT_OUT_LINE: LEFT_OUT_LINE,
    isBookingErrorReason: isBookingErrorReason,
    countsTowardLctr: countsTowardLctr,
  };
});
