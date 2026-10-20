/* The desk posts a quote with a direction. The server derives the same
   direction from the two currencies and the desk home currency, and
   refuses the quote when they disagree. INR paid in for USD on a CAD
   desk is a cross: neither side is home. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateQuoteTerms } from "../src/quotes/terms.js";

const MENU = ["CAD", "USD", "EUR", "GBP", "INR", "PHP", "CNY", "MXN", "AED"];
/* AUD is a pack home currency and is not on the nine-currency menu. */
const HOMES = [...MENU, "AUD"];

type Shape = "customer_buy_foreign" | "customer_sell_foreign" | "customer_cross";

function serverShape(from: string, to: string, home: string): Shape {
  if (from === home) return "customer_buy_foreign";
  if (to === home) return "customer_sell_foreign";
  return "customer_cross";
}

function codesFor(home: string): string[] {
  return MENU.includes(home) ? MENU : [home, ...MENU];
}

function pairsOf(home: string, shape: Shape): string[] {
  const out: string[] = [];
  for (const from of codesFor(home)) {
    for (const to of codesFor(home)) {
      if (from !== to && serverShape(from, to, home) === shape) out.push(`${from}->${to}`);
    }
  }
  return out;
}

function quoteDirectionExpression(source: string): string {
  const at = source.indexOf("Backend.createQuote({");
  if (at < 0) throw new Error("createQuote call missing");
  const match = source.slice(at, at + 700).match(/direction:\s*([^,\n]+)/);
  const found = match && match[1];
  if (!found) throw new Error("direction expression missing");
  return found.trim();
}

function deskSends(expression: string, from: string, to: string, home: string): string {
  const value = Function(
    "inCcy",
    "outCcy",
    "home",
    `"use strict"; return (${expression});`,
  )(from, to, home);
  if (typeof value !== "string") throw new Error("direction was not a string");
  return value;
}

function serviceShapeExpression(source: string): string {
  const at = source.indexOf("const shape: QuoteDirection =");
  if (at < 0) throw new Error("server shape missing");
  const match = source.slice(at, at + 400).match(/const shape: QuoteDirection =\s*([\s\S]*?);/);
  const found = match && match[1];
  if (!found) throw new Error("server shape expression missing");
  return found.trim();
}

function serviceSends(expression: string, from: string, to: string, home: string): string {
  const value = Function(
    "request",
    "home",
    `"use strict"; return (${expression});`,
  )({ from, to }, home);
  if (typeof value !== "string") throw new Error("server shape was not a string");
  return value;
}

const root = new URL("../../", import.meta.url);
const deskSource = readFileSync(new URL("os-src/cdos-txmodal.jsx", root), "utf8");
const deskBuilt = readFileSync(new URL("web/app/os.js", root), "utf8");
const serviceSource = readFileSync(new URL("server/src/quotes/service.ts", root), "utf8");
const deskFiles = [
  ["os-src/cdos-txmodal.jsx", quoteDirectionExpression(deskSource)],
  ["web/app/os.js", quoteDirectionExpression(deskBuilt)],
] as const;

function wrongPairs(expression: string, shape: Shape, skip: string[] = []): string[] {
  const bad: string[] = [];
  for (const home of HOMES) {
    for (const pair of pairsOf(home, shape)) {
      if (skip.includes(`${home} ${pair}`)) continue;
      const parts = pair.split("->");
      const from = parts[0];
      const to = parts[1];
      if (!from || !to) throw new Error(`bad pair ${pair}`);
      const got = deskSends(expression, from, to, home);
      if (got !== shape) bad.push(`${home} ${from}->${to} sent ${got}`);
    }
  }
  return bad;
}

describe("desk deal direction", () => {
  it("sends customer_cross when a CAD desk sells INR for USD", () => {
    for (const [file, expression] of deskFiles) {
      expect(deskSends(expression, "INR", "USD", "CAD"), file).toBe("customer_cross");
    }
  });

  it("sends customer_cross for every other pair with no home currency on either side", () => {
    for (const [file, expression] of deskFiles) {
      expect(wrongPairs(expression, "customer_cross", ["CAD INR->USD"]), file).toEqual([]);
    }
  });

  it("keeps customer_sell_foreign when the home currency is received", () => {
    for (const [file, expression] of deskFiles) {
      expect(wrongPairs(expression, "customer_sell_foreign"), file).toEqual([]);
    }
  });

  it("keeps customer_buy_foreign when the home currency is paid in", () => {
    for (const [file, expression] of deskFiles) {
      expect(wrongPairs(expression, "customer_buy_foreign"), file).toEqual([]);
    }
  });
});

describe("server deal direction", () => {
  const shape = serviceShapeExpression(serviceSource);

  it("already treats INR sold for USD on a CAD desk as a cross", () => {
    expect(serviceSends(shape, "INR", "USD", "CAD")).toBe("customer_cross");
    expect(serviceSource).toContain("Transaction direction does not match the currency pair.");
    const priced = calculateQuoteTerms({
      direction: "customer_cross",
      from: "INR",
      to: "USD",
      inputAmount: "1000.00",
      feeCad: "0.00",
      marketMid: "0.0166",
      fromMid: "0.0166",
      toMid: "1.36",
      margin: "0.02",
      homeCurrency: "CAD",
    });
    expect(priced.buyOrSellSide).toBe("we_cross");
    expect(priced.outputAmount.gt(0)).toBe(true);
  });

  it("already refuses customer_sell_foreign for INR to USD on a CAD desk", () => {
    expect(() =>
      calculateQuoteTerms({
        direction: "customer_sell_foreign",
        from: "INR",
        to: "USD",
        inputAmount: "1000.00",
        feeCad: "0.00",
        marketMid: "0.0166",
        fromMid: "0.0166",
        toMid: "1.36",
        margin: "0.02",
        homeCurrency: "CAD",
      }),
    ).toThrow("direction and currencies disagree");
  });

  it("agrees with the currency pair for every checked home", () => {
    const bad: string[] = [];
    for (const home of HOMES) {
      for (const from of codesFor(home)) {
        for (const to of codesFor(home)) {
          if (from === to) continue;
          const want = serverShape(from, to, home);
          const got = serviceSends(shape, from, to, home);
          if (got !== want) bad.push(`${home} ${from}->${to} server ${got}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
