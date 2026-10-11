/* Each spelling that used to slip past /\bOFAC\b/, and the ordinary
   words that must keep passing. Run with: node --test tests/sanctions-phrases.test.mjs
   ============================================================ */
import test from "node:test";
import assert from "node:assert/strict";
import { bannedNameHits, bannedBundleHits } from "../scripts/check-sanctions-phrases.mjs";

const flagged = [
  ["Ofac", "OFAC"],
  ["OFACs", "OFAC"],
  ["O.F.A.C.", "OFAC"],
  ["U.N.", "UN"],
  ["OSFI's", "OSFI"],
];

for (const [text, name] of flagged) {
  test(`flags ${text}`, () => {
    const hits = bannedNameHits(text);
    assert.ok(hits.some((hit) => hit.name === name), JSON.stringify(hits));
  });
}

for (const text of ["unit", "under"]) {
  test(`allows ${text}`, () => {
    assert.deepEqual(bannedNameHits(text), []);
  });
}

test("flags the other spellings the seam used to miss", () => {
  for (const text of ["ofac list", "OFAC-listed", "OSFIs", "O.S.F.I.", "WEI LIN", "UN sanctions", "u.n. list"]) {
    assert.notDeepEqual(bannedNameHits(text), [], text);
  }
  assert.ok(bannedNameHits("OFAC\u00A0list").some((hit) => hit.name === "OFAC"));
});

test("flags un followed by list, sanctions, or security council", () => {
  for (const text of [
    "un list",
    "un sanctions",
    "un security council",
    "UN  sanctions",
    "Un\nlist",
    "un security  council",
    "uN\tLiSt",
    "un\u00A0security\u00A0council",
    "un\nsecurity\ncouncil",
  ]) {
    assert.ok(bannedNameHits(text).some((hit) => hit.name === "UN"), text);
  }
});

test("allows words that merely contain those letters", () => {
  for (const text of [
    "unit",
    "under",
    "UNIT PRICE",
    "UNDER REVIEW",
    "until",
    "function",
    "country",
    "Fund",
    "Lin Wei",
    "undefined",
    "run",
    "const un = !net && !asg.length",
    "un-patched",
    "unlisted",
    "un security",
    "security council",
  ]) {
    assert.deepEqual(bannedNameHits(text), [], text);
  }
});

test("the bundle scan flags a planted phrase and leaves the sample beneficiary", () => {
  assert.ok(bannedBundleHits("screened against a list").some((hit) => hit.name === "screened against"));
  assert.ok(bannedBundleHits("1 Sanctions hits").some((hit) => hit.name === "Sanctions hits"));
  assert.deepEqual(bannedBundleHits("Lin Wei is a sample beneficiary. Check the unit under the counter."), []);
});
