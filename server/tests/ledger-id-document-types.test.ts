/* The no-expiry allow-list is one flag on one type. A second type
   with the flag, or a health card marked as photo ID, is a different
   rule from the one the posting gate is supposed to apply. */
import { describe, expect, it } from "vitest";
import {
  ID_DOCUMENT_TYPES,
  currentPhotoSql,
} from "../src/ledger/id-document-types.mjs";

const ALLOWED = "Canadian citizenship card (pre-2012)";

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

  it("requires an expiry on a PR card", () => {
    for (const name of ["PR Card", "Permanent Resident Card"]) {
      const row = ID_DOCUMENT_TYPES.find((item) => item.name === name);
      expect(row).toMatchObject({ photo: true, noExpiryAllowed: false, accepted: true });
    }
  });

  it("does not treat a blank expiry as current for every type", () => {
    const sql = currentPhotoSql("$1");
    expect(sql).toContain("no_expiry_allowed");
    expect(sql).not.toContain("expires_on IS NULL OR");
