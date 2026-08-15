#!/usr/bin/env node
/* ============================================================
   Seam-suite completeness check.

   The defect this prevents: for weeks CI reported the browser gate
   green while 13 of 17 seam specs — including the deployment gate —
   silently skipped, because SEAM_DATABASE_URL was absent and every
   file begins with `test.skip(!hasLedger, …)`. A skipped critical
   test must be loud, not green.

   Reads a Playwright JSON report and fails when:
     1. any spec FILE executed zero tests (the whole file skipped —
        exactly the missing-database failure mode), or
     2. the deployment gate (zz-a-day-at-the-desk.spec.ts) did not
        execute at least one test.

   Individual in-file conditional skips (e.g. cash-seam's "vault
   opening position is covered by the vault suite") are legitimate
   data-dependent guards: they are PRINTED so they are visible, but
   they do not fail the check.

   Usage: node scripts/check-seam-ran.mjs <playwright-report.json>
   ============================================================ */
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/check-seam-ran.mjs <playwright-report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));

/* Walk the suite tree; collect per-file executed/skipped test counts. */
const files = new Map(); // file -> { executed, skipped, skippedTitles: [] }
function visit(suite, file) {
  const f = suite.file ?? file;
  for (const spec of suite.specs ?? []) {
    const entry = files.get(spec.file ?? f) ?? { executed: 0, skipped: 0, skippedTitles: [] };
    for (const t of spec.tests ?? []) {
      const statuses = (t.results ?? []).map((r) => r.status);
      const ranSomething = statuses.some((s) => s && s !== "skipped");
      if (ranSomething) entry.executed += 1;
      else {
        entry.skipped += 1;
        entry.skippedTitles.push(spec.title);
      }
    }
    files.set(spec.file ?? f, entry);
  }
  for (const child of suite.suites ?? []) visit(child, f);
}
for (const s of report.suites ?? []) visit(s, s.file);

if (files.size === 0) {
  console.error("seam-check: FAILED — the report contains no test files at all.");
  process.exit(1);
}

let failed = false;
const GATE = "zz-a-day-at-the-desk.spec.ts";
let gateSeen = false;

for (const [file, { executed, skipped, skippedTitles }] of [...files.entries()].sort()) {
  const short = file.split("/").pop();
  if (short === GATE) gateSeen = executed > 0;
  if (executed === 0) {
    failed = true;
    console.error(`seam-check: FAILED — ${short}: every test skipped (${skipped}). ` +
      `This is the missing-SEAM_DATABASE_URL signature; the gate must not be green.`);
  } else if (skipped > 0) {
    console.warn(`seam-check: note — ${short}: ${executed} executed, ${skipped} conditionally skipped:`);
    for (const t of skippedTitles) console.warn(`    · ${t}`);
  } else {
    console.log(`seam-check: ok — ${short}: ${executed} executed`);
  }
}

if (!gateSeen) {
  failed = true;
  console.error(`seam-check: FAILED — the deployment gate ${GATE} did not execute.`);
}

process.exit(failed ? 1 : 0);
