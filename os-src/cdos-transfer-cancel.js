/* Cancel a transfer that took cash. Phone PR #113 calls this.
   The contract is docs/TRANSFER_CANCEL.md. */
(function () {
  "use strict";

  var TELLER_MESSAGE = "Only a manager can cancel a transfer that took cash. Ask a manager to cancel.";
  var PAID_OUT_MESSAGE = "This transfer was already paid out. It cannot be cancelled.";
  var RECEIVE_MESSAGE = "A received transfer can't be cancelled here. Ask a manager.";

  /* OS names of the roles that already hold transaction:reverse.
     Cashier and Trainee do not. This does not grant anything. */
  var CAN_POST = { Owner: true, Manager: true, "Senior teller": true };

  function placesOf(currency) {
    var fn = window.CDOS && window.CDOS.currencyPlaces;
    if (typeof fn !== "function") return 2;
    return fn(currency) === 0 ? 0 : 2;
  }

  /* places is 0 for a currency such as JPY. Everything else on this
     sheet is two decimals, which is what the ledger stored. */
  function money(amount, places) {
    var text = String(amount == null ? "" : amount).trim();
    var match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error("The ledger did not return a cash figure.");
    var digits = places === 0 ? 0 : 2;
    var whole = match[2];
    if (digits === 0) {
      var frac = match[3] || "";
      if (frac.charAt(0) >= "5") whole = String(Number(whole) + 1);
      whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return match[1] + whole;
    }
    var pennies = (match[3] || "00").slice(0, 2);
    while (pennies.length < 2) pennies += "0";
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return match[1] + whole + "." + pennies;
  }

  function positive(amount) {
    var text = String(amount == null ? "" : amount).trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return false;
    return Number(text) > 0;
  }

  /* What the confirm sheet is allowed to say. The figures are the
     obligation row the server returned. This function does not add
     the fee, and it does not price the corridor. */
  function review(obligation) {
    if (!obligation) {
      return { kind: "missing", message: "This transfer is not on the ledger. Nothing was cancelled." };
    }
    if (obligation.paidOutAt || obligation.status === "settled") {
      return { kind: "refused", message: PAID_OUT_MESSAGE };
    }
    if (obligation.status === "reversed") {
      return { kind: "already", message: "This transfer is already cancelled." };
    }
    if (obligation.dealKind === "remittance_receive") {
      return { kind: "refused", message: RECEIVE_MESSAGE };
    }
    if (obligation.status !== "open") {
      return { kind: "refused", message: "This transfer cannot be cancelled." };
    }
    var inbound = positive(obligation.cashInHome);
    var cash = inbound ? obligation.cashInHome : obligation.cashOutHome;
    var home = money(cash, placesOf(obligation.homeCurrency)) + " " + obligation.homeCurrency;
    var face = money(obligation.faceAmount, placesOf(obligation.faceCurrency)) + " " + obligation.faceCurrency;
    var partner = obligation.counterparty;
    var sentence = inbound
      ? "This gives the customer back " + home + " from your drawer and cancels the " + face + " owed to " + partner + "."
      : "This puts " + home + " back in your drawer and cancels the " + face + " " + partner + " owes this desk.";
    return { kind: "confirm", sentence: sentence };
  }

  function idempotencyKey(transactionId) {
    return "web:transfer-cancel:" + transactionId;
  }

  function paidOutKey(transactionId) {
    return "web:transfer-paid:" + transactionId;
  }

  function postOnce(call) {
    return call().catch(function (error) {
      if (!error || error.code !== "IDEMPOTENCY_IN_PROGRESS") throw error;
      return call();
    });
  }

  function postCancel(transactionId) {
    var backend = window.CDOS && window.CDOS.Backend;
    if (!backend || typeof backend.reverseObligationDeal !== "function") {
      return Promise.reject(new Error("The ledger client is not loaded. Nothing was cancelled."));
    }
    var payload = { idempotencyKey: idempotencyKey(transactionId), reason: "Cancelled at the counter" };
    return postOnce(function () { return backend.reverseObligationDeal(transactionId, payload); });
  }

  function postPaidOut(transactionId) {
    var backend = window.CDOS && window.CDOS.Backend;
    if (!backend || typeof backend.markTransferPaidOut !== "function") {
      return Promise.reject(new Error("The ledger client is not loaded. The payout was not recorded."));
    }
    var payload = { idempotencyKey: paidOutKey(transactionId) };
    return postOnce(function () { return backend.markTransferPaidOut(transactionId, payload); });
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    transferCancel: {
      TELLER_MESSAGE: TELLER_MESSAGE,
      PAID_OUT_MESSAGE: PAID_OUT_MESSAGE,
      RECEIVE_MESSAGE: RECEIVE_MESSAGE,
      canPost: function (role) { return !!CAN_POST[role]; },
      review: review,
      idempotencyKey: idempotencyKey,
      paidOutKey: paidOutKey,
      postCancel: postCancel,
      postPaidOut: postPaidOut,
    },
  });
})();
