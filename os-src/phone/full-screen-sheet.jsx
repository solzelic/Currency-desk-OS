/* FullScreenSheet — a dialog that covers the phone, including the
   bottom bar. Portaled to the body so a transformed window cannot
   trap it above the bar. Hidden above 430px by the stylesheet, so
   a resize back to the desktop does not leave it on screen. */
(function () {
  const { Ic } = window.CDOS;

  function FullScreenSheet({ title, label, onClose, children }) {
    React.useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return ReactDOM.createPortal(
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label || title}>
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
