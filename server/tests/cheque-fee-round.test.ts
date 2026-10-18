/* The screen fee and the server fee are one helper.
   1000.25 at 2% is 20.01, not the 20.00 a float multiply prints. */
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { chequeScheduleFee } from "../src/ledger/chequeFee.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const faces = ["0.01", "0.25", "1.00", "4.99", "10.00", "50.25", "99.99", "250.25", "333.33", "999.99", "1000.00", "1000.25", "1000.50", "1234.56", "9999.99", "100000.25"];

function decimalFee(face: string, pct: number, min: number) {
  return Decimal.max(new Decimal(min), new Decimal(face).mul(pct).div(100)).toDecimalPlaces(2).toFixed(2);
}

describe("cheque fee rounding", () => {
  it("rounds 1,000.25 and 250.25 half up, and the screen calls that helper", () => {
    expect(chequeScheduleFee("1000.25", 2, 5)).toBe("20.01");
    expect(chequeScheduleFee("250.25", 2, 5)).toBe("5.01");
    const jsx = readFileSync(new URL("../../os-src/cdos-cheques.jsx", import.meta.url), "utf8");
    const feeFor = jsx.slice(jsx.indexOf("const feeFor"), jsx.indexOf("\n", jsx.indexOf("const feeFor")));
    expect(feeFor).toContain("chequeScheduleFee");
    expect(feeFor).not.toContain("*");
  });

  it("matches the server half-up fee for every type across the faces", () => {
    for (const row of DEFAULT_CHEQUE_SCHEDULE) {
      for (const face of faces) {
        expect(chequeScheduleFee(face, row.feePct, row.feeMin), `${row.id} ${face}`).toBe(decimalFee(face, row.feePct, row.feeMin));
      }
    }
  });
});
