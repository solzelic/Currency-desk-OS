/* Toggle — the 51×31 pill. It does not take the click.
   NavRow puts role="switch" on the row, because a 31px pill is
   smaller than a thumb. Use this when a row needs the picture. */
(function () {
  function Toggle({ on }) {
    return <span className={'switch' + (on ? ' on' : '')} aria-hidden="true" />;
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Toggle });
})();
