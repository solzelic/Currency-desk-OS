import { describe, expect, it } from "vitest";
import { civilDate } from "../src/ledger/civil-date.js";

describe("a date-only value stays on its civil day", () => {
  it("reads local midnight as that calendar day, not the UTC day", () => {
    const april = new Date(2030, 3, 1, 0, 0, 0, 0);
    expect(civilDate(april)).toBe("2030-04-01");
    expect(april.getFullYear()).toBe(2030);
    expect(april.getMonth()).toBe(3);
    expect(april.getDate()).toBe(1);
  });

  it("keeps a YYYY-MM-DD string and refuses an instant or junk", () => {
    expect(civilDate("2030-04-01")).toBe("2030-04-01");
    expect(civilDate("2030-04-01T00:00:00.000Z")).toBeNull();
    expect(civilDate("2026-10-11 junk")).toBeNull();
    expect(civilDate("0000-01-01")).toBeNull();
    expect(civilDate(null)).toBeNull();
    expect(civilDate("")).toBeNull();
  });
});
