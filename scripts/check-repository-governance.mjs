#!/usr/bin/env node
/* ============================================================
   Repository governance check — documentation freshness at the
   PR level.

   The rule (CONTRIBUTING.md, AGENTS.md): a change-set that alters
   application code must either update docs/PROJECT_STATE.md or
   explicitly record that it was reviewed and needed no change; a
   change-set that alters architecture-sensitive surfaces must do
   the same for the architecture/repository docs.

   The "reviewed — no change required" record is a checked box in
   the PR body (from .github/pull_request_template.md), which CI
   passes in via the PR_BODY environment variable. That makes the
   review a visible, reviewable claim on the PR — without forcing
   meaningless whitespace edits into the docs.

   Usage:
     node scripts/check-repository-governance.mjs --base origin/main
   Env:
     PR_BODY   the pull-request body (set by the workflow)

   Exit 0 = compliant. Exit 1 = violation, with instructions.
   Docs-only change-sets always pass.
   ============================================================ */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = baseIdx !== -1 ? args[baseIdx + 1] : "origin/main";
const prBody = process.env.PR_BODY ?? "";

const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (changed.length === 0) {
  console.log(`governance: no changes against ${base} — nothing to check.`);
  process.exit(0);
}

/* Documentation and metadata never require themselves. */
const isDoc = (f) =>
  f.startsWith("docs/") ||
  f.endsWith(".md") ||
  f.startsWith("design/kyc-handoff/") ||
  f === ".gitignore" ||
  f === ".nvmrc" ||
  f === "LICENSE";

/* Tests prove reality rather than changing it; a tests-only PR does not
   force a PROJECT_STATE edit. (It may still trip the architecture rule
   below if it touches workflows or configs.) */
const isTest = (f) => f.startsWith("server/tests/") || f.startsWith("tests/");

/* Meaningful application code — the product, its build, its deployment. */
const isAppCode = (f) =>
  !isDoc(f) &&
  !isTest(f) &&
  (f.startsWith("server/src/") ||
    f.startsWith("os-src/") ||
    f.startsWith("web/") ||
    f.startsWith("YorkFX/") ||
    f.startsWith("design/") ||
    f.startsWith("scripts/") ||
    f === "admin.html" ||
    f === "CurrencyDesk OS.html" ||
    f === "CurrencyDesk Onboarding.html" ||
    f === "yorkfx.css" ||
    f === "yorkfx-converter.js" ||
    f === "render.yaml" ||
    f === "package.json" ||
    f === "server/package.json" ||
    f === "playwright.config.ts");

/* Architecture-sensitive surfaces: runtime topology, static routing, build
   pipeline, deployment contract, CI, and the migration MECHANISM (individual
   migration files are ordinary app code; the runner is architecture). */
const isArchSensitive = (f) =>
  f === "server/src/app.ts" ||
  f === "server/src/index.ts" ||
  f === "server/src/sites.ts" ||
  f === "server/src/db/index.ts" ||
  f === "server/src/db/migrations.ts" ||
  f === "render.yaml" ||
  f === "package.json" ||
  f === "server/package.json" ||
  f === "playwright.config.ts" ||
  f === "server/vitest.config.ts" ||
  f.startsWith(".github/workflows/") ||
  (f.startsWith("scripts/") && !f.startsWith("scripts/check-"));

const ARCH_DOCS = [
  "docs/REPOSITORY_MAP.md",
  "docs/ARCHITECTURE.md",
  "docs/ROAD_TO_DEPLOYMENT.md",
  "README.md",
  "CONTRIBUTING.md",
];

/* A checked box in the PR body. Tolerant of dash variants and extra text
   after the phrase, strict about being CHECKED — an empty box is not a
   review. */
const checkedBox = (phrase) =>
  new RegExp(String.raw`^\s*[-*]\s*\[[xX]\]\s*${phrase}`, "m").test(prBody);
const stateMarker = checkedBox(String.raw`PROJECT_STATE reviewed\s*[—–-]+\s*no change required`);
const archMarker = checkedBox(String.raw`Architecture docs reviewed\s*[—–-]+\s*no change required`);

const appCode = changed.filter(isAppCode);
const archCode = changed.filter(isArchSensitive);
const touchedState = changed.includes("docs/PROJECT_STATE.md");
const touchedArchDocs = ARCH_DOCS.filter((d) => changed.includes(d));

let failures = [];

if (appCode.length > 0 && !touchedState && !stateMarker) {
  failures.push(
    `This change-set modifies application code:\n` +
      appCode.slice(0, 15).map((f) => `    ${f}`).join("\n") +
      (appCode.length > 15 ? `\n    … and ${appCode.length - 15} more` : "") +
      `\n\n  but docs/PROJECT_STATE.md was not updated and the PR body does not` +
      `\n  contain the checked box "PROJECT_STATE reviewed — no change required".` +
      `\n  Either update the living state document or check that box to record` +
      `\n  the review. (The box is in .github/pull_request_template.md.)`
  );
}

if (archCode.length > 0 && touchedArchDocs.length === 0 && !archMarker) {
  failures.push(
    `This change-set modifies architecture-sensitive surfaces:\n` +
      archCode.map((f) => `    ${f}`).join("\n") +
      `\n\n  but none of ${ARCH_DOCS.join(", ")}` +
      `\n  was updated, and the PR body does not contain the checked box` +
      `\n  "Architecture docs reviewed — no change required".`
  );
}

if (failures.length > 0) {
  console.error("governance: FAILED\n");
  for (const f of failures) console.error("• " + f + "\n");
  console.error(
    "The purpose is not bureaucracy: it is making it hard to change reality\n" +
      "while leaving the repository's description of reality behind."
  );
  process.exit(1);
}

console.log(
  `governance: ok — ${changed.length} changed file(s); ` +
    (appCode.length
      ? touchedState
        ? "PROJECT_STATE updated."
        : "PROJECT_STATE review recorded in the PR body."
      : "no application code changed.") +
    (archCode.length
      ? touchedArchDocs.length
        ? ` Architecture docs updated: ${touchedArchDocs.join(", ")}.`
        : " Architecture-doc review recorded in the PR body."
      : "")
);
