import { describe, expect, it } from "vitest";
import { crossRate, inputAmountCad, quoteExchange } from "../../src/domain/rates";

describe("exchange quotation", () => {
  it("quotes cross-currency rates from CAD base rates", () => {
    expect(crossRate("CAD", "USD")).toBe(0.731);
    expect(crossRate("USD", "CAD")).toBe(1.368);
  });

  it("calculates fees, spread, and output amount", () => {
    const quote = quoteExchange("CAD", "USD", 1000, 4);

    expect(quote.rate).toBe(0.731);
    expect(quote.outputAmount).toBe(724.42);
    expect(quote.spreadCad).toBe(9);
    expect(quote.totalProfitCad).toBe(13);
  });

  it("converts non-CAD input amounts to CAD equivalent", () => {
    expect(inputAmountCad("USD", 731)).toBe(1000);
  });
});
