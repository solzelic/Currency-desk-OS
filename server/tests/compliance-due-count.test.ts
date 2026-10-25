/* Header and Needs filing both render the real Compliance screen.
   The count they show is openReportables. A source-string match is not a count. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const babel = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};
const React = require("react");
const ReactDOMServer = require("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
const root = resolve(import.meta.dirname, "../..");
const g = globalThis as any;

g.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, length: 0, key: () => null };
g.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null, documentElement: { setAttribute() {}, style: {} }, head: { appendChild() {} }, createElement: () => ({ style: {} }) };
require("../../shared/lctr-reversal.js");
require("../../shared/rolling-24h.js");
require("../../os-src/cdos-desk-time.js");
require("../../shared/id-document-types.js");
g.window = { CDOS: g.CDOS, CDOS_ID_TYPES: g.CDOS_ID_TYPES, location: { search: "", pathname: "/app", hash: "", origin: "http://127.0.0.1" }, addEventListener() {}, removeEventListener() {} };
Object.assign(g.window.CDOS, {
  CD: { ink: "var(--cd-ink)", mute: "var(--cd-mute)", faint: "var(--cd-faint)", panel: "var(--cd-panel)", paper: "var(--cd-paper)", line: "var(--cd-line)", lineSoft: "var(--cd-line-soft)", flag: "var(--cd-flag)", flagSoft: "var(--cd-flag-soft)", onFlagSoft: "var(--cd-on-flag-soft)", green: "var(--cd-green)", greenSoft: "var(--cd-green-soft)", amber: "var(--cd-amber)", amberSoft: "var(--cd-amber-soft)", chip: "var(--cd-chip)" },
  Ic: () => null, InfoTip: () => null, Tag: () => null,
  fmt: (n: unknown) => String(n ?? ""), num: (n: unknown) => String(n ?? ""),
  TODAY: "2026-10-25", crossRate: () => 1,
  counterCashIn: (r: { inAmt?: number; inCcy?: string }) => ({ amount: Number(r.inAmt) || 0, ccy: r.inCcy || "CAD" }),
  counterCashOut: () => null, businessDate: () => "2026-10-25",
  reportingLimit: () => ({ amount: 10000, currency: "CAD" }), dDiff: () => 0,
  TYPES: [], CCY: [], currencyPlaces: () => 2, effectiveRate: () => ({ text: "" }),
  RATE_NOTE: "", unitText: () => "", perCadLive: () => 1,
  branchZone: () => "America/Toronto", rulesMissing: () => false, deskPack: () => null,
  Absent: () => null, useDeskFacts: () => ({}), sumDealHome: () => ({ total: 0, valued: 0, unvalued: 0 }), makeSearch: () => ({ match: () => true, chips: [], wantsVoid: false, active: false }),
  STAFF: [{ name: "J. Masri", role: "Owner", staffId: "j.masri", branches: "*", home: null, demo: true }],
  ROLE_CAPS: {}, ROLE_SCOPE: {},
  defaultBaseline: () => ({ units: {} }), defaultReceipts: () => [],
  _stations: { SKEY: "b", MKEY: "m", defaultBranches: () => [{ id: "b01", name: "Front", main: true, status: "open", vault: {}, tills: [{ id: "t1", name: "Till", status: "open", operator: "" }] }], defaultStation: () => ({ branchId: "b01", tillId: "t1" }) },
  _transfers: { BKEY: "ben", CKEY: "cor", defaultBeneficiaries: () => [], defaultCorridors: () => [] },
  _cheques: { KKEY: "ch", SKEY: "sch", ledger: () => true, defaultCheques: () => [], defaultSchedule: () => ({}) },
  APP_ACCENT: {}, publishedBook: null, applyBook() {}, bookSig: () => "",
  ...Object.fromEntries(["SignIn", "LockDesk", "Handover", "Ledger", "Clients", "TillDrawer", "Audit", "SettingsView", "Calc", "ReceiptModal", "Tagged", "LoanCalc", "AppStore", "Reports", "Vault", "Transfers", "Cheques", "Branches", "Pricing", "Telegraph"].map((k) => [k, () => null])),
  COMING: {}, STORE_DESC: {},
});

function load(file: string) {
  const src = readFileSync(resolve(root, file), "utf8");
  const code = babel.transform(src, { presets: ["react"], filename: file }).code;
  if (!code) throw new Error(file);
  new Function("React", "window", "document", "localStorage", code)(React, g.window, g.document, g.localStorage);
}
load("os-src/cdos-compliance.jsx");
load("os-src/cdos-modules.jsx");
load("os-src/cdos-compliance-app.jsx");
load("os-src/cdos-dashboard.jsx");
load("os-src/cdos-apps.jsx");
load("os-src/cdos-ledger.jsx");
load("os-src/cdos-os.jsx");

const SETTINGS = { regime: "FINTRAC", structuringDays: 7, threshold: 10000, employees: [] };
const FILED_FLAG = "A deal in this report was later marked booking error. Check if the filed report needs a correction.";

function cashDeal(over: Record<string, unknown> = {}) {
  return {
    id: "live", ref: "R-LIVE", date: "2026-10-25", time: "10:00", customer: "A. Chen", beneficiary: "",
    type: "Currency Exchange", receivedInstrument: "cash", disbursedInstrument: "cash",
    inCcy: "CAD", inAmt: 12000, outCcy: "USD", outAmt: 8000, status: "posted", ...over,
  };
}

function render(subs: Record<string, unknown>, rows: unknown[] = []) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(g.window.CDOS.Compliance, {
    rows, clients: {}, beneficiaries: [], settings: SETTINGS, me: { name: "J. Masri", role: "Owner" },
    subs, initialTab: "submissions",
  }));
}

function headerCount(html: string) {
  const m = /<div class="font-bold"[^>]*>([^<]*)<\/div><div class="text-\[10\.5px\]"[^>]*>Filings due<\/div>/.exec(html);
  const n = m && m[1];
  if (!n) throw new Error("header count missing");
  return n.trim();
}
function needsCount(html: string) {
  const m = /Needs filing<\/span><span[^>]*>([^<]*)<\/span>/.exec(html);
  const n = m && m[1];
  if (!n) throw new Error("Needs filing count missing");
  return n.trim();
}
function dueTile(html: string) {
  const m = /<button[^>]*>[\s\S]*?Filings due<\/div><\/button>/.exec(html);
  const tile = m && m[0];
  if (!tile) throw new Error("due tile missing");
  return tile;
}
function counts(subs: Record<string, unknown>, rows: unknown[] = []) {
  const html = render(subs, rows);
  const due = g.window.CDOS.openReportables(rows, {}, SETTINGS, [], subs);
  return { html, header: headerCount(html), needs: needsCount(html), selector: due.length, due };
}

describe("one due selector on the Compliance screen", () => {
  it("counts an unrebuildable prepared filing once in the header and once in Needs filing", () => {
    const subs = {
      "PREP-ORPHAN": {
        status: "prepared", kind: "LCTR", subject: "M. Ortega", amount: 12000,
        submittedAt: "2026-10-20 10:00:00", refs: ["R-ORPHAN"],
      },
    };
    const got = counts(subs);
    expect({ header: got.header, needs: got.needs, selector: got.selector }).toEqual({ header: "1", needs: "1", selector: 1 });
    expect(got.due.map((o: { id: string }) => o.id)).toEqual(["PREP-ORPHAN"]);
    expect(got.html).toContain("M. Ortega");
    expect(got.html).not.toContain("Nothing awaiting filing.");
  });

  it("counts a sealed filing as zero due and shows it under Filed records", () => {
    const subs = {
      "FILED-1": {
        status: "submitted", kind: "LCTR", subject: "B. Khan", amount: 15000,
        ackNo: "FWR-1", submittedAt: "2026-10-20 10:00:00", by: "J. Masri", refs: ["R-FILED"],
      },
    };
    const got = counts(subs);
    expect({ header: got.header, needs: got.needs, selector: got.selector }).toEqual({ header: "0", needs: "0", selector: 0 });
    expect(got.html).toContain("Nothing awaiting filing.");
    const filedAt = got.html.indexOf("Filed records");
    expect(got.html.indexOf("B. Khan")).toBeGreaterThan(filedAt);
  });

  it("counts nothing when there are no filings", () => {
    const got = counts({});
    expect({ header: got.header, needs: got.needs, selector: got.selector }).toEqual({ header: "0", needs: "0", selector: 0 });
    expect(got.html).toContain("Nothing awaiting filing.");
    expect(got.html).toContain("No filed records yet");
  });

  it("counts a rebuildable prepared filing once, not twice", () => {
    const rows = [cashDeal()];
    const subs = {
      "L-R-LIVE": { status: "prepared", kind: "LCTR", subject: "A. Chen", amount: 12000, refs: ["R-LIVE"] },
    };
    const got = counts(subs, rows);
    expect(got.due.filter((o: { id: string }) => o.id === "L-R-LIVE")).toHaveLength(1);
    expect({ header: got.header, needs: got.needs, selector: got.selector }).toEqual({ header: "1", needs: "1", selector: 1 });
    expect(got.html.split("A. Chen").length - 1).toBe(1);
  });

  it("adds zero to due when a filed report carries a booking-error flag", () => {
    const subs = {
      "FILED-FLAG": {
        status: "submitted", kind: "LCTR", subject: "C. Diaz", amount: 15000,
        ackNo: "FWR-9", submittedAt: "2026-10-20 10:00:00", by: "J. Masri",
        bookingErrorFlag: FILED_FLAG, refs: ["R-9"],
      },
    };
    const got = counts(subs);
    expect({ header: got.header, needs: got.needs, selector: got.selector }).toEqual({ header: "0", needs: "0", selector: 0 });
    expect(got.html).toContain(FILED_FLAG);
    expect(got.html).toContain("Nothing awaiting filing.");
    expect(got.html.indexOf("C. Diaz")).toBeGreaterThan(got.html.indexOf("Filed records"));
  });
});

describe("the due count is amber text on the tile", () => {
  it("paints a count above zero with the amber token on the panel tile, at 12px in the badge", () => {
    const subs = {
      "PREP-ORPHAN": { status: "prepared", kind: "LCTR", subject: "M. Ortega", amount: 12000, refs: ["R-ORPHAN"] },
    };
    const html = render(subs);
    const tile = dueTile(html);
    expect(tile).toContain("background:var(--cd-panel)");
    expect(tile).toMatch(/class="font-bold"[^>]*color:var\(--cd-amber\)/);
    expect(tile).not.toMatch(/class="font-bold"[^>]*color:var\(--cd-flag\)/);
    const badge = /Needs filing<\/span>(<span class="[^"]*")/.exec(html);
    expect(badge && badge[1]).toContain("text-[12px]");
  });

  it("leaves a zero count on the green token", () => {
    const tile = dueTile(render({}));
    expect(tile).toMatch(/class="font-bold"[^>]*color:var\(--cd-green\)/);
    expect(tile).not.toContain("var(--cd-amber)");
  });

  it("keeps amber on the tile at 4.5:1 or more in both themes, and under that on the page", () => {
    const src = readFileSync(resolve(root, "os-src/cdos-base.jsx"), "utf8");
    const light = src.slice(src.indexOf("light: {"), src.indexOf("dark: {"));
    const dark = src.slice(src.indexOf("dark: {"), src.indexOf("const cdVar"));
    const pick = (block: string, key: string) => {
      const m = new RegExp(key + ": '([^']+)'").exec(block);
      const hex = m && m[1];
      if (!hex) throw new Error(key);
      return hex;
    };
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
    };
    const ratio = (fg: string, bg: string) => {
      const a = lum(fg); const b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const lightTile = ratio(pick(light, "amber"), pick(light, "panel"));
    const darkTile = ratio(pick(dark, "amber"), pick(dark, "panel"));
    const lightPage = ratio(pick(light, "amber"), pick(light, "paper"));
    expect(lightTile).toBeGreaterThanOrEqual(4.5);
    expect(darkTile).toBeGreaterThanOrEqual(4.5);
    expect(lightPage).toBeLessThan(4.5);
    expect(Number(lightTile.toFixed(2))).toBe(4.67);
    expect(Number(darkTile.toFixed(2))).toBe(7.05);
    expect(Number(lightPage.toFixed(2))).toBe(4.21);
    const lightBadge = ratio(pick(light, "onInk"), pick(light, "amber"));
    const darkBadge = ratio(pick(dark, "onInk"), pick(dark, "amber"));
    expect(lightBadge).toBeGreaterThanOrEqual(4.5);
    expect(darkBadge).toBeGreaterThanOrEqual(4.5);
    expect(Number(lightBadge.toFixed(2))).toBe(4.67);
    expect(Number(darkBadge.toFixed(2))).toBe(7.83);
    const ledger = readFileSync(resolve(root, "os-src/cdos-ledger.jsx"), "utf8");
    const card = ledger.slice(ledger.indexOf("function StatCard"), ledger.indexOf("function CompKpi"));
    expect(card).toContain("flag ? CD.panel");
    expect(card).toContain("flag ? CD.amber : CD.ink");
    expect(Number(lightTile.toFixed(2))).toBe(4.67);
    expect(Number(darkTile.toFixed(2))).toBe(7.05);
    expect(Number(ratio(pick(light, "amber"), pick(light, "chip")).toFixed(2))).toBe(4.1);
    expect(Number(ratio(pick(light, "amber"), pick(light, "paper")).toFixed(2))).toBe(4.21);
    expect(Number(ratio(pick(dark, "amber"), pick(dark, "paper")).toFixed(2))).toBe(7.63);
    expect(Number(ratio(pick(dark, "amber"), pick(dark, "chip")).toFixed(2))).toBe(6.41);
    const dash = readFileSync(resolve(root, "os-src/cdos-dashboard.jsx"), "utf8");
    const vig = (name: string) => { const m = new RegExp(name + ":[\\s\\S]*?vignette: '(#[0-9a-f]+)'").exec(dash); const value = m && m[1]; if (!value) throw new Error(name); return value; };
    expect(Number(ratio(pick(light, "amber"), vig("light")).toFixed(2))).toBe(4.14);
    expect(Number(ratio(pick(dark, "amber"), vig("dark")).toFixed(2))).toBe(6.53);
    expect(dash).toContain("dueN > 0 ? CD.amber : T.green");
    expect(dash).toContain("l === 'Reportable deals' && dueN > 0 ? CD.panel : T.vignette");
  });
});

describe("the bell, the ledger nav badge, and Reportable deals are amber", () => {
  function decl(css: string, selector: string, prop: string) {
    const at = css.indexOf(selector + " {");
    if (at < 0) throw new Error(selector);
    const rule = css.slice(at, css.indexOf("}", at));
    const m = new RegExp(prop + ":\\s*([^;]+)").exec(rule);
    const value = m && m[1];
    if (!value) throw new Error(selector + " " + prop);
    return value.trim();
  }

  it("reads the bell badge and the ledger nav badge from the amber and on-ink tokens", () => {
    const css = readFileSync(resolve(root, "os-src/york-os.css"), "utf8");
    expect(decl(css, ".mb-bell-count", "background")).toBe("var(--cd-amber)");
    expect(decl(css, ".mb-bell-count", "color")).toBe("var(--cd-on-ink)");
    expect(decl(css, "html[data-cdtheme=\"dark\"] .mb-bell-count", "background")).toBe("var(--cd-amber)");
    expect(decl(css, "html[data-cdtheme=\"dark\"] .mb-bell-count", "color")).toBe("var(--cd-on-ink)");
    expect(decl(css, ".dock-badge", "background")).toBe("var(--cd-amber)");
    expect(decl(css, ".dock-badge", "color")).toBe("var(--cd-on-ink)");
    expect(decl(css, ".dock-badge:hover", "background")).toBe("var(--cd-amber)");
    const badges = [".mb-bell-count", "html[data-cdtheme=\"dark\"] .mb-bell-count", ".dock-badge", ".dock-badge:hover"]
      .map(sel => css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {"))))
      .join("\n");
    expect(badges).not.toMatch(/#c0392b|#d8453a|var\(--flag\)/);
  });

  it("paints an open reportable figure in amber on the panel", () => {
    const src = readFileSync(resolve(root, "os-src/cdos-ledger.jsx"), "utf8");
    const fn = src.slice(src.indexOf("function StatCard"), src.indexOf("function CompKpi"));
    expect(fn).toContain("background: flag ? CD.panel");
    expect(fn).toContain("flag ? CD.amber : CD.ink");
    expect(fn).not.toContain("CD.flag");
    const at = src.indexOf(">Reportable deals");
    const chip = src.slice(at - 200, at);
    expect(chip).toContain("CD.amber");
    expect(chip).toContain("CD.panel");
  });
});

const PREPARED = { "PREP-ORPHAN": { status: "prepared", kind: "LCTR", subject: "M. Ortega", amount: 12000, refs: ["R-ORPHAN"] } };
const SEALED = { "FILED-1": { status: "submitted", kind: "LCTR", subject: "B. Khan", amount: 15000, ackNo: "FWR-1", refs: ["R-FILED"] } };

function shell(subs: Record<string, unknown>, rows: unknown[] = [], apps = ["compliance", "assistant"]) {
  const prev = g.localStorage.getItem;
  g.localStorage.getItem = (k: string) => k === "cdos_submissions_v1" ? JSON.stringify(subs) : k === "cdos_rows_v1" ? JSON.stringify(rows) : null;
  g.window.CDOS._bootStage = "desktop";
  g.window.CDOS._bootBell = true;
  g.window.CDOS._bootWins = apps.map((id, i) => ({ id, x: 0, y: 0, w: 900, h: 700, z: i + 1, min: false }));
  g.window.CDOS._captureAlerts = true;
  try {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(g.window.CDOS_App));
    const take = (re: RegExp) => { const m = re.exec(html); return (m && m[1]) || "0"; };
    const line = g.window.CDOS.deskSnapshot([], {}, g.window.CDOS._deskAlerts);
    const rpt = (String(line).match(/reportable \(LCTR ≥ \$10k\): (\d+)/) || [])[1];
    return {
      html, header: headerCount(html).trim(),
      bell: take(/mb-bell-count">([^<]*)</),
      dock: take(/dock-badge"[^>]*>([^<]*)</),
      tab: take(/Filings\s*<span class="text-\[9px\][^"]*"[^>]*>([^<]+)</),
      list: take(/Unfiled reportables<i>([^<]*)</),
      jump: g.window.CDOS.jumpAlerts(),
      rpt,
    };
  } finally { g.localStorage.getItem = prev; }
}
function expectDue(subs: Record<string, unknown>, n: string) {
  const { html, ...got } = shell(subs);
  expect(got).toEqual({ header: n, bell: n, dock: n, tab: n, list: n, rpt: n, jump: n === "0" ? "open" : "RPT" });
}

describe("the shell alerts equal the header", () => {
  it("counts nothing due", () => expectDue({}, "0"));
  it("counts a prepared filing on every surface", () => expectDue(PREPARED, "1"));
  it("counts a sealed filing as zero", () => expectDue(SEALED, "0"));
  it("renders the ledger chip equal to the header when a prepared filing outnumbers loaded deals", () => {
    const html = shell(PREPARED, [cashDeal()], ["compliance", "ledger"]).html; const chip = /Reportable deals · (\d+)/.exec(html);
    expect([(chip && chip[1]) || "0", headerCount(html), html.includes(">2 open<")]).toEqual(["2", "2", true]);
  });
  it("renders the ledger figure equal to the chip and the header", () => {
    const cardOf = (html: string) => { const open = />Reportable deals<\/div><div class="text-lg[^"]*"[^>]*>(\d+) open</.exec(html); const n = open && open[1]; if (n) return n; return />Reportable deals<\/div><div class="text-lg[^"]*"[^>]*>0</.test(html) ? "0" : "missing"; };
    const chipOf = (html: string) => { const chip = /Reportable deals · (\d+)/.exec(html); return (chip && chip[1]) || "0"; };
    const flagOf = (html: string) => {
      const m = /background:(var\(--cd-panel\)|transparent);cursor:pointer;transition:background \.12s"><div class="text-\[11px\][^"]*"[^>]*>Reportable deals<\/div><div class="text-lg[^"]*" style="([^"]*)"/.exec(html);
      const bg = m && m[1]; const style = m && m[2];
      const on = bg === "var(--cd-panel)" && !!style && style.includes("color:var(--cd-amber)");
      const off = bg === "transparent" && !!style && style.includes("color:var(--cd-ink)");
      if (on === off) return "missing";
      return on ? "on" : "off";
    };
    const row = (subs: Record<string, unknown>, rows: unknown[]) => { const html = shell(subs, rows, ["compliance", "ledger"]).html; return [cardOf(html), chipOf(html), headerCount(html)]; };
    const flagged = (subs: Record<string, unknown>, rows: unknown[]) => { const html = shell(subs, rows, ["compliance", "ledger"]).html; const due = headerCount(html); return [due, flagOf(html), due === "0" ? "off" : "on"]; };
    expect(row({}, [])).toEqual(["0", "0", "0"]);
    expect(row(PREPARED, [cashDeal()])).toEqual(["2", "2", "2"]);
    expect(row(SEALED, [cashDeal()])).toEqual(["1", "1", "1"]);
    expect(flagged({}, [])).toEqual(["0", "off", "off"]);
    expect(flagged(PREPARED, [])).toEqual(["1", "on", "on"]);
    expect(flagged(SEALED, [cashDeal()])).toEqual(["1", "on", "on"]);
  });
  it("renders the dashboard tile equal to the header when a prepared filing outnumbers loaded deals", () => {
    const html = shell(PREPARED, [cashDeal()], ["compliance", "dashboard"]).html; const tile = /font-size:22px[^"]*">(\d+)<\/div><div[^>]*>Reportable deals</.exec(html);
    expect([(tile && tile[1]) || "0", headerCount(html)]).toEqual(["2", "2"]);
  });
});
