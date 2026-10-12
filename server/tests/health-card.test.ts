/* The read-side detector. The catalogue file on PR #108 matches only
   the exact name "health card". A desk types OHIP, RAMQ, MSP, Alberta
   Health and Care Card, in whatever case and spacing it was given. */
import { describe, expect, it } from "vitest";
import { isHealthCardType } from "../src/clients/health-card.js";

describe("isHealthCardType", () => {
  it("matches the catalogue name in any case or spacing", () => {
    for (const name of ["Health Card", "health card", "HEALTH CARD", "Health   Card", " health-card "]) {
      expect(isHealthCardType(name), name).toBe(true);
    }
  });

  it("matches the aliases a desk types", () => {
    for (const name of ["OHIP", "ohip", "OHIP card", "RAMQ", "MSP", "Alberta Health", "Alberta Health Care", "Care Card", "BC Care Card"]) {
      expect(isHealthCardType(name), name).toBe(true);
    }
  });

  it("does not match a passport, a licence, or a word that only shares letters", () => {
    for (const name of ["Passport", "Driver's Licence", "Provincial ID", "mspaint", "careful card", "healthcare", ""]) {
      expect(isHealthCardType(name), name).toBe(false);
    }
    expect(isHealthCardType(null)).toBe(false);
    expect(isHealthCardType(undefined)).toBe(false);
  });
});
