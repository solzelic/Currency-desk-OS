/* Prove the desktop pixel rule still sees a ledger change.

   Two breaks, each alone, against the pictures of main. The file is
   restored either way. A passing spec means the rule is too loose.

   1. The ledger window body moves down 1px.
   2. The ledger folder bar changes colour.

   The failure has to name ledger-1280 and a channel delta above 1.
   A 1-level antialiasing cap must not hide either break.
*/
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetSeamDatabase } from "./capture-main-desktop-baselines.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(root, "os-src", "york-os.css");
const original = readFileSync(cssPath, "utf8");

const BREAKS = [
  {
    id: "1px-layout-shift",
    css: [
      "/* desktop-break-proof: ledger body, 1px down. Not part of the product. */",
      "#desktop .win[data-app=\"ledger\"] .win-body { position: relative; top: 1px !important; }",
      "",
    ].join("\n"),
  },
  {
    id: "ledger-colour",
    css: [
      "/* desktop-break-proof: ledger folder bar, a different colour. Not part of the product. */",
      "#desktop .win[data-app=\"ledger\"] .fld-bar {",
      "  background: #b42318 !important;",
      "  border-bottom-color: #b42318 !important;",
      "}",
      "",
    ].join("\n"),
  },
];

const PIXEL_LINE = /ledger-1280\.png: (\d+) pixels differ, max channel delta (\d+), (\d+) pixels exceed 1 level, cap (\d+)/;

function shoot() {
  return spawnSync(
    "npx",
    ["playwright", "test", "tests/e2e/desktop-unchanged.spec.ts", "--reporter=line", "--retries=0"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        DESKTOP_ONLY: "ledger",
        DESKTOP_UPDATE_BASELINES: "",
        DESKTOP_BASELINE_FROM: "",
        DESKTOP_MAIN_ROOT: "",
        DESKTOP_SNAPSHOT_DIR: "",
      },
    },
  );
}

try {
  if (!process.env.SEAM_DATABASE_URL) throw new Error("SEAM_DATABASE_URL is required");
  if (!process.env.DESKTOP_BASELINE_DIR) throw new Error("DESKTOP_BASELINE_DIR is required");
  const results = [];
  for (const item of BREAKS) {
    writeFileSync(cssPath, `${original}\n${item.css}`);
    await resetSeamDatabase(process.env.SEAM_DATABASE_URL);
    const run = shoot();
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    const match = PIXEL_LINE.exec(output);
    const row = {
      id: item.id,
      exitCode: run.status,
      diffPixels: match ? Number(match[1]) : null,
      maxChannelDelta: match ? Number(match[2]) : null,
      overOne: match ? Number(match[3]) : null,
      cap: match ? Number(match[4]) : null,
      tail: output.split("\n").slice(-40).join("\n"),
    };
    results.push(row);
    const caught = row.exitCode !== 0 && row.maxChannelDelta !== null && row.maxChannelDelta > 1;
    if (!caught) {
      mkdirSync(path.join(root, "test-results"), { recursive: true });
      writeFileSync(path.join(root, "test-results", "desktop-break-proof.json"), JSON.stringify(results, null, 2));
      throw new Error(`${item.id} did not turn the ledger picture red with a channel delta above 1`);
    }
    console.log(`${item.id}: red, ${row.diffPixels} pixels, max channel delta ${row.maxChannelDelta}, cap ${row.cap}`);
  }
  mkdirSync(path.join(root, "test-results"), { recursive: true });
  writeFileSync(path.join(root, "test-results", "desktop-break-proof.json"), JSON.stringify(results, null, 2));
} finally {
  writeFileSync(cssPath, original);
}
