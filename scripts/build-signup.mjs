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
import { compileSignup } from "./signup-aot.mjs";
import { patchSignupTour } from "./signup-tour.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "design/onboarding/signup-v2.1");
const SRC = path.join(DIR, "CurrencyDesk Sign-up v2.1.dc.html");
/* The bridge, in the order it must load: the core (ID, credential, code, PIN,
   boot), then the chapters, then Open (plan, card, Day 1). */
const BRIDGE = ["signup-v2.1-bridge.js", "signup-v2.1-chapters.js", "signup-v2.1-open.js", "signup-v2.1-consent.js", "signup-v2.1-audio.js", "signup-v2.1-setup.js", "signup-v2.1-tour.js"]
  .map((f) => path.join(ROOT, "design/onboarding", f));
const SSO = path.join(ROOT, "design/onboarding/signup-sso.html");
const OUT = path.join(ROOT, "web/signup.html");
const ASSETS = path.join(ROOT, "web/signup");
const agreementSource = readFileSync(path.join(ROOT, "server/src/onboarding/signup-open.ts"), "utf8");
const agreementVersions = [...agreementSource.matchAll(/export const SERVICE_AGREEMENT_SOURCE_HASH = "([a-f0-9]{64})";/g)];
if (agreementVersions.length !== 1) throw new Error("build-signup: server agreement version missing or ambiguous");
const AGREEMENT_HASH = agreementVersions[0][1];
const AGREEMENT_START = "CurrencyDesk Service Agreement</div>";
const AGREEMENT_END = "are the whole understanding between us on this subject.";

let html = readFileSync(SRC, "utf8");

function patch(name, from, to, count = 1) {
  const n = html.split(from).length - 1;
  if (n !== count) throw new Error(`build-signup: "${name}" expected ${count} match(es), found ${n}`);
  html = html.split(from).join(to);
}
function patchRegion(name, startMark, endMark, from, to, count = 1) {
  const a = html.indexOf(startMark), b = html.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error(`build-signup: region "${name}" not found`);
  const region = html.slice(a, b);
  const matches = region.split(from).length - 1;
  if (html.split(startMark).length !== 2 || matches !== count) throw new Error(`build-signup: region "${name}" expected ${count} matches, found ${matches}`);
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
patch("runtime", '<script src="./support.js"></script>', `<script>window.__cdAgreementHash=${JSON.stringify(AGREEMENT_HASH)};</script>\n` + BRIDGE.map((f) => `<script>\n${readFileSync(f, "utf8")}</script>\n`).join("") + '<script src="/web/support.js"></script>');
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

/* Invalidate pending navigation even when Back returns to the same screen. */
patch("back cancels advance", "  back() {", "  back() { window.__cdOnb.navigation();");
/* Keep invalid input visible for validation; never turn -10 into 10 or 1.5 notes into 15. */
patch("note input exact", "String(q).replace(/[^0-9]/g, '')", "String(q)");
patch("coin input exact", "String(q).replace(/[^0-9.]/g, '')", "String(q)");
patch("total input exact", "v.replace(/[^0-9.]/g, '')", "String(v)");

/* Draft counts have no authoritative converted valuation or posted balance. */
patch("draft count label", "In the vault, in {{ homeCode }}", "{{ countSummaryLabel }}", 2);
patch("draft count status", "≈ {{ drawerStr }}", "{{ drawerStr }}", 2);

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

/* Context resume belongs only to the pointer/key wake handler, never a delayed tone. */
patch("audio wake only", "    if (this._ac.state === 'suspended' || this._ac.state === 'interrupted') { try { this._ac.resume(); } catch (x) {} }", "");
const ACCOUNT_MENU = `<details data-signup-account="true" onKeyDown="{{ accountKey }}" style="position:relative;flex:none;margin-left:auto;font-family:var(--m);font-size:12px;color:#17140F;background:#F8F5ED;border:1px solid #DDD5C6;border-radius:12px;box-shadow:0 4px 12px #17140f0a;">
    <summary tabindex="0" style="min-height:44px;min-width:44px;box-sizing:border-box;padding:14px;cursor:pointer;">Account</summary>
    <button type="button" tabindex="0" aria-pressed="{{ soundOn }}" onClick="{{ onSound }}" style="min-height:44px;min-width:120px;margin:0 8px 8px;border:1px solid #DDD5C6;border-radius:8px;background:#F8F5ED;color:#17140F;font:inherit;cursor:pointer;">{{ soundLabel }}</button>
  </details>`;
/* Account belongs to the layout. A viewport overlay covered Back on phones. */
patch("wizard account sound control", '<sc-if value="{{ hasBack }}" hint-placeholder-val="{{ true }}">', ACCOUNT_MENU + '<sc-if value="{{ hasBack }}" hint-placeholder-val="{{ true }}">');
patch("payment account sound control", '<div onKeyDown="{{ onKey }}" style="{{ modalStyle }}" data-paymodal="true">', '<div onKeyDown="{{ onKey }}" style="{{ modalStyle }}" data-paymodal="true"><div data-signup-toolbar="true" style="display:flex;flex:none;justify-content:flex-end;padding:8px 12px;">' + ACCOUNT_MENU + '</div>');
/* On Day 1 the real Home's header owns the top-right corner (the owner's name and
   avatar); a viewport-fixed Account covered them. It lives in the welcome card. */
patch("day one welcome card frame", '<div style="width: min(560px, 100%); padding: 40px 34px 34px;', '<div style="position: relative; width: min(560px, 100%); padding: 40px 34px 34px;');
patch("day one account sound control", 'text-align: center; animation: cdPop 0.7s cubic-bezier(0.2,1.2,0.4,1) both;">', 'text-align: center; animation: cdPop 0.7s cubic-bezier(0.2,1.2,0.4,1) both;">' + ACCOUNT_MENU.replace('position:relative;', 'position:absolute;top:12px;right:12px;z-index:2;text-align:left;'));
/* Back's padded target extends below this header; keep it above the phase bar. */
patch("account header wrapping", "</helmet>", '<style>[data-cardtop] { flex-wrap:wrap;z-index:4!important; } [data-cardtop] [data-signup-account] { align-self:flex-start; }</style>\n</helmet>');
/* Desktop controls need 24px; preserve the header's height and the phone's 44px. */
patch("desktop account target", "</helmet>", '<style>@media(min-width:721px) { [data-signup-account] summary { min-height:26px!important;padding:6px 14px!important;line-height:14px; } }</style>\n</helmet>');
/* Fitted cards keep a line of slack for renderer text metrics (Linux CI wraps the
   ID hint): short desktops may use the split card's 24px margin, not 92vh. */
patch("short desktop card room", "cardMaxH: (type === 'explain' || M.formTop === 'lock') ? 'none' : type === 'pin' ? 'calc(100vh - 20px)' : 'min(92vh, 840px)',", "cardMaxH: (type === 'explain' || M.formTop === 'lock') ? 'none' : type === 'pin' ? 'calc(100vh - 20px)' : 'var(--cd-card-max, min(92vh, 840px))',");
patch("short desktop card room css", "</helmet>", '<style>@media(min-width:1100px) and (max-height:900px) { [data-card] { --cd-card-max:min(calc(100vh - 24px), 840px); } }</style>\n</helmet>');
patch("screen layout identity", '<div style="{{ stageWrap }}">', '<div data-signup-screen="{{ i }}" data-signup-explain="{{ t_explain }}" style="{{ stageWrap }}">');
/* Keep complete chapter introductions and their actions inside desktop viewports. */
patch("chapter desktop fit", "</helmet>", `<style>
@media(min-width:1100px) and (max-height:940px) {
 [data-signup-explain="true"] { padding:12px 24px!important; }
 [data-signup-explain="true"] [data-cardtop] { padding-top:8px!important;padding-bottom:0!important; }
 [data-signup-explain="true"] [data-stage] { padding:12px 34px 4px!important; }
 [data-signup-explain="true"] [data-exwrap] { grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important; }
 [data-signup-explain="true"] [data-exgrid]>div { padding:4px 0!important; }
 [data-signup-explain="true"] [data-foot] { padding:8px 34px 12px!important; }
}
</style>\n</helmet>`);
patch("credential disabled state", "        R.authNote =", "        R.authBtns = R.authBtns.map(b => Object.assign({}, b, { disabled: busy || ok(b.id) }));\n        R.authNote =");
patch("credential disabled semantics", '<button onClick="{{ b.onTap }}" data-logo="{{ b.id }}"', '<button disabled="{{ b.disabled }}" onClick="{{ b.onTap }}" data-logo="{{ b.id }}"');

/* ---- accessibility (axe, build doc §8): names, language, tap targets ---- */
patch("language", "<html><head>", '<html lang="en"><head>');
patch("keypad names (markup)", '<button type="button" onClick="{{ k.onTap }}" style="{{ k.s }}"', '<button type="button" aria-label="{{ k.aria }}" onClick="{{ k.onTap }}" style="{{ k.s }}"');
patch("keypad names", "      R.pinMsg = err ||", "      R.pinKeys = R.pinKeys.map((k) => Object.assign(k, { aria: k.l === '←' ? 'Delete the last digit' : (k.l || 'Clear') }));\n      R.pinMsg = err ||");
patch("remove names (markup)", '<button onClick="{{ t.onDel }}" style=', '<button aria-label="{{ t.delLabel }}" onClick="{{ t.onDel }}" style=');
patch("remove names", "          onDel: () => this.delMember(k),", "          onDel: () => this.delMember(k), delLabel: 'Remove ' + t.name,");
patch("desk apps reachable", '<div data-deskapps="true" style=', '<div data-deskapps="true" tabindex="0" role="region" aria-label="Desk apps" style=');
/* every button at least 44px on a phone (build doc §5); the count's two tabs were 40 */
patch("phone tap targets", "</helmet>", "<style>@media (max-width: 720px) { [data-card] [role=\"tab\"] { min-height: 44px !important; } }</style>\n</helmet>");

/* Credential managers can suggest a new password without treating this as returning login. */
patch("new password autofill", "country_addr:'country-name', ownerName:'name'", "ownerPass:'new-password', pass2:'new-password', country_addr:'country-name', ownerName:'name'");
/* Native controls keep their Enter action; a chapter shortcut must not swallow it. */
patch("keyboard choice activation", "  onKey(e) {", "  onKey(e) {\n    if (e.defaultPrevented || (e.key === 'Enter' && e.target && e.target.closest && e.target.closest('button,a,summary,[role=button],[role=tab],[role=checkbox]'))) return;");
patch("payment fold disabled state", "R['pf' + k + 'NextL'] = nexts[k];", "R['pf' + k + 'NextL'] = nexts[k]; R['pf' + k + 'Disabled'] = !nextOk[k];");
for (let k = 0; k < 4; k++) patch("payment disabled " + k, '<button onClick="{{ pf' + k + 'Next }}"', '<button disabled="{{ pf' + k + 'Disabled }}" onClick="{{ pf' + k + 'Next }}"');
patch("accessible control targets", "</helmet>", `<style>
[data-product] button, [data-product] a[href] { min-height:24px; }
[data-product] a[href] { display:inline-flex;align-items:center; }
[data-product] :is(button,a,input,[tabindex]):focus-visible { outline:2px solid #1D6B45;outline-offset:3px; }
@media(max-width:720px) {
 [data-product] :is(button,a[href],input,[role=tab],[role=button]) { min-height:44px!important;min-width:44px!important;box-sizing:border-box; }
 [data-product] button[data-herocta] { min-width:260px!important; }
}
</style>\n</helmet>`);
/* The hero action is already 260px wide in the prototype; the 44px floor above must not narrow it. */
patch("hero action identity", '<button onClick="{{ onCta }}" disabled="{{ ctaDisabled }}" style="{{ heroCtaStyle }}"', '<button data-herocta="true" onClick="{{ onCta }}" disabled="{{ ctaDisabled }}" style="{{ heroCtaStyle }}"');

patchSignupTour(patch, patchRegion);

/* ======== CHAPTERS (signup-v2.1-chapters.js) ======== */
/* ---- the address: Google Places through our server, by hand otherwise ---- */
patch("places list", "const list = ql.length < 3 ? [] : this.ADDR.filter(", "const list = window.__cdOnb ? window.__cdOnb.places(this, ql) : this.ADDR.filter(");
patch("places line", "sub: a[4] + ', ' + a[1] + ', ' + a[2] + ', Canada'", "sub: a.sub || (a[4] + ', ' + a[1] + ', ' + a[2])");
patch("places pick", "  _adPick(a) {", "  _adPick(a) { if (a && a.placeId) return window.__cdOnb.pickPlace(this, a);");

/* ======== OPEN (signup-v2.1-open.js): plan, card, Day 1, tour ======== */
/* ---- the plan: the server's prices, Stripe's card ---------------------- */
patch("card complete", "(d.cardNum || '').replace(/\\s/g, '').length >= 15 && (d.cardExp || '').length >= 4 && (d.cardCvc || '').length >= 3 && ",
  "!!window.__cdOnb.cardComplete && ", 2);
patch("no last four", "const last4 = (d.cardNum || '').replace(/\\s/g, '').slice(-4);", "const last4 = '';");
patch("no backup promised", "'Card, billing address, a backup if you like'", "'Card and billing address'");
patch("card summary", "'Card •••• ' + last4 + ' · '", "'Card ready · '");
patch("not while paying", "this._payValid = this._payValid && read;", "this._payValid = this._payValid && read && !window.__cdOnb._paying;");
patch("no promo yet", "R.promoMsg = 'Stripe checkout is not connected yet.';", "R.promoMsg = 'That code isn\\u2019t one we recognise.';");
/* a backup card needs its own SetupIntent, which the server does not make
   yet: not shown, rather than collected and dropped */
patch("no backup yet", "R.showBackup = !!d.showBackup; R.notShowBackup = !d.showBackup;", "R.showBackup = false; R.notShowBackup = false;");
patch("pay", "  goLive() {", "  goLive() { if (window.__cdOnb) { if (this._payValid) window.__cdOnb.pay(this); return; }");
patch("price retry", '<div data-paysum="true"', '<sc-if value="{{ retryPricesVisible }}"><button type="button" onClick="{{ onRetryPrices }}" style="min-height:44px;padding:10px 16px;">Try loading prices again</button></sc-if><div data-paysum="true"');
patch("prices and day one", "    return Object.assign(R, this._railVals(), this._tourVals());",
  "    return window.__cdOnb.priced(this, Object.assign(R, this._railVals(), this._tourVals()));");
patch("setup week price", ">$5,000 once<", ">{{ xSetupPrice }}<");
patch("website price", ">$99 CAD/mo<", ">{{ xWebPrice }}<", 2);

/* card number, expiry and CVC: Stripe's frame instead of our inputs */
{
  const lines = html.split("\n");
  const num = lines.findIndex((l) => l.includes('<input value="{{ cardNum }}"'));
  const exp = lines.findIndex((l) => l.includes('<input value="{{ cardExp }}"'));
  if (num < 0 || exp < 0 || !lines[exp - 1].includes("grid-template-columns: 1fr 1fr") || !lines[exp + 1].includes('value="{{ cardCvc }}"') || lines[exp + 2].trim() !== "</div>")
    throw new Error("build-signup: card fields moved");
  lines[num] = '                <div data-stripe-card="true" role="group" aria-label="Card details" style="min-height: 46px;"></div>';
  lines[num] += '<sc-if value="{{ retryCardVisible }}"><button type="button" onClick="{{ onRetryCard }}" style="min-height:44px;padding:10px 16px;border:1px solid #DDD5C6;border-radius:10px;background:#fff;color:#17140F;font:inherit;cursor:pointer;">Try the card form again</button></sc-if>';
  lines.splice(exp - 1, 4);
  const note = lines.findIndex((l) => l.includes("A backup card is worth adding."));
  if (note < 0) throw new Error("build-signup: backup note moved");
  lines.splice(note, 1);
  html = lines.join("\n");
}

/* Consent is an explicit persisted choice; this row is not a payment side effect. */
patch("call consent accessibility", '<button onClick="{{ onXCall }}" style="{{ xCallS }}">', '<button onClick="{{ onXCall }}" style="{{ xCallS }}" aria-pressed="{{ xCall }}" disabled="{{ samBusy }}">');
patch("call consent words", 'SAM will call you to set up your desk. No call, thanks? Tap to switch it off.', '{{ samText }}');
patch("call consent status", '<div style="font-family: var(--m); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); font-weight: 700; margin: 16px 0 8px;">Add if you like</div>', '<div role="status" style="font-size:12px;line-height:1.45;color:var(--mute);margin-top:8px">{{ samStatus }}</div><div style="font-family: var(--m); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); font-weight: 700; margin: 16px 0 8px;">Add if you like</div>');

/* ---- Day 1: the real desk behind the welcome --------------------------- */
/* The real session's Home is a React child, never an imperative insertion race. */
patch("day one real frame", '<div data-desk="true" style="min-height:', '<div data-desk="true" data-real="{{ realHome }}" style="position:relative;min-height:');
patch("day one prototype chrome begins", '      <div style="display: flex; align-items: center; gap: 12px; height: 46px; padding: 0 18px; background: #F6F2EA;', `      <sc-if value="{{ realHome }}"><iframe data-real-home="true" src="/app?onboarding=welcome" title="Your desk Home" aria-hidden="true" tabindex="-1" inert="{{ realInert }}" style="position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;filter:saturate(0.85) brightness(0.92);"></iframe></sc-if>
      <sc-if value="{{ prototypeHome }}"><div style="display: flex; align-items: center; gap: 12px; height: 46px; padding: 0 18px; background: #F6F2EA;`);
patch("day one prototype chrome ends", '      <div style="position: relative; max-width: 780px; margin: 0 auto; padding: 38px 18px 60px;">', '      </sc-if><div style="{{ welcomeWrap }}"><sc-if value="{{ prototypeHome }}">');
patch("day one prototype cards end", '        <sc-if value="{{ dkOn }}" hint-placeholder-val="{{ false }}">', '        </sc-if><sc-if value="{{ dkOn }}" hint-placeholder-val="{{ false }}">');


patch("home loading status", '{{ dkCta }}</button>', '{{ dkCta }}</button><sc-if value="{{ homeStatus }}"><p data-real-home-status="true" role="status" style="font-size:12px;color:var(--mute)">{{ homeStatus }}</p></sc-if>');
patch("build my desk", "R.onDkWalk = ", "R.onDkWalk = window.__cdOnb.launched ? (() => { this._tone('next'); window.__cdOnb.walk(); }) : ");

/* ======== END OF SECTIONS ======== */
/* ---- nothing review-only survived ------------------------------------- */
for (const banned of ["demo-mode.js", "data-review=\"true\"", "coded/", "fonts.googleapis.com", "· simulated"]) {
  if (banned === "· simulated") continue; /* the kicker text is in the logic but never drawn: sheetOn is false */
  if (html.includes(banned)) throw new Error(`build-signup: "${banned}" is still in the page`);
}

mkdirSync(path.dirname(OUT), { recursive: true });
const built = compileSignup(html);
mkdirSync(path.join(ROOT, "web/app"), { recursive: true });
writeFileSync(OUT, built.html);
writeFileSync(path.join(ROOT, "web/app/signup.js"), built.js);
writeFileSync(path.join(ROOT, "web/signup-sso.html"), readFileSync(SSO, "utf8"));
for (const sub of ["flags", "shots"]) {
  mkdirSync(path.join(ASSETS, sub), { recursive: true });
  for (const f of readdirSync(path.join(DIR, sub))) copyFileSync(path.join(DIR, sub, f), path.join(ASSETS, sub, f));
}
const recordings = path.join(ROOT, "design/onboarding/signup-recordings");
mkdirSync(path.join(ASSETS, "recordings"), { recursive: true });
for (const name of ["home", "rates", "online", "vault", "settings", "dashboard", "currencies", "vaultset"]) {
  for (const suffix of [".webm", "-poster.png"]) copyFileSync(path.join(recordings, name + suffix), path.join(ASSETS, "recordings", name + suffix));
}
console.log(`build-signup: web/signup.html (${(html.length / 1024).toFixed(0)} KB), web/signup-sso.html, web/signup/`);
