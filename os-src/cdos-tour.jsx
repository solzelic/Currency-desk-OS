/* ============================================================
   CurrencyDesk OS — first-run tour, on the desk

   The decisions (who, which steps, whether they have already
   skipped or finished) live in cdos-tour.js so they can be tested
   without a browser. This file only puts that answer on screen:
   it opens the real app, finds the real anchor, and draws a card
   beside it.

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
  const { useState, useEffect, useRef } = React;
  const api = function () { return window.CDOS_TOUR; };

  /* The card sits beside the window, not on the thing it is
     describing. A wide anchor (the shop masthead, the till header)
     has no room to its right inside the window, so the first choice
     is outside the window itself. */
  function placeBeside(anchor, host) {
    var cardW = Math.min(340, window.innerWidth - 24);
    var cardH = 210;
    var gap = 16;
    var bounds = host || anchor;
    var spots = [
      { left: bounds.right + gap, top: bounds.top },
      { left: bounds.left - cardW - gap, top: bounds.top },
      { left: bounds.left, top: bounds.bottom + gap },
      { left: anchor.left, top: anchor.bottom + gap },
      { left: anchor.left, top: anchor.top - cardH - gap },
    ];
    for (var i = 0; i < spots.length; i++) {
      var spot = spots[i];
      if (spot.left >= 12 && spot.top >= 12 && spot.left + cardW <= window.innerWidth - 12 && spot.top + cardH <= window.innerHeight - 12) {
        return { left: spot.left, top: spot.top, width: cardW };
      }
    }
    var left = Math.max(12, Math.min(anchor.left, window.innerWidth - cardW - 12));
    var top = Math.max(12, Math.min(anchor.bottom + gap, window.innerHeight - cardH - 12));
    return { left: left, top: top, width: cardW };
  }

  /* A window starts at opacity 0 and only then gains `.show`. An
     anchor inside a window that has not appeared yet is not a screen
     a person can see, so the card waits. */
  function visibleBox(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var win = el.closest ? el.closest('.win') : null;
    if (win && (!win.classList.contains('show') || win.classList.contains('min'))) return null;
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

    useEffect(() => {
      if (!run || !step || paused) return undefined;
      var cancelled = false;
      var tries = 0;
      var timer = 0;
      var placed = false;

      function openSurface() {
        try {
          if (step.needsClient) {
            var name = tour.clientForTour(clientsRef.current);
            if (name && openClientRef.current) openClientRef.current(name);
            else if (step.app && openAppRef.current) openAppRef.current(step.app);
          } else if (step.app && openAppRef.current) {
            openAppRef.current(step.app);
          }
        } catch (e) {}
      }

      function look() {
        if (cancelled || !tour) return;
        tries += 1;
        /* Keep asking until the window is actually up. The desk opens
           the ledger on its own a moment after sign-in; one call, made
           too early, loses that race and the card is left on an empty
           desktop. There is no tab to click here — the close panel is
           not a step, and clicking it is how a close error gets on screen. */
        if (!placed) openSurface();
        var el = document.querySelector('[data-tour="' + step.anchor + '"]');
        var boxNow = visibleBox(el);
        if (boxNow) {
          try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
          boxNow = visibleBox(el) || boxNow;
          placed = true;
          sawRef.current = true;
          setBox(boxNow);
          return;
        }
        /* Twelve looks is about a second and a half. Past that the
           screen is not going to draw this anchor — drop the step. */
        if (tries >= 12) {
          setRun(function (cur) {
            if (!cur || !cur.steps) return cur;
            var next = tour.dropUnplaced(cur.steps, [step.anchor]);
            if (next.length === cur.steps.length) return cur;
            /* The missing step was the current one. The step now at
               this index is the one that followed it. If nothing
               follows, leave the tour up only when earlier steps
               remain — the card still has Skip. An empty list hides
               it without recording, so a desk whose screens were
               slow rather than absent can try again next sign-in. */
            if (!next.length) return false;
            /* Past the last step that still exists: the walk is over.
               `complete` asks the effect below to record finished,
               and only if a step was actually shown. */
            if (cur.index >= next.length) return { steps: next, index: next.length, complete: true };
            return { steps: next, index: cur.index };
          });
          return;
        }
        timer = window.setTimeout(look, 120);
      }

      timer = window.setTimeout(look, 180);
      function follow() {
        if (!placed) return;
        var el = document.querySelector('[data-tour="' + step.anchor + '"]');
        var boxNow = visibleBox(el);
        if (!boxNow) return;
        setBox(boxNow);
      }
      window.addEventListener('resize', follow);
      window.addEventListener('scroll', follow, true);
      return function () {
        cancelled = true;
        window.clearTimeout(timer);
        window.removeEventListener('resize', follow);
        window.removeEventListener('scroll', follow, true);
      };
    }, [run && run.index, step && step.id, staffId, paused]);

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

    /* No card until the screen it describes is open. A card in the
       corner of an empty desktop is the bug this guard exists for. */
    if (!run || !step || paused || !box) return null;

    var spot = placeBeside(box, box.host);
    var last = run.index >= run.steps.length - 1;
    var cardStyle = { left: spot.left, top: spot.top, width: spot.width };

    return ReactDOM.createPortal(
      <div className="cdos-tour" data-tour-root="1">
        {box && <div className="cdos-tour-ring" style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }} />}
        <div className="cdos-tour-card" role="dialog" aria-modal="false" aria-labelledby="cdos-tour-title" style={cardStyle}>
          <div className="cdos-tour-kicker">First run · {run.index + 1} of {run.steps.length}</div>
          <div id="cdos-tour-title" className="cdos-tour-title">{step.title}</div>
          <p className="cdos-tour-body">{step.body}</p>
          <div className="cdos-tour-actions">
            <button type="button" className="cdos-tour-skip" onClick={skip}>Skip</button>
            <button type="button" className="cdos-tour-next" onClick={next}>{last ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>,
      document.body);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { FirstRun: FirstRun });
})();
