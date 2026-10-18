/* The screen fee and the server fee are one helper.
   1000.25 at 2% is 20.01, not the 20.00 a float multiply prints.
   1000.5 is the same 20.01. A stored percent with more than 2 digits
   after the point rounds half up to 2 on read. */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { chequeScheduleFee, feeFigureProblem, feePctCommit, feePctShown, feePctText, moneyShown } from "../src/ledger/chequeFee.js";
import { FEE_PERCENT_PLACES } from "../src/routes/tenantState.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const faces = ["0.01", "0.25", "1.00", "4.99", "10.00", "50.25", "99.99", "250.25", "333.33", "999.99", "1000.00", "1000.25", "1000.50", "1000.5", "1234.56", "9999.99", "100000.25"];

function decimalFee(face: string, pct: number, min: number) {
  const roundedPct = new Decimal(pct).toDecimalPlaces(2);
  return Decimal.max(new Decimal(min), new Decimal(face).mul(roundedPct).div(100)).toDecimalPlaces(2).toFixed(2);
}

const helperSrc = readFileSync(new URL("../../os-src/cheque-fee.js", import.meta.url), "utf8");

describe("cheque fee rounding", () => {
  it("rounds 1,000.25 and 250.25 half up, and the screen calls that helper", () => {
    expect(chequeScheduleFee("1000.25", 2, 5)).toBe("20.01");
    expect(chequeScheduleFee("250.25", 2, 5)).toBe("5.01");
    const jsx = readFileSync(new URL("../../os-src/cdos-cheques.jsx", import.meta.url), "utf8");
    const feeFor = jsx.slice(jsx.indexOf("const feeFor"), jsx.indexOf("\n", jsx.indexOf("const feeFor")));
    expect(feeFor).toContain("CDOS_CHEQUE_FEE.chequeScheduleFee");
    expect(feeFor).not.toContain("*");
  });

  it("reads the one-decimal face 1000.5 as 20.01", () => {
    expect(chequeScheduleFee("1000.5", 2, 5)).toBe("20.01");
  });

  it("matches the server half-up fee for every type across the faces", () => {
    for (const row of DEFAULT_CHEQUE_SCHEDULE) {
      for (const face of faces) {
        expect(chequeScheduleFee(face, row.feePct, row.feeMin), `${row.id} ${face}`).toBe(decimalFee(face, row.feePct, row.feeMin));
      }
    }
  });

  it("rounds a stored percent with more than 2 digits half up to 2 on read", () => {
    expect(chequeScheduleFee("1000.00", 2.125, 0)).toBe("21.30");
    expect(chequeScheduleFee("1000.00", 2.12345, 0)).toBe("21.20");
    expect(chequeScheduleFee("1000.00", "2.120", 0)).toBe("21.20");
  });

  it("returns null for a figure it cannot read, never 0.00", () => {
    expect(chequeScheduleFee("1000.00", "nope", 5)).toBeNull();
    expect(chequeScheduleFee("1000.00", 2, "five")).toBeNull();
    expect(chequeScheduleFee("10.001", 2, 5)).toBeNull();
  });

  it("keeps the helper under one namespace and states the input limits", () => {
    const sandbox = createContext({}) as Record<string, unknown>;
    runInContext(helperSrc, sandbox);
    expect(Object.keys(sandbox)).toEqual(["CDOS_CHEQUE_FEE"]);
    const box = sandbox.CDOS_CHEQUE_FEE as Record<string, unknown>;
    expect(Object.keys(box).sort()).toEqual(["chequeScheduleFee", "feeFigureProblem", "feePctCommit", "feePctShown", "feePctText", "moneyShown"]);
    expect(helperSrc).toContain("12 digits");
    expect(helperSrc).toContain("1000.5");
    expect(helperSrc).toContain("2 digits after the point");
    expect(helperSrc).toContain("half a cent");
  });

  it("limits Fee % to 2 decimal places in the field and says so in amber", () => {
    expect(feePctText("")).toBe("");
    expect(feePctText("2")).toBe("2");
    expect(feePctText("2.")).toBe("2.");
    expect(feePctText("2.2")).toBe("2.2");
    expect(feePctText("2.12")).toBe("2.12");
    expect(feePctText("2.12345")).toBeNull();
    expect(feeFigureProblem(2.12345, "percent")).toBe("places");
    expect(feeFigureProblem(2.12, "percent")).toBeNull();
    expect(feeFigureProblem("2.120", "percent")).toBeNull();
    expect(feeFigureProblem(1.5, "percent")).toBeNull();
    expect(feeFigureProblem(1e-7, "percent")).toBe("places");
    expect(feeFigureProblem("1e-7", "percent")).toBe("places");
    expect(feeFigureProblem(1e2, "percent")).toBeNull();
    expect(feeFigureProblem("1e2", "percent")).toBe("unread");
    expect(feeFigureProblem(4.005, "money")).toBe("places");
    expect(feeFigureProblem("4.005", "money")).toBe("places");
    expect(feeFigureProblem(4, "money")).toBeNull();
    expect(feeFigureProblem("4.00", "money")).toBeNull();
    expect(feeFigureProblem("4.", "money")).toBe("unread");
    expect(feeFigureProblem(".", "percent")).toBe("unread");
    expect(feeFigureProblem(-2, "percent")).toBe("unread");
    expect(feeFigureProblem("abc", "percent")).toBe("unread");
    expect(feeFigureProblem(1e21, "percent")).toBe("unread");
    expect(feeFigureProblem(1234567, "percent")).toBe("unread");
    expect(feeFigureProblem("2.5000000000000", "percent")).toBe("unread");
    expect(feeFigureProblem(-5, "money")).toBe("unread");
    expect(feeFigureProblem("1e3", "money")).toBe("unread");
    expect(feeFigureProblem(1e13, "money")).toBe("unread");
    expect(feeFigureProblem("x", "money")).toBe("unread");
    expect(chequeScheduleFee("1000.25", 2, "4.")).toBeNull();
    expect(chequeScheduleFee("1000.25", ".", 5)).toBeNull();
    expect(moneyShown("4.")).toBe("4.00");
    expect(moneyShown("4.5")).toBe("4.50");
    expect(moneyShown(".")).toBe("");
    expect(feePctCommit(".")).toBe("");
    expect(feePctCommit("2.")).toBe("2");
    expect(feePctCommit("2.125")).toBeNull();
    expect(chequeScheduleFee("1000.25", 2, moneyShown("4."))).toBe("20.01");
    const problem = helperSrc.slice(helperSrc.indexOf("function feeFigureProblem"), helperSrc.indexOf("function moneyShown"));
    expect(problem).toContain("percentParts");
    expect(problem).toContain("moneyCents");
    expect(feePctShown(2.125)).toBe("2.13");
    expect(feePctShown("2.125")).toBe("2.13");
    expect(feePctShown(1.5)).toBe("1.5");
    expect(feePctShown(2)).toBe("2");
    expect(feePctShown("2.120")).toBe("2.12");
    const decimal = helperSrc.slice(helperSrc.indexOf("string arithmetic"), helperSrc.indexOf("function feePctShown"));
    expect(decimal).not.toContain("toFixed");
    const app = readFileSync(new URL("../../os-src/cdos-cheques-app.jsx", import.meta.url), "utf8");
    const at = app.indexOf("CDOS_CHEQUE_FEE.feePctText");
    const pct = app.slice(app.lastIndexOf("<input", at), app.indexOf("/>", at));
    expect(pct).toContain('type="text"');
    expect(pct).toContain('inputMode="decimal"');
    expect(pct).toContain("onBlur");
    expect(pct).not.toContain("next !== ''");
    expect(pct).not.toContain('step="0.1"');
    const bannerAt = app.indexOf('data-testid="fee-schedule-places"');
    const banner = app.slice(bannerAt, bannerAt + 360);
    expect(banner).toContain("CD.amberSoft");
    expect(banner).toContain('n="alert"');
    expect(banner).toContain("s={13}");
    expect(banner).toContain("text-[13px]");
    expect(banner).toContain("{places.detail}");
    expect(pct).toContain("aria-invalid");
    expect(pct).toContain("feePctCommit");
    const minAt = app.indexOf('data-testid="fee-min"');
    const min = app.slice(minAt, app.indexOf("/>", minAt));
    expect(min).toContain("aria-invalid");
    expect(min).toContain("moneyShown");
    expect(app).toContain(`const FEE_PLACES = "${FEE_PERCENT_PLACES}"`);
    expect(app).toContain("feePctShown(row.feePct)");
    expect(app).toContain("feePctShown(t.feePct)");
  });
});
