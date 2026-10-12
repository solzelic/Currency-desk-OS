/* The one health-card list. Server and browser load
   shared/health-card-names.js. A name matches the whole folded
   type, not a substring. */
import { describe, expect, it } from "vitest";
import { HEALTH_CARD_NAMES, isHealthCardType, typeKey } from "../src/clients/health-card.js";

const REQUIRED = [
  "Carte d'assurance maladie",
  "BC Services Card",
  "Ontario Health Insurance Plan",
  "OHIP",
  "Medicare card",
  "Alberta Health",
  "Alberta Health Care Insurance Plan",
  "RAMQ",
  "MSP",
  "Care Card",
  "Manitoba Health",
  "Saskatchewan Health Card",
  "Nova Scotia Health Card",
  "Prince Edward Island Health Card",
  "Newfoundland and Labrador Medical Care Plan",
  "Northwest Territories Health Care Card",
  "Nunavut Health Care Card",
  "Yukon Health Care Card",
  "New Brunswick Medicare",
];

describe("isHealthCardType", () => {
  it("lists every name the desk has to treat as a health card", () => {
    for (const name of REQUIRED) {
      expect(HEALTH_CARD_NAMES, name).toContain(name);
      expect(isHealthCardType(name), name).toBe(true);
    }
  });

  it("matches the catalogue name in any case or spacing", () => {
    for (const name of ["Health Card", "health card", "HEALTH CARD", "Health   Card", " health-card "]) {
      expect(isHealthCardType(name), name).toBe(true);
    }
    expect(typeKey("Carte d'assurance maladie")).toBe("carte dassurance maladie");
    expect(isHealthCardType("Carte d’assurance maladie")).toBe(true);
  });

  it("matches each name on the shared list and not a word that only shares letters", () => {
    for (const name of HEALTH_CARD_NAMES) {
      expect(isHealthCardType(name), name).toBe(true);
    }
    for (const name of ["Passport", "Driver's Licence", "Provincial ID", "mspaint", "careful card", "healthcare", "Ontario", ""]) {
      expect(isHealthCardType(name), name).toBe(false);
    }
    expect(isHealthCardType(null)).toBe(false);
    expect(isHealthCardType(undefined)).toBe(false);
  });
});
