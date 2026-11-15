import { describe, expect, it } from "vitest";
import { bestMatch, type ListEntry } from "../src/screening/match.js";
import {
  SCORE_THRESHOLD_PLACEHOLDER,
  THRESHOLD_SIGNOFF,
  dobAgrees,
  dobConflict,
  normalizeName,
  parseDobField,
  scoreNames,
} from "../src/screening/names.js";

const listed: ListEntry = {
  key: "ca|73",
  names: ["Sergei Yepikhov", "Siarhei Yepikhau"],
  dobs: [{ kind: "date", value: "1966-05-16" }],
};

describe("name normalisation and matching", () => {
  it("folds case, accents, punctuation, and word order", () => {
    expect(normalizeName("  Sergeí, Yepikhov ")).toBe("sergei yepikhov");
    expect(scoreNames("YEPIKHOV, Sergei", "Sergei Yepikhov")).toBe(1);
    expect(scoreNames("Al-Qaida", "Al Qaida")).toBe(1);
  });

  it("treats a transliteration fold as a near match", () => {
    expect(scoreNames("Yousuf al Uyayri", "Yusuf al Uyayri")).toBe(0.97);
    expect(scoreNames("Muhammad", "Mohammed")).toBe(0.93);
  });

  it("matches an alias from the list and a date of birth when both sides have one", () => {
    const hit = bestMatch({ name: "Siarhei Yepikhau", dob: "1966-05-16" }, [listed], SCORE_THRESHOLD_PLACEHOLDER);
    expect(hit?.matchedName).toBe("Siarhei Yepikhau");
    expect(hit?.score).toBe(1);
  });

  it("rules a match out only when full dates conflict", () => {
    expect(bestMatch({ name: "Sergei Yepikhov", dob: "1970-01-02" }, [listed], SCORE_THRESHOLD_PLACEHOLDER)).toBeNull();
    expect(dobConflict("1970-01-02", listed.dobs)).toBe(true);
    expect(bestMatch({ name: "Sergei Yepikhov" }, [listed], SCORE_THRESHOLD_PLACEHOLDER)?.score).toBe(1);
    const yearOnly: ListEntry = { ...listed, dobs: parseDobField("1970") };
    expect(dobConflict("1966-05-16", yearOnly.dobs)).toBe(false);
    expect(bestMatch({ name: "Sergei Yepikhov", dob: "1966-05-16" }, [yearOnly], SCORE_THRESHOLD_PLACEHOLDER)?.score).toBe(1);
    const several: ListEntry = { ...listed, dobs: parseDobField("1972-08-26 or 1974-05-31") };
    expect(dobConflict("1974-05-31", several.dobs)).toBe(false);
    expect(bestMatch({ name: "Sergei Yepikhov", dob: "1974-05-31" }, [several], SCORE_THRESHOLD_PLACEHOLDER)?.score).toBe(1);
    expect(bestMatch({ name: "Sergei Yepikhov", dob: "1980-01-01" }, [several], SCORE_THRESHOLD_PLACEHOLDER)).toBeNull();
  });

  it("keeps a name match when only one side has a date of birth", () => {
    expect(bestMatch({ name: "Sergei Yepikhov" }, [listed], SCORE_THRESHOLD_PLACEHOLDER)?.score).toBe(1);
    const yearOnly: ListEntry = { ...listed, dobs: parseDobField("1966") };
    expect(dobAgrees("1966-05-16", yearOnly.dobs)).toBe(true);
    expect(bestMatch({ name: "Sergei Yepikhov", dob: "1966-11-02" }, [yearOnly], SCORE_THRESHOLD_PLACEHOLDER)?.score).toBe(1);
  });

  it("leaves the default threshold as a placeholder for sign-off", () => {
    expect(SCORE_THRESHOLD_PLACEHOLDER).toBe(0.92);
    expect(THRESHOLD_SIGNOFF).toMatch(/pending Compliance Officer sign-off/);
    expect(THRESHOLD_SIGNOFF).not.toMatch(/final/i);
  });
});
