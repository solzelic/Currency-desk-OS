/* A currency's face: its flag and its name, one set for the desk and the
   public pages (shared/currency-face.js). The flags are the design's own
   images (assets/flags, from flag-icons); a currency with no image gets
   the emoji built from its country letters, the way the desk's tape does. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const face = () => require("../../shared/currency-face.js") as {
  flagUrl: (code: string) => string | null;
  flagEmoji: (code: string) => string;
  currencyName: (code: string) => string;
};

describe("flags", () => {
  it("uses the design's image where there is one, the euro included", () => {
    expect(face().flagUrl("USD")).toBe("/assets/flags/us.svg");
    expect(face().flagUrl("EUR")).toBe("/assets/flags/eu.svg");
    expect(face().flagUrl("jpy")).toBe("/assets/flags/jp.svg");
  });

  it("every image it names is on disk, and every image on disk is named", () => {
    const files = readdirSync(path.join(ROOT, "assets/flags")).filter((f) => f.endsWith(".svg")).sort();
    const named = ["AED", "AUD", "BRL", "CAD", "CHF", "CNY", "EUR", "GBP", "HKD", "IDR", "INR", "JPY", "KRW", "MXN", "MYR", "NGN", "NZD", "PHP", "PKR", "QAR", "SAR", "SEK", "SGD", "THB", "TRY", "USD", "VND", "ZAR"]
      .map((c) => face().flagUrl(c)!.slice("/assets/flags/".length)).sort();
    expect(named).toEqual(files);
    for (const f of files) expect(existsSync(path.join(ROOT, "assets/flags", f))).toBe(true);
  });

  it("falls back to the emoji for a currency with no image, and to nothing for nonsense", () => {
    expect(face().flagUrl("HUF")).toBeNull();
    expect(face().flagEmoji("HUF")).toBe("\u{1F1ED}\u{1F1FA}");
    expect(face().flagEmoji("EUR")).toBe("\u{1F1EA}\u{1F1FA}");
    expect(face().flagEmoji("1x")).toBe("");
  });

  it("holds no script: every image is a plain picture", () => {
    for (const f of readdirSync(path.join(ROOT, "assets/flags")).filter((n) => n.endsWith(".svg"))) {
      expect(readFileSync(path.join(ROOT, "assets/flags", f), "utf8"), f).not.toMatch(/<script|on[a-z]+=|javascript:|<foreignObject/i);
    }
  });
});

describe("names", () => {
  it("names a currency in English, and gives the code back for one it does not know", () => {
    expect(face().currencyName("USD")).toBe("US Dollar");
    expect(face().currencyName("PHP")).toBe("Philippine Peso");
    expect(face().currencyName("ZZZ")).toBe("ZZZ");
  });
});

it("ships in the desk and is public for the rate page and screens", () => {
  expect(readFileSync(path.join(ROOT, "CurrencyDesk OS.html"), "utf8")).toContain('<script src="shared/currency-face.js"></script>');
  expect(readFileSync(path.join(ROOT, "server/src/app.ts"), "utf8")).toContain('file === "/shared/currency-face.js"');
  for (const page of ["rates-public/rate-page.html", "rates-public/window-screen.html"]) {
    expect(readFileSync(path.join(ROOT, page), "utf8"), page).toContain('<script src="/shared/currency-face.js"></script>');
  }
});
