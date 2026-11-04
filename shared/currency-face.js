/* A currency's face: its flag and its English name, one set for the desk
   (bundled into the OS) and for the public rate page and window screens
   (served at /shared/currency-face.js). The flags are the design's own
   images in assets/flags (flag-icons, MIT). A currency with no image gets
   the emoji built from its country letters, as the desk's tape does. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CurrencyFace = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  /* The country of each image in assets/flags, by currency code. */
  var FLAG_FILES = {
    AED: "ae", AUD: "au", BRL: "br", CAD: "ca", CHF: "ch", CNY: "cn", EUR: "eu", GBP: "gb",
    HKD: "hk", IDR: "id", INR: "in", JPY: "jp", KRW: "kr", MXN: "mx", MYR: "my", NGN: "ng",
    NZD: "nz", PHP: "ph", PKR: "pk", QAR: "qa", SAR: "sa", SEK: "se", SGD: "sg", THB: "th",
    TRY: "tr", USD: "us", VND: "vn", ZAR: "za"
  };
  function code3(code) { var c = String(code || "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : ""; }

  function flagUrl(code) {
    var country = FLAG_FILES[code3(code)];
    return country ? "/assets/flags/" + country + ".svg" : null;
  }
  /* ISO 4217 codes start with the ISO 3166 country (USD is US); the euro's
     EU letters are a flag too. */
  function flagEmoji(code) {
    var c = code3(code);
    if (!c) return "";
    return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
  }
  var names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "currency" }); } catch (e) { names = null; }
  function currencyName(code) {
    var c = code3(code);
    if (!c || !names) return c || String(code || "");
    try { var n = names.of(c); return n && n !== c ? n : c; } catch (e) { return c; }
  }
  return { flagUrl: flagUrl, flagEmoji: flagEmoji, currencyName: currencyName };
});
