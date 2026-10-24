/* The sentences on idStanding are copied from displayIdStanding in
   os-src/cdos-backend.js. detail and reason are the same sentence.
   status is the short word that helper returns. A paraphrase here
   and the original there is two vocabularies. This test holds the
   copy. The helper's provider path ("Verified") is not a document
   verdict, and this server does not emit it. */
import { describe, expect, it } from "vitest";
import { standingForVerdict } from "../src/ledger/id-on-file.js";

const IDENTIFIED = "An identity document with a number is on file, and it has not expired.";
const EXPIRED = "An identity document on this file is past its expiry. The till will not treat this customer as identified.";

describe("idStanding matches displayIdStanding", () => {
  it("pins Identified", () => {
    expect(standingForVerdict("identified")).toEqual({
      status: "identified",
      label: "Identified",
      detail: IDENTIFIED,
      reason: IDENTIFIED,
      tone: "ok",
    });
  });

  it("pins Expired", () => {
    expect(standingForVerdict("expired")).toEqual({
      status: "expired",
      label: "Expired",
      detail: EXPIRED,
      reason: EXPIRED,
      tone: "warning",
    });
  });

  it("pins a blank expiry", () => {
    expect(standingForVerdict("no_expiry")).toEqual({
      status: "missing",
      label: "Missing ID",
      detail: "ID has no expiry date",
      reason: "ID has no expiry date",
      tone: "warning",
    });
  });

  it("pins a missing number", () => {
    expect(standingForVerdict("no_number")).toEqual({
      status: "missing",
      label: "Missing ID",
      detail: "No ID number",
      reason: "No ID number",
      tone: "warning",
    });
  });

  it("pins a type that was not stated", () => {
    expect(standingForVerdict("type_not_stated")).toEqual({
      status: "missing",
      label: "Missing ID",
      detail: "ID type not stated",
      reason: "ID type not stated",
      tone: "warning",
    });
  });

  it("pins no document", () => {
    expect(standingForVerdict("no_id")).toEqual({
      status: "missing",
      label: "Missing ID",
      detail: "No ID on file",
      reason: "No ID on file",
      tone: "warning",
    });
  });

  it("pins a file with no current photo ID", () => {
    expect(standingForVerdict("photo_needed")).toEqual({
      status: "missing",
      label: "Missing ID",
      detail: "A current photo ID is needed",
      reason: "A current photo ID is needed",
      tone: "warning",
    });
  });

  it("folds an unknown verdict into no document", () => {
    expect(standingForVerdict("something-else").reason).toBe("No ID on file");
    expect(standingForVerdict("").status).toBe("missing");
  });
});
