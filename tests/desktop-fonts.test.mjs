/* The 1280 picture's faces live on disk. Run with:
   node --test tests/desktop-fonts.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e", "fonts");
const css = readFileSync(path.join(dir, "desk-faces.css"), "utf8");

test("desk faces are local woff2 and name the weights the desk uses", () => {
  const body = css.replace(/^\/\*[\s\S]*?\*\//, "");
  assert.equal(body.includes("fonts.gstatic.com"), false);
  assert.equal(body.includes("fonts.googleapis.com"), false);
  assert.equal(/url\(\s*https?:/.test(body), false);
  assert.equal(css.includes("font-display: swap"), false);
  assert.match(css, /font-display: block/);

  const urls = [...css.matchAll(/url\(\/e2e-fonts\/([A-Za-z0-9._-]+\.woff2)\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 9);
  const onDisk = new Set(readdirSync(dir).filter((name) => name.endsWith(".woff2")));
  assert.deepEqual(new Set(urls), onDisk);
  for (const name of onDisk) {
    const bytes = readFileSync(path.join(dir, name));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2", name);
  }

  for (const weight of [400, 500, 600, 700, 800, 900]) {
    assert.match(css, new RegExp(`font-family: 'Archivo';[\\s\\S]*?font-weight: ${weight};`));
  }
  for (const weight of [400, 700]) {
    assert.match(css, new RegExp(`font-family: 'Space Mono';[\\s\\S]*?font-weight: ${weight};`));
  }
  assert.match(readFileSync(path.join(dir, "OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE/);
});

/* Chromium reports a face it cannot decode as a network error, and
   then document.fonts.load rejects the whole family. The first Noto
   Sans symbol files were valid WOFF2 with an empty cmap, so every
   Archivo weight failed that way. */
function payloadHasArrows(file) {
  const buf = readFileSync(file);
  for (let offset = 48; offset < buf.length; offset++) {
    let raw;
    try {
      raw = brotliDecompressSync(buf.subarray(offset));
    } catch {
      continue;
    }
    if (raw.length < 100) continue;
    const has = (code) => {
      const hi = (code >> 8) & 0xff;
      const lo = code & 0xff;
      for (let i = 0; i < raw.length - 1; i++) {
        if (raw[i] === hi && raw[i + 1] === lo) return true;
      }
      return false;
    };
    if (has(0x2192) && has(0x2265)) return true;
  }
  return false;
}

test("symbol faces carry the arrow and the greater-or-equal sign", () => {
  for (const name of [
    "desk-symbols-sans-400.woff2",
    "desk-symbols-sans-700.woff2",
    "desk-symbols-mono-400.woff2",
    "desk-symbols-mono-700.woff2",
  ]) {
    assert.equal(payloadHasArrows(path.join(dir, name)), true, name);
  }
});
