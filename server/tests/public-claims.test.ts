import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public marketing claims", () => {
  it("served pages do not repeat banned claims", () => {
    const script = path.resolve(import.meta.dirname, "../../scripts/check-public-claims.mjs");
    const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(out).toMatch(/^ok /);
  });
});
