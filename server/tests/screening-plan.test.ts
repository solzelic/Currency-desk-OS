import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planScreen } from "../src/screening/gate.js";
import { SCORE_THRESHOLD_PLACEHOLDER } from "../src/screening/names.js";

const entry = {
  key: "ca|73",
  names: ["Sergei Yepikhov"],
  dobs: [{ kind: "date" as const, value: "1966-05-16" }],
  sourceKey: "ca-sema",
};

describe("screen plan", () => {
  it("holds a possible match and a confirmed match, and lets a cleared entry through", () => {
    const hit = planScreen({
      entries: [entry], threshold: SCORE_THRESHOLD_PLACEHOLDER,
      subject: { name: "Yepikhov, Sergei", dob: "1966-05-16" },
      confirmed: false, clearedKeys: [],
    });
    expect(hit.hold).toBe(true);
    expect(hit.outcome).toBe("possible");
    expect(planScreen({
      entries: [entry], threshold: SCORE_THRESHOLD_PLACEHOLDER,
      subject: { name: "Sergei Yepikhov" }, confirmed: true, clearedKeys: [],
    }).outcome).toBe("confirmed");
    expect(planScreen({
      entries: [entry], threshold: SCORE_THRESHOLD_PLACEHOLDER,
      subject: { name: "Sergei Yepikhov", dob: "1966-05-16" },
      confirmed: false, clearedKeys: ["ca|73"],
    }).hold).toBe(false);
  });

  it("does not call a PEP or adverse media vendor from the id check route", () => {
    const source = readFileSync(new URL("../src/screening/routes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.screenPep\s*\(/);
    expect(source).not.toMatch(/\.screenAdverseMedia\s*\(/);
  });
});
