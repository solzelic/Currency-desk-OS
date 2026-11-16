/* ============================================================
   Sign-up / onboarding v2.1: the bridge between Sol's frozen prototype
   (design/onboarding/signup-v2.1/) and the real server.

   The prototype draws every screen and keeps every animation. It talks to
   its server through window.__cdOnb, a contract it already had: fmtRef,
   refState, checkRef, sendCode, checkCode, launch. This file is that
   contract, pointed at the v2.1 routes (server/src/routes/signup-*.ts),
   plus the handful of hooks scripts/build-signup.mjs patches in where the
   prototype only pretended (passkey, Google/Microsoft, prices, the card,
   the desk opening). Nothing here decides money, identity or what the
   law says: the server does, and this renders what it answered.

   What never happens here:
     - nothing personal is stored in the browser. The only things kept are
       the typed CurrencyDesk ID, in this tab (sessionStorage), so a reload
       comes back to the same reservation, and while the email code is
       pending a bare "1" beside it, so a reload lands back on Check your
       inbox. Answers live on the server. On staging, Start on Day 1 leaves
       a bare timestamp (cdDayOne) that this page reads once and drops.
     - no card number reaches this page. Stripe Elements draws the card in
       Stripe's own frame; this page only holds the SetupIntent's secret.
     - no success the server did not say. Every screen that sends something
       waits for the answer and shows the server's own reason when it says no.
   ============================================================ */
(function () {
  "use strict";

  var ID = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
  var TAB_KEY = "cdSignupId";
  var INBOX_KEY = "cdSignupInbox";
  var SOUND_KEY = "cdSound";

  /* The screen numbers are the prototype's (its ORDER); the step names are
     the states in reference/tools/capture.cjs, which the server's
     last_step and PUT …/answers use (onboarding/signup-answers.ts). */
  var STEP_OF = {
    17: "01-welcome", 0: "02-id", 20: "03-chapter1", 5: "04-signin", 14: "05-inbox",
    27: "06-pin-intro", 18: "07-pin", 2: "08-shop-name", 3: "09-address", 28: "09-address",
    29: "10-shops", 30: "11-shops-more", 4: "12-registration", 22: "13-money", 6: "14-currencies",
    8: "15-count", 26: "16-online", 23: "17-rules", 9: "18-officer", 10: "19-idline",
    11: "20-team", 31: "21-add-person", 13: "22-confirm", 24: "23-confirmed", 15: "24-pay", 16: "25-day1",
  };
  var SCREEN_OF = {};
  Object.keys(STEP_OF).forEach(function (k) { if (!(STEP_OF[k] in SCREEN_OF)) SCREEN_OF[STEP_OF[k]] = Number(k); });
  SCREEN_OF["09-address"] = 3;
  /* The seed route's step names (capture.cjs `step`): screen and, for the
     three sign-in sub-states, which window was open. */
  var SEED = {
    welcome: [17], id: [0], chapter1: [20], signin: [5], "signin-passkey": [5, "asking"], "signin-google": [5, "sso"],
    "signin-cancelled": [5, "failed"], inbox: [14], "pin-intro": [27], pin: [18], "shop-name": [2], address: [3],
    shops: [29], "shops-more": [30], registration: [4], money: [22], currencies: [6], count: [8], online: [26],
    rules: [23], officer: [9], idline: [10], team: [11], "add-person": [31], confirm: [13], confirmed: [24], pay: [15], day1: [16],
  };
  /* Screens outside the prototype's ORDER, and where its own next() goes
     from each: _after() reads them as ORDER[0] and would open the ID. */
  var NEXT_OF = { 28: 29, 30: 4, 31: 11 };

  /* Staging's Start on Day 1 (os-src/staging-fresh-shop.js) marks this tab
     with a bare timestamp just before it opens /onboarding#day1. The mark is
     read once and dropped on every load, and #day1 counts only with a mark
     under a minute old: a link another site opens has none. */
  var DAY_ONE_KEY = "cdDayOne";
  function dayOneMarked() {
    var raw = null;
    try { raw = sessionStorage.getItem(DAY_ONE_KEY); sessionStorage.removeItem(DAY_ONE_KEY); } catch (e) { return false; }
    var age = Date.now() - Number(raw);
    return /^[0-9]{13}$/.test(String(raw)) && age >= 0 && age < 60000;
  }

  function tabGet() { try { return sessionStorage.getItem(TAB_KEY) || ""; } catch (e) { return ""; } }
  /* Dropping the ID drops the inbox flag with it. */
  function tabSet(v) { try { if (v) sessionStorage.setItem(TAB_KEY, v); else { sessionStorage.removeItem(TAB_KEY); sessionStorage.removeItem(INBOX_KEY); } } catch (e) { /* storage blocked: a reload starts at the ID */ } }
  function inboxSet(on) { try { if (on) sessionStorage.setItem(INBOX_KEY, "1"); else sessionStorage.removeItem(INBOX_KEY); } catch (e) { /* storage blocked: a reload starts at the ID */ } }
  function inboxGet() { try { return sessionStorage.getItem(INBOX_KEY) === "1"; } catch (e) { return false; } }

  function call(method, path, body, ms) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 20000) : null;
    return fetch(path, {
      method: method, credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("invalid response");
        return { status: r.status, body: j };
      });
    }).catch(function () {
      return { status: 0, body: { error: "network", detail: NET } };
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function api(method, suffix, body, ms) {
    return call(method, "/api/onboarding/" + encodeURIComponent(CD.code || "") + suffix, body, ms);
  }
  var NET = "We couldn’t reach CurrencyDesk just now. Check your connection and try again.";
  function why(r, fallback) { return (r && r.body && typeof r.body.detail === "string" && r.body.detail) || fallback; }
  /* A sign-in refused because the email code already passed, in a browser
     holding no enrolment for it (another browser, or one idle for a day).
     That enrolment is the only way back until the Sign-in pack (CD-221)
     adds one, so say where it is rather than "carry on" from nowhere. */
  var SET_ELSEWHERE = "Your sign-in is already set in the browser where you chose it. Open this page there, within a day of your last step, and type your ID to carry on. Signing in from another browser isn’t ready yet.";
  function refused(r, fallback) { return r && r.body && r.body.error === "already_verified" ? SET_ELSEWHERE : why(r, fallback); }

  var CD = window.__cdOnb = {
    code: "",
    known: {},
    names: {},
    states: {},
    /* what GET /state said this browser's enrolment is, per ID ("" for none) */
    signups: {},
    checking: "",
    throttled: false,
    err: "",
    passNote: "",
    verify: { channel: "email", sentTo: "", code: "" },
    launched: false,
    resume: null,
    pkAvailable: null,
    prices: null,
    pack: null,
    muted: false,
    comp: null,

    /* ---- the ID (screen 2) --------------------------------------------- */
    fmtRef: function (v) {
      /* lowercase, spaces, missing or typographic hyphens are all fine:
         "cdyork7k42" reads as CD-YORK-7K42 */
      var all = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if ("CD".indexOf(all) === 0) return all;
      var raw = all.replace(/^CD/, "").slice(0, 8);
      return raw ? "CD-" + raw.slice(0, 4) + (raw.length > 4 ? "-" + raw.slice(4) : "") : "";
    },
    refValid: function (v) { var id = String(v || "").toUpperCase(); return ID.test(id) && CD.known[id] === true; },
    refState: function (v) {
      var id = String(v || "").toUpperCase();
      if (!ID.test(id)) return "empty";
      if (CD.known[id] === true) return "ok";
      if (CD.throttled) return "slow";
      if (CD.known[id] === false) return "no";
      return CD.checking === id ? "checking" : "empty";
    },
    /* Only a whole, well-shaped ID is ever asked about: part of one, while
       it is being typed, goes nowhere. The answer is the shop's name and
       nothing else (SIGNUP-LOGIC §2.1). A 429 is the server's throttle,
       never "we don't know it". */
    checkRef: function (v, done) {
      var id = String(v || "").toUpperCase();
      clearTimeout(CD._rt);
      var request = CD._refRequest = (CD._refRequest || 0) + 1;
      CD.checking = ""; CD.throttled = false; CD.err = "";
      if (CD.code && CD.code !== id) {
        CD.navigation(); CD.pack = null; CD.pinSet = false; CD._resumeTo = null;
        CD.prices = null; CD._priceFailed = false; CD._cardKey = null; CD.cardComplete = false; CD._staging = false; CD._paying = false;
        CD.callPreference = null; CD._consentBusy = false; CD.consentError = ""; CD._openStalled = null;
        if (CD.comp && CD.comp.fresh) CD.comp.setState({ data: Object.assign(CD.comp.fresh(), { cdId: id }) });
      }
      CD.code = ""; CD.alreadyOpen = false; CD.verify.code = ""; tabSet("");
      if (CD.comp) CD.comp.set("operatingName", "");
      function select() {
        CD.code = id; CD.alreadyOpen = CD.states[id] === "active"; CD.verify.code = ""; tabSet(id);
        if (CD.comp) CD.comp.set("operatingName", CD.names[id] || "");
      }
      if (!ID.test(id)) return;
      if (CD.known[id] === true) { select(); return; }
      if (CD.known[id] === false) return;
      CD._rt = setTimeout(function () {
        CD.checking = id; done();
        call("GET", "/api/onboarding/" + encodeURIComponent(id) + "/state").then(function (r) {
          if (request !== CD._refRequest) return;
          CD.checking = "";
          if (r.status === 429) { CD.throttled = true; done(); return; }
          if (r.status === 200 && r.body.valid) {
            CD.known[id] = true; CD.names[id] = String(r.body.operatingName || "");
            CD.states[id] = r.body.state; CD.signups[id] = typeof r.body.signup === "string" ? r.body.signup : ""; select();
          } else if (r.status === 404) CD.known[id] = false;
          else CD.err = NET;
          done();
        });
      }, 450);
    },
    resendId: function (email) {
      /* always 202 whatever the email; a failure here is the network */
      return call("POST", "/api/onboarding/resend-id", { email: email }).then(function (r) { return r.status === 202; });
    },

    /* ---- the credential (screen 4) --------------------------------------- */
    passkey: function (c) {
      c.setState({ pkPhase: "asking", lockErr: "" });
      var fail = function (msg) { c.setState({ pkPhase: "idle", pkScan: false, lockErr: msg }); };
      var cancelled = "The passkey wasn’t created. Nothing was saved. Try again, or choose another way.";
      api("POST", "/passkey/options", {}).then(function (r) {
        if (r.status !== 200 || !r.body.options) return fail(refused(r, cancelled));
        var o = r.body.options;
        var pub = {
          rp: o.rp, challenge: b64d(o.challenge),
          user: { id: b64d(o.user.id), name: o.user.name, displayName: o.user.displayName },
          pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: o.attestation || "none",
          authenticatorSelection: o.authenticatorSelection,
          excludeCredentials: (o.excludeCredentials || []).map(function (x) { return { id: b64d(x.id), type: x.type, transports: x.transports }; }),
        };
        return navigator.credentials.create({ publicKey: pub }).then(function (cred) {
          var res = cred.response;
          var body = {
            response: {
              id: cred.id, rawId: b64e(cred.rawId), type: cred.type,
              response: {
                clientDataJSON: b64e(res.clientDataJSON), attestationObject: b64e(res.attestationObject),
                transports: typeof res.getTransports === "function" ? res.getTransports() : undefined,
              },
              clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
              authenticatorAttachment: cred.authenticatorAttachment || undefined,
            },
            deviceLabel: c.deviceInfo().device,
          };
          var id = CD.code;
          return api("POST", "/passkey/verify", body).then(function (v) {
            if (v.status !== 200 || !v.body.ok) return fail(refused(v, cancelled));
            CD.codeSent = v.body.codeSent !== false; CD.stagingCode(v.body, id); CD.awaitingCode(id);
            c.setState({ pkScan: "ok" });
            setTimeout(function () { c.setState({ pkPhase: "done", pkScan: false }); c.set("passkeyDone", true);
              setTimeout(function () { if (c.state.i === 5) c.next(); }, 900); }, 400);
          });
        }, function () { fail(cancelled); });
      });
    },
    sso: function (c, prov) {
      var label = prov === "google" ? "Google" : "Microsoft";
      c.setState({ ssoPhase: "busy", ssoProv: prov, lockErr: "" });
      var fail = function (msg) { c.setState({ ssoPhase: "idle", lockErr: msg }); };
      var closed = "You closed the " + label + " window. Nothing was linked. Try again, or choose another way.";
      /* The window opens on the click, before the server answers, or the
         browser calls it a popup nobody asked for. On a phone the page
         itself goes to the provider and comes back (sso-return below). */
      var phone = window.innerWidth < 720;
      var win = phone ? null : window.open("about:blank", "cd-sso", "width=480,height=640");
      api("GET", "/sso/" + prov + "/start").then(function (r) {
        if (r.status !== 200 || !r.body.url) { if (win) win.close(); return fail(refused(r, "That way in isn’t available yet. Choose another.")); }
        try { sessionStorage.setItem("cdSsoReturn", JSON.stringify({ id: CD.code, provider: prov })); } catch (e) { /* no return trip on a phone without storage */ }
        if (!win) { location.assign(r.body.url); return; }
        win.location = r.body.url;
        var watch = setInterval(function () { if (win.closed) { clearInterval(watch); if (c.state.ssoPhase === "busy" && !CD._ssoGot) fail(closed); } }, 500);
        CD._ssoGot = false;
        CD._ssoWait = function (code, state) { CD._ssoGot = true; clearInterval(watch); CD.ssoFinish(c, prov, code, state); };
      });
    },
    ssoFinish: function (c, prov, code, state) {
      var label = prov === "google" ? "Google" : "Microsoft", id = CD.code;
      api("POST", "/sso/callback", { provider: prov, code: code, state: state }).then(function (r) {
        if (r.status !== 200 || !r.body.ok) {
          c.setState({ ssoPhase: "idle", lockErr: refused(r, "That " + label + " sign-in didn’t finish. Nothing was saved. Try again, or choose another way.") });
          return;
        }
        CD.codeSent = r.body.codeSent !== false; CD.stagingCode(r.body, id); CD.awaitingCode(id);
        c.setState({ ssoPhase: "idle" }); c.set("lockMode", prov); c.set("ssoDone", prov);
        setTimeout(function () { if (c.state.i === 5) c.next(); }, 900);
      });
    },
    password: function (c) {
      var d = c.state.data, id = CD.code;
      return api("POST", "/password", { password: d.ownerPass || "", confirm: d.pass2 || "" }).then(function (r) {
        if (r.status === 200 && r.body.ok) { CD.codeSent = r.body.codeSent !== false; CD.stagingCode(r.body, id); CD.awaitingCode(id); c.set("ownerPass", ""); c.set("pass2", ""); return true; }
        c.setState({ lockErr: refused(r, "That password wasn’t saved. Try again.") });
        return false;
      });
    },

    /* ---- the inbox (screen 5) -------------------------------------------- */
    verifyCopy: function () {
      return { q: "Check your inbox.", help: "We just sent a 6-digit code to the email you applied with. This is the address we write to.",
        resend: "No email yet?", fixLead: "Wrong address?", fixTail: " — you’ll need this address every time you sign in." };
    },
    /* The staging door's synthetic shop has no inbox: the server hands its
       code to this browser alone, and the frozen "Staging code" row shows it
       (it hides "Send it again" while it does). Never kept; a late reply for
       another ID is dropped. Any other reservation never gets one. */
    stagingCode: function (body, id) {
      if (CD.code !== id) return;
      CD.verify.code = body && typeof body.stagingCode === "string" && /^[0-9]{6}$/.test(body.stagingCode) ? body.stagingCode : "";
    },
    /* A candidate credential is saved and its code is on the way. */
    awaitingCode: function (id) { if (CD.code === id) inboxSet(true); },
    /* "Send it again" only. The first code went when the credential saved. */
    sendCode: function () {
      CD.err = "";
      var id = CD.code;
      return api("POST", "/email/send", {}).then(function (r) {
        if (r.status === 200 && r.body.ok !== false) { CD.stagingCode(r.body, id); return true; }
        CD.err = why(r, "We couldn’t send that code just now.");
        return false;
      });
    },
    checkCode: function (entered) {
      CD.err = "";
      var id = CD.code;
      return api("POST", "/email/verify", { code: entered }).then(function (r) {
        if (r.status === 200 && r.body.ok !== false) {
          if (CD.code === id) { CD.verify.code = ""; CD.signups[id] = "verified"; inboxSet(false); }
          return CD.loadResume(true).then(function () { return true; });
        }
        /* a spent or lapsed staging code: bring "Send it again" back */
        if (CD.code === id && /^(expired|too_many_attempts|no_code|no_candidate|not_enrolling)$/.test(String(r.body.error || ""))) CD.verify.code = "";
        CD.err = why(r, r.status === 0 ? NET : "That code isn’t right.");
        return false;
      });
    },

    /* ---- after the code: the server's copy of everything ------------------ */
    /* true once the answers are in; false if this tab moved on meanwhile;
       otherwise the server's refusal, for a caller that has to say why */
    loadResume: function (fresh) {
      var id = CD.code, nav = CD._nav || 0;
      return api("GET", "/resume").then(function (r) {
        if (CD.code !== id || (CD._nav || 0) !== nav) return false;
        if (r.status !== 200) return r;
        var c = CD.comp, b = r.body;
        CD.pack = b.pack || null;
        CD.applyPack(c, CD.pack);
        var you = b.you || {};
        var data = CD.fromServer ? CD.fromServer(b.answers || {}) : {};
        data.ownerName = you.name || ""; data.ownerEmail = you.email || ""; data.phone = you.mobile || "";
        data.cdId = CD.code;
        /* the reserved address heads the Confirm record (the prototype's R.recDesk) */
        data.workspace = typeof b.workspace === "string" ? b.workspace : "";
        CD.callPreference = b.callPreference || null; data.call = !!(CD.callPreference && CD.callPreference.call);
        if (CD.pack) data.country = CD.pack.code;
        var modes = {};
        Object.keys((b.answers || {}).count || {}).forEach(function (cc) { modes[cc] = b.answers.count[cc].mode; });
        CD.pinSet = !!b.pinSet;
        return new Promise(function (resolve) { c.setState(function (s) { return { data: Object.assign({}, s.data, data), cntMode: modes }; }, function () {
          var to = SCREEN_OF[b.lastStep];
          if (to != null && b.saved && b.lastStep !== "22-confirm") to = NEXT_OF[to] != null ? NEXT_OF[to] : c._after(to);
          if (to != null) CD._resumeTo = fresh ? to : null;
          if (!fresh && to != null) { c._dir = 1; c.setState({ i: to }); }
          resolve(true);
        }); });
      });
    },
    applyPack: function (c, p) {
      if (!c || !p) return;
      var j = c.JURIS.find(function (x) { return x.id === p.code; }) || c.JURIS.find(function (x) { return x.id === "XX"; });
      if (!j) return;
      /* the pack is the server's; the frozen copy (law rows) stays the
         prototype's own words until Compliance clears the pack's */
      j.reg = p.regulator; j.regLabel = p.registration.label;
      if (p.registration.placeholder) j.ph = p.registration.placeholder;
      j.hint = p.registration.hint; j.home = p.homeCurrency; j.thc = p.idLine.currency;
      if (p.idLine.legal != null) j.idLine = p.idLine.legal;
      if (p.idLine.recommended != null) j.idRecommended = p.idLine.recommended;
      if (p.billingCurrency) c.PRICE_CCY = p.billingCurrency;
    },

    /* ---- Continue on each screen (patched into the prototype's next()) --- */
    beforeNext: function (c) {
      var i = c.state.i, d = c.state.data;
      if (CD._pass === i) { CD._pass = null; return true; }
      if (CD.seeded) return true;
      if (CD._busy) return false;
      var id = CD.code, nav = CD._nav || 0;
      var current = function () { return c.state.i === i && CD.code === id && (CD._nav || 0) === nav; };
      var go = function () { CD._busy = false; if (!current()) return; CD._pass = i; c.next(); };
      var stop = function (msg) { CD._busy = false; if (current()) { CD.err = msg || ""; c.forceUpdate(); } };
      if (i === 0) {
        var held = CD.signups[id];
        /* an open desk whose opening hand-off this browser still holds:
           POST /open gives the desk session; sign in only if it says no */
        if (CD.alreadyOpen && held && CD.resumePayment) { CD.resumePayment(c, true); return false; }
        if (CD.alreadyOpen) { CD.err = "This desk is already open. Sign in."; location.assign("/login"); return false; }
        /* this browser's enrolment (the code passed in another tab): carry
           on where they stopped; if it lapsed meanwhile, chapter 1 as before */
        if (held) {
          CD._busy = true;
          CD.loadResume(false).then(function (res) {
            CD._busy = false;
            if (res === true || !current()) return;
            if (res && res.status === 401) { CD.signups[id] = ""; go(); return; }
            stop(why(res, NET));
          });
          return false;
        }
        return true;
      }
      if (i === 5) {
        if (d.lockMode !== "password") return true;
        CD._busy = true;
        CD.password(c).then(function (ok) { if (ok) go(); else stop(""); });
        return false;
      }
      if (i === 14) {
        if (CD._resumeTo != null && CD._resumeTo !== 27) { var to = CD._resumeTo; CD._resumeTo = null; c._dir = 1; c.setState({ i: to }); return false; }
        return true;
      }
      if (i === 18) {
        CD._busy = true;
        api("POST", "/pin", { pin: d.pin, confirm: d.pin2 }).then(function (r) {
          if (r.status === 200) return go();
          if (!current()) { CD._busy = false; return; }
          CD._busy = false;
          if (r.status === 401) return CD.signInAgain(c, why(r));
          c._pinFail(why(r, r.status === 0 ? NET : "That PIN wasn’t saved. Try again."));
        });
        return false;
      }
      if (CD.chapterNext) return CD.chapterNext(c, go, stop);
      return true;
    },
    /* Skip links ("I'll add this later" and the like): chapters decide (signup-v2.1-chapters.js). */
    beforeGo: function (c, n) { CD.navigation(); return CD.chapterGo ? CD.chapterGo(c, n) : true; },
    navigation: function () { CD._nav = (CD._nav || 0) + 1; CD._pass = null; },
    signInAgain: function (c, msg) {
      /* The enrolment session lapsed (24 hours idle) or was opened in another
         browser. Resuming with the credential belongs to the Sign-in pack;
         until it lands, the honest answer is to say so and start at the ID. */
      CD.err = msg || "For your security, sign in again to carry on.";
      c._dir = -1; c.setState({ i: 0 });
    },

    /* ---- the official marks (Google and Microsoft brand kits) ----------- */
    mark: function (which) {
      var svg = which === "google"
        ? '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>'
        : '<svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>';
      return window.React.createElement("span", { style: { display: "inline-flex" }, dangerouslySetInnerHTML: { __html: svg } });
    },

    /* ---- boot ------------------------------------------------------------ */
    blank: function (f) {
      /* the prototype's fresh state carries its stand-in shop and owner
         (SIGNUP-LOGIC §13): a real visitor starts with nothing of theirs
         shown until the server says it */
      return Object.assign({}, f, { operatingName: "", ownerName: "", ownerEmail: "", phone: "", country: "", call: false });
    },
    mount: function (c) {
      CD.comp = c;
      try { CD.muted = localStorage.getItem(SOUND_KEY) === "off"; } catch (e) { CD.muted = false; }
      if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (ok) { CD.pkAvailable = !!ok; c.forceUpdate(); }, function () { CD.pkAvailable = false; c.forceUpdate(); });
      } else CD.pkAvailable = false;
      var seedStep = window.__cdSeedStep;
      if (seedStep && SEED[seedStep]) {
        /* TEST ONLY: the server writes __cdSeedStep into the page only when
           SIGNUP_TEST_SEED is set outside production (routes/signup-page.ts),
           for reference/tools/capture.cjs. A visitor never gets one. */
        CD.seeded = true; CD.code = "CD-YORK-7K42"; CD.known[CD.code] = true;
        c._pkJump = SEED[seedStep][1] || ""; c.railJump(SEED[seedStep][0]); c.set("call", false);
        CD.names[CD.code] = String(c.state.data.operatingName || ""); CD.states[CD.code] = "reserved";
        return;
      }
      var returnQuery = new URLSearchParams(location.search);
      var paymentReturn = returnQuery.get("payment") === "return" || returnQuery.has("setup_intent") || returnQuery.has("setup_intent_client_secret");
      if (paymentReturn) history.replaceState(null, "", "/onboarding");
      var ret = null;
      try { ret = JSON.parse(sessionStorage.getItem("cdSsoReturn") || "null"); sessionStorage.removeItem("cdSsoReturn"); } catch (e) { ret = null; }
      var back = /[?&]sso=1/.test(location.search) ? ssoParams() : null;
      /* Start on Day 1: the address is tidied first, so a reload never asks twice */
      var dayOne = dayOneMarked();
      if (location.hash === "#day1") {
        history.replaceState(null, "", "/onboarding");
        if (dayOne && CD.dayOne) { CD.dayOne(c); return; }
      }
      var id = (ret && ret.id) || tabGet();
      if (!ID.test(id)) return;
      CD.code = id;
      var bootRequest = CD._refRequest || 0;
      call("GET", "/api/onboarding/" + encodeURIComponent(id) + "/state").then(function (r) {
        if ((CD._refRequest || 0) !== bootRequest) return;
        if (r.status !== 200 || !r.body.valid) { tabSet(""); return; }
        CD.known[id] = true; CD.names[id] = String(r.body.operatingName || "");
        var active = r.body.state === "active", held = typeof r.body.signup === "string" ? r.body.signup : "";
        CD.states[id] = r.body.state; CD.signups[id] = held; CD.alreadyOpen = active;
        c.set("cdId", id); c.set("operatingName", CD.names[id]);
        if (held || active) inboxSet(false);
        if (paymentReturn && CD.resumePayment) { CD.resumePayment(c, active); return; }
        /* opened by Stripe's webhook after the page stopped asking, or the tab
           closed while it was opening: this browser's enrolment is the hand-off */
        if (active && held && CD.resumePayment) { CD.resumePayment(c, true); return; }
        if (active) { c.setState({ i: 0 }); return; }
        if (back && ret) { c.set("lockMode", ret.provider); c.setState({ i: 5 }); history.replaceState(null, "", "/onboarding"); CD.ssoFinish(c, ret.provider, back.code, back.state); return; }
        if (held) { CD.loadResume(false); return; }
        /* /state answers only reserved or active, so a code still pending is
           this tab's own flag: back to Check your inbox, nothing resent */
        if (inboxGet()) { c.setState({ i: 14 }); return; }
        c.setState({ i: 0 });
      });
    },
    toggleSound: function () {
      CD.muted = !CD.muted;
      try { localStorage.setItem(SOUND_KEY, CD.muted ? "off" : "on"); } catch (e) { /* a per-viewer convenience only */ }
      return CD.muted;
    },
  };

  /* What the other bridge files (chapters, open) share. */
  CD.h = { call: call, api: api, why: why, NET: NET, tabSet: tabSet, STEP_OF: STEP_OF, ID: ID };

  /* The popup comes back here (web/signup-sso.html posts it). */
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data || e.data.type !== "cd-sso" || typeof CD._ssoWait !== "function") return;
    var f = CD._ssoWait; CD._ssoWait = null;
    f(String(e.data.code || ""), String(e.data.state || ""));
  });

  function ssoParams() {
    var q = new URLSearchParams(location.search);
    return q.get("code") && q.get("state") ? { code: q.get("code"), state: q.get("state") } : null;
  }

  function b64e(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64d(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

})();
