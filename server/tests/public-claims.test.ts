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

  it("flags a dotted OFAC", () => {
    const result = probe("O.F.A.C. list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OFAC/);
  });

  it("flags a dotted U.N. sanctions list", () => {
    const result = probe("U.N. sanctions list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/UN sanctions/);
  });

  it("flags OSFI", () => {
    const result = probe("checked with OSFI");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OSFI/);
  });

  it("flags a singular real shop", () => {
    const result = probe("a real shop");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a zero-width space inside real shops", () => {
    const result = probe("real&#8203;shops");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a soft hyphen inside real shops", () => {
    const result = probe("real&shy;shops");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a soft hyphen inside OFAC", () => {
    const result = probe("O&shy;FAC");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OFAC/);
  });

  it("flags a soft hyphen inside sanctions", () => {
    const result = probe("sanc&shy;tions");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/sanctions/);
  });

  it("flags sanctions screening when it is not the honest negation", () => {
    const result = probe("sanctions screening included");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/sanctions screening/);
  });

  it("allows the honest sentence that sanctions screening is not connected", () => {
    const result = probe("Sanctions screening is not connected");
    expect(result.ok).toBe(true);
  });

  it("flags screened against", () => {
    const result = probe("screened against a list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/screened against/);
  });

  it("flags most popular", () => {
    const result = probe("Most popular");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/most popular/);
  });

  it("flags most chosen", () => {
    const result = probe("Most chosen");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/most chosen/);
  });

  it("flags billed separately", () => {
    const result = probe("billed separately per file");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/billed separately/);
  });

  it("flags a UN list", () => {
    const result = probe("checked on the UN list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/UN list/);
  });

  it("flags a United Nations list", () => {
    const result = probe("the United Nations list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/United Nations list/);
  });

  it("flags best protection", () => {
    const result = probe("Best protection");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/best protection/);
  });

  it("flags in seconds, including a zero-width split", () => {
    const result = probe("serve a customer in&#8203;seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in seconds/);
  });

  it("flags in N seconds, including a soft hyphen", () => {
    const result = probe("done in 4&shy;seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in N seconds/);
  });

  it("flags in N minutes, including a soft hyphen", () => {
    const result = probe("ready in 4&shy;minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in N minutes/);
  });

  it("flags a minutes duration, including a zero-width split", () => {
    const result = probe("wait 15&#8203;minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/minutes/);
  });

  it("flags a few minutes", () => {
    const result = probe("within a few minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/minutes/);
  });

  it("flags N seconds, including a written number", () => {
    const result = probe("ninety seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/N seconds/);
  });

  it("flags same afternoon, including a zero-width split", () => {
    const result = probe("live the same&#8203;afternoon");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same afternoon/);
  });

  it("flags same day, including a dotted split", () => {
    const result = probe("usually the s.a.m.e day");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same day/);
  });

  it("flags about a week, including a soft hyphen", () => {
    const result = probe("about a&shy;week");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/about a week/);
  });

  it("flags within a week, including an entity split", () => {
    const result = probe("within&#8203;a week");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/within a week/);
  });

  it("allows the moment a deal is written and an untimed launch", () => {
    const result = probe("the second it happens. a second shop. an on-site launch week. We have not timed it.");
    expect(result.ok).toBe(true);
  });
});
