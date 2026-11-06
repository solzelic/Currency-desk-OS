/* The desk ships without its whitespace and comments.

   web/app/os.js was the compiled sources as written: 3 MB, a third of it
   indentation and the comments that explain the code. Every visitor
   downloaded and parsed all of it. scripts/build-os.mjs now strips
   whitespace and comments from the shipped copy only. Names are kept
   (deal-direction.test.ts runs the shipped direction expression by its
   variable names), and so is each file's marker line, so the bundle can
   still be read file by file. The comments stay in os-src, where they
   are read. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { minify } from "terser";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const bundle = readFileSync(path.join(ROOT, "web/app/os.js"), "utf8");
const shell = readFileSync(path.join(ROOT, "CurrencyDesk OS.html"), "utf8");

/* The scripts the build puts in os.js, in the shell's order. */
const sources = [...shell.matchAll(/<script\b[^>]*\bsrc="((?:os-src|shared)\/[^"]+)"/g)].map((m) => m[1]!);

/* After the banner, each script is its marker line and one line of code. */
function files(): Array<{ marker: string; code: string[] }> {
  const out: Array<{ marker: string; code: string[] }> = [];
  for (const line of bundle.split("\n")) {
    const marker = /^\/\* ---- (.+) ---- \*\/$/.exec(line);
    if (marker) out.push({ marker: marker[1]!, code: [] });
    else if (out.length && line.trim()) out[out.length - 1]!.code.push(line);
  }
  return out;
}

describe("the shipped desk", () => {
  it("keeps a marker for every script, in the shell's order", () => {
    expect(sources.length).toBeGreaterThan(40);
    expect(files().map((f) => f.marker).filter((m) => m !== "inline")).toEqual(sources);
  });

  it("is one line of code per script", () => {
    for (const f of files()) expect(f.code.length, f.marker).toBe(1);
  });

  it("has no whitespace or comments left for the minifier to take out", async () => {
    for (const f of files()) {
      const again = await minify(f.code[0]!, { compress: false, mangle: false, format: { comments: false } });
      expect(again.code === f.code[0], f.marker).toBe(true);
    }
  });

  it("is less than two thirds of the size it was", () => {
    // 3,124,593 bytes on main at 35ff77a4, before this change
    expect(Buffer.byteLength(bundle)).toBeLessThan(2_083_000);
  });

  it("leaves the comments in the sources", () => {
    expect(readFileSync(path.join(ROOT, "os-src/cdos-os.jsx"), "utf8")).toContain("/* The desk is only signed in if the SERVER says so.");
    expect(bundle).not.toContain("The desk is only signed in if the SERVER says so.");
  });
});
