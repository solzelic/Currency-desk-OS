/* ============================================================
   Compile the designed onboarding into the served page.

     CurrencyDesk Onboarding.html  →  web/onboarding.html

   The design is a dc-runtime standalone bundle: 17 screens that keep
   their answers in localStorage. That is right for a prototype and
   wrong for the real thing — an operator who starts on the shop laptop
   and finishes on their phone would lose the lot, nothing we filled in
   from the panel would ever reach them, and at the end of it no desk
   would exist.

   So this build changes three kinds of thing and nothing else:

     WHERE THE ANSWERS LIVE   — they go to the server as well as to
       localStorage, and the server's copy is in place before the
       bundle boots.

     WHO THE PAGE IS TALKING TO — the invite code from the link is the
       page's identity, so the shape the design validates has to be the
       shape we actually issue, and the demo desk must never be what a
       real customer opens on.

     WHAT THE LAST THREE SCREENS DO — verify a real code, and create a
       real desk. In the prototype both are theatre.

   Everything else — every screen, every animation, every word that
   isn't about the two changes above — is the design's.

   HOW THE PATCHING WORKS

   The bundle carries the design as a JSON string inside
   <script type="__bundler/template">, which the loader JSON.parses at
   boot. Patching that string in its escaped form means writing every
   anchor in escaped form too, which is how you end up with anchors
   nobody can read and a build that silently stops matching. So we
   parse it, patch the real source, and re-serialize.

   The one wrinkle is that the bundler escapes "</" as "</" so an
   inner </script> can't close the outer tag. We reproduce that exactly;
   forget it and the page truncates at the first inner script.

   EVERY ANCHOR IS ASSERTED. A re-export that moves one fails the build
   loudly rather than shipping a page that has quietly stopped saving,
   stopped verifying, or stopped creating desks.
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

/* ------------------------------------------------------------------
   The bridge. Everything the page needs that the design cannot know:
   which application this is, which channel we verify over, and how to
   turn the answers into a desk.

   It runs before any bundle script, so window.__cdOnb is already there
   when the design's own code first looks for it.
   ------------------------------------------------------------------ */
const BRIDGE = `<script>
(function () {
  "use strict";
  var KEY = ${JSON.stringify(KEY)};
  /* The code can arrive either way: /onboarding/CD-A3V5ZE is what we put in
     the email because it reads like an address rather than a query string,
     and ?code= still works for anything already sent. */
  var seg = location.pathname.replace(/\\/+$/, "").split("/").pop() || "";
  var q = new URLSearchParams(location.search).get("code") || "";
  var code = (/^CD-/i.test(seg) ? seg : q).toUpperCase();

  /* The shape we actually issue: CD- and six characters from an alphabet
     with no 0/1/I/O, so nothing misreads down a phone line. The design
     validated CD-XXXX-0000, which was invented before this existed and
     would reject every code we have ever emailed. The longer form is the
     walkthrough (CD-WALKTHRU) and anything else we mint by hand. */
  var REF = /^CD-[2-9A-HJ-NP-Z]{6,12}$/;

  function api(path, body) {
    return fetch("/api/onboarding/" + encodeURIComponent(CD.code) + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j || {} }; },
                           function () { return { status: r.status, body: {} }; });
    });
  }

  var CD = window.__cdOnb = {
    code: code || null,
    application: null,
    /* Which channel confirms the account. The server decides and says so
       here, because it is the thing that actually sends. Today that is
       email; when a phone provider exists it becomes "phone" server-side
       and every word on this screen follows without a rebuild. */
    verify: { channel: "email", sentTo: "" },
    err: "",

    refValid: function (v) { return REF.test(String(v || "").toUpperCase().trim()); },
    fmtRef: function (v) {
      var raw = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^CD/, "").slice(0, 12);
      return raw ? "CD-" + raw : "";
    },

    /* The verify screen, in the words of whichever channel is live. Both
       sets are kept: the phone one is not dead code, it is the copy that
       comes back the day we can send to a phone. */
    verifyCopy: function (d) {
      var to = CD.verify.sentTo || (CD.verify.channel === "phone" ? (d && d.phone) : (d && d.ownerEmail));
      if (CD.verify.channel === "phone") {
        return {
          q: "Confirm your mobile.",
          help: "We\\u2019ve texted a 6-digit code to " + (to || "your mobile") +
                ". This is the number that signs you in from now on, and the one we call.",
          resend: "No text yet?", fixLead: "Wrong number?",
          fixTail: "\\u2014 you\\u2019ll need this number every time you sign in.",
        };
      }
      return {
        q: "Confirm your email.",
        help: "We\\u2019ve emailed a 6-digit code to " + (to || "your email address") +
              ". This is the address that signs you in from now on, and the one we write to.",
        resend: "No email yet?", fixLead: "Wrong address?",
        fixTail: "\\u2014 you\\u2019ll need this address every time you sign in.",
      };
    },

    /* Arriving at the verify screen stages the desk and sends the code.
       Idempotent by design: coming back to this screen re-sends rather
       than erroring, which is what somebody who lost the email wants. */
    sendCode: function (d) {
      if (!CD.code) return Promise.resolve(false);
      CD.err = "";
      return api("/verify/send", { data: d }).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          CD.verify = { channel: r.body.channel || "email", sentTo: r.body.sentTo || "" };
          return true;
        }
        CD.err = r.body.detail || "We couldn\\u2019t send that code just now.";
        return false;
      }).catch(function () { CD.err = "We couldn\\u2019t send that code just now."; return false; });
    },

    checkCode: function (entered) {
      if (!CD.code) return Promise.resolve(true);
      return api("/verify/check", { code: entered }).then(function (r) {
        if (r.status === 200 && r.body.ok) { CD.err = ""; return true; }
        CD.err = r.body.detail || "That code isn\\u2019t right.";
        return false;
      }).catch(function () { CD.err = "We couldn\\u2019t check that code just now."; return false; });
    },

    /* The end of it. Creates the tenant and the owner, signs them in and
       closes the application. Everything before this is answers; this is
       the desk. */
    launch: function (d) {
      if (!CD.code) return Promise.resolve({ ok: true, simulated: true });
      CD.err = "";
      return api("/launch", { data: d }).then(function (r) {
        if ((r.status === 200 || r.status === 201) && r.body.ok) return r.body;
        CD.err = r.body.detail || "We couldn\\u2019t open the desk just then.";
        return { ok: false };
      }).catch(function () {
        CD.err = "We couldn\\u2019t open the desk just then.";
        return { ok: false };
      });
    },

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
        if (s.verify) CD.verify = s.verify;
        var data = s.data || {};
        /* They followed a link that already carries the code. Making them
           read it off the email and type it back is the flow admitting it
           wasn't listening. */
        if (!data.cdId) data.cdId = CD.code;
        localStorage.setItem(KEY, JSON.stringify({ i: s.at || 0, data: data }));
      } else if (xhr.status === 404) {
        CD.unknownCode = true;
      }
    } catch (e) { /* offline: their own browser's copy is what they get */ }
  }
})();
</script>
`;

/* ------------------------------------------------------------------
   Patches. Each is [what must be there, what replaces it, why], applied
   to the design's real source and asserted before it is applied.
   ------------------------------------------------------------------ */
function patcher(source) {
  let src = source;
  const applied = [];
  /* `count` is the number of occurrences we expect. Getting a different
     number is as much a failure as getting none: two call sites where we
     thought there was one means half the page kept the old behaviour. */
  const patch = (why, from, to, count = 1) => {
    const seen = src.split(from).length - 1;
    if (seen !== count) {
      throw new Error(
        `onboarding: anchor moved — ${why}\n` +
        `  expected ${count} occurrence(s), found ${seen}\n` +
        `  anchor: ${from.slice(0, 160)}${from.length > 160 ? "…" : ""}`,
      );
    }
    src = src.split(from).join(to);
    applied.push(why);
  };
  return { patch, applied, out: () => src };
}

if (!existsSync(SRC)) {
  console.log("no CurrencyDesk Onboarding.html in the repo root — nothing to build.");
  console.log("drop the design there and run this again.");
  process.exit(0);
}

const html = readFileSync(SRC, "utf8");

/* Pull the design out of the bundle. The template runs to the LAST
   </script> in the file — inner ones are escaped, so a non-greedy match
   would silently truncate the design to its first few lines. */
const OPEN = '<script type="__bundler/template">';
const openAt = html.indexOf(OPEN);
if (openAt < 0) throw new Error("onboarding: no __bundler/template script — is this still a dc standalone bundle?");
const closeAt = html.indexOf("</script>", openAt);
if (closeAt < 0) throw new Error("onboarding: the template script is never closed");

let design;
try {
  design = JSON.parse(html.slice(openAt + OPEN.length, closeAt));
} catch (err) {
  throw new Error("onboarding: the template is not the JSON string the loader expects — " + err.message);
}
if (typeof design !== "string") throw new Error("onboarding: the template parsed to a " + typeof design + ", not a string");

const { patch, applied, out } = patcher(design);

if (!design.includes(`KEY = '${KEY}'`)) {
  throw new Error(`onboarding: the design's storage key is no longer '${KEY}' — update scripts/build-onboarding.mjs`);
}

/* --- 1. Save to the server as well as to localStorage ------------- */
patch(
  "the persist call — nothing would save",
  "localStorage.setItem(this.KEY, JSON.stringify({ i: save, data: this.state.data }));",
  "localStorage.setItem(this.KEY, JSON.stringify({ i: save, data: this.state.data })); if (window.__cdOnb) window.__cdOnb.save(save, this.state.data);",
);

/* --- 2. The componentDidUpdate defect, and the send-on-arrival hook -
   The dc runtime forwards only prevProps, so the design's first line
   throws on every update. scripts/build-site.mjs patches the same defect
   in support.js for the site pages; here the runtime is inside a bundled
   blob, so the guard goes on the design's own handler instead.

   Landing on the verify screen is also the moment the code has to go
   out, and this is the one place that knows the screen just changed. */
patch(
  "componentDidUpdate — the runtime drops prevState and the design would throw on every update",
  "componentDidUpdate(prevP, prevS) {\n    if (prevS.i !== this.state.i) this.focusStage();",
  "componentDidUpdate(prevP, prevS) {\n" +
  "    /* The runtime forwards only prevProps, so prevS arrives undefined. The\n" +
  "       old guard substituted this.state, which stopped the throw but made\n" +
  "       'the screen changed' permanently false — focusStage never ran. Keep\n" +
  "       our own note of the screen instead: it is the only reliable one. */\n" +
  "    var wasI = this._seenI;\n" +
  "    this._seenI = this.state.i;\n" +
  "    if (!prevS) prevS = { i: wasI };\n" +
  "    if (wasI !== this.state.i && this.state.i === 14 && window.__cdOnb && window.__cdOnb.code) {\n" +
  "      window.__cdOnb.sendCode(this.state.data).then(() => this.forceUpdate());\n" +
  "    }\n" +
  "    if (prevS.i !== this.state.i) this.focusStage();",
);

/* --- 3. The invite code, in the shape we actually issue ------------
   Replacing the validator covers every call site at once: the hero's
   CTA, the badge, the hint and the input's own styling all ask it. */
patch(
  "cdIdValid — the design would reject every code we have emailed",
  "cdIdValid(v) { return /^CD-[A-Z0-9]{4}-[0-9]{4}$/.test(v || ''); }",
  "cdIdValid(v) { return window.__cdOnb ? window.__cdOnb.refValid(v) : /^CD-[A-Z0-9]{4}-[0-9]{4}$/.test(v || ''); }",
);
patch(
  "the code input's formatter — it would break CD-A3V5ZE into CD-A3V5-ZE as you type",
  "onCdId: (e) => this.set('cdId', this.fmtCdId(e.target.value)),",
  "onCdId: (e) => this.set('cdId', window.__cdOnb ? window.__cdOnb.fmtRef(e.target.value) : this.fmtCdId(e.target.value)),",
);
patch(
  "the code input's placeholder — it advertises a format we do not issue",
  'placeholder="CD-XXXX-0000"',
  'placeholder="CD-XXXXXX"',
);

/* --- 4. Never open a real customer on the demo desk ----------------
   The bundle's own default is prefillDemo:true, which is right for the
   design tool and would otherwise show a stranger York FX's address,
   float and staff. Served live, the flow starts empty and is filled
   only from their own application.

   Two call sites, and both matter: the initial state, and "start over" —
   which is exactly the button somebody presses when the demo data has
   confused them, so landing them back on it would be perverse. */
patch(
  "the initial state and reset — a live page would open prefilled with the demo desk",
  "data: (this.props && this.props.prefillDemo === false) ? this.fresh() : this.demo(),",
  "data: (window.__cdOnb || (this.props && this.props.prefillDemo === false)) ? this.fresh() : this.demo(),",
  2,
);

/* --- 5. The verification code is typed, not pre-answered -----------
   '000001' makes the prototype's verify screen arrive already valid.
   Two occurrences, fresh() and demo(), and both have to go or the CTA
   lights up before anything has been sent. */
patch(
  "the pre-filled verification code",
  "code:'000001'",
  "code:''",
  2,
);

/* --- 6. Verify by email, in the channel's own words ---------------- */
patch(
  "the verify screen's copy",
  "S[14] = { phase:3, type:'verify', mark:'lock', eyebrow:'Secure your account', q:'Confirm your mobile.', help:'We\\u2019ve texted a 6-digit code to ' + (d.phone || 'your mobile') + '. Your email is already confirmed — this is the number that signs you in from now on, and the one we call.', valid: (d.code || '').replace(/\\D/g, '').length === 6 };",
  "S[14] = { phase:3, type:'verify', mark:'lock', eyebrow:'Secure your account', q: this.vCopy().q, help: this.vCopy().help, valid: (d.code || '').replace(/\\D/g, '').length === 6 };",
);
patch(
  "the class body — nowhere to hang the channel's copy",
  "  meta(i, d, j, home, selCcy) {",
  "  vCopy() {\n" +
  "    if (window.__cdOnb) return window.__cdOnb.verifyCopy(this.state.data);\n" +
  "    const d = this.state.data;\n" +
  "    return { q:'Confirm your mobile.', help:'We\\u2019ve texted a 6-digit code to ' + (d.phone || 'your mobile') + '.',\n" +
  "             resend:'No text yet?', fixLead:'Wrong number?', fixTail:'\\u2014 you\\u2019ll need this number every time you sign in.' };\n" +
  "  }\n\n" +
  "  meta(i, d, j, home, selCcy) {",
);
patch(
  "the resend prompt on the verify screen",
  '<span style="font-size: 12.5px; color: var(--mute);">No text yet?</span>',
  '<span style="font-size: 12.5px; color: {{ verifyNoteColor }};">{{ verifyResend }}</span>',
);
patch(
  "the 'wrong number' footnote on the verify screen",
  "<span>Wrong number? <button sc-camel-on-click=\"{{ onFixPhone }}\"",
  "<span>{{ verifyFixLead }} <button sc-camel-on-click=\"{{ onFixPhone }}\"",
);
patch(
  "the tail of the 'wrong number' footnote",
  "Go back and change it</button> — you'll need this number every time you sign in.</span>",
  "Go back and change it</button> {{ verifyFixTail }}</span>",
);

/* --- 7. The code is checked against the server, and resending
         actually re-sends ------------------------------------------- */
patch(
  "the verify screen's bindings",
  "code: d.code, onCode: (e) => this.onCode(e), onResend: () => this.set('code', ''),",
  "code: d.code, onCode: (e) => this.onCode(e),\n" +
  "      onResend: () => { this.set('code', ''); if (window.__cdOnb) window.__cdOnb.sendCode(this.state.data).then(() => this.forceUpdate()); },\n" +
  "      verifyResend: (window.__cdOnb && window.__cdOnb.err) ? window.__cdOnb.err : this.vCopy().resend,\n" +
  "      verifyNoteColor: (window.__cdOnb && window.__cdOnb.err) ? '#b3261e' : 'var(--mute)',\n" +
  "      verifyFixLead: this.vCopy().fixLead, verifyFixTail: this.vCopy().fixTail,",
);
patch(
  "onCode — a typed code would advance without ever being checked",
  "onCode(e) { const v = e.target.value.replace(/\\D/g, '').slice(0, 6); this.set('code', v); if (v.length === 6) setTimeout(() => this.next(), 420); }",
  "onCode(e) {\n" +
  "    const v = e.target.value.replace(/\\D/g, '').slice(0, 6);\n" +
  "    this.set('code', v);\n" +
  "    if (v.length !== 6) return;\n" +
  "    if (!window.__cdOnb || !window.__cdOnb.code) { setTimeout(() => this.next(), 420); return; }\n" +
  "    window.__cdOnb.checkCode(v).then((ok) => { if (ok) this.next(); else this.set('code', ''); });\n" +
  "  }",
);

/* --- 7b. A name in the browser tab --------------------------------
   The loader replaces the whole document with the design's own, so a
   <title> on the outer wrapper is gone by the time anybody sees the tab.
   It has to go in the design's head. */
patch(
  "the design's <head> — the served page would have a blank browser tab",
  '<html><head>\n<meta charset="utf-8">',
  '<html><head>\n<meta charset="utf-8">\n<title>Set up your desk — CurrencyDesk</title>',
);

/* --- 7c. The password does not travel, and the flow has to say so -
   We deliberately never store it, so somebody who sets it on the shop
   laptop and finishes on their phone arrives at the last screen with
   nothing to open the desk with. Failing there, under a button, is the
   wrong place to find out: send them back to the screen that can fix
   it, and say why when they get there. */
patch(
  "the account screen's subtitle — nowhere to explain a password that did not travel",
  "eyebrow:'Your account', q:'Set up the owner login.', help:'Everything below this account answers to it.",
  "eyebrow:'Your account', q:'Set up the owner login.', help:((window.__cdOnb && window.__cdOnb.passNote) ? window.__cdOnb.passNote + ' ' : '') + 'Everything below this account answers to it.",
);

/* --- 8. Going live creates the desk -------------------------------
   In the prototype this sets a flag and slides to the last screen. */
patch(
  "goLive — the last screen would say 'you're live' without creating anything",
  "goLive() { if (this._payValid) { this.setState({ paid: true, landKey: this.state.landKey + 1 }); setTimeout(() => this.setState(s => ({ i: 16 })), 1000); } }",
  "goLive() {\n" +
  "    if (!this._payValid || this._launching) return;\n" +
  "    if ((this.state.data.ownerPass || '').length < 6) {\n" +
  "      if (window.__cdOnb) window.__cdOnb.passNote = 'Set your password once more \\u2014 we never store it, so it doesn\\u2019t follow you between devices.';\n" +
  "      this.go(5);\n" +
  "      return;\n" +
  "    }\n" +
  "    if (window.__cdOnb) window.__cdOnb.passNote = '';\n" +
  "    const done = () => { this.setState({ paid: true, landKey: this.state.landKey + 1 }); setTimeout(() => this.setState(s => ({ i: 16 })), 1000); };\n" +
  "    if (!window.__cdOnb || !window.__cdOnb.code) { done(); return; }\n" +
  "    this._launching = true;\n" +
  "    window.__cdOnb.launch(this.state.data).then((r) => {\n" +
  "      this._launching = false;\n" +
  "      if (r && r.ok) done(); else this.forceUpdate();\n" +
  "    });\n" +
  "  }",
);
patch(
  "the line under the go-live button — nowhere to say why it failed",
  "R.goLiveSub = (pOk ?",
  "R.goLiveSub = (window.__cdOnb && window.__cdOnb.err) ? window.__cdOnb.err : (pOk ?",
);

/* ------------------------------------------------------------------
   Put it back. The "</" escaping is the bundler's, and reproducing it is
   not optional: without it the page truncates at the design's own
   closing script tag.
   ------------------------------------------------------------------ */
const reserialized = JSON.stringify(out()).replace(/<\//g, "<\\u002F");
if (reserialized.includes("</script")) throw new Error("onboarding: re-serialized template would close its own script tag");

let page = html.slice(0, openAt + OPEN.length) + reserialized + html.slice(closeAt);

const bodyAt = page.indexOf("<body");
if (bodyAt < 0) throw new Error("onboarding: no <body> to place the bridge in");
const bodyEnd = page.indexOf(">", bodyAt) + 1;
page = page.slice(0, bodyEnd) + "\n" + BRIDGE + page.slice(bodyEnd);

if (!page.includes("<title>Bundled Page</title>")) throw new Error("onboarding: the bundle's title is no longer 'Bundled Page'");
page = page
  .replace("<title>Bundled Page</title>", "<title>Set up your desk — CurrencyDesk</title>")
  .replace("</head>", '<meta name="robots" content="noindex,follow">\n</head>');

writeFileSync(OUT, page);
console.log(`built web/onboarding.html  (${Math.round(page.length / 1024)} kB) from the design`);
console.log(`  ${applied.length} anchors matched and patched:`);
for (const a of applied) console.log(`    · ${a}`);
