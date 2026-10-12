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

  function create(Decimal) {
    Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

    function minorUnits(code) {
      return EXCEPTIONS[String(code || "").toUpperCase()] ?? 2;
    }
    function placesOf(code) {
      var places = minorUnits(code);
      if (places > 2) throw new Error("unsupported currency scale");
      return places;
    }
    function money(value, min, places) {
      if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(String(value))) throw new Error("invalid money");
      var out = new Decimal(value);
      if (out.lt(min) || out.gt("1000000000")) throw new Error("out of range");
      if (!out.eq(out.toDecimalPlaces(places))) throw new Error("invalid money");
      return out.toDecimalPlaces(places);
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
    function roundOutput(amount, rate, currency) {
      return new Decimal(amount).mul(rate).toDecimalPlaces(placesOf(currency));
    }
    function formatRate(value) {
      return new Decimal(value).toDecimalPlaces(12).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
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
      var amount = money(input.inputAmount, "0.01", placesOf(from));
      var fee = money(input.feeCad, "0", homePlaces);
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
    function packed(terms, from, to, direction) {
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
      var amount = money(raw, "0.01", placesOf(from));
      var feeText = spec.feeCad == null || String(spec.feeCad).trim() === "" ? "0" : String(spec.feeCad).trim();
      var fee = money(feeText, "0", placesOf(home));
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
      return packed({
        input: amount, fee: fee, customerRate: rate, outputAmount: output,
        spreadCad: spread, inputCad: inputCad,
        buyOrSellSide: direction === "customer_buy_foreign" ? "we_sell" : direction === "customer_sell_foreign" ? "we_buy" : "we_cross",
      }, from, to, direction);
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
        return packed(calculateQuoteTerms(input), from, to, direction);
      } catch (error) {
        return { state: "bad", message: error && error.message ? error.message : "The quote could not be priced." };
      }
    }

    return {
      calculateQuoteTerms: calculateQuoteTerms,
      roundOutput: roundOutput,
      preview: preview,
      minorUnits: minorUnits,
      formatAmount: formatAmount,
      formatRate: formatRate,
      sameRate: sameRate,
      lessThan: lessThan,
      profitShare: profitShare,
    };
  }
  return { create: create };
});
