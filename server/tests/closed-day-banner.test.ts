/* The ledger banner on a closed day used an em dash on every width.
   The phone already reads as two sentences. The desk does too. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-ledger.jsx"), "utf8");

describe("closed day banner", () => {
  it("says the book is read-only in two sentences, with no dash", () => {
    expect(src).toContain(
      "The trading day is closed. The book is read-only. Reopen from Till & Cash Drawer to post new transactions.",
    );
    expect(src).not.toContain("The trading day is closed — the book is read-only.");
    expect(src).not.toContain("The trading day is closed – the book is read-only.");
  });
});
