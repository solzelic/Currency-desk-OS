#!/usr/bin/env node
/* ============================================================
   Build the public site: design/site/*.dc.html  →  web/*.html

     node scripts/build-site.mjs

   The design pages are Claude Design documents — ordinary markup
   plus {{ }} bindings, driven at runtime by the design's own
   dc-runtime (design/site/support.js). We keep that runtime
   rather than compiling the bindings away, so a re-export from
   the designer is a file copy, not a porting exercise.

   The build's job is to make those pages stand on their own:
     · React comes from web/vendor/, never unpkg
     · fonts come from web/fonts/, never fonts.googleapis.com
     · links to design pages become real routes on this server
     · each page gets a title, description and social card

   Binary assets (photographs, illustrations, fonts) are produced
   once by scripts/extract-design-assets.mjs and committed; this
   build reuses them and fails loudly if they are missing.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "design", "site");
const OUT = path.join(ROOT, "web");
const SITE_ORIGIN = "https://www.currencydeskos.com";

/* ---------------------------------------------------------------
   The pages the design links to, and where each one lives here.

   `out` is the file we generate; `route` is what links become.
   A page the designer has not sent yet falls back to `anchor` —
   the section of the front page that covers the same ground — so
   no link is ever dead. Drop the .dc.html into design/site and
   re-run: it builds, and every link to it retargets automatically.

   Sign In and Early Access are deliberately NOT built as pages.
   They are the entrances to the product, so they route into the
   real OS — a static copy would look right and do nothing.
   --------------------------------------------------------------- */
const PAGES = {
  "CurrencyDesk Site":         { out: "index.html",  route: "/",  home: true,
    title: "CurrencyDesk — more trades, less paperwork",
    description: "One desk for the whole shop: live rates, till and ledger, clients and KYC, and your regulator's rulebook carried for you. Live in Canada.",
    /* The hero counter ticks up to the number of desks claimed. The design
       animates to a fixed 64; wait for the real figure and animate to that,
       and hold the design's number if the call fails so the hero never shows
       a zero it doesn't mean. The bar reads out of the cohort size rather
       than assuming it is 100. */
    inject: [[
      "    if (reduce) { this.setState({ claimed: 64 }); return; }\n" +
        "    this._cc = setInterval(() => this.setState(s => { const n = s.claimed + 1; if (n >= 64) clearInterval(this._cc); return { claimed: Math.min(n, 64) }; }), 26);",
      "    window.claimedCount.then(d => {\n" +
        "      const target = d ? d.claimed : 64;\n" +
        "      this.setState({ cap: d ? d.cap : 100 });\n" +
        "      if (reduce || target <= 0) { this.setState({ claimed: target }); return; }\n" +
        "      this._cc = setInterval(() => this.setState(s => { const n = s.claimed + 1; if (n >= target) clearInterval(this._cc); return { claimed: Math.min(n, target) }; }), Math.max(12, Math.round(1650 / target)));\n" +
        "    });",
    ], [
      "      claimed: s.claimed, claimedPct: s.claimed + '%',",
      "      claimed: s.claimed, claimedCap: s.cap || 100,\n" +
        "      claimedPct: Math.min(100, Math.round((s.claimed / (s.cap || 100)) * 100)) + '%',",
    ], [
      "state = { showAll: false, detected: '', term: 'monthly', clock: this.clk(), tick: 0, claimed: 0,",
      "state = { showAll: false, detected: '', term: 'monthly', clock: this.clk(), tick: 0, claimed: 0, cap: 100,",
    ], [
      '<span style="color: #fff; font-weight: 600; font-size: 13px;">{{ claimed }}</span> / 100 desks claimed',
      '<span style="color: #fff; font-weight: 600; font-size: 13px;">{{ claimed }}</span> / {{ claimedCap }} desks claimed',
    ]] },
  "CurrencyDesk Mobile":       { out: "mobile.html", route: "/m", home: true, noindex: true,
    title: "CurrencyDesk — more trades, less paperwork",
    description: "One desk for the whole shop — rates, till, ledger, clients and compliance.",
    /* The mobile design has no way in for someone who already has a desk: its
       header offers Early access and nothing else, and at 390px that header is
       already full — a second action there costs the wordmark. So Sign in goes
       in the footer nav, which is a two-column list with room to spare. Move it
       to the header once the design makes space for it. */
    inject: [[
      ">Privacy &amp; Terms</a>",
      ">Privacy &amp; Terms</a>\n      " +
        '<a href="/login" style="font-size: 13.5px; color: var(--mute);">Sign in</a>',
    ], [
      // the same live count as the front page, in both places it appears
      ">64 of 100 desks claimed</span>",
      "><span data-cd-claimed>64</span> of <span data-cd-cap>100</span> desks claimed</span>",
    ], [
      'border-radius: 999px; overflow: hidden;"><div style="height: 100%; width: 64%; background: #fff;',
      'border-radius: 999px; overflow: hidden;"><div data-cd-bar style="height: 100%; width: 64%; background: #fff;',
    ], [
      '<b style="color: #fff;">64</b> / 100 claimed',
      '<b style="color: #fff;" data-cd-claimed>64</b> / <span data-cd-cap>100</span> claimed',
    ]] },
  "CurrencyDesk Legal":        { out: "legal.html",  route: "/legal", anchor: "#company",
    title: "Privacy Policy and Terms of Service — CurrencyDesk",
    description: "Both documents in full, on one page. What we collect, what we do with it, and the terms your desk runs under." },
  "CurrencyDesk FAQ":          { out: "faq.html",    route: "/faq", anchor: "#faq",
    title: "Your questions, answered — CurrencyDesk",
    description: "What CurrencyDesk costs, what it runs on, how long setup takes, and when it reaches your country." },
  "CurrencyDesk Compliance":   { out: "compliance.html", route: "/compliance", anchor: "#compliance",
    title: "Compliance — CurrencyDesk",
    description: "Your regulator's rulebook loads first: thresholds watched, reports prepared, records kept." },
  "CurrencyDesk Contact":      { out: "contact.html", route: "/contact", anchor: "#company",
    title: "Contact — CurrencyDesk",
    description: "Talk to the people building the desk. No ticket queue, no phone tree.",
    /* The design ends the form with a made-up reference and a promise of a
       reply. Send it first, and show the reference the server recorded. */
    inject: [[
      "    const n = Math.floor(1000 + Math.random() * 8999);\n" +
        "    this.setState({ sent: true, ref: 'CD-' + n });",
      "    const s = this.state;\n" +
        "    this.setState({ sent: true, ref: 'sending…' });\n" +
        "    sendEnquiry('contact', s.email, s.name, {\n" +
        "      topic: s.topic, shop: s.shop, city: s.city, message: s.msg, newsletter: s.news,\n" +
        /* sendEnquiry resolves the whole reply, not a string. Setting that
           object straight into `ref` put an object where the confirmation
           screen renders text — React refuses to render one, so the page
           went blank at the exact moment somebody had finished writing to
           us. Read the reference off it. */
        "    }).then((r) => this.setState({ ref: (r && r.reference) || 'not sent — please email hello@currencydeskos.com' }));",
    ]] },
  "CurrencyDesk Add-ons":      { out: "add-ons.html", route: "/add-ons", anchor: "#pricing",
    title: "Add-ons — CurrencyDesk",
    description: "Extras that bolt onto the desk, priced on their own." },
  "CurrencyDesk Early Access": { out: "early-access.html", route: "/signup", anchor: "/signup",
    title: "Become a Founding Operator — CurrencyDesk",
    description: "Apply for early access: founding pricing held for the life of the account, and a direct line to the people building the desk.",
    /* The last step congratulates the applicant. Nothing had been sent —
       record the application at the moment the design says it is done.
       Its header "Sign in" is a placeholder href too; give it the door. */
    inject: [[
      '<a href="#" style="font-size: 13.5px; font-weight: 700; color: {{ headText }};',
      '<a href="/login" style="font-size: 13.5px; font-weight: 700; color: {{ headText }};',
    ], [
      /* WHAT THE SHOP IS CALLED.

         The form asked nine questions and none of them was the name of the
         business. Everything downstream wanted it: the emails open with
         "thanks for putting <their shop> forward", the charter card is
         mostly that name, and the panel had nothing to show but a slug.

         It goes on the step that already asks them to reserve an address,
         because that is where somebody is thinking about what their shop
         is called anyway — and typing it fills the address in underneath. */
      '<div style="margin-top: 22px; display: flex; align-items: center; background: #FFFDF8; border: 1.5px solid #DDD5C6; border-radius: 13px; overflow: hidden;" style-focus="border-color:#A9791C;">',
      '<label for="cd-shop" style="display: block; margin-top: 22px; font-family: \'IBM Plex Mono\', monospace; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6459;">What the shop is called</label>' +
        '<input id="cd-shop" ref="{{ refShop }}" value="{{ shopName }}" sc-camel-on-input="{{ onShopName }}" sc-camel-on-key-down="{{ onKey }}" placeholder="Yorkville Currency" ' +
        'style="width: 100%; box-sizing: border-box; margin-top: 8px; padding: 15px 18px; font-size: 16.5px; font-weight: 600; color: #17140F; background: #FFFDF8; border: 1.5px solid #DDD5C6; border-radius: 13px; outline: none;" style-focus="border-color:#A9791C;">' +
        '<div style="margin-top: 18px; font-family: \'IBM Plex Mono\', monospace; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6459;">Your address on CurrencyDesk</div>' +
        '<div style="margin-top: 8px; display: flex; align-items: center; background: #FFFDF8; border: 1.5px solid #DDD5C6; border-radius: 13px; overflow: hidden;" style-focus="border-color:#A9791C;">',
    ], [
      // the name is the field worth landing on, so the step opens there
      "this._refByStep = { 0: 'ref0', 1: 'ref1', 2: 'ref2', 6: 'ref7', 7: 'ref6' };",
      "this.refShop = React.createRef();\n    this._refByStep = { 0: 'ref0', 1: 'ref1', 2: 'refShop', 6: 'ref7', 7: 'ref6' };",
    ], [
      "step: 0, email: '', domain: '', workspace: '', volume: null,",
      "step: 0, email: '', domain: '', shopName: '', workspace: '', volume: null,",
    ], [
      // both, or the step is not done. A desk with no name is the thing
      // this whole change exists to stop happening again.
      "case 2: return s.workspace.trim().length > 1;",
      "case 2: return s.shopName.trim().length > 1 && s.workspace.trim().length > 1;",
    ], [
      /* Typing the name fills the address in under it — but only while the
         address is still ours to guess. The moment they edit it themselves
         it is theirs, and nothing we do here may overwrite it. */
      "  _workspaceFull() {",
      "  onShopName = (e) => {\n" +
        "    const v = e.target.value;\n" +
        "    this.setState((s) => {\n" +
        "      const slug = v.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);\n" +
        "      const ours = !s.workspace || s.workspace === s._autoWs;\n" +
        "      return ours ? { shopName: v, workspace: slug, _autoWs: slug } : { shopName: v };\n" +
        "    });\n" +
        "  };\n\n" +
        "  _workspaceFull() {",
    ], [
      "      workspace: s.workspace, onWorkspace: this.set('workspace'), ref2: this.ref2, workspaceFull: this._workspaceFull(),",
      "      workspace: s.workspace, onWorkspace: this.set('workspace'), ref2: this.ref2, workspaceFull: this._workspaceFull(),\n" +
        "      shopName: s.shopName, onShopName: this.onShopName, refShop: this.refShop,",
    ], [
      "if (this.state.step === 8) { setTimeout(() => this.startMemberCount(), 800); }",
      "if (this.state.step === 8) {\n" +
        "        const s = this.state;\n" +
        "        sendEnquiry('early_access', s.email, s.name, {\n" +
        "          shopName: s.shopName, workspace: this._workspaceFull(), website: s.noWebsite ? 'none yet' : s.domain,\n" +
        "          jurisdiction: s.jur, role: s.role, employees: s.employees, monthlyVolume: s.volume,\n" +
        "          branches: s.branches, runningOn: s.stack, timeline: s.timeline,\n" +
        /* The number we ring, in one piece and in the shape a person dials.
           The dialling code plus digits only, never the prettified version
           the field shows — spacing is for reading, not for storing. The
           server normalises it to E.164 from here.

           `callWindow` becomes `bestTime` on the way out for the same reason
           `volume` becomes `monthlyVolume` above: the design names its own
           state, and an application's answers are named for the person
           reading them in the panel. */
        "          phone: s.dial + ' ' + String(s.phone || '').replace(/\\D/g, ''), bestTime: s.callWindow,\n" +
        "        }).then((r) => {\n" +
        "          if (!r.reference) this.flashToast('We could not record that — email hello@currencydeskos.com');\n" +
        "          this._target = r.charterNo || null;\n" +
        "          setTimeout(() => this.startMemberCount(), 800);\n" +
        "        });\n      }",
    ], [
      /* The card said a random number between 38 and 64 — so two operators
         could be handed the same Nº on a thing that reads "on the record",
         and nobody's was their real place in line. Wait for the number the
         server assigned and count up to that. If the application did not
         reach us the seal stays blank rather than inventing a place; the
         toast above has already said so. */
      "  startMemberCount = () => {\n" +
        "    clearInterval(this._mc);\n" +
        "    const target = this._target || (this._target = 38 + Math.floor(Math.random() * 27));\n" +
        "    const from = Math.max(1, target - 6);",
      "  startMemberCount = () => {\n" +
        "    clearInterval(this._mc);\n" +
        "    const target = this._target;\n" +
        "    if (!target) { this.setState({ memberCount: null }); return; }\n" +
        "    const from = Math.max(1, target - 6);",
    ], [
      "      memberNo: 'Nº ' + String(s.memberCount).padStart(4, '0'),",
      "      memberNo: s.memberCount == null ? '' : 'Nº ' + String(s.memberCount).padStart(4, '0'),",
    ], [
      // no stale 42 on the seal while the real number is still in flight
      "seed: 0, toast: '', noWebsite: false, memberCount: 42",
      "seed: 0, toast: '', noWebsite: false, memberCount: null",
    ], [
      // the downloadable certificate carries the same number, or none
      "      const no = 'Nº ' + String(this.state.memberCount).padStart(4, '0');",
      "      const no = this.state.memberCount == null ? '' : 'Nº ' + String(this.state.memberCount).padStart(4, '0');",
    ], [
      "      a.download = 'CurrencyDesk-Founding-Operator-' + String(this.state.memberCount).padStart(4, '0') + '.png';",
      "      a.download = 'CurrencyDesk-Founding-Operator' + (this.state.memberCount == null ? '' : '-' + String(this.state.memberCount).padStart(4, '0')) + '.png';",
    ], [
      /* Two things the eighth step left behind, fixed here rather than in the
         design so a re-export stays a file copy.

         The phone step was inserted at index 6 and the label list was not
         extended, so `nextLabels[step] || 'Continue'` put "Claim my
         membership" on the PHONE screen — which is not the last one — and
         "Continue" on the final screen, which is. The applicant is told they
         are done a step early and then asked for more. */
      "    const nextLabels = ['Apply for early access', 'Continue', 'Reserve it', 'Continue', 'Continue', 'Continue', 'Claim my membership'];",
      "    const nextLabels = ['Apply for early access', 'Continue', 'Reserve it', 'Continue', 'Continue', 'Continue', 'Continue', 'Claim my membership'];",
    ], [
      // and the pager still draws seven dots for eight steps, so the last one
      // has nothing to light up
      "    const pager = [0, 1, 2, 3, 4, 5, 6].map((i) => ({",
      "    const pager = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({",
    ], [
      // the cohort meter, live. The bar ANIMATES to its width, so the keyframe
      // has to end on the real figure too — hence the custom property.
      "@keyframes cdFill { from { width: 0; } to { width: 64%; } }",
      "@keyframes cdFill { from { width: 0; } to { width: var(--cd-fill, 64%); } }",
    ], [
      '<div style="height: 100%; border-radius: 3px; background: linear-gradient(90deg, #1D6B45, #2EA36B); width: 64%; animation: cdFill',
      '<div data-cd-bar style="height: 100%; border-radius: 3px; background: linear-gradient(90deg, #1D6B45, #2EA36B); width: 64%; animation: cdFill',
    ], [
      ">64 / 100 desks claimed</div>",
      "><span data-cd-claimed>64</span> / <span data-cd-cap>100</span> desks claimed</div>",
    ]] },
  // the way back in — always the live route, never a page. A designed sign-in
  // should restyle the OS's real one, not sit in front of it doing nothing.
  "CurrencyDesk Sign In":      { route: "/login", product: true },
};

/* Both public forms post here. Defined once, injected into the pages that
   need it: the design's own logic calls it and shows what comes back, so a
   failure surfaces as a missing reference rather than a false success. */
const ENQUIRY_HELPER = `<script>
window.sendEnquiry = function (kind, email, name, details) {
  return fetch('/api/enquiries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: kind, email: email, name: name || undefined, details: details }),
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    // the whole reply: the reference to quote back, and — for an application —
    // the charter number that goes on their card
    .catch(function (e) { console.error('[enquiry] not sent:', e); return { reference: '', charterNo: null }; });
};
</script>
`;

/* "64 of 100 desks claimed" was the number the design happened to be drawn
   with, baked into three pages. It is counted server-side now and read here,
   so it moves when somebody applies.

   Two ways to use it: any element carrying data-cd-claimed / data-cd-cap has
   its text filled in, and window.claimedCount is the promise, for the front
   page whose counter animates up to the figure. Every path leaves the number
   the page shipped with untouched if the call fails — a stale count reads
   better than a blank space where the social proof was. */
const CLAIMED_HELPER = `<script>
window.claimedCount = fetch('/api/site/early-access')
  .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
  .catch(function (e) { console.error('[early-access] count unavailable:', e); return null; });
window.claimedCount.then(function (d) {
  if (!d) return;
  // the progress bars are drawn at a fixed width, and one of them ANIMATES to
  // that width — so the real figure has to reach the keyframe too, which it
  // does through the custom property the keyframe now ends on
  var pct = Math.min(100, Math.round((d.claimed / (d.cap || 100)) * 100)) + '%';
  var apply = function () {
    var fill = function (attr, value) {
      var nodes = document.querySelectorAll('[' + attr + ']');
      // only write when it differs, or the observer below sees its own edits
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].textContent !== String(value)) nodes[i].textContent = String(value);
      }
    };
    fill('data-cd-claimed', d.claimed);
    fill('data-cd-cap', d.cap);
    var bars = document.querySelectorAll('[data-cd-bar]');
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].style.getPropertyValue('--cd-fill') === pct) continue;
      bars[i].style.setProperty('--cd-fill', pct);
      bars[i].style.width = pct;
    }
  };
  /* These numbers sit inside dc-runtime components, which re-render and put
     the design's own 64 back. Rather than teach each design about the count,
     write it again whenever the page changes underneath us.

     This script runs in the head, so the fetch can land before there is a
     body to watch — wait for one, or the observer throws and takes the
     count down with it. */
  var start = function () {
    apply();
    if (typeof MutationObserver === 'function' && document.body) {
      new MutationObserver(apply).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
});
</script>
`;

/* dc-runtime asks for React at runtime; cdnScriptFor() consults
   window.__resources first, so pointing those URLs at local copies keeps
   the page working with no network at all. (Babel is only fetched for
   x-import'ed JSX, which no page uses — if one ever does, it will fail
   visibly rather than quietly reaching for a CDN.) */
const CDN = {
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "/web/vendor/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "/web/vendor/react-dom.production.min.js",
};

const VENDOR = [
  ["react/umd/react.production.min.js", "react.production.min.js"],
  ["react-dom/umd/react-dom.production.min.js", "react-dom.production.min.js"],
];

/* the design's logo mark, as the tab icon */
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 140">' +
  '<rect width="200" height="140" fill="#E7E3DA"/>' +
  '<circle cx="60" cy="70" r="48" fill="#17140F"/>' +
  '<path d="M116,22 H136 A48,48 0 0 1 136,118 H116 Z" fill="#17140F"/>' +
  '<rect x="60" y="64.5" width="92" height="11" fill="#E7E3DA"/>' +
  '<circle cx="112" cy="70" r="6.5" fill="#1D6B45"/></svg>';

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---- preflight ------------------------------------------------ */
if (!existsSync(SRC)) throw new Error(`no design sources at ${SRC}`);
for (const dir of ["photos", "assets", "fonts"]) {
  const p = path.join(OUT, dir);
  if (!existsSync(p) || readdirSync(p).length === 0) {
    throw new Error(`web/${dir} is empty — run scripts/extract-design-assets.mjs <export.html> first`);
  }
}

const present = new Set(
  readdirSync(SRC).filter((f) => f.endsWith(".dc.html")).map((f) => f.replace(/\.dc\.html$/, "")),
);
for (const name of present) {
  if (!PAGES[name]) throw new Error(`design/site/${name}.dc.html has no entry in PAGES — add one`);
}

/* where a link to <design page> should point today */
const routeOf = (name) => {
  const p = PAGES[name];
  if (p.product || present.has(name)) return p.route;
  return p.anchor ?? p.route;
};

mkdirSync(path.join(OUT, "vendor"), { recursive: true });
for (const [from, to] of VENDOR) {
  copyFileSync(path.join(ROOT, "node_modules", from), path.join(OUT, "vendor", to));
}
copyFileSync(path.join(SRC, "image-slot.js"), path.join(OUT, "image-slot.js"));
writeFileSync(path.join(OUT, "support.js"), patchRuntime(readFileSync(path.join(SRC, "support.js"), "utf8")));

/* ---------------------------------------------------------------
   One fix to the design's runtime.

   React calls componentDidUpdate(prevProps, prevState); the runtime
   forwards only prevProps, so a page written to React's contract —
   `if (prevState.step !== this.state.step)` — throws on every update
   and loses everything that hook was doing. (The Early Access wizard
   uses it for step focus, for guessing the workspace from the domain,
   and for the members counter.) The wrapper's own React state is just
   a version counter, so the logic's previous state has to be kept as
   it is replaced, then handed over.

   Asserted line by line: a re-export that changes any of this fails
   the build instead of quietly dropping the fix.
   --------------------------------------------------------------- */
function patchRuntime(js) {
  const edits = [
    // remember the state we are replacing
    [
      '        this.logic.state = { ...prev, ...patch };\n',
      '        this.logic.state = { ...prev, ...patch };\n        this.__prevLogicState = prev;\n',
    ],
    // and hand it to the author's hook, as React would
    [
      '            this.logic.componentDidUpdate(prevProps);\n',
      '            this.logic.componentDidUpdate(prevProps, this.__prevLogicState || this.logic.state);\n',
    ],
  ];
  for (const [from, to] of edits) {
    if (!js.includes(from)) throw new Error(`support.js: runtime patch anchor not found — ${from.trim()}`);
    js = js.replace(from, to);
  }
  return js;
}

/* ---- pages ---------------------------------------------------- */
const built = [];
for (const name of present) {
  const page = PAGES[name];
  if (page.product) continue;            // entrances are routes, not pages
  let html = readFileSync(path.join(SRC, `${name}.dc.html`), "utf8");

  // runtime + assets move under /web/, so every page resolves them the
  // same way regardless of the route it is served at
  html = html
    .replace(/(["'])\.\/support\.js\1/g, "$1/web/support.js$1")
    .replace(/(["'])\.\/image-slot\.js\1/g, "$1/web/image-slot.js$1")
    .replace(/\.\.\/photos\//g, "/web/photos/")
    .replace(/\.\.\/assets\//g, "/web/assets/");

  // self-hosted fonts, in place of the Google stylesheet + preconnects
  html = html.replace(
    /\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]*>/,
    '\n  <link rel="stylesheet" href="/web/fonts/fonts.css">',
  );

  // design page links → live routes
  for (const other of Object.keys(PAGES)) {
    const to = routeOf(other);
    // the design references the product's own pages as ../app/<name>.dc.html
    for (const from of [`../app/${other}.dc.html`, `${other}.dc.html`]) {
      html = html.split(from).join(to);
    }
  }
  // a link built as "<page>#<section>" collapses when <page> resolved to
  // an on-page anchor — "#compliance#fintrac" is not a place
  html = html.replace(/(href=")(#[a-z0-9-]+)#[a-z0-9-]+(")/gi, "$1$2$3");
  html = html.replace(/'(#[a-z0-9-]+)#'\s*\+\s*[^,\n]+?\.replace\(\/\[\^a-z0-9\]\+\/g,\s*'-'\)/gi, "'$1'");

  for (const [from, to] of page.inject ?? []) {
    if (!html.includes(from)) throw new Error(`${name}: injection anchor not found — ${from}`);
    html = html.replace(from, to);
  }

  // local React, declared before the runtime reads it — and, for the pages
  // whose forms now reach the server, the one call that gets them there
  const resources = `<script>window.__resources = ${JSON.stringify(CDN)};</script>\n`;
  const helper = html.includes("sendEnquiry(") ? ENQUIRY_HELPER : "";
  const counter = /data-cd-(claimed|cap)|claimedCount/.test(html) ? CLAIMED_HELPER : "";
  html = html.replace('<script src="/web/support.js">', resources + helper + counter + '<script src="/web/support.js">');

  const head =
    `<title>${esc(page.title)}</title>\n` +
    `<meta name="description" content="${esc(page.description)}">\n` +
    `<link rel="canonical" href="${SITE_ORIGIN}${page.route}">\n` +
    (page.noindex ? '<meta name="robots" content="noindex,follow">\n' : "") +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:site_name" content="CurrencyDesk">\n` +
    `<meta property="og:title" content="${esc(page.title)}">\n` +
    `<meta property="og:description" content="${esc(page.description)}">\n` +
    `<meta property="og:url" content="${SITE_ORIGIN}${page.route}">\n` +
    `<meta property="og:image" content="${SITE_ORIGIN}/web/photos/rate-board-storefront.jpg">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    `<meta name="theme-color" content="#E7E3DA">\n` +
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">\n`;
  html = html.replace("</head>", head + "</head>");

  writeFileSync(path.join(OUT, page.out), html);
  built.push(`${page.out.padEnd(16)} ${page.route}`);
}

/* ---- report --------------------------------------------------- */
const pending = Object.entries(PAGES)
  .filter(([n, p]) => !p.product && !present.has(n))
  .map(([n, p]) => `${n} → falls back to ${p.anchor}`);

console.log(`built ${built.length} page(s):`);
for (const b of built) console.log("  " + b);
if (pending.length) {
  console.log("\nnot yet designed (links fall back to a front-page section):");
  for (const p of pending) console.log("  " + p);
}
