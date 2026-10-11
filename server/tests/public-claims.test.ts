import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/check-public-claims.mjs");

function probe(html: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, "--probe", html], { encoding: "utf8" });
    return { ok: true, out };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

describe("public marketing claims", () => {
  it("served pages do not repeat banned claims", () => {
    const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(out).toMatch(/^ok /);
  });

  it("flags a non-breaking space between desks and claimed", () => {
    const result = probe("desks&nbsp;claimed");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/desks claimed/);
  });

  it("flags a line break between desks and claimed", () => {
    const result = probe("desks\nclaimed");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/desks claimed/);
  });

  it("flags a tag between report and ready", () => {
    const result = probe("Report <b>ready</b>");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/Report ready/);
  });

  it("flags uppercase EFTR next to LIVE", () => {
    const result = probe("EFTR LIVE");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/EFTR next to Live/);
  });

  it("does not treat the word structuring as an STR", () => {
    const result = probe("STRUCTURING stays on the worksheet");
    expect(result.ok).toBe(true);
  });
});
