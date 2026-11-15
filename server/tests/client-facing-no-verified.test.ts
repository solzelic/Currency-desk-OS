/* The staff ID stamp says "Verified, [method], [age]".
   A client never sees that word: receipts, texts, emails, the storefront,
   or a client link. Staff screens are not in this list. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

function filesIn(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesIn(path, out);
    else if (/\.(html|ts|js|jsx)$/.test(name)) out.push(path);
  }
  return out;
}

const clientFacing = [
  ...filesIn(join(root, "YorkFX")),
  ...filesIn(join(root, "rates-public")),
  join(root, "server/src/email.ts"),
  ...filesIn(join(root, "server/src/emails")),
  join(root, "server/src/routes/public-site.ts"),
].map((path) => relative(root, path));

describe("client-facing outputs never contain Verified", () => {
  it("keeps the word off the storefront, texts, emails, and the public quote", () => {
    expect(clientFacing.length).toBeGreaterThan(5);
    for (const path of clientFacing) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text, path).not.toContain("Verified");
    }
  });

  it("does not put the staff stamp on the exchange receipt lines", () => {
    const source = readFileSync(join(root, "server/src/ledger/service.ts"), "utf8");
    const receipts = source.split("receipt:").slice(1);
    expect(receipts.length).toBeGreaterThan(0);
    for (const block of receipts) {
      const lines = block.slice(0, block.indexOf("};"));
      expect(lines).not.toContain("Verified");
      expect(lines).not.toContain("idBadge");
    }
  });
});
