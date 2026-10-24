/* The customer-quote hero is the locked pay sentence. One currency on
   the card uses a dollar sign. More than one names the code. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(import.meta.dirname, "../../os-src/cdos-base.jsx"), "utf8");
const start = source.indexOf("function groupedMoney");
const end = source.indexOf("window.CDOS = Object.assign", start);
const loaded = new Function(`${source.slice(start, end)}\nreturn feeOnTopCopy;`) as () => (quote: {
  fee: number;
  principal: number;
  currency: string;
  payCurrency: string;
  currencies: string[];
}) => { feeLine: string; payLine: string };
const feeOnTopCopy = loaded();

const quote = {
  fee: 2.5,
  principal: 1000,
  currency: "CAD",
  payCurrency: "CAD",
};

describe("fee on top hero copy", () => {
  it("uses a dollar sign when the card has one currency", () => {
    expect(feeOnTopCopy({ ...quote, currencies: ["CAD"] })).toEqual({
      feeLine: "Service fee: $2.50, added to the total",
      payLine: "You pay: $1,002.50",
    });
  });

  it("names the code when the card has more than one currency", () => {
    expect(feeOnTopCopy({ ...quote, currencies: ["CAD", "USD"] })).toEqual({
      feeLine: "Service fee: CAD 2.50, added to the total",
      payLine: "You pay: CAD 1,002.50",
    });
  });
});
