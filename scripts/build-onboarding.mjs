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

    /* Which codes the server has confirmed, and which it has denied. The
       design's own check was a shape check — CD- and six characters — which
       every invented string passes. A wizard whose first screen can be walked
       by anybody who guesses the format is not gated at all, so the gate is
       the server: a code opens this only if it belongs to an application we
       actually invited. */
    known: {},
    checking: "",

    refValid: function (v) {
      var code = String(v || "").toUpperCase().trim();
      return REF.test(code) && CD.known[code] === true;
    },
    /* What screen 0 should be saying right now: nothing yet, we're asking,
       we don't know it, or it's theirs. */
    refState: function (v) {
      var code = String(v || "").toUpperCase().trim();
      if (!REF.test(code)) return "empty";
      if (CD.known[code] === true) return "ok";
      if (CD.known[code] === false) return "no";
      return CD.checking === code ? "checking" : "empty";
    },
    /* Debounced, because this fires as they type and a wrong answer counts
       against the miss limit. Cached, so re-checking a code we already have
       an answer for costs nothing. */
    checkRef: function (v, done) {
      var code = String(v || "").toUpperCase().trim();
      clearTimeout(CD._rt);
      if (!REF.test(code) || code in CD.known) return;
      CD._rt = setTimeout(function () {
        if (code in CD.known) return;
        CD.checking = code;
        done();
        fetch("/api/onboarding/" + encodeURIComponent(code) + "/state")
          .then(function (r) {
            CD.known[code] = r.ok;
            CD.checking = "";
            /* Their code, typed rather than followed. Send them to the same
               address the email would have, so the rest of this — hydrating
               their answers, saving, launching — is one path, not two. */
            if (r.ok && code !== CD.code) { location.href = "/onboarding/" + encodeURIComponent(code); return; }
            done();
          })
          .catch(function () { CD.checking = ""; done(); });
      }, 450);
    },
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

  /* ----------------------------------------------------------------
     Address lookup.

     Attached from out here rather than built into the design, for the
     same reason the save hook is: the bundle re-renders itself and a
     dropdown living inside its tree would be torn down every keystroke.
     This one hangs off document.body and follows the input.

     The whole thing is inert unless the server says Google is
     configured. Nothing appears, nothing is asked for, and the address
     is typed by hand exactly as it is today.
     ---------------------------------------------------------------- */
  function address() {
    var box = null, list = [], sel = -1, input = null, token = "", live = null, t, filling = false;

    var newToken = function () {
      token = "cd-" + Math.abs(Date.now() ^ (performance.now() * 1000 | 0)).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    };
    newToken();

    /* The design's inputs are React-controlled, so assigning .value is
       overwritten on the next render. Go through the native setter and
       let React hear the event, the way a keystroke would. */
    function setField(k, v) {
      var el = document.querySelector('input[data-k="' + k + '"]');
      if (!el || !v) return;
      var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      d.set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    /* Empty it, not just hide it. A hidden node is still a node: leave the
       options in place and a screen reader keeps offering addresses that are
       no longer on the screen. */
    function hide() { if (box) { box.style.display = "none"; box.innerHTML = ""; } sel = -1; }

    function place() {
      if (!box || !input) return;
      var r = input.getBoundingClientRect();
      box.style.left = (r.left + window.scrollX) + "px";
      box.style.top = (r.bottom + window.scrollY + 6) + "px";
      box.style.width = r.width + "px";
    }

    function paint() {
      if (!box) return;
      if (!list.length) return hide();
      box.innerHTML = "";
      list.forEach(function (s, i) {
        var row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === sel ? "true" : "false");
        row.style.cssText =
          "display:block;width:100%;text-align:left;padding:10px 13px;border:0;border-bottom:1px solid rgba(23,20,15,.07);" +
          "background:" + (i === sel ? "rgba(29,107,69,.09)" : "transparent") + ";cursor:pointer;font-family:inherit;color:#17140f;";
        row.innerHTML =
          '<span style="display:block;font-size:14px;font-weight:600">' + esc(s.primary) + "</span>" +
          '<span style="display:block;font-size:12px;color:#6e675b;margin-top:1px">' + esc(s.secondary) + "</span>";
        row.addEventListener("mousedown", function (e) { e.preventDefault(); choose(i); });
        row.addEventListener("mouseenter", function () { sel = i; paint(); });
        box.appendChild(row);
      });
      box.style.display = "block";
      place();
    }

    function esc(s) {
      return String(s || "").replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }

    function choose(i) {
      var s = list[i];
      if (!s) return;
      hide();
      list = [];
      fetch("/api/onboarding/" + encodeURIComponent(CD.code) + "/places/details?id=" +
            encodeURIComponent(s.id) + "&s=" + encodeURIComponent(token))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var a = j && j.address;
          /* Filling the street box dispatches the same event a keystroke
             does — which is the point, it is how React hears us — so the
             lookup would fire again on the address we just chose and open
             the dropdown right back up underneath them. */
          filling = true;
          if (!a) { setField("street", s.primary); }
          else {
            setField("street", a.street || s.primary);
            setField("city", a.city);
            setField("region", a.region);
            setField("postal", a.postal);
            setField("country_addr", a.country);
          }
          setTimeout(function () { filling = false; }, 0);
          clearTimeout(t);
          hide();
          if (!a) return;
          newToken();   // that session is spent
          var city = document.querySelector('input[data-k="city"]');
          if (city && !a.city) city.focus();
        })
        .catch(function () { setField("street", s.primary); });
    }

    function ask(q) {
      clearTimeout(t);
      if (CD.places === false || !CD.code) return;
      if (q.trim().length < 3) { list = []; hide(); return; }
      t = setTimeout(function () {
        var country = "";
        try { country = (JSON.parse(localStorage.getItem(KEY)).data.country || ""); } catch (e) {}
        fetch("/api/onboarding/" + encodeURIComponent(CD.code) + "/places/suggest?q=" +
              encodeURIComponent(q) + "&country=" + encodeURIComponent(country) + "&s=" + encodeURIComponent(token))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j) return;
            if (j.enabled === false) { CD.places = false; return; }   // stop asking
            CD.places = true;
            list = j.suggestions || [];
            sel = -1;
            paint();
          })
          .catch(function () {});
      }, 220);
    }

    function attach(el) {
      if (!el || el === input) return;
      input = el;
      if (!box) {
        box = document.createElement("div");
        box.setAttribute("role", "listbox");
        box.style.cssText =
          "position:absolute;z-index:99999;display:none;background:#fff;border:1px solid rgba(23,20,15,.14);" +
          "border-radius:12px;overflow:hidden;box-shadow:0 18px 40px -16px rgba(23,20,15,.4);max-height:264px;overflow-y:auto;";
        document.body.appendChild(box);
        addEventListener("resize", place, true);
        addEventListener("scroll", place, true);
      }
      el.addEventListener("input", function (e) { if (!filling) ask(e.target.value); });
      el.addEventListener("blur", function () { setTimeout(hide, 160); });
      el.addEventListener("keydown", function (e) {
        if (box.style.display !== "block" || !list.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % list.length; paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + list.length) % list.length; paint(); }
        else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); e.stopPropagation(); choose(sel); }
        else if (e.key === "Escape") { hide(); }
      }, true);
    }

    /* The address screen comes and goes as they move through the flow. */
    live = new MutationObserver(function () {
      var el = document.querySelector('input[data-k="street"]');
      if (el) attach(el);
      else if (input) { input = null; hide(); }
    });
    addEventListener("DOMContentLoaded", function () {
      live.observe(document.body, { childList: true, subtree: true });
      var el = document.querySelector('input[data-k="street"]');
      if (el) attach(el);
    });
  }
  address();

  /* The press. A rule rather than style-hover, because the design's runtime
     has no notion of :active and being able to see the button go down under
     your finger is most of what "responsive" means on a touchscreen.

     prefers-reduced-motion is honoured: somebody who has asked their
     machine to stop moving things has asked us too. */
  (function () {
    var css = document.createElement("style");
    css.textContent =
      'button[style*="--cd-cta"]:hover{transform:translateY(-1px);box-shadow:0 12px 26px -8px rgba(29,107,69,0.55)}' +
      'button[style*="--cd-cta"]:active{transform:translateY(1px) scale(0.995);box-shadow:0 4px 12px -6px rgba(29,107,69,0.5)}' +
      'button[style*="--cd-cta"]:focus-visible{outline:2px solid #1D6B45;outline-offset:3px}' +
      '@media (prefers-reduced-motion: reduce){button[style*="--cd-cta"]{transition:none}' +
      'button[style*="--cd-cta"]:hover,button[style*="--cd-cta"]:active{transform:none}}';
    document.head.appendChild(css);
  })();

  // before the bundle runs, so the first paint is already their desk
  if (CD.code) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/onboarding/" + encodeURIComponent(CD.code) + "/state", false);
      xhr.send();
      if (xhr.status === 200) {
        var s = JSON.parse(xhr.responseText);
        CD.known[CD.code] = true;   // followed from the email: already proven
        CD.application = s.application || null;
        if (s.verify) CD.verify = s.verify;
        var data = s.data || {};
        /* They followed a link that already carries the code. Making them
           read it off the email and type it back is the flow admitting it
           wasn't listening. */
        if (!data.cdId) data.cdId = CD.code;
        /* THE LINK OPENS AT THE BEGINNING, NOT WHERE THEY STOPPED.

           s.at is the screen they last saved on, and restoring it meant
           the button in the invitation — "Set up your desk, takes about
           ten minutes" — dropped somebody straight onto "Confirm your
           email" with no idea how they got there and nothing they could
           check. An email that promises a beginning has to open on one.

           Their answers are still here, so paging forward through what
           they already filled in is quick and, more to the point,
           possible: before this there was no way back to look at what you
           had typed. */
        localStorage.setItem(KEY, JSON.stringify({ i: 0, data: data }));
      } else if (xhr.status === 404) {
        CD.known[CD.code] = false;
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

/* The exported design is a customer-facing order summary, so it must never
   diverge from Stripe's catalog. Keep this compatibility patch until the next
   design export carries the $599 Full System price. */
const LEGACY_FULL_SYSTEM_PRICE = "id:'full', name:'Full System', mo:499";
const CURRENT_FULL_SYSTEM_PRICE = "id:'full', name:'Full System', mo:599";
if (!design.includes(LEGACY_FULL_SYSTEM_PRICE) && !design.includes(CURRENT_FULL_SYSTEM_PRICE)) {
  throw new Error("onboarding: Full System plan price anchor not found — verify the public price before building");
}
design = design.replace(LEGACY_FULL_SYSTEM_PRICE, CURRENT_FULL_SYSTEM_PRICE);

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
  "the code input — it would break CD-A3V5ZE into CD-A3V5-ZE, and never ask whether the code is real",
  "onCdId: (e) => this.set('cdId', this.fmtCdId(e.target.value)),",
  "onCdId: (e) => {\n" +
  "        if (!window.__cdOnb) { this.set('cdId', this.fmtCdId(e.target.value)); return; }\n" +
  "        const v = window.__cdOnb.fmtRef(e.target.value);\n" +
  "        this.set('cdId', v);\n" +
  "        window.__cdOnb.checkRef(v, () => this.forceUpdate());\n" +
  "      },",
);

/* --- 3b. Say what the server said ---------------------------------
   The badge read "Recognised" the moment the shape was right, which was
   the lie underneath the hole: it claimed recognition for a code nobody
   had looked up. */
patch(
  "the code badge — it claimed 'Recognised' for anything shaped like a code",
  "cdIdBadge: this.cdIdValid(d.cdId) ? 'Recognised' : 'From your invite email',",
  "cdIdBadge: (() => { const s = window.__cdOnb ? window.__cdOnb.refState(d.cdId) : (this.cdIdValid(d.cdId) ? 'ok' : 'empty');\n" +
  "        return s === 'ok' ? 'Recognised' : s === 'checking' ? 'Checking\\u2026' : s === 'no' ? 'Not recognised' : 'From your invite email'; })(),",
);
patch(
  "the code hint — it told somebody their invented code was theirs to keep",
  "cdIdHint: this.cdIdValid(d.cdId)\n        ? 'This is how you\\u2019ll sign in from now on. It stays yours.'\n        : 'We emailed it to you when you were approved. Can\\u2019t find it? Search your inbox for CurrencyDesk.',",
  "cdIdHint: (() => { const s = window.__cdOnb ? window.__cdOnb.refState(d.cdId) : (this.cdIdValid(d.cdId) ? 'ok' : 'empty');\n" +
  "        if (s === 'ok') return 'This is how you\\u2019ll sign in from now on. It stays yours.';\n" +
  "        if (s === 'checking') return 'Just checking that one\\u2026';\n" +
  "        if (s === 'no') return 'We don\\u2019t have that ID. Check the email we sent you \\u2014 or reply to it and we\\u2019ll look you up.';\n" +
  "        return 'We emailed it to you when you were approved. Can\\u2019t find it? Search your inbox for CurrencyDesk.'; })(),",
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

/* --- 6b. The main button acknowledges being pressed ----------------

   It had a transition declared and nothing to transition: hover changed
   the colour and that was the whole of it, so on a sixteen-screen flow the
   one control you press sixteen times felt dead under the cursor.

   The marker is a custom property rather than a class because the bundle
   re-renders on every keystroke and would strip a class straight back off;
   the inline style survives, so the rule below has something stable to
   hang on. --cd-cta does nothing on its own — it exists to be selected. */
patch(
  "a marker on the primary CTA, so it can be given a press",
  "cursor:pointer;box-shadow:0 8px 20px -6px rgba(29,107,69,0.5);transition:transform .1s ease, background .15s;",
  "cursor:pointer;--cd-cta:1;box-shadow:0 8px 20px -6px rgba(29,107,69,0.5);transition:transform .12s cubic-bezier(0.2,0.8,0.2,1), box-shadow .18s ease, background .15s;",
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

/* --- 7d. Make the form fields addressable -------------------------
   The generic field input renders with nothing on it but a placeholder,
   so nothing outside the bundle can find "the street box" except by
   matching English. Carry the design's own field key onto the element
   and address lookup can attach to it by name. */
patch(
  "the generic field input — nothing identifies which field it is",
  '<input style="{{ f.style }}" style-focus="border-color: var(--primary); box-shadow: 0 0 0 4px rgba(29,107,69,0.14); background: #fff;" type="{{ f.type }}" value="{{ f.value }}" sc-camel-on-change="{{ f.onChange }}" placeholder="{{ f.ph }}" data-focus="{{ f.focus }}">',
  '<input data-k="{{ f.k }}" autocomplete="{{ f.ac }}" style="{{ f.style }}" style-focus="border-color: var(--primary); box-shadow: 0 0 0 4px rgba(29,107,69,0.14); background: #fff;" type="{{ f.type }}" value="{{ f.value }}" sc-camel-on-change="{{ f.onChange }}" placeholder="{{ f.ph }}" data-focus="{{ f.focus }}">',
);
patch(
  "the field mapping — the key never reaches the element",
  "value: d[f.key] || '', ph: f.ph || '', focus: f.focus ? 'true' : undefined,",
  "value: d[f.key] || '', ph: f.ph || '', focus: f.focus ? 'true' : undefined, k: f.key,\n" +
  "        /* Let the browser's own address fill help too. Ours only works\n" +
  "           where Google does; theirs already knows this person. */\n" +
  "        ac: ({ street:'address-line1', city:'address-level2', region:'address-level1', postal:'postal-code',\n" +
  "              country_addr:'country-name', ownerName:'name', ownerEmail:'email', phone:'tel' })[f.key] || 'off',",
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

/* --- 9. Never honour a browser-only discount ---------------------
   The exported design contains a prototype code that grants three months
   free entirely in browser state. It has no redemption limit, expiry, Stripe
   record, or invoice audit trail. Stripe Checkout is the only authority for
   a real offer, so this screen must not claim a discount until that hosted
   payment hand-off is wired. */
patch(
  "the browser-only founding code — it would grant a discount without Stripe",
  "const pOk = pCode === 'FOUNDING100';",
  "const pOk = false;",
);
patch(
  "the browser-only promo message — it claimed a three-month offer was applied",
  "R.promoMsg = pOk ? ('\\u2713 ' + pCode + ' applied — your first three months are on us.') : 'That code isn\\u2019t recognised. Check the invite email we sent you.';",
  "R.promoMsg = 'Offers are applied securely at Stripe Checkout.';",
);

/* ------------------------------------------------------------------
   FINISHING THE LOOP.

   The last screen is a real Day-1 checklist — bring your rates across,
   publish them, walk your settings, take your first deal — and every
   one of its buttons pointed at a design document. So the last thing
   that happened to somebody who had just opened a desk was a dead link,
   with the actual desk one URL away and never offered.

   Their session already exists by this point: opening the desk signs
   them in. So these are ordinary links into the running app, and the OS
   picks that session up rather than asking for the password they typed
   ninety seconds ago.
   ------------------------------------------------------------------ */
patch(
  "the Day-1 checklist pointed at design documents instead of the desk",
  "href: 'CurrencyDesk Rate Board.dc.html'",
  "href: '/app'",
  3,
);
patch(
  "the same, for the steps that open the desk itself",
  "href: 'CurrencyDesk Dashboard.dc.html'",
  "href: '/app'",
  3,
);

patch(
  "the last dead link on the Day-1 screen",
  'href="CurrencyDesk Dashboard.dc.html"',
  'href="/app"',
);
patch(
  "\"questions before you sign\" pointed at a design document",
  'href="CurrencyDesk Contact.dc.html"',
  'href="/contact"',
);
patch(
  "\"see what your team sees\" — that is the sign-in screen, and it exists",
  'href="CurrencyDesk Sign Up.dc.html"',
  'href="/login"',
);

patch(
  "the service agreement link — /legal is a real page",
  'href="CurrencyDesk Legal.dc.html"',
  'href="/legal"',
);

/* Two preview links are deliberately left pointing at design documents:
   "CurrencyDesk Rate Page" and "CurrencyDesk Board Display" are pages
   that have not been built as routes yet. Sending a customer to a
   plausible-looking wrong URL is worse than a link that obviously has
   not shipped, so they wait for the real pages. */

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
