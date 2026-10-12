/* Toast — one line after a save. It sits at the bottom, 16px above
   the sticky action, or 16px above the tab bar when the screen has
   none. Inset 16px. It leaves after 4 seconds. role=status so a
   screen reader hears it without the cashier hunting for it. */
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

  function Toast({ text, actionLabel, onAction, onDone }) {
    const node = React.useRef(null);
    const done = React.useRef(onDone);
    done.current = onDone;
    /* Depend on the text, not the callback. A parent re-render would
       otherwise restart the four seconds and the toast would stick. */
    React.useEffect(() => {
      if (!text) return undefined;
      const t = setTimeout(() => { if (done.current) done.current(); }, 4000);
      return () => clearTimeout(t);
    }, [text]);
    React.useLayoutEffect(() => {
      const el = node.current;
      if (!el) return undefined;
      const place = () => {
        el.style.bottom = (window.innerHeight - anchorTop() + 16) + "px";
      };
      place();
      window.addEventListener("resize", place);
      return () => window.removeEventListener("resize", place);
    }, [text, actionLabel]);
    if (!text) return null;
    return ReactDOM.createPortal(
      <div ref={node} className="phone-toast" role="status">
        <Ic n="check" s={16} />
        <span>{text}</span>
        {actionLabel ? <button type="button" className="phone-toast-go" onClick={onAction}>{actionLabel}</button> : null}
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Toast });
})();
