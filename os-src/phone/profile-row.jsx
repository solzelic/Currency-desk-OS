/* ProfileRow — the signed-in person at the top of Settings.
   48px avatar, name, role line, chevron. The row is 76px and the
   whole of it opens My details. */
(function () {
  const { Ic } = window.CDOS;

  function ProfileRow({ initials, name, detail, onClick }) {
    return (
      <button type="button" className="me" onClick={onClick} data-phone-row="profile">
        <span className="av" aria-hidden="true">{initials}</span>
        <span className="tx">
          <span className="t">{name}</span>
          <span className="d">{detail}</span>
        </span>
        <span className="cv" aria-hidden="true"><Ic n="chev" s={20} /></span>
      </button>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { ProfileRow });
})();
