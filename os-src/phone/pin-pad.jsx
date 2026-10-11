/* PinPad — one question, four dots, a keypad. The parent decides
   when four digits is enough. This only draws the step and reports
   each key. Delete removes one digit. The keypad locks while a
   save is in flight so the last digit cannot submit twice. */
(function () {
  const { Ic } = window.CDOS;
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  function PinPad({ step, steps, question, hint, digits, error, shake, busy, locked, passwordMode, password, onPassword, onPasswordNext, onDigit, onDelete, forgotLabel, onForgot, retryLabel, onRetry }) {
    const filled = Math.min(4, (digits || '').length);
    return (
      <div className="pinpad" data-pin-step={step}>
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
          <div className={'pin-dots' + (shake ? ' shake' : '')} aria-label={filled + ' of 4 digits entered'}>
            {[0, 1, 2, 3].map((i) => <i key={i} className={i < filled ? 'on' : ''} />)}
          </div>
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
