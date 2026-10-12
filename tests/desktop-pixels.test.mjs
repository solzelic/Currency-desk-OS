/* The desktop picture compare. Run with: node --test tests/desktop-pixels.test.mjs
   A 1-level gap is one step in a channel. A 2-level gap is a real change. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { decodePng, diffRgba, capFor, withinDesktopCap, SIGN_IN_PIXEL_CAP } = require("./e2e/helpers/desktop-pixels.cjs");

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return upLeft;
}

/* filter is 0 none, 1 sub, 2 up, 3 average, 4 Paeth. */
function encodePng(width, height, rgba, filter) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const stored = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0;
      const up = previous[i];
      const upLeft = i >= 4 ? previous[i - 4] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = Math.floor((left + up) / 2);
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      stored[i] = (row[i] - predicted) & 255;
    }
    const at = y * (1 + stride);
    raw[at] = filter;
    stored.copy(raw, at + 1);
    previous = Buffer.from(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("PNG filters round-trip to the same pixels", () => {
  const rgba = Buffer.from([
    10, 20, 30, 255, 11, 21, 31, 255,
    40, 50, 60, 255, 0, 0, 0, 128,
  ]);
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(encodePng(2, 2, rgba, filter));
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
    assert.deepEqual(decoded.data, rgba);
  }
});

test("a 1-level gap and a 2-level gap are counted apart", () => {
  const base = Buffer.from([0, 0, 0, 255, 10, 10, 10, 255, 20, 20, 20, 255]);
  const next = Buffer.from(base);
  next[0] = 1;
  next[5] = 12;
  const diff = diffRgba(next, base);
  assert.deepEqual(diff, { diffPixels: 2, maxDelta: 2, overOne: 1 });
});

const OTHER_PICTURES = [
  "ledger-1280.png",
  "clients-1280.png",
  "rates-1280.png",
  "till-1280.png",
  "compliance-1280.png",
  "reports-1280.png",
  "settings-1280.png",
  "pricing-1280.png",
  "transfers-1280.png",
  "cheques-1280.png",
  "vault-1280.png",
  "audit-1280.png",
];

test("sign-in allows one-level glass pixels and rejects a real change", () => {
  assert.equal(SIGN_IN_PIXEL_CAP, 10);
  assert.equal(capFor("sign-in-1280.png"), 10);
  assert.equal(capFor("sign-in-1280-chromium-linux.png"), 10);
  const oneLevel = { diffPixels: 4, maxDelta: 1, overOne: 0 };
  assert.equal(withinDesktopCap("sign-in-1280.png", oneLevel), true);
  assert.equal(withinDesktopCap("sign-in-1280.png", { diffPixels: 10, maxDelta: 1, overOne: 0 }), true);
  assert.equal(withinDesktopCap("sign-in-1280.png", { diffPixels: 11, maxDelta: 1, overOne: 0 }), false);
  assert.equal(withinDesktopCap("sign-in-1280.png", { diffPixels: 1, maxDelta: 2, overOne: 1 }), false);
  assert.equal(withinDesktopCap("sign-in-1280-chromium-linux.png", { diffPixels: 4, maxDelta: 2, overOne: 1 }), false);
});

test("every other desktop picture stays exact", () => {
  for (const name of OTHER_PICTURES) {
    assert.equal(capFor(name), 0, name);
    assert.equal(capFor(name.replace(".png", "-chromium-linux.png")), 0, name);
    assert.equal(withinDesktopCap(name, { diffPixels: 0, maxDelta: 0, overOne: 0 }), true, name);
    assert.equal(withinDesktopCap(name, { diffPixels: 1, maxDelta: 1, overOne: 0 }), false, name);
    assert.equal(withinDesktopCap(name, { diffPixels: 4, maxDelta: 1, overOne: 0 }), false, name);
    assert.equal(withinDesktopCap(name, { diffPixels: 1, maxDelta: 2, overOne: 1 }), false, name);
  }
});
