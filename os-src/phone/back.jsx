/* Phone back. A chevron and the parent name. The hit is the
   whole control. There is no arrow character.
   Loaded after cdos-phone.jsx so it can hang off window.CDOS.Phone. */
(function () {
  function PhoneBack({ label, onClick }) {
    const name = String(label || '').trim();
    const backTo = name ? 'Back to ' + name : 'Back';
    return (
      <button type="button" className="phone-back" aria-label={backTo} title={backTo} onClick={onClick}>
        <svg className="phone-back-chevron" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
          <path d="m15 18-6-6 6-6" />
        </svg>
        {name ? <span className="phone-back-label">{name}</span> : null}
      </button>
    );
  }
  const root = (window.CDOS = window.CDOS || {});
  if (!root.Phone) root.Phone = {};
  root.Phone.Back = PhoneBack;
})();
