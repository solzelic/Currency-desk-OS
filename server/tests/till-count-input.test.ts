/* The takeover count field reads exactly what the teller typed or pasted,
   or refuses it. It never rounds and never reads a look-alike character
   as a digit (#558). The rule is parseCount in os-src/minor-units-format.js,
   the file the desk loads; the server's own check is in the ledger route
   (decimalString, then the currency's minor unit). */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { parseCount } = require(join(root, "os-src/minor-units-format.js")) as {
  parseCount: (text: unknown, currency: string) => { ok: true; value: string } | { ok: false; reason: string };
};

const refused = (text: string, currency: string) => {
  const result = parseCount(text, currency);
  expect(result.ok, `${currency} ${JSON.stringify(text)}`).toBe(false);
  return result.ok ? "" : result.reason;
};
const read = (text: string, currency: string) => {
  const result = parseCount(text, currency);
  expect(result, `${currency} ${JSON.stringify(text)}`).toMatchObject({ ok: true });
  return result.ok ? result.value : "";
};

describe("a till count as typed", () => {
  it("refuses 1.999 CAD and says why, instead of sending 2.00", () => {
    expect(refused("1.999", "CAD")).toBe("CAD counts to 2 decimal places. 1.999 has 3. Nothing was rounded.");
    expect(refused("24990.004", "CAD")).toContain("Nothing was rounded.");
  });

  it("refuses a pasted 1500² instead of reading it as 15002", () => {
    expect(refused("1500²", "CAD")).toBe("Type the CAD count with the digits 0 to 9 and one decimal point.");
    expect(refused("¹⁵⁰⁰", "CAD")).toContain("digits 0 to 9");
  });

  it("refuses every other character that is not a digit or one decimal point", () => {
    for (const text of ["１５００", "1500a", "15 00", "1.5.0", "-20", "+20", "1e3", "1,500", "$1500", "١٥٠٠", "Infinity", "."]) {
      refused(text, "CAD");
    }
  });

  it("refuses a decimal on a currency with no minor unit", () => {
    expect(refused("1500.5", "JPY")).toBe("JPY has no decimal places. Count whole JPY.");
    expect(refused("1500.", "JPY")).toBe("JPY has no decimal places. Count whole JPY.");
  });

  it("refuses an empty count and an amount the ledger cannot hold", () => {
    expect(refused("", "CAD")).toBe("Type the CAD count.");
    expect(refused("   ", "CAD")).toBe("Type the CAD count.");
    expect(refused("1000000000.01", "CAD")).toBe("CAD 1000000000.01 is more than a till can hold.");
  });

  it("reads what was typed exactly, padded to the currency's places and never rounded", () => {
    expect(read("1.99", "CAD")).toBe("1.99");
    expect(read("1.5", "CAD")).toBe("1.50");
    expect(read("1500", "CAD")).toBe("1500.00");
    expect(read(" 20.00 ", "CAD")).toBe("20.00");
    expect(read("0012.30", "CAD")).toBe("12.30");
    expect(read(".5", "CAD")).toBe("0.50");
    expect(read("5.", "CAD")).toBe("5.00");
    expect(read("0", "CAD")).toBe("0.00");
    expect(read("1500", "JPY")).toBe("1500");
    expect(read("1000000000", "CAD")).toBe("1000000000.00");
  });
});
