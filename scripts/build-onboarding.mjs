/* ============================================================
   Compile the designed onboarding into the served page.

     CurrencyDesk Onboarding.html  →  web/onboarding.html

   The design is a complete 24-screen flow that keeps its answers in
   localStorage. That is right for a prototype and wrong for the real
   thing: an operator who starts on the laptop in their shop and
   finishes on their phone would lose everything, and nothing we filled
   in for them from the panel would ever appear.

   So the only thing this build changes is WHERE the answers live. Every
   screen, every animation, every word is the design's. The injections
   are asserted — if the design is re-exported and an anchor moves, this
   fails loudly rather than quietly shipping a page that has stopped
   saving.
   ============================================================ */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "CurrencyDesk Onboarding.html");
const OUT = path.join(ROOT, "web", "onboarding.html");

/* Talks to /api/onboarding/:code — the same record the control panel works
   from, so a desk half set up at the counter opens here already filled in. */
const BRIDGE = `<script>
(function () {
  "use strict";
  var KEY = 'cdos_onboarding_v2';
  var code = new URLSearchParams(location.search).get('code');
  var CD = window.__cdOnboarding = {
    code: code ? String(code).toUpperCase() : null,
    application: null,
    ready: false,
    /* Save is debounced and never blocks a keystroke. A failure is kept
       quiet on purpose: the answers are still in localStorage, and telling
       somebody mid-sentence that the network blinked helps nobody. */
    save: function (i, data) {
      if (!CD.code) return;
      clearTimeout(CD._t);
      CD._t = setTimeout(function () {
        fetch('/api/onboarding/' + encodeURIComponent(CD.code) + '/state', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: i, data: data }),
        }).catch(function () {});
      }, 700);
    },
  };

  /* Hydrate before React mounts, so the first paint is already their desk
     rather than an empty form that fills in a moment later. */
  CD.boot = function (done) {
    if (!CD.code) { CD.ready = true; return done(); }
    fetch('/api/onboarding/' + encodeURIComponent(CD.code) + '/state')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (s && s.data) {
          CD.application = s.application || null;
          try { localStorage.setItem(KEY, JSON.stringify({ i: s.at || 0, data: s.data })); } catch (e) {}
        }
        CD.ready = true; done();
      })
      .catch(function () { CD.ready = true; done(); });
  };
})();
</script>
`;

const EDITS = [
  // save to the server as well as the browser
  [
    "  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ i, data })); } catch (e) {} }, [i, data]);",
    "  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ i, data })); } catch (e) {}\n" +
      "    if (window.__cdOnboarding) window.__cdOnboarding.save(i, data); }, [i, data]);",
  ],
  // mount only once the server's copy is in place
  [
    "ReactDOM.createRoot(document.getElementById('root')).render(<Root />);",
    "(window.__cdOnboarding ? window.__cdOnboarding.boot : function (f) { f(); })(function () {\n" +
      "  ReactDOM.createRoot(document.getElementById('root')).render(<Root />);\n" +
      "});",
  ],
];

let html = readFileSync(SRC, "utf8");
for (const [from, to] of EDITS) {
  if (!html.includes(from)) throw new Error(`onboarding: injection anchor not found —\n${from}`);
  html = html.replace(from, to);
}
// the bridge has to exist before the app script runs
const anchor = "<body>";
if (!html.includes(anchor)) throw new Error("onboarding: no <body> to place the bridge before");
html = html.replace(anchor, anchor + "\n" + BRIDGE);

html = html.replace("</head>", '<meta name="robots" content="noindex,follow">\n</head>');

writeFileSync(OUT, html);
console.log(`built web/onboarding.html  (${(html.length / 1024).toFixed(0)} kB)  from the design`);
