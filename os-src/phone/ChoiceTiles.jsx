/* ChoiceTiles. Two columns. Each tile is at least 56px. The selected
   tile uses the app colour. This is the phone contract. See
   docs/PHONE_SHELL.md.

   options: [{ id, label, detail }]
   value: selected id
   onChange(id)
   label: the listbox name */
(function () {
  function ChoiceTiles({ options, value, onChange, label }) {
    return (
      <div className="phq-tiles" role="listbox" aria-label={label || 'Choose one'}>
        {(options || []).map(function (opt) {
          const on = value === opt.id;
          return (
            <button key={opt.id} type="button" role="option" aria-selected={on}
              className={'phq-tile' + (on ? ' is-on' : '')}
              onClick={function () { onChange && onChange(opt.id); }}>
              <b>{opt.label}</b>
              {opt.detail ? <small>{opt.detail}</small> : null}
            </button>
          );
        })}
      </div>
    );
  }
  window.CDOS = window.CDOS || {};
  window.CDOS.ChoiceTiles = ChoiceTiles;
})();
