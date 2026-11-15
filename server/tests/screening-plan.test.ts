import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mayReviewScreening, planScreen } from "../src/screening/gate.js";
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
    const ivan = { key: "ca|ivan", names: ["Ivan Petrov"], dobs: [], sourceKey: "ca-sema" };
    const longer = { key: "un|ivan", names: ["Ivan Ivanovich Petrov"], dobs: [], sourceKey: "un-sc" };
    const both = planScreen({
      entries: [ivan, longer], threshold: SCORE_THRESHOLD_PLACEHOLDER,
      subject: { name: "Ivan Petrov" }, confirmed: false, clearedKeys: [],
    });
    expect(both.hold).toBe(true);
    expect(both.hits.map((hit) => hit.key).sort()).toEqual(["ca|ivan", "un|ivan"]);
    const rest = planScreen({
      entries: [ivan, longer], threshold: SCORE_THRESHOLD_PLACEHOLDER,
      subject: { name: "Ivan Petrov" }, confirmed: false, clearedKeys: ["ca|ivan"],
    });
    expect(rest.hold).toBe(true);
    expect(rest.hits.map((hit) => hit.key)).toEqual(["un|ivan"]);
  });

  it("lets the named compliance officer decide and never a teller", () => {
    expect(mayReviewScreening("teller", "m.costa", "m.costa")).toBe(false);
    expect(mayReviewScreening("administrator", "j.masri", null)).toBe(false);
    expect(mayReviewScreening("administrator", "j.masri", "c.adebayo")).toBe(false);
    expect(mayReviewScreening("administrator", "j.masri", "j.masri")).toBe(true);
    expect(mayReviewScreening("compliance_officer", "c.adebayo", null)).toBe(false);
    expect(mayReviewScreening("compliance_officer", "c.adebayo", "c.adebayo")).toBe(true);
    expect(mayReviewScreening("compliance_officer", "c.adebayo", "j.masri")).toBe(false);
  });

  it("shows the unnamed-officer prompt and lets the owner name themselves in Settings", () => {
    const screen = readFileSync(new URL("../../os-src/cdos-compliance-app.jsx", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../os-src/cdos-settings.jsx", import.meta.url), "utf8");
    const prompt = "Name your compliance officer. Every MSB must have one.";
    expect(screen).toContain(prompt);
    expect(screen).toContain("openSettingsTab('compliance')");
    expect(screen).toContain('data-testid="screening-name-officer"');
    expect(settings).toContain('id="compliance-officer-field"');
    expect(settings).toContain('data-testid="name-self-compliance-officer"');
  });

  it("does not call a PEP or adverse media vendor from the id check route", () => {
    const source = readFileSync(new URL("../src/screening/routes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.screenPep\s*\(/);
    expect(source).not.toMatch(/\.screenAdverseMedia\s*\(/);
  });
});
