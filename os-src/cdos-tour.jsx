/* ============================================================
   CurrencyDesk OS — first-run tour, on the desk

   The decisions (who, which steps, whether they have already
   skipped or finished) live in cdos-tour.js so they can be tested
   without a browser. This file only puts that answer on screen.

   It does not open or raise a window. A step runs when its window
   is already open and is the one in front. Until then the card
   shows a plain button — "Open the till", "Open the dashboard" —
   and that click is the only call to openApp. A timer that opened
   the till on its own raised it over whatever the person (or a
   seam test) had just opened, and the click landed on the till.

   The card uses the desk's own type and colours. It is not a
   scrim and it does not add a dock icon. Skip is on every step.
   Escape skips too — a person mid-count should be able to leave
   without hunting for the button.

   Once they skip or finish, the choice is written to
   `cdos_tour_v1` and `CDOS_PERSIST.save()` is asked to flush.
   The four-second autosave would usually be enough; a refresh
   in those four seconds would restore the server copy and show
   the tour again, which is the bug the flush is there to avoid.
   On a desk with no server session the flush is a no-op and the
   localStorage key is the copy that survives, the same way the
   rest of an offline desk survives.
   ============================================================ */
(function () {
  const { useState, useEffect, useLayoutEffect, useRef } = React;
  const api = function () { return window.CDOS_TOUR; };

  function boxOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function overlaps(a, b) {
    return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  }

  /* Everything the card must not sit on. Open windows (the shop, the
     till, and the ledger the desk opens on its own), the customer sheet
     when the step is inside one, the anchor itself, and the menu,
     tenant, and app bars. "New transaction" is named because it sits on
     the ledger beside the till — a card in that gap covers the control
     the till step is standing next to. */
  function keepClear(anchorEl) {
    var rects = [];
    function add(el) {
      var box = boxOf(el);
      if (box) rects.push(box);
    }
    document.querySelectorAll('.win.show').forEach(add);
    ['menubar', 'tenantbar', 'appbar'].forEach(function (id) { add(document.getElementById(id)); });
    document.querySelectorAll('[data-tour="shop"], [data-tour="file-folder"], [data-tour="till-count"]').forEach(add);
    if (anchorEl) {
      add(anchorEl);
      var sheet = anchorEl.closest('.fixed');
      if (sheet) add(sheet.firstElementChild || sheet);
    }
    document.querySelectorAll('button').forEach(function (b) {
      if ((b.textContent || '').replace(/\s+/g, ' ').trim() === 'New transaction') add(b);
    });
    return rects;
  }

  function overlapArea(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 1 || h <= 1) return 0;
    return w * h;
  }

  /* Buttons, links, and fields that can take a click right now.
     A control under another window cannot, and treating it as an
     obstacle pushes Skip onto the one that is actually on top.
     The tour's own buttons are set aside for the sample: if they
     stayed, the control underneath would look covered and Skip
     would be left sitting on it. */
  function controlsToMiss() {
    var tour = document.querySelector('.cdos-tour');
    var hidden = [];
    if (tour) {
      tour.querySelectorAll('button').forEach(function (b) {
        hidden.push([b, b.style.pointerEvents]);
        b.style.pointerEvents = 'none';
      });
    }
    var rects = [];
    try {
      document.querySelectorAll('button, a, input, textarea, select, [role="button"]').forEach(function (el) {
        if (el.closest && el.closest('.cdos-tour')) return;
        var box = boxOf(el);
        if (!box) return;
        var top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!top || (top !== el && !el.contains(top))) return;
        rects.push(box);
      });
    } finally {
      hidden.forEach(function (pair) { pair[0].style.pointerEvents = pair[1]; });
    }
    return rects;
  }

  /* Skip and Open, as offsets from the card's corner. Measured from
     the card after its width is set — a guessed strip was wide of
     "Open the dashboard" at one width and still left Skip on a
     button at another. The fallback is that strip, used only before
     the buttons have been drawn. */
  function buttonOffsets(node) {
    var card = node.getBoundingClientRect();
    if (!card || card.width < 2) return null;
    var zones = [];
    node.querySelectorAll('.cdos-tour-skip, .cdos-tour-next').forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      zones.push({ dx: r.left - card.left, dy: r.top - card.top, w: r.width, h: r.height });
    });
    return zones.length ? zones : null;
  }

  function fallbackOffsets(cardW, cardH) {
    var top = Math.max(0, cardH - 50);
    return [
      { dx: 8, dy: top, w: 70, h: 44 },
      { dx: Math.max(8, cardW - 196), dy: top, w: 188, h: 44 },
    ];
  }

  function actionHits(origin, controls, zones) {
    var hits = 0;
    var pad = 6;
    for (var z = 0; z < zones.length; z++) {
      var zone = {
        left: origin.left + zones[z].dx - pad,
        top: origin.top + zones[z].dy - pad,
        right: origin.left + zones[z].dx + zones[z].w + pad,
        bottom: origin.top + zones[z].dy + zones[z].h + pad,
      };
      for (var i = 0; i < controls.length; i++) {
        if (overlaps(zone, controls[i])) hits += 1;
      }
    }
    return hits;
  }

  /* One pass over a list of candidate spots. A clean spot has Skip
     and Open on no control, and the card clear of the windows and
     the chrome. The first clean spot wins. */
  function searchSpots(spots, avoid, controls, cardW, cardH, zones, seed) {
    var margin = 14;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var best = seed || null;
    var bestHits = best ? best.hits : Infinity;
    var bestArea = best ? best.overlap : Infinity;
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      if (s.left < margin || s.top < margin) continue;
      if (s.left + cardW > vw - margin || s.top + cardH > vh - margin) continue;
      var card = { left: s.left, top: s.top, right: s.left + cardW, bottom: s.top + cardH };
      var hits = actionHits(card, controls, zones);
      var area = 0;
      for (var j = 0; j < avoid.length; j++) area += overlapArea(card, avoid[j]);
      var better = hits < bestHits || (hits === bestHits && area < bestArea);
      if (!better) continue;
      bestHits = hits;
      bestArea = area;
      best = { left: card.left, top: card.top, width: cardW, overlap: area, hits: hits };
      if (hits === 0 && area === 0) return best;
    }
    return best;
  }

  /* A spot in a gap, using the card's real width and height. Skip and
     Open have to miss every control that is actually on top; the rest
     of the card does not, because it does not take a click. Narrower
     cards are tried by the caller so a profile sheet (which leaves
     only a gutter) still has a place for Skip. The spots beside the
     anchor come first. The full-screen grid is only for when none
     of those is clean. */
  function placeCard(avoid, controls, cardW, cardH, zones) {
    var margin = 14;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    /* Corners, then the gaps beside the anchor and the other things
       the card must keep clear of. These are a handful of spots. */
    var near = [
      { left: vw - cardW - margin, top: vh - cardH - margin },
      { left: margin, top: vh - cardH - margin },
      { left: vw - cardW - margin, top: margin },
      { left: margin, top: margin },
    ];
    avoid.forEach(function (r) {
      near.push({ left: r.right + margin, top: Math.max(margin, r.top) });
      near.push({ left: r.left - cardW - margin, top: Math.max(margin, r.top) });
      near.push({ left: Math.max(margin, Math.min(r.left, vw - cardW - margin)), top: r.bottom + margin });
      near.push({ left: Math.max(margin, Math.min(r.right - cardW, vw - cardW - margin)), top: r.top - cardH - margin });
    });
    var best = searchSpots(near, avoid, controls, cardW, cardH, zones, null);
    if (best && best.hits === 0 && best.overlap === 0) return best;
    /* The grid is the whole screen, step by step. It is only walked
       when none of the spots above is clean — a till with windows
       open is that case, and walking it on a timer is what made
       counting cash expensive. */
    var grid = [];
    for (var y = margin; y + cardH <= vh - margin; y += 28) {
      for (var x = margin; x + cardW <= vw - margin; x += 28) grid.push({ left: x, top: y });
    }
    best = searchSpots(grid, avoid, controls, cardW, cardH, zones, best);
    if (best) return best;
    return { left: margin, top: Math.max(margin, vh - cardH - margin), width: cardW, overlap: Infinity, hits: Infinity };
  }

  /* The window in front. `active` is the topmost window, the one
     that receives the click. Open underneath is not in front. */
  function frontWin() {
    var win = document.querySelector('.win.show.active');
    if (!win || win.classList.contains('min')) return null;
    return win;
  }

  /* A whole pixel is enough. Sub-pixel jitter would otherwise look
     like the desk moved and sit the card again for nothing. */
  function roundRect(r) {
    if (!r || r.width < 2 || r.height < 2) return '';
    return Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
  }

  /* Which window is in front. The app name lives on the window body
     (`data-screen-label`); the rectangle tells two copies of the same
     app apart. */
  function frontKey(win) {
    if (!win) return '';
    var label = win.querySelector('[data-screen-label]');
    var name = label ? (label.getAttribute('data-screen-label') || '') : '';
    return name + '@' + roundRect(win.getBoundingClientRect());
  }

  /* How many controls can take a click right now. A control inside a
     window that is not in front cannot. This does not sample
     elementFromPoint and does not touch pointer-events — that work
     belongs to a real sit, not to the once-a-second look. Counting
     this way also ignores the tour card itself, so sitting the card
     does not change the count and sit itself again. */
  function onTopCount() {
    var front = frontWin();
    var n = 0;
    var list = document.querySelectorAll('button, a, input, textarea, select, [role="button"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.closest && el.closest('.cdos-tour')) continue;
      var host = el.closest ? el.closest('.win') : null;
      if (host && host !== front) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      n += 1;
    }
    return n;
  }

  /* Cheap read of "did the desk change". The front window and where
     it sits, where this step's anchor sits, the viewport, and how
     many controls are on top. */
  function deskSignature(current) {
    var anchor = current ? document.querySelector('[data-tour="' + current.anchor + '"]') : null;
    return [
      frontKey(frontWin()),
      roundRect(anchor && anchor.getBoundingClientRect()),
      window.innerWidth + 'x' + window.innerHeight,
      String(onTopCount()),
    ].join('|');
  }

  function frontIs(app) {
    var win = frontWin();
    if (!win) return false;
    if (app === 'dashboard') return !!win.querySelector('[data-tour="shop"]');
    if (app === 'till') return !!win.querySelector('[data-tour="till"]');
    if (app === 'clients') return !!win.querySelector('[data-tour="clients"]');
    return false;
  }

  /* The words on the button. Till and dashboard are named the way a
     person at the desk says them; the clients window uses the same
     shape. The button is the only way this file opens anything. */
  function openLabel(app) {
    if (app === 'till') return 'Open the till';
    if (app === 'dashboard') return 'Open the dashboard';
    if (app === 'clients') return 'Open the clients';
    return 'Open it';
  }

  /* A window starts at opacity 0 and only then gains `.show`. An
     anchor inside a window that has not appeared yet is not a screen
     a person can see. It also has to be the window in front — a
     window left open underneath still has `.show`, and pointing at
     it would mean raising it, which is the thing this file must
     not do. A customer sheet is not a window; the clients window
     has to be the one in front as well. */
  function visibleBox(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var win = el.closest ? el.closest('.win') : null;
    if (win && (!win.classList.contains('show') || !win.classList.contains('active') || win.classList.contains('min'))) return null;
    var rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    var host = win ? win.getBoundingClientRect() : null;
    return {
      top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right,
      host: host ? { top: host.top, left: host.left, width: host.width, height: host.height, bottom: host.bottom, right: host.right } : null,
    };
  }

  function FirstRun({ role, staffId, apps, clients, openApp, openClient, paused }) {
    const tour = api();
    const [run, setRun] = useState(null);   // null until read; false once declined or empty
    const [box, setBox] = useState(null);
    const [frame, setFrame] = useState(null);
    const cardRef = useRef(null);
    const clientsRef = useRef(clients);
    const openAppRef = useRef(openApp);
    const openClientRef = useRef(openClient);
    clientsRef.current = clients;
    openAppRef.current = openApp;
    openClientRef.current = openClient;
    const sawRef = useRef(false);
    const personRef = useRef(null);
    /* A joined string, not the array. The shell builds a new array on
       every render; depending on it would restart the tour forever. */
    const appsKey = (apps || []).join('|');
    const clientReady = !!(tour && tour.hasClient(clients));

    /* Decide per person. A colleague (different staff id) is read
       again, so one skip does not dismiss theirs. Clients often
       arrive a moment after the desk does; if that happens while
       this person is still on the first step, the folder steps are
       added. Past the first step, new steps are appended rather
       than rewinding the tour. A skip or a finish is already in
       the preference document, and shouldShow stays false. */
    useEffect(() => {
      if (personRef.current !== staffId) {
        personRef.current = staffId;
        sawRef.current = false;
        setBox(null);
      }
      if (!tour || !tour.shouldShow(tour.read(window.localStorage), staffId)) {
        setRun(false);
        return;
      }
      var steps = tour.stepsFor({
        role: role,
        apps: appsKey ? appsKey.split('|') : apps,
        hasClient: tour.hasClient(clientsRef.current),
      });
      setRun(function (cur) {
        if (cur && cur.steps && cur.index > 0) {
          var have = {};
          cur.steps.forEach(function (s) { have[s.id] = 1; });
          var extra = steps.filter(function (s) { return !have[s.id]; });
          if (!extra.length) return cur;
          return { steps: cur.steps.concat(extra), index: cur.index };
        }
        if (!steps.length) return false;
        if (cur && cur.steps && cur.steps.length === steps.length) {
          var same = cur.steps.every(function (s, i) { return s.id === steps[i].id; });
          if (same) return cur;
        }
        return { steps: steps, index: 0 };
      });
    }, [staffId, role, appsKey, clientReady]);

    const step = run && run.steps ? run.steps[run.index] : null;

    /* The anchor, but only when its window is the one in front.
       A customer sheet has no window of its own, so the clients
       window has to be that front window. */
    function readyBox(current) {
      if (!current) return null;
      var el = document.querySelector('[data-tour="' + current.anchor + '"]');
      if (!el) return null;
      var win = el.closest ? el.closest('.win') : null;
      if (!win && !frontIs(current.app)) return null;
      return visibleBox(el);
    }

    /* The window for this step is in front, and the anchor is still
       not on it. That is a screen the product does not draw (search
       with no papers, identification with no standing) — drop it.
       A window that is not in front is not this case. The person has
       not opened it, and this file will not open it for them. */
    function absentWhileFront(current) {
      if (!current || !frontIs(current.app)) return false;
      if (document.querySelector('[data-tour="' + current.anchor + '"]')) return false;
      if (!current.needsClient) return true;
      /* The file is a sheet on a customer. Until that sheet is open
         the anchor is supposed to be missing. */
      return !!document.querySelector('.fixed [data-tour="file-folder"], .fixed [data-tour="identification"]');
    }

    /* Sit the card so Skip and Open are not on top of a desk control.
       This is the expensive call — every on-top control, then the
       spots, then the grid if those spots are not clean. The watch
       below calls it only when deskSignature changes. It never
       opens a window. */
    function sitCard() {
      var node = cardRef.current;
      if (!node || !step) return;
      var anchorEl = document.querySelector('[data-tour="' + step.anchor + '"]');
      var avoid = keepClear(anchorEl);
      var controls = controlsToMiss();
      var widths = [320, 280, 248];
      var chosen = null;
      for (var i = 0; i < widths.length; i++) {
        node.style.width = widths[i] + 'px';
        var zones = buttonOffsets(node) || fallbackOffsets(widths[i], node.offsetHeight);
        var spot = placeCard(avoid, controls, widths[i], node.offsetHeight, zones);
        if (!chosen || spot.hits < chosen.hits || (spot.hits === chosen.hits && spot.overlap < chosen.overlap)) chosen = spot;
        if (spot.hits === 0 && spot.overlap === 0) break;
      }
      if (!chosen) return;
      setFrame(function (cur) {
        if (cur && cur.left === chosen.left && cur.top === chosen.top && cur.width === chosen.width) return cur;
        return chosen;
      });
    }

    /* Watch the desk. Read only — this effect must not call openApp
       or openClient. Pause is not a dependency: locking the desk and
       unlocking it must not start the watch over, and must not open
       anything. The click handler below is the only open.

       Sitting the card measures every control and may walk a grid of
       the whole screen. That used to run several times a second for
       as long as the card was up, including on the till while someone
       counted cash. The signature above is the cheap read. The card
       is sat again only when it changes (a new control, the window
       moved, the viewport). While it holds, the watch looks at most
       once a second. A resize of the browser or of the front window
       still sits the card, after a short pause, so a stretch is not
       left until that second is up. */
    useEffect(() => {
      if (!run || !step) return undefined;
      var cancelled = false;
      var timer = 0;
      var resizeTimer = 0;
      var scrolled = false;
      var lastSig = '';
      var absentSince = 0;
      var observed = null;
      var ro = typeof ResizeObserver === 'function'
        ? new ResizeObserver(function () { nudge(); })
        : null;

      function dropStep() {
        setRun(function (cur) {
          if (!cur || !cur.steps) return cur;
          var next = tour.dropUnplaced(cur.steps, [step.anchor]);
          if (next.length === cur.steps.length) return cur;
          if (!next.length) return false;
          /* Past the last step that still exists: the walk is over.
             `complete` asks the effect below to record finished, and
             only if a step was actually shown. */
          if (cur.index >= next.length) return { steps: next, index: next.length, complete: true };
          return { steps: next, index: cur.index };
        });
      }

      function followFront() {
        if (!ro) return;
        var win = frontWin();
        if (win === observed) return;
        ro.disconnect();
        observed = win;
        if (win) ro.observe(win);
      }

      function check() {
        if (cancelled || !tour) return;
        followFront();
        var boxNow = readyBox(step);
        if (boxNow) {
          absentSince = 0;
          var el = document.querySelector('[data-tour="' + step.anchor + '"]');
          if (el && !scrolled) {
            scrolled = true;
            try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
            boxNow = readyBox(step) || boxNow;
          }
          sawRef.current = true;
          var next = {
            top: Math.round(boxNow.top), left: Math.round(boxNow.left),
            width: Math.round(boxNow.width), height: Math.round(boxNow.height),
            bottom: Math.round(boxNow.bottom), right: Math.round(boxNow.right),
            host: boxNow.host,
          };
          setBox(function (cur) {
            if (cur && cur.top === next.top && cur.left === next.left && cur.width === next.width && cur.height === next.height) return cur;
            return next;
          });
        } else {
          setBox(function (cur) { return cur ? null : cur; });
          /* About two seconds of the right window being in front
             with no anchor. Past that the screen is not going to
             draw it. Timed, not counted, so a slower look does not
             leave a missing step up for longer. */
          if (absentWhileFront(step)) {
            if (!absentSince) absentSince = Date.now();
            if (Date.now() - absentSince >= 2000) dropStep();
          } else {
            absentSince = 0;
          }
        }
        /* No card while the desk is locked. Sitting then would
           measure a screen the person cannot see. */
        if (cardRef.current) {
          var sig = deskSignature(step);
          if (sig !== lastSig) {
            lastSig = sig;
            sitCard();
          }
        }
      }

      function arm(ms) {
        window.clearTimeout(timer);
        timer = window.setTimeout(function () {
          check();
          if (!cancelled) arm(1000);
        }, ms);
      }

      /* Resize is the one event that does not wait for the
         one-second look. Debounced so a drag does not sit on
         every pointer move. */
      function nudge() {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(function () {
          if (!cancelled) check();
        }, 250);
      }

      window.addEventListener('resize', nudge);
      arm(180);
      return function () {
        cancelled = true;
        window.clearTimeout(timer);
        window.clearTimeout(resizeTimer);
        window.removeEventListener('resize', nudge);
        if (ro) ro.disconnect();
      };
    }, [run && run.index, step && step.id, staffId]);

    useEffect(() => {
      if (!run || !run.complete || !sawRef.current) return;
      if (!tour) return;
      tour.record(window.localStorage, staffId, 'finished', tour.kindForRole(role));
      try {
        if (window.CDOS_PERSIST && typeof window.CDOS_PERSIST.save === 'function') window.CDOS_PERSIST.save();
      } catch (e) {}
      setRun(false);
    }, [run && run.complete, staffId, role]);

    function persist(status) {
      if (!tour) return;
      tour.record(window.localStorage, staffId, status, tour.kindForRole(role));
      try {
        if (window.CDOS_PERSIST && typeof window.CDOS_PERSIST.save === 'function') {
          window.CDOS_PERSIST.save();
        }
      } catch (e) {}
    }

    function skip() {
      persist('skipped');
      setRun(false);
      setBox(null);
    }

    function next() {
      if (!run) return;
      if (run.index >= run.steps.length - 1) {
        persist('finished');
        setRun(false);
        setBox(null);
        return;
      }
      setBox(null);
      setRun({ steps: run.steps, index: run.index + 1 });
    }

    /* The only open in this file. The look timer does not call it,
       and pause turning on or off does not call it either. A customer
       step opens that customer's record — openClient is what raises
       the clients window and the file together — and every other step
       opens its own app. */
    function askOpen() {
      if (!step) return;
      try {
        if (step.needsClient && tour && openClientRef.current) {
          var name = tour.clientForTour(clientsRef.current);
          if (name) { openClientRef.current(name); return; }
        }
        if (step.app && openAppRef.current) openAppRef.current(step.app);
      } catch (e) {}
    }

    /* Rebound when the step or the person changes, so Escape skips
       the tour that is actually on screen. No dependency array would
       rebind on every render for the same result. */
    useEffect(() => {
      if (!run || paused) return undefined;
      function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        skip();
      }
      window.addEventListener('keydown', onKey);
      return function () { window.removeEventListener('keydown', onKey); };
    }, [run, paused, staffId, role]);

    /* Measure the card, then sit it in a gap. Widths are tried widest
       first; the first one that misses the shop figures, the drawer,
       the count, the file list, and New transaction wins. */
    useLayoutEffect(() => {
      if (!run || !step || paused) { setFrame(null); return; }
      sitCard();
    }, [box && box.top, box && box.left, box && box.width, box && box.height, step && step.id, run && run.index, paused]);

    /* The card is up either way. Without a front window it asks the
       person to open one. The ring and Next wait until that window
       is the one in front — drawing them sooner is how the tour used
       to raise a window on its own. */
    if (!run || !step || paused) return null;

    var last = run.index >= run.steps.length - 1;
    var cardStyle = frame
      ? { left: frame.left, top: frame.top, width: frame.width }
      : { left: 16, top: 16, width: 320, visibility: 'hidden' };

    return ReactDOM.createPortal(
      <div className="cdos-tour" data-tour-root="1">
        {box && <div className="cdos-tour-ring" style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }} />}
        <div ref={cardRef} className="cdos-tour-card" role="dialog" aria-modal="false" aria-labelledby="cdos-tour-title" style={cardStyle}>
          <div className="cdos-tour-kicker">First run · {run.index + 1} of {run.steps.length}</div>
          <div id="cdos-tour-title" className="cdos-tour-title">{step.title}</div>
          <p className="cdos-tour-body">{step.body}</p>
          <div className="cdos-tour-actions">
            <button type="button" className="cdos-tour-skip" onClick={skip}>Skip</button>
            {box
              ? <button type="button" className="cdos-tour-next" onClick={next}>{last ? 'Done' : 'Next'}</button>
              : <button type="button" className="cdos-tour-next" onClick={askOpen}>{openLabel(step.app)}</button>}
          </div>
        </div>
      </div>,
      document.body);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { FirstRun: FirstRun });
})();
