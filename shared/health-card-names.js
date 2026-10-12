/* One explicit list of health-card names.

   The server and the browser both load this file. PR #108's catalogue
   (server/src/ledger/id-document-types.mjs) is not on this branch, and
   its health-card aliases do not yet include every name below. When
   that catalogue merges, its health-card row should take this list
   rather than grow a second one.

   A name matches only as a whole type, after the same fold #108 uses:
   lower case, apostrophes removed, every other non-letter turned into
   a space. "healthcare" is not "health card". "mspaint" is not "MSP".
   "BC Services Card" is on the list because that card, used as a
   health card, is a health number. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CDOS_HEALTH_CARDS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var HEALTH_CARD_NAMES = [
    "Health Card",
    "OHIP",
    "OHIP card",
    "Ontario Health Insurance Plan",
    "Ontario Health Card",
    "Carte d'assurance maladie",
    "RAMQ",
    "RAMQ card",
    "Régie de l'assurance maladie du Québec",
    "Regie de l'assurance maladie du Quebec",
    "MSP",
    "MSP card",
    "Medical Services Plan",
    "BC Services Card",
    "Care Card",
    "BC Care Card",
    "Alberta Health",
    "Alberta Health Card",
    "Alberta Health Care",
    "Alberta Health Care Insurance Plan",
    "Medicare",
    "Medicare card",
    "New Brunswick Medicare",
    "Manitoba Health",
    "Manitoba Health Card",
    "Saskatchewan Health Card",
    "Saskatchewan Health Services Card",
    "Nova Scotia Health Card",
    "MSI",
    "Medical Services Insurance",
    "PEI Health Card",
    "Prince Edward Island Health Card",
    "Newfoundland and Labrador Medical Care Plan",
    "MCP",
    "Medical Care Plan",
    "Northwest Territories Health Care Card",
    "NWT Health Care Card",
    "Nunavut Health Care Card",
    "Yukon Health Care Card",
    "Yukon Health Care Insurance Plan",
  ];

  function typeKey(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/['\u2018\u2019]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/ +/g, " ")
      .trim();
  }

  var KEYS = Object.create(null);
  HEALTH_CARD_NAMES.forEach(function (name) {
    var key = typeKey(name);
    if (!key) throw new Error("A health-card name folded to nothing: " + name);
    KEYS[key] = true;
  });
  var HEALTH_CARD_TYPE_KEYS = Object.keys(KEYS);

  /* The marker the owner-run redaction writes. It is not a number, so
     it does not identify a client. */
  var REDACTED_HEALTH_NUMBER = "[redacted]";

  function isHealthCardType(value) {
    var key = typeKey(value);
    return key !== "" && KEYS[key] === true;
  }

  var NUMBER_KEYS = { docNumber: 1, doc_number: 1, idNum: 1, num: 1, number: 1 };
  var TYPE_KEYS = ["docType", "doc_type", "idType", "type"];

  function objectIsHealthCard(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (var i = 0; i < TYPE_KEYS.length; i++) {
      if (isHealthCardType(value[TYPE_KEYS[i]])) return true;
    }
    return false;
  }

  function scrubHealthNumbers(value) {
    if (Array.isArray(value)) return value.map(scrubHealthNumbers);
    if (typeof value === "string") {
      if (value.charAt(0) !== "{" && value.charAt(0) !== "[") return value;
      try {
        var parsed = JSON.parse(value);
        var cleaned = scrubHealthNumbers(parsed);
        if (JSON.stringify(cleaned) === JSON.stringify(parsed)) return value;
        return JSON.stringify(cleaned);
      } catch (error) {
        return value;
      }
    }
    if (!value || typeof value !== "object") return value;
    var drop = objectIsHealthCard(value);
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (drop && NUMBER_KEYS[key]) return;
      out[key] = scrubHealthNumbers(value[key]);
    });
    return out;
  }

  /* Same fold as typeKey(), in Postgres. The doubled quote is one
     apostrophe inside the SQL string. */
  function healthCardExcludedSql(expr) {
    var apostrophes = "[''\u2018\u2019]";
    var folded =
      "btrim(regexp_replace(regexp_replace(regexp_replace(lower(" +
      expr +
      "), '" +
      apostrophes +
      "', '', 'g'), '[^a-z0-9]+', ' ', 'g'), ' +', ' ', 'g'))";
    var list = HEALTH_CARD_TYPE_KEYS.map(function (key) {
      return "'" + key.replace(/'/g, "''") + "'";
    }).join(", ");
    return folded + " <> ALL (ARRAY[" + list + "]::text[])";
  }

  /* A stored id number that still counts. Blank does not. The redaction
     marker does not: it records that a number was removed. */
  function idNumberCountsSql(expr) {
    var trimmed = "coalesce(btrim(" + expr + "),'')";
    return trimmed + " <> '' AND " + trimmed + " <> '" + REDACTED_HEALTH_NUMBER.replace(/'/g, "''") + "'";
  }

  /* The CASE refreshVerification writes. `c` is desk_clients and `d` is
     the document alias. `verified` is not in the CASE: the caller leaves
     a provider result alone. */
  function verificationCaseSql() {
    var typeOk = healthCardExcludedSql("d.doc_type");
    var numbered = idNumberCountsSql("d.doc_number");
    return (
      "CASE WHEN NOT EXISTS (" +
      "SELECT 1 FROM desk_client_identity_documents d " +
      "WHERE d.client_id=c.client_id AND " +
      numbered +
      " AND " +
      typeOk +
      ") THEN 'unverified' WHEN EXISTS (" +
      "SELECT 1 FROM desk_client_identity_documents d " +
      "WHERE d.client_id=c.client_id AND d.is_primary AND " +
      typeOk +
      " AND d.expires_on IS NOT NULL AND d.expires_on < current_date" +
      ") THEN 'expired' ELSE 'identified' END"
    );
  }

  return {
    HEALTH_CARD_NAMES: HEALTH_CARD_NAMES,
    HEALTH_CARD_TYPE_KEYS: HEALTH_CARD_TYPE_KEYS,
    REDACTED_HEALTH_NUMBER: REDACTED_HEALTH_NUMBER,
    typeKey: typeKey,
    isHealthCardType: isHealthCardType,
    scrubHealthNumbers: scrubHealthNumbers,
    healthCardExcludedSql: healthCardExcludedSql,
    idNumberCountsSql: idNumberCountsSql,
    verificationCaseSql: verificationCaseSql,
  };
});
