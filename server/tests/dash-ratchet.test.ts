import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* Visible copy: decoded strings, template text, and JSX text. Comments
   are skipped. The baseline must equal the count. The old slash scan
   treated accept="image/*" (cdos-settings.jsx, the logo input, ~line 1955)
   as a block comment and dropped the Desk name copy through the compliance
   fallback, 18 dashes. Those sentences are not reworded here. A regex is
   not copy, and a slash-star inside one is not a comment. web/app/os.js
   is the built desk and has its own count. */
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EM = "\u2014";
const EN = "\u2013";
const RE_KW = new Set("return throw case typeof void delete await yield new in of instanceof else do".split(" "));
const BASELINE: Record<string, number> = {
  "CurrencyDesk OS.html": 2,
  "YorkFX/YorkFX Homepage.html": 3,
  "YorkFX/YorkFX Rate Board.html": 9,
  "YorkFX/YorkFX Rates.html": 4,
  "YorkFX/YorkFX Regulations.html": 8,
  "YorkFX/YorkFX Services.html": 9,
  "YorkFX/YorkFX Visit.html": 4,
  "admin.html": 133,
  "design/emails/CurrencyDesk Emails.dc.html": 47,
  "design/kyc-handoff/kyc-verification-states.html": 26,
  "design/onboarding/currencydesk-onboarding.html": 18,
  "design/site/CurrencyDesk Compliance.dc.html": 0,
  "design/site/CurrencyDesk Contact.dc.html": 0,
  "design/site/CurrencyDesk Early Access.dc.html": 0,
  "design/site/CurrencyDesk FAQ.dc.html": 0,
  "design/site/CurrencyDesk Legal.dc.html": 0,
  "design/site/CurrencyDesk Mobile.dc.html": 1,
  "design/site/CurrencyDesk Site.dc.html": 0,
  "os-src/cdos-apps.jsx": 7,
  "os-src/cdos-backend.js": 3,
  "os-src/cdos-base.jsx": 9,
  "os-src/cdos-branches.jsx": 31,
  "os-src/cdos-cheques-app.jsx": 2,
  "os-src/cdos-cheques.jsx": 10,
  "os-src/cdos-clients.jsx": 24,
  "os-src/cdos-compliance-app.jsx": 13,
  "os-src/cdos-compliance.jsx": 5,
  "os-src/cdos-dashboard.jsx": 10,
  "os-src/cdos-import.jsx": 13,
  "os-src/cdos-kyc.jsx": 16,
  "os-src/cdos-lctr.jsx": 45,
  "os-src/cdos-ledger.jsx": 88,
  "os-src/cdos-modules.jsx": 7,
  "os-src/cdos-os.jsx": 51,
  "os-src/cdos-persist.js": 4,
  "os-src/cdos-pricing.jsx": 5,
  "os-src/cdos-reports.jsx": 58,
  "os-src/cdos-search.jsx": 4,
  "os-src/cdos-settings.jsx": 96,
  "os-src/cdos-signin.jsx": 8,
  "os-src/cdos-telegraph.jsx": 111,
  "os-src/cdos-till.jsx": 48,
  "os-src/cdos-tour.js": 1,
  "os-src/cdos-transfers-app.jsx": 9,
  "os-src/cdos-transfers.jsx": 16,
  "os-src/cdos-txmodal.jsx": 34,
  "os-src/cdos-vault.jsx": 35,
  "server/src/auth/break-glass.ts": 2,
  "server/src/auth/cdid.ts": 1,
  "server/src/clients/records.ts": 3,
  "server/src/clients/routes.ts": 1,
  "server/src/comms.ts": 14,
  "server/src/db/index.ts": 5,
  "server/src/email.ts": 3,
  "server/src/emails/design.ts": 18,
  "server/src/index.ts": 11,
  "server/src/ledger/cheques.ts": 2,
  "server/src/ledger/currencies.ts": 2,
  "server/src/ledger/obligations.ts": 1,
  "server/src/ledger/report-filings.ts": 1,
  "server/src/ledger/routes.ts": 4,
  "server/src/ledger/service.ts": 1,
  "server/src/ledger/threshold-control.ts": 1,
  "server/src/ledger/vault-control.ts": 1,
  "server/src/onboarding/flow.ts": 6,
  "server/src/onboarding/pipeline.ts": 1,
  "server/src/onboarding/walkthrough.ts": 2,
  "server/src/platform/health.ts": 2,
  "server/src/platform/team.ts": 1,
  "server/src/quotes/routes.ts": 0,
  "server/src/rates/market.ts": 1,
  "server/src/routes/admin.ts": 9,
  "server/src/routes/desk.ts": 3,
  "server/src/routes/enquiries.ts": 1,
  "server/src/routes/onboarding-public.ts": 15,
  "server/src/routes/public-site.ts": 1,
  "server/src/routes/signup.ts": 10,
  "server/src/routes/staff.ts": 2,
  "server/src/routes/tenantState.ts": 2,
  "server/src/state/contract.ts": 1,
  "server/src/state/shape.ts": 10,
  "web/app/os.js": 764,
};
const FIXED: Array<[string, string]> = [
  ["os-src/cdos-branches.jsx", "Drag someone onto a branch to assign them, or onto a till to post them to that drawer"],
  ["os-src/cdos-settings.jsx", "Password set by the employee. Only they know it. Reset issues a new temporary one."],
  ["os-src/cdos-settings.jsx", "Server unavailable. Passwords are managed on the live desk."],
  ["os-src/cdos-settings.jsx", "Type their name above. Their username fills in by itself."],
  ["server/src/routes/public-site.ts", "Ref ${ref}. Show this text at the desk."],
  ["server/src/routes/public-site.ts", "confirmed. ${fmtAmount(q.receiveAmount, q.wantCcy)} set aside until"],
  ["YorkFX/YorkFX Visit.html", "Visit Us | Currency Exchange"],
  ["YorkFX/YorkFX Visit.html", "Unit 102, footsteps"],
  ["YorkFX/YorkFX Visit.html", "Unit 102, directly across"],
  ["YorkFX/YorkFX Visit.html", "Bloor-Yonge"],
];
type Code = { t: "code"; br: number; root: boolean; canRe: boolean };
type Frame = Code | { t: "tpl" } | { t: "jsxText" } | { t: "jsxTag"; phase: "name" | "attr" };
function walk(dir: string, pred: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "web") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, pred, out);
    else if (pred(path)) out.push(path);
  }
  return out;
}
function files(): string[] {
  const out: string[] = [];
  walk(join(root, "os-src"), (path) => /\.(js|jsx|mjs|css|html)$/.test(path), out);
  walk(join(root, "server/src"), (path) => /\.(ts|js|mjs)$/.test(path), out);
  walk(join(root, "YorkFX"), (path) => path.endsWith(".html"), out);
  walk(join(root, "design"), (path) => path.endsWith(".html"), out);
  for (const name of readdirSync(root)) if (name.endsWith(".html")) out.push(join(root, name));
  out.push(join(root, "web/app/os.js"));
  return [...new Set(out)].map((path) => relative(root, path)).sort();
}
function idStart(c: string): boolean { return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127; }
function idChar(c: string): boolean { return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127; }
function isWs(c: string): boolean { return c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f"; }
/* jsx is on for .jsx sources. The built bundle is plain JS, so os.js
   stays off and its createElement strings are what get counted. */
export function visibleJs(source: string, jsx: boolean): string {
  const n = source.length;
  let i = 0;
  let out = "";
  const stack: Frame[] = [{ t: "code", br: 0, root: true, canRe: true }];
  const at = (k: number) => source.charAt(k);
  const top = () => stack[stack.length - 1]!;
  function decodeEscape(): string {
    i += 1;
    const c = at(i);
    i += 1;
    if (c === "u" && at(i) === "{") {
      const end = source.indexOf("}", i + 1);
      const hex = source.slice(i + 1, end < 0 ? i + 1 : end);
      i = end < 0 ? n : end + 1;
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    }
    if (c === "u") {
      const cp = Number.parseInt(source.slice(i, i + 4), 16);
      i += 4;
      return Number.isFinite(cp) ? String.fromCharCode(cp) : "";
    }
    if (c === "x") {
      const cp = Number.parseInt(source.slice(i, i + 2), 16);
      i += 2;
      return Number.isFinite(cp) ? String.fromCharCode(cp) : "";
    }
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    if (c === "\r") { if (at(i) === "\n") i += 1; return ""; }
    if (c === "\n") return "";
    return c;
  }
  function readQuoted(quote: string): string {
    i += 1;
    let s = "";
    while (i < n) {
      const c = at(i);
      if (c === "\\") { s += decodeEscape(); continue; }
      if (c === quote) { i += 1; break; }
      s += c;
      i += 1;
    }
    return s;
  }
  function readRegex(): boolean {
    i += 1;
    let cls = false;
    while (i < n) {
      const c = at(i);
      if (c === "\\") { i += 2; continue; }
      if (c === "\n" || c === "\r") return false;
      if (cls) { if (c === "]") cls = false; i += 1; continue; }
      if (c === "[") { cls = true; i += 1; continue; }
      if (c === "/") { i += 1; break; }
      i += 1;
    }
    while (i < n && /[a-zA-Z]/.test(at(i))) i += 1;
    return true;
  }
  function readNumber(): void {
    if (at(i) === "0" && /[xXbBoO]/.test(at(i + 1))) {
      i += 2;
      while (i < n && /[0-9a-fA-F_]/.test(at(i))) i += 1;
    } else {
      if (at(i) === ".") i += 1;
      while (i < n && /[0-9_]/.test(at(i))) i += 1;
      if (at(i) === "." && /[0-9]/.test(at(i + 1))) { i += 1; while (i < n && /[0-9_]/.test(at(i))) i += 1; }
      if (at(i) === "e" || at(i) === "E") {
        i += 1;
        if (at(i) === "+" || at(i) === "-") i += 1;
        while (i < n && /[0-9_]/.test(at(i))) i += 1;
      }
    }
    if (at(i) === "n") i += 1;
  }
  while (i < n) {
    const s = top();
    const c = at(i);
    const d = at(i + 1);
    if (s.t === "tpl") {
      if (c === "\\") { out += decodeEscape(); continue; }
      if (c === "`") { stack.pop(); i += 1; continue; }
      if (c === "$" && d === "{") { stack.push({ t: "code", br: 0, root: false, canRe: true }); i += 2; continue; }
      out += c; i += 1; continue;
    }
    if (s.t === "jsxText") {
      if (c === "{") {
        if (source.startsWith("{/*", i)) {
          i += 3;
          while (i < n && !(at(i) === "*" && at(i + 1) === "/")) i += 1;
          i = Math.min(n, i + 2);
          if (at(i) === "}") i += 1;
          continue;
        }
        stack.push({ t: "code", br: 0, root: false, canRe: true });
        i += 1; continue;
      }
      if (c === "<" && d === "/") {
        i += 2;
        while (i < n && at(i) !== ">") i += 1;
        if (i < n) i += 1;
        stack.pop(); continue;
      }
      if (c === "<") { stack.push({ t: "jsxTag", phase: "name" }); i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (s.t === "jsxTag") {
      if (isWs(c)) { i += 1; continue; }
      if (s.phase === "name") {
        if (c === ">") { s.phase = "attr"; continue; }
        if (c === "/") { i += 1; continue; }
        while (i < n && (idChar(at(i)) || at(i) === "-" || at(i) === ":" || at(i) === ".")) i += 1;
        s.phase = "attr"; continue;
      }
      if (c === "/" && d === ">") { stack.pop(); i += 2; continue; }
      if (c === ">") { stack.pop(); i += 1; stack.push({ t: "jsxText" }); continue; }
      if (c === "{") { stack.push({ t: "code", br: 0, root: false, canRe: true }); i += 1; continue; }
      if (c === "'" || c === "\"") { out += readQuoted(c); continue; }
      if (idStart(c)) { while (i < n && (idChar(at(i)) || at(i) === "-" || at(i) === ":")) i += 1; continue; }
      i += 1; continue;
    }
    if (isWs(c)) { i += 1; continue; }
    if (c === "/" && d === "/") { i += 2; while (i < n && at(i) !== "\n") i += 1; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(at(i) === "*" && at(i + 1) === "/")) i += 1; i = Math.min(n, i + 2); continue; }
    if (c === "'" || c === "\"") { out += readQuoted(c); s.canRe = false; continue; }
    if (c === "`") { stack.push({ t: "tpl" }); i += 1; continue; }
    if (c === "/" && s.canRe) {
      const atSlash = i;
      if (!readRegex()) i = atSlash + 1;
      s.canRe = false; continue;
    }
    if (jsx && c === "<" && s.canRe && d !== "=" && d !== "<" && (d === ">" || idStart(d))) {
      stack.push({ t: "jsxTag", phase: "name" }); i += 1; continue;
    }
    if (c === "{") { s.br += 1; s.canRe = true; i += 1; continue; }
    if (c === "}") {
      if (s.br > 0) { s.br -= 1; s.canRe = false; i += 1; continue; }
      if (!s.root) { stack.pop(); i += 1; continue; }
      s.canRe = true; i += 1; continue;
    }
    if (c === "(" || c === "[") { s.canRe = true; i += 1; continue; }
    if (c === ")" || c === "]") { s.canRe = false; i += 1; continue; }
    if (",;?:=~!*%^&|".includes(c)) { s.canRe = true; i += 1; continue; }
    if (c === "+" || c === "-") {
      if (d === c) { i += 2; continue; }
      if (d === "=") { i += 2; s.canRe = true; continue; }
      s.canRe = true; i += 1; continue;
    }
    if (c === "<" || c === ">") { s.canRe = true; i += 1; continue; }
    if (c === ".") {
      if (d === "." && at(i + 2) === ".") { i += 3; s.canRe = true; continue; }
      if (s.canRe && /[0-9]/.test(d)) { readNumber(); s.canRe = false; continue; }
      i += 1; s.canRe = false; continue;
    }
    if (/[0-9]/.test(c)) { readNumber(); s.canRe = false; continue; }
    if (idStart(c)) {
      const start = i;
      i += 1;
      while (i < n && idChar(at(i))) i += 1;
      s.canRe = RE_KW.has(source.slice(start, i));
      continue;
    }
    s.canRe = true; i += 1;
  }
  return out;
}
function stripHtml(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    out += source.charAt(i);
    i += 1;
  }
  return out;
}
function visible(path: string, source: string): string {
  if (path.endsWith(".html")) return stripHtml(source);
  return visibleJs(source, path.endsWith(".jsx"));
}
function dashCount(text: string): number {
  return (text.match(/\u2014|\u2013/g) || []).length;
}
function counts(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of files()) {
    const n = dashCount(visible(path, readFileSync(join(root, path), "utf8")));
    if (n) found[path] = n;
  }
  return found;
}
describe("dash ratchet", () => {
  it("matches each recorded dash count exactly", () => {
    const actual = counts();
    const keys = new Set([...Object.keys(BASELINE), ...Object.keys(actual)]);
    for (const path of [...keys].sort()) expect(actual[path] ?? 0, path).toBe(BASELINE[path] ?? 0);
  });
  it("counts a dash added on the Desk name line the old stripper skipped", () => {
    const path = "os-src/cdos-settings.jsx";
    const source = readFileSync(join(root, path), "utf8");
    const lines = source.split("\n");
    const idx = lines.findIndex((line) => line.includes("The desk shown under your branch in the header"));
    expect(idx).toBeGreaterThanOrEqual(1963);
    expect(idx).toBeLessThanOrEqual(2135);
    const before = dashCount(visible(path, source));
    lines[idx] = lines[idx]!.replace("Desk 1.", "Desk 1. " + EM);
    expect(dashCount(visible(path, lines.join("\n")))).toBe(before + 1);
  });
  it("keeps a slash-star inside a string, and skips a JSX comment", () => {
    expect(dashCount(visibleJs('<label><input accept="image/*" /> a ' + EM + " b</label>", true))).toBe(1);
    expect(dashCount(visibleJs("<div>{/* " + EM + " */}ok</div>", true))).toBe(0);
    expect(dashCount(visibleJs("const a = 1 / 2; const s = \"" + EM + "\"", false))).toBe(1);
    expect(dashCount(visibleJs("const s = `a " + EM + " ${x} b " + EN + "`", false))).toBe(2);
    expect(dashCount(visibleJs("\"\\u2014\"", false))).toBe(1);
  });
  it("keeps the fixed lines free of an em dash and an en dash", () => {
    for (const [path, needle] of FIXED) {
      const lines = readFileSync(join(root, path), "utf8").split("\n").filter((line) => line.includes(needle));
      expect(lines.length, path + " " + needle).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, path).not.toContain(EM);
        expect(line, path).not.toContain(EN);
      }
    }
  });
});
