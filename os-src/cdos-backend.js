(function () {
  "use strict";

  function asMoney(value) {
    var number = Number(value || 0);
    return number.toFixed(2);
  }

  /* Which till the server should answer for. Every ledger and quote route reads
     it from x-workspace-id and, when the header is missing, falls back to "the
     branch's only workspace" — which worked only because every branch had one.
     The browser never sent it, so a desk with two tills would have had the
     server answer for whichever workspace it liked (or refuse outright), while
     the Cash Drawer header said something else entirely. The OS sets this once
     it has asked the server what tills this branch has. */
  var activeWorkspaceId = null;
  function setWorkspace(id) { activeWorkspaceId = id || null; }
  function getWorkspace() { return activeWorkspaceId; }

  async function request(path, options) {
    var response;
    /* Object.assign is shallow: a caller passing its own headers used to REPLACE
       the default object wholesale, so merging the two here is what keeps
       content-type on every POST that also needs the workspace header. */
    var init = Object.assign({ credentials: "same-origin" }, options || {});
    init.headers = Object.assign({ "content-type": "application/json" }, (options && options.headers) || {});
    if (activeWorkspaceId) init.headers["x-workspace-id"] = activeWorkspaceId;
    try {
      response = await fetch(path, init);
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
        TILL_NOT_OPEN: "Open the till before posting or recording cash activity.",
        TILL_ALREADY_CLOSED: "This till session is already closed.",
        INCOMPLETE_TILL_COUNT: "Count every server-backed currency before closing the till.",
        TILL_SESSION_NOT_FOUND: "That till session no longer exists on the server. Reload the drawer.",
        INSUFFICIENT_VAULT_LIQUIDITY: "The vault does not hold that much — the movement was refused and nothing moved.",
        VAULT_NOT_INITIALIZED: "This vault has no opening position on the ledger yet. Record what is in the safe before moving cash through it.",
        VAULT_ALREADY_INITIALIZED: "This vault already has an opening position. Change it with a recorded movement, not by restating it.",
        TILL_ALREADY_ACTIVE: "This till already has an open session.",
        IDEMPOTENCY_CONFLICT: "That till operation was already recorded.",
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
        thirdParty: transaction.thirdParty == null ? !!compliance.thirdParty : !!transaction.thirdParty,
        thirdPartyName: transaction.thirdPartyName || compliance.thirdPartyName || "",
        by: transaction.complianceCapturedBy || transaction.actorId || "",
        at: transaction.complianceCapturedAt || transaction.postedAt,
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
      setWorkspace: setWorkspace,
      getWorkspace: getWorkspace,
      // the tills this session's branch has on the ledger, as the server names
      // them — the desk's own branch records cannot answer this
      loadWorkspaces: function () {
        return request("/api/ledger/workspaces");
      },
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
      loadTillBalances: function () {
        return request("/api/ledger/till-balances");
      },
      loadTillSession: function () {
        return request("/api/ledger/till-session");
      },
      /* The drawer always wants both halves of the same picture — what the
         server says the till holds, and which session that holding sits in.
         Fetching them separately let one arrive without the other and the
         screen rendered a balance with no session to post it against. */
      loadTill: function () {
        return Promise.all([
          request("/api/ledger/till-balances"),
          request("/api/ledger/till-session"),
        ]).then(function (results) {
          return {
            tillId: results[0].tillId || null,
            balances: results[0].balances || {},
            session: results[1].session || null,
            latestCounts: results[1].latestCounts || {},
          };
        });
      },
      openTillSession: function () {
        return request("/api/ledger/till-sessions/open", {
          method: "POST",
          body: "{}",
        });
      },
      saveTillCount: function (payload) {
        return request("/api/ledger/till-counts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      closeTillSession: function (sessionId, payload) {
        return request("/api/ledger/till-sessions/" + encodeURIComponent(sessionId) + "/close", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      moveTillCash: function (payload) {
        return request("/api/ledger/till-movements", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      /* ---- the vault: the branch's strong room, on the ledger ---- */
      loadVault: function () {
        return request("/api/ledger/vault");
      },
      openVaultPosition: function (balances) {
        return request("/api/ledger/vault/opening-position", {
          method: "POST",
          body: JSON.stringify({ balances: balances }),
        });
      },
      receiveVaultCash: function (payload) {
        return request("/api/ledger/vault/receipts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      runVaultCash: function (payload) {
        return request("/api/ledger/vault/runs", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      loadVaultMovements: function (limit) {
        return request("/api/ledger/vault/movements?limit=" + (limit || 100));
      },
      getTransactionReceipt: function (transactionId) {
        return request("/api/ledger/transactions/" + encodeURIComponent(transactionId) + "/receipt");
      },
      mergeRows: mergeRows,
      asMoney: asMoney,
    },
  });
})();
