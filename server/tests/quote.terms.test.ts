import { describe, expect, it } from "vitest";
import { calculateQuoteTerms } from "../src/quotes/terms.js";

describe("quote terms",()=>{
  it("uses We Sell when a customer buys foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_buy_foreign",from:"CAD",to:"USD",inputAmount:"1000.00",feeCad:"4.00",marketMid:"1.4",margin:"0.03"});expect(q.buyOrSellSide).toBe("we_sell");expect(q.customerRate.toFixed(12)).toBe("0.692857142857");expect(q.outputAmount.toFixed(2)).toBe("692.86");expect(q.spreadCad.toFixed(2)).toBe("30.00");});
  it("uses We Buy when a customer sells foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"1000.00",feeCad:"0.00",marketMid:"1.4",margin:"0.02"});expect(q.buyOrSellSide).toBe("we_buy");expect(q.customerRate.toFixed(12)).toBe("1.372000000000");expect(q.outputAmount.toFixed(2)).toBe("1372.00");expect(q.spreadCad.toFixed(2)).toBe("28.00");});
});
