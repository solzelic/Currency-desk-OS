/* The client file chip, Where they are, and the KYC gap all read this. */
import { describe, expect, it } from "vitest";
import { idFileStanding } from "../src/idv/records.js";
import { personaFileHost } from "../src/idv/inquiry-text.js";

describe("ID on file from the check record", () => {
  it("counts a passed check, including in person, and shows the method, date, and last 4", () => {
    const passed = idFileStanding([{
      result: "pass",
      line: "ID checked 16 Nov 2026, ID and selfie, Persona",
      maskedNumber: "•••• 8991",
    }]);
    expect(passed).toEqual({
      onFile: true,
      chip: "ID on file",
      title: "Identified",
      line: "ID checked 16 Nov 2026, ID and selfie, Persona. •••• 8991",
      gap: null,
    });
    const counter = idFileStanding([{
      result: "pass",
      line: "ID checked 16 Nov 2026, In person",
      maskedNumber: null,
    }]);
    expect(counter.onFile).toBe(true);
    expect(counter.line).toBe("ID checked 16 Nov 2026, In person");
    expect(counter.gap).toBeNull();
  });

  it("keeps the gap when the record expired or did not pass", () => {
    expect(idFileStanding([])).toMatchObject({ onFile: false, chip: "Missing ID", gap: "missing ID" });
    expect(idFileStanding([{ result: "expired", line: "Expired 1 Jan 2020", maskedNumber: "•••• 8991" }])).toMatchObject({
      onFile: false, chip: "ID expired", gap: "expired ID", line: "Expired 1 Jan 2020",
    });
    expect(idFileStanding([{ result: "declined", line: "This check did not pass.", maskedNumber: "•••• 8991" }])).toMatchObject({
      onFile: false, chip: "Missing ID", gap: "missing ID",
    });
    expect(idFileStanding([{ result: "needs_review", line: "This needs review.", maskedNumber: null }]).onFile).toBe(false);
  });
});

describe("seam ID photo host", () => {
  const seam = { NODE_ENV: "test", RENDER_EXTERNAL_HOSTNAME: "", PERSONA_API_BASE: "http://127.0.0.1:4199/api/v1" };
  it("serves the stub photo only from this machine, and not in production", () => {
    expect(personaFileHost("http://127.0.0.1:4199/id-front.png", seam)).toBe(true);
    expect(personaFileHost("http://127.0.0.1:4199/id-front.png", { ...seam, NODE_ENV: "production" })).toBe(false);
    expect(personaFileHost("http://127.0.0.1:4199/id-front.png", { ...seam, RENDER_EXTERNAL_HOSTNAME: "desk.example" })).toBe(false);
    expect(personaFileHost("https://example.test/id-front.jpg", seam)).toBe(false);
    expect(personaFileHost("https://files.withpersona.com/a.png", seam)).toBe(true);
  });
});
