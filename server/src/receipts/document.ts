/* One receipt, drawn the same way for the email and the PDF attachment.
   Amount strings come from the ledger. A missing figure is left out. */
import Decimal from "decimal.js";
import { toDataURL } from "qrcode";
import { receiptClosing } from "./closing.js";
import type { ReceiptIdentity, ReceiptOptions } from "./settings.js";

export interface LedgerReceiptFields {
  transactionRef: string;
  postedAt: string;
  postedAtLocal?: string;
  timezone?: string;
  customerName?: string | null;
  clientEmail?: string | null;
  fromCurrency?: string;
  toCurrency?: string;
  inputAmount?: string;
  outputAmount?: string;
  rate?: string;
  feeCad?: string;
}

export interface ReceiptView {
  shopName: string;
  heading: string;
  address: string | null;
  phone: string | null;
  licence: string | null;
  cdIdLine: string;
  when: string;
  receiptNumber: string;
  clientName: string | null;
  paid: string | null;
  rate: string | null;
  fee: string | null;
  received: string | null;
  closing: string;
  disclaimer: string | null;
  qrDataUrl: string | null;
  rateUrl: string | null;
  paper: ReceiptOptions["paper"];
}

function moneyText(raw: string | undefined): string | null {
  if (raw == null || raw === "") return null;
  try {
    const value = new Decimal(raw);
    const shown = value.toFixed(2);
    return value.eq(shown) ? shown : value.toFixed(value.decimalPlaces());
  } catch {
    return null;
  }
}

function rateText(raw: string | undefined): string | null {
  if (raw == null || raw === "") return null;
  try {
    const value = new Decimal(raw);
    const trimmed = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    const shown = trimmed.includes(".") ? trimmed : `${trimmed}.00`;
    return value.eq(shown) ? shown : value.toFixed(12);
  } catch {
    return null;
  }
}

export function receiptView(
  fields: LedgerReceiptFields,
  options: ReceiptOptions,
  identity: ReceiptIdentity,
  qrDataUrl: string | null,
): ReceiptView {
  const paidAmt = moneyText(fields.inputAmount);
  const gotAmt = moneyText(fields.outputAmount);
  const from = (fields.fromCurrency || "").trim();
  const to = (fields.toCurrency || "").trim();
  const heading = options.header.trim() || identity.shopName;
  return {
    shopName: identity.shopName,
    heading,
    address: identity.address,
    phone: identity.phone,
    licence: options.showMsb ? identity.licence : null,
    cdIdLine: identity.cdId ?? "No CurrencyDesk ID issued yet",
    when: fields.postedAtLocal || fields.postedAt,
    receiptNumber: fields.transactionRef,
    clientName: options.showClientName ? (fields.customerName?.trim() || null) : null,
    paid: paidAmt && from ? `${paidAmt} ${from}` : null,
    rate: options.showRate ? rateText(fields.rate) : null,
    fee: options.showFees ? moneyText(fields.feeCad) : null,
    received: gotAmt && to ? `${gotAmt} ${to}` : null,
    closing: receiptClosing(options.footer),
    disclaimer: options.disclaimer.trim() || null,
    qrDataUrl: options.showQr && identity.rateUrl ? qrDataUrl : null,
    rateUrl: options.showQr ? identity.rateUrl : null,
    paper: options.paper,
  };
}

export async function qrFor(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    return await toDataURL(url, { margin: 0, width: 180, errorCorrectionLevel: "M" });
  } catch {
    return null;
  }
}

const esc = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const FONT = `"IBM Plex Mono","Noto Sans","Noto Naskh Arabic","Noto Sans CJK JP","Noto Sans JP","Hiragino Sans","Yu Gothic","Segoe UI",sans-serif`;

function row(label: string, value: string | null): string {
  if (!value) return "";
  return `<tr><td style="padding:4px 12px 4px 0;color:#444;vertical-align:top">${esc(label)}</td><td style="padding:4px 0;font-weight:600;text-align:right">${esc(value)}</td></tr>`;
}

const PAGE: Record<ReceiptOptions["paper"], string> = {
  "80mm": "80mm auto",
  "58mm": "58mm auto",
  a4: "A4",
  letter: "letter",
};

const SHEET: Record<ReceiptOptions["paper"], string> = {
  "80mm": "72mm",
  "58mm": "50mm",
  a4: "180mm",
  letter: "180mm",
};

export function receiptHtml(view: ReceiptView, opts?: { autoprint?: boolean }): string {
  const page = PAGE[view.paper] ?? "80mm auto";
  const width = SHEET[view.paper] ?? "72mm";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ${esc(view.receiptNumber)}</title>
<link rel="stylesheet" href="/web/fonts/fonts.css">
<style>
  @page { size: ${page}; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font-family: ${FONT}; }
  .sheet { box-sizing: border-box; width: ${width}; margin: 0 auto; padding: 8mm 5mm 10mm; }
  h1 { font-size: 15px; margin: 0 0 4px; font-weight: 700; text-align: center; }
  .muted { color: #333; font-size: 12px; text-align: center; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  .rule { border-top: 1px dashed #000; margin: 10px 0; }
  .closing { text-align: center; font-size: 13px; margin: 12px 0 0; }
  .fine { text-align: center; font-size: 11px; color: #333; margin: 8px 0 0; }
  img.qr { display: block; margin: 10px auto 0; width: 96px; height: 96px; }
  @media print {
    html, body { background: #fff; }
  }
</style></head><body>
<article class="sheet">
  <h1>${esc(view.heading)}</h1>
  ${view.address ? `<p class="muted">${esc(view.address)}</p>` : ""}
  ${view.phone ? `<p class="muted">${esc(view.phone)}</p>` : ""}
  ${view.licence ? `<p class="muted">${esc(view.licence)}</p>` : ""}
  <p class="muted">${esc(view.cdIdLine)}</p>
  <div class="rule"></div>
  <table>
    ${row("Receipt", view.receiptNumber)}
    ${row("Date", view.when)}
    ${row("Client", view.clientName)}
    ${row("Paid", view.paid)}
    ${row("Rate", view.rate)}
    ${row("Fee", view.fee ? `${view.fee}` : null)}
    ${row("Received", view.received)}
  </table>
  <div class="rule"></div>
  <p class="closing" data-receipt-closing="1">${esc(view.closing)}</p>
  ${view.disclaimer ? `<p class="fine">${esc(view.disclaimer)}</p>` : ""}
  ${view.qrDataUrl ? `<img class="qr" alt="" src="${esc(view.qrDataUrl)}">` : ""}
  ${view.rateUrl ? `<p class="fine">${esc(view.rateUrl)}</p>` : ""}
</article>
${opts?.autoprint ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},40)})</script>` : ""}
</body></html>`;
}

export function receiptText(view: ReceiptView): string {
  const lines = [
    view.heading,
    view.address,
    view.phone,
    view.licence,
    view.cdIdLine,
    `Receipt ${view.receiptNumber}`,
    view.when,
    view.clientName ? `Client: ${view.clientName}` : null,
    view.paid ? `Paid: ${view.paid}` : null,
    view.rate ? `Rate: ${view.rate}` : null,
    view.fee ? `Fee: ${view.fee}` : null,
    view.received ? `Received: ${view.received}` : null,
    view.closing,
    view.disclaimer,
    view.rateUrl,
  ];
  return lines.filter((line): line is string => !!line).join("\n");
}
