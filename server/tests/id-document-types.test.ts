/* The ID-document catalogue, without a database.

   shared/id-document-types.js is one list that the server requires and
   the desk loads as a script. These tests hold the list to what the
   owner asked for: every type a desk records, aliases that fold to it,
   the BC Services Card accepted as photo ID, and a health card present
   but never accepted, never searched, and never kept in a saved copy. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEALTH_CARD_REFUSAL,
  HEALTH_CARD_SHOWN,
  ID_DOCUMENT_TYPES,
  NOT_IN_CATALOGUE,
  isAcceptedIdType,
  isHealthCardType,
  normaliseForWrite,
  pickerLabels,
  resolveIdType,
  scrubHealthNumbers,
  shownIdType,
  typeKey,
} from "../src/clients/id-document-types.js";

const PERSON = [
  "Driver's Licence",
  "Passport",
  "Provincial/Territorial Photo ID",
  "Permanent Resident Card",
  "Citizenship Card",
  "BC Services Card",
  "National Identity Card",
];
const BUSINESS = [
  "Business Number",
  "Incorporation Certificate",
  "Master Business Licence",
  "Articles of Incorporation",
];

describe("the catalogue", () => {
  it("lists every type with the fields a screen and the server need", () => {
    expect(ID_DOCUMENT_TYPES.map((row) => row.label)).toEqual([
      ...PERSON,
      "Health Card",
      ...BUSINESS,
    ]);
    for (const row of ID_DOCUMENT_TYPES) {
      expect(row.code, row.label).toMatch(/^[a-z_]+$/);
      expect(["person", "business"], row.label).toContain(row.kind);
      expect(typeof row.photo, row.label).toBe("boolean");
      expect(typeof row.mayLackExpiry, row.label).toBe("boolean");
      expect(Array.isArray(row.aliases), row.label).toBe(true);
    }
    expect(new Set(ID_DOCUMENT_TYPES.map((row) => row.code)).size).toBe(ID_DOCUMENT_TYPES.length);
  });

  it("offers the person and business types and never the health card", () => {
    expect(pickerLabels("person")).toEqual(PERSON);
    expect(pickerLabels("business")).toEqual(BUSINESS);
    expect(pickerLabels()).not.toContain("Health Card");
  });

  it("stores the catalogue label for a label, a code, or an alias", () => {
    const cases: [string, string][] = [
      ["Passport", "Passport"],
      ["  passport ", "Passport"],
      ["PR Card", "Permanent Resident Card"],
      ["pr card", "Permanent Resident Card"],
      ["Provincial ID", "Provincial/Territorial Photo ID"],
      ["Driver's License", "Driver's Licence"],
      ["Driver’s Licence", "Driver's Licence"],
      ["drivers_licence", "Driver's Licence"],
      ["BC Services Card", "BC Services Card"],
      ["Emirates ID", "National Identity Card"],
      ["national id", "National Identity Card"],
      ["Certificate of Incorporation", "Incorporation Certificate"],
      ["Master Business License", "Master Business Licence"],
      ["Articles of Incorporation", "Articles of Incorporation"],
      ["Business Number", "Business Number"],
      ["Not stated", "Not stated"],
    ];
    for (const [typed, stored] of cases) {
      expect(normaliseForWrite(typed), typed).toMatchObject({ ok: true, label: stored });
    }
  });

  it("accepts the BC Services Card as photo ID and does not read it as a health card", () => {
    const row = resolveIdType("BC Services Card");
    expect(row).toMatchObject({ code: "bc_services_card", kind: "person", photo: true, acceptedAsId: true });
    expect(isHealthCardType("BC Services Card")).toBe(false);
    expect(isAcceptedIdType("bc services card")).toBe(true);
  });

  it("refuses a type the catalogue does not list, naming the accepted ones", () => {
    for (const typed of ["Library card", "Costco card", "Birth certificate", "Medicare", "Medicare card", "mspaint"]) {
      const result = normaliseForWrite(typed);
      expect(result, typed).toEqual({ ok: false, code: "ID_TYPE_NOT_IN_CATALOGUE", detail: NOT_IN_CATALOGUE });
    }
    expect(NOT_IN_CATALOGUE).toBe(
      "That ID type isn't on this desk's list. Use one of: Driver's Licence, Passport, Provincial/Territorial Photo ID, " +
        "Permanent Resident Card, Citizenship Card, BC Services Card, National Identity Card, Business Number, " +
        "Incorporation Certificate, Master Business Licence, or Articles of Incorporation.",
    );
    expect(NOT_IN_CATALOGUE).not.toContain("Health");
  });
});

describe("health cards", () => {
  const HEALTH_NAMES = [
    "Health Card",
    "health card",
    " HEALTH   CARD ",
    "health-card",
    "OHIP",
    "Ontario Health Insurance Plan",
    "Carte d'assurance maladie",
    "Carte d’assurance maladie",
    "RAMQ",
    "Régie de l'assurance maladie du Québec",
    "MSP",
    "Care Card",
    "Alberta Health Care Insurance Plan",
    "New Brunswick Medicare",
    "Manitoba Health",
    "Saskatchewan Health Card",
    "Nova Scotia Health Card",
    "Prince Edward Island Health Card",
    "Newfoundland and Labrador Medical Care Plan",
    "Northwest Territories Health Care Card",
    "Nunavut Health Care Card",
    "Yukon Health Care Card",
  ];

  it("resolves every health-card name to the one row, which is not accepted", () => {
    for (const name of HEALTH_NAMES) {
      expect(isHealthCardType(name), name).toBe(true);
      expect(isAcceptedIdType(name), name).toBe(false);
      expect(normaliseForWrite(name), name).toEqual({
        ok: false,
        code: "HEALTH_CARD_NOT_ID",
        detail: "Health cards can't be used as ID. Record a current photo ID.",
      });
    }
    expect(HEALTH_CARD_REFUSAL).toBe("Health cards can't be used as ID. Record a current photo ID.");
  });

  it("matches a whole type, not a word inside one", () => {
    for (const name of ["healthcare", "mspaint", "careful card", "Ontario", "Medicare", "Medicare card", "Passport", "", null, undefined]) {
      expect(isHealthCardType(name), String(name)).toBe(false);
    }
    expect(typeKey("Carte d'assurance maladie")).toBe("carte dassurance maladie");
  });

  it("is shown as not accepted, and every other type is shown as stored", () => {
    expect(HEALTH_CARD_SHOWN).toBe("Health card — not accepted as ID");
    expect(shownIdType("OHIP")).toBe(HEALTH_CARD_SHOWN);
    expect(shownIdType("PR Card")).toBe("PR Card");
    expect(shownIdType("Birth certificate")).toBe("Birth certificate");
    expect(shownIdType(null)).toBe("");
  });

  it("drops a health number from a saved copy and leaves everything else as it was", () => {
    const client = {
      idType: "OHIP",
      idNum: "HN-PRIV-1",
      dob: "1980-01-01",
      ids: [
        { type: "Passport", num: "PA-1" },
        { type: "Carte d'assurance maladie", num: "HN-PRIV-2" },
      ],
      documents: [{ docType: "MSP", docNumber: "HN-PRIV-3", expiresOn: "2030-01-01" }],
    };
    const state = {
      cdos_clients_v1: JSON.stringify({ "Hana Health": client }),
      cdos_settings: JSON.stringify({ bizName: "Desk" }),
      cdos_cheque_schedule_v1: "[{\"id\":\"government\"}]",
      plain: "not json",
    };
    const cleaned = scrubHealthNumbers(state);
    expect(JSON.stringify(cleaned)).not.toContain("HN-PRIV");
    const back = JSON.parse(cleaned.cdos_clients_v1)["Hana Health"];
    expect(back).not.toHaveProperty("idNum");
    expect(back.idType).toBe("OHIP");
    expect(back.dob).toBe("1980-01-01");
    expect(back.ids[0]).toEqual({ type: "Passport", num: "PA-1" });
    expect(back.ids[1]).toEqual({ type: "Carte d'assurance maladie" });
    expect(back.documents[0]).toEqual({ docType: "MSP", expiresOn: "2030-01-01" });
    /* Untouched values are the same values, byte for byte. */
    expect(cleaned.cdos_settings).toBe(state.cdos_settings);
    expect(cleaned.cdos_cheque_schedule_v1).toBe(state.cdos_cheque_schedule_v1);
    expect(cleaned.plain).toBe("not json");
    const clean = { cdos_clients_v1: JSON.stringify({ A: { idType: "Passport", idNum: "PA-2" } }) };
    expect(scrubHealthNumbers(clean)).toBe(clean);
  });
});

describe("one list, two loaders", () => {
  const root = resolve(process.cwd(), "..");

  it("is loaded by the desk shell before the code that reads it", () => {
    const shell = readFileSync(resolve(root, "CurrencyDesk OS.html"), "utf8");
    const shared = shell.indexOf('src="shared/id-document-types.js"');
    expect(shared).toBeGreaterThan(-1);
    expect(shared).toBeLessThan(shell.indexOf('src="os-src/cdos-backend.js"'));
    expect(shared).toBeLessThan(shell.indexOf('src="os-src/cdos-clients.jsx"'));
  });

  it("is in the built desk, and no screen keeps its own list or offers a health card", () => {
    const bundle = readFileSync(resolve(root, "web/app/os.js"), "utf8");
    expect(bundle).toContain("---- shared/id-document-types.js ----");
    for (const file of ["os-src/cdos-clients.jsx", "os-src/cdos-ledger.jsx"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).not.toMatch(/['"]Health Card['"]/);
      expect(source, file).toContain("pickerLabels(");
    }
  });

  it("does not copy a client's number into a filing unless the catalogue accepts its type", () => {
    const lctr = readFileSync(resolve(root, "os-src/cdos-lctr.jsx"), "utf8");
    expect(lctr).toContain("isAcceptedIdType(rec.idType)");
    expect(lctr).not.toContain("subj.idNum");
    expect(lctr).not.toContain("cond.idNum");
  });

  it("keeps the number out of the register, its CSV, search, and the printed file", () => {
    const reports = readFileSync(resolve(root, "os-src/cdos-reports.jsx"), "utf8");
    expect(reports).not.toContain("c.idNum || '—'");
    expect(reports).not.toContain("c.idNum || '', c.idExpiry");
    const clients = readFileSync(resolve(root, "os-src/cdos-clients.jsx"), "utf8");
    expect(clients).not.toContain("${r.idNum || ''}");
    expect(clients).not.toContain("row('Number', rec.idNum)");
  });

  it("does not call a client verified because papers are on file", () => {
    for (const file of ["os-src/cdos-ledger.jsx", "os-src/cdos-reports.jsx"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).not.toContain("'ID verified'");
      expect(source, file).not.toContain("All active clients verified.");
      expect(source, file).not.toMatch(/'ID expired' : 'verified'/);
    }
  });
});
