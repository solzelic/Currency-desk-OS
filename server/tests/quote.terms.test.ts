import { describe, expect, it } from "vitest";
import { calculateQuoteTerms, cashierQuoteMessage } from "../src/quotes/terms.js";

const RAW = ["negative spread", "direction and currencies disagree"];
const shown = (run: () => void) => {
  try {
    run();
  } catch (error) {
    const message = cashierQuoteMessage(error);
    for (const raw of RAW) expect(message).not.toContain(raw);
    return message;
  }
  throw new Error("expected a refusal");
};

describe("quote terms",()=>{
  it("uses We Sell when a customer buys foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_buy_foreign",from:"CAD",to:"USD",inputAmount:"1000.00",feeCad:"4.00",marketMid:"1.4",margin:"0.03"});expect(q.buyOrSellSide).toBe("we_sell");expect(q.customerRate.toFixed(12)).toBe("0.692857142857");expect(q.outputAmount.toFixed(2)).toBe("692.86");expect(q.spreadCad.toFixed(2)).toBe("30.00");});
  it("uses We Buy when a customer sells foreign currency",()=>{const q=calculateQuoteTerms({direction:"customer_sell_foreign",from:"USD",to:"CAD",inputAmount:"1000.00",feeCad:"0.00",marketMid:"1.4",margin:"0.02"});expect(q.buyOrSellSide).toBe("we_buy");expect(q.customerRate.toFixed(12)).toBe("1.372000000000");expect(q.outputAmount.toFixed(2)).toBe("1372.00");expect(q.spreadCad.toFixed(2)).toBe("28.00");});

  it("tells the cashier in plain words", () => {
    const direction = shown(() =>
      calculateQuoteTerms({
        direction: "customer_sell_foreign",
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        marketMid: "1.4",
        margin: "0.02",
      }),
    );
    expect(direction).toMatch(/paid in/);
    /* 1.00 CAD at a mid of 1.005 rounds the payout up past the cash taken in. */
    const spread = shown(() =>
      calculateQuoteTerms({
        direction: "customer_buy_foreign",
        from: "CAD",
        to: "USD",
        inputAmount: "1.00",
        feeCad: "0.00",
        marketMid: "1.005",
        margin: "0",
      }),
    );
    expect(spread).toMatch(/cost the desk/);
    expect(shown(() => { throw new Error("negative spread"); })).toMatch(/cost the desk/);
    expect(shown(() => { throw new Error("direction and currencies disagree"); })).toMatch(/paid in/);
    expect(shown(() => { throw new Error("invalid board terms"); })).toMatch(/rate board/);
  });
});
