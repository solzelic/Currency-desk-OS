#!/usr/bin/env node
/* Fails if a served marketing page repeats a claim the live product
   does not make. Scans the built HTML only. The app bundle and the
   onboarding page are out of this check. */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "web/index.html",
  "web/mobile.html",
  "web/compliance.html",
  "web/faq.html",
  "web/early-access.html",
  "web/legal.html",
  "web/contact.html",
];

const phrases = [
  [/OFAC/i, "OFAC"],
  [/desks claimed/i, "desks claimed"],
  [/Report ready/i, "Report ready"],
  [/then deleted/i, "then deleted"],
  [/encrypted at rest/i, "encrypted at rest"],
  [/encryption at rest/i, "encryption at rest"],
  [/in the region you operate/i, "in the region you operate"],
];

function nearby(html, needle, other, span) {
  const hits = [];
  const re = new RegExp(needle, "g");
  let m;
  while ((m = re.exec(html))) {
    const from = Math.max(0, m.index - span);
    const to = Math.min(html.length, m.index + needle.length + span);
    const slice = html.slice(from, to);
    if (slice.includes(other)) hits.push(slice.replace(/\s+/g, " ").slice(0, 220));
  }
  return hits;
}

const problems = [];
for (const rel of files) {
  const html = readFileSync(path.join(root, rel), "utf8");
  for (const [re, label] of phrases) {
    if (re.test(html)) problems.push(`${rel}: ${label}`);
    re.lastIndex = 0;
  }
  for (const hit of nearby(html, "EFTR", "Live", 80)) {
    problems.push(`${rel}: EFTR next to Live (${hit})`);
  }
  for (const hit of nearby(html, "STR", "Live", 80)) {
    problems.push(`${rel}: STR next to Live (${hit})`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok ${files.length} marketing pages`);
