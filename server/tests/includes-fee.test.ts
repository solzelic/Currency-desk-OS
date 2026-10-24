/* The fee is added on top. "Includes ... fee" is the sentence that
   said otherwise. Tags, line breaks, and non-breaking spaces do not
   hide it. Modeled on the public-claims banned-phrase check. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/check-includes-fee.mjs");

function probe(text: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, "--probe", text], { encoding: "utf8" });
    return { ok: true, out };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

describe("included-fee phrase", () => {
  it("app source and the built desk do not say the fee is included", () => {
    const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(out).toMatch(/^ok /);
  });

  it("flags Includes $2.50 service fee", () => {
    const result = probe("Includes $2.50 service fee");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/includes/);
  });

  it("flags a line break between Includes and fee", () => {
    const result = probe("Includes\n$2.50 service fee");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/includes/);
  });

  it("flags a tag between Includes and fee", () => {
    const result = probe("Includes <b>$2.50</b> service fee");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/includes/);
  });

  it("allows the fee added on top", () => {
    expect(probe("Service fee: $2.50, added to the total").ok).toBe(true);
    expect(probe("You pay: CAD 1,002.50").ok).toBe(true);
    expect(probe("No service fee").ok).toBe(true);
  });
});
