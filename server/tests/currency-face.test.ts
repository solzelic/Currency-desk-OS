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

  /* Every currency the market feeds offer (open.er-api.com, and the three
     more openexchangerates.org adds: CUC, SVC, VED), so any currency a
     shop adds to its board wears its country's flag. XDR is not money and
     the feed code drops it. */
  const FEED = (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD " +
    "CAD CDF CHF CLF CLP CNH CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP FOK GBP " +
    "GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES " +
    "KGS KHR KID KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK " +
    "MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR " +
    "SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TVD TWD TZS UAH UGX " +
    "USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL"
  ).split(" ");
  /* Shared by several countries, so no one country's flag is right. */
  const SHARED = ["XAF", "XCD", "XOF", "XPF"];

  it("gives every currency the feeds offer its country's flag, except the four shared by several countries", () => {
    const without = FEED.filter((c) => !SHARED.includes(c) && face().flagUrl(c) === null);
    expect(without).toEqual([]);
    expect(face().flagUrl("HUF")).toBe("/assets/flags/hu.svg");
    expect(face().flagUrl("CNH")).toBe("/assets/flags/cn.svg");
    expect(face().flagUrl("XCG")).toBe("/assets/flags/cw.svg");
  });

  it("every image it names is on disk, and every image on disk is named", () => {
    const files = readdirSync(path.join(ROOT, "assets/flags")).filter((f) => f.endsWith(".svg")).sort();
    const named = [...new Set(FEED.map((c) => face().flagUrl(c)).filter((u): u is string => u !== null))]
      .map((u) => u.slice("/assets/flags/".length)).sort();
    expect(named).toEqual(files);
    for (const f of files) expect(existsSync(path.join(ROOT, "assets/flags", f))).toBe(true);
  });

  it("falls back to the emoji for a currency with no image, and to nothing for nonsense", () => {
    /* BOV is Bolivia's fund unit: not on a board, but it has a country. */
    expect(face().flagUrl("BOV")).toBeNull();
    expect(face().flagEmoji("BOV")).toBe("\u{1F1E7}\u{1F1F4}");
    expect(face().flagEmoji("EUR")).toBe("\u{1F1EA}\u{1F1FA}");
    expect(face().flagEmoji("1x")).toBe("");
  });

  it("shows a plain tile, not two loose letters, for a currency shared by several countries", () => {
    for (const c of SHARED) {
      expect(face().flagUrl(c), c).toBeNull();
      expect(face().flagEmoji(c), c).toBe("");
    }
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

it("ships in the desk and is public, so the rate page and screens can load it too", () => {
  expect(readFileSync(path.join(ROOT, "CurrencyDesk OS.html"), "utf8")).toContain('<script src="shared/currency-face.js"></script>');
  expect(readFileSync(path.join(ROOT, "server/src/app.ts"), "utf8")).toContain('file === "/shared/currency-face.js"');
});

it("is loaded by the public rate page and the window screen, which show the same flags and names", () => {
  for (const page of ["rates-public/rate-page.html", "rates-public/window-screen.html"]) {
    expect(readFileSync(path.join(ROOT, page), "utf8"), page).toContain('<script src="/shared/currency-face.js"></script>');
  }
});
