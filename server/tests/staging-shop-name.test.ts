/* Sol, 3 Nov 2026: on staging the seed shop shows as Test FX, so nobody
   takes it for a real shop. Live keeps York FX. The York FX desk runs on
   the browser's own demo copy (it never loads its name from the server), so
   the rename is in the browser, on the server's staging answer only. A name
   a tester typed that does not say York is left alone. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const load = () => require("../../os-src/staging-shop-name.js") as {
  SEED_TENANT: string;
  renameSettings: (s: Record<string, unknown> | null, tenantId: unknown, staging: unknown) => Record<string, unknown> | null;
  renameTexts: (storage: unknown, tenantId: unknown, staging: unknown) => boolean;
};

const YORK = {
  bizName: "York Foreign Exchange Inc.", operatingName: "York Currency Exchange", receiptHeader: "York Currency Exchange",
  bizCity: "Toronto", bizEmail: "desk@yorkfx.ca", threshold: 10000,
};
const TG = "cdos_tg_settings_v1";

function memory(start: Record<string, string> = {}) {
  const items = new Map(Object.entries(start));
  return {
    items,
    getItem: (k: string) => (items.has(k) ? items.get(k)! : null),
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
  };
}
const throwing = { getItem() { throw new Error("off"); }, setItem() { throw new Error("off"); } };

describe("the desk's names", () => {
  it("on staging, York FX's three names become Test FX and nothing else changes", () => {
    const { renameSettings, SEED_TENANT } = load();
    expect(SEED_TENANT).toBe("tnt-yorkfx");
    const next = renameSettings({ ...YORK }, "tnt-yorkfx", true)!;
    expect(next).toEqual({ ...YORK, bizName: "Test FX Inc.", operatingName: "Test FX", receiptHeader: "Test FX" });
  });

  it("live, an unknown answer, or another shop keeps every name", () => {
    const { renameSettings } = load();
    for (const staging of [false, undefined, null, "true", 1]) {
      const s = { ...YORK };
      expect(renameSettings(s, "tnt-yorkfx", staging), String(staging)).toBe(s);
    }
    const other = { ...YORK };
    expect(renameSettings(other, "tnt-mapleleaf", true)).toBe(other);
    expect(renameSettings(null, "tnt-yorkfx", true)).toBe(null);
  });

  it("a name a tester typed is kept, and a second run changes nothing", () => {
    const { renameSettings } = load();
    const typed = { ...YORK, operatingName: "Danforth Money" };
    expect(renameSettings(typed, "tnt-yorkfx", true)).toEqual({ ...typed, bizName: "Test FX Inc.", receiptHeader: "Test FX" });
    const once = renameSettings({ ...YORK }, "tnt-yorkfx", true);
    expect(renameSettings(once, "tnt-yorkfx", true)).toBe(once);
  });
});

describe("the texts sender", () => {
  it("on staging, the sender becomes TEST FX, keeping the other text settings", () => {
    const { renameTexts } = load();
    const empty = memory();
    expect(renameTexts(empty, "tnt-yorkfx", true)).toBe(true);
    expect(JSON.parse(empty.items.get(TG)!)).toEqual({ desk: "TEST FX", from: "TESTFX" });
    const saved = memory({ [TG]: JSON.stringify({ desk: "YORK FX", from: "YORKFX", holdMins: 45 }) });
    expect(renameTexts(saved, "tnt-yorkfx", true)).toBe(true);
    expect(JSON.parse(saved.items.get(TG)!)).toEqual({ desk: "TEST FX", from: "TESTFX", holdMins: 45 });
    expect(renameTexts(saved, "tnt-yorkfx", true)).toBe(false);
  });

  it("live, another shop, a typed sender or storage that is off: nothing written", () => {
    const { renameTexts } = load();
    for (const [staging, tenant] of [[false, "tnt-yorkfx"], [undefined, "tnt-yorkfx"], [true, "tnt-mapleleaf"]] as const) {
      const s = memory();
      expect(renameTexts(s, tenant, staging)).toBe(false);
      expect(s.items.size).toBe(0);
    }
    const typed = memory({ [TG]: JSON.stringify({ desk: "DANFORTH", from: "DANFORTH" }) });
    expect(renameTexts(typed, "tnt-yorkfx", true)).toBe(false);
    expect(renameTexts(throwing, "tnt-yorkfx", true)).toBe(false);
    expect(renameTexts(memory({ [TG]: "not json" }), "tnt-yorkfx", true)).toBe(false);
  });
});

it("ships in the desk: the page loads it and the bundle has it", () => {
  expect(readFileSync(new URL("../../CurrencyDesk OS.html", import.meta.url), "utf8")).toContain('<script src="os-src/staging-shop-name.js"></script>');
  expect(readFileSync(new URL("../../web/app/os.js", import.meta.url), "utf8")).toContain("/* ---- os-src/staging-shop-name.js ---- */");
  const desk = readFileSync(new URL("../../os-src/cdos-os.jsx", import.meta.url), "utf8");
  expect(desk).toContain("const names = window.CDOS.stagingShopName;");
  expect(desk).toContain("names.renameSettings(s, tid, stagingOn)");
});
