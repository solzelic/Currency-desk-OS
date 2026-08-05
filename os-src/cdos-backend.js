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
    /* The active till is a DEFAULT here, not an override: a caller that names
       x-workspace-id itself wins. Only one call does, and it is the one that
       switches tills — it has to reach the target workspace while the screen,
       and therefore every other request in flight, still belongs to the one
       being left. Applying the module's id last would have made that call
       impossible to express, and the alternative (flip the module id, then
       ask) is the defect this fixes: for the length of one round trip the
       header would name a till the screen had not moved to yet. */
    init.headers = Object.assign(
      { "content-type": "application/json" },
      activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : null,
      (options && options.headers) || {});
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
        LEDGER_BUSY: "Another change to this till is being recorded. Nothing was posted — try again in a moment.",
        OBLIGATION_ALREADY_FILED: "This report has already been sealed on the ledger. A correction is filed as a new report linked to the original — the sealed copy is never replaced.",
        REPORT_NOT_IN_PACK: "Your jurisdiction pack has no such report, so this desk cannot file one.",
        FILING_NOT_FOUND: "That filed report is not on this desk's record.",
        REVERSAL_NOT_ALLOWED: "The till cannot support this reversal. Reconcile the affected currency before trying again.",
        REVERSAL_ALREADY_EXISTS: "This transaction has already been reversed.",
      })[body.code] || "The ledger server rejected this request. Nothing was posted.");
      error.code = body.code || "REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return body;
  }

  /* WHO IS ON A TILL, ACCORDING TO THE BOOK — or nobody at all.

     Both till switchers used to answer this from a roster compiled into the
     browser ("Till 2 — Express · M. Costa on now") for drawers that had never
     held a session, naming a person the ledger has never heard of. So the only
     answer either of them may render comes from here: the actor on the till's
     latest session, and only while that session is open. Anything else — no
     session, a closed one, a session with no actor — is the empty string, and
     the screen is expected to show nothing rather than guess. */
  function tillOccupant(session) {
    if (!session || session.status !== "open") return "";
    return String(session.openedBy || "").split(":").pop() || "";
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
      // them — the desk's own branch records cannot answer this. The roster
      // adds who is on each drawer; the desk used to answer that from a demo
      // roster and named a person the ledger has never heard of.
      loadWorkspaces: function () {
        return request("/api/ledger/till-roster");
      },
      /* Move the operator to another till.
         The target is named on THIS request only — `activeWorkspaceId` is
         deliberately left alone until the server has agreed, so there is no
         moment when the id the desk is sending and the till the screen shows
         are different tills. The caller commits with setWorkspace(id) on the
         resolved response, which also carries that till's session and
         balances so the new name and the new money land together. */
      selectWorkspace: function (workspaceId) {
        return request("/api/ledger/till-selection", {
          method: "POST",
          headers: { "x-workspace-id": workspaceId },
          body: "{}",
        });
      },
      tillOccupant: tillOccupant,
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
      /* ---- how the desk costs what it sells ---- */
      loadCostMethod: function () {
        return request("/api/ledger/cost-method");
      },
      /* "weighted_average", "fifo", or "pack_default" to follow the jurisdiction. */
      setCostMethod: function (method) {
        return request("/api/ledger/cost-method", {
          method: "PUT",
          body: JSON.stringify({ method: method }),
        });
      },
      mergeRows: mergeRows,
      asMoney: asMoney,
      /* ---- filed regulatory reports ----

         The sealed five-year copy of a report used to live in localStorage,
         which is a place a compliance record cannot live: it dies with the
         browser profile, the second till holds a different set of filings
         from the first, and the store is bounded — a busy desk eventually
         writes one filing more than fits and the quota error lands in a
         swallowed catch while the screen says "sealed". These make the
         ledger the record and the browser a cache of it. */
      loadReportFilings: function (limit) {
        return request("/api/ledger/report-filings?limit=" + (limit || 200));
      },
      /* One filing WITH its payload — every field as submitted. The list
         above leaves the payload out because a sealed worksheet is tens of
         kilobytes and the Filings screen renders one line per report. */
      loadReportFiling: function (filingId) {
        return request("/api/ledger/report-filings/" + encodeURIComponent(filingId));
      },
      /* Seal a filing. There is no update and no delete beside this: the
         database refuses to change a filed row, and a correction is a new
         filing carrying `amendsFilingId`. */
      fileReport: function (payload) {
        return request("/api/ledger/report-filings", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },

      /* ---- what the desk earned, and what it is holding ----

         Every summary screen used to answer these for itself, in the
         browser, off a demo seed: the Dashboard announced 38 deals and
         $130,566 of volume for a desk that had done one $1,000 trade, and
         the FX exposure panel had it SHORT the euros it was long. Nothing
         disagreed, because nothing else was asking.

         Read docs/ABSENT_FIGURES.md before rendering any of this. Every
         money field can be null and null is not zero — it means the ledger
         has no answer, and the screen owes the reader a "—" and a reason
         rather than a confident total. */

      /* Totals over a window. `from` and `to` are ISO instants and BOTH
         are optional; omitting them means "everything this till has ever
         posted", which is the only window that needs no timezone to be
         right. The server deliberately does not decide where a day starts
         — see businessDayWindow() in cdos-base.jsx, which builds the
         window from the till session's own business date. */
      loadLedgerSummary: function (window) {
        var query = [];
        if (window && window.from) query.push("from=" + encodeURIComponent(window.from));
        if (window && window.to) query.push("to=" + encodeURIComponent(window.to));
        return request("/api/ledger/summary" + (query.length ? "?" + query.join("&") : ""));
      },

      /* What this branch physically holds, till and vault together, with
         cost basis and — only where both halves are genuinely known —
         unrealized P&L. This is the answer to "are we long or short",
         which the Dashboard was previously deriving from the net of the
         day's deals: a completely different question with a plausible
         enough answer that nobody noticed. */
      loadLedgerPosition: function () {
        return request("/api/ledger/position");
      },

      /* The rules this desk trades under — home currency, the regulator's
         report name, the reporting and identification thresholds. One
         source for a number the browser used to hardcode as 10,000
         Canadian dollars in one place and read from settings in another. */
      loadJurisdiction: function () {
        return request("/api/ledger/jurisdiction");
      },

      /* ---- the desk's own thresholds ----

         The pack states what the regulator requires; these are what the
         desk actually operates at, which it may tighten at any time and
         not only at sign-up. They live on the ledger because the POSTING
         path enforces the identification line — a number the server
         cannot see is a number the server cannot enforce, and it used to
         be a hardcoded 3,000 for every desk on earth.

         Each line comes back as { effective, deskChoice, packValue,
         posture }: what the desk operates at, what it chose, what its
         regulator requires, and where the first stands against the last.
         `posture` is "following" while the desk has chosen nothing,
         "stricter" where it asks more of itself than the law does — which
         is a legitimate decision and not a fault — and "looser" where it
         is failing to report what it is obliged to report. */
      loadDeskThresholds: function () {
        return request("/api/ledger/desk-thresholds");
      },
      /* A partial change: name only the lines you are moving. Amounts are
         decimal strings, windows and years are whole numbers, and the
         string "pack_default" hands a line back to the jurisdiction. */
      setDeskThresholds: function (changes) {
        return request("/api/ledger/desk-thresholds", {
          method: "PUT",
          body: JSON.stringify(changes),
        });
      },
    },
  });
})();
