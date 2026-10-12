/* Toast — one line after a save. It stays for 4 seconds. It sits
   16px above the sticky action, or 16px above the tab bar, when
   that band covers no control and does not cover the sheet copy.
   When it would, it sits 16px above the next control, in the open
   band, so the question and the hint stay readable. Taps pass
   through the line. The action still takes them. The words go into
   a live region after the toast mounts, so a screen reader hears
   them. An action toast stays up while that action has focus. */
(function () {
  const { Ic } = window.CDOS;
  const TOAST_MS = 4000;

  function anchorTop() {
    const stickies = document.querySelectorAll(".phone-sticky");
    for (let i = 0; i < stickies.length; i++) {
      const box = stickies[i].getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return box.top;
    }
    const dock = document.getElementById("phone-dock");
    return dock ? dock.getBoundingClientRect().top : window.innerHeight;
  }

  function visibleBoxes(selector) {
    const nodes = document.querySelectorAll(selector);
    const boxes = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      boxes.push(box);
    }
    return boxes;
  }

  function stackingZ(el) {
    let z = 0;
    let node = el;
    while (node && node.nodeType === 1) {
      const st = getComputedStyle(node);
      if (st.position !== "static" && st.zIndex !== "auto") {
        const n = parseInt(st.zIndex, 10);
        if (n > z) z = n;
      }
      if (node === document.body) break;
      node = node.parentElement;
    }
    return z;
  }

  /* A control on the desk behind an open sheet is not on screen.
     One painted above the sheet still counts. */
  function hiddenBySheet(el) {
    const sheets = document.querySelectorAll(".sheet");
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      if (sheet.contains(el)) return false;
      const st = getComputedStyle(sheet);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const sheetBox = sheet.getBoundingClientRect();
      if (sheetBox.width < 1 || sheetBox.height < 1) continue;
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      if (cx <= sheetBox.left || cx >= sheetBox.right || cy <= sheetBox.top || cy >= sheetBox.bottom) continue;
      if (stackingZ(el) <= stackingZ(sheet)) return true;
    }
    return false;
  }

  function controlBoxes(except) {
    const nodes = document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"]');
    const boxes = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (except && except.contains(el)) continue;
      if (hiddenBySheet(el)) continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      boxes.push(box);
    }
    return boxes;
  }

  function hits(rect, boxes) {
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (rect.left < box.right - 0.5 && rect.right > box.left + 0.5 && rect.top < box.bottom - 0.5 && rect.bottom > box.top + 0.5) return true;
    }
    return false;
  }

  function Toast({ text, actionLabel, onAction, onDone }) {
    const node = React.useRef(null);
    const done = React.useRef(onDone);
    done.current = onDone;
    const action = React.useRef(actionLabel);
    action.current = actionLabel;
    const timer = React.useRef(null);
    const remaining = React.useRef(TOAST_MS);
    const started = React.useRef(0);
    const held = React.useRef(false);
    /* Empty on the first paint. The effect fills it after mount. */
    const [live, setLive] = React.useState("");

    const clearTimer = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    const finish = () => {
      if (held.current && action.current) return;
      if (done.current) done.current();
    };
    const arm = (ms) => {
      clearTimer();
      remaining.current = ms;
      started.current = Date.now();
      if (held.current && action.current) return;
      timer.current = setTimeout(finish, ms);
    };

    /* Depend on the text, not the callback. A parent re-render would
       otherwise restart the four seconds and the toast would stick. */
    React.useEffect(() => {
      if (!text) return undefined;
      const el = node.current;
      held.current = !!(action.current && el && document.activeElement && el.contains(document.activeElement));
      arm(TOAST_MS);
      return () => clearTimer();
    }, [text]);

    React.useEffect(() => {
      setLive(text || "");
    }, [text]);

    React.useLayoutEffect(() => {
      const el = node.current;
      if (!el || !text) return undefined;
      const place = () => {
        const height = el.offsetHeight;
        if (height < 1) return;
        const boxes = controlBoxes(el).concat(visibleBoxes(".sheet-h, .pin-q, .pin-s, .steps, .pin-dots, .pin-err, .pin-saving"));
        const width = window.innerWidth;
        const left = 16;
        const right = width - 16;
        const clear = (top) => top >= 0 && top + height <= window.innerHeight && !hits({ left: left, right: right, top: top, bottom: top + height }, boxes);
        const bottomInset = Math.round(window.innerHeight - anchorTop() + 16);
        const bottomTop = window.innerHeight - bottomInset - height;
        if (clear(bottomTop)) {
          el.style.top = "auto";
          el.style.bottom = bottomInset + "px";
          return;
        }
        /* Lowest open band, 16px above the next control, and not on
           the question or the hint. */
        const spans = [];
        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];
          if (box.right <= left + 0.5 || box.left >= right - 0.5) continue;
          spans.push([box.top, box.bottom]);
        }
        spans.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i];
          const last = merged[merged.length - 1];
          if (!last || span[0] > last[1] + 0.5) merged.push([span[0], span[1]]);
          else if (span[1] > last[1]) last[1] = span[1];
        }
        let best = null;
        let cursor = 0;
        const consider = (gapEnd) => {
          const top = gapEnd - 16 - height;
          const floor = cursor > 0 ? cursor + 16 : 0;
          if (top < floor || !clear(top)) return;
          if (best === null || top > best) best = top;
        };
        for (let i = 0; i < merged.length; i++) {
          consider(merged[i][0]);
          if (merged[i][1] > cursor) cursor = merged[i][1];
        }
        consider(window.innerHeight);
        if (best === null) {
          const copy = visibleBoxes(".pin-q, .pin-s, .steps, .pin-dots, .pin-err, .pin-saving");
          let under = 0;
          for (let i = 0; i < copy.length; i++) if (copy[i].bottom > under) under = copy[i].bottom;
          best = under + 16;
        }
        el.style.bottom = "auto";
        el.style.top = Math.round(best) + "px";
      };
      place();
      window.addEventListener("resize", place);
      return () => window.removeEventListener("resize", place);
    }, [text, actionLabel]);

    const hold = () => {
      if (!action.current) return;
      held.current = true;
      if (!timer.current) return;
      const elapsed = Date.now() - started.current;
      remaining.current = Math.max(0, remaining.current - elapsed);
      clearTimer();
    };
    const release = (e) => {
      if (!action.current) return;
      const next = e.relatedTarget;
      if (node.current && next && node.current.contains(next)) return;
      held.current = false;
      if (remaining.current <= 0) {
        finish();
        return;
      }
      arm(remaining.current);
    };

    if (!text) return null;
    return ReactDOM.createPortal(
      <div ref={node} className="phone-toast" onFocus={hold} onBlur={release}>
        <span aria-hidden="true"><Ic n="check" s={16} /></span>
        <span aria-hidden="true">{text}</span>
        <span className="phone-toast-live" role="status" aria-live="polite" aria-atomic="true">{live}</span>
        {actionLabel ? <button type="button" className="phone-toast-go" onClick={onAction}>{actionLabel}</button> : null}
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Toast });
})();
