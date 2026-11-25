/* The old Quick / Verified / Verified Plus prices are not shown.
   A price that comes back later has to say CAD. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const files = [
  "os-src/cdos-kyc.jsx",
  "os-src/cdos-settings.jsx",
  "os-src/cdos-txmodal.jsx",
  "web/app/os.js",
];

describe("tier prices", () => {
  it("does not render the stale check prices", () => {
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).not.toContain("$3.99");
      expect(text, file).not.toContain("$6.99");
      expect(text, file).not.toContain("$14.99");
      expect(text, file).not.toContain("3.99");
      expect(text, file).not.toContain("6.99");
      expect(text, file).not.toContain("14.99");
    }
  });

  it("formats a future KYC amount in CAD", () => {
    const source = readFileSync(join(root, "os-src/cdos-kyc.jsx"), "utf8");
    const money = source.slice(source.indexOf("const money"), source.indexOf("const storedSettings"));
    expect(money).toContain("CAD");
    expect(money).not.toMatch(/['"]\$/);
  });
});
