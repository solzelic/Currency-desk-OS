/* PinPad — one question, four dots, a keypad. The parent decides
   when four digits is enough. This only draws the step and reports
   each key. Delete removes one digit. A hardware digit, Backspace,
   Delete, and a paste do the same. The count is announced as
   "N of 4 digits". The keypad locks while a save is in flight so
   the last digit cannot submit twice. */
(function () {
  const { Ic } = window.CDOS;
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  function PinPad({ step, steps, question, hint, digits, error, shake, busy, locked, passwordMode, password, onPassword, onPasswordNext, onDigit, onDelete, forgotLabel, onForgot, retryLabel, onRetry }) {
    const root = React.useRef(null);
    const digitRef = React.useRef(onDigit);
    const deleteRef = React.useRef(onDelete);
    digitRef.current = onDigit;
    deleteRef.current = onDelete;
    const filled = Math.min(4, (digits || '').length);
    const closed = !!(passwordMode || busy || locked);

    React.useEffect(() => {
      if (closed) return undefined;
      const onKey = (e) => {
        const pad = root.current;
        if (!pad || pad.getBoundingClientRect().width < 1) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target;
        if (target && target.closest) {
          const field = target.closest("input, textarea, select");
          if (field && !pad.contains(field)) return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          if (digitRef.current) digitRef.current(e.key);
        } else if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          if (deleteRef.current) deleteRef.current();
        }
      };
      const onPaste = (e) => {
        const pad = root.current;
        if (!pad || pad.getBoundingClientRect().width < 1) return;
        const target = e.target;
        if (target && target.closest) {
          const field = target.closest("input, textarea");
          if (field && !pad.contains(field)) return;
        }
        const data = e.clipboardData || window.clipboardData;
        if (!data) return;
        const text = data.getData("text/plain") || data.getData("text") || "";
        const room = 4 - Math.min(4, String(digits || "").length);
        const chars = String(text).replace(/\D/g, "").slice(0, room);
        if (!chars) return;
        e.preventDefault();
        chars.split("").forEach((ch) => { if (digitRef.current) digitRef.current(ch); });
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("paste", onPaste);
      return () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("paste", onPaste);
      };
    }, [closed, digits]);

    return (
      <div className="pinpad" data-pin-step={step} ref={root}>
        <div className="steps" aria-label={'Step ' + step + ' of ' + steps}>
          {Array.from({ length: steps }, (_, i) => <i key={i} className={i < step ? 'on' : ''} />)}
        </div>
        <div className="pin-q">{question}</div>
        {hint ? <div className="pin-s">{hint}</div> : null}
        {passwordMode ? (
          <label className="pin-pw">
            <span className="sr">Sign-in password</span>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password || ''}
              disabled={locked || busy}
              onChange={(e) => onPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onPasswordNext(); }}
            />
            <button type="button" className="phone-btn primary" disabled={locked || busy} onClick={onPasswordNext}>Next</button>
          </label>
        ) : busy ? (
          <div className="pin-saving" role="status">Saving...</div>
        ) : (
          <div className={'pin-dots' + (shake ? ' shake' : '')} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <i key={i} className={i < filled ? 'on' : ''} />)}
          </div>
        )}
        {passwordMode || busy ? null : (
          <p className="sr pin-count" role="status" aria-live="polite" aria-atomic="true">{filled} of 4 digits</p>
        )}
        {error ? <p className="pin-err" role="alert">{error}</p> : null}
        {onForgot ? <div className="forgot"><button type="button" className="phone-text" onClick={onForgot}>{forgotLabel}</button></div> : null}
        {onRetry ? <div className="forgot"><button type="button" className="phone-btn secondary" onClick={onRetry}>{retryLabel || 'Try again'}</button></div> : null}
        {passwordMode ? null : (
          <div className="keypad">
            {KEYS.map((k) => k === ''
              ? <button key="blank" type="button" className="blank" tabIndex={-1} aria-hidden="true" />
              : k === 'del'
                ? <button key="del" type="button" className="del" aria-label="Delete last digit" disabled={busy || locked} onClick={onDelete}><Ic n="del" s={26} /></button>
                : <button key={k} type="button" disabled={busy || locked} onClick={() => onDigit(k)}>{k}</button>)}
          </div>
        )}
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PinPad });
})();
