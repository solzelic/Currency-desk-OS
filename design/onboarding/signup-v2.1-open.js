/* ============================================================
   Sign-up v2.1, chapter 5 · Open (build doc §6): the plan at the server's
   prices, Stripe's card frame and a $0 SetupIntent, the desk opening once
   Stripe's webhook has told the server, and Day 1 over the real Home.
   Extends the bridge in signup-v2.1-bridge.js.
   ============================================================ */
(function () {
  "use strict";
  var CD = window.__cdOnb, h = CD.h, call = h.call, api = h.api, why = h.why, NET = h.NET, tabSet = h.tabSet, STEP_OF = h.STEP_OF;
  /* Start on Day 1 (staging): what the server's one answer must look like */
  var DAY_ONE_EMAIL = /^owner\+[0-9a-f]{8}@staging\.invalid$/;
  var DAY_ONE_PASSWORD = /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{4}$/;
  var DAY_ONE_FAILED = "The staging door didn’t open a shop. Try again.";
  var DAY_ONE_SLOW = "Too many new staging shops just now. Try again in a little while.";
  /* One item a line (the page draws it pre-line), so a password never wraps at its hyphens. */
  function dayOneLine(s) {
    return ["Staging test shop. Note these now: they are not shown again.",
      "Counter PIN " + s.pin + " (staging resets every PIN to 0000 when it next restarts or deploys)",
      "Owner email " + s.email,
      "Password " + s.password + " (Forgot PIN asks for it)",
      "The sign-in page can’t sign this owner in again yet (CD-221), so this browser stays signed in for 12 hours."].join("\n");
  }
  /* ---- money, as the server sent it ------------------------------------ */
  var STAGING_NOTE = "Staging test shop. No card is taken, nothing on this form is sent and nothing is charged: Open finishes the desk as a test shop.";
  /* the server's own line is preferred; this is for a server that sends none */
  var WEBSITE_SOON = "Your own rate website isn’t open yet. Untick it to carry on. Nothing was charged.";
  var SYMBOL = { CAD: "$", USD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£" };
  function money(minor, currency) {
    if (typeof minor !== "number" || !isFinite(minor)) return "";
    var whole = Math.floor(minor / 100), cents = minor % 100;
    var s = (SYMBOL[currency] || "") + whole.toLocaleString("en-CA");
    return cents ? s + "." + (cents < 10 ? "0" : "") + cents : s;
  }

  Object.assign(CD, {
    paymentChoice: function (c) {
      var d = c.state.data;
      return { plan: d.plan || "ai", term: d.term || "monthly",
        extras: { brief: d.brief !== false, call: d.call !== false, website: !!(d.addons || {}).website, setupWeek: !!(d.addons || {}).onsite } };
    },
    paymentKey: function (c) { return JSON.stringify({ id: CD.code, choice: CD.paymentChoice(c), locations: c.locCount(), answers: CD._answersRevision || 0 }); },
    /* ---- the plan and the card (screen 24) ------------------------------- */
    loadPrices: function (c) {
      var key = JSON.stringify([CD.code, CD._answersRevision || 0]);
      if (CD._priceKey === key && (CD._pricing || CD._priceFailed)) return;
      CD._priceKey = key; CD._pricing = true; CD._priceFailed = false;
      var request = CD._priceRequest = (CD._priceRequest || 0) + 1;
      /* the seeded review page has no session: it shows the public list price */
      (CD.seeded ? call("GET", "/api/onboarding/prices") : api("GET", "/prices")).then(function (r) {
        if (request !== CD._priceRequest || key !== JSON.stringify([CD.code, CD._answersRevision || 0])) return;
        if (r.status !== 200 || !r.body.plans) CD._priceFailed = true;
        CD._pricing = false;
        if (r.status === 200 && r.body.plans) { CD.prices = r.body; c.forceUpdate(); }
        else { CD.err = why(r, "We couldn’t load the prices just now."); c.forceUpdate(); }
      });
    },
    quote: function (plan, term) {
      var p = CD.prices; if (!p) return null;
      var q = (p.plans[plan] || {})[term];
      return q ? { currency: p.currency, locations: p.locations, per: q.perLocationMinor, perYear: q.perLocationYearMinor, perDay: q.aboutPerDayMinor,
        total: q.totalMinor, year: q.yearMinor, saveYear: q.annualSavingMinor, setup: p.setupWeekMinor, dueToday: q.dueTodayMinor } : null;
    },
    /* After every render: what the server knows replaces what the prototype
       drew from its own numbers, and the screen says why when the server said no. */
    priced: function (c, R) {
      var i = c.state.i;
      R.homeStatus = CD.launched && !CD.homeReady ? (CD.homeError || "Loading your desk…") : "";
      R.realHome = CD.launched === true; R.prototypeHome = !R.realHome; R.realInert = "";
      R.welcomeWrap = "position:relative;max-width:780px;margin:" + (R.realHome ? "158px auto 0" : "0 auto") + ";padding:38px 18px 60px;";
      if (CD._errAt !== i) { CD._errAt = i; if (CD.err && i !== 0) CD.err = ""; }
      if (CD.err && i !== 14 && i !== 0) R.help = CD.err;
      if (i === 0 && CD.err) R.cdIdHint = CD.err;
      /* Start on Day 1's one staging line: on Day 1 only, after that launch */
      R.stagingDayOne = i === 16 && CD.launched === true && CD._dayOneLine ? CD._dayOneLine : "";
      /* and its hold: a neutral status over the page, which is inert beneath it ("" sets the attribute) */
      var hold = CD.holding();
      R.dayOneHold = hold; R.holdInert = hold ? "" : null;
      R.dayOneHoldTitle = hold ? "Opening " + (CD._dayOneName || "a staging test shop") + "…" : "";
      if (i !== 15) return R;
      var d = c.state.data, an = (d.term || "monthly") === "annual";
      /* The website refusal stands while it is ticked. Unticking clears it,
         and the card is asked for afresh the next time Payment opens. */
      if (CD._webRefused && !(d.addons || {}).website) {
        if (CD.payErr === CD._webRefused) CD.payErr = "";
        CD._webRefused = ""; CD._cardKey = null; CD._cardFailed = false;
      }
      R.xWebRefused = CD._webRefused || "";
      /* a desk already open is only waiting for /open: no quote, no card (both 409);
         one that has opened needs neither in the second before Day 1 */
      var quoting = !CD._paying && !CD.alreadyOpen && !CD.launched;
      if (!CD.prices && quoting) { CD.loadPrices(c); }
      var cur = " " + ((CD.prices && CD.prices.currency) || c.PRICE_CCY);
      var f = function (m) { return money(m, CD.prices && CD.prices.currency); };
      var blank = "—";
      (R.planCards || []).forEach(function (card, k) {
        var q = CD.quote(c.PLANS[k].id, an ? "annual" : "monthly");
        card.cur = (CD.prices && CD.prices.currency) || c.PRICE_CCY;
        card.priceBig = q ? f(q.per) : blank;
        card.perNote = !q ? "" : an ? "billed " + f(q.perYear) + " a year · per location" : "per location · about " + f(Math.round(q.perDay / 100) * 100) + " a day"; /* "about": whole units, as designed */
      });
      var sel = CD.quote(d.plan || "ai", an ? "annual" : "monthly");
      var selMonthly = CD.quote(d.plan || "ai", "monthly");
      var once = (d.addons || {}).onsite && sel ? sel.setup : 0;
      if (sel) {
        R.orderRecur = an ? f(sel.year) + cur + "/yr" : f(sel.total) + cur + "/mo";
        R.locsMath = sel.locations + " × " + (an ? f(sel.perYear) + cur + "/yr" : f(sel.per) + cur + "/mo");
        R.orderOnce = f(once); R.hasOnce = once > 0;
        R.pf0Sum = c.PLANS.find(function (p) { return p.id === (d.plan || "ai"); }).name + " · " + f(sel.per) + cur + "/mo per location" + (an ? ", billed yearly" : "");
        R.dueToday = money(sel.dueToday, CD.prices.currency) + (sel.dueToday % 100 ? "" : ".00");
        R.goLiveSub = money(sel.dueToday, CD.prices.currency) + " today · billing starts with your first transaction · then " + R.orderRecur + (once ? " · " + f(once) + " one-time" : "") + " · cancel any time";
      } else { R.orderRecur = blank; R.goLiveSub = ""; }
      if (selMonthly) {
        var save = CD.quote(d.plan || "ai", "annual");
        if (save) { R.annualBadge = "Save " + f(save.saveYear); R.annualNudge = "Pay yearly instead and save " + f(save.saveYear) + " a year"; R.annualSaveStr = "You save " + f(save.saveYear) + " a year vs monthly"; }
      }
      R.xSetupPrice = CD.prices ? f(CD.prices.setupWeekMinor) + " once" : blank;
      R.xWebPrice = "$99" + cur + "/mo"; /* coming soon: shown by the design, never sold (the server refuses it) */
      (R.addonRows || []).forEach(function (a) { if (/setup week/i.test(a.name) && CD.prices) a.priceStr = f(CD.prices.setupWeekMinor) + cur + " once"; });
      R.retryCardVisible = !!CD._cardFailed && !CD._paying && !CD.seeded && !CD._webRefused; /* a retry cannot help: the add-on is the problem */
      R.onRetryCard = function () { CD.retryCard(c); };
      R.retryPricesVisible = !!CD._priceFailed;
      R.onRetryPrices = function () { CD._priceFailed = false; CD.loadPrices(c); c.forceUpdate(); };
      R.checkOpenVisible = !!CD._openStalled && !CD._paying;
      R.onCheckOpen = function () { CD.checkOpen(c); };
      if (CD.payErr) R.goLiveSub = CD.payErr;
      if (CD._paying) { R.goLiveLabel = "Opening " + (d.operatingName || "your desk") + "…"; }
      if (R.pf2Open && !CD.seeded && quoting) { CD.card(c); setTimeout(CD.mountCard, 0); setTimeout(CD.cardNote, 0); }
      return R;
    },
    fmt: money,
    /* The card: Stripe's Payment Element, in Stripe's frame, mounted into
       the empty box the build leaves where the prototype drew card fields.
       It needs a SetupIntent, which needs the plan the person chose, so it
       starts when the Payment section opens and restarts if that changes. */
    retryCard: function (c) {
      if (CD._paying || CD._cardBusy) return;
      CD._cardKey = null; CD.card(c); c.forceUpdate();
    },
    card: function (c) {
      var choice = CD.paymentChoice(c), key = CD.paymentKey(c);
      if (CD._cardKey === key && (CD._cardBusy || CD._elements || CD._cardFailed || CD._staging)) return;
      if (CD._pe) { try { CD._pe.destroy(); } catch (e) {} }
      CD._pe = null; CD._elements = null; CD._secret = null; CD._intent = null;
      if (CD._box) { CD._box.removeAttribute("data-mounted"); CD._box.textContent = ""; }
      CD._cardKey = key; CD._cardBusy = true; CD._cardFailed = false; CD.cardComplete = false; CD._staging = false; CD.payErr = ""; CD._webRefused = "";
      var sequence = CD._cardRequest = (CD._cardRequest || 0) + 1;
      var current = function () { return CD._cardKey === key && key === CD.paymentKey(c) && sequence === CD._cardRequest; };
      var fail = function (message) { if (!current()) return; CD._cardBusy = false; CD._cardFailed = true; CD._elements = null; CD.payErr = message; c.forceUpdate(); };
      api("POST", "/payment", choice, 20000).then(function (r) {
        if (!current()) return;
        if (r.status === 409 && r.body && r.body.error === "website_coming_soon") {
          /* the add-on, not the card: say so beside it, with Extras open where it can be unticked */
          CD._webRefused = why(r, WEBSITE_SOON); fail(CD._webRefused); c.setState({ payOpen: 1 }); return;
        }
        if (r.status !== 200 || (!r.body.clientSecret && r.body.staging !== true)) { fail(why(r, "Card payments aren’t available just now. Nothing was charged.")); return; }
        if (r.body.staging === true && r.body.termsSourceHash === window.__cdAgreementHash) {
          /* the staging door's synthetic shop: no card form, nothing to take */
          CD._staging = true; CD._cardBusy = false; CD.cardComplete = true; c.forceUpdate(); setTimeout(CD.cardNote, 0); return;
        }
        if (!r.body.setupIntentId || r.body.termsSourceHash !== window.__cdAgreementHash) { fail("The agreement has changed. Reload this page to review it before opening your desk."); return; }
        CD._secret = r.body.clientSecret; CD._intent = r.body.setupIntentId;
        return stripeJs().then(function () {
          if (!current()) return;
          var pk = r.body.publishableKey;
          if (!window.Stripe || !pk) { fail("Card payments aren’t switched on here yet. Nothing was charged."); return; }
          CD._stripe = CD._stripe || window.Stripe(pk);
          CD._elements = CD._stripe.elements({ clientSecret: CD._secret, appearance: { theme: "stripe", variables: { colorPrimary: "#1D6B45", colorText: "#17140F", borderRadius: "10px", fontFamily: "Schibsted Grotesk, system-ui, sans-serif" } } });
          CD._pe = CD._elements.create("payment", { layout: "tabs", fields: { billingDetails: { name: "never", address: "never" } }, wallets: { applePay: "never", googlePay: "never" } });
          CD._pe.on("change", function (e) { if (!current()) return; CD.cardComplete = !!e.complete; c.forceUpdate(); });
          CD._cardBusy = false; CD.mountCard(); c.forceUpdate();
        });
      }).catch(function () { fail("The card form didn’t load. Check your connection and try again. Nothing was charged."); });
    },
    /* No card form (Stripe off, or unreachable): say why where the card would be. */
    cardNote: function () {
      var box = document.querySelector("[data-stripe-card]");
      if (!box || box.getAttribute("data-mounted") === "1") return;
      box.setAttribute("role", "status");
      box.style.cssText = "min-height: 46px; display: flex; align-items: center; padding: 12px 14px; border-radius: 10px; border: 1px dashed var(--line); font-size: 13px; line-height: 1.45; color: var(--mute);";
      box.textContent = CD.payErr || (CD._staging ? STAGING_NOTE : CD._cardBusy ? "Loading the card form\u2026" : "");
    },
    mountCard: function () {
      var box = document.querySelector("[data-stripe-card]");
      if (!box || !CD._pe || box.getAttribute("data-mounted") === "1") return;
      /* the section folds and opens again with a new box: move the frame */
      if (CD._box && CD._box !== box) { try { CD._pe.unmount(); } catch (e) { /* the old box went with the fold */ } }
      CD._box = box; box.textContent = ""; box.setAttribute("role", "group");
      try { CD._pe.mount(box); box.setAttribute("data-mounted", "1"); }
      catch (e) { CD._cardFailed = true; CD._elements = null; CD.payErr = "The card form didn’t load. Try again. Nothing was charged."; if (CD.comp) CD.comp.forceUpdate(); }
    },
    /* Open {Shop}: Stripe confirms the SetupIntent (no money moves; a bank
       may ask the person to approve). Then the desk opens when Stripe's
       webhook has told the server, and only then; the page asks until it
       has, and says so if it is taking a while. */
    pay: function (c) {
      /* the card is already confirmed: Open only asks again, never confirms twice */
      if (CD._openStalled) return CD.checkOpen(c);
      if (CD._staging) return CD.stagingPay(c);
      if (!CD._stripe || !CD._elements || CD._paying || !c.state.termsRead) return;
      if (CD._cardKey !== CD.paymentKey(c)) { CD.payErr = "Your plan changed. Open Payment again to update the card form."; CD.cardComplete = false; c.forceUpdate(); return; }
      var d = c.state.data;
      var key = CD._cardKey, elements = CD._elements;
      CD._paying = true; CD.payErr = ""; c.forceUpdate();
      var billing = d.billSame !== false
        ? { name: d.cardName || d.ownerName, address: { line1: d.street, line2: d.unit || undefined, city: d.city, state: d.region, postal_code: d.postal, country: (CD.pack && CD.pack.code) || undefined } }
        : { name: d.cardName || d.ownerName, address: { line1: d.billStreet, city: d.billCity, state: d.billRegion, postal_code: d.billPostal } };
      api("POST", "/agreement", { setupIntentId: CD._intent, termsSourceHash: window.__cdAgreementHash, agreed: true }).then(function (r) {
        if (r.status !== 200 || key !== CD.paymentKey(c)) {
          if (r.status === 409) CD._cardKey = null;
          CD._paying = false; CD.payErr = why(r, "Your desk or plan changed. Review it before opening your desk."); c.forceUpdate(); return;
        }
        return CD._stripe.confirmSetup({ elements: elements, redirect: "if_required", confirmParams: { payment_method_data: { billing_details: billing }, return_url: location.origin + "/onboarding?payment=return" } })
        .then(function (res) {
          if (res.error) { CD._paying = false; CD.payErr = res.error.message || "The card wasn’t accepted. Nothing was charged."; c.forceUpdate(); return; }
          CD.waitOpen(c, 0);
        });
      }).catch(function () { CD._paying = false; CD.payErr = NET; c.forceUpdate(); });
    },
    /* Staging test shop: Open records the owner's assent and the server opens
       the desk as a test shop; then the same /open as after a card. */
    stagingPay: function (c) {
      if (CD._paying || !c.state.termsRead || !CD.cardComplete) return;
      if (CD._cardKey !== CD.paymentKey(c)) { CD.payErr = "Your plan changed. Open Payment again to update it."; CD.cardComplete = false; CD._staging = false; c.forceUpdate(); return; }
      var key = CD._cardKey, attempt = { id: CD.code, nav: CD._nav || 0 };
      CD._paying = true; CD.payErr = ""; c.forceUpdate();
      api("POST", "/staging-open", { termsSourceHash: window.__cdAgreementHash, agreed: true }).then(function (r) {
        if (attempt.id !== CD.code || attempt.nav !== (CD._nav || 0)) return;
        if ((r.status === 200 && r.body.ok) || (r.status === 409 && r.body.error === "already_open")) { CD.waitOpen(c, 0, attempt); return; }
        if (r.status === 409 || key !== CD.paymentKey(c)) { CD._cardKey = null; CD._staging = false; CD.cardComplete = false; }
        CD._paying = false; CD.payErr = why(r, "The desk didn’t open. Nothing was charged."); c.forceUpdate();
      });
    },
    resumePayment: function (c, active) {
      // A URL is only a navigation hint. /open requires the unspent enrolment
      // cookie and a webhook-activated account; no query value proves payment.
      // `active`: GET /state already said the desk is open.
      CD._paying = true; CD._openStalled = null; c.setState({ i: 15 });
      CD.waitOpen(c, 0, { id: CD.code, nav: CD._nav || 0, active: !!active });
    },
    /* Check again, after the page stopped asking: the same /open, once more. */
    checkOpen: function (c) {
      var was = CD._openStalled;
      if (!was || CD._paying || was.id !== CD.code) return;
      CD._openStalled = null; CD._paying = true; CD.payErr = ""; c.forceUpdate();
      CD.waitOpen(c, 0, { id: CD.code, nav: CD._nav || 0, active: was.active });
    },
    waitOpen: function (c, n, attempt) {
      attempt = attempt || { id: CD.code, nav: CD._nav || 0 };
      var current = function () { return attempt.id === CD.code && attempt.nav === (CD._nav || 0); };
      if (!current()) return;
      api("POST", "/open", {}).then(function (r) {
        if (!current()) return;
        if (r.status === 200 && r.body.ok) {
          CD._paying = false; CD.launched = true; CD.tenantId = r.body.tenantId; tabSet("");
          c.set("cdId", r.body.cdId || CD.code); if (r.body.operatingName) c.set("operatingName", r.body.operatingName);
          c.setState({ paid: true, landKey: c.state.landKey + 1 });
          setTimeout(function () {
            if (!CD.homeReady && c.state.i === 16) { CD.homeError = "Your desk is taking longer to load. Open it to try again."; c.forceUpdate(); }
          }, 10000);
          setTimeout(function () { c.setState({ i: 16 }); }, 1000);
          return;
        }
        if (r.status === 202 || r.status === 0) {
          if (n === 10) { CD.payErr = "Your card is saved. The desk is still opening; this can take a minute. Stay on this page."; c.forceUpdate(); }
          if (n < 60) { setTimeout(function () { CD.waitOpen(c, n + 1, attempt); }, n < 10 ? 1000 : 3000); return; }
          CD._paying = false; CD._openStalled = attempt;
          CD.payErr = "Your card is saved and nothing was charged, but the desk hasn’t opened yet. Check again in a minute. If you leave, come back to this page in this browser; once it has opened, we’ll pick up from here.";
          c.forceUpdate(); return;
        }
        if (attempt.active && (r.status === 401 || r.status === 409)) {
          /* the desk is open, but this browser's hand-off is spent or gone: sign in */
          CD._paying = false; CD.signups[CD.code] = ""; CD.alreadyOpen = true; CD.err = "This desk is already open. Sign in.";
          c._dir = -1; c.setState({ i: 0 }); return;
        }
        CD._paying = false; CD.payErr = why(r, "The desk didn’t open. Nothing was charged."); c.forceUpdate();
      });
    },
    walk: function () { CD._dayOneLine = ""; location.assign("/app"); },

    /* ---- Start on Day 1 (staging only) ----------------------------------- */
    /* The bridge's mount() calls this for /onboarding#day1 with this tab's
       fresh mark. The server signs up a new test shop and answers once with
       its ID and the owner's sign-in; the page's own calls then open it, as
       after a staging Open: /resume, /staging-open, /open. The sign-in stays
       in page memory, for the one line on Day 1, and is never stored. The ID
       goes into this tab only once the desk is opening, so a reload before
       then starts afresh instead of half-way through.
       The page holds (holding(), the build's hold over an inert page) from
       the press until the desk opens or the press fails. The welcome stays
       under it, then the plan screen once the server has named the shop:
       never a shop screen without that name, where the prototype draws its
       stand-in shop (SIGNUP-LOGIC §13). Nothing under the hold can move the
       page, so a 201 is always carried on, never dropped. */
    /* Is the page held? Continue, the skips and Back ask first (the bridge,
       the build's back()). The hold ends when the press stops paying. */
    holding: function () {
      if (CD._dayOneHold && !CD._paying) CD._dayOneHold = false;
      return !!CD._dayOneHold;
    },
    dayOne: function (c) {
      var fail = function (r) {
        CD._paying = false; CD._dayOneHold = false; CD._dayOneLine = ""; CD._dayOneName = ""; CD.code = ""; tabSet("");
        CD.err = r && r.status === 429 ? DAY_ONE_SLOW : why(r, DAY_ONE_FAILED);
        c._dir = -1; c.setState({ i: 0 });
      };
      tabSet(""); CD.navigation(); CD.code = ""; CD.err = ""; CD._dayOneLine = ""; CD._dayOneName = "";
      CD._paying = true; CD._dayOneHold = true; c.forceUpdate();
      call("POST", "/api/staging/day-one", {}, 60000).then(function (r) {
        var b = r.body || {}, s = b.signIn && typeof b.signIn === "object" ? b.signIn : {};
        if (r.status !== 201 || b.ok !== true || typeof b.cdId !== "string" || !h.ID.test(b.cdId) || typeof b.operatingName !== "string" || !b.operatingName.trim()
          || !DAY_ONE_EMAIL.test(String(s.email)) || !/^[0-9]{4}$/.test(String(s.pin)) || !DAY_ONE_PASSWORD.test(String(s.password))) return fail(r);
        var id = b.cdId;
        CD.code = id; CD.known[id] = true; CD.names[id] = b.operatingName.trim(); CD.states[id] = "reserved"; CD.signups[id] = "verified";
        c.set("cdId", id); c.set("operatingName", CD.names[id]);
        CD._dayOneName = CD.names[id]; CD._dayOneLine = dayOneLine(s);
        return CD.loadResume(true).then(function (res) {
          /* false: the tab moved, which the hold rules out; say so rather than strand it */
          if (res !== true) return fail(res === false ? null : res);
          return api("POST", "/staging-open", { termsSourceHash: window.__cdAgreementHash, agreed: true }).then(function (o) {
            if (CD.code !== id || !((o.status === 200 && o.body.ok) || (o.status === 409 && o.body.error === "already_open"))) return fail(CD.code !== id ? null : o);
            /* the named plan screen under the hold: if /open does not open, the hold lifts onto it with the reason */
            tabSet(id); c._dir = 1; c.setState({ i: 15 });
            CD.waitOpen(c, 0, { id: id, nav: CD._nav || 0 });
          });
        });
      });
    },
  });

  /* Leaving Day 1 forgets the staging line, and a page brought back from the
     browser's cache draws again without it. */
  window.addEventListener("pagehide", function () {
    if (!CD._dayOneLine) return;
    CD._dayOneLine = "";
    var line = document.querySelector("[data-staging-day-one]");
    if (line) line.style.display = "none";
  });
  window.addEventListener("pageshow", function (e) { if (e && e.persisted && CD.comp) CD.comp.forceUpdate(); });

  window.addEventListener("message", function (e) {
    var frame = document.querySelector("iframe[data-real-home]");
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || !e.data || e.data.type !== "cd-signup-home-ready" || e.data.tenantId !== CD.tenantId) return;
    CD.homeReady = true; if (CD.comp) CD.comp.forceUpdate();
  });

  var stripeLoading = null;
  function stripeJs() {
    if (window.Stripe) return Promise.resolve();
    if (stripeLoading) return stripeLoading;
    stripeLoading = new Promise(function (ok, no) {
      var s = document.createElement("script");
      s.src = "https://js.stripe.com/v3/"; s.async = true;
      var settled = false;
      function finish(error) {
        if (settled) return; settled = true; clearTimeout(t); s.onload = null; s.onerror = null;
        if (error) { s.remove(); stripeLoading = null; no(error); } else ok();
      }
      var t = setTimeout(function () { finish(new Error("stripe_timeout")); }, 15000);
      s.onload = function () { finish(window.Stripe ? null : new Error("stripe_missing")); };
      s.onerror = function () { finish(new Error("stripe_load")); };
      document.head.appendChild(s);
    });
    return stripeLoading;
  }

})();
