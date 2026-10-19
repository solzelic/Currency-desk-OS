/* ============================================================
   The ID-document catalogue. One list, loaded by the server and by the
   desk.

   The server loads this file with `require` (server/src/clients/
   id-document-types.ts). The desk shell loads it as a plain script
   before cdos-backend.js, and scripts/build-os.mjs puts it in
   web/app/os.js. Neither side keeps a copy of these names.

   Each type has:
     code           stable id. Never shown.
     label          what the desk shows and what the server stores.
     kind           'person' or 'business'.
     photo          the document carries the holder's photograph.
     mayLackExpiry  a blank expiry is normal for this document.
     acceptedAsId   false only for the health card.
     aliases        other names that mean the same document.

   A name matches the whole type after the same fold on both sides:
   lower case, apostrophes removed, every run of anything that is not
   a-z or 0-9 turned into one space. "healthcare" is not "health card".
   "mspaint" is not "MSP".

   HEALTH CARDS. The row is here so a health card already stored still
   resolves to a type. It is not accepted as ID. Ontario's Health Cards
   and Numbers Control Act, 1991 bars a business outside health care
   from collecting or using a health number, and FINTRAC says not to use
   a health card where provincial law prohibits it. The desk refuses a
   new one everywhere and never shows, searches, or sends the number.

   The BC Services Card is NOT a health card here. The photo version is
   a provincial government photo ID, and FINTRAC accepts it. A bare
   "Medicare" is not an alias, and neither is "Medicare card": both are
   also the name of Australia's card.

   "Not stated" is not a type. It is the placeholder the desk writes
   when a document row exists before anybody has picked its type.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.CDOS_ID_TYPES = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var HEALTH_CARD = "health_card";
  var NOT_STATED = "Not stated";
  var HEALTH_CARD_REFUSAL = "Health cards can't be used as ID. Record a current photo ID.";
  var HEALTH_CARD_SHOWN = "Health card — not accepted as ID";

  var TYPES = [
    {
      code: "drivers_licence", label: "Driver's Licence", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: ["Driver's License", "Drivers Licence", "Drivers License", "Driver Licence", "Driver License", "Driving Licence"],
    },
    {
      code: "passport", label: "Passport", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: [],
    },
    {
      code: "provincial_photo_id", label: "Provincial/Territorial Photo ID", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: ["Provincial ID", "Territorial ID", "Provincial Photo ID", "Territorial Photo ID", "Provincial or Territorial Photo ID", "Ontario Photo Card"],
    },
    {
      code: "permanent_resident_card", label: "Permanent Resident Card", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: ["PR Card"],
    },
    {
      /* The card IRCC issued until 2012 carried a photograph and no
         expiry. The paper certificate issued since is not this type. */
      code: "citizenship_card", label: "Citizenship Card", kind: "person",
      photo: true, mayLackExpiry: true, acceptedAsId: true,
      aliases: ["Canadian Citizenship Card"],
    },
    {
      code: "bc_services_card", label: "BC Services Card", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: ["BC Services Card with photo"],
    },
    {
      /* A government photo ID card from another country, such as an
         Emirates ID or a German Personalausweis. FINTRAC accepts a
         foreign government's photo ID, and desks outside Canada record
         their own country's card here. */
      code: "national_id_card", label: "National Identity Card", kind: "person",
      photo: true, mayLackExpiry: false, acceptedAsId: true,
      aliases: ["National ID", "National ID Card", "National Identity Document", "Identity Card", "ID Card", "Emirates ID"],
    },
    {
      code: HEALTH_CARD, label: "Health Card", kind: "person",
      photo: false, mayLackExpiry: false, acceptedAsId: false,
      aliases: [
        "Health Insurance Card",
        "Provincial Health Card",
        "OHIP",
        "OHIP card",
        "Ontario Health Insurance Plan",
        "Ontario Health Card",
        "Carte d'assurance maladie",
        "Carte soleil",
        "RAMQ",
        "RAMQ card",
        "Régie de l'assurance maladie du Québec",
        "Regie de l'assurance maladie du Quebec",
        "MSP",
        "MSP card",
        "Medical Services Plan",
        "Care Card",
        "BC Care Card",
        "Alberta Health",
        "Alberta Health Card",
        "Alberta Health Care",
        "Alberta Health Care Insurance Plan",
        "New Brunswick Medicare",
        "NB Medicare",
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
      ],
    },
    {
      code: "business_number", label: "Business Number", kind: "business",
      photo: false, mayLackExpiry: true, acceptedAsId: true,
      aliases: ["BN"],
    },
    {
      code: "incorporation_certificate", label: "Incorporation Certificate", kind: "business",
      photo: false, mayLackExpiry: true, acceptedAsId: true,
      aliases: ["Certificate of Incorporation"],
    },
    {
      code: "master_business_licence", label: "Master Business Licence", kind: "business",
      photo: false, mayLackExpiry: true, acceptedAsId: true,
      aliases: ["Master Business License"],
    },
    {
      code: "articles_of_incorporation", label: "Articles of Incorporation", kind: "business",
      photo: false, mayLackExpiry: true, acceptedAsId: true,
      aliases: [],
    },
  ];

  function typeKey(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/['‘’]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* Every name, folded, to its row. Two rows may never share a name. */
  var BY_KEY = Object.create(null);
  TYPES.forEach(function (row) {
    Object.freeze(row.aliases);
    [row.code, row.label].concat(row.aliases).forEach(function (name) {
      var key = typeKey(name);
      if (!key) throw new Error("An ID type name folds to nothing: " + name);
      if (BY_KEY[key] && BY_KEY[key] !== row) {
        throw new Error("Two ID types share the name " + name);
      }
      BY_KEY[key] = row;
    });
    Object.freeze(row);
  });
  Object.freeze(TYPES);
  var NOT_STATED_KEY = typeKey(NOT_STATED);
  if (BY_KEY[NOT_STATED_KEY]) throw new Error("\"Not stated\" cannot be an ID type");

  /* The row a name means, or null. */
  function resolveIdType(value) {
    var key = typeKey(value);
    return key ? (BY_KEY[key] || null) : null;
  }

  function isNotStated(value) {
    return typeKey(value) === NOT_STATED_KEY;
  }

  function isHealthCardType(value) {
    var row = resolveIdType(value);
    return !!(row && row.code === HEALTH_CARD);
  }

  /* In the catalogue and accepted as ID. */
  function isAcceptedIdType(value) {
    var row = resolveIdType(value);
    return !!(row && row.acceptedAsId);
  }

  /* What a picker offers for a new document of this kind. */
  function pickerLabels(kind) {
    return TYPES.filter(function (row) {
      return row.acceptedAsId && (!kind || row.kind === kind);
    }).map(function (row) { return row.label; });
  }

  /* The words a screen shows for a stored type. A health card says it
     is not accepted. Anything else is shown as it was stored. */
  function shownIdType(value) {
    if (isHealthCardType(value)) return HEALTH_CARD_SHOWN;
    return value == null ? "" : String(value);
  }

  function listInWords(labels) {
    if (labels.length <= 1) return labels.join("");
    return labels.slice(0, -1).join(", ") + ", or " + labels[labels.length - 1];
  }

  /* The refusal for a name that is not on the list. The server passes
     the types this shop accepts. With no shop, it is every accepted
     type in the catalogue. */
  function notInCatalogueSentence(labels) {
    return "That ID type isn't on this desk's list. Use one of: " + listInWords(labels) + ".";
  }

  var NOT_IN_CATALOGUE = notInCatalogueSentence(pickerLabels());

  /* Settings → Accepted IDs. The owner can switch a type off for their
     shop. A new document of that type is refused with the first
     sentence. A document already on file keeps reading, with the second
     one beside it. */
  function notAcceptedHereSentence(label) {
    return "This shop doesn't accept " + label + ". The owner can change this in Settings → Accepted IDs.";
  }

  function noLongerAcceptedSentence(label) {
    return "This shop no longer accepts " + label + ". Record another ID at the next visit.";
  }

  /* What a write may store. Either the catalogue label, the placeholder,
     or a refusal with its code and sentence. */
  function normaliseForWrite(value) {
    if (isNotStated(value)) return { ok: true, label: NOT_STATED };
    var row = resolveIdType(value);
    if (!row) return { ok: false, code: "ID_TYPE_NOT_IN_CATALOGUE", detail: NOT_IN_CATALOGUE };
    if (!row.acceptedAsId) return { ok: false, code: "HEALTH_CARD_NOT_ID", detail: HEALTH_CARD_REFUSAL };
    return { ok: true, label: row.label, code: row.code };
  }

  /* ---- health numbers in a stored copy -------------------------------

     A saved desk document, a localStorage value, or a cached client
     record can still hold a health number written before this list
     existed. This walks any JSON value. An object whose type field names
     a health card loses its number field. A string that is JSON is read,
     cleaned, and written back as a string. Anything that needed no
     change comes back as the same value, so a caller can compare with
     === and not rewrite what was already clean. */
  var NUMBER_FIELDS = { docNumber: 1, doc_number: 1, idNum: 1, num: 1, number: 1 };
  var TYPE_FIELDS = ["docType", "doc_type", "idType", "type"];

  function namesHealthCard(value) {
    for (var i = 0; i < TYPE_FIELDS.length; i++) {
      if (isHealthCardType(value[TYPE_FIELDS[i]])) return true;
    }
    return false;
  }

  function scrubHealthNumbers(value) {
    if (typeof value === "string") {
      var first = value.charAt(0);
      if (first !== "{" && first !== "[") return value;
      var parsed;
      try { parsed = JSON.parse(value); } catch (error) { return value; }
      var cleaned = scrubHealthNumbers(parsed);
      return cleaned === parsed ? value : JSON.stringify(cleaned);
    }
    if (Array.isArray(value)) {
      var changed = false;
      var items = value.map(function (item) {
        var next = scrubHealthNumbers(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? items : value;
    }
    if (!value || typeof value !== "object") return value;
    var drop = namesHealthCard(value);
    var touched = false;
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (drop && NUMBER_FIELDS[key]) { touched = true; return; }
      var next = scrubHealthNumbers(value[key]);
      if (next !== value[key]) touched = true;
      out[key] = next;
    });
    return touched ? out : value;
  }

  /* The same fold as typeKey(), in Postgres. Any letter outside a-z is
     a space on both sides, so the two always agree. */
  function typeKeySql(expr) {
    return "btrim(regexp_replace(regexp_replace(lower(" + expr + "), '[''‘’]', '', 'g'), '[^a-z0-9]+', ' ', 'g'))";
  }

  /* Every folded name that means a health card, for a query parameter. */
  var HEALTH_CARD_KEYS = Object.keys(BY_KEY).filter(function (key) {
    return BY_KEY[key].code === HEALTH_CARD;
  });

  return {
    ID_DOCUMENT_TYPES: TYPES,
    HEALTH_CARD: HEALTH_CARD,
    NOT_STATED: NOT_STATED,
    HEALTH_CARD_REFUSAL: HEALTH_CARD_REFUSAL,
    HEALTH_CARD_SHOWN: HEALTH_CARD_SHOWN,
    NOT_IN_CATALOGUE: NOT_IN_CATALOGUE,
    HEALTH_CARD_KEYS: HEALTH_CARD_KEYS,
    typeKey: typeKey,
    resolveIdType: resolveIdType,
    isNotStated: isNotStated,
    isHealthCardType: isHealthCardType,
    isAcceptedIdType: isAcceptedIdType,
    pickerLabels: pickerLabels,
    shownIdType: shownIdType,
    notInCatalogueSentence: notInCatalogueSentence,
    notAcceptedHereSentence: notAcceptedHereSentence,
    noLongerAcceptedSentence: noLongerAcceptedSentence,
    normaliseForWrite: normaliseForWrite,
    scrubHealthNumbers: scrubHealthNumbers,
    typeKeySql: typeKeySql,
  };
});
