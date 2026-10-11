/* AmountField. A large number the cashier types, with the currency
   code beside it as text. The field does not format the number.
   See docs/PHONE_SHELL.md.

   label, value, onChange(string), currency */
(function () {
  function AmountField({ label, value, onChange, currency }) {
    return (
      <label className="phq-amt">
        <span className="phq-amt-k">{label}</span>
        <span className="phq-amt-v">
          <input className="phq-amt-n" inputMode="decimal" autoComplete="off"
            placeholder="0.00" aria-label={label} value={value}
            onChange={function (e) { onChange && onChange(e.target.value); }} />
          <span className="phq-amt-c">{currency}</span>
        </span>
      </label>
    );
  }
  window.CDOS = window.CDOS || {};
  window.CDOS.AmountField = AmountField;
})();
