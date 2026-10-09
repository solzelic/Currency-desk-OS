#!/usr/bin/env node
/* ============================================================
   Size budget for the compiled desk script.

     node scripts/check-os-bundle.mjs

   web/app/os.js is what /login loads. On main before this job it was
   the Babel concatenation, unminified: about 2.6 MB raw. That file
   fails the budget below. A minified build from scripts/build-os.mjs
   fits. admin.js is the same build step, so it has a budget too.

   Parsing is node --check, the engine the browser's parser is a
   cousin of. It does not boot the desk. The boot is
   tests/e2e/desk-script-boots.spec.ts.
   ============================================================ */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Above a keep-names esbuild minify of the current sources
   (os.js ~1.48 MB, admin.js ~143 KB) and below the unminified files
   (os.js 2,603,950 bytes, admin.js 225,918). */
const BUDGETS = [
  { file: "web/app/os.js", maxBytes: 1_600_000 },
  { file: "web/app/admin.js", maxBytes: 180_000 },
];

let failed = false;

for (const { file, maxBytes } of BUDGETS) {
  const abs = path.join(ROOT, file);
  const size = readFileSync(abs).length;
  if (size > maxBytes) {
    failed = true;
    console.error(`${file} is ${size} bytes, over the ${maxBytes}-byte budget.`);
  } else {
    console.log(`${file} is ${size} bytes (budget ${maxBytes}).`);
  }

  const parsed = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
  if (parsed.status !== 0) {
    failed = true;
    console.error(`${file} does not parse.\n${parsed.stderr || parsed.stdout}`);
  } else {
    console.log(`${file} parses.`);
  }
}

if (failed) process.exit(1);
console.log("compiled app bundles are within budget and parse.");
