/* The closed-day next step, and the line that the closed day is unchanged.
   Defined once.

   server/src/ledger/cheques.ts requires this and puts the sentences
   on the 422. The desk prints those fields. It does not keep a copy.

   A return, including Return NSF and Flag fraud, posts with
   transaction:post. A teller holds that. A reversal posts with
   transaction:reverse, which starts at supervisor. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.chequeDayClosedNext = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return {
    reversal:
      "Open a new session on the till that paid this cheque out. A supervisor or manager then posts the reversal there.",
    returned:
      "Open a new session on the till that paid this cheque out. Then post the return there.",
    stays: "The closed day stays as it was.",
  };
});
