/* One price for a deal, shared by the server and the counter.

   The sheet used to multiply a mid that had already been rounded to four
   decimal places, in floating point, and on a sale it used a different
   spread from the one the ledger posts. The cashier read that figure and
   counted cash against it. This is the arithmetic the quote service
   already used: the customer rate is not rounded before the multiply, and
   the amount handed over is that product rounded half-up to the currency's
   own minor units. */
(function (root, factory) {
  var api = factory();
  /* esbuild's browser bundle defines module and calls create() itself,
     after it has put Decimal on the page. A classic script has no module,
     so it still has to find Decimal on its own. */
  var bundled = typeof module === "object" && module.exports;
  if (bundled) module.exports = api;
  /* A classic script on the uncompiled shell runs before the deferred
     quote file has put Decimal on the page. Throwing here would stop
     every script after this one. The built file creates quoteTerms. */
  if (typeof document !== "undefined" && !bundled && root.Decimal) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.quoteTerms = api.create(root.Decimal);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* Same exceptions as server/src/ledger/currencies.ts. A parity test
     locks the two lists together. Three-decimal currencies are not
     carried: the money columns hold two places. */
  var EXCEPTIONS = {
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
    PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  };

  /* Every sentence the New transaction sheet can be handed, and the
     sentence a teller should read instead. A second pass is the same
     sentence, so the preview and the request layer can both use it.
     A message that is not here returns null, and the sheet says
     "Couldn't get a price. Reload and try again." */
  var QUOTE_FALLBACK = "Couldn't get a price. Reload and try again.";
  var DESK = {
    "Quote has expired.": "Quote expired. Get a new rate.",
    "Missing quote:create.": "You do not have permission to get a quote.",
    "Missing quote:view.": "You do not have permission to view this quote.",
    "Missing quote:cancel.": "You do not have permission to cancel this quote.",
    "Missing quote:post.": "You do not have permission to post this quote.",
    "Missing rates:override.": "You do not have permission to change this rate.",
    "Missing transaction:post.": "You do not have permission to post this quote.",
    "Rate publication is stale.": "The rate board is out of date. Publish the board and try again.",
    "No published branch board.": "There is no rate board for this branch. Publish the board and try again.",
    "Currency is not published.": "That currency is not on the published board.",
    "Quote outside active scope.": "This quote is not on this till.",
    "Quote is outside the active scope.": "This quote is not on this till.",
    "Superseded quote is outside active scope.": "This quote is not on this till.",
    "Customer is not in active workspace.": "This customer is not on this till.",
    "Customer is not in the active workspace.": "This customer is not on this till.",
    "Quote not found.": "That quote is not on this desk. Get a new rate.",
    "Quote pricing did not load.": "Prices didn't load. Reload the page.",
    "invalid money": "Enter a valid amount.",
    "unsupported currency scale": "That currency is not available on this desk.",
    "out of range": "That amount is outside what this desk can quote.",
    "negative spread": "This rate cannot be quoted.",
    "direction and currencies disagree": "Choose one currency to pay and a different one to receive.",
    "Transaction direction does not match the currency pair.": "Choose one currency to pay and a different one to receive.",
    "A deal needs two different currencies.": "Choose one currency to pay and a different one to receive.",
    "invalid board terms": "The rate board cannot price this.",
    "invalid rate": "The rate board cannot price this.",
    "This deal is not priced.": "Couldn't get a price. Reload and try again.",
    "Quote already posted.": "This quote was already posted.",
    "Quote cannot be posted.": "This quote cannot be posted. Get a new rate.",
    "Only active quotes can be cancelled.": "Only an open quote can be cancelled.",
    "Only unexpired active quotes may be overridden.": "This quote cannot be changed. Get a new rate.",
    "Override reason required.": "Say why this rate is being changed.",
    "Override exceeds policy limit.": "That rate is too far from the board.",
    "Override produces a negative spread.": "That rate would pay the customer more than the board allows.",
    "Third-party name requires third-party status.": "Name the other person, or clear the third party mark.",
    "Third-party status and name must be captured together.": "Name the other person, or clear the third party mark.",
    "Authenticated principal is outside this workspace.": "This till is not open for your sign in. Reload and try again.",
    "Frozen quote terms do not match authoritative record.": "This screen is out of date. Reload to continue.",
    "A cross-currency deal must carry both frozen board mids.": "This quote is missing a rate. Reload and try again.",
    "Request is already in progress.": "Another change to this till is being recorded. Nothing was posted. Try again in a moment.",
    "The desk is recording another change to this till. Nothing was quoted — try again.": "The desk is recording another change to this till. Nothing was quoted. Try again.",
    "Insufficient till liquidity.": "The till does not have enough of that currency.",
    "Open the till before posting transactions.": "Open the till before posting.",
    "Authoritative compliance policy blocked posting.": "This desk's compliance policy will not let this be posted. Identify the customer, or capture what the rules require, and try again.",
    "This deal was not posted. A suspicion draft is saved for APML. The desk does not send it.": "This deal was not posted. A suspicion draft is saved for APML. The desk does not send it.",
    "Say whether this sale includes 50 or 100 US dollar notes.": "Say whether this sale includes 50 or 100 US dollar notes.",
    "A sale of 50 or 100 US dollar notes needs the customer's name, their JMBG or passport number, and the serial number of each note.": "A sale of 50 or 100 US dollar notes needs the customer's name, their JMBG or passport number, and the serial number of each note.",
    "This counter is airside or in a casino. Every buy and sell needs the customer's name and their JMBG or passport number.": "This counter is airside or in a casino. Every buy and sell needs the customer's name and their JMBG or passport number.",
    "This receipt needs the customer's JMBG or passport number.": "This receipt needs the customer's JMBG or passport number.",
    "Cash payment for a sale of foreign exchange must be below 50000 INR. This sale is at or above that line, so take a cheque or a bank transfer.": "Cash payment for a sale of foreign exchange must be below 50000 INR. This sale is at or above that line, so take a cheque or a bank transfer.",
    "This deal needs the customer's purpose and the source of the funds before it can be posted.": "This deal needs the customer's purpose and the source of the funds before it can be posted.",
    "This deal has no peso amount and no fresh rate, so the desk cannot test the Philippine limits. It is not posted.": "This deal has no peso amount and no fresh rate, so the desk cannot test the Philippine limits. It is not posted.",
    "This Philippines desk is not keeping its book in PHP, so the desk cannot test the Philippine limits. It is not posted.": "This Philippines desk is not keeping its book in PHP, so the desk cannot test the Philippine limits. It is not posted.",
    "A cash payout of more than 500000 PHP, or the foreign-currency equivalent, has to be a cheque or a credit to a deposit account. This payout is over that line.": "A cash payout of more than 500000 PHP, or the foreign-currency equivalent, has to be a cheque or a credit to a deposit account. This payout is over that line.",
    "This cash payout is in foreign currency and there is no fresh rate, so the desk cannot test the 500000 PHP payout limit. It is not posted.": "This cash payout is in foreign currency and there is no fresh rate, so the desk cannot test the 500000 PHP payout limit. It is not posted.",
    "A sale of foreign currency must not exceed 10000 USD, or the equivalent, in one transaction. This sale is over that line.": "A sale of foreign currency must not exceed 10000 USD, or the equivalent, in one transaction. This sale is over that line.",
    "This sale of foreign currency has no fresh US dollar rate, so the desk cannot test the 10000 USD limit. It is not posted.": "This sale of foreign currency has no fresh US dollar rate, so the desk cannot test the 10000 USD limit. It is not posted.",
    "This deal is over 500000 PHP, so it needs the customer's purpose and the source of the funds before it can be posted.": "This deal is over 500000 PHP, so it needs the customer's purpose and the source of the funds before it can be posted.",
    "This desk has no rules pack installed, so a new deal cannot be posted.": "This desk has no rules pack installed, so a new deal cannot be posted.",
    "This desk's European Union rules are incomplete, so it cannot tell whether this customer needs to be identified.": "This desk's European Union rules are incomplete, so it cannot tell whether this customer needs to be identified.",
    "This deal needs customer due diligence, so it cannot be posted without its purpose and source of funds.": "This deal needs customer due diligence, so it cannot be posted without its purpose and source of funds.",
    "This desk has no identification threshold, so it cannot tell whether this customer needs to be identified. Set one in Settings, or ask your jurisdiction pack to be installed.": "This desk has no identification threshold, so it cannot tell whether this customer needs to be identified. Set one in Settings, or ask your jurisdiction pack to be installed.",
    "This desk has no reporting threshold, so a deal cannot be posted without its purpose and source of funds. Set one in Settings, or ask your jurisdiction pack to be installed.": "This desk has no reporting threshold, so a deal cannot be posted without its purpose and source of funds. Set one in Settings, or ask your jurisdiction pack to be installed.",
    "Yen has no decimals.": "Yen has no decimals.",
    "This currency has no decimals.": "This currency has no decimals.",
    "This quote pays out nothing.": "This quote pays out nothing.",
    "Enter a valid amount.": "Enter a valid amount.",
    "That amount is outside what this desk can quote.": "That amount is outside what this desk can quote.",
    "That currency is not available on this desk.": "That currency is not available on this desk.",
    "This rate cannot be quoted.": "This rate cannot be quoted.",
    "Choose one currency to pay and a different one to receive.": "Choose one currency to pay and a different one to receive.",
    "The rate board cannot price this.": "The rate board cannot price this.",
    "The quote could not be priced.": "The quote could not be priced.",
    "This screen is out of date. Reload to continue.": "This screen is out of date. Reload to continue.",
    "You do not have permission to do that.": "You do not have permission to do that.",
    "Fill in the required field and try again.": "Fill in the required field and try again.",
    "Do this as two deals through the home currency.": "Do this as two deals through the home currency.",
    "Open the till before posting.": "Open the till before posting.",
    "The till does not have enough of that currency.": "The till does not have enough of that currency.",
    "Till movement rejected.": "The till doesn't have enough of that currency. Ask a manager to move cash in.",
    "Couldn't get a price. Reload and try again.": "Couldn't get a price. Reload and try again.",
    "Prices didn't load. Reload the page.": "Prices didn't load. Reload the page.",
  };
  (function sealDeskSentences() {
    var keys = Object.keys(DESK);
    for (var i = 0; i < keys.length; i++) {
      var spoken = DESK[keys[i]];
      if (!Object.prototype.hasOwnProperty.call(DESK, spoken)) DESK[spoken] = spoken;
    }
  })();
  function deskWording(message) {
    var text = message == null ? "" : String(message);
    if (Object.prototype.hasOwnProperty.call(DESK, text)) return DESK[text];
    if (text.indexOf("invalid ") === 0) return DESK["The rate board cannot price this."];
    if (text.indexOf("Missing ") === 0 && text.indexOf(":") > 0) return DESK["You do not have permission to do that."];
    if (text.indexOf("This desk does not trade ") === 0) return DESK["That currency is not available on this desk."];
    if (text.indexOf(" is not permitted in ") !== -1) return DESK["That currency is not available on this desk."];
    if (text.indexOf(" desks trade against ") !== -1) return DESK["Do this as two deals through the home currency."];
    if (text.indexOf(" is written to ") !== -1) return DESK["That currency is not available on this desk."];
    if (text.indexOf(" is required and must be at most 500 characters.") !== -1) return DESK["Fill in the required field and try again."];
    if (text.indexOf(" is not an amount in ") !== -1 || text.indexOf(" is not a whole number of ") !== -1) return DESK["Enter a valid amount."];
    /* "CAD uses 2 decimals. Try 12.35." is already the desk sentence.
       A second pass returns it unchanged. */
    if (/^[A-Z]{3} uses \d+ decimals\. Try [0-9]+(?:\.[0-9]+)?\.$/.test(text)) return text;
    /* The liquidity refusal names the currency the drawer is short of.
       A second pass returns that sentence unchanged. */
    if (/^The till doesn't have enough [A-Z]{3}\. Ask a manager to move cash in\.$/.test(text)) return text;
    return null;
  }

  function create(Decimal) {
    Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

    function minorUnits(code) {
      return EXCEPTIONS[String(code || "").toUpperCase()] ?? 2;
    }
    function overScaleMessage(currency, raw) {
      var code = String(currency || "").toUpperCase();
      var places = minorUnits(code);
      var out = new Decimal(raw);
      if (!out.isFinite()) return null;
      var suggestion = out.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
      return code + " uses " + places + " decimals. Try " + suggestion + ".";
    }
    function placesOf(code) {
      var places = minorUnits(code);
      if (places > 2) throw new Error("unsupported currency scale");
      return places;
    }
    function money(value, min, places, code) {
      var text = String(value);
      if (!/^(?:0|[1-9]\d{0,11})(?:\.\d+)?$/.test(text)) throw new Error("invalid money");
      var out = new Decimal(text);
      if (out.lt(min) || out.gt("1000000000")) throw new Error("out of range");
      /* A whole yen written 1000.00 still fits. 1000.50 does not, and
         neither does 12.345 dollars. The suggestion is the same half-up
         the till would have paid. */
      var fitted = out.toDecimalPlaces(places);
      if (!out.eq(fitted)) {
        var suggestion = out.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
        throw new Error(String(code || "").toUpperCase() + " uses " + places + " decimals. Try " + suggestion + ".");
      }
      return fitted;
    }
    function rateOf(value, what) {
      var out = new Decimal(value == null || value === "" ? NaN : value);
      if (!out.isFinite() || out.lte(0)) throw new Error("invalid " + what);
      return out;
    }
    function marginOf(value) {
      var out = new Decimal(value);
      if (!out.isFinite() || out.lt(0) || out.gte(1)) throw new Error("invalid board terms");
      return out;
    }
    /* The rate on the screen is four decimal places. The amount is that
       same rate times the amount, then rounded to the currency's places.
       displayRate and roundOutput share pricedRate so they cannot drift. */
    function pricedRate(rate) {
      return new Decimal(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }
    function roundOutput(amount, rate, currency) {
      return new Decimal(amount).mul(pricedRate(rate)).toDecimalPlaces(placesOf(currency), Decimal.ROUND_HALF_UP);
    }
    /* The customer receives nothing, or the fee would take the whole
       home payout. That is a refused quote, not a zero on the ticket. */
    function assertPayout(output, fee, to, home) {
      var homeCode = String(home || "CAD").toUpperCase();
      if (output.lte(0) || (String(to || "").toUpperCase() === homeCode && output.lte(fee))) {
        throw new Error("This quote pays out nothing.");
      }
    }
    /* Cash that changes hands. The fee is home-currency tender on top of
       the exchange: added when the customer pays home, subtracted when
       they receive it. The exchange output itself is unchanged. */
    function cashHands(inputAmount, outputAmount, feeAmount, from, to, home) {
      var input = new Decimal(inputAmount);
      var output = new Decimal(outputAmount);
      var fee = new Decimal(feeAmount || 0);
      var homeCode = String(home || "CAD").toUpperCase();
      from = String(from || "").toUpperCase();
      to = String(to || "").toUpperCase();
      function amountOf(value, currency) {
        return formatAmount(value, currency);
      }
      function wireOf(value, currency) {
        var places = placesOf(currency);
        return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
      }
      function side(net, currency, detail) {
        var amount = amountOf(net, currency);
        return {
          sentence: amount + " " + currency + (detail ? " (" + detail + ")" : ""),
          amount: amount,
          currency: currency,
          detail: detail,
        };
      }
      var give, receive, giveNote, receiveNote = null;
      if (from === homeCode) {
        var paid = fee.gt(0) ? amountOf(input, from) + " + " + amountOf(fee, homeCode) + " fee" : null;
        give = side(input.plus(fee), from, paid);
        receive = side(output, to, null);
        /* The customer screen keeps the total big and the fee on the
           next line, so "101.50 CAD (100.00 + 1.50 fee)" does not wrap. */
        giveNote = fee.gt(0)
          ? amountOf(input, from) + " " + from + " + " + amountOf(fee, homeCode) + " " + homeCode + " service fee"
          : null;
      } else if (to === homeCode) {
        var kept = fee.gt(0) ? amountOf(output, to) + " less " + amountOf(fee, homeCode) + " fee" : null;
        give = side(input, from, null);
        receive = side(output.minus(fee), to, kept);
        giveNote = null;
        receiveNote = fee.gt(0)
          ? amountOf(output, to) + " " + to + " less " + amountOf(fee, homeCode) + " " + homeCode + " service fee"
          : null;
      } else {
        give = side(input, from, null);
        receive = side(output, to, null);
        giveNote = null;
      }
      /* The drawer moves the net cash. The journal still keeps the
         exchange and the fee as separate lines. A cross has no home
         leg in the exchange, so the fee is its own home movement.
         The receipt keeps the gross exchange and the fee, and names
         the cash the teller hands over. */
      var payout = to === homeCode ? output.minus(fee) : output;
      var cashToCustomer = "Cash to customer " + amountOf(payout, to) + " " + to;
      var cashFromCustomer = from === homeCode && fee.gt(0)
        ? "Cash from customer " + amountOf(input.plus(fee), from) + " " + from
        : null;
      var moves = [];
      function pushMove(currency, direction, value) {
        if (!value.gt(0)) return;
        moves.push({
          currency: currency,
          direction: direction,
          amount: value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        });
      }
      if (from === homeCode) pushMove(from, "in", input.plus(fee));
      else pushMove(from, "in", input);
      if (to === homeCode) pushMove(to, "out", output.minus(fee));
      else pushMove(to, "out", output);
      if (from !== homeCode && to !== homeCode) pushMove(homeCode, "in", fee);
      var receiptCash = ["You give " + amountOf(input, from) + " " + from];
      if (giveNote) receiptCash.push(giveNote);
      if (cashFromCustomer) receiptCash.push(cashFromCustomer);
      receiptCash.push("You receive " + amountOf(output, to) + " " + to);
      if (receiveNote) receiptCash.push(receiveNote);
      receiptCash.push(cashToCustomer);
      return {
        give: give.sentence,
        giveAmount: give.amount,
        giveCurrency: give.currency,
        giveDetail: give.detail,
        giveNote: giveNote,
        receive: receive.sentence,
        receiveAmount: receive.amount,
        receiveCurrency: receive.currency,
        receiveDetail: receive.detail,
        receiveNote: receiveNote,
        receiveWire: wireOf(to === homeCode && fee.gt(0) ? output.minus(fee) : output, to),
        cashToCustomer: cashToCustomer,
        cashFromCustomer: cashFromCustomer,
        tillMoves: moves,
        receiptCash: receiptCash,
      };
    }
    function plainQuoteError(error) {
      var message = error && error.message ? String(error.message) : "";
      return deskWording(message) || QUOTE_FALLBACK;
    }
    function formatRate(value) {
      return new Decimal(value).toDecimalPlaces(12).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    }
    /* Four places. This is the rate roundOutput multiplies by. */
    function displayRate(value) {
      return pricedRate(value).toFixed(4);
    }
    function formatAmount(value, currency) {
      var places = placesOf(currency);
      var dec = new Decimal(value).toDecimalPlaces(places);
      var sign = dec.isNeg() ? "-" : "";
      var parts = dec.abs().toFixed(places).split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return sign + (parts[1] != null ? parts[0] + "." + parts[1] : parts[0]);
    }
    /* The quote row stores the customer rate at 12 decimal places. Two
       rates are the same rate when they agree there. */
    function sameRate(a, b) {
      return new Decimal(a).toDecimalPlaces(12).eq(new Decimal(b).toDecimalPlaces(12));
    }
    function lessThan(a, b) {
      return new Decimal(a).lt(new Decimal(b));
    }
    function profitShare(spreadCad, feeCad, inputCad) {
      var profit = new Decimal(spreadCad).plus(feeCad || 0);
      var basis = new Decimal(inputCad);
      return {
        profit: profit.toFixed(2),
        pct: basis.gt(0) ? profit.div(basis).mul(100).toFixed(2) : "0.00",
      };
    }

    function calculateQuoteTerms(input) {
      var home = String(input.homeCurrency || "CAD").toUpperCase();
      var from = String(input.from || "").toUpperCase();
      var to = String(input.to || "").toUpperCase();
      var homePlaces = placesOf(home);
      var amount = money(input.inputAmount, "0.01", placesOf(from), from);
      var fee = money(input.feeCad, "0", homePlaces, home);
      var margin = marginOf(input.margin);
      if (from === to) throw new Error("direction and currencies disagree");
      var shape = from === home && to !== home
        ? "customer_buy_foreign"
        : to === home && from !== home
          ? "customer_sell_foreign"
          : "customer_cross";
      if (shape !== input.direction) throw new Error("direction and currencies disagree");

      if (shape === "customer_cross") {
        var fromMid = rateOf(input.fromMid, "board terms");
        var toMid = rateOf(input.toMid, "board terms");
        var outMargin = marginOf(input.outMargin == null ? input.margin : input.outMargin);
        var inputHome = amount.mul(fromMid).toDecimalPlaces(homePlaces);
        var kept = new Decimal(1).minus(margin).mul(new Decimal(1).minus(outMargin));
        var crossRate = fromMid.div(toMid).mul(kept);
        var crossOut = roundOutput(amount, crossRate, to);
        var outputHome = crossOut.mul(toMid).toDecimalPlaces(homePlaces);
        var crossSpread = inputHome.minus(outputHome).toDecimalPlaces(homePlaces);
        if (crossSpread.lt(0)) throw new Error("negative spread");
        assertPayout(crossOut, fee, to, home);
        return {
          input: amount, fee: fee, mid: fromMid, fromMid: fromMid, toMid: toMid,
          customerRate: crossRate, outputAmount: crossOut, inputCad: inputHome,
          outputCad: outputHome, spreadCad: crossSpread, buyOrSellSide: "we_cross",
        };
      }

      var mid = rateOf(input.marketMid, "board terms");
      /* Buying foreign, the customer hands over home currency and receives
         units, so their rate is units per home. Selling, they hand over
         units and receive home currency. The rate is not rounded here. */
      var customerRate = shape === "customer_buy_foreign"
        ? new Decimal(1).div(mid).mul(new Decimal(1).minus(margin))
        : mid.mul(new Decimal(1).minus(margin));
      var outputAmount = roundOutput(amount, customerRate, to);
      var inputCad = from === home ? amount : amount.mul(mid).toDecimalPlaces(homePlaces);
      var outputCad = to === home ? outputAmount : outputAmount.mul(mid).toDecimalPlaces(homePlaces);
      var spreadCad = inputCad.minus(outputCad).toDecimalPlaces(homePlaces);
      if (spreadCad.lt(0)) throw new Error("negative spread");
      assertPayout(outputAmount, fee, to, home);
      return {
        input: amount, fee: fee, mid: mid,
        fromMid: from === home ? new Decimal(1) : mid,
        toMid: to === home ? new Decimal(1) : mid,
        customerRate: customerRate, outputAmount: outputAmount,
        inputCad: inputCad, outputCad: outputCad, spreadCad: spreadCad,
        buyOrSellSide: shape === "customer_buy_foreign" ? "we_sell" : "we_buy",
      };
    }

    function textOf(value) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
      if (typeof value === "number" && isFinite(value)) return String(value);
      return null;
    }
    function packed(terms, from, to, direction, home) {
      var hands = cashHands(terms.input, terms.outputAmount, terms.fee, from, to, home);
      return {
        state: "ok",
        direction: direction,
        from: from,
        to: to,
        side: terms.buyOrSellSide === "we_buy" ? "buy" : terms.buyOrSellSide === "we_sell" ? "sell" : "cross",
        inputWire: terms.input.toFixed(2),
        feeWire: terms.fee.toFixed(2),
        outputWire: terms.outputAmount.toFixed(2),
        customerRate: formatRate(terms.customerRate),
        rateWire: terms.customerRate.toString(),
        paysLabel: formatAmount(terms.input.toFixed(2), from),
        receivesLabel: formatAmount(terms.outputAmount.toFixed(2), to),
        rateLabel: formatRate(terms.customerRate),
        spreadCad: terms.spreadCad.toFixed(2),
        inputCad: terms.inputCad.toFixed(2),
        give: hands.give,
        giveAmount: hands.giveAmount,
        giveCurrency: hands.giveCurrency,
        giveDetail: hands.giveDetail,
        giveNote: hands.giveNote,
        receive: hands.receive,
        receiveAmount: hands.receiveAmount,
        receiveCurrency: hands.receiveCurrency,
        receiveDetail: hands.receiveDetail,
        receiveWire: hands.receiveWire,
        receiveNote: hands.receiveNote,
        cashToCustomer: hands.cashToCustomer,
        cashFromCustomer: hands.cashFromCustomer,
        tillMoves: hands.tillMoves,
        receiptCash: hands.receiptCash,
      };
    }
    function directionOf(from, to, home) {
      if (from === home && to !== home) return "customer_buy_foreign";
      if (to === home && from !== home) return "customer_sell_foreign";
      return "customer_cross";
    }
    function sideOf(direction) {
      return direction === "customer_buy_foreign" ? "sell" : direction === "customer_sell_foreign" ? "buy" : "cross";
    }
    function priceAtRate(board, spec, from, to, home, raw) {
      var direction = directionOf(from, to, home);
      var amount = money(raw, "0.01", placesOf(from), from);
      var feeText = spec.feeCad == null || String(spec.feeCad).trim() === "" ? "0" : String(spec.feeCad).trim();
      var fee = money(feeText, "0", placesOf(home), home);
      var rate = rateOf(spec.overrideRate, "rate");
      var output = roundOutput(amount, rate, to);
      var homePlaces = placesOf(home);
      var side = function (currency) {
        if (currency === home) return new Decimal(1);
        var row = board && board.rows && board.rows[currency];
        var mid = row && textOf(row.mid);
        return mid ? new Decimal(mid) : null;
      };
      var fromMid = side(from), toMid = side(to);
      var inputCad = fromMid ? amount.mul(fromMid).toDecimalPlaces(homePlaces) : amount;
      var outputCad = toMid ? output.mul(toMid).toDecimalPlaces(homePlaces) : output;
      var spread = fromMid && toMid ? inputCad.minus(outputCad).toDecimalPlaces(homePlaces) : new Decimal(0);
      if (spread.lt(0)) throw new Error("negative spread");
      assertPayout(output, fee, to, home);
      return packed({
        input: amount, fee: fee, customerRate: rate, outputAmount: output,
        spreadCad: spread, inputCad: inputCad,
        buyOrSellSide: direction === "customer_buy_foreign" ? "we_sell" : direction === "customer_sell_foreign" ? "we_buy" : "we_cross",
      }, from, to, direction, home);
    }
    function preview(board, spec) {
      var from = String(spec.from || "").toUpperCase();
      var to = String(spec.to || "").toUpperCase();
      var home = String(spec.homeCurrency || "CAD").toUpperCase();
      var raw = spec.inputAmount == null ? "" : String(spec.inputAmount).trim();
      var direction = directionOf(from, to, home);
      if (raw === "") return { state: "empty", side: sideOf(direction), direction: direction };
      try {
        if (spec.overrideRate != null && String(spec.overrideRate).trim() !== "") {
          return priceAtRate(board, spec, from, to, home, raw);
        }
        if (!board || !board.rows) return { state: "unpriced", side: sideOf(direction), direction: direction };
        var feeText = spec.feeCad == null || String(spec.feeCad).trim() === "" ? "0" : String(spec.feeCad).trim();
        var input = {
          direction: direction, from: from, to: to, inputAmount: raw, feeCad: feeText,
          homeCurrency: home, marketMid: "1", margin: "0",
        };
        if (direction === "customer_cross") {
          var fromRow = board.rows[from], toRow = board.rows[to];
          if (!fromRow || fromRow.show === false || !toRow || toRow.show === false) return { state: "unpriced", side: "cross", direction: direction };
          var fromMid = textOf(fromRow.mid), toMid = textOf(toRow.mid);
          var buy = textOf(fromRow.spread != null ? fromRow.spread : board.buyMargin);
          var sell = textOf(toRow.spread != null ? toRow.spread : board.sellMargin);
          if (!fromMid || !toMid || !buy || !sell) return { state: "unpriced", side: "cross", direction: direction };
          input.marketMid = fromMid;
          input.fromMid = fromMid;
          input.toMid = toMid;
          input.margin = buy;
          input.outMargin = sell;
        } else {
          var code = direction === "customer_buy_foreign" ? to : from;
          var row = board.rows[code];
          if (!row || row.show === false) return { state: "unpriced", side: sideOf(direction), direction: direction };
          var mid = textOf(row.mid);
          var margin = textOf(row.spread != null ? row.spread : (direction === "customer_buy_foreign" ? board.sellMargin : board.buyMargin));
          if (!mid || !margin) return { state: "unpriced", side: sideOf(direction), direction: direction };
          input.marketMid = mid;
          input.margin = margin;
        }
        return packed(calculateQuoteTerms(input), from, to, direction, home);
      } catch (error) {
        return { state: "bad", message: plainQuoteError(error) };
      }
    }

    return {
      calculateQuoteTerms: calculateQuoteTerms,
      roundOutput: roundOutput,
      cashHands: cashHands,
      overScaleMessage: overScaleMessage,
      preview: preview,
      minorUnits: minorUnits,
      formatAmount: formatAmount,
      formatRate: formatRate,
      displayRate: displayRate,
      sameRate: sameRate,
      lessThan: lessThan,
      profitShare: profitShare,
      deskWording: deskWording,
      quoteFallback: QUOTE_FALLBACK,
    };
  }
  return { create: create };
});
