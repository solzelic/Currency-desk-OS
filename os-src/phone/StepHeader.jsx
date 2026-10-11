/* StepHeader. "Step 2 of 3: cheque details" plus a bar of `total`
   segments. The title keeps a normal word space. See docs/PHONE_SHELL.md.

   step, total, label */
(function () {
  function StepHeader({ step, total, label }) {
    const n = total || 3;
    const bars = [];
    for (let i = 1; i <= n; i++) bars.push(<i key={i} className={i <= step ? 'is-on' : ''} />);
    return (
      <div className="phq-steps">
        <div className="phq-steps-t">Step <b>{step} of {n}</b>: {label}</div>
        <div className="phq-bar" aria-hidden="true">{bars}</div>
      </div>
    );
  }
  window.CDOS = window.CDOS || {};
  window.CDOS.StepHeader = StepHeader;
})();
