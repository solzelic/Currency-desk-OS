#!/usr/bin/env node
/* Fails if app source or the built desk still says the fee is included.
   Tags are stripped, a non-breaking space becomes a space, whitespace
   collapses, and the text is lowercased, so a tag or a line break
   cannot hide "Includes ... fee". */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pattern = /\bincludes\s.{0,80}\bfee\b/g;

function walk(dir, out) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|html|mjs)$/.test(name)) out.push(full);
  }
}

export function appFiles() {
  const files = [];
  walk(path.join(root, "os-src"), files);
  walk(path.join(root, "web", "app"), files);
  for (const rel of ["CurrencyDesk OS.html", "admin.html"]) files.push(path.join(root, rel));
  return files;
}

export function visibleText(raw) {
  return String(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function includesFeeHits(raw) {
  const text = visibleText(raw);
  return [...text.matchAll(pattern)].map((hit) => hit[0].slice(0, 120));
}

export function scanIncludesFee(read = (file) => readFileSync(file, "utf8")) {
  const problems = [];
  for (const file of appFiles()) {
    const rel = path.relative(root, file);
    for (const hit of includesFeeHits(read(file))) problems.push(`${rel}: ${hit}`);
  }
  return problems;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  if (process.argv[2] === "--probe") {
    const hits = includesFeeHits(process.argv[3] ?? "");
    if (hits.length) {
      console.error(hits.join("\n"));
      process.exit(1);
    }
    console.log("ok probe");
  } else {
    const problems = scanIncludesFee();
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`ok ${appFiles().length} files`);
  }
}
