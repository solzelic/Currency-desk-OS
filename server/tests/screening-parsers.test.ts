import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCanadaXml, parsePublicSafetyHtml, parseUnXml } from "../src/screening/parse.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sanctions");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe("official list parsers", () => {
  it("reads the Canada XML fixture", () => {
    const entries = parseCanadaXml(read("canada.xml"));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.names).toEqual(["Sergei Yepikhov", "Siarhei Yepikhau"]);
    expect(entries[0]?.dobs).toEqual([{ kind: "date", value: "1966-05-16" }]);
    expect(entries[1]?.names[0]).toMatch(/Belaeronavigatsia/);
    expect(entries[1]?.dobs).toEqual([]);
  });

  it("reads the Security Council XML fixture", () => {
    const entries = parseUnXml(read("un.xml"));
    expect(entries.map((entry) => entry.key)).toEqual(["un|6907999", "un|6908402"]);
    expect(entries[0]?.names).toContain("MAKENGA, EMMANUEL SULTANI");
    expect(entries[0]?.dobs).toEqual([{ kind: "date", value: "1973-12-25" }]);
    expect(entries[1]?.names).toContain("Allied Democratic Forces");
  });

  it("reads the Public Safety page fixture", () => {
    const entries = parsePublicSafetyHtml(read("public-safety.html"));
    expect(entries.map((entry) => entry.key)).toEqual(["cc|1", "cc|6"]);
    expect(entries[0]?.names[0]).toBe("Abdallah Azzam Brigades (AAB)");
    expect(entries[0]?.names).toContain("the Yusuf al-'Uyayri Battalions");
    expect(entries[1]?.names).toContain("Al-Qaida");
  });

  it("fails loudly when the Public Safety page structure changes", () => {
    const broken = `<h2 id="1">Example Entity</h2><p>No labels here.</p>`;
    expect(() => parsePublicSafetyHtml(broken)).toThrow(/page structure changed/);
    expect(() => parsePublicSafetyHtml("<html><h2>Not a list</h2></html>")).toThrow(/no numbered headings/);
    expect(() => parseCanadaXml("<html></html>")).toThrow(/file structure changed/);
    expect(() => parseUnXml("<html></html>")).toThrow(/file structure changed/);
  });
});
