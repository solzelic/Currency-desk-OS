/* ============================================================
   Phone cash drawer. At 430px and under, TillDrawer renders this
   instead of the desktop drawer. Wider than that, this file is
   loaded and not mounted, so the desktop drawer is untouched.

   One currency at a time. The footer is the only primary action
   (Save count, or Close till). There is no round + on this screen.
   Amounts go through window.CDOS.phoneMoney, which the phone shell
   owns (docs/PHONE_SHELL.md): "1,765.05 CAD", never a bare "$".
   A figure the ledger did not return is left out, not shown as 0.
   ============================================================ */
(function () {
  const { useState, useEffect } = React;

  /* The phone shell owns this. Empty string means the figure is absent. */
  function money(amount, currency) {
    if (amount == null || currency == null || currency === '') return null;
    const said = window.CDOS.formatPhoneMoney(amount, currency);
    return said || null;
  }

  function usePhoneWidth() {
    const query = '(max-width: 430px)';
    const [on, setOn] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
      const mq = window.matchMedia(query);
      const apply = () => setOn(mq.matches);
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }, []);
    return on;
  }

  /* Slow first fetch: skeleton after 300ms, the cold-start banner after 3s. */
  function useWait(loading) {
    const [skel, setSkel] = useState(false);
    const [slow, setSlow] = useState(false);
    useEffect(() => {
      if (!loading) { setSkel(false); setSlow(false); return undefined; }
      const a = setTimeout(() => setSkel(true), 300);
      const b = setTimeout(() => setSlow(true), 3000);
      return () => { clearTimeout(a); clearTimeout(b); };
    }, [loading]);
    return { skel, slow };
  }

  function clock12(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  /* The ledger stores a staff id. The roster is how that id is spelled
     for a person. No roster match keeps the id. It does not invent one. */
  function operatorOf(current, roster) {
    if (!current || !current.operator || current.operator === '—') return null;
    const id = String(current.operator).toLowerCase();
    const hit = (roster || []).find(s => String(s.staffId || '').toLowerCase() === id || String(s.name || '').toLowerCase() === id);
    return { name: hit ? hit.name : current.operator, since: current.since || null };
  }

  function faceOf(v, ccy) {
    const n = v >= 1 && Number.isInteger(v) ? String(v) : Number(v).toFixed(2);
    return n + ' ' + ccy;
  }

  /* Counted minus expected, in words. No figure until both exist. */
  function diffWords(ccy, counted, expected) {
    if (counted == null || expected == null) return '';
    const v = Math.round((Number(counted) - Number(expected)) * 100) / 100;
    if (Math.abs(v) < 0.005) return 'Matches the book';
    const said = money(Math.abs(v), ccy);
    if (!said) return '';
    return said + (v > 0 ? ' over' : ' short');
  }

  function QtyRow({ d, ccy, counts, setCount }) {
    const raw = (counts[ccy] || {})[d.i];
    const shown = raw == null || raw === '' ? '' : String(raw);
    const n = parseInt(shown, 10);
    const have = Number.isFinite(n) ? n : 0;
    const sub = d.v * have;
    const face = faceOf(d.v, ccy);
    const line = shown === '' || !sub ? null : money(sub, ccy);
    return (
      <div className="till-den-row">
        <span className="till-den-face">{face}</span>
        <div className="till-stepper">
          <button type="button" className="till-step" aria-label={'Remove one ' + face} onClick={() => { if (shown === '') return; setCount(ccy, d.i, String(Math.max(0, have - 1))); }}>−</button>
          <input className="till-den-qty" type="text" inputMode="decimal" autoComplete="off" enterKeyHint="done" aria-label={face + ' count'} value={shown} onChange={e => setCount(ccy, d.i, e.target.value.replace(/[^0-9]/g, ''))} />
          <button type="button" className="till-step" aria-label={'Add one ' + face} onClick={() => setCount(ccy, d.i, String(have + 1))}>+</button>
        </div>
        <span className="till-den-sub">{line || '—'}</span>
      </div>
    );
  }

  function PhoneTill(p) {
    const [sheet, setSheet] = useState(false);
    const loading = !!(p.serverBacked && p.balances == null && !p.error);
    const wait = useWait(loading);
    const who = operatorOf(p.current, p.roster);
    const counted = p.isCounted(p.ccy);
    const total = counted ? p.ccyTotal(p.ccy) : null;
    const expected = p.expectedOf(p.ccy);
    const showExpected = !p.blind || !!p.revealExp[p.ccy];
    const words = showExpected && counted ? diffWords(p.ccy, total, expected) : '';
    const open = !!p.sessionOpen;
    const noSession = !!(p.serverBacked && p.balances != null && !p.error && !p.serverSession);
    const closed = !!(p.sessionClosed);
    const mode = p.ccyMode(p.ccy);
    const denoms = p.denoms || [];
    const amount = (n, ccy) => (n == null || !ccy) ? null : money(n, ccy);

    const footLabel = p.tab === 'reconcile' ? (p.closing ? 'Closing…' : 'Close till') : (p.saved ? 'Saved' : (p.busy === 'count' ? 'Saving…' : 'Save count'));
    const footDisabled = p.tab === 'reconcile'
      ? (!p.canClose || p.closing || p.closeBlocked)
      : (!open || !counted || p.saved || p.busy === 'count');

    const onFoot = () => {
      if (footDisabled) return;
      if (p.tab === 'reconcile') p.onClose();
      else p.onSave();
    };

    const Phone = window.CDOS.Phone;
    const saveWhy = p.tab === 'reconcile'
      ? (p.closeBlocked ? p.closeReason : '')
      : (!open ? 'Open the till before saving a count' : (!counted ? 'Enter a count first' : ''));
    const sticky = (p.tab === 'history') ? (
      <div className="till-count-foot">
        <Phone.StickyAction label="Back to count" onClick={() => p.setTab('count')} />
      </div>
    ) : (noSession || closed) ? (
      <div className="till-count-foot">
        <Phone.StickyAction
          label={p.busy === 'open' || p.opening ? 'Opening…' : (closed ? 'Open next session' : 'Open the till')}
          disabled={!!p.busy || p.opening}
          disabledReason={p.busy || p.opening ? 'Opening the till' : ''}
          onClick={closed ? p.onNext : p.onOpen}
        />
      </div>
    ) : (
      <div className="till-count-foot">
        <div className="till-foot-sum">
          <div className="till-phone-counted">{total == null ? (p.ccy + ' not counted yet') : money(total, p.ccy)}</div>
          <div className="till-foot-exp">
            <span>{showExpected ? ('Expected: ' + (expected == null ? '—' : money(expected, p.ccy))) : 'Expected: Hidden'}</span>
            {words ? <span className="till-diff">{words}</span> : null}
            {p.blind && (
              <button type="button" className="till-phone-link" aria-label={showExpected ? 'Hide expected amount' : 'Show expected amount'} onClick={() => p.toggleReveal(p.ccy)}>{showExpected ? 'Hide' : 'Show'}</button>
            )}
          </div>
        </div>
        <Phone.StickyAction label={footLabel} disabled={footDisabled} disabledReason={saveWhy} onClick={onFoot} />
      </div>
    );

    return (
      <div ref={p.rootRef} className="till-screen till-phone-host" data-tour="till" data-phone-till={loading ? 'loading' : (noSession || closed ? 'empty' : p.tab)}>
        <Phone.Screen
          app="till"
          className="till-phone"
          title="Cash drawer"
          action={<button type="button" className="till-phone-link" onClick={() => p.setTab('history')}>History</button>}
          banner={wait.slow ? (
            <div className="till-wake" role="status">
              <b>Waking the server</b>
              <span>This can take up to a minute. Keep this screen open.</span>
            </div>
          ) : null}
          sticky={sticky}
        >
          <div className="till-phone-seg" role="tablist">
            <button type="button" role="tab" aria-selected={p.tab === 'count'} className={p.tab === 'count' ? 'is-on' : ''} onClick={() => p.setTab('count')}>Count</button>
            <button type="button" role="tab" aria-selected={p.tab === 'reconcile'} className={p.tab === 'reconcile' ? 'is-on' : ''} onClick={() => p.setTab('reconcile')}>Reconcile and close</button>
          </div>

          {p.error ? <Phone.ErrorState message={p.error} onRetry={p.onRetry} /> : null}
          {loading && wait.skel ? <Phone.LoadingState rows={3} label="Loading the till" /> : null}
          {loading && wait.skel && Array.from({ length: 10 }, (_, i) => <div key={i} className="till-den-row till-skel-row"><span className="till-skel" /><span className="till-skel" /></div>)}

          {!loading && (noSession || closed) && (
            <Phone.EmptyState
              title={closed ? 'This till is closed' : 'This till is not open'}
              message={closed
                ? 'The book is locked. Open the next session to count again.'
                : 'Open it to count the drawer. A count, a cash move, and a deal all record against that session.'}
            />
          )}

          {!loading && !noSession && !closed && p.tab !== 'history' && (
            <section className="till-phone-card">
              <div className="till-phone-amount">{amount(p.drawerTotal, p.homeCcy) || '—'}</div>
              <div className="till-phone-meta">
                {'In drawer · '}
                {p.sessionNumber != null ? ('Session #' + p.sessionNumber + ' · ' + (clock12(p.openedAt) || '—')) : 'No open session'}
                {' · ' + p.countedN + ' of ' + p.reconCount + ' counted'}
              </div>
              <div className="till-phone-who">
                <span>{who ? ('On the drawer: ' + who.name + (who.since ? ', since ' + clock12(who.since) : '')) : 'Nobody on this till'}</span>
                {p.tillName ? <button type="button" className="till-phone-till" onClick={() => setSheet(true)}>{p.tillName}</button> : null}
              </div>
              <div className="till-phone-actions">
                <button type="button" onClick={p.onMove} disabled={!p.canMove}>Move cash</button>
                <button type="button" onClick={p.onVault}>Vault</button>
                <button type="button" onClick={p.onHandoff}>Hand off</button>
              </div>
            </section>
          )}

          {!loading && !noSession && !closed && p.tab === 'count' && !(wait.skel && loading) && (
            <>
              <Phone.FilterChips
                chips={p.currencies.map(c => ({ id: c, label: p.isCounted(c) ? (c + ' counted') : c }))}
                value={p.ccy}
                onChange={p.setCcy}
              />
              <div className="till-phone-sec" data-tour="till-count">
                <h2>Count {p.ccy}</h2>
                <button type="button" className="till-phone-link" onClick={() => p.setMode(m => ({ ...m, [p.ccy]: mode === 'total' ? 'denom' : 'total' }))}>{mode === 'total' ? 'Count notes' : 'Enter total instead'}</button>
              </div>
              {mode === 'total' && (
                <label className="till-phone-total">
                  <span>{p.ccy}</span>
                  <input type="text" inputMode="decimal" autoComplete="off" aria-label={p.ccy + ' total'} value={p.quick[p.ccy] ?? ''} onChange={e => { p.setQuick(o => ({ ...o, [p.ccy]: e.target.value.replace(/[^0-9.]/g, '') })); p.stamp(p.ccy); }} />
                </label>
              )}
              <div className="till-phone-list">
                {denoms.map(d => <QtyRow key={d.i} d={d} ccy={p.ccy} counts={p.counts} setCount={p.setCount} />)}
              </div>
            </>
          )}

          {!loading && !noSession && !closed && p.tab === 'reconcile' && (
            <div className="till-phone-list">
              {p.recon.map(r => (
                <div key={r.c} className="till-phone-recon">
                  <b>{r.c}</b>
                  <span>{r.counted == null ? 'Not counted yet' : money(r.counted, r.c)}</span>
                  <span>{'Expected ' + (r.expected == null ? '—' : money(r.expected, r.c))}</span>
                  <span className="till-diff">{diffWords(r.c, r.counted, r.expected)}</span>
                </div>
              ))}
              {p.closeBlocked && <p className="till-phone-note">{p.closeReason}</p>}
            </div>
          )}

          {p.tab === 'history' && (
            <div className="till-phone-list">
              {!(p.histKeys || []).length && <p className="till-phone-note">No counts saved on this till.</p>}
              {(p.histKeys || []).slice(0, 12).map(k => (
                <button type="button" key={k} className="till-phone-recon" onClick={() => p.onHistory(k)}>
                  <b>{k}</b>
                  <span>{p.history[k] && p.history[k].by}</span>
                </button>
              ))}
            </div>
          )}
          <div className="till-scroll-pad" />
        </Phone.Screen>

        {sheet && (
          <div className="till-sheet" role="dialog" aria-label="Switch till">
            <button type="button" className="till-sheet-scrim" aria-label="Close till list" onClick={() => setSheet(false)} />
            <div className="till-sheet-panel">
              <div className="till-sheet-title">Which till?</div>
              {(p.tills || []).map(o => (
                <button type="button" key={o.key} className="till-sheet-row" onClick={() => { setSheet(false); p.onPickTill(o.key); }}>
                  <span>{o.name}</span>
                  <span>{o.on ? 'This till' : (o.occupant || o.note || '')}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {p.confirmClose && (
          <div className="till-sheet" role="dialog" aria-label="Close the till">
            <button type="button" className="till-sheet-scrim" aria-label="Back to count" onClick={() => p.setConfirmClose(false)} />
            <div className="till-sheet-panel">
              <div className="till-sheet-title">Close the till</div>
              <p className="till-phone-note">The close writes each counted figure back as the till balance.</p>
              {p.recon.map(r => (
                <div key={r.c} className="till-phone-recon">
                  <b>{r.c}</b>
                  <span>{r.counted == null ? 'Not counted yet' : money(r.counted, r.c)}</span>
                  <span className="till-diff">{diffWords(r.c, r.counted, r.expected) || (r.expected == null ? '—' : ('Expected ' + money(r.expected, r.c)))}</span>
                </div>
              ))}
              <button type="button" className="till-save" onClick={p.onConfirmClose}>Close till</button>
            </div>
          </div>
        )}
        {p.children}
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTill, usePhoneWidth });
})();
