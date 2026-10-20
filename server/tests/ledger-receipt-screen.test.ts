import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const read = (name: string) => readFileSync(new URL("../../os-src/" + name, import.meta.url), "utf8");
it("stores the ledger receipt on Transfers and prints those lines", () => {
  const screen = read("cdos-transfers.jsx");
  expect(screen).toContain("posted.receipt.lines.slice()");
  expect(screen).toContain('data-ledger-receipt="1"');
  expect(read("cdos-transfers-app.jsx")).toContain("t.receiptLines.map");
});
it("draws drawer movement from the book, or says the ledger has no answer", () => {
  const reports = read("cdos-reports.jsx");
  expect(reports).toContain("book.movement.map");
  expect(reports).toContain("The ledger has no answer. ${noBook}.");
  expect(reports).not.toContain("drawerOut");
  expect(reports).not.toContain("drawerIn");
});
