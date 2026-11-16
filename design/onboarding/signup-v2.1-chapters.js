/* ============================================================
   Sign-up v2.1, chapters 2 to 5 (build doc §6): each screen saves on
   Continue (PUT …/answers, the server's own names in
   onboarding/signup-answers.ts), the skip links save what skipping means,
   the address comes from Google Places through our server or is typed by
   hand, and the declaration is signed with POST …/confirm. Extends the
   bridge in signup-v2.1-bridge.js.
   ============================================================ */
(function () {
  "use strict";
  var CD = window.__cdOnb, h = CD.h, call = h.call, api = h.api, why = h.why, NET = h.NET, tabSet = h.tabSet, STEP_OF = h.STEP_OF;
  var SAVES = { 2: 1, 3: 1, 28: 1, 29: 1, 30: 1, 4: 1, 22: 1, 6: 1, 8: 1, 26: 1, 23: 1, 9: 1, 10: 1, 11: 1, 31: 1 };

  Object.assign(CD, {
    /* Continue on a chapter screen (called from the core's beforeNext) */
    chapterNext: function (c, go, stop) {
      var i = c.state.i, d = c.state.data, id = CD.code, nav = CD._nav || 0;
      var current = function () { return i === c.state.i && id === CD.code && nav === (CD._nav || 0); };
      if (i === 13) {
        if (!d.signed) return true; /* the prototype refuses on its own */
        CD._busy = true;
        api("POST", "/confirm", { signed: true, name: d.ownerName }).then(function (r) {
          if (!current()) { CD._busy = false; return; }
          if (r.status === 200) { CD.declaration = r.body.declaration || ""; return go(); }
          if (r.status === 401) { CD._busy = false; return CD.signInAgain(c, why(r)); }
          c.set("signed", false); stop(why(r, NET));
        });
        return false;
      }
      if (SAVES[i]) {
        CD._busy = true;
        CD.save(c, i, d).then(function (r) {
          if (!current()) { CD._busy = false; return; }
          if (r.status === 200) return go();
          if (r.status === 401) { CD._busy = false; return CD.signInAgain(c, why(r)); }
          stop(why(r, NET));
        });
        return false;
      }
      return true;
    },
    chapterGo: function (c, n) {
      var i = c.state.i, d = c.state.data;
      if (CD.seeded || CD._goPass) { CD._goPass = false; return true; }
      var skip = (i === 4 && n === 22) ? { step: "12-registration", answers: { msbNumber: "", regSkipped: true } }
        : (i === 8 && n === 26) ? { step: "15-count", answers: { countLater: true } }
        : (i === 11 && n === 24) ? { step: "20-team", answers: { team: [] }, to: 13 }
        : null;
      if (!skip) return true;
      if (CD._busy) return false;
      CD._busy = true;
      var id = CD.code, nav = CD._nav || 0;
      api("PUT", "/answers", { step: skip.step, answers: skip.answers }).then(function (r) {
        CD._busy = false;
        if (CD.code !== id || c.state.i !== i || (CD._nav || 0) !== nav) return;
        if (r.status === 200) { CD.savedAnswers(); CD._goPass = true; c.go(skip.to != null ? skip.to : n); return; }
        if (r.status === 401) return CD.signInAgain(c, why(r));
        CD.err = why(r, NET); c.forceUpdate();
      });
      return false;
    },
    save: function (c, i, d) {
      var answers;
      try { answers = toServer(c, i, d); } catch (e) { return Promise.resolve({ status: 422, body: { detail: e.message } }); }
      return api("PUT", "/answers", { step: STEP_OF[i], answers: answers }).then(function (r) { if (r.status === 200) CD.savedAnswers(); return r; });
    },
    savedAnswers: function () {
      CD._answersRevision = (CD._answersRevision || 0) + 1;
      CD._cardKey = null; CD.cardComplete = false;
      CD.prices = null; CD._priceFailed = false;
    },
    /* ---- the address (screen 9): Google Places through our server -------- */
    places: function (c, q) {
      if (q.length < 3 || !CD.code) return [];
      if (CD._pq !== q) {
        CD._pq = q; clearTimeout(CD._pt);
        CD._pt = setTimeout(function () {
          if (!CD._ps) CD._ps = "cd-" + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
          api("GET", "/places/suggest?q=" + encodeURIComponent(q) + "&s=" + encodeURIComponent(CD._ps), undefined, 6000).then(function (r) {
            if (CD._pq !== q) return;
            CD._pl = r.status === 200 && r.body.enabled !== false ? (r.body.suggestions || []).slice(0, 5).map(function (s) {
              var a = [s.primary, "", "", "", s.secondary]; a.placeId = s.id; a.sub = s.secondary; return a;
            }) : [];
            c.forceUpdate();
          });
        }, 220);
      }
      return CD._pl || [];
    },
    pickPlace: function (c, a) {
      c._tone("step");
      c.setState({ adQ: a[0], adSearch: false });
      api("GET", "/places/details?id=" + encodeURIComponent(a.placeId) + "&s=" + encodeURIComponent(CD._ps || ""), undefined, 6000).then(function (r) {
        CD._ps = null;
        var x = r.status === 200 && r.body.address;
        if (!x) { c.set("street", a[0]); c.set("addrVerified", false); c.set("addrManual", true); return; }
        ["street", "city", "region", "postal"].forEach(function (k) { c.set(k, x[k] || ""); });
        c.set("country_addr", x.country || ""); c.set("addrVerified", true); c.set("addrManual", false);
      });
    },

    fromServer: function (a) { return fromServer(a); },
  });

  /* ---- answers: the prototype's names ⇄ the server's (signup-answers.ts) */
  function amount(v) {
    var s = String(v == null ? "" : v).trim();
    if (s && !/^\d{1,12}(\.\d{1,2})?$/.test(s)) throw new Error("Enter a non-negative amount with up to two decimal places.");
    return s;
  }
  function member(t) {
    var parts = String(t.name || "").trim().split(/\s+/);
    var first = (t.first || parts[0] || "").trim(), last = (t.last || parts.slice(1).join(" ") || "").trim();
    var email = String(t.email || "").trim();
    var m = { first: first, last: last, name: (first + " " + last).trim(), role: t.role, email: email, mode: email ? "email" : "noemail" };
    if (t.phone) m.phone = String(t.phone).trim();
    return m;
  }
  function toServer(c, i, d) {
    switch (i) {
      case 2: return { operatingName: d.operatingName, bizName: d.bizName, nameOk: !!d.nameOk, legalOk: !!d.legalOk };
      case 3: return { street: d.street, unit: d.unit || "", city: d.city, region: d.region, postal: d.postal, country_addr: d.country_addr, addrVerified: !!d.addrVerified, addrManual: !!d.addrManual };
      /* the hand-entry form: saved before the prototype marks it manual, so say so here */
      case 28: return { street: d.street, unit: d.unit || "", city: d.city, region: d.region, postal: d.postal, country_addr: d.country_addr, addrVerified: false, addrManual: true };
      case 29: return { shops: c.locCount() > 1 ? "more" : "one" };
      case 30: return { shops: "more", shopCount: Math.max(2, c.locCount()) };
      case 4: return { msbNumber: String(d.msbNumber || "").trim(), regSkipped: !String(d.msbNumber || "").trim() };
      case 6: return { currencies: d.currencies.slice() };
      case 8: {
        var out = {}, home = c.jurisOf(d.country).home, all = [home].concat(d.currencies.filter(function (x) { return x !== home; }));
        all.forEach(function (cc) {
          var k = (d.count || {})[cc] || {}, den = k.den || {}, notes = {};
          var mode = (c.state.cntMode || {})[cc] || (Object.values(den).some(Boolean) || k.coins ? "notes" : ((d.float || {})[cc] ? "total" : "notes"));
          if (mode === "total") {
            var total = amount((d.float || {})[cc]);
            if (total) out[cc] = { mode: "total", total: total, done: !!k.done };
            else if (k.done) out[cc] = { mode: "none", done: true };
            return;
          }
          Object.keys(den).forEach(function (v) {
            var q = String(den[v] == null ? "" : den[v]).trim();
            if (!q) return;
            if (!/^\d+$/.test(q) || Number(q) > 1000000) throw new Error("Enter a whole number of notes, up to 1,000,000.");
            if (Number(q) > 0) notes[v] = Number(q);
          });
          var coins = amount(k.coins);
          if (Object.keys(notes).length || coins) out[cc] = { mode: "notes", notes: notes, coins: coins || undefined, done: !!k.done };
          else if (k.done) out[cc] = { mode: "none", done: true };

        });
        return { count: out, countLater: false };
      }
      case 9: {
        var me = d.complianceMode === "me" || (!d.complianceMode && d.compName && d.compName === d.ownerName);
        return me ? { complianceMode: "me", compName: d.ownerName || "", compEmail: "" }
          : { complianceMode: "else", compName: String(d.compName || "").trim(), compEmail: String(d.compEmail || "").trim() };
      }
      case 10: {
        var j = c.jurisOf(d.country);
        var over = d.idOver === "" || d.idOver == null ? String(c.idRec(j)) : String(d.idOver).trim();
        return { idOver: over || "0", idCustom: String(d.idCustom || "").trim() };
      }
      case 11: return { team: d.team.map(member) };
      case 31: {
        var dr = c.state.draft || {};
        return { team: d.team.map(member).concat([member({ first: dr.first, last: dr.last, role: dr.role || "Cashier", email: dr.email, phone: dr.phone })]) };
      }
      default: return {};
    }
  }
  function fromServer(a) {
    var d = {};
    ["operatingName", "bizName", "nameOk", "legalOk", "street", "unit", "city", "region", "postal", "country_addr", "addrVerified", "addrManual", "msbNumber", "regSkipped", "countLater", "compName", "compEmail", "idCustom"].forEach(function (k) { if (a[k] !== undefined) d[k] = a[k]; });
    if (a.shops === "one") d.shopCount = 1;
    else if (a.shopCount) d.shopCount = a.shopCount;
    if (Array.isArray(a.currencies)) d.currencies = a.currencies;
    if (a.complianceMode) d.complianceMode = a.complianceMode === "else" ? "other" : "me";
    if (a.idOver !== undefined) d.idOver = String(a.idOver);
    if (Array.isArray(a.team)) d.team = a.team.map(function (t) { return { name: t.name || (t.first + " " + t.last).trim(), first: t.first, last: t.last, role: t.role, email: t.email || "", phone: t.phone || "", mode: t.mode || (t.email ? "email" : "noemail") }; });
    if (a.count && typeof a.count === "object") {
      d.count = {}; d.float = {};
      Object.keys(a.count).forEach(function (cc) {
        var e = a.count[cc] || {};
        if (e.mode === "notes") { var den = {}; Object.keys(e.notes || {}).forEach(function (v) { den[v] = String(e.notes[v]); }); d.count[cc] = { den: den, coins: e.coins || "", done: !!e.done }; }
        else if (e.mode === "total") { d.float[cc] = e.total || ""; d.count[cc] = { done: !!e.done }; }
        else d.count[cc] = { done: !!e.done };
      });
    }
    return d;
  }
})();
