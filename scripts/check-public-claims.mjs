#!/usr/bin/env node
/* Fails if a served public page repeats a claim the live product does
   not make. Tags are stripped, entities decoded, whitespace collapsed
   and the text lowercased before a match, so a tag, a line break or
   a non-breaking space cannot hide a phrase. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "web/index.html",
  "web/mobile.html",
  "web/compliance.html",
  "web/faq.html",
  "web/early-access.html",
  "web/legal.html",
  "web/contact.html",
  "web/onboarding.html",
];

const phrases = [
  [/ofac/, "OFAC"],
  [/desks claimed/, "desks claimed"],
  [/report ready/, "Report ready"],
  [/then deleted/, "then deleted"],
  [/encrypted at rest/, "encrypted at rest"],
  [/encryption at rest/, "encryption at rest"],
  [/in the region you operate/, "in the region you operate"],
  [/real shops/, "real shops"],
  [/billed per file/, "billed per file"],
  [/identity verification/, "identity verification"],
  [/error monitoring/, "error monitoring"],
  [/measured at the counter/, "measured at the counter"],
  [/first shop/, "first shop"],
];

export function visibleText(html) {
  let text = String(html);
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  const named = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  text = text.replace(/&([a-z]+);/gi, (all, name) =>
    Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : all,
  );
  /* A second pass catches &amp;nbsp; once it has become &nbsp;. */
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/<[^>]*>/g, " ");
  text = text.replace(/\s+/g, " ").trim().toLowerCase();
  return text;
}

function nearby(text, needle, other, span) {
  const hits = [];
  const re = new RegExp(`\\b${needle}\\b`, "g");
  const otherRe = new RegExp(`\\b${other}\\b`);
  let match;
  while ((match = re.exec(text))) {
    const from = Math.max(0, match.index - span);
    const to = Math.min(text.length, match.index + match[0].length + span);
    const slice = text.slice(from, to);
    if (otherRe.test(slice)) hits.push(slice.slice(0, 220));
  }
  return hits;
}

export function findClaims(html) {
  const text = visibleText(html);
  const problems = [];
  for (const [re, label] of phrases) {
    if (re.test(text)) problems.push(label);
    re.lastIndex = 0;
  }
  for (const hit of nearby(text, "eftr", "live", 80)) {
    problems.push(`EFTR next to Live (${hit})`);
  }
  for (const hit of nearby(text, "str", "live", 80)) {
    problems.push(`STR next to Live (${hit})`);
  }
  return problems;
}

export function checkFiles(rels, read = (rel) => readFileSync(path.join(root, rel), "utf8")) {
  const problems = [];
  for (const rel of rels) {
    for (const problem of findClaims(read(rel))) problems.push(`${rel}: ${problem}`);
  }
  return problems;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  if (process.argv[2] === "--probe") {
    const problems = findClaims(process.argv[3] ?? "");
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log("ok probe");
    process.exit(0);
  }
  const problems = checkFiles(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ok ${files.length} marketing pages`);
}
