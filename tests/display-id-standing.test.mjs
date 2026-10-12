/* The desk label for an ID. While checks are not connected it comes
   from the document, and a stored "verified" word does not move it.
   The function under test is the one the desk ships. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ID_DOCUMENT_TYPES } from "../server/src/ledger/id-document-types.mjs";

const source = readFileSync(new URL("../os-src/cdos-backend.js", import.meta.url), "utf8");
const aliasSource = readFileSync(new URL("../os-src/health-card-aliases.js", import.meta.url), "utf8");
const start = source.indexOf("function displayIdType");
const end = source.indexOf("window.CDOS = Object.assign", start);
const context = vm.createContext({});
vm.runInContext(aliasSource, context);
vm.runInContext(source.slice(start, end), context);
const displayIdStanding = context.displayIdStanding;

const TODAY = "2026-10-11";

test("a stored verified row with no document is Missing ID", () => {
  const standing = displayIdStanding({ verificationStatus: "verified" }, TODAY);
  assert.equal(standing.label, "Missing ID");
  assert.equal(standing.tone, "warning");
  assert.equal(standing.reason, "No ID on file");
  assert.equal(standing.detail, "No ID on file");
  assert.equal(standing.detail.includes("Identified"), false);
});

test("a type without a number, or a number without a type, is Missing ID", () => {
  const noNumber = displayIdStanding({ idType: "Passport", verificationStatus: "verified" }, TODAY);
  assert.equal(noNumber.label, "Missing ID");
  assert.equal(noNumber.reason, "No ID number");
  const noType = displayIdStanding({ idNum: "P-1", verificationStatus: "verified" }, TODAY);
  assert.equal(noType.label, "Missing ID");
  assert.equal(noType.reason, "ID type not stated");
  const blank = displayIdStanding({ idType: "  ", idNum: "  " }, TODAY);
  assert.equal(blank.label, "Missing ID");
  assert.equal(blank.reason, "No ID on file");
});

test("a type and number past expiry is Expired, including a stored verified row", () => {
  const standing = displayIdStanding({
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2020-01-01",
    verificationStatus: "verified",
  }, TODAY);
  assert.equal(standing.label, "Expired");
  assert.equal(standing.tone, "warning");
  assert.equal(standing.status, "expired");
  assert.equal(standing.reason, "An identity document on this file is past its expiry. The till will not treat this customer as identified.");
});

test("a type and number that has not expired is Identified", () => {
  const current = displayIdStanding({
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2030-01-01",
    verificationStatus: "verified",
  }, TODAY);
  assert.equal(current.label, "Identified");
  assert.equal(current.tone, "ok");
  assert.equal(current.detail, "An identity document with a number is on file, and it has not expired.");
  assert.equal(current.reason, current.detail);

  const sameDay = displayIdStanding({ idType: "Passport", idNum: "P-1", idExpiry: TODAY }, TODAY);
  assert.equal(sameDay.label, "Identified");
});

test("a type and number with no expiry is Missing ID", () => {
  const noExpiry = displayIdStanding({ idType: "Passport", idNum: "P-1", verificationStatus: "unverified" }, TODAY);
  assert.equal(noExpiry.label, "Missing ID");
  assert.equal(noExpiry.tone, "warning");
  assert.equal(noExpiry.reason, "ID has no expiry date");
});

test("a current secondary document does not identify the client", () => {
  const secondaryOnly = displayIdStanding({
    idType: "",
    idNum: "",
    documents: [
      { isPrimary: false, docType: "Passport", docNumber: "P-2", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(secondaryOnly.label, "Missing ID");
  assert.equal(secondaryOnly.tone, "warning");
  assert.equal(secondaryOnly.reason, "A current photo ID is needed");
  assert.equal(secondaryOnly.document, null);
  assert.equal(secondaryOnly.expiredDocument, null);

  const expiredPrimary = displayIdStanding({
    idType: "Passport",
    idNum: "OLD",
    idExpiry: "2020-01-01",
    documents: [
      { isPrimary: true, docType: "Passport", docNumber: "OLD", expiresOn: "2020-01-01" },
      { isPrimary: false, docType: "Driver's licence", docNumber: "D-9", expiresOn: "2030-06-01" },
    ],
  }, TODAY);
  assert.equal(expiredPrimary.label, "Missing ID");
  assert.equal(expiredPrimary.status, "missing");
  assert.equal(expiredPrimary.reason, "Photo ID expired on Jan 1, 2020");
  assert.equal(expiredPrimary.document, null);
  assert.equal(expiredPrimary.expiredDocument, null);

  const expiredPlusBirth = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Passport", docNumber: "OLD", expiresOn: "2020-01-01" },
      { isPrimary: false, docType: "Birth certificate", docNumber: "B-1", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(expiredPlusBirth.label, "Missing ID");
  assert.equal(expiredPlusBirth.reason, "Photo ID expired on Jan 1, 2020");
});

test("a current primary is the document shown when it is current", () => {
  const both = displayIdStanding({
    documents: [
      { isPrimary: false, docType: "Passport", docNumber: "P-2", expiresOn: "2030-01-01" },
      { isPrimary: true, docType: "Driver's Licence", docNumber: "D-1", expiresOn: "2029-05-01" },
    ],
  }, TODAY);
  assert.equal(both.label, "Identified");
  assert.equal(both.document.docType, "Driver's Licence");
  assert.equal(both.document.expiresOn, "2029-05-01");
  assert.equal(both.document.isPrimary, true);
  assert.equal(both.expiredDocument, null);
});

test("a phone date is read from the ISO day", () => {
  assert.equal(context.displayIdDate("2020-01-01", true), "Jan 1, 2020");
  assert.equal(context.displayIdDate("2026-10-11", true), "Oct 11, 2026");
  assert.equal(context.displayIdDate("2030-04-01", true), "Apr 1, 2030");
  assert.equal(context.displayIdDate("2030-01-01", false), "Jan 1, 2030");
  assert.equal(context.displayIdDate("not-a-date", true), "");
});

test("a primary typed Not stated, even with a number, is not an ID", () => {
  const primary = displayIdStanding({
    idType: "Not stated",
    idNum: "P-1",
    idExpiry: "2030-01-01",
    documents: [
      { isPrimary: true, docType: "Not stated", docNumber: "P-1", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(primary.label, "Missing ID");
  assert.equal(primary.status, "missing");
  assert.equal(primary.reason, "ID type not stated");

  const withSecondary = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Not stated", docNumber: "P-1", expiresOn: "2030-01-01" },
      { isPrimary: false, docType: "Passport", docNumber: "P-2", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(withSecondary.label, "Missing ID");
  assert.equal(withSecondary.reason, "ID type not stated");
});

test("a number that is only NBSP or zero-width characters is empty", () => {
  const nbsp = displayIdStanding({
    idType: "Passport",
    idNum: "\u00A0\u00A0",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(nbsp.label, "Missing ID");
  assert.equal(nbsp.reason, "No ID number");

  const zeroWidth = displayIdStanding({
    idType: "Passport",
    idNum: "\u200B\u200C\u200D\uFEFF",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(zeroWidth.label, "Missing ID");

  const wrapped = displayIdStanding({
    idType: "Passport",
    idNum: "\u00A0P\u200B-1\uFEFF",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(wrapped.label, "Identified");
});

test("near midnight the business date wins over the browser's local date", () => {
  const midnight = vm.createContext({
    window: { CDOS: { businessDate: () => "2026-10-11" } },
  });
  vm.runInContext(source.slice(start, end), midnight);
  const stillToday = midnight.displayIdStanding({
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2026-10-11",
  }, "2026-10-12");
  assert.equal(stillToday.label, "Identified");

  midnight.window.CDOS.businessDate = () => "2026-10-12";
  const rolled = midnight.displayIdStanding({
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2026-10-11",
  }, "2026-10-11");
  assert.equal(rolled.label, "Expired");
});

test("a stored verified value with no provider record never yields Verified", () => {
  const records = [
    { verificationStatus: "verified" },
    { verificationStatus: "verified", verified: true },
    { verificationStatus: "verified", idType: "Passport", idNum: "P-1", idExpiry: "2030-01-01" },
    { verificationStatus: "verified", personaInquiry: "approved" },
    { verificationStatus: "verified", personaInquiry: { status: "approved" } },
    { verificationStatus: "verified", personaInquiry: { status: "verified", inquiryId: "inq_abc", eventId: "evt_abc", eventName: "inquiry.approved" } },
    { verificationStatus: "verified", personaInquiry: { status: "approved", inquiryId: "not-an-inquiry", eventId: "evt_abc", eventName: "inquiry.approved" } },
    { verificationStatus: "verified", checksConnected: true, kyc: { verified: true } },
  ];
  for (const record of records) {
    const standing = displayIdStanding(record, TODAY);
    assert.notEqual(standing.label, "Verified");
    assert.equal(String(standing.detail || "").includes("authenticated"), false);
    assert.equal(String(standing.reason || "").includes("authenticated"), false);
  }
  const connected = vm.createContext({
    window: { CDOS: { KYC: { checksConnected: () => true }, businessDate: () => TODAY } },
  });
  vm.runInContext(source.slice(start, end), connected);
  const fromClient = connected.displayIdStanding({ verificationStatus: "verified" }, TODAY);
  assert.notEqual(fromClient.label, "Verified");
  assert.equal(fromClient.reason, "No ID on file");
  const passport = displayIdStanding({
    verificationStatus: "verified",
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(passport.label, "Identified");
});

test("idStanding on the response is the label, and a missing field still derives", () => {
  const carried = displayIdStanding({
    idStanding: { status: "expired", label: "Expired", detail: "from the server", tone: "warning" },
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(carried.label, "Expired");
  assert.equal(carried.detail, "from the server");
  assert.equal(carried.document, undefined);

  const absent = displayIdStanding({
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(absent.label, "Identified");

  const empty = displayIdStanding({
    idStanding: null,
    idType: "Passport",
    idNum: "P-1",
    idExpiry: "2020-01-01",
  }, TODAY);
  assert.equal(empty.label, "Expired");
});

test("the desk type table is the server catalogue, and one type allows no expiry", () => {
  assert.equal(JSON.stringify(context.ID_DOCUMENT_TYPES), JSON.stringify(ID_DOCUMENT_TYPES));
  assert.deepEqual(ID_DOCUMENT_TYPES.map((row) => [row.name, row.photo, row.noExpiryAllowed, row.accepted]), [
    ["Passport", true, false, true],
    ["Driver's Licence", true, false, true],
    ["Driver licence", true, false, true],
    ["Driver's License", true, false, true],
    ["Provincial ID", true, false, true],
    ["PR Card", true, false, true],
    ["Permanent Resident Card", true, false, true],
    ["Citizenship Card", false, false, true],
    ["Citizenship certificate (2012 or later, no photo)", false, false, true],
    ["Canadian citizenship card (pre-2012)", true, true, true],
    ["Secure Certificate of Indian Status", true, false, true],
    ["Health Card", false, false, false],
    ["Birth certificate", false, false, true],
  ]);
  assert.equal(ID_DOCUMENT_TYPES.some((row) => row.name === "Certificate of Indian Status"), false);
  const allowed = ID_DOCUMENT_TYPES.filter((row) => row.noExpiryAllowed);
  assert.deepEqual(allowed.map((row) => row.name), ["Canadian citizenship card (pre-2012)"]);
  assert.equal(allowed[0].photo, true);
  const refused = ID_DOCUMENT_TYPES.filter((row) => row.accepted === false);
  assert.deepEqual(refused.map((row) => row.name), ["Health Card"]);
  assert.equal(context.displayIdType("Citizenship Card"), "Citizenship certificate (2012 or later, no photo)");
  assert.equal(context.displayIdType("PR Card"), "Permanent Resident Card");
  assert.equal(context.displayIdType("Driver licence"), "Driver's Licence");
  assert.equal(context.displayIdType("driver licence"), "Driver's Licence");
  assert.equal(context.idTypeRefused("Health Card"), true);
  assert.equal(context.idTypeRefused("Passport"), false);
  assert.equal(context.idTypeRefused("Driver licence"), false);
  assert.equal(context.idTypeNotAccepted("Driver licence"), false);
  assert.equal(context.idTypeNotAccepted("PR Card"), false);
  assert.equal(context.idTypeNotAccepted("Citizenship certificate (2012 or later, no photo)"), false);
  assert.equal(context.idTypeNotAccepted("Birth certificate"), false);
  assert.equal(context.idTypeNotAccepted("Health Card"), true);
  assert.equal(context.idTypeNotAccepted(""), false);
  assert.equal(context.maskStoredIdNumber("Health Card", "HC-RO"), "****C-RO");
  assert.equal(context.maskStoredIdNumber("Health Card", "HC-998877"), "****8877");
  assert.equal(context.maskStoredIdNumber("Health Card", "H-1"), "********");
  assert.equal(context.maskStoredIdNumber("Passport", "P-12345"), "P-12345");
  assert.equal(context.maskStoredIdNumber("Driver licence", "DL-9"), "DL-9");
});

test("a health card is never an ID, even when it is current", () => {
  const only = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Health Card", docNumber: "H-1", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(only.label, "Missing ID");
  assert.equal(only.reason, "Health cards can't be used as ID");
  assert.equal(only.document, null);

  const beside = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Passport", docNumber: "P-1", expiresOn: "2020-01-01" },
      { isPrimary: false, docType: "Health Card", docNumber: "H-1", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(beside.label, "Expired");
  assert.equal(beside.reason, "An identity document on this file is past its expiry. The till will not treat this customer as identified.");
});

test("a pre-2012 citizenship card with no expiry is Identified when it is primary", () => {
  const card = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Canadian citizenship card (pre-2012)", docNumber: "CIT-1" },
    ],
  }, TODAY);
  assert.equal(card.label, "Identified");
  assert.equal(card.tone, "ok");
  assert.equal(card.document.docType, "Canadian citizenship card (pre-2012)");
  assert.equal(card.document.expiresOn, "");
  assert.equal(card.document.isPrimary, true);
  assert.equal(card.detail, "An identity document with a number is on file, and it has not expired.");

  const dated = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Canadian citizenship card (pre-2012)", docNumber: "CIT-1", expiresOn: "2020-01-01" },
    ],
  }, TODAY);
  assert.equal(dated.label, "Expired");

  const secondary = displayIdStanding({
    documents: [
      { isPrimary: false, docType: "Canadian citizenship card (pre-2012)", docNumber: "CIT-1" },
    ],
  }, TODAY);
  assert.equal(secondary.label, "Missing ID");
  assert.equal(secondary.reason, "A current photo ID is needed");
});

test("a blank expiry is Missing ID except on the pre-2012 citizenship card", () => {
  const pr = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Permanent Resident Card", docNumber: "PR-1" },
    ],
  }, TODAY);
  assert.equal(pr.label, "Missing ID");
  assert.equal(pr.reason, "ID has no expiry date");

  const storedShortName = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "PR Card", docNumber: "PR-1" },
    ],
  }, TODAY);
  assert.equal(storedShortName.reason, "ID has no expiry date");

  const status = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Secure Certificate of Indian Status", docNumber: "CIS-1" },
    ],
  }, TODAY);
  assert.equal(status.reason, "ID has no expiry date");

  const laminated = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Certificate of Indian Status", docNumber: "CIS-2" },
    ],
  }, TODAY);
  assert.equal(laminated.reason, "ID has no expiry date");
  const laminatedCurrent = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Certificate of Indian Status", docNumber: "CIS-2", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(laminatedCurrent.reason, "A current photo ID is needed");

  const paper = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Citizenship Card", docNumber: "CIT-2", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(paper.label, "Missing ID");
  assert.equal(paper.reason, "A current photo ID is needed");
  const certificate = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Citizenship certificate (2012 or later, no photo)", docNumber: "CIT-3", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(certificate.reason, "A current photo ID is needed");

  const secure = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Secure Certificate of Indian Status", docNumber: "CIS-9", expiresOn: "2030-06-01" },
    ],
  }, TODAY);
  assert.equal(secure.label, "Identified");
  assert.equal(secure.document.docType, "Secure Certificate of Indian Status");

  const license = displayIdStanding({
    idType: "Driver's License", idNum: "D-US", idExpiry: "2030-01-01",
  }, TODAY);
  assert.equal(license.label, "Identified");

  const birth = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Birth certificate", docNumber: "B-2", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(birth.reason, "A current photo ID is needed");

  const currentPr = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Permanent Resident Card", docNumber: "PR-1", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(currentPr.label, "Identified");
  assert.equal(currentPr.document.docType, "Permanent Resident Card");

  const alias = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Driver licence", docNumber: "DL-ALIAS-1", expiresOn: "2030-06-01" },
    ],
  }, TODAY);
  assert.equal(alias.label, "Identified");
  assert.equal(alias.document.docType, "Driver's Licence");
  assert.equal(context.idTypeRule("Driver licence").name, "Driver's Licence");
  assert.equal(context.idTypeRule("PR Card").name, "Permanent Resident Card");
});

test("a health-card alias is refused and masked, and an unknown type is not accepted", () => {
  const aliases = [
    "OHIP card",
    "ohip card",
    "RAMQ",
    "msp",
    "Alberta Health",
    "health card",
    "  Health   Card  ",
    "Carte d'assurance maladie",
    "BC Services Card",
    "Ontario Health Insurance Plan",
    "Medicare card",
    "BC Care Card",
  ];
  for (const alias of aliases) {
    const standing = displayIdStanding({
      documents: [
        { isPrimary: true, docType: alias, docNumber: "OHIP9988", expiresOn: "2030-01-01" },
      ],
    }, TODAY);
    assert.equal(standing.label, "Missing ID", alias);
    assert.equal(standing.reason, "Health cards can't be used as ID", alias);
    assert.equal(standing.document, null, alias);
    assert.equal(context.idTypeRefused(alias), true, alias);
    assert.equal(context.idTypeNotAccepted(alias), true, alias);
    assert.equal(context.displayIdType(alias), "Health Card", alias);
    const masked = context.maskStoredIdNumber(alias, "OHIP9988");
    assert.equal(masked, "****9988", alias);
    assert.equal(masked.length, 8, alias);
    assert.equal(masked.startsWith("OHI"), false, alias);
    assert.equal(context.maskStoredIdNumber(alias, masked), masked, alias);
    assert.equal(context.CDOS.isHealthCardType(alias), true, alias);
  }
  assert.equal(context.CDOS.isHealthCardType("mspaint"), false);
  assert.equal(context.CDOS.isHealthCardType("Passport"), false);

  const library = displayIdStanding({
    documents: [
      { isPrimary: true, docType: "Library card", docNumber: "LIB-4455", expiresOn: "2030-01-01" },
    ],
  }, TODAY);
  assert.equal(library.label, "Missing ID");
  assert.equal(library.reason, "A current photo ID is needed");
  assert.equal(library.document, null);
  assert.equal(context.idTypeRule("Library card"), null);
  assert.equal(context.idTypeRefused("Library card"), false);
  assert.equal(context.idTypeNotAccepted("Library card"), true);
  assert.equal(context.displayIdType("Library card"), "Library card");
  assert.equal(context.maskStoredIdNumber("Library card", "LIB-4455"), "****4455");
  assert.equal(context.maskStoredIdNumber("mspaint", "PAINT9988"), "****9988");
});

test("a withheld health-card number is blank, never the word undefined", () => {
  for (const value of [undefined, null, "", "   "]) {
    const masked = context.maskStoredIdNumber("Health Card", value);
    assert.equal(masked, "", JSON.stringify(value));
    assert.equal(context.maskStoredIdNumber("OHIP card", value), "", JSON.stringify(value));
    assert.notEqual(masked, "undefined");
    assert.notEqual(masked, "und******");
  }
  assert.equal(context.maskStoredIdNumber("Health Card", "OHIP9988"), "****9988");
  assert.equal(context.maskStoredIdNumber("Passport", undefined), "");

  for (const docNumber of [undefined, null, "", "   "]) {
    const paper = { isPrimary: true, docType: "Health Card", expiresOn: "2030-01-01" };
    if (docNumber !== undefined) paper.docNumber = docNumber;
    const standing = displayIdStanding({ documents: [paper] }, TODAY);
    assert.equal(standing.label, "Missing ID", JSON.stringify(docNumber));
    assert.equal(standing.reason, "Health cards can't be used as ID", JSON.stringify(docNumber));
    assert.equal(standing.document, null, JSON.stringify(docNumber));
  }

  const omitted = displayIdStanding({
    documents: [{ isPrimary: true, docType: "OHIP card", expiresOn: "2030-01-01" }],
  }, TODAY);
  assert.equal(omitted.reason, "Health cards can't be used as ID");

  const passport = displayIdStanding({
    documents: [{ isPrimary: true, docType: "Passport", expiresOn: "2030-01-01" }],
  }, TODAY);
  assert.equal(passport.reason, "No ID number");
});
