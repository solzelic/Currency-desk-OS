/* What counts as ID on file, and which one-time links may be opened. */
import { describe, expect, it } from "vitest";
import { idFileStanding } from "../src/idv/records.js";
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
  original: null,
};

describe("ID on file from the check record", () => {
  it("counts a fresh pass with the last 4, and not a number that was unavailable", () => {
    expect(idFileStanding(pass)).toMatchObject({ onFile: true, chip: "ID on file", line: pass.line, gap: null });
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
  });

  it("keeps the gap for declined, review, and no record", () => {
    expect(idFileStanding(null)).toMatchObject({ onFile: false, chip: "Missing ID", gap: "missing ID" });
    expect(idFileStanding({ ...pass, result: "declined", line: "Not passed 16 Nov 2026" }).onFile).toBe(false);
    expect(idFileStanding({ ...pass, result: "needs_review", line: "Under review since 16 Nov 2026" }).onFile).toBe(false);
    expect(idFileStanding({ ...pass, result: "method_not_completed", line: "Method not completed. Check the ID at the counter." }).onFile).toBe(false);
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
