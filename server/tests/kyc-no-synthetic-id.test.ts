/* The desk used to invent a date of birth, an address and an ID number
   from a hash of the customer's name, then write them onto the file as
   if a provider had read them off a document. This test is the lock on
   that door: the generator is gone from the source and from the bundle
   Render serves. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = readFileSync(new URL("os-src/cdos-kyc.jsx", root), "utf8");
const bundle = readFileSync(new URL("web/app/os.js", root), "utf8");
const sink = readFileSync(new URL("os-src/cdos-os.jsx", root), "utf8");

const GENERATED = [
  "function extractIdentity",
  "Bathurst St",
  "Dundas St W",
  "auto-filled onto this contact",
  "Pulled from the ID",
  "fills in the rest from the ID",
];

describe("KYC does not invent an identity", () => {
  for (const [name, text] of [
    ["os-src/cdos-kyc.jsx", source],
    ["web/app/os.js", bundle],
  ] as const) {
    it(`${name} has no generator and says scanning is not connected`, () => {
      for (const needle of GENERATED) expect(text, needle).not.toContain(needle);
      expect(text).toContain("ID scanning isn't connected yet");
      expect(text).toContain("Save client");
      expect(text).toContain("Jane Doe");
    });
  }

  it("does not copy a verification result onto the contact's ID fields", () => {
    expect(sink).not.toContain("setContactSink");
    expect(source).not.toMatch(/extracted:\s*\(t\.idv/);
  });

  it("does not finish an ID check on a timer or file it as verified", () => {
    for (const text of [source, bundle]) {
      expect(text).not.toMatch(/setInterval\(\s*reconcile/);
      expect(text).not.toContain("c.result = resolve(c)");
      expect(text).not.toContain("check.result = resolve(check)");
      expect(text).toContain("ID checks not connected yet");
      expect(text).toContain("Check the client's ID in person and record it on their file.");
      expect(text).not.toContain("No ID on file yet.");
      expect(text).not.toContain("run a verify check to establish identity");
      expect(text).toContain("return false");
    }
    expect(source).toContain("function checksConnected() { return false; }");
    const clients = readFileSync(new URL("os-src/cdos-clients.jsx", root), "utf8");
    const tx = readFileSync(new URL("os-src/cdos-txmodal.jsx", root), "utf8");
    expect(clients).toContain("if (!(window.CDOS.KYC && window.CDOS.KYC.checksConnected && window.CDOS.KYC.checksConnected())) return null;");
    /* The deal list does not ask the browser's check list whether the
       customer is verified. The label is displayIdStanding. */
    expect(tx).toContain("displayIdStanding(");
    expect(tx).not.toContain("checksFor(");
    expect(tx).not.toContain("ID verified");
  });

  it("does not price a check or promise a link in the built desk", () => {
    const banned = [
      "The ID you scanned is checked instantly",
      "secure link",
      "$3.99",
      "$6.99",
      "$14.99",
    ];
    for (const needle of banned) {
      expect(source, needle).not.toContain(needle);
      expect(bundle, needle).not.toContain(needle);
    }
    expect(source).not.toContain("screened against");
    expect(bundle).not.toContain("screened against");
    expect(source).toContain('data-testid="persona-not-connected"');
    expect(bundle).toContain("Persona is not connected yet.");
    expect(bundle).toContain("ID checks aren't connected. Type the ID type and number from the document.");
    const tx = readFileSync(new URL("os-src/cdos-txmodal.jsx", root), "utf8");
    expect(tx).toContain("onRecordId: () => setRecordId(true)");
  });

  it("offers Permanent Resident Card and shows a stored PR Card as that", () => {
    const tx = readFileSync(new URL("os-src/cdos-txmodal.jsx", root), "utf8");
    const lists = [
      ["os-src/cdos-kyc.jsx", source],
      ["os-src/cdos-clients.jsx", readFileSync(new URL("os-src/cdos-clients.jsx", root), "utf8")],
      ["os-src/cdos-ledger.jsx", readFileSync(new URL("os-src/cdos-ledger.jsx", root), "utf8")],
    ] as const;
    for (const [name, text] of lists) {
      expect(text, name).not.toMatch(/['"]PR Card['"]/);
      expect(text, name).toContain("Permanent Resident Card");
    }
    /* The phone sheet no longer keeps its own type list. Record the ID
       opens the client file's editor, which is the list above. */
    expect(tx).not.toMatch(/['"]PR Card['"]/);
    expect(tx).toContain("setRecordId(true)");
    const clients = readFileSync(new URL("os-src/cdos-clients.jsx", root), "utf8");
    const sheet = clients.slice(clients.indexOf("function RecordIdSheet"), clients.indexOf("RecordIdSheet is that same identity editor"));
    expect(sheet).toContain("source: 'staff'");
    const backend = readFileSync(new URL("os-src/cdos-backend.js", root), "utf8");
    expect(backend).toContain('if (type === "PR Card") return "Permanent Resident Card";');
    expect(backend).toContain('if (type === "Citizenship Card") return "Citizenship certificate (2012 or later, no photo)";');
    expect(backend).toContain('if (type === "Driver licence") return "Driver\'s Licence";');
    expect(backend).toContain("function idTypeNotAccepted");
    expect(backend).toContain("idTypeNotAccepted: idTypeNotAccepted");
    expect(bundle).toContain('if (type === "PR Card") return "Permanent Resident Card";');
    expect(bundle).toContain('if (type === "Citizenship Card") return "Citizenship certificate (2012 or later, no photo)";');
    expect(bundle).toContain('if (type === "Driver licence") return "Driver\'s Licence";');
    expect(bundle).toContain("function idTypeNotAccepted");
    const pickerArrays = [...bundle.matchAll(/const (?:ID_TYPES_IND|ID_TYPES_CORP|ID_TYPES|PERSON_ID_TYPES|BUSINESS_ID_TYPES) = \[[^\]]*\]/g)].map((match) => match[0]);
    expect(pickerArrays.length).toBeGreaterThan(0);
    for (const list of pickerArrays) {
      expect(list, list).not.toContain("PR Card");
      expect(list, list).not.toContain("Health Card");
      expect(list, list).not.toContain("Citizenship Card");
      expect(list, list).not.toContain("Driver licence");
    }
    expect(clients).toContain("Canadian citizenship card (pre-2012)");
    expect(clients).toContain("Citizenship certificate (2012 or later, no photo)");
    expect(clients).toContain("Secure Certificate of Indian Status");
    expect(clients).toContain("Driver's License");
    expect(clients).toContain("Birth certificate");
    expect(clients).not.toMatch(/['"]Citizenship Card['"]/);
    expect(clients).not.toMatch(/['"]Certificate of Indian Status['"]/);
    expect(clients).not.toMatch(/['"]Health Card['"]/);
    expect(clients).toContain("Health cards can't be used as ID");
    expect(clients).toContain('data-testid="refused-id-row"');
    expect(clients).toContain('data-testid="primary-id-slot"');
    expect(clients).toContain('data-testid="not-accepted-id"');
    expect(clients).toContain("No current photo ID");
    expect(clients).toContain("Not accepted as ID");
    expect(clients).toContain("idTypeNotAccepted");
    const lctr = readFileSync(new URL("os-src/cdos-lctr.jsx", root), "utf8");
    expect(lctr).toContain("F('su_idnum', 'Identifier number', '*', 'PROMPT', ''");
    expect(lctr).toContain("F('cd_idnum', 'Identifier number', '*', 'PROMPT', ''");
    expect(lctr).not.toContain("subj.idNum");
    expect(lctr).not.toContain("cond.idNum");
    expect(backend).toContain("function maskStoredIdNumber");
    expect(backend).toContain("idTypeRule: idTypeRule");
    expect(source).toContain("Canadian citizenship card (pre-2012)");
    expect(source).toContain("Citizenship certificate (2012 or later, no photo)");
    expect(source).toContain("Secure Certificate of Indian Status");
    expect(source).toContain("Driver's License");
    expect(source).not.toMatch(/['"]Citizenship Card['"]/);
    expect(source).not.toMatch(/['"]Certificate of Indian Status['"]/);
    expect(source).not.toMatch(/['"]Health Card['"]/);
    const ledger = readFileSync(new URL("os-src/cdos-ledger.jsx", root), "utf8");
    expect(ledger).toContain("Citizenship certificate (2012 or later, no photo)");
    expect(ledger).toContain("Secure Certificate of Indian Status");
    expect(ledger).not.toMatch(/['"]Citizenship Card['"]/);
    expect(ledger).not.toMatch(/['"]Certificate of Indian Status['"]/);
    expect(ledger).not.toMatch(/['"]Health Card['"]/);
  });

  it("derives the ID label from the document, through one helper", () => {
    const backend = readFileSync(new URL("os-src/cdos-backend.js", root), "utf8");
    const clients = readFileSync(new URL("os-src/cdos-clients.jsx", root), "utf8");
    const reports = readFileSync(new URL("os-src/cdos-reports.jsx", root), "utf8");
    const tx = readFileSync(new URL("os-src/cdos-txmodal.jsx", root), "utf8");
    const ledger = readFileSync(new URL("os-src/cdos-ledger.jsx", root), "utf8");
    expect(backend).toContain("function displayIdStanding(record, today)");
    expect(backend).toContain("if (record.idStanding && record.idStanding.label) return record.idStanding;");
    expect(backend).toContain('type === "Not stated"');
    expect(backend).toContain("idStanding: record.idStanding || null");
    for (const phrase of ["ID has no expiry date", "ID type not stated", "No ID number", "No ID on file"]) {
      expect(backend, phrase).toContain(phrase);
    }
    expect(tx).toContain("displayIdStanding(c, window.CDOS.businessDate())");
    expect(tx).toContain("ID needed for this amount");
    expect(tx).toContain('className="cd-tx-id-need-reason"');
    expect(tx).toContain("standing.reason || standing.detail || standing.label");
    expect(tx).toContain("cd-tx-id-ok");
    expect(tx).toContain("standing.document");
    expect(tx).toContain("cd-tx-id-expired");
    expect(tx).toContain("displayIdDate(");
    expect(tx).not.toContain("rec.idExpiry");
    expect(backend).toContain("function displayIdDate");
    expect(backend).toContain("document: currentPrimary");
    expect(backend).toContain("expiredDocument: expiredPhoto");
    expect(backend).toContain("Health cards can't be used as ID");
    expect(backend).toContain("Photo ID expired on ");
    expect(backend).toContain("A current photo ID is needed");
    expect(backend).toContain("Canadian citizenship card (pre-2012)");
    expect(backend).toContain("noExpiryAllowed");
    expect(backend).not.toContain('if (status === "verified" && !idChecksConnected()) return "identified";');
    expect(backend).not.toContain('record.verificationStatus === "verified"');
    expect(backend).toContain('eventName !== "inquiry.approved"');
    const modules = readFileSync(new URL("os-src/cdos-modules.jsx", root), "utf8");
    const transfers = readFileSync(new URL("os-src/cdos-transfers.jsx", root), "utf8");
    for (const text of [clients, source, reports, tx, ledger, modules, transfers]) {
      expect(text).toContain("displayIdStanding(");
    }
    const payload = backend.slice(backend.indexOf("function customerPayload"), backend.indexOf("async function syncCustomer"));
    expect(payload).toContain("displayIdStanding(record)");
    expect(payload).not.toContain("new Date(");
    expect(payload).not.toContain("verificationStatus");
    expect(payload).not.toContain("screeningOutcome");
    expect(payload).not.toContain("screeningMatched");
    expect(payload).toContain("idStatus: idStatus");
    expect(clients).toContain("['identified', 'Identified', counts.verified]");
    expect(clients).not.toContain("'Verified', counts.verified");
    expect(clients).not.toContain("The identity on file was authenticated.");
    expect(reports).toContain("All active clients have an ID on file.");
    expect(reports).not.toContain("All active clients verified.");
  });
});
