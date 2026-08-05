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
        CHEQUE_NOT_FOUND: "That cheque is not on this branch's register.",
        CHEQUE_NOT_HELD: "Somebody has already cleared, returned or reversed this cheque. Reopen the register to see where it stands.",
        CHEQUE_CURRENCY_NOT_HOME: "A cheque written in another currency is an exchange as well as a cheque — quote it on the exchange path first. Nothing was posted.",
        COMPLIANCE_BLOCKED: "This desk's compliance policy will not let this be posted. Identify the customer, or capture what the rules require, and try again.",
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

  /* What the ledger's `dealKind` is called on a desk screen.
     Every server row used to be labelled "Currency Exchange" because an
     exchange was the only thing the book could hold. It holds cheque
     cashings now, and a screen that calls one an exchange is misnaming a
     deal type on the same line it prints the amount — which is how the
     compliance worksheet came to assert "Method of transaction: Cash"
     about deals that were nothing of the sort. An unrecognised kind falls
     back to the exchange label rather than rendering a raw identifier,
     because this map is the client's and the server may learn a new kind
     before this file does. */
  var DEAL_TYPE_LABEL = {
    exchange: "Currency Exchange",
    cheque_cashing: "Cheque Cashing",
  };

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
      type: DEAL_TYPE_LABEL[transaction.dealKind] || "Currency Exchange",
      /* What physically crossed the counter, carried through from the
         book. The amount columns cannot answer it: a cashed cheque reads
         CAD 1,000 in and CAD 965 out and not one dollar of cash came in.
         Read docs/CHEQUE_CASHING.md before using these to decide whether
         anything is reportable — the direction of the cash is a fact, and
         what a jurisdiction does about it is the pack's question. */
      receivedInstrument: transaction.receivedInstrument || "cash",
      disbursedInstrument: transaction.disbursedInstrument || "cash",
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
      /* ---- cheque cashing ----

         Cashing a cheque hands a customer real money out of a real
         drawer, and until now it did that entirely in the browser: a
         row pushed into an array and a cheque written to
         `cdos_cheques_v1`. The ledger never heard about the cash, and
         the desk's own "cash at risk" figure — its credit exposure —
         was totalled from a store that dies with a browser profile and
         that the second till cannot see.

         So the server is the record and `cdos_cheques_v1` is a cache of
         it, exactly as `cdos_submissions_v1` is a cache of the filed
         reports. If the server refuses, NOTHING is cashed and the
         screen says why: a cheque record the ledger does not know about
         is the defect, not the fallback.

         The amounts are the desk's; the DATES, the reference number and
         the resulting balances are the server's. A hold-until worked
         out in a browser is a client computing something load-bearing
         about money, and the reference number computed from the length
         of a local list is how two tills both minted CHQ-260618-003. */
      loadCheques: function (limit) {
        return request("/api/ledger/cheques?limit=" + (limit || 200));
      },
      cashCheque: function (payload) {
        return request("/api/ledger/cheques", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      clearCheque: function (chequeId, payload) {
        return request("/api/ledger/cheques/" + encodeURIComponent(chequeId) + "/clearance", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      /* A return and a reversal are separate calls because they are
         separate things: a return is money genuinely lost and the desk
         keeps its fee, a reversal is a cashing that should never have
         happened and the fee goes back with the cash. See the long note
         in server/src/ledger/cheques.ts. */
      returnCheque: function (chequeId, payload) {
        return request("/api/ledger/cheques/" + encodeURIComponent(chequeId) + "/return", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      reverseCheque: function (chequeId, payload) {
        return request("/api/ledger/cheques/" + encodeURIComponent(chequeId) + "/reversal", {
          method: "POST",
          body: JSON.stringify(payload),
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

      /* ---- the four lines that are cash on one side and a promise on
             the other ----

         A remittance, a bill payment and a money order all used to
         happen entirely here: the teller took the money, an array grew
         by one, and `ledger_till_balances` never heard about it. By the
         end of a day the drawer on this screen and the drawer on the
         server disagreed by whatever the shop had taken in.

         Each of these posts the money and comes back with the ledger's
         own record of it — a transaction, and the OBLIGATION the deal
         left behind. Nothing is applied optimistically: a movement that
         succeeded here and never reached the server is a loss, so the
         browser record is written only after the server has agreed.

         Read docs/OBLIGATION_LINES.md before touching any of them. The
         short version: the desk does not know what a payout will cost
         until it buys it from the corridor partner, so no margin is
         claimed at the counter and the fee is the only thing booked as
         earned. Do not send a `spreadCad` — there isn't one, and the
         server would ignore it. */
      postRemittanceSend: function (payload) {
        return request("/api/ledger/remittances/send", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      postRemittanceReceive: function (payload) {
        return request("/api/ledger/remittances/receive", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      postBillPayment: function (payload) {
        return request("/api/ledger/bill-payments", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      postMoneyOrder: function (payload) {
        return request("/api/ledger/money-orders", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },

      /* What the desk owes and what it is owed, as the book has it.
         `outstanding` is one figure per side and either of them may be
         null — a desk that has never taken a remittance has no payable
         position, and "0.00" is a claim about a book nobody has written
         in. See docs/ABSENT_FIGURES.md. */
      loadObligations: function (options) {
        var query = [];
        if (options && options.status) query.push("status=" + encodeURIComponent(options.status));
        query.push("limit=" + ((options && options.limit) || 200));
        return request("/api/ledger/obligations?" + query.join("&"));
      },

      /* The promise was honoured, for a real price — and the difference
         between that price and what the book carried is the first
         honest margin figure in the deal's life. */
      settleObligation: function (obligationId, payload) {
        return request("/api/ledger/obligations/" + encodeURIComponent(obligationId) + "/settlement", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      /* The counterparty did not perform, and the desk is out the money.
         Emphatically not the same call as the one below it: a write-off
         is a loss and a reversal is a deal that never happened, and a
         screen that offers them as one control will get them confused. */
      writeOffObligation: function (obligationId, payload) {
        return request("/api/ledger/obligations/" + encodeURIComponent(obligationId) + "/write-off", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
      reverseObligationDeal: function (transactionId, payload) {
        return request("/api/ledger/obligation-deals/" + encodeURIComponent(transactionId) + "/reversal", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
    },
  });

  /* ============================================================
     THE DESK'S CUSTOMER FILES

     Every customer file used to live in this browser, in localStorage
     under `cdos_clients_v1`, keyed BY THE CUSTOMER'S NAME. Two people
     called David Chen were one file; correcting a spelling moved the key
     and orphaned a person's history; the second till was a different
     shop; and the passport scans inside it were the largest single
     contributor to a four-megabyte ceiling that, when reached, stopped
     the desk saving ANYTHING.

     These are the routes that replace it. `desk_clients` is scoped to
     the LEGAL ENTITY, so what one counter collects every counter sees,
     at every location the business ever opens.

     Appended as its own object rather than folded into `Backend` above
     so that the two halves of this file stay separable — this is a
     different subject from posting money, and the only thing it shares
     is `request`.
     ============================================================ */
  var RISK_IN = { Low: "low", Normal: "normal", Medium: "medium", High: "high" };
  var RISK_OUT = { low: "Low", normal: "Normal", medium: "Medium", high: "High" };

  /* One server record, in the shape every screen that has not moved yet
     still reads: a flat object keyed by name, with the primary identity
     document flattened onto it as idType / idNum / idIssued / idExpiry.

     `local` is whatever that screen already had. It matters for exactly
     one field: a scan the server does not hold stays where it is, so a
     desk mid-upgrade never loses a picture. Where the server DOES hold
     it, the browser stops holding it — which is the whole point, because
     that is the byte weight that was stopping the desk saving. */
  function toDeskRecord(record, local) {
    local = local || {};
    var documents = record.documents || [];
    var primary = documents.filter(function (d) { return d.isPrimary; })[0] || null;
    var extra = documents.filter(function (d) { return !d.isPrimary; });
    var serverHasPrimaryScan = !!(primary && primary.hasScan);
    return {
      /* The stable identity. Nothing about it is derived from the name,
         which is the entire reason a rename is now safe. */
      clientId: record.clientId,
      serverBacked: true,
      kind: record.kind === "business" ? "corporate" : "individual",
      legalName: record.legalName,
      aliases: (record.aliases || []).map(function (a) { return a.alias; }),
      dob: record.dateOfBirth || "",
      email: record.email || "",
      phone: record.phone || "",
      address: record.addressLine || "",
      city: record.city || "",
      province: record.region || "",
      postal: record.postalCode || "",
      country: record.country || "",
      occupation: record.occupation || "",
      notes: record.notes || "",
      risk: RISK_OUT[record.riskRating] || "Normal",
      verificationStatus: record.verificationStatus,
      screeningOutcome: record.screeningOutcome || null,
      screeningMatched: record.screeningMatched || null,
      incorpDate: record.incorporationDate || "",
      jurisdiction: record.incorporationJurisdiction || "",
      business: record.natureOfBusiness || "",
      contactName: record.contactName || "",
      contactTitle: record.contactTitle || "",
      /* Said on every read, not only at creation: a desk with two David
         Chens should be reminded every time it opens either of them. */
      possibleDuplicate: !!record.possibleDuplicate,
      duplicateReason: record.duplicateReason || null,
      sameNameClientIds: record.sameNameClientIds || [],
      idType: primary ? primary.docType : "",
      idNum: primary ? (primary.docNumber || "") : "",
      idIssued: primary ? (primary.issuedOn || "") : "",
      idExpiry: primary ? (primary.expiresOn || "") : "",
      primaryDocumentId: primary ? primary.documentId : null,
      primaryHasScan: serverHasPrimaryScan,
      /* NOT the bytes. A covered placeholder is drawn from `hasScan`, and
         the picture arrives only from a request that records who asked. */
      photo: serverHasPrimaryScan ? null : (local.photo || null),
      hasPhotograph: !!record.photograph,
      avatar: record.photograph ? null : (local.avatar || null),
      ids: extra.map(function (d) {
        return {
          documentId: d.documentId,
          type: d.docType,
          num: d.docNumber || "",
          issued: d.issuedOn || "",
          expiry: d.expiresOn || "",
          hasScan: !!d.hasScan,
          photo: d.hasScan ? null : null,
        };
      }),
      documents: documents,
      /* Supporting documents, extra photographs and the beneficiary list
         have NOT moved and are still the browser's. Carried through
         untouched so this projection never deletes them. */
      docs: local.docs || [],
      gallery: local.gallery || [],
      ledgerCustomerId: local.ledgerCustomerId || null,
      ledgerExternalRef: local.ledgerExternalRef || null,
      createdAt: (record.createdAt || "").slice(0, 10),
      updatedAt: (record.updatedAt || "").slice(0, 10),
    };
  }

  /* The other direction: the flat fields a screen edits, as the fields
     the customer record actually has. Only what was named is sent — a
     PATCH that carried the whole record would let a stale screen quietly
     undo somebody else's edit to a field it was not even showing. */
  function fromDeskFields(patch) {
    var map = {
      kind: function (v) { return ["kind", v === "corporate" ? "business" : "individual"]; },
      dob: function (v) { return ["dateOfBirth", v || null]; },
      email: function (v) { return ["email", v]; },
      phone: function (v) { return ["phone", v]; },
      address: function (v) { return ["addressLine", v]; },
      city: function (v) { return ["city", v]; },
      province: function (v) { return ["region", v]; },
      postal: function (v) { return ["postalCode", v]; },
      country: function (v) { return ["country", v]; },
      occupation: function (v) { return ["occupation", v]; },
      notes: function (v) { return ["notes", v]; },
      risk: function (v) { return ["riskRating", RISK_IN[v] || "normal"]; },
      incorpDate: function (v) { return ["incorporationDate", v || null]; },
      jurisdiction: function (v) { return ["incorporationJurisdiction", v]; },
      business: function (v) { return ["natureOfBusiness", v]; },
      contactName: function (v) { return ["contactName", v]; },
      contactTitle: function (v) { return ["contactTitle", v]; },
      legalName: function (v) { return ["legalName", v]; },
    };
    var out = {};
    Object.keys(patch || {}).forEach(function (key) {
      if (!map[key]) return;
      var pair = map[key](patch[key]);
      out[pair[0]] = pair[1];
    });
    return out;
  }

  /* Which of the flat fields belong to the primary IDENTITY DOCUMENT
     rather than to the person. Keeping the two apart is the point of the
     whole change; this is where a screen that still edits them as one
     object gets routed to the right place. */
  var DOCUMENT_FIELDS = { idType: "docType", idNum: "docNumber", idIssued: "issuedOn", idExpiry: "expiresOn" };

  window.CDOS.Backend.Clients = {
    RISK_IN: RISK_IN,
    RISK_OUT: RISK_OUT,
    DOCUMENT_FIELDS: DOCUMENT_FIELDS,
    toDeskRecord: toDeskRecord,
    fromDeskFields: fromDeskFields,
    list: function () { return request("/api/clients"); },
    get: function (clientId) { return request("/api/clients/" + encodeURIComponent(clientId)); },
    /* More than one answer is a legitimate answer: two people share a
       name, and the caller chooses rather than this picking one and
       being quietly wrong about somebody's compliance history. */
    lookup: function (name) { return request("/api/clients/lookup?name=" + encodeURIComponent(name)); },
    create: function (input) {
      return request("/api/clients", { method: "POST", body: JSON.stringify(input) });
    },
    update: function (clientId, changes) {
      return request("/api/clients/" + encodeURIComponent(clientId), {
        method: "PATCH", body: JSON.stringify(changes),
      });
    },
    addAlias: function (clientId, alias) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/aliases", {
        method: "POST", body: JSON.stringify({ alias: alias }),
      });
    },
    addDocument: function (clientId, input) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/documents", {
        method: "POST", body: JSON.stringify(input),
      });
    },
    updateDocument: function (clientId, documentId, input) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/documents/" + encodeURIComponent(documentId), {
        method: "PATCH", body: JSON.stringify(input),
      });
    },
    removeDocument: function (clientId, documentId) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/documents/" + encodeURIComponent(documentId), {
        method: "DELETE",
      });
    },
    /* THE AUDITED REVEAL. The only way to the bytes of an identity
       document, and it writes "who looked at this customer's passport,
       and when" in the same transaction that hands them over. A POST
       rather than a GET on purpose: a GET is what a cache repeats. */
    revealDocument: function (clientId, documentId, purpose) {
      return request(
        "/api/clients/" + encodeURIComponent(clientId) + "/documents/" + encodeURIComponent(documentId) + "/reveal",
        { method: "POST", body: JSON.stringify(purpose ? { purpose: purpose } : {}) });
    },
    /* Take the picture off the file, keeping the document. Its own call
       because it is its own act — the desk still holds the number and
       the expiry, it no longer holds the photograph of the page — and it
       is audited for the same reason a reveal is. */
    removeDocumentScan: function (clientId, documentId) {
      return request(
        "/api/clients/" + encodeURIComponent(clientId) + "/documents/" + encodeURIComponent(documentId) + "/scan",
        { method: "DELETE" });
    },
    disclosures: function (clientId, limit) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/disclosures?limit=" + (limit || 100));
    },
    setPhotograph: function (clientId, dataUrl) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/photograph", {
        method: "PUT", body: JSON.stringify({ dataUrl: dataUrl }),
      });
    },
    photograph: function (clientId) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/photograph");
    },
    /* This person, as the till's own counter record — the `customerId`
       the posting path wants. The join between the desk's file and the
       ledger's row, made explicit so no caller has to guess it. */
    counterRecord: function (clientId) {
      return request("/api/clients/" + encodeURIComponent(clientId) + "/counter-record", {
        method: "POST", body: "{}",
      });
    },
  };
})();
