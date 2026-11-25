/* QR modules for a customer pre-verify link. The matrix is drawn by the desk.
   No image host and no third-party fetch. */
// @ts-expect-error vendored encoder, typed at the call
import { encode } from "./qr-encode.mjs";

type QrEncoded = { size: number; data: boolean[][] };

export function qrMatrix(text: string): boolean[][] {
  const encoded = (encode as (data: string, options?: { ecc?: string; border?: number }) => QrEncoded)(text, { ecc: "M", border: 2 });
  if (!encoded.data.length || encoded.data.some((row) => row.length !== encoded.data.length)) {
    throw new Error("qr_failed");
  }
  return encoded.data;
}
