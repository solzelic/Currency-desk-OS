/* A currency's face: its flag and its English name, one set for the desk
   (bundled into the OS) and for the public rate page and window screens
   (served at /shared/currency-face.js). The flags are the images in
   assets/flags, from flag-icons (MIT), the set the design uses. A currency
   with no image gets the emoji built from its country letters, as the
   desk's tape does. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CurrencyFace = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  /* The country of each image in assets/flags, by currency code: every
     currency the market feeds offer, each with the flag of the country
     that issues it (CNH, the offshore yuan, is China's; ANG and XCG, the
     Caribbean guilder, are Curacao's). XAF, XCD, XOF and XPF are each
     shared by several countries, so no one flag is right and they have
     none. */
  var FLAG_FILES = {
    AED: "ae", AFN: "af", ALL: "al", AMD: "am", ANG: "cw", AOA: "ao", ARS: "ar", AUD: "au",
    AWG: "aw", AZN: "az", BAM: "ba", BBD: "bb", BDT: "bd", BGN: "bg", BHD: "bh", BIF: "bi",
    BMD: "bm", BND: "bn", BOB: "bo", BRL: "br", BSD: "bs", BTN: "bt", BWP: "bw", BYN: "by",
    BZD: "bz", CAD: "ca", CDF: "cd", CHF: "ch", CLF: "cl", CLP: "cl", CNH: "cn", CNY: "cn",
    COP: "co", CRC: "cr", CUC: "cu", CUP: "cu", CVE: "cv", CZK: "cz", DJF: "dj", DKK: "dk",
    DOP: "do", DZD: "dz", EGP: "eg", ERN: "er", ETB: "et", EUR: "eu", FJD: "fj", FKP: "fk",
    FOK: "fo", GBP: "gb", GEL: "ge", GGP: "gg", GHS: "gh", GIP: "gi", GMD: "gm", GNF: "gn",
    GTQ: "gt", GYD: "gy", HKD: "hk", HNL: "hn", HRK: "hr", HTG: "ht", HUF: "hu", IDR: "id",
    ILS: "il", IMP: "im", INR: "in", IQD: "iq", IRR: "ir", ISK: "is", JEP: "je", JMD: "jm",
    JOD: "jo", JPY: "jp", KES: "ke", KGS: "kg", KHR: "kh", KID: "ki", KMF: "km", KPW: "kp",
    KRW: "kr", KWD: "kw", KYD: "ky", KZT: "kz", LAK: "la", LBP: "lb", LKR: "lk", LRD: "lr",
    LSL: "ls", LYD: "ly", MAD: "ma", MDL: "md", MGA: "mg", MKD: "mk", MMK: "mm", MNT: "mn",
    MOP: "mo", MRU: "mr", MUR: "mu", MVR: "mv", MWK: "mw", MXN: "mx", MYR: "my", MZN: "mz",
    NAD: "na", NGN: "ng", NIO: "ni", NOK: "no", NPR: "np", NZD: "nz", OMR: "om", PAB: "pa",
    PEN: "pe", PGK: "pg", PHP: "ph", PKR: "pk", PLN: "pl", PYG: "py", QAR: "qa", RON: "ro",
    RSD: "rs", RUB: "ru", RWF: "rw", SAR: "sa", SBD: "sb", SCR: "sc", SDG: "sd", SEK: "se",
    SGD: "sg", SHP: "sh", SLE: "sl", SLL: "sl", SOS: "so", SRD: "sr", SSP: "ss", STN: "st",
    SVC: "sv", SYP: "sy", SZL: "sz", THB: "th", TJS: "tj", TMT: "tm", TND: "tn", TOP: "to",
    TRY: "tr", TTD: "tt", TVD: "tv", TWD: "tw", TZS: "tz", UAH: "ua", UGX: "ug", USD: "us",
    UYU: "uy", UZS: "uz", VED: "ve", VES: "ve", VND: "vn", VUV: "vu", WST: "ws", XCG: "cw",
    YER: "ye", ZAR: "za", ZMW: "zm", ZWG: "zw", ZWL: "zw"
  };
  function code3(code) { var c = String(code || "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(c) ? c : ""; }

  function flagUrl(code) {
    var country = FLAG_FILES[code3(code)];
    return country ? "/assets/flags/" + country + ".svg" : null;
  }
  /* ISO 4217 codes start with the ISO 3166 country (USD is US); the euro's
     EU letters are a flag too. Codes starting with X belong to no country
     (XAF, XOF, the metals), so they get nothing rather than two loose
     letters, and the screen shows a plain tile. */
  function flagEmoji(code) {
    var c = code3(code);
    if (!c || c.charAt(0) === "X") return "";
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
