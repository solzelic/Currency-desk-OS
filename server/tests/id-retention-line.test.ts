/* Each identity-check sentence follows the record. No record and no
   typed ID says nothing. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function retentionSentence(latest: { method?: string; maskedNumber?: string | null; numberUnavailable?: boolean } | null, typedOnly: boolean): string {
  const source = readFileSync(join(import.meta.dirname, "../../os-src/cdos-id-check.jsx"), "utf8");
  const start = source.indexOf("function retentionSentence");
  const end = source.indexOf("function Panel");
  const body = source.slice(start, end);
  const load = new Function(`${body}; return retentionSentence;`) as () => (
    latest: { method?: string; maskedNumber?: string | null; numberUnavailable?: boolean } | null,
    typedOnly: boolean,
  ) => string;
  return load()(latest, typedOnly);
}

describe("identity check retention sentence", () => {
  it("names an in-person number as encrypted, last 4 only", () => {
    expect(retentionSentence({ method: "in_person", maskedNumber: "•••• 4242" }, false))
      .toBe("The ID number is stored encrypted. Only the last 4 are shown.");
  });

  it("keeps a passed check with a number on the server", () => {
    expect(retentionSentence({ method: "id_and_selfie", maskedNumber: "•••• 0001" }, false))
      .toBe("ID details from this check are kept on the server. Only the last 4 of the number are shown.");
  });

  it("says a scan stored no ID number", () => {
    expect(retentionSentence({ method: "id_and_selfie", maskedNumber: null }, false))
      .toBe("ID scanned. No ID number stored.");
  });

  it("says the number was not recorded when it was unavailable", () => {
    expect(retentionSentence({ method: "id_and_selfie", maskedNumber: null, numberUnavailable: true }, false))
      .toBe("No ID number was recorded for this check.");
  });

  it("asks for a check when the ID was only typed", () => {
    expect(retentionSentence(null, true))
      .toBe("ID typed by hand, not checked. Check the ID to record it.");
  });

  it("says nothing when no check is on file", () => {
    expect(retentionSentence(null, false)).toBe("");
  });
});
