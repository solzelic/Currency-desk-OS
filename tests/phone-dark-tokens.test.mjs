/* Dark phone tokens. Run with:
   node --test tests/phone-dark-tokens.test.mjs
   A pair under 4.5:1 fails. The painted check is the seam spec. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function lum(r, g, b) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const hi = Math.max(lum(...a), lum(...b));
  const lo = Math.min(lum(...a), lum(...b));
  return (hi + 0.05) / (lo + 0.05);
}

function hex(value) {
  const n = value.replace("#", "");
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

const tokens = readFileSync(new URL("../os-src/tokens.css", import.meta.url), "utf8");
const phone = tokens.slice(tokens.indexOf("@media (max-width: 430px)"), tokens.indexOf("@media (prefers-reduced-motion"));
const york = readFileSync(new URL("../os-src/york-os.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../os-src/phone-shell.css", import.meta.url), "utf8");

test("the broken pairs sit under 4.5:1", () => {
  const window = hex("#1E1D1A");
  assert.ok(ratio(hex("#161513"), window) < 4.5);
  assert.ok(ratio(hex("#131210"), hex("#161513")) < 4.5);
  assert.ok(ratio(hex("#6B6760"), window) < 4.5);
});

test("phone dark tokens clear 4.5:1 and stay inside 430px", () => {
  assert.match(phone, /html\[data-cdtheme="dark"\]/);
  const text = hex("#F6F3EC");
  const muted = hex("#C9C2B6");
  const surface = hex("#1E1D1A");
  const bg = hex("#14130F");
  const negative = hex("#FFB4A8");
  for (const [name, fg, bgColor] of [
    ["text on surface", text, surface],
    ["muted on surface", muted, surface],
    ["text on page", text, bg],
    ["muted on page", muted, bg],
    ["danger on surface", negative, surface],
    ["initials on the avatar", text, hex("#161513")],
    ["white on a selected chip", hex("#FFFFFF"), hex("#161513")],
  ]) {
    const score = ratio(fg, bgColor);
    assert.ok(score >= 4.5, name + " is " + score.toFixed(2) + ":1");
  }
  assert.match(phone, /--color-text:\s*#F6F3EC/);
  assert.match(phone, /--color-text-muted:\s*#C9C2B6/);
  assert.match(phone, /--color-surface:\s*#1E1D1A/);
  assert.match(phone, /--color-on-surface-negative:\s*#FFB4A8/);
  assert.match(phone, /--cd-faint:\s*#C9C2B6\s*!important/);
  assert.match(tokens, /--gray-900:\s*#161513/);
  assert.doesNotMatch(phone, /--gray-900:\s*#(?!161513)/);
});

test("the shared shell uses those tokens and does not restyle 1280", () => {
  assert.match(york, /\.phone-shop \{[\s\S]*?color:\s*var\(--color-text/);
  assert.match(york, /html\[data-cdtheme="dark"\] \.phone-head \.mb-acct-av \{[\s\S]*?color:\s*var\(--color-text/);
  assert.equal(york.includes("rgb(30, 29, 26)"), false);
  assert.equal(shell.includes("color-scheme: light !important"), false);
  assert.match(shell, /html\[data-cdtheme="dark"\] \{ color-scheme: dark; \}/);
  const shellBody = shell.replace(/^\/\*[\s\S]*?\*\//, "");
  assert.equal(shellBody.trimStart().startsWith("@media (max-width: 430px)"), true);
});
