/* Toast — one line after a save. It sits at the bottom, 16px above
   the sticky action, and leaves after 4 seconds. role=status so a
   screen reader hears it without the cashier hunting for it. */
(function () {
  const { Ic } = window.CDOS;

  function Toast({ text, onDone }) {
    const done = React.useRef(onDone);
    done.current = onDone;
    /* Depend on the text, not the callback. A parent re-render would
       otherwise restart the four seconds and the toast would stick. */
    React.useEffect(() => {
      if (!text) return undefined;
      const t = setTimeout(() => { if (done.current) done.current(); }, 4000);
      return () => clearTimeout(t);
    }, [text]);
    if (!text) return null;
    return ReactDOM.createPortal(
      <div className="phone-toast" role="status" aria-live="polite">
        <Ic n="check" s={16} c="#fff" />
        <span>{text}</span>
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Toast });
})();
