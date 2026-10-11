/* SummaryList — read-only facts the screen already has.
   Label and value. No fields, no save. A row with no value is
   left out, so a missing figure is absent rather than a blank. */
(function () {
  function SummaryList({ rows }) {
    const shown = (rows || []).filter((row) => row && row.label && row.value);
    if (!shown.length) return null;
    return (
      <dl className="phone-summary">
        {shown.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { SummaryList });
})();
