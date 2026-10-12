/* Each health-card alias has to fail on its own. Removing one phrase
   from the shared list turns that one case red. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ID_TYPE_NOT_IN_CATALOGUE_MESSAGE,
  assertCatalogueIdType,
  documentNumberForDesk,
} from "../src/clients/records.js";
import { deskValidationMessage } from "../src/clients/routes.js";
import { LedgerError } from "../src/ledger/service.js";

const { isHealthCardType, maskNotAcceptedNumber } = createRequire(import.meta.url)(
  "../../os-src/health-card-aliases.js",
) as {
  isHealthCardType: (value: unknown) => boolean;
  maskNotAcceptedNumber: (value: unknown) => string;
};

const ALIASES = [
  "Carte d'assurance maladie",
  "BC Services Card",
  "Ontario Health Insurance Plan",
  "Medicare card",
  "OHIP card",
  "RAMQ",
  "MSP",
  "Alberta Health",
  "BC Care Card",
];

describe("health-card aliases and the catalogue door", () => {
  for (const alias of ALIASES) {
    it(`treats ${alias} as a health card and refuses it on a save`, () => {
      expect(isHealthCardType(alias), alias).toBe(true);
      expect(() => assertCatalogueIdType(alias)).toThrow(LedgerError);
      try {
        assertCatalogueIdType(alias);
      } catch (error) {
        expect(error).toMatchObject({
          code: "ID_TYPE_NOT_IN_CATALOGUE",
          message: ID_TYPE_NOT_IN_CATALOGUE_MESSAGE,
        });
      }
      const masked = documentNumberForDesk(alias, "SAMQ12345678");
      expect(masked).toBe("****5678");
      expect(masked).toHaveLength(8);
      expect(String(masked).startsWith("SAM")).toBe(false);
      expect(String(masked).includes("12345678")).toBe(false);
    });
  }

  it("does not treat a near miss as a health card", () => {
    expect(isHealthCardType("mspaint")).toBe(false);
    expect(isHealthCardType("Passport")).toBe(false);
    expect(() => assertCatalogueIdType("mspaint")).toThrow(LedgerError);
    expect(() => assertCatalogueIdType("Passport")).not.toThrow();
    expect(() => assertCatalogueIdType("Driver licence")).not.toThrow();
    expect(() => assertCatalogueIdType("Health Card")).not.toThrow();
    expect(documentNumberForDesk("Passport", "P-12345")).toBe("P-12345");
    expect(isHealthCardType("health card")).toBe(true);
    expect(isHealthCardType("  Health   Card  ")).toBe(true);
    expect(documentNumberForDesk("Health Card", "H-1")).toBe("********");
    expect(documentNumberForDesk("health card", "OHIP9988")).toBe("****9988");
    expect(documentNumberForDesk("Library card", "LIB-4455")).toBe("****4455");
    expect(documentNumberForDesk("Health Card", null)).toBeNull();
    expect(documentNumberForDesk("Health Card", "   ")).toBe("");
  });

  it("keeps the mask eight characters wide", () => {
    expect(maskNotAcceptedNumber("OHIP99887766")).toBe("****7766");
    expect(maskNotAcceptedNumber("OHIP99887766")).toHaveLength(8);
    expect(maskNotAcceptedNumber("****9988")).toBe("****9988");
    expect(maskNotAcceptedNumber("AB")).toBe("********");
    expect(maskNotAcceptedNumber(null)).toBe("");
    expect(maskNotAcceptedNumber(undefined)).toBe("");
  });
});

describe("a save error is a desk sentence", () => {
  it("does not return zod's own wording", () => {
    const body = z.object({
      legalName: z.string().min(1),
      source: z.literal("staff", { errorMap: () => ({ message: "Type the ID type and number yourself. ID scanning is not connected, so a record with no staff entry is refused." }) }),
    }).strict();
    const parsed = body.safeParse({ legalName: null, source: "scan", extra: true });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = deskValidationMessage(parsed.error);
    expect(message).not.toMatch(/Expected/);
    expect(message).not.toMatch(/received/);
    expect(message).not.toMatch(/Invalid/);
    expect(message).not.toMatch(/String must/);
    expect(message).not.toMatch(/Unrecognized key/);
    expect(message).not.toContain("legalName:");
    expect(message).not.toContain("docType:");
    expect(message.length).toBeGreaterThan(0);
  });
});
