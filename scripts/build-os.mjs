#!/usr/bin/env node
/* ============================================================
   Compile the OS and the panel, so a customer's browser does not.

     node scripts/build-os.mjs        →  web/app/index.html
                                         web/app/admin.html
                                         web/app/os.js
                                         web/app/admin.js
                                         web/app/quote-terms.min.js

   WHY

   Both apps were written buildless: plain .jsx in <script type="text/babel">,
   compiled in the visitor's browser on every single page load. That is a
   lovely way to work and a miserable thing to open. Opening the desk meant:

     · fetch three megabytes of Babel from unpkg
     · fetch 27 separate .jsx files, 1.6 MB of them
     · compile all of it on the main thread, with a blank screen up

   Measured on this machine: five seconds with the CDN close by, and
   eighty-five when it was not. A currency shop on a bad connection watches
   a white page while a customer stands at the counter.

   None of that work is per-visitor. It is the same 1.6 MB compiled to the
   same output every time, so it happens once, here, and what ships is
   ordinary JavaScript. Babel does not go to the browser at all.

   WHAT THIS DOES NOT CHANGE

   The sources stay exactly as they were — os-src/*.jsx and admin.html are
   still hand-written JSX and still the thing you edit. This reads them,
   compiles them in the order the page declared, and writes the result
   beside the other built pages in web/. Same arrangement the design pages
   already use, and CI already fails when web/ is stale.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/standalone";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "web", "app");
mkdirSync(OUT, { recursive: true });

const compile = (code, filename) =>
  babel.transform(code, { presets: ["react"], filename, sourceType: "script" }).code;

/* Every <script> the page runs, in order, with what it is.

   Order matters more than usual here: these files declare globals for one
   another rather than importing, so cdos-base has to run before cdos-till
   the same way it does today. Reading the tags rather than a hand-kept list
   is what keeps that true — add a screen to the page and this picks it up. */
function scripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [whole, attrs, body] = m;
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1] || null;
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    out.push({ whole, src, type, body, jsx: /babel|jsx/i.test(type), at: m.index });
  }
  return out;
}

const VENDOR = {
  react: "/web/vendor/react.production.min.js",
  "react-dom": "/web/vendor/react-dom.production.min.js",
};

/* React comes off our own domain too.

   Not a performance footnote — it is the same argument as Babel. A desk
   that cannot open because unpkg is having a morning is not a desk. No
   integrity hash on these, on purpose: SRI guards against a CDN serving
   something other than what was published, and these are our own files.
   A hash would only mean the page dies silently at the next version bump.
   `npm run build:site` writes web/vendor straight out of node_modules. */
function localVendor(html) {
  return html
    .replace(/<script src="https:\/\/unpkg\.com\/react@[^"]*"[^>]*><\/script>/,
      `<script src="${VENDOR.react}"></script>`)
    .replace(/<script src="https:\/\/unpkg\.com\/react-dom@[^"]*"[^>]*><\/script>/,
      `<script src="${VENDOR["react-dom"]}"></script>`)
    // Babel is gone entirely — that is the point of this script
    .replace(/\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]*"[^>]*><\/script>/, "")
    .replace("<!-- React + Babel (pinned) -->", "<!-- React, from our own domain. Babel is not here: the JSX was compiled by scripts/build-os.mjs. -->");
}

const banner = (name) =>
  `/* Built from source by scripts/build-os.mjs — do not edit.\n` +
  `   Edit ${name} instead, then run: npm run build:os */\n`;


/* Quote arithmetic for the browser, one small file.

   os.js and admin.js stay the concatenation this script has always
   written. Minifying those two is a separate job. decimal.js is not
   copied into the repo and not pasted into the desk script. This
   bundles the server's decimal.js with os-src/quote-terms.js and
   minifies only that result. The page loads it with defer, ahead of
   os.js. */
function writeQuoteTerms() {
  const decimalSrc = path.join(ROOT, "server", "node_modules", "decimal.js", "decimal.js");
  if (!existsSync(decimalSrc)) {
    throw new Error("server/node_modules/decimal.js/decimal.js is missing — run npm ci in server/");
  }
  const result = esbuild.buildSync({
    stdin: {
      contents: [
        'import Decimal from "decimal.js";',
        'import quoteTerms from "./os-src/quote-terms.js";',
        "const root = globalThis;",
        "root.Decimal = Decimal;",
        "const api = typeof quoteTerms.create === \"function\" ? quoteTerms : quoteTerms.default;",
        "if (!api || typeof api.create !== \"function\") throw new Error(\"quote terms did not export create\");",
        "const cdos = root.CDOS || (root.CDOS = {});",
        "cdos.quoteTerms = api.create(Decimal);",
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "quote-terms-entry.js",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    write: false,
    nodePaths: [path.join(ROOT, "server", "node_modules")],
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  if (!code.includes("quoteTerms")) throw new Error("quote-terms.min.js did not keep quoteTerms");
  writeFileSync(path.join(OUT, "quote-terms.min.js"), code);
  return Buffer.byteLength(code);
}

let built = 0;

// ---- Tailwind, compiled here instead of in the customer's browser --------
/* The source shell loads the Play CDN — a Tailwind COMPILER that scans the
   DOM and generates CSS on every page load, from a third-party host. The
   last off-domain request the OS made, and the worst kind: we watched the
   desk open with that host blocked and only the sign-in screen survived.

   Same classes, compiled once, 16 KB minified. The source keeps the CDN tag
   so the buildless dev flow still works; the BUILT shell gets this file.
   Config and the reasoning live in scripts/tailwind.config.cjs. */
{
  const bin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss");
  execFileSync(bin, [
    "-c", path.join(ROOT, "scripts", "tailwind.config.cjs"),
    "-i", path.join(ROOT, "scripts", "tw-input.css"),
    "-o", path.join(OUT, "tw.css"),
    "--minify",
  ], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  const size = readFileSync(path.join(OUT, "tw.css")).length;
  /* A quarter of today's size means the scan silently found nothing — a
     moved directory, a renamed config — and the desk would ship unstyled
     while every gate stayed green. Fail here instead. */
  if (size < 8 * 1024) throw new Error(`web/app/tw.css is ${size} bytes — the Tailwind scan found almost nothing`);
  console.log(`  web/app/tw.css        ${Math.round(size / 1024)} KB (replaces the Play CDN compiler)`);
}

/* Swap the CDN compiler for the built stylesheet, IN PLACE — the Play CDN
   injected its generated <style> at the script's own position in <head>,
   before yorkfx.css and york-os.css, so those keep winning conflicts
   exactly as they do today. Moving this link later in the head would
   silently flip the cascade. */
const localTailwind = (html) =>
  html.replace(
    /<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/,
    '<link rel="stylesheet" href="/web/app/tw.css" />',
  );

// ---- the OS -------------------------------------------------------------
{
  const file = path.join(ROOT, "CurrencyDesk OS.html");
  let html = readFileSync(file, "utf8");
  const all = scripts(html);
  const ours = all.filter((s) => (s.src && s.src.startsWith("os-src/")) || (!s.src && s.jsx));
  if (ours.length === 0) throw new Error("CurrencyDesk OS.html: found no app scripts to compile");

  const quoteBytes = writeQuoteTerms();
  console.log(`  web/app/quote-terms.min.js  ${quoteBytes} bytes`);

  const parts = [banner("os-src/*.jsx")];
  for (const s of ours) {
    /* The arithmetic ships as quote-terms.min.js, loaded ahead of this
       file. Concatenating it here would run it before that file and
       stop the desk. */
    if (s.src === "os-src/quote-terms.js") continue;
    if (s.src) {
      const p = path.join(ROOT, s.src);
      const code = readFileSync(p, "utf8");
      parts.push(`\n/* ---- ${s.src} ---- */\n` + (s.jsx ? compile(code, s.src) : code));
    } else {
      parts.push(`\n/* ---- inline ---- */\n` + compile(s.body, "CurrencyDesk OS.html"));
    }
  }
  writeFileSync(path.join(OUT, "os.js"), parts.join("\n"));

  /* Replace the whole run of them with one tag, in the place the first one
     stood — so anything the page does before or after still happens in the
     same order. */
  const first = ours[0].whole;
  html = localTailwind(localVendor(html));
  if (html.includes("cdn.tailwindcss.com")) throw new Error("the built OS shell still points at the Tailwind CDN");
  for (const s of ours) html = html.replace(s.whole, s.whole === first ? " BUNDLE " : "");
  html = html.replace(" BUNDLE ", '<script src="/web/app/os.js"></script>');
  // tidy the blank lines the removals left behind
  html = html.replace(/\n{3,}/g, "\n\n");
  writeFileSync(path.join(OUT, "index.html"), html);
  console.log(`  web/app/os.js         ${ours.length} scripts, ${Math.round(readFileSync(path.join(OUT, "os.js")).length / 1024)} KB`);
  built++;
}

// ---- the platform panel -------------------------------------------------
{
  const file = path.join(ROOT, "admin.html");
  let html = readFileSync(file, "utf8");
  const ours = scripts(html).filter((s) => !s.src && s.jsx);
  if (ours.length === 0) throw new Error("admin.html: found no JSX to compile");

  const parts = [banner("admin.html")];
  for (const s of ours) parts.push(compile(s.body, "admin.html"));
  writeFileSync(path.join(OUT, "admin.js"), parts.join("\n"));

  const first = ours[0].whole;
  html = localVendor(html);
  for (const s of ours) html = html.replace(s.whole, s.whole === first ? " BUNDLE " : "");
  html = html.replace(" BUNDLE ", '<script src="/web/app/admin.js"></script>');
  html = html.replace(/\n{3,}/g, "\n\n");
  writeFileSync(path.join(OUT, "admin.html"), html);
  console.log(`  web/app/admin.js      ${ours.length} script, ${Math.round(readFileSync(path.join(OUT, "admin.js")).length / 1024)} KB`);
  built++;
}

console.log(`${built} apps compiled. Nothing in web/app is edited by hand.`);
