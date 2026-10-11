/* SummaryList — read-only facts the screen already has.
   Label and value. No fields, no save. A row with no value is
   left out, so a missing figure is absent rather than a blank.
   big is the figure to read out loud. tone "pos" is a positive
   amount. mark is written to data-phone-cheque.
   See docs/PHONE_SHELL.md. */
(function () {
  function SummaryList({ rows }) {
    const shown = (rows || []).filter((row) => row && row.label && row.value);
    if (!shown.length) return null;
    return (
      <dl className="phone-summary">
        {shown.map((row) => (
          <div key={row.label} className={row.big ? 'is-big' : undefined}>
            <dt>{row.label}</dt>
            <dd className={row.tone === 'pos' ? 'is-pos' : undefined} data-phone-cheque={row.mark || undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { SummaryList });
})();
