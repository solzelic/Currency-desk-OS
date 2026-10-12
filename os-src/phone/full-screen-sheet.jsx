/* FullScreenSheet — a dialog that covers the phone, including the
   bottom bar. Portaled to the body so a transformed window cannot
   trap it above the bar. Hidden above 430px by the stylesheet, so
   a resize back to the desktop does not leave it on screen.
   Focus stays inside the sheet. Escape closes it and returns focus
   to the control that opened it. */
(function () {
  const { Ic } = window.CDOS;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function shown(el) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function focusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
      if (el.getAttribute("tabindex") === "-1") return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      return shown(el);
    });
  }

  function FullScreenSheet({ title, label, onClose, children }) {
    const root = React.useRef(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;

    React.useEffect(() => {
      const opener = document.activeElement;
      const sheet = root.current;
      const items = () => (sheet ? focusables(sheet) : []);
      const first = items()[0];
      if (first) first.focus();
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (closeRef.current) closeRef.current();
          return;
        }
        if (e.key !== "Tab" || !sheet) return;
        const list = items();
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const index = list.indexOf(document.activeElement);
        const next = e.shiftKey
          ? (index <= 0 ? list[list.length - 1] : list[index - 1])
          : (index < 0 || index >= list.length - 1 ? list[0] : list[index + 1]);
        e.preventDefault();
        next.focus();
      };
      document.addEventListener("keydown", onKey, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        if (opener && typeof opener.focus === "function" && document.contains(opener)) {
          try { opener.focus(); } catch (err) { /* the opener can be gone */ }
        }
      };
    }, []);

    return ReactDOM.createPortal(
      <div ref={root} className="sheet" role="dialog" aria-modal="true" aria-label={label || title}>
        <div className="sheet-h">
          <button type="button" className="phone-sheet-x" aria-label="Close without changing" onClick={onClose}>
            <Ic n="x" s={22} />
          </button>
          <h2>{title}</h2>
          <span />
        </div>
        {children}
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { FullScreenSheet });
})();
