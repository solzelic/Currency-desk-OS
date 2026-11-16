/* What counts as ID on file, and which one-time links may be opened. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { day, idFileStanding } from "../src/idv/records.js";
import { verifiedScanChip } from "../src/idv/tiers.js";
import { personaOneTimeLink } from "../src/idv/persona-calls.js";
import { personaFileHost } from "../src/idv/inquiry-text.js";

const pass = {
  result: "pass",
  method: "id_and_selfie",
  line: "ID checked 16 Nov 2026, ID and selfie, Persona",
  maskedNumber: "•••• 8991",
  numberUnavailable: false,
  withinFiveYears: true,
  documentExpired: false,
  seenOn: "16 Nov 2026",
  sameShop: true,
  original: null,
};
const verified = "ID verified, scan and selfie, 16 Nov 2026";

describe("ID on file from the check record", () => {
  it("counts a fresh pass with the last 4, and not a number that was unavailable", () => {
    expect(idFileStanding(pass)).toMatchObject({ onFile: true, chip: verified, line: pass.line, gap: null });
    expect(idFileStanding(pass).line).not.toContain("8991");
    expect(idFileStanding({ ...pass, numberUnavailable: true }).onFile).toBe(false);
    expect(idFileStanding({ ...pass, maskedNumber: null }).onFile).toBe(false);
  });

  it("does not count a check over 5 years, an expired document, or a bad original", () => {
    expect(idFileStanding({ ...pass, withinFiveYears: false }).onFile).toBe(false);
    expect(idFileStanding({ ...pass, documentExpired: true, line: "Expired 1 Jan 2020" })).toMatchObject({
      onFile: false, chip: "ID expired", gap: "expired ID",
    });
    const returning = {
      result: "returning_confirmed",
      method: "returning_client",
      line: "Returning client, ID checked 1 Jan 2010, In person",
      maskedNumber: null,
      numberUnavailable: false,
      withinFiveYears: true,
      documentExpired: false,
      original: { ...pass, withinFiveYears: false },
    };
    expect(idFileStanding(returning).onFile).toBe(false);
    expect(idFileStanding({ ...returning, original: pass }).onFile).toBe(true);
    expect(idFileStanding({ ...returning, original: null }).onFile).toBe(false);
    expect(idFileStanding({ ...returning, original: { ...pass, result: "" } }).onFile).toBe(false);
    expect(idFileStanding({ ...returning, result: "needs_review", original: pass }).onFile).toBe(false);
  });

  it("counts an in-person photo ID only when the server has every fact", () => {
    const seen = {
      result: "pass",
      method: "in_person",
      line: "ID checked 16 Nov 2026, photo ID, in person",
      maskedNumber: "•••• 4444",
      numberUnavailable: false,
      withinFiveYears: true,
      documentExpired: false,
      acceptedPhotoId: true,
      numberStored: true,
      issuingJurisdiction: "Canada",
      issuingCountry: "CA",
      staffSeen: "m.costa",
      seenOn: "16 Nov 2026",
      documentType: "Passport",
      expiryIso: "2030-04-01",
      sameShop: true,
    };
    expect(idFileStanding(seen)).toMatchObject({
      onFile: true,
      chip: "ID on file",
      line: "ID seen in person by m.costa, Passport, expires 1 Apr 2030, checked 16 Nov 2026",
    });
    expect(idFileStanding({ ...seen, staffSeen: null }).line).toBe("ID typed in, check not recorded");
    expect(idFileStanding({ ...seen, seenOn: null }).line).toBe("ID typed in, check not recorded");
    expect(idFileStanding({ typedOnly: true, method: "in_person" })).toMatchObject({
      chip: "ID typed by hand, not checked",
      line: "ID typed by hand, not checked",
    });
    expect(idFileStanding({ typedOnly: true }).line).not.toContain("typed in, check not recorded");
    expect(idFileStanding({ ...seen, documentExpired: true, expiryIso: "2020-01-01" })).toMatchObject({
      onFile: false,
      chip: "ID expired",
      line: "Expired 1 Jan 2020. A new ID check is needed before the next deal of $3,000 or more.",
    });
    expect(idFileStanding({ ...seen, sameShop: false }).onFile).toBe(false);
    expect(idFileStanding({ ...seen, withinFiveYears: false })).toMatchObject({
      onFile: false,
      chip: "This check is too old. A new ID check is needed.",
      line: "This check is too old. A new ID check is needed.",
    });
    expect(idFileStanding({ ...seen, withinFiveYears: false }).chip).not.toContain("ID typed by hand");
    expect(idFileStanding({ ...seen, numberUnavailable: true }).onFile).toBe(false);
    expect(idFileStanding({ ...seen, result: "needs_review" }).onFile).toBe(false);
    expect(idFileStanding({ ...seen, acceptedPhotoId: false }).onFile).toBe(false);
    expect(idFileStanding({ ...seen, numberStored: false }).onFile).toBe(false);
  });

  it("keeps the gap for declined, review, and no record", () => {
    expect(idFileStanding(null)).toMatchObject({ onFile: false, chip: "Missing ID", gap: "missing ID" });
    const declined = idFileStanding({ ...pass, result: "declined", line: "Not passed 16 Nov 2026" });
    expect(declined.onFile).toBe(false);
    expect(declined.chip).toBe("Not passed 16 Nov 2026");
    expect(declined.chip).not.toContain("ID typed by hand");
    const review = idFileStanding({ ...pass, result: "needs_review", line: "Under review since 16 Nov 2026" });
    expect(review.chip).toBe("Under review since 16 Nov 2026");
    expect(review.chip).not.toContain("ID typed by hand");
    expect(idFileStanding({ ...pass, result: "method_not_completed", line: "Method not completed. Check the ID at the counter." }).chip).toBe("Method not completed. Check the ID at the counter.");
  });

  it("uses the scan-and-selfie badge only after a pass on this shop", () => {
    expect(verifiedScanChip("16 Nov 2026")).toBe("ID verified, scan and selfie, 16 Nov 2026");
    expect(verifiedScanChip("16 Nov 2026", true)).toBe("ID verified, scan and selfie (test), 16 Nov 2026");
    expect(idFileStanding(pass).chip).toBe(verified);
    expect(idFileStanding({ ...pass, testPass: true }).chip).toBe("ID verified, scan and selfie (test), 16 Nov 2026");
    const records = readFileSync(new URL("../src/idv/records.ts", import.meta.url), "utf8");
    expect(records).toContain("return verifiedScanChip(date, test);");
    expect(records).toContain("testPass: test && method === \"id_and_selfie\" && result === \"pass\"");
    const pending = { ...pass, result: "in_progress", line: "ID check in progress" };
    const failed = { ...pass, result: "declined", line: "Not passed 16 Nov 2026" };
    const otherShop = { ...pass, sameShop: false };
    for (const row of [pending, failed, otherShop]) {
      expect(idFileStanding(row).chip).not.toContain("ID verified, scan and selfie");
    }
    expect(idFileStanding({ ...pass, seenOn: "" }).chip).toBe("ID on file");
  });
});

describe("calendar day", () => {
  it("keeps 1 Apr 2030 on a clock east of UTC", () => {
    expect(day(new Date(2030, 3, 1))).toBe("2030-04-01");
    expect(day("2030-04-01T00:00:00.000Z")).toBe("2030-04-01");
  });
});

describe("one-time link host", () => {
  it("allows only https on a Persona host", () => {
    expect(personaOneTimeLink("https://inquiry.withpersona.com/verify?code=sandbox")).toBe(true);
    expect(personaOneTimeLink("https://withpersona.com/verify")).toBe(true);
    expect(personaOneTimeLink("http://inquiry.withpersona.com/verify")).toBe(false);
    expect(personaOneTimeLink("https://evil.test/verify")).toBe(false);
    expect(personaOneTimeLink("https://inquiry.withpersona.com.evil.test/verify")).toBe(false);
    expect(personaOneTimeLink("javascript:alert(1)")).toBe(false);
  });
});

describe("seam ID photo host", () => {
  const seam = { NODE_ENV: "test", RENDER_EXTERNAL_HOSTNAME: "", PERSONA_API_BASE: "http://127.0.0.1:4199/api/v1" };
  it("serves the stub photo only from this machine, and not in production", () => {
    expect(personaFileHost("http://127.0.0.1:4199/id-front.png", seam)).toBe(true);
    expect(personaFileHost("http://127.0.0.1:4199/id-front.png", { ...seam, NODE_ENV: "production" })).toBe(false);
    expect(personaFileHost("https://example.test/id-front.jpg", seam)).toBe(false);
  });
});
