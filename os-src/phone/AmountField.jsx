/* AmountField. A large number the cashier types, with the currency
   code beside it as text. The field does not format the number.
   feeLabel and onFee are optional. Together they draw a fee line
   under the number; onFee makes that line a button. autoFocus
   focuses the number so the keypad opens. Leave them off and the
   field is the plain amount. See docs/PHONE_SHELL.md.

   label, value, onChange(string), currency
   feeLabel?, onFee?, autoFocus? */
(function () {
  function AmountField({ label, value, onChange, currency, feeLabel, onFee, autoFocus }) {
    const number = (
      <span className="phq-amt-v">
        <input className="phq-amt-n" inputMode="decimal" autoComplete="off"
          placeholder="0.00" aria-label={label} value={value}
          autoFocus={autoFocus ? true : undefined}
          onChange={function (e) { onChange && onChange(e.target.value); }} />
        <span className="phq-amt-c">{currency}</span>
      </span>
    );
    const fee = onFee
      ? <button type="button" className="phq-amt-fee" onClick={onFee}>{feeLabel}</button>
      : (feeLabel ? <span className="phq-amt-note">{feeLabel}</span> : null);
    /* A button cannot sit inside the label, or the tap focuses the
       number as well. Without onFee the wrapper stays a label, which
       is what Cheques already uses. */
    if (onFee) {
      return (
        <div className="phq-amt">
          <span className="phq-amt-k">{label}</span>
          {number}
          {fee}
        </div>
      );
    }
    return (
      <label className="phq-amt">
        <span className="phq-amt-k">{label}</span>
        {number}
        {fee}
      </label>
    );
  }
  window.CDOS = window.CDOS || {};
  window.CDOS.AmountField = AmountField;
})();
