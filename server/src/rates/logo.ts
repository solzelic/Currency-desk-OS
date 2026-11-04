/* The shop's logo: a PNG, checked before it is kept.

   The desk draws whatever the owner picks onto a 240px canvas and sends
   the PNG that comes out. This file does not trust that: it takes only a
   base64 PNG data URL whose bytes start with the PNG signature and an
   IHDR of at most 1024 by 1024, and at most 256 KB. Anything else,
   SVG above all (an SVG can carry script), is refused. It is served back
   only as image/png, with nosniff and a policy that lets nothing run. */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX = "data:image/png;base64,";
export const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_MAX_SIDE = 1024;

export type CheckedLogo = { dataUrl: string; bytes: Buffer };

/* null when the upload is not a small, real PNG. */
export function checkLogo(dataUrl: unknown): CheckedLogo | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PREFIX)) return null;
  const b64 = dataUrl.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 33 || bytes.length > LOGO_MAX_BYTES) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  /* The first chunk of a PNG is IHDR: width and height, big-endian. */
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) return null;
  return { dataUrl: PREFIX + bytes.toString("base64"), bytes };
}

/* The bytes of a stored logo (written by checkLogo, so already checked). */
export function logoBytes(stored: string | null | undefined): Buffer | null {
  if (!stored || !stored.startsWith(PREFIX)) return null;
  return Buffer.from(stored.slice(PREFIX.length), "base64");
}

/* The headers every logo answer carries. */
export const LOGO_HEADERS = {
  "content-type": "image/png",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;
