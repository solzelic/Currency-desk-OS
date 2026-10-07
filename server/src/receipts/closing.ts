/* The receipt's closing line.

   This is the footer ReceiptModal already prints
   (os-src/cdos-modules.jsx). Empty means that same sentence.
   There is no per-currency greeting in this repository. */
export const RECEIPT_CLOSING = "Thank you \u2014 keep for your records";

export function receiptClosing(footer: string | null | undefined): string {
  const typed = typeof footer === "string" ? footer : "";
  return typed.trim() ? typed : RECEIPT_CLOSING;
}
