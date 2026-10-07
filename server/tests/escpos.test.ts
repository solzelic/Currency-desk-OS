import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PRINTER_GUIDE, PRINTER_HELP } from "../src/receipts/printer-help.js";
import { RECEIPT_CLOSING } from "../src/receipts/closing.js";

const require = createRequire(import.meta.url);
const escpos = require("../../os-src/cdos-escpos.js") as {
  needsRaster(text: string): boolean;
  drawerPulse(): Uint8Array;
  encodeReceipt(model: {
    lines?: string[];
    qrUrl?: string | null;
    cut?: boolean;
    drawer?: boolean;
    logo?: { widthBytes: number; height: number; data: Uint8Array };
  }, hooks?: { rasterize?: (line: string) => { widthBytes: number; height: number; data: Uint8Array } | null }): Uint8Array;
  rasterCommand(bmp: { widthBytes: number; height: number; data: Uint8Array }): Uint8Array;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("ESC/POS", () => {
  it("matches the ASCII golden file", () => {
    const bytes = escpos.encodeReceipt({ lines: ["YORK", "CAD 10.00"], cut: true });
    const golden = readFileSync(new URL("./fixtures/escpos/ascii.hex", import.meta.url), "utf8").trim();
    expect(hex(bytes)).toBe(golden);
  });

  it("frames a QR with the URL bytes, then cuts", () => {
    const url = "https://x.test/r";
    const bytes = escpos.encodeReceipt({ lines: [], qrUrl: url, cut: true });
    const raw = Buffer.from(bytes);
    expect(raw.includes(Buffer.from(url))).toBe(true);
    expect(raw.includes(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(true);
    expect(raw.subarray(raw.length - 4).equals(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true);
  });

  it("pulses the drawer on pin 2", () => {
    expect(hex(escpos.drawerPulse())).toBe("1b70001919");
    const bytes = escpos.encodeReceipt({ lines: ["OK"], drawer: true, cut: true });
    expect(Buffer.from(bytes).includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0x19]))).toBe(true);
  });

  it("rasters a bitmap with GS v 0", () => {
    const bmp = { widthBytes: 1, height: 1, data: Uint8Array.of(0x80) };
    expect(hex(escpos.rasterCommand(bmp))).toBe("1d7630000100010080");
    const bytes = escpos.encodeReceipt({ lines: [], logo: bmp, cut: false });
    expect(hex(bytes)).toContain("1d7630000100010080");
  });

  it("rasters the em dash and Cyrillic instead of a code page", () => {
    expect(escpos.needsRaster("Thanks")).toBe(false);
    expect(escpos.needsRaster(RECEIPT_CLOSING)).toBe(true);
    expect(escpos.needsRaster("РСД")).toBe(true);
    const bytes = escpos.encodeReceipt({
      lines: [RECEIPT_CLOSING],
      cut: false,
    }, {
      rasterize: () => ({ widthBytes: 1, height: 1, data: Uint8Array.of(0xff) }),
    });
    expect(hex(bytes)).toContain("1d76300001000100ff");
    expect(Buffer.from(bytes).includes(Buffer.from([0x3f]))).toBe(false);
  });
});

describe("printer help", () => {
  it("names the tested paths in the same words the desk shows, and does not claim every printer", () => {
    const js = readFileSync(new URL("../../os-src/cdos-receipt.js", import.meta.url), "utf8");
    for (const line of PRINTER_HELP.split("\n")) expect(js).toContain(line);
    expect(PRINTER_GUIDE.steps.length).toBeLessThanOrEqual(4);
    for (const step of PRINTER_GUIDE.steps) expect(step.length).toBeLessThan(80);
    expect(PRINTER_GUIDE.worksWith.join("\n")).toContain("Epson TM-T20III");
    expect(PRINTER_GUIDE.worksWith.join("\n")).toContain("TM-m30");
    expect(PRINTER_GUIDE.worksWith.join("\n")).toContain("Star TSP100");
    expect(PRINTER_GUIDE.worksWith.join("\n")).toContain("AirPrint");
    expect(PRINTER_GUIDE.unsupported).toContain("9100");
    expect(PRINTER_GUIDE.unsupported).toContain("classic Bluetooth");
    expect(PRINTER_HELP).toContain("TCP 9100");
    expect(PRINTER_HELP.toLowerCase()).not.toContain("all printers");
    expect(PRINTER_HELP).not.toContain("Bixolon");
    expect(PRINTER_HELP).not.toMatch(/[\u2013\u2014]/);
  });
});
