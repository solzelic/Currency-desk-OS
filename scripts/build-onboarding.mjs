/* ============================================================
   Compile the designed onboarding into the served page.

     CurrencyDesk Onboarding.html  →  web/onboarding.html

   The design is a dc-runtime standalone bundle: 17 screens that keep
   their answers in localStorage. That is right for a prototype and
   wrong for the real thing — an operator who starts on the shop laptop
   and finishes on their phone would lose the lot, and nothing we filled
   in from the panel would ever reach them.

   So the only thing this build changes is WHERE the answers live. Every
   screen, every animation, every word is the design's.

   Two seams, and they are asymmetric on purpose:

     SAVE is an injection into the design's own persist call. One
     asserted anchor; if a re-export moves it the build fails loudly
     rather than quietly shipping a page that has stopped saving.

     HYDRATE does NOT reach into the bundle at all. The runtime boots
     itself, so racing it with a fetch would be a coin toss that fails
     on slow connections and passes on ours. Instead the bridge puts the
     server's copy into localStorage with one synchronous request before
     any of the bundle's scripts run. Synchronous XHR is a blunt tool and
     the right one here: this page is opened once, behind a code, and a
     wizard that occasionally starts blank is far worse than one that
     waits 80ms.
   ============================================================ */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "CurrencyDesk Onboarding.html");
const OUT = path.join(ROOT, "web", "onboarding.html");

/* The design's own storage key. Kept in one place here so that if a re-export
   renames it, the assert below is what tells us — not a customer whose
   answers stopped coming back. */
const KEY = "cdos_onb_v2";

const BRIDGE = `<script>
(function () {
  "use strict";
  var KEY = ${JSON.stringify(KEY)};
  /* The code can arrive either way: /onboarding/CD-A3V5ZE is what we put in
     the email because it reads like an address rather than a query string,
     and ?code= still works for anything already sent. */
  var path = location.pathname.replace(/\\/+$/, "").split("/").pop() || "";
  var q = new URLSearchParams(location.search).get("code") || "";
  var code = (/^CD-/i.test(path) ? path : q).toUpperCase();

  var CD = window.__cdOnb = {
    code: code || null,
    application: null,
    /* Debounced, and never blocks a keystroke. A failure stays quiet on
       purpose: the answers are still in localStorage, and telling somebody
       mid-sentence that the network blinked helps nobody. */
    save: function (i, data) {
      if (!CD.code) return;
      clearTimeout(CD._t);
      CD._t = setTimeout(function () {
        fetch("/api/onboarding/" + encodeURIComponent(CD.code) + "/state", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ at: i, data: data }),
        }).catch(function () {});
      }, 700);
    },
  };

  // before the bundle runs, so the first paint is already their desk
  if (CD.code) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/onboarding/" + encodeURIComponent(CD.code) + "/state", false);
      xhr.send();
      if (xhr.status === 200) {
        var s = JSON.parse(xhr.responseText);
        CD.application = s.application || null;
        if (s.data) localStorage.setItem(KEY, JSON.stringify({ i: s.at || 0, data: s.data }));
      } else if (xhr.status === 404) {
        CD.unknownCode = true;
      }
    } catch (e) { /* offline: their own browser's copy is what they get */ }
  }
})();
</script>
`;

/* Inside the bundle the design's source is a JSON-escaped string, so the
   anchor is matched — and the injection written — in that escaped form. No
   quotes in the added code, or it would need escaping too. */
const SAVE_ANCHOR =
  "localStorage.setItem(this.KEY, JSON.stringify({ i: save, data: this.state.data }));";
const SAVE_PATCH =
  SAVE_ANCHOR + " if (window.__cdOnb) window.__cdOnb.save(save, this.state.data);";

if (!existsSync(SRC)) {
  console.log("no CurrencyDesk Onboarding.html in the repo root — nothing to build.");
  console.log("drop the design there and run this again.");
  process.exit(0);
}

let html = readFileSync(SRC, "utf8");

if (!html.includes(`KEY = '${KEY}'`)) {
  throw new Error(`onboarding: the design's storage key is no longer '${KEY}' — update scripts/build-onboarding.mjs`);
}
if (!html.includes(SAVE_ANCHOR)) {
  throw new Error("onboarding: the persist call moved — nothing would save. Anchor:\n" + SAVE_ANCHOR);
}
html = html.split(SAVE_ANCHOR).join(SAVE_PATCH);

/* The dc runtime forwards only prevProps to componentDidUpdate, so the second
   argument arrives undefined and the design's first line throws on every
   update — the same defect scripts/build-site.mjs patches in support.js for
   the site pages. The runtime here is inside a bundled blob and not reachable
   as text, so the guard goes on the design's own handler instead. */
const CDU_ANCHOR = "componentDidUpdate(prevP, prevS) {\\n    if (prevS.i !== this.state.i)";
const CDU_PATCH = "componentDidUpdate(prevP, prevS) {\\n    if (!prevS) prevS = this.state;\\n    if (prevS.i !== this.state.i)";
if (!html.includes(CDU_ANCHOR)) {
  throw new Error("onboarding: componentDidUpdate guard anchor not found — check whether the runtime still drops prevState");
}
html = html.split(CDU_ANCHOR).join(CDU_PATCH);

const bodyAt = html.indexOf("<body");
if (bodyAt < 0) throw new Error("onboarding: no <body> to place the bridge in");
const bodyEnd = html.indexOf(">", bodyAt) + 1;
html = html.slice(0, bodyEnd) + "\n" + BRIDGE + html.slice(bodyEnd);

html = html
  .replace("<title>Bundled Page</title>", "<title>Set up your desk — CurrencyDesk</title>")
  .replace("</head>", '<meta name="robots" content="noindex,follow">\n</head>');

writeFileSync(OUT, html);
console.log(`built web/onboarding.html  (${Math.round(html.length / 1024)} kB) from the design`);
