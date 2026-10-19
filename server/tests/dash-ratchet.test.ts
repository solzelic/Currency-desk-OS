import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* User-facing copy only: desk sources, the root shells, server messages
   (comments stripped), the SMS templates, and the marketing pages.
   The number for each file is the count on this head. A later edit may
   remove a dash. It may not add one. The lines this pull request fixed
   may not grow a dash again. */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EM = "\u2014";
const EN = "\u2013";

const BASELINE: Record<string, number> = {
  "CurrencyDesk OS.html": 2,
  "YorkFX/YorkFX Homepage.html": 3,
  "YorkFX/YorkFX Rate Board.html": 9,
  "YorkFX/YorkFX Rates.html": 4,
  "YorkFX/YorkFX Regulations.html": 8,
  "YorkFX/YorkFX Services.html": 9,
  "YorkFX/YorkFX Visit.html": 4,
  "admin.html": 134,
  "design/emails/CurrencyDesk Emails.dc.html": 47,
  "design/kyc-handoff/kyc-verification-states.html": 26,
  "design/onboarding/currencydesk-onboarding.html": 18,
  "design/site/CurrencyDesk Compliance.dc.html": 1,
  "design/site/CurrencyDesk Contact.dc.html": 2,
  "design/site/CurrencyDesk Early Access.dc.html": 12,
  "design/site/CurrencyDesk FAQ.dc.html": 19,
  "design/site/CurrencyDesk Legal.dc.html": 16,
  "design/site/CurrencyDesk Mobile.dc.html": 5,
  "design/site/CurrencyDesk Site.dc.html": 13,
  "os-src/cdos-apps.jsx": 7,
  "os-src/cdos-backend.js": 3,
  "os-src/cdos-base.jsx": 9,
  "os-src/cdos-branches.jsx": 43,
  "os-src/cdos-cheques-app.jsx": 3,
  "os-src/cdos-cheques.jsx": 10,
  "os-src/cdos-clients.jsx": 58,
  "os-src/cdos-compliance-app.jsx": 13,
  "os-src/cdos-compliance.jsx": 5,
  "os-src/cdos-dashboard.jsx": 13,
  "os-src/cdos-import.jsx": 13,
  "os-src/cdos-kyc.jsx": 18,
  "os-src/cdos-lctr.jsx": 45,
  "os-src/cdos-ledger.jsx": 89,
  "os-src/cdos-modules.jsx": 7,
  "os-src/cdos-os.jsx": 48,
  "os-src/cdos-persist.js": 4,
  "os-src/cdos-pricing.jsx": 5,
  "os-src/cdos-reports.jsx": 61,
  "os-src/cdos-search.jsx": 4,
  "os-src/cdos-settings.jsx": 98,
  "os-src/cdos-signin.jsx": 10,
  "os-src/cdos-telegraph.jsx": 111,
  "os-src/cdos-till.jsx": 58,
  "os-src/cdos-tour.js": 1,
  "os-src/cdos-transfers-app.jsx": 10,
  "os-src/cdos-transfers.jsx": 16,
  "os-src/cdos-txmodal.jsx": 36,
  "os-src/cdos-vault.jsx": 45,
  "server/src/auth/break-glass.ts": 2,
  "server/src/auth/cdid.ts": 1,
  "server/src/clients/records.ts": 3,
  "server/src/clients/routes.ts": 2,
  "server/src/comms.ts": 14,
  "server/src/db/index.ts": 5,
  "server/src/email.ts": 1,
  "server/src/emails/design.ts": 22,
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
  "server/src/quotes/routes.ts": 1,
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
};

const FIXED: Array<[string, string]> = [
  ["os-src/cdos-branches.jsx", "Drag someone onto a branch to assign them, onto a till to post them to that drawer"],
  ["os-src/cdos-settings.jsx", "Password set by the employee. Only they know it. Reset issues a new temporary one."],
  ["server/src/routes/public-site.ts", "Ref ${ref}. Show this text at the desk."],
  ["server/src/routes/public-site.ts", "confirmed. ${fmtAmount(q.receiveAmount, q.wantCcy)} set aside until"],
  ["YorkFX/YorkFX Visit.html", "Visit Us. Currency Exchange"],
  ["YorkFX/YorkFX Visit.html", "Unit 102. Footsteps"],
  ["YorkFX/YorkFX Visit.html", "Unit 102. Directly"],
  ["YorkFX/YorkFX Visit.html", "Bloor-Yonge"],
];

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
  return [...new Set(out)].map((path) => relative(root, path)).sort();
}

function stripJs(source: string): string {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === "\"" || c === "`") { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i += 2; continue; }
      if (c === "\n") out += "\n";
      i++; continue;
    }
    out += c;
    if (c === "\\") { if (i + 1 < source.length) { out += source[i + 1]; i += 2; continue; } }
    if (c === state) state = "code";
    i++;
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
    out += source[i++]!;
  }
  return out;
}

function visible(path: string, source: string): string {
  if (path.endsWith(".html")) return stripHtml(source);
  return stripJs(source);
}

function counts(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of files()) {
    const text = visible(path, readFileSync(join(root, path), "utf8"));
    const n = (text.match(/\u2014|\u2013/g) || []).length;
    if (n) found[path] = n;
  }
  return found;
}

describe("dash ratchet", () => {
  it("does not let any user-facing file gain an em dash or an en dash", () => {
    const actual = counts();
    for (const [path, n] of Object.entries(actual)) {
      expect(n, path).toBeLessThanOrEqual(BASELINE[path] ?? 0);
    }
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
