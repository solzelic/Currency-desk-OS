/* Rates v2.5 guardrails, the server's copy of the rule.

   The new-deal screen meters a deal's margin and holds it to a floor
   (os-src/cdos-txmodal.jsx, os-src/rates-board.js floorFor). The server now
   checks the same when a deal posts (quotes/service.ts). Two copies of one
   rule drift, so this file runs both on the same cases: a floor the screen
   shows is the floor the server applies. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { dealMarginPct, enforceOf, floorFor, readDeskSettings } from "../src/rates/guardrails.js";

const require = createRequire(import.meta.url);
const browser = require("../../os-src/rates-board.js") as { floorFor: (s: unknown, code: string) => number };

describe("the floor a currency is held to", () => {
  const cases: [unknown, string][] = [
    [{ marginFloorPct: 0.8, marginFloorByCcy: { USD: 0.3, GBP: "1.2", JPY: "", MXN: "x", TRY: -1 } }, "USD"],
    [{ marginFloorPct: 0.8, marginFloorByCcy: { USD: 0.3, GBP: "1.2" } }, "GBP"],
    [{ marginFloorPct: 0.8, marginFloorByCcy: { JPY: "" } }, "JPY"],
    [{ marginFloorPct: "1.5" }, "EUR"],
    [{ marginFloorPct: -2 }, "EUR"],
    [{}, "USD"],
    [null, "USD"],
  ];
  it.each(cases)("is the same on the server as on the screen (%j, %s)", (settings, code) => {
    expect(floorFor(settings, code)).toBe(browser.floorFor(settings, code));
  });
});

describe("what happens below the floor", () => {
  it("blocks unless the shop chose to warn only", () => {
    expect(enforceOf({})).toBe("block");
    expect(enforceOf({ marginEnforce: "block" })).toBe("block");
    expect(enforceOf({ marginEnforce: "warn" })).toBe("warn");
    expect(enforceOf({ marginEnforce: "anything" })).toBe("block");
  });
});

describe("the desk's settings as saved", () => {
  it("reads the browser's JSON text or an object, and nothing else", () => {
    expect(readDeskSettings('{"marginFloorPct":2}')).toEqual({ marginFloorPct: 2 });
    expect(readDeskSettings({ marginFloorPct: 2 })).toEqual({ marginFloorPct: 2 });
    expect(readDeskSettings("not json")).toEqual({});
    expect(readDeskSettings("[1,2]")).toEqual({});
    expect(readDeskSettings(null)).toEqual({});
  });
});

describe("a deal's margin", () => {
  /* The screen's: what the desk keeps (the booked spread plus the fee),
     over the deal's size in the home currency. */
  it("is spread plus fee over the home side of the deal", () => {
    expect(dealMarginPct({ home: "CAD", from: "CAD", to: "USD", inputAmount: "1000", outputAmount: "700", marketMid: "1.4", spread: "20", fee: "5" })!.toString()).toBe("2.5");
    expect(dealMarginPct({ home: "CAD", from: "USD", to: "CAD", inputAmount: "500", outputAmount: "686", marketMid: "1.4", spread: "14", fee: "0" })!.toNumber()).toBeCloseTo(14 / 686 * 100, 10);
    expect(dealMarginPct({ home: "CAD", from: "USD", to: "EUR", inputAmount: "100", outputAmount: "90", marketMid: "1.4", spread: "2.8", fee: "0" })!.toString()).toBe("2");
  });
  /* Money is never floating point (engineering standard §3). In floats
     0.57 kept on 114 is 0.49999999999999994%, under a 0.5% floor it is
     exactly at. */
  it("is exact: a deal at its floor is not under it", () => {
    const at = dealMarginPct({ home: "CAD", from: "CAD", to: "USD", inputAmount: "114", outputAmount: "80", marketMid: "1.4", spread: "0.57", fee: "0" })!;
    expect(at.toString()).toBe("0.5");
    expect(at.lt(floorFor({ marginFloorPct: 0.5 }, "USD"))).toBe(false);
  });
  it("has no margin to measure on an empty deal", () => {
    expect(dealMarginPct({ home: "CAD", from: "CAD", to: "USD", inputAmount: "0", outputAmount: "0", marketMid: "1.4", spread: "0", fee: "0" })).toBeNull();
  });
});
