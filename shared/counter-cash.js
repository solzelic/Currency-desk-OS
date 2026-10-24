/* What actually crossed the counter, in cash.

   One file for the desk and the server. The shell loads it before
   os-src/cdos-base.jsx. server/src/ledger/reporting.ts requires it
   for the till summary. Neither side keeps a second copy of the rule.

   A named instrument wins for that leg. Only "cash" counts. A blank
   instrument falls through to the deal type, then the deal kind.
   Anything still unnamed counts as cash both ways: the failure this
   table prevents is over-reporting, and an unknown row should stay
   visible rather than disappear.

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

  function namedCash(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;
    return text === "cash";
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
    var typeRule = BY_TYPE[row.type];
    var kindRule = BY_KIND[row.dealKind || row.deal_kind];
    var rule = typeRule || kindRule || { in: true, out: true };
    var inNamed = namedCash(first(row, ["receivedInstrument", "received_instrument"]));
    var outNamed = namedCash(first(row, ["disbursedInstrument", "disbursed_instrument"]));
    var inCash = inNamed === null ? rule.in : inNamed;
    var outCash = outNamed === null ? rule.out : outNamed;
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
