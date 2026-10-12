/* Toast — one line after a save. It sits 16px above the sticky
   action, or 16px above the tab bar, when that band covers no
   control. When it would, it sits 16px below the phone header or
   the sheet header. Taps pass through the line. The action still
   takes them. The words go into a live region after the toast
   mounts, so a screen reader hears them. An action toast stays
   up while that action has focus. */
(function () {
  const { Ic } = window.CDOS;

  function anchorTop() {
    const stickies = document.querySelectorAll(".phone-sticky");
    for (let i = 0; i < stickies.length; i++) {
      const box = stickies[i].getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return box.top;
    }
    const dock = document.getElementById("phone-dock");
    return dock ? dock.getBoundingClientRect().top : window.innerHeight;
  }

  function headerBottom() {
    let bottom = 0;
    const nodes = document.querySelectorAll(".sheet-h, .phone-head");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.bottom > bottom) bottom = box.bottom;
    }
    return bottom;
  }

  function controlBoxes(except) {
    const nodes = document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"]');
    const boxes = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (except && except.contains(el)) continue;
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
    const remaining = React.useRef(4000);
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
      arm(4000);
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
        const boxes = controlBoxes(el);
        const width = window.innerWidth;
        const bottomInset = Math.round(window.innerHeight - anchorTop() + 16);
        const bottomTop = window.innerHeight - bottomInset - height;
        const bottomRect = { left: 16, right: width - 16, top: bottomTop, bottom: bottomTop + height };
        if (!hits(bottomRect, boxes)) {
          el.style.top = "auto";
          el.style.bottom = bottomInset + "px";
          return;
        }
        el.style.bottom = "auto";
        el.style.top = (headerBottom() + 16) + "px";
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
