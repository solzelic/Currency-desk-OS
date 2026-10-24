/* The till summary and the large-cash screen share one cash rule.
   A cashed cheque pays cash out. Its face is not cash in. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    })).toEqual({ in: { amount: 500, ccy: "CAD" }, out: null });
    expect(cashLegs({ inAmt: 20, outAmt: 15, inCcy: "CAD", outCcy: "USD" })).toEqual({
      in: { amount: 20, ccy: "CAD" },
      out: { amount: 15, ccy: "USD" },
    });
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
