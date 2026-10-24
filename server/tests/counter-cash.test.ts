/* The till summary and the large-cash screen share one cash rule.
   A cashed cheque pays cash out. Its face is not cash in. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const babel = createRequire(import.meta.url)("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};
const React = createRequire(import.meta.url)("react");

const require = createRequire(import.meta.url);
const { cashLegs } = require("../../shared/counter-cash.js") as {
  cashLegs: (row: Record<string, unknown>) => {
    in: { amount: unknown; ccy: unknown } | null;
    out: { amount: unknown; ccy: unknown } | null;
  };
};

describe("cash legs", () => {
  it("counts the cash paid out on a cheque and leaves the face out", () => {
    expect(cashLegs({
      type: "Cheque Cashing", deal_kind: "cheque_cashing",
      inAmt: 1000, outAmt: 965, inCcy: "CAD", outCcy: "CAD",
      receivedInstrument: "cheque", disbursedInstrument: "cash",
    })).toEqual({ in: null, out: { amount: 965, ccy: "CAD" } });
    expect(cashLegs({
      deal_kind: "cheque_cashing",
      input_amount: "1000.00", output_amount: "965.00",
      from_currency: "CAD", to_currency: "CAD",
      received_instrument: "cheque", disbursed_instrument: "cash",
    })).toEqual({ in: null, out: { amount: "965.00", ccy: "CAD" } });
  });

  it("counts both legs of a cash exchange, and lets a named instrument win", () => {
    expect(cashLegs({
      deal_kind: "exchange",
      input_amount: "100.00", output_amount: "70.00",
      from_currency: "CAD", to_currency: "USD",
      received_instrument: "cash", disbursed_instrument: "cash",
    })).toEqual({
      in: { amount: "100.00", ccy: "CAD" },
      out: { amount: "70.00", ccy: "USD" },
    });
    expect(cashLegs({
      type: "Currency Exchange",
      inAmt: 100, outAmt: 70, inCcy: "CAD", outCcy: "USD",
      receivedInstrument: "cheque", disbursedInstrument: "cash",
    })).toEqual({ in: null, out: { amount: 70, ccy: "USD" } });
  });

  it("still counts an old row with no instrument as cash", () => {
    expect(cashLegs({
      type: "Remittance — Send",
      inAmt: 500, outAmt: 480, inCcy: "CAD", outCcy: "PHP",
    })).toEqual({
      in: { amount: 500, ccy: "CAD" },
      out: { amount: 480, ccy: "PHP" },
    });
    expect(cashLegs({ inAmt: 20, outAmt: 15, inCcy: "CAD", outCcy: "USD" })).toEqual({
      in: { amount: 20, ccy: "CAD" },
      out: { amount: 15, ccy: "USD" },
    });
  });

  const paidIn = (instrument: unknown) => cashLegs({
    type: "Currency Exchange",
    inAmt: "10000.00", outAmt: "7000.00", inCcy: "CAD", outCcy: "USD",
    receivedInstrument: instrument, disbursedInstrument: "cash",
  }).in;

  it("counts cash, CASH, and padded cash", () => {
    expect(paidIn("cash")).toEqual({ amount: "10000.00", ccy: "CAD" });
    expect(paidIn("CASH")).toEqual({ amount: "10000.00", ccy: "CAD" });
    expect(paidIn(" cash ")).toEqual({ amount: "10000.00", ccy: "CAD" });
  });

  it("counts an unknown method as cash", () => {
    expect(paidIn("unknown")).toEqual({ amount: "10000.00", ccy: "CAD" });
  });

  it("counts a missing method as cash", () => {
    expect(cashLegs({
      type: "Cheque Cashing",
      inAmt: "10000.00", outAmt: "965.00", inCcy: "CAD", outCcy: "CAD",
    }).in).toEqual({ amount: "10000.00", ccy: "CAD" });
  });

  it("counts eft as zero", () => {
    expect(paidIn("eft")).toBeNull();
    expect(paidIn("EFT")).toBeNull();
  });

  it("is loaded by the desk shell before the code that reads it", () => {
    const root = resolve(process.cwd(), "..");
    const shell = readFileSync(resolve(root, "CurrencyDesk OS.html"), "utf8");
    const shared = shell.indexOf('src="shared/counter-cash.js"');
    const bundle = readFileSync(resolve(root, "web/app/os.js"), "utf8");
    expect(shared).toBeGreaterThan(-1);
    expect(shared).toBeLessThan(shell.indexOf('src="os-src/cdos-base.jsx"'));
    expect(bundle.indexOf("---- shared/counter-cash.js ----")).toBeLessThan(
      bundle.indexOf("---- os-src/cdos-base.jsx ----"),
    );
  });
});

/* The large-cash flag is computeFlags in the desk. Canada is at or
   above the line, so 10,000.00 is a report and 9,999.99 is not. */
function lctrFlags(rows: Array<Record<string, unknown>>) {
  const root = resolve(process.cwd(), "..");
  const cash = require("../../shared/counter-cash.js") as {
    cashLegs: (row: Record<string, unknown>) => {
      in: { amount: unknown; ccy: unknown } | null;
    };
  };
  const leg = (row: Record<string, unknown>) => {
    const found = row && cash.cashLegs(row).in;
    return found ? { amount: Number(found.amount) || 0, ccy: found.ccy } : null;
  };
  const CDOS: Record<string, unknown> = {
    counterCashIn: leg,
    counterCashOut: () => null,
    deskPack: () => ({ homeCurrency: "CAD", packId: "pack-ca-v1" }),
    reportingLimit: () => ({ amount: 10000, currency: "CAD", code: "LCTR" }),
    getRegime: () => ({ comparator: "gte", largeDirection: "in", aggregate: false, threshold: 10000 }),
    dDiff: () => 0,
    businessDate: () => "2026-10-24",
    crossRate: () => 1,
    deskTime: () => "",
    deskDay: () => "",
    rulesMissing: () => false,
    CD: {},
    Ic: () => null,
    TYPES: [],
    CCY: [],
    fmt: (n: unknown) => String(n ?? ""),
    num: (n: unknown) => String(n ?? ""),
    currencyPlaces: () => 2,
    effectiveRate: () => ({ text: "", rounded: false }),
    RATE_NOTE: "",
    unitText: () => "",
    perCadLive: () => 1,
  };
  const window = { CDOS };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.React = React;
  g.document = { addEventListener() {}, removeEventListener() {} };
  const src = readFileSync(resolve(root, "os-src/cdos-modules.jsx"), "utf8");
  const code = babel.transform(src, { presets: ["react"], filename: "cdos-modules.jsx" }).code;
  if (!code) throw new Error("cdos-modules.jsx");
  new Function("React", "window", "document", code)(React, window, g.document);
  const computeFlags = CDOS.computeFlags as (rows: unknown[], clients: object, settings: object) => Record<string, { single: boolean }>;
  return computeFlags(rows, {}, { structuringDays: 30 });
}

describe("LCTR line", () => {
  const row = (amount: string) => ({
    id: "row", status: "posted", type: "Currency Exchange", customer: "Ada",
    date: "2026-10-24", time: "10:00 AM",
    inAmt: amount, inCcy: "CAD", outAmt: "1.00", outCcy: "USD",
    receivedInstrument: "cash", disbursedInstrument: "cash",
  });

  it("triggers at exactly 10000.00 CAD cash and not at 9999.99", () => {
    const over = lctrFlags([row("10000.00")]).row;
    const under = lctrFlags([row("9999.99")]).row;
    expect(over && over.single).toBe(true);
    expect(under && under.single).toBe(false);
  });
});
