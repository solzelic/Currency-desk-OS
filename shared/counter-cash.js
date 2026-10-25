/* What actually crossed the counter, in cash.

   One file for the desk and the server. The shell loads it before
   os-src/cdos-base.jsx. server/src/ledger/reporting.ts requires it
   for the till summary. Neither side keeps a second copy of the rule.

   Each leg is judged on its own. After trim and lower case, the leg
   counts as 0 only when the instrument is in NOT_CASH. Anything else
   counts the full amount: cash in any spelling, a blank, a missing
   value, or a word this list does not name. The type table stays so
   the desk and the server share the deal labels. It does not decide
   the cash.

   The type names are the desk's own labels, including the two
   remittance labels, so they match TYPES in cdos-base.jsx. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    root.CDOS = root.CDOS || {};
    root.CDOS.COUNTER_CASH = api.BY_TYPE;
    root.CDOS.cashLegs = api.cashLegs;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var BY_TYPE = {
    "Currency Exchange": { in: true, out: true },
    "Remittance — Send": { in: true, out: false },
    "Remittance — Receive": { in: false, out: true },
    "Cheque Cashing": { in: false, out: true },
    "Money Order": { in: true, out: false },
    "Bill Payment": { in: true, out: false },
  };
  var BY_KIND = {
    exchange: { in: true, out: true },
    cheque_cashing: { in: false, out: true },
    remittance_send: { in: true, out: false },
    remittance_receive: { in: false, out: true },
    bill_payment: { in: true, out: false },
    money_order: { in: true, out: false },
  };

  /* One map for cash in and cash out. After trim and lower case, a
     leg counts as 0 only when the name is a key. The value is the
     stored name from migration 018, or the name itself when the book
     has no shorter form. eft and wire are electronic_funds_transfer.
     draft is cheque. cash, none, a blank, a missing value, and any
     other word count the full amount. */
  var NOT_CASH = {
    cheque: "cheque",
    electronic_funds_transfer: "electronic_funds_transfer",
    bank_credit: "bank_credit",
    money_order: "money_order",
    bill_credit: "bill_credit",
    eft: "electronic_funds_transfer",
    wire: "electronic_funds_transfer",
    draft: "cheque",
    card: "card",
    virtual_currency: "virtual_currency",
  };

  function namedCash(value) {
    if (value == null) return true;
    var text = String(value).trim().toLowerCase();
    if (!text) return true;
    return NOT_CASH[text] == null;
  }

  function first(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (row[keys[i]] != null && row[keys[i]] !== "") return row[keys[i]];
    }
    return undefined;
  }

  /* `{ in, out }`, each `{ amount, ccy }` or null. Amount is the
     value the row already carried, so the server can add it as a
     decimal string. */
  function cashLegs(row) {
    if (!row) return { in: null, out: null };
    var inCash = namedCash(first(row, ["receivedInstrument", "received_instrument"]));
    var outCash = namedCash(first(row, ["disbursedInstrument", "disbursed_instrument"]));
    return {
      in: inCash ? {
        amount: first(row, ["inAmt", "input_amount", "inputAmount"]) ?? 0,
        ccy: first(row, ["inCcy", "from_currency", "fromCurrency"]),
      } : null,
      out: outCash ? {
        amount: first(row, ["outAmt", "output_amount", "outputAmount"]) ?? 0,
        ccy: first(row, ["outCcy", "to_currency", "toCurrency"]),
      } : null,
    };
  }

  return { BY_TYPE: BY_TYPE, BY_KIND: BY_KIND, cashLegs: cashLegs };
});
