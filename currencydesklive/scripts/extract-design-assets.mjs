#!/usr/bin/env node
/* ============================================================
   Pull the design's binary assets — photographs, illustrations
   and web fonts — out of a Claude Design "standalone" export and
   give them the names the .dc.html sources actually reference.

     node scripts/extract-design-assets.mjs <CurrencyDesk_Site_Standalone.html>

   Writes web/photos/, web/assets/ and web/fonts/ (fonts.css plus
   the woff2 files it points at). Run this only when the designer
   re-exports with new imagery — the output is committed, and the
   day-to-day build (scripts/build-site.mjs) just reuses it.

   The export is one enormous line-oriented file: somewhere in it
   is a JSON object mapping asset uuid → {mime, compressed, data},
   and somewhere else the page HTML as a JSON string. Neither has
   a stable line number, so both are found by shape.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SRC = process.argv[2];
if (!SRC) {
  console.error("usage: node scripts/extract-design-assets.mjs <standalone-export.html>");
  process.exit(1);
}
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "web");

/* Which uploaded image belongs where. The export identifies images by
   the <image-slot> they were dropped into; the .dc.html sources name
   the same images by path. This table is the join between the two, and
   is the one piece of knowledge the export itself does not carry. */
const SLOT_TO_FILE = {
  gcRate: "photos/rate-board-storefront.jpg",
  gcSms: "photos/sms-storefront.jpg",
  gcTill: "photos/till-float.jpg",
  gcKyc: "photos/kyc-counter.jpg",
  gcComp: "photos/compliance-institution.jpg",
  gcReport: "photos/reports-ledger.jpg",
  gcCash: "photos/cheque-cashing.jpg",
  gcVault: "photos/vault-count.jpg",
  gcAi: "photos/ai-copilot-guilloche.jpg",
  web1: "assets/site-web-1.jpg",
  web2: "assets/site-web-2.jpg",
  web3: "assets/site-web-3.jpg",
  web4: "assets/site-web-4.jpg",
  web5: "assets/site-web-5.jpg",
};
/* The storefront photo is a plain src= on its slot rather than a drop,
   so it never appears in the slot list — it is the one image uuid that
   shows up inline in the page HTML. */
const STORY_PHOTO = "photos/storefront-team.jpg";

const lines = readFileSync(SRC, "utf8").split("\n");
let assets = null;   // uuid -> {mime, compressed, data}
let slots = null;    // [{id, uuid}]
let html = null;     // the page markup
for (const line of lines) {
  if (line.length < 200) continue;
  const c = line[0];
  if (c === "{" && !assets) {
    try {
      const o = JSON.parse(line);
      if (Object.values(o)[0]?.mime) assets = o;
    } catch {}
  } else if (c === "[" && !slots) {
    try {
      const a = JSON.parse(line);
      if (Array.isArray(a) && a[0]?.id && a[0]?.uuid) slots = a;
    } catch {}
  } else if (c === '"' && !html) {
    try {
      const v = JSON.parse(line);
      if (typeof v === "string" && v.includes("<!DOCTYPE html>")) html = v;
    } catch {}
  }
}
if (!assets) throw new Error("no asset map found in the export");
if (!slots) throw new Error("no image-slot list found in the export");
if (!html) throw new Error("no page HTML found in the export");

const bytesOf = (a) => {
  const buf = Buffer.from(a.data, "base64");
  // every text asset in the export ships gzipped; images generally do not
  return a.compressed ? zlib.gunzipSync(buf) : buf;
};

for (const dir of ["photos", "assets", "fonts"]) {
  rmSync(path.join(OUT, dir), { recursive: true, force: true });
  mkdirSync(path.join(OUT, dir), { recursive: true });
}

/* ---- photographs and illustrations ---- */
let images = 0;
const bySlot = Object.fromEntries(slots.map((s) => [s.id, s.uuid]));
for (const [slot, file] of Object.entries(SLOT_TO_FILE)) {
  const uuid = bySlot[slot];
  if (!uuid) throw new Error(`export has no image for slot "${slot}"`);
  writeFileSync(path.join(OUT, file), bytesOf(assets[uuid]));
  images++;
}
const claimed = new Set(Object.values(bySlot));
const inline = Object.keys(assets).filter(
  (u) => assets[u].mime.startsWith("image/") && !claimed.has(u) && html.includes(u),
);
if (inline.length !== 1) {
  throw new Error(`expected exactly one inline image (the storefront photo), found ${inline.length}`);
}
writeFileSync(path.join(OUT, STORY_PHOTO), bytesOf(assets[inline[0]]));
images++;

/* ---- web fonts ----
   The export inlines Google's stylesheet with every font URL swapped for
   an asset uuid. Lift that stylesheet out whole and repoint it at files
   named after the family and subset they serve. */
const styleStart = html.indexOf("<style>/*");
const styleEnd = html.indexOf("</style>", styleStart);
if (styleStart < 0 || styleEnd < 0) throw new Error("no inlined font stylesheet found");
let css = html.slice(styleStart + "<style>".length, styleEnd);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const used = new Map();
let fonts = 0;
// each @font-face carries the family, weight and (in a leading comment) the subset
css = css.replace(
  /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{[^}]*\}/gi,
  (block, subset) => {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1] ?? "font";
    const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1].trim().replace(/\s+/g, "-") ?? "400";
    // the export rewrites each src url to a bare asset uuid
    const uuid = /url\("?([0-9a-f]{8}-[0-9a-f-]{27})"?\)/.exec(block)?.[1];
    if (!uuid) return block;
    let name = `${slug(family)}-${weight}-${subset}.woff2`;
    // a family can repeat a subset across styles; keep both
    for (let n = 2; used.has(name) && used.get(name) !== uuid; n++) {
      name = `${slug(family)}-${weight}-${subset}-${n}.woff2`;
    }
    if (!used.has(name)) {
      used.set(name, uuid);
      writeFileSync(path.join(OUT, "fonts", name), bytesOf(assets[uuid]));
      fonts++;
    }
    return block.replace(/url\("[^"]*"\)/, `url("/web/fonts/${name}")`);
  },
);
writeFileSync(path.join(OUT, "fonts", "fonts.css"), css.trim() + "\n");

console.log(`extracted ${images} images and ${fonts} font files into web/`);
