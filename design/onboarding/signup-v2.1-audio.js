/* One audible response per click. Waking audio never plays a tone. */
(function () {
  "use strict";
  var CD = window.__cdOnb, mount = CD.mount, priced = CD.priced;
  CD.mount = function (c) {
    var press = null, lastSound = -Infinity, waking = null;
    c._warm = function () {
      if (CD.muted) return;
      try {
        var ac = c._bus(); if (!ac) return;
        if ((ac.state === "suspended" || ac.state === "interrupted") && !waking) {
          waking = Promise.resolve(ac.resume()).catch(function () {}).then(function () { waking = null; });
        }
        if (!c._unlocked) {
          var b = ac.createBuffer(1, 1, 22050), src = ac.createBufferSource();
          src.buffer = b; src.connect(ac.destination); src.start(0); c._unlocked = true;
        }
      } catch (e) { /* Unsupported or denied audio never blocks a form action. */ }
    };
    c._clickMark = function () {
      var current = press = { at: performance.now(), used: false };
      setTimeout(function () { if (press === current) press = null; }, 0);
    };
    c._tone = function (kind) {
      var current = press;
      if (CD.muted || !current || current.used) return;
      current.used = true;
      if (kind === "tap" && current.at - lastSound < 80) return;
      function paint() {
        requestAnimationFrame(function () {
          if (CD.muted || performance.now() - current.at > 180 || !c._ac || c._ac.state !== "running") return;
          lastSound = performance.now(); c._toneNow(kind);
        });
      }
      if (waking) waking.then(paint); else paint();
    };
    c._tapSnd = function (e) {
      var el = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!el || el.disabled || el.closest("[data-review]") || (c._meta && c._meta.type === "pin" && !el.closest("[data-foot]"))) return;
      c._tone("tap");
    };
    return mount(c);
  };
  CD.priced = function (c, r) {
    var R = priced(c, r);
    R.soundLabel = CD.muted ? "Sound off" : "Sound on";
    R.soundOn = !CD.muted;
    R.onSound = function () { CD.toggleSound(); c.forceUpdate(); };
    R.accountKey = function (e) { e.stopPropagation(); if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary").focus(); } };
    return R;
  };
})();
