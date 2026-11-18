/* PR 2b copy guard. New counter strings must not say Verified, Approved, Cleared, or FINTRAC approved. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BANNED = /\bVerified\b|\bApproved\b|\bCleared\b|FINTRAC approved/i;

function quoted(source: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) out.push(match[0]);
  return out;
}

describe("id check counter copy", () => {
  it("keeps the banned words out of the new screen strings", () => {
    const source = readFileSync(join(root, "os-src/cdos-id-check.jsx"), "utf8");
    const hits = quoted(source).filter((line) => BANNED.test(line));
    expect(hits).toEqual([]);
    const notice = readFileSync(join(root, "server/src/idv/consent-copy.ts"), "utf8");
    expect(notice).toContain("Your ID details are kept for at least 5 years because the law requires it.");
    expect(notice).toContain("United States");
    expect(source).toContain("No thanks, check my ID at the counter");
    expect(source).toContain("No photo on file");
    expect(source).toContain("Check passed (test)");
    expect(source).not.toContain("\u2014");
    expect(source).not.toContain("\u2013");
  });
});
