/* NavRow — one settings row on a phone.
   The whole row is the target, at least 56px tall. A switch, when
   one is passed, is only the picture: the row itself is the switch
   so the hit area is the row, not the 51px pill. */
(function () {
  const { Ic } = window.CDOS;

  function NavRow({ icon, title, detail, value, valueTone, badge, badgeTone, onClick, danger, switchOn, switchLabel, rowId }) {
    const interactive = typeof onClick === 'function' || switchOn !== undefined;
    const Tag = interactive ? 'button' : 'div';
    const switched = switchOn !== undefined;
    return (
      <Tag
        {...(interactive ? { type: 'button', onClick } : {})}
        {...(switched ? { role: 'switch', 'aria-checked': !!switchOn, 'aria-label': switchLabel || title } : {})}
        className={'nrow' + (danger ? ' danger' : '') + (interactive ? '' : ' static')}
        data-phone-row={rowId || undefined}
      >
        <span className="ic" aria-hidden="true">{typeof icon === 'string' ? <Ic n={icon} s={20} /> : icon}</span>
        <span className="tx">
          <span className="t">{title}</span>
          {detail ? <span className="d">{detail}</span> : null}
        </span>
        {badge
          ? <span className={'badge ' + (badgeTone || 'neutral')}>{badge}</span>
          : <span className={'v' + (valueTone ? ' is-' + valueTone : '')}>{value || ''}</span>}
        {switched
          ? (window.CDOS.Toggle ? <window.CDOS.Toggle on={!!switchOn} /> : <span className={'switch' + (switchOn ? ' on' : '')} aria-hidden="true" />)
          : (interactive && !danger ? <span className="cv" aria-hidden="true"><Ic n="chev" s={20} /></span> : <span />)}
      </Tag>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { NavRow });
})();
