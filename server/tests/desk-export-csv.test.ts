import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { csvCell, csvDocument, storedDecimal } from "../src/desk/export-csv.js";

describe("desk export csv", () => {
  it("quotes a comma and a quote, and leaves a plain cell alone", () => {
    expect(csvCell("Zed, Export")).toBe('"Zed, Export"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });

  it("keeps a stored money string and refuses a value that is not a number", () => {
    expect(storedDecimal("1000.50")).toBe("1000.50");
    expect(new Decimal(storedDecimal("1000.50")).eq("1000.50")).toBe(true);
    expect(storedDecimal(null)).toBe("");
    expect(() => storedDecimal("not-money")).toThrow(/not a number/);
  });

  it("ends with a newline so a spreadsheet sees the last row", () => {
    const file = csvDocument(["name"], [["Ada"]]);
    expect(file).toBe("name\r\nAda\r\n");
  });
});
