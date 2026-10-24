import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* The customer-facing sentence used to be "Includes ... fee". The fee
   and the amount paid are two lines now. This fails while any app
   file still has the old sentence. */
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PHRASE = /Includes\b(?:[^.\n]|\$\{[^}]*\}){0,80}fee/i;
const ROOTS = ["os-src", "web/app", "server/src"];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(path);
  }
  return out;
}

describe("service fee wording", () => {
  it("does not say Includes ... fee", () => {
    const hits: string[] = [];
    for (const rel of ROOTS) {
      for (const path of files(join(root, rel))) {
        if (PHRASE.test(readFileSync(path, "utf8"))) hits.push(relative(root, path));
      }
    }
    expect(hits).toEqual([]);
  });
});
