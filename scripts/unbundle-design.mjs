#!/usr/bin/env node
/* ============================================================
   Turn a Claude Design "standalone" export back into a source
   document this repo can build.

     node scripts/unbundle-design.mjs <export.html> "design/site/CurrencyDesk Early Access.dc.html"

   WHY THIS EXISTS

   The designer can hand over a page in two shapes. A plain .dc.html
   is ordinary markup and builds as-is. A STANDALONE export is that
   same document wrapped for offline viewing: the source is a JSON
   string in <script type="__bundler/template">, and every external
   reference — the dc runtime, each web font — has been rewritten to
   a bare uuid resolved from an asset map inside the bundle.

   Dropped into design/site/ unchanged, that export looks right and
   does nothing: the uuid the runtime used to live at 404s, no
   bindings evaluate, and the page renders every step at once with
   {{ email }} showing in the input. Which is a confusing enough
   failure to be worth a script rather than a memory.

   So: unwrap the template, point the runtime back at support.js,
   and drop the inlined @font-face block — the same families are
   already self-hosted in web/fonts/ and the build swaps the Google
   stylesheet for them. Nothing else is touched, so the diff against
   the previous export is the designer's actual changes.
   ============================================================ */
import { readFileSync, writeFileSync } from "node:fs";

const [, , SRC, OUT] = process.argv;
if (!SRC || !OUT) {
  console.error('usage: node scripts/unbundle-design.mjs <export.html> <out.dc.html>');
  process.exit(1);
}

const raw = readFileSync(SRC, "utf8");

/* A plain .dc.html needs none of this. Say so rather than failing at a
   regex — being handed either shape is normal. */
const tpl = raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
if (!tpl) {
  if (!raw.includes("<x-dc>")) {
    console.error("not a Claude Design document: no bundled template and no <x-dc> root");
    process.exit(1);
  }
  writeFileSync(OUT, raw);
  console.log(`${OUT}\n  plain .dc.html — copied as-is`);
  process.exit(0);
}

let src = JSON.parse(tpl[1]);
const before = src.length;

/* The runtime. One script tag, rewritten by the bundler to a uuid. This
   is the failure that matters: without it nothing on the page binds. */
const runtime = src.match(/<script src="([0-9a-f-]{36})"><\/script>/);
if (!runtime) {
  console.error("no bundled runtime <script src=uuid> found — has the export format changed?");
  process.exit(1);
}
src = src.replace(runtime[0], '<script src="./support.js"></script>');

/* The fonts. Bundling REPLACES the Google stylesheet link with an
   inlined @font-face block whose every src is a uuid — so dropping the
   block without putting the link back leaves a page with no fonts at
   all, which is a worse bug than the one being fixed and a quieter one.

   Put back exactly what a plain export carries. The build then swaps it
   for our self-hosted copies in web/fonts, as it does for every other
   page, and the document ends up in the same shape either way. */
const GOOGLE_LINK =
  '  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1' +
  '&amp;family=Schibsted+Grotesk:ital,wght@0,400..900;1,400..900' +
  '&amp;family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600&amp;display=swap" rel="stylesheet">\n';

const faces = (src.match(/@font-face\s*\{[^}]*\}/g) || []).filter((f) => /url\("[0-9a-f-]{36}"\)/.test(f));
for (const f of faces) src = src.replace(f, "");
// the "/* latin */" subset comments the block was interleaved with
src = src.replace(/\/\* [a-z-]+ \*\/\s*/g, "");

if (faces.length && !src.includes("fonts.googleapis.com/css2")) {
  const anchor = '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">\n';
  if (!src.includes(anchor)) {
    console.error("cannot restore the font stylesheet: the preconnect it goes after is not there");
    process.exit(1);
  }
  src = src.replace(anchor, anchor + GOOGLE_LINK);
}

/* Anything still pointing at a uuid would 404 at runtime. Images belong
   in web/photos via extract-design-assets.mjs, so name them rather than
   letting them fail quietly in a browser nobody is watching. */
const leftover = [...new Set((src.match(/["'(]([0-9a-f]{8}-[0-9a-f-]{27})["')]/g) || []))];
if (leftover.length) {
  console.warn(`  ! ${leftover.length} unresolved asset reference(s) remain — run extract-design-assets.mjs if these are images`);
}

writeFileSync(OUT, src);
console.log(`${OUT}\n  unbundled ${before} chars, runtime restored, ${faces.length} inlined @font-face rule(s) dropped`);
