/* One list of health-card names, shared by the server and the desk.

   Ontario health-card numbers are restricted by the Health Cards and
   Numbers Control Act, 1991, and FINTRAC does not take a health card
   as identification. The catalogue row is "Health Card". These names
   are the same card under another label. A whole word keeps "mspaint"
   from matching MSP. Accent marks and apostrophes fold away so
   "Carte d'assurance maladie" matches. #131's read-side list is not
   on main; this file is the list both sides use. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof module === "object" && module && module.exports && typeof window === "undefined") return;
  var host = root || globalThis;
  var cdos = host.CDOS || (host.CDOS = {});
  cdos.isHealthCardType = api.isHealthCardType;
  cdos.maskNotAcceptedNumber = api.maskNotAcceptedNumber;
})(typeof window !== "undefined" ? window : globalThis, function () {
  var WORD_ALIASES = { ohip: true, ramq: true, msp: true, medicare: true };
  var PHRASES = [
    "alberta health",
    "assurance maladie",
    "bc services card",
    "ontario health insurance",
    "health insurance plan",
    "medicare card",
  ];

  function fold(value) {
    return String(value == null ? "" : value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function isHealthCardType(value) {
    var spaced = fold(value);
    if (!spaced) return false;
    var compact = spaced.replace(/ /g, "");
    if (compact.indexOf("healthcard") !== -1) return true;
    if (compact.indexOf("carecard") !== -1) return true;
    var words = spaced.split(" ");
    for (var i = 0; i < words.length; i++) {
      if (WORD_ALIASES[words[i]]) return true;
    }
    for (var j = 0; j < PHRASES.length; j++) {
      if (spaced.indexOf(PHRASES[j]) !== -1) return true;
    }
    return false;
  }

  /* Last four characters, always eight wide. Four stars, then those
     four. A short number is eight stars, so the length and the front
     of the number stay off the screen. Masking a mask again is the
     same eight characters. */
  function maskNotAcceptedNumber(value) {
    if (value == null) return "";
    var stripped = String(value).replace(/\s/g, "");
    if (!stripped) return "";
    if (stripped.length <= 4) return "********";
    return "****" + stripped.slice(-4);
  }

  return {
    isHealthCardType: isHealthCardType,
    maskNotAcceptedNumber: maskNotAcceptedNumber,
  };
});
