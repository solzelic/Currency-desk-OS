import { createRequire } from "node:module";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateQuoteTerms, roundOutput } from "../src/quotes/terms.js";

const quoteTerms = createRequire(import.meta.url)("../../os-src/quote-terms.js").create(Decimal);
const cashHands = quoteTerms.cashHands;

describe("quote terms",()=>{
  it("uses We Sell when a customer buys foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_buy_foreign",from:"CAD",to:"USD",inputAmount:"1000.00",feeCad:"4.00",marketMid:"1.4",margin:"0.03"});expect(q.buyOrSellSide).toBe("we_sell");expect(q.customerRate.toFixed(12)).toBe("0.692857142857");expect(q.outputAmount.toFixed(2)).toBe("692.90");expect(q.spreadCad.toFixed(2)).toBe("29.94");});
  it("uses We Buy when a customer sells foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"1000.00",feeCad:"0.00",marketMid:"1.4",margin:"0.02"});expect(q.buyOrSellSide).toBe("we_buy");expect(q.customerRate.toFixed(12)).toBe("1.372000000000");expect(q.outputAmount.toFixed(2)).toBe("1372.00");expect(q.spreadCad.toFixed(2)).toBe("28.00");});
  it("rounds a half up, not to even",()=>{expect(roundOutput(new Decimal("1.005"),new Decimal(1),"USD").toFixed(2)).toBe("1.01");});
  it("names a yen amount that is not a whole yen",()=>{expect(()=>calculateQuoteTerms({direction:"customer_sell_foreign",from:"JPY",to:"CAD",inputAmount:"1000.5",feeCad:"0",marketMid:"0.00909918",margin:"0.015"})).toThrow("JPY uses 0 decimals. Try 1001.");});
  it("refuses a payout the fee would consume",()=>{expect(()=>calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"0.01",feeCad:"1.50",marketMid:"1.4",margin:"0.02"})).toThrow("This quote pays out nothing.");});
  it("states the cash a fee adds or takes",()=>{
    expect(cashHands("100.00","72.21","1.50","CAD","USD","CAD").give).toBe("101.50 CAD (100.00 + 1.50 fee)");
    expect(cashHands("100.00","72.21","1.50","CAD","USD","CAD").giveNote).toBe("100.00 CAD + 1.50 CAD service fee");
    expect(cashHands("100.00","72.21","1.50","CAD","USD","CAD").receiveWire).toBe("72.21");
    expect(cashHands("100.00","134.36","1.50","USD","CAD","CAD").receive).toBe("132.86 CAD (134.36 less 1.50 fee)");
    expect(cashHands("100.00","134.36","1.50","USD","CAD","CAD").receiveWire).toBe("132.86");
    expect(cashHands("3500.00","4702.63","0","USD","CAD","CAD").receive).toBe("4,702.63 CAD");
    expect(cashHands("3500.00","4702.63","0","USD","CAD","CAD").receiveWire).toBe("4702.63");
    const sell = cashHands("100.00","72.21","5.00","CAD","USD","CAD");
    expect(sell.giveAmount).toBe("105.00");
    expect(sell.giveNote).toBe("100.00 CAD + 5.00 CAD service fee");
    expect(sell.tillMoves).toEqual([
      { currency: "CAD", direction: "in", amount: "105.00" },
      { currency: "USD", direction: "out", amount: "72.21" },
    ]);
    expect(sell.receiptCash).toEqual([
      "You give 100.00 CAD",
      "100.00 CAD + 5.00 CAD service fee",
      "Cash from customer 105.00 CAD",
      "You receive 72.21 USD",
      "Cash to customer 72.21 USD",
    ]);
    const buy = cashHands("100.00","134.36","5.00","USD","CAD","CAD");
    expect(buy.receiveAmount).toBe("129.36");
    expect(buy.receiveNote).toBe("134.36 CAD less 5.00 CAD service fee");
    expect(buy.tillMoves).toEqual([
      { currency: "USD", direction: "in", amount: "100.00" },
      { currency: "CAD", direction: "out", amount: "129.36" },
    ]);
    expect(buy.receiptCash).toEqual([
      "You give 100.00 USD",
      "You receive 134.36 CAD",
      "134.36 CAD less 5.00 CAD service fee",
      "Cash to customer 129.36 CAD",
    ]);
    expect(buy.cashToCustomer).toBe("Cash to customer 129.36 CAD");
    expect("Cash to customer 129.36 CAD").not.toMatch(/[-\u2013\u2014]/);
    const yen = cashHands("1000","108252","5.00","CAD","JPY","CAD");
    expect(yen.giveAmount).toBe("1,005.00");
    expect(yen.receiveAmount).toBe("108,252");
    expect(yen.tillMoves).toEqual([
      { currency: "CAD", direction: "in", amount: "1005.00" },
      { currency: "JPY", direction: "out", amount: "108252.00" },
    ]);
    const plain = cashHands("100.00","72.21","0","CAD","USD","CAD");
    expect(plain.receiptCash).toEqual(["You give 100.00 CAD", "You receive 72.21 USD", "Cash to customer 72.21 USD"]);
    expect(plain.tillMoves).toEqual([
      { currency: "CAD", direction: "in", amount: "100.00" },
      { currency: "USD", direction: "out", amount: "72.21" },
    ]);
  });
  it("says the desk sentence for every quote error the sheet can be handed",()=>{
    const said = (raw: string) => quoteTerms.deskWording(raw);
    expect(said("Quote pricing did not load.")).toBe("Prices didn't load. Reload the page.");
    expect(said("No published branch board.")).toBe("There is no rate board for this branch. Publish the board and try again.");
    expect(said("Currency is not published.")).toBe("That currency is not on the published board.");
    expect(said("Quote outside active scope.")).toBe("This quote is not on this till.");
    expect(said("Customer is not in active workspace.")).toBe("This customer is not on this till.");
    expect(said("Quote not found.")).toBe("That quote is not on this desk. Get a new rate.");
    expect(said("invalid money")).toBe("Enter a valid amount.");
    expect(said("CAD uses 2 decimals. Try 12.35.")).toBe("CAD uses 2 decimals. Try 12.35.");
    expect(said("JPY uses 0 decimals. Try 1001.")).toBe("JPY uses 0 decimals. Try 1001.");
    expect(said("unsupported currency scale")).toBe("That currency is not available on this desk.");
    expect(said("Enter a valid amount.")).toBe("Enter a valid amount.");
    expect(said("The till doesn't have enough USD. Ask a manager to move cash in.")).toBe("The till doesn't have enough USD. Ask a manager to move cash in.");
    expect(said("Till movement rejected.")).toBe("The till doesn't have enough of that currency. Ask a manager to move cash in.");
    expect(said("A brand new server sentence.")).toBeNull();
    expect(quoteTerms.quoteFallback).toBe("Couldn't get a price. Reload and try again.");
    const board = { rows: { USD: { mid: "1.36", show: true, spread: "0.015" }, JOD: { mid: "1.8", show: true, spread: "0.015" }, JPY: { mid: "0.00909918", show: true, spread: "0.015" } }, buyMargin: "0.015", sellMargin: "0.015" };
    expect(quoteTerms.preview(board, { from: "CAD", to: "USD", inputAmount: "12.345", feeCad: "0", homeCurrency: "CAD" }).message).toBe("CAD uses 2 decimals. Try 12.35.");
    expect(quoteTerms.preview(board, { from: "JPY", to: "CAD", inputAmount: "1000.5", feeCad: "0", homeCurrency: "CAD" }).message).toBe("JPY uses 0 decimals. Try 1001.");
    expect(quoteTerms.preview(board, { from: "CAD", to: "USD", inputAmount: "12.34.5", feeCad: "0", homeCurrency: "CAD" }).message).toBe("Enter a valid amount.");
    const priced = quoteTerms.preview(board, { from: "CAD", to: "USD", inputAmount: "1000.00", feeCad: "0", homeCurrency: "CAD" });
    const shownRate = quoteTerms.displayRate(priced.rateWire);
    expect(shownRate).toMatch(/^\d+\.\d{4}$/);
    expect(priced.outputWire).toBe(quoteTerms.roundOutput(new Decimal("1000"), priced.rateWire, "USD").toFixed(2));
    expect(new Decimal(shownRate).mul("1000").toDecimalPlaces(2).toFixed(2)).toBe(priced.outputWire);
    expect(quoteTerms.preview(board, { from: "CAD", to: "JOD", inputAmount: "10", feeCad: "0", homeCurrency: "CAD" }).message).toBe("That currency is not available on this desk.");
  });
});
