(function () {
  "use strict";

  function asMoney(value) {
    var number = Number(value || 0);
    return number.toFixed(2);
  }

  async function request(path, options) {
    var response;
    try {
      response = await fetch(path, Object.assign({
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      }, options || {}));
    } catch (cause) {
      var networkError = new Error("CurrencyDesk could not reach the ledger server. Nothing was posted.");
      networkError.code = "NETWORK_ERROR";
      networkError.cause = cause;
      throw networkError;
    }

    var body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      var error = new Error(body.message || ({
        AUTHENTICATION_REQUIRED: "Your session expired. Sign in again before posting.",
        PLAN_NOT_ENTITLED: "This workspace plan does not include server ledger posting.",
        SCOPE_DENIED: "The active workspace is not authorized for this account.",
        UNSUPPORTED_CURRENCY_PAIR: "Server posting currently supports CAD exchanges with USD, EUR, or GBP.",
        QUOTE_EXPIRED: "The frozen quote expired. Request a new quote and confirm it again.",
        INSUFFICIENT_TILL_LIQUIDITY: "The till does not have enough currency to complete this exchange.",
        REVERSAL_NOT_ALLOWED: "The till cannot support this reversal. Reconcile the affected currency before trying again.",
        REVERSAL_ALREADY_EXISTS: "This transaction has already been reversed.",
      })[body.code] || "The ledger server rejected this request. Nothing was posted.");
      error.code = body.code || "REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function customerPayload(name, record) {
    record = record || {};
    var riskText = String(record.risk || record.riskRating || "").toLowerCase();
    var risk = riskText.indexOf("high") >= 0 ? "high"
      : (riskText.indexOf("medium") >= 0 || riskText.indexOf("enhanced") >= 0) ? "enhanced"
      : "normal";
    var idStatus = !record.idType || !record.idNum ? "missing"
      : record.idExpiry && record.idExpiry < new Date().toISOString().slice(0, 10) ? "expired"
      : "verified";
    var externalRef = record.ledgerExternalRef || ("os:" + String(name).trim().toLowerCase().replace(/\s+/g, "-"));
    return { externalRef: externalRef, name: String(name).trim(), risk: risk, idStatus: idStatus };
  }

  async function syncCustomer(name, record) {
    var payload = customerPayload(name, record);
    return request("/api/ledger/customers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function transactionToRow(transaction, customerName, compliance) {
    var posted = new Date(transaction.postedAt);
    var reversal = transaction.reversal || null;
    compliance = compliance || {};
    return {
      id: "srv_" + transaction.transactionId,
      serverTransactionId: transaction.transactionId,
      serverQuoteId: transaction.quoteId || null,
      ref: transaction.transactionRef,
      date: posted.toISOString().slice(0, 10),
      time: posted.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false }),
      customer: customerName || transaction.customerId,
      beneficiary: "",
      type: "Currency Exchange",
      inCcy: transaction.from,
      inAmt: Number(transaction.inputAmount),
      rate: Number(transaction.rate),
      outCcy: transaction.to,
      outAmt: Number(transaction.outputAmount),
      fee: Number(transaction.feeCad),
      midRate: transaction.marketMid == null ? null : Number(transaction.marketMid),
      spreadCad: Number(transaction.spreadCad || 0),
      side: transaction.from === "CAD" ? "sell" : "buy",
      quoteRef: transaction.quoteId || null,
      rateBoardPublicationId: transaction.rateBoardPublicationId || null,
      marketSnapshotId: transaction.marketSnapshotId || null,
      rateSourceType: transaction.rateSourceType || null,
      quoteOverrideId: transaction.quoteOverrideId || null,
      capture: {
        purpose: transaction.purpose || compliance.purpose || "",
        source: transaction.sourceOfFunds || compliance.sourceOfFunds || "",
        thirdParty: false,
        thirdPartyName: "",
      },
      notes: transaction.purpose || compliance.purpose || "",
      teller: transaction.actorId || "",
      createdBy: transaction.actorId || "",
      createdAt: transaction.postedAt,
      status: reversal ? "void" : "posted",
      voidReason: reversal ? reversal.reason : "",
      voidBy: "",
      voidAt: reversal ? reversal.postedAt : "",
      thread: [],
      filed: false,
      filedInfo: null,
      ackStr: false,
      ackStrInfo: null,
      tagged: false,
      tagInfo: null,
    };
  }

  async function loadLedger() {
    var results = await Promise.all([
      request("/api/ledger/customers"),
      request("/api/ledger/transactions?limit=100"),
    ]);
    var names = {};
    (results[0].customers || []).forEach(function (customer) {
      names[customer.customerId] = customer.name;
    });
    return (results[1].transactions || []).map(function (transaction) {
      return transactionToRow(transaction, names[transaction.customerId]);
    });
  }

  function mergeRows(existing, serverRows) {
    var ids = new Set((serverRows || []).map(function (row) { return row.serverTransactionId; }));
    return (serverRows || []).concat((existing || []).filter(function (row) {
      return !row.serverTransactionId || !ids.has(row.serverTransactionId);
    }));
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    Backend: {
      request: request,
      customerPayload: customerPayload,
      syncCustomer: syncCustomer,
      createQuote: function (payload) {
        return request("/api/quotes", { method: "POST", body: JSON.stringify(payload) });
      },
      overrideQuote: function (quoteId, payload) {
        return request("/api/quotes/" + encodeURIComponent(quoteId) + "/override", { method: "POST", body: JSON.stringify(payload) });
      },
      postQuote: function (quoteId, payload) {
        return request("/api/quotes/" + encodeURIComponent(quoteId) + "/post", { method: "POST", body: JSON.stringify(payload) });
      },
      reverseTransaction: function (transactionId, payload) {
        return request("/api/ledger/transactions/" + encodeURIComponent(transactionId) + "/reversal", { method: "POST", body: JSON.stringify(payload) });
      },
      transactionToRow: transactionToRow,
      loadLedger: loadLedger,
      mergeRows: mergeRows,
      asMoney: asMoney,
    },
  });
})();
