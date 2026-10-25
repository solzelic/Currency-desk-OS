/* ============================================================
   Settings → Accepted IDs, the pack side, without a database.

   What a pack says about the catalogue's ID types. A type the
   catalogue accepts is on by default, except the pre-2012 citizenship
   card, which starts off. The health card is locked off everywhere,
   and Canada's lock names the law. A later pack can lock another type
   with its own note.
   ============================================================ */
import { describe, expect, it } from "vitest";
import {
  CANADA_HEALTH_CARD_NOTE,
  NEVER_ID_NOTE,
  PACK_ID_TYPE_RULES,
  acceptedCodes,
  idTypeRulesFor,
  keepsPhotoId,
} from "../src/ledger/id-type-rules.js";
import {
  ID_DOCUMENT_TYPES,
  NOT_IN_CATALOGUE,
  noLongerAcceptedSentence,
  notAcceptedHereSentence,
  notInCatalogueSentence,
  pickerLabels,
} from "../src/clients/id-document-types.js";

/* Every jurisdiction a seeded pack names, the baseline, and a pack row
   that is missing altogether (jurisdiction ""). */
const JURISDICTIONS = ["CA", "US", "GB", "EU", "AU", "AE", "RS", "IN", "PH", "INTL", ""];

const ACCEPTED_TODAY = ID_DOCUMENT_TYPES.filter(
  (row) => row.acceptedAsId && row.defaultOn !== false,
).map((row) => row.code);

describe("pack defaults", () => {
  it("switches on every accepted type except the pre-2012 citizenship card, in every pack", () => {
    for (const jurisdiction of JURISDICTIONS) {
      const rules = idTypeRulesFor(jurisdiction);
      expect(rules.map((rule) => rule.code), jurisdiction).toEqual(ID_DOCUMENT_TYPES.map((row) => row.code));
      expect(acceptedCodes(rules, null), jurisdiction).toEqual(ACCEPTED_TODAY);
      expect(rules.filter((rule) => rule.packDefault).map((rule) => rule.code), jurisdiction).toEqual(ACCEPTED_TODAY);
    }
    expect(ACCEPTED_TODAY).not.toContain("citizenship_card");
    expect(ACCEPTED_TODAY).toContain("secure_certificate_of_indian_status");
    /* Secure status on, citizenship off, four business types, and the other person photo types. */
    expect(ACCEPTED_TODAY).toHaveLength(11);
  });

  it("records the ruling categories", () => {
    const rules = idTypeRulesFor("CA");
    const row = (code: string) => rules.find((rule) => rule.code === code)!;
    expect(row("secure_certificate_of_indian_status")).toMatchObject({
      category: "A", packDefault: true, locked: false, photo: true,
    });
    expect(row("citizenship_card")).toMatchObject({
      category: "B", packDefault: false, locked: false, warning: "No expiry date. Old photo. Counter check only.",
    });
    expect(row("provincial_photo_id")).toMatchObject({ category: "A", packDefault: true, photo: true });
    expect(row("national_id_card")).toMatchObject({ category: "A", packDefault: true, photo: true });
    expect(row("bc_services_card")).toMatchObject({ category: "A", packDefault: true, photo: true });
    expect(row("health_card")).toMatchObject({ category: "C", packDefault: false, locked: true });
  });

  it("locks the health card off everywhere, and only the health card", () => {
    for (const jurisdiction of JURISDICTIONS) {
      const locked = idTypeRulesFor(jurisdiction).filter((rule) => rule.locked);
      expect(locked.map((rule) => rule.code), jurisdiction).toEqual(["health_card"]);
      expect(locked[0]!.packDefault, jurisdiction).toBe(false);
      expect(locked[0]!.note, jurisdiction).toBeTruthy();
    }
  });

  it("gives Canada's health card lock the legal note, and every other pack the plain one", () => {
    const canada = idTypeRulesFor("CA").find((rule) => rule.code === "health_card")!;
    expect(canada.note).toBe(CANADA_HEALTH_CARD_NOTE);
    expect(canada.note).toContain("FINTRAC says not to use a health card where provincial law forbids it.");
    expect(canada.note).toContain("Ontario's Health Cards and Numbers Control Act bars it.");
    /* Case and spaces in the stored jurisdiction do not matter. */
    expect(idTypeRulesFor(" ca ").find((rule) => rule.code === "health_card")!.note).toBe(CANADA_HEALTH_CARD_NOTE);
    for (const jurisdiction of ["GB", "AE", "INTL", ""]) {
      const health = idTypeRulesFor(jurisdiction).find((rule) => rule.code === "health_card")!;
      expect(health.note, jurisdiction).toBe(NEVER_ID_NOTE);
      expect(health.note, jurisdiction).not.toContain("FINTRAC");
    }
    expect(Object.keys(PACK_ID_TYPE_RULES)).toEqual(["CA"]);
  });

  it("lets a later pack lock another type with its own note", () => {
    const rules = idTypeRulesFor("XX", {
      XX: { locks: [{ code: "citizenship_card", note: "A test pack locks this type." }] },
    });
    const card = rules.find((rule) => rule.code === "citizenship_card")!;
    expect(card).toMatchObject({ locked: true, packDefault: false, note: "A test pack locks this type." });
    /* The health card stays locked: the catalogue never accepts it. */
    expect(rules.find((rule) => rule.code === "health_card")!.locked).toBe(true);
    expect(acceptedCodes(rules, null)).not.toContain("citizenship_card");
    /* A shop that stored it before the lock does not get it back. */
    expect(acceptedCodes(rules, ["passport", "citizenship_card"])).toEqual(["passport"]);
  });

  it("keeps a stored list in catalogue order, less locks and codes the catalogue no longer has", () => {
    const rules = idTypeRulesFor("CA");
    expect(acceptedCodes(rules, ["business_number", "passport", "health_card", "library_card"])).toEqual([
      "passport",
      "business_number",
    ]);
  });

  it("knows a list with no person photo ID from one with one", () => {
    const rules = idTypeRulesFor("CA");
    expect(keepsPhotoId(rules, ["passport"])).toBe(true);
    expect(keepsPhotoId(rules, ["national_id_card", "business_number"])).toBe(true);
    expect(keepsPhotoId(rules, ["business_number", "incorporation_certificate"])).toBe(false);
    expect(keepsPhotoId(rules, ["health_card"])).toBe(false);
    expect(keepsPhotoId(rules, [])).toBe(false);
  });
});

describe("the sentences", () => {
  it("names this shop's types when a name is not on the list, and every accepted type with no shop", () => {
    expect(NOT_IN_CATALOGUE).toBe(notInCatalogueSentence(pickerLabels()));
    expect(notInCatalogueSentence(["Passport", "Driver's Licence"])).toBe(
      "That ID type isn't on this desk's list. Use one of: Passport, or Driver's Licence.",
    );
  });

  it("says a switched-off type is refused, and where the owner changes it", () => {
    expect(notAcceptedHereSentence("National Identity Card")).toBe(
      "This shop doesn't accept National Identity Card. The owner can change this in Settings → Accepted IDs.",
    );
    expect(noLongerAcceptedSentence("Passport")).toBe(
      "This shop no longer accepts Passport. Record another ID at the next visit.",
    );
  });
});
