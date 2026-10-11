#!/usr/bin/env node
/* Fail when the built desk bundle names a sanctions list.

   Render serves the committed web/app/os.js. It does not rebuild it.
   browser-validate runs this after `npm run build:os`, so a phrase
   that survived into the bundle fails the pull request without a
   seam run. Comments are compiled into that file, so they count.
   ============================================================ */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bannedBundleHits } from "./check-sanctions-phrases.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = path.join("web", "app", "os.js");
const text = readFileSync(path.join(root, rel), "utf8");
const hits = bannedBundleHits(text);

if (hits.length) {
  console.error(`banned sanctions phrases in ${rel} (${hits.length}):`);
  for (const hit of hits) console.error(`  ${hit.name}: ${JSON.stringify(hit.sample)}`);
  process.exit(1);
}

console.log(`${rel}: no banned sanctions phrases`);
