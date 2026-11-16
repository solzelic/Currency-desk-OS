/* ============================================================
   Sign-up v2.1, chapter 5 · Open (build doc §6): the plan at the server's
   prices, Stripe's card frame and a $0 SetupIntent, the desk opening once
   Stripe's webhook has told the server, and Day 1 over the real Home.
   Extends the bridge in signup-v2.1-bridge.js.
   ============================================================ */
(function () {
  "use strict";
  var CD = window.__cdOnb, h = CD.h, call = h.call, api = h.api, why = h.why, NET = h.NET, tabSet = h.tabSet, STEP_OF = h.STEP_OF;
  /* ---- money, as the server sent it ------------------------------------ */
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
    paymentKey: function (c) { return JSON.stringify({ choice: CD.paymentChoice(c), locations: c.locCount(), answers: CD._answersRevision || 0 }); },
    /* ---- the plan and the card (screen 24) ------------------------------- */
    loadPrices: function (c) {
      if (CD._pricing || CD._priceFailed) return;
      CD._pricing = true;
      /* the seeded review page has no session: it shows the public list price */
      (CD.seeded ? call("GET", "/api/onboarding/prices") : api("GET", "/prices")).then(function (r) {
        if (r.status !== 200) CD._priceFailed = true;
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
      if (i !== 15) return R;
      var d = c.state.data, an = (d.term || "monthly") === "annual";
      if (!CD.prices) { CD.loadPrices(c); }
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
      if (CD.payErr) R.goLiveSub = CD.payErr;
      if (CD._paying) { R.goLiveLabel = "Opening " + (d.operatingName || "your desk") + "…"; }
      if (R.pf2Open && !CD.seeded) { CD.card(c); setTimeout(CD.mountCard, 0); setTimeout(CD.cardNote, 0); }
      return R;
    },
    fmt: money,
    /* The card: Stripe's Payment Element, in Stripe's frame, mounted into
       the empty box the build leaves where the prototype drew card fields.
       It needs a SetupIntent, which needs the plan the person chose, so it
       starts when the Payment section opens and restarts if that changes. */
    card: function (c) {
      var choice = CD.paymentChoice(c), key = CD.paymentKey(c);
      if (CD._cardKey === key && (CD._cardBusy || CD._elements || CD.payErr)) return;
      if (CD._pe) { try { CD._pe.destroy(); } catch (e) { /* already gone with its box */ } CD._pe = null; CD._elements = null; }
      CD._cardKey = key; CD._cardBusy = true; CD.cardComplete = false; CD.payErr = "";
      var sequence = CD._cardRequest = (CD._cardRequest || 0) + 1;
      api("POST", "/payment", choice, 20000).then(function (r) {
        if (CD._cardKey !== key || sequence !== CD._cardRequest) return;
        CD._cardBusy = false;
        if (r.status !== 200 || !r.body.clientSecret) { CD.payErr = why(r, "Card payments aren’t available just now. Nothing was charged."); c.forceUpdate(); return; }
        if (!r.body.setupIntentId || r.body.termsSourceHash !== window.__cdAgreementHash) { CD.payErr = "The agreement has changed. Reload this page to review it before opening your desk."; c.forceUpdate(); return; }
        CD._secret = r.body.clientSecret;
        CD._intent = r.body.setupIntentId;
        return stripeJs().then(function () {
          if (CD._cardKey !== key || sequence !== CD._cardRequest) return;
          var pk = r.body.publishableKey;
          if (!window.Stripe || !pk) { CD.payErr = "Card payments aren’t switched on here yet. Nothing was charged."; c.forceUpdate(); return; }
          CD._stripe = CD._stripe || window.Stripe(pk);
          CD._elements = CD._stripe.elements({ clientSecret: CD._secret, appearance: { theme: "stripe", variables: { colorPrimary: "#1D6B45", colorText: "#17140F", borderRadius: "10px", fontFamily: "Schibsted Grotesk, system-ui, sans-serif" } } });
          CD._pe = CD._elements.create("payment", { layout: "tabs", fields: { billingDetails: { name: "never", address: "never" } }, wallets: { applePay: "never", googlePay: "never" } });
          CD._pe.on("change", function (e) { CD.cardComplete = !!e.complete; c.forceUpdate(); });
          CD.mountCard();
        }, function () { if (sequence !== CD._cardRequest) return; CD.payErr = "The card form didn’t load. Check your connection and try again. Nothing was charged."; c.forceUpdate(); });
      });
    },
    /* No card form (Stripe off, or unreachable): say why where the card would be. */
    cardNote: function () {
      var box = document.querySelector("[data-stripe-card]");
      if (!box || box.getAttribute("data-mounted") === "1") return;
      box.setAttribute("role", "status");
      box.style.cssText = "min-height: 46px; display: flex; align-items: center; padding: 12px 14px; border-radius: 10px; border: 1px dashed var(--line); font-size: 13px; line-height: 1.45; color: var(--mute);";
      box.textContent = CD.payErr || (CD._cardBusy ? "Loading the card form\u2026" : "");
    },
    mountCard: function () {
      var box = document.querySelector("[data-stripe-card]");
      if (!box || !CD._pe || box.getAttribute("data-mounted") === "1") return;
      /* the section folds and opens again with a new box: move the frame */
      if (CD._box && CD._box !== box) { try { CD._pe.unmount(); } catch (e) { /* the old box went with the fold */ } }
      CD._box = box; box.setAttribute("data-mounted", "1");
      try { CD._pe.mount(box); } catch (e) { console.error("[signup] card form did not mount", e && e.name); }
    },
    /* Open {Shop}: Stripe confirms the SetupIntent (no money moves; a bank
       may ask the person to approve). Then the desk opens when Stripe's
       webhook has told the server, and only then; the page asks until it
       has, and says so if it is taking a while. */
    pay: function (c) {
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
        return CD._stripe.confirmSetup({ elements: elements, redirect: "if_required", confirmParams: { payment_method_data: { billing_details: billing }, return_url: location.origin + "/onboarding" } })
        .then(function (res) {
          if (res.error) { CD._paying = false; CD.payErr = res.error.message || "The card wasn’t accepted. Nothing was charged."; c.forceUpdate(); return; }
          CD.waitOpen(c, 0);
        }, function () { CD._paying = false; CD.payErr = NET; c.forceUpdate(); });
      });
    },
    waitOpen: function (c, n) {
      api("POST", "/open", {}).then(function (r) {
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
          if (n < 60) { setTimeout(function () { CD.waitOpen(c, n + 1); }, n < 10 ? 1000 : 3000); return; }
          CD._paying = false; CD.payErr = "Your card is saved and nothing was charged, but the desk hasn’t opened yet. Come back to this page in a few minutes; we’ll pick up from here."; c.forceUpdate(); return;
        }
        CD._paying = false; CD.payErr = why(r, "The desk didn’t open. Nothing was charged."); c.forceUpdate();
      });
    },
    walk: function () { location.assign("/app"); },

  });

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
      var t = setTimeout(function () { no(new Error("stripe_timeout")); }, 15000);
      s.onload = function () { clearTimeout(t); ok(); }; s.onerror = function () { clearTimeout(t); stripeLoading = null; no(new Error("stripe_load")); };
      document.head.appendChild(s);
    });
    return stripeLoading;
  }

})();
