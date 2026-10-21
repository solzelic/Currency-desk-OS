import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inProgress = "This request is already being posted. Nothing else was posted.";
const busy = "Nothing was posted. Try again.";
const shared = "The ledger is busy. Nothing was saved. Please try again.";

function text(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

describe("teller sentences", () => {
  it("keeps the in-progress sentence", () => {
    for (const path of ["os-src/cdos-backend.js", "web/app/os.js"]) {
      expect(text(path), path).toContain(`IDEMPOTENCY_IN_PROGRESS: "${inProgress}"`);
    }
  });

  it("says the till is busy without a dash", () => {
    for (const path of ["os-src/cdos-backend.js", "web/app/os.js"]) {
      const source = text(path);
      expect(source, path).not.toContain("Nothing was posted \u2014 try again");
      expect(source, path).toContain(busy);
    }
    expect(text("server/src/ledger/retry.ts")).toContain(shared);
    for (const path of [
      "server/src/ledger/routes.ts",
      "server/src/quotes/routes.ts",
      "server/src/clients/routes.ts",
    ]) {
      const source = text(path);
      expect(source, path).toContain("LEDGER_BUSY_MESSAGE");
      expect(source, path).not.toContain("Nothing was posted \u2014 try again");
      expect(source, path).not.toContain("Nothing was saved \u2014 try again");
      expect(source, path).not.toContain("Nothing was quoted \u2014 try again");
    }
  });
});
