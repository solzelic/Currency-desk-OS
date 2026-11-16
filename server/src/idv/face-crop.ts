/* A small portrait window from the ID document photo. It is not a face match.
   The window is fixed: on a wide ID the portrait sits on the left. No score,
   no template, no comparison of two faces. The result is a 96 by 96 PNG. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Rgba = { width: number; height: number; data: Uint8Array };
type PngImage = { width: number; height: number; data: Buffer };

const jpeg = require("jpeg-js") as {
  decode(buf: Buffer, opts?: { useTArray?: boolean; formatAsRGBA?: boolean }): Rgba;
};
const { PNG } = require("pngjs") as {
  PNG: { sync: { read(buf: Buffer): PngImage; write(png: PngImage): Buffer } };
};

export const CROP_SIZE = 96;
const MAX_SOURCE_BYTES = 6_000_000;

function decode(bytes: Buffer): Rgba | null {
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) return null;
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const png = PNG.sync.read(bytes);
      return { width: png.width, height: png.height, data: png.data };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return { width: decoded.width, height: decoded.height, data: decoded.data };
    }
  } catch {
    return null;
  }
  return null;
}

function windowFor(width: number, height: number): { x: number; y: number; side: number } {
  if (width > height * 1.2) {
    const side = Math.max(1, Math.min(width, height, Math.round(height * 0.78)));
    const x = Math.min(Math.round(width * 0.06), Math.max(0, width - side));
    const y = Math.max(0, Math.round((height - side) / 2));
    return { x, y, side };
  }
  const side = Math.max(1, Math.round(Math.min(width, height) * 0.8));
  return {
    x: Math.max(0, Math.round((width - side) / 2)),
    y: Math.max(0, Math.round((height - side) / 2)),
    side,
  };
}

export function cropIdPortrait(source: Buffer): Buffer | null {
  const image = decode(source);
  if (!image || image.width < 8 || image.height < 8) return null;
  const box = windowFor(image.width, image.height);
  const out = Buffer.alloc(CROP_SIZE * CROP_SIZE * 4);
  for (let y = 0; y < CROP_SIZE; y += 1) {
    for (let x = 0; x < CROP_SIZE; x += 1) {
      const sx = Math.min(image.width - 1, box.x + Math.floor((x * box.side) / CROP_SIZE));
      const sy = Math.min(image.height - 1, box.y + Math.floor((y * box.side) / CROP_SIZE));
      const from = (sy * image.width + sx) * 4;
      const to = (y * CROP_SIZE + x) * 4;
      out[to] = image.data[from] ?? 0;
      out[to + 1] = image.data[from + 1] ?? 0;
      out[to + 2] = image.data[from + 2] ?? 0;
      out[to + 3] = 255;
    }
  }
  const png = PNG.sync.write({ width: CROP_SIZE, height: CROP_SIZE, data: out });
  if (png.equals(source)) return null;
  return png;
}

export function isSmallCrop(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > 32_000 || bytes[0] !== 0x89) return false;
  try {
    const png = PNG.sync.read(bytes);
    return png.width === CROP_SIZE && png.height === CROP_SIZE;
  } catch {
    return false;
  }
}
