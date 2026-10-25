/* The login page renders no Enter as buttons unless quick sign-in
   is exactly enabled. The source has to call the shared helper with
   true, and only inside the quick branch. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { renderStagingEnterButtons } = createRequire(import.meta.url)("../../os-src/staging-signin.js") as {
  renderStagingEnterButtons: (enabled: unknown) => string;
};

describe("login page render", () => {
  it("shows no enter buttons when staging sign-in is disabled", () => {
    for (const off of [false, undefined, null, 0, "1", { enabled: false }]) {
      const html = renderStagingEnterButtons(off);
      expect(html).toBe("");
      expect(html).not.toContain("Enter as");
      expect(html).not.toContain("<button");
    }
    const on = renderStagingEnterButtons(true);
    for (const label of ["Enter as Owner", "Enter as Manager", "Enter as Supervisor", "Enter as Compliance officer", "Enter as Teller", "Enter as Auditor"]) {
      expect(on).toContain(label);
    }
    expect(on).not.toMatch(/\u2014|\u2013/);
    const page = readFileSync(new URL("../../os-src/cdos-signin.jsx", import.meta.url), "utf8");
    expect(page).toContain("stagingEnterButtons(true)");
    expect(page).toContain("quick ?");
  });
});
