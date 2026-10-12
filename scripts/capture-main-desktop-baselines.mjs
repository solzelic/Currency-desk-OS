/* Render the 1280 desktop from the main commit named in tests/e2e/README.md.

   Run inside the browser-seam job, after Chromium is installed the way
   that job installs it. The product files come from that commit. The
   measurement (this branch's desktop-unchanged spec) is what takes the
   picture, so the branch is later compared with the same clock and stubs.
   The product keeps the sign-in card's glass blur. The capture turns
   that filter off, because two renders of main with it on did not
   match (4 pixels at channel delta 1, then 6 pixels at channel delta
   8). The menu-bar dot stays a circle.

   The commit is rendered twice. All 13 pictures have to match at
   every pixel. A laptop render is not a substitute.

   The spec serves Archivo and Space Mono from tests/e2e/fonts, and
   Noto Sans plus DejaVu Sans Mono for → and ≥. The picture does not
   use the runner's fontconfig fallback. The browser zone is UTC, so
   the pinned 15:02Z clock paints 15:02.

   The output directory must not sit inside Playwright's outputDir
   (test-results). Each capture starts a new Playwright run, and that
   run deletes test-results before the spec writes. A picture stored
   there does not survive the second render.

   Usage:
     node scripts/capture-main-desktop-baselines.mjs --out desktop-main-render
     node scripts/capture-main-desktop-baselines.mjs --compare-committed desktop-main-render
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(root, "tests", "e2e", "README.md");
const committedDir = path.join(root, "tests", "e2e", "desktop-unchanged.spec.ts-snapshots");
const require = createRequire(path.join(root, "server", "package.json"));
const { Client } = require("pg");
const { decodePng, diffRgba, exactPixels } = require(path.join(root, "tests", "e2e", "helpers", "desktop-pixels.cjs"));

const SHA_LINE = /^main-sha:\s*([0-9a-f]{40})\s*$/m;

function readPinnedSha() {
  const text = readFileSync(readmePath, "utf8");
  const match = SHA_LINE.exec(text);
  if (!match) throw new Error(`${readmePath} has no main-sha line`);
  return match[1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function quoteIdent(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing database name ${name}`);
  return `"${name}"`;
}

export async function resetSeamDatabase(connectionString) {
  const url = new URL(connectionString);
  const dbName = url.pathname.replace(/^\//, "");
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const ident = quoteIdent(dbName);
    for (let attempt = 0; attempt < 10; attempt++) {
      await client.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      try {
        await client.query(`DROP DATABASE IF EXISTS ${ident}`);
        await client.query(`CREATE DATABASE ${ident}`);
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } finally {
    await client.end();
  }
}

function sameFile(left, right) {
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return hash(left) === hash(right);
}

function linkModules(work) {
  for (const rel of ["package-lock.json", "server/package-lock.json"]) {
    if (!sameFile(path.join(root, rel), path.join(work, rel))) {
      throw new Error(`${rel} on main differs from this branch, so this job's node_modules cannot serve that commit`);
    }
  }
  symlinkSync(path.join(root, "node_modules"), path.join(work, "node_modules"));
  symlinkSync(path.join(root, "server", "node_modules"), path.join(work, "server", "node_modules"));
}

function captureOnce(work, sha, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "main-sha"), `${sha}\n`);
  const result = spawnSync(
    "npx",
    ["playwright", "test", "tests/e2e/desktop-unchanged.spec.ts", "--reporter=line", "--retries=0"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        DESKTOP_MAIN_ROOT: work,
        DESKTOP_BASELINE_FROM: "main",
        DESKTOP_UPDATE_BASELINES: "1",
        DESKTOP_SNAPSHOT_DIR: outDir,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error("the main desktop render failed");
  }
}

function pngNames(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(`no pictures in ${dir}: ${error instanceof Error ? error.message : error}`);
  }
  return names.filter((name) => name.endsWith(".png")).sort();
}

function compareDirs(leftDir, rightDir) {
  const left = pngNames(leftDir);
  const right = pngNames(rightDir);
  const rows = [];
  if (left.join("\n") !== right.join("\n")) {
    rows.push({ name: "(set)", diffPixels: -1, maxDelta: -1, overOne: -1, detail: `names ${left.join(",")} vs ${right.join(",")}` });
    return rows;
  }
  for (const name of left) {
    const a = decodePng(readFileSync(path.join(leftDir, name)));
    const b = decodePng(readFileSync(path.join(rightDir, name)));
    if (a.width !== b.width || a.height !== b.height) {
      rows.push({ name, diffPixels: -1, maxDelta: -1, overOne: -1, detail: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` });
      continue;
    }
    rows.push({ name, ...diffRgba(a.data, b.data) });
  }
  return rows;
}

function exact(rows) {
  return rows.length === 13 && rows.every((row) => exactPixels(row));
}

async function render(outDir) {
  const database = process.env.SEAM_DATABASE_URL;
  if (!database) throw new Error("SEAM_DATABASE_URL is required");
  const sha = readPinnedSha();
  run("git", ["fetch", "--depth=1", "origin", sha]);
  const work = mkdtempSync(path.join(tmpdir(), "main-desktop-"));
  try {
    run("git", ["worktree", "add", "--detach", work, sha]);
    linkModules(work);
    const again = path.join(path.dirname(outDir), `${path.basename(outDir)}-again`);
    await resetSeamDatabase(database);
    captureOnce(work, sha, outDir);
    await resetSeamDatabase(database);
    captureOnce(work, sha, again);
    const rows = compareDirs(outDir, again);
    writeFileSync(path.join(outDir, "stability.json"), JSON.stringify({ sha, rows }, null, 2));
    rmSync(again, { recursive: true, force: true });
    if (!exact(rows)) {
      console.error(JSON.stringify(rows, null, 2));
      throw new Error("two renders of main did not match. The pictures are not stable enough to commit.");
    }
    const signIn = rows.find((row) => String(row.name).startsWith("sign-in-1280"));
    console.log(
      `main ${sha} rendered twice, 13 pictures. sign-in: ${signIn ? signIn.diffPixels : "missing"} pixels, max channel delta ${signIn ? signIn.maxDelta : "missing"}. every other picture is exact.`,
    );
    await resetSeamDatabase(database);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", work], { cwd: root, stdio: "inherit" });
    rmSync(work, { recursive: true, force: true });
  }
}

function compareCommitted(freshDir) {
  const sha = readPinnedSha();
  const rendered = readFileSync(path.join(freshDir, "main-sha"), "utf8").trim();
  if (rendered !== sha) {
    throw new Error(`render is ${rendered}, tests/e2e/README.md pins ${sha}`);
  }
  const rows = compareDirs(freshDir, committedDir);
  writeFileSync(path.join(freshDir, "committed-compare.json"), JSON.stringify({ sha, rows }, null, 2));
  if (!exact(rows)) {
    console.error(JSON.stringify(rows, null, 2));
    throw new Error("committed desktop pictures are not the render of the pinned main commit");
  }
  console.log(`committed pictures match main ${sha}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const compareAt = process.argv.indexOf("--compare-committed");
  if (compareAt !== -1) {
    compareCommitted(path.resolve(root, process.argv[compareAt + 1]));
  } else {
    const outAt = process.argv.indexOf("--out");
    if (outAt === -1) throw new Error("pass --out <dir> or --compare-committed <dir>");
    await render(path.resolve(root, process.argv[outAt + 1]));
  }
}
