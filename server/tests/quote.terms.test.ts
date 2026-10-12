import { createRequire } from "node:module";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateQuoteTerms, roundOutput } from "../src/quotes/terms.js";

const cashHands = createRequire(import.meta.url)("../../os-src/quote-terms.js").create(Decimal).cashHands;

describe("quote terms",()=>{
  it("uses We Sell when a customer buys foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_buy_foreign",from:"CAD",to:"USD",inputAmount:"1000.00",feeCad:"4.00",marketMid:"1.4",margin:"0.03"});expect(q.buyOrSellSide).toBe("we_sell");expect(q.customerRate.toFixed(12)).toBe("0.692857142857");expect(q.outputAmount.toFixed(2)).toBe("692.86");expect(q.spreadCad.toFixed(2)).toBe("30.00");});
  it("uses We Buy when a customer sells foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"1000.00",feeCad:"0.00",marketMid:"1.4",margin:"0.02"});expect(q.buyOrSellSide).toBe("we_buy");expect(q.customerRate.toFixed(12)).toBe("1.372000000000");expect(q.outputAmount.toFixed(2)).toBe("1372.00");expect(q.spreadCad.toFixed(2)).toBe("28.00");});
  it("rounds a half up, not to even",()=>{expect(roundOutput(new Decimal("1.005"),new Decimal(1),"USD").toFixed(2)).toBe("1.01");});
  it("names a yen amount that is not a whole yen",()=>{expect(()=>calculateQuoteTerms({direction:"customer_sell_foreign",from:"JPY",to:"CAD",inputAmount:"1000.5",feeCad:"0",marketMid:"0.00909918",margin:"0.015"})).toThrow("Yen has no decimals.");});
  it("refuses a payout the fee would consume",()=>{expect(()=>calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"0.01",feeCad:"1.50",marketMid:"1.4",margin:"0.02"})).toThrow("This quote pays out nothing.");});
  it("states the cash a fee adds or takes",()=>{
    expect(cashHands("100.00","72.21","1.50","CAD","USD","CAD").give).toBe("101.50 CAD (100.00 + 1.50 fee)");
    expect(cashHands("100.00","72.21","1.50","CAD","USD","CAD").receiveWire).toBe("72.21");
    expect(cashHands("100.00","134.36","1.50","USD","CAD","CAD").receive).toBe("132.86 CAD (134.36 less 1.50 fee)");
    expect(cashHands("100.00","134.36","1.50","USD","CAD","CAD").receiveWire).toBe("132.86");
    expect(cashHands("3500.00","4702.63","0","USD","CAD","CAD").receive).toBe("4,702.63 CAD");
    expect(cashHands("3500.00","4702.63","0","USD","CAD","CAD").receiveWire).toBe("4702.63");
  });
});
