/* Real app recordings and a user-controlled still tour when motion is reduced. */
(function () {
  'use strict';
  var CD = window.__cdOnb, mount = CD.mount, priced = CD.priced;
  var media = window.matchMedia('(prefers-reduced-motion: reduce)');
  function sequence(c) { var t = c.state.tour; return t && (c.SEQS[t.seq] || c.TOUR); }
  CD.mount = function (c) {
    CD.h.call("GET", "/api/signup/tour-pack").then(function (r) {
      if (r.status === 200 && r.body && r.body.example === true) { CD.tourPack = r.body.pack; c.forceUpdate(); }
    }).catch(function () {});
    var vals = c._tourVals.bind(c), tick = c._tourTick.bind(c), play = c._playVids.bind(c);
    c.tourOpen = function (name) {
      c._tourReturn = document.activeElement; clearInterval(c._tourI);
      c.setState({ tour: { k: 0, t0: Date.now(), seq: name || 'tour' } }, function () {
        var close = document.querySelector('[data-tour] [data-tour-close]'); if (close) close.focus();
        var box = document.querySelector('[data-tourbox]');
        if (box) {
          function fit() { box.style.setProperty('--tour-scale', String(box.clientWidth / 960)); }
          fit(); if (c._tourResize) c._tourResize.disconnect(); c._tourResize = new ResizeObserver(fit); c._tourResize.observe(box);
        }
      });
      if (!media.matches) c._tourI = setInterval(function () { c._tourTick(); }, 150);
    };
    c.tourClose = function () {
      clearInterval(c._tourI); if (c._tourResize) c._tourResize.disconnect(); c.setState({ tour: null }, function () {
        if (c._tourReturn && c._tourReturn.isConnected) c._tourReturn.focus();
      });
    };
    c._tourTick = function () { if (!media.matches) tick(); };
    c._playVids = function () {
      if (media.matches) document.querySelectorAll('video').forEach(function (v) { v.pause(); });
      else play();
    };
    c._tourVals = function () {
      var R = vals(), t = c.state.tour, seq = sequence(c), st = seq && seq[t.k];
      R.tourInert = t ? '' : undefined; R.tourReduced = media.matches ? 'true' : 'false';
      if (!st) return R;
      R.tourPlayClip = R.tourIsClip && !media.matches; R.tourStillClip = R.tourIsClip && media.matches;
      R.tourSrc = '/web/signup/recordings/' + (st.src || 'home') + '.webm';
      R.tourPoster = '/web/signup/recordings/' + (st.src || 'home') + '-poster.png';
      R.tourWhere = (st.kind === 'scene' ? 'Illustrative workflow' : 'Recorded in a synthetic desk') + (st.where ? ' · ' + st.where : '');
      if (media.matches) R.tourCap = (st.caps || []).map(function (cap) { return cap[1]; }).join(' ');
      R.tourBackDisabled = t.k === 0; R.tourNextDisabled = t.k === seq.length - 1;
      function move(by) { clearInterval(c._tourI); c.setState({ tour: { k: Math.max(0, Math.min(seq.length - 1, t.k + by)), t0: Date.now(), seq: t.seq } }); }
      R.onTourPrevious = function () { move(-1); }; R.onTourNext = function () { move(1); };
      R.onTourKey = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c.tourClose(); }
        if (e.key !== 'Tab') return;
        var controls = Array.from(e.currentTarget.querySelectorAll('button:not(:disabled),[tabindex="0"]')).filter(function (el) { return el.getClientRects().length; });
        var first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      var pack = CD.pack || CD.tourPack || {}, d = c.state.data;
      R.tourHomeCurrency = pack.homeCurrency || '—';
      R.tourForeignCurrency = pack.exampleForeignCurrency || '—';
      R.tourReport = pack.reportName || 'Cash report';
      R.tourIdLine = d.idOver === '0' ? 'Every exchange requires ID.' : 'Your ID line: ' + (d.idOver || (pack.idLine && pack.idLine.recommended) || 'Not configured') + ' ' + (pack.idLine && pack.idLine.currency || '');
      R.tourOfficer = (d.complianceMode === 'else' ? d.compName : d.ownerName) || 'Your compliance officer';
      R.tourFileLabel = 'Review for ' + (pack.regulator || 'your regulator') + ' →';
      return R;
    };
    var observedMotion = media.matches;
    function changed() {
      observedMotion = media.matches;
      clearInterval(c._tourI); if (c.state.tour && !media.matches) c._tourI = setInterval(function () { c._tourTick(); }, 150);
      c._playVids(); c.forceUpdate();
    }
    // Manual navigation stops the tour clock. Reconcile on actual playback too,
    // so a delayed preference notification cannot leave a moving clip on screen.
    // No timer or render on ordinary playback; pause before replacing the video.
    function playback(e) {
      if (e.target.matches('[data-tour] video,[data-product] video') && media.matches !== observedMotion) changed();
    }
    media.addEventListener('change', changed);
    document.addEventListener('timeupdate', playback, true);
    var unmount = c.componentWillUnmount.bind(c);
    c.componentWillUnmount = function () { media.removeEventListener('change', changed); document.removeEventListener('timeupdate', playback, true); if (c._tourResize) c._tourResize.disconnect(); unmount(); };
    return mount(c);
  };
  CD.priced = function (c, r) {
    var R = priced(c, r);
    R.exRecording = !!R.exLive; R.exStill = R.exRecording && media.matches;
    if (R.exStill) R.exLive = false;
    if (R.exVidSrc) R.exVidSrc = R.exVidSrc.replace('/shots/', '/recordings/').replace('.mp4', '.webm');
    if (R.exShotSrc) R.exShotSrc = R.exShotSrc.replace('/shots/', '/recordings/').replace('-poster.jpg', '-poster.png');
    return R;
  };
})();
