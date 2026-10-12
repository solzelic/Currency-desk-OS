/* The no-expiry allow-list is one flag on one type. A second type
   with the flag, or a health card marked as photo ID, is a different
   rule from the one the posting gate is supposed to apply. */
import { describe, expect, it } from "vitest";
import {
  ID_DOCUMENT_TYPES,
  currentPhotoSql,
  idDocumentTypeJoinSql,
  resolveIncomingType,
  typeKey,
} from "../src/ledger/id-document-types.mjs";

const ALLOWED = "Canadian citizenship card (pre-2012)";
const CERTIFICATE = "Citizenship certificate (2012 or later, no photo)";

describe("the identity document catalogue", () => {
  it("allows a blank expiry on one type", () => {
    const allowed = ID_DOCUMENT_TYPES.filter((row) => row.noExpiryAllowed);
    expect(allowed.map((row) => row.name)).toEqual([ALLOWED]);
    expect(allowed[0]).toMatchObject({ photo: true, accepted: true });
  });

  it("refuses a health card", () => {
    const health = ID_DOCUMENT_TYPES.find((row) => row.name === "Health Card");
    expect(health).toMatchObject({ photo: false, noExpiryAllowed: false, accepted: false });
  });

  it("does not treat a citizenship certificate as a photo ID", () => {
    const row = ID_DOCUMENT_TYPES.find((item) => item.name === CERTIFICATE);
    expect(row).toMatchObject({ photo: false, noExpiryAllowed: false, accepted: true });
    expect(resolveIncomingType("Citizenship Card")).toMatchObject({
      known: true,
      refused: false,
      stored: CERTIFICATE,
      canonical: CERTIFICATE,
    });
  });

  it("requires an expiry on a Secure Certificate of Indian Status", () => {
    const row = ID_DOCUMENT_TYPES.find((item) => item.name === "Secure Certificate of Indian Status");
    expect(row).toMatchObject({ photo: true, noExpiryAllowed: false, accepted: true });
  });

  it("leaves the laminated Certificate of Indian Status unlisted", () => {
    expect(ID_DOCUMENT_TYPES.some((row) => row.name === "Certificate of Indian Status")).toBe(false);
    expect(resolveIncomingType("Certificate of Indian Status")).toMatchObject({
      known: false,
      refused: false,
      stored: "Certificate of Indian Status",
      canonical: null,
    });
  });

  it("accepts the US spelling of a driver's licence and still requires an expiry", () => {
    const row = ID_DOCUMENT_TYPES.find((item) => item.name === "Driver's Licence");
    expect(row).toMatchObject({ photo: true, noExpiryAllowed: false, accepted: true });
    expect(resolveIncomingType("Driver's License").stored).toBe("Driver's Licence");
    expect(resolveIncomingType("Driver licence").stored).toBe("Driver's Licence");
  });

  it("requires an expiry on a PR card", () => {
    const row = ID_DOCUMENT_TYPES.find((item) => item.name === "Permanent Resident Card");
    expect(row).toMatchObject({ photo: true, noExpiryAllowed: false, accepted: true });
    expect(resolveIncomingType("PR Card").stored).toBe("Permanent Resident Card");
  });

  it("does not treat a blank expiry as current for every type", () => {
    const sql = currentPhotoSql("$1");
    expect(sql).toContain("no_expiry_allowed");
    expect(sql).not.toContain("expires_on IS NULL OR");
  });

  it("folds case, spacing, and punctuation into one catalogue key", () => {
    expect(typeKey("ohip  Card")).toBe("ohip card");
    expect(typeKey("OHIP-card")).toBe("ohip card");
    expect(typeKey("Health-Card")).toBe("health card");
    expect(typeKey("Driver's Licence")).toBe("drivers licence");
    expect(typeKey("Driver licence")).toBe("driver licence");
    expect(typeKey("Library card")).toBe("library card");
  });

  it("refuses a health card under a provincial name", () => {
    for (const name of ["OHIP card", "ohip  Card", "OHIP", "RAMQ", "MSP card", "Alberta Health", "Care Card", "Health-Card"]) {
      expect(resolveIncomingType(name)).toMatchObject({
        known: true,
        refused: true,
        stored: "Health Card",
        canonical: "Health Card",
      });
    }
  });

  it("stores a type that is not in the catalogue as given", () => {
    expect(resolveIncomingType("  Library card  ")).toEqual({
      known: false,
      refused: false,
      stored: "Library card",
      canonical: null,
    });
  });

  it("classifies a stored alias with the canonical flags", () => {
    const sql = idDocumentTypeJoinSql();
    expect(sql).toContain("('driver licence', true, false, true)");
    expect(sql).toContain("('drivers license', true, false, true)");
    expect(sql).toContain("('pr card', true, false, true)");
    expect(sql).toContain("('ohip card', false, false, false)");
    expect(sql).toContain("('health card', false, false, false)");
    expect(sql).toContain("regexp_replace");
    expect(sql).not.toContain("lower(btrim(d.doc_type))");
  });
});
