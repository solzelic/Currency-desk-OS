/* ============================================================
   Phone cash drawer. At 430px and under, TillDrawer renders this
   instead of the desktop drawer. Wider than that, this file is
   loaded and not mounted, so the desktop drawer is untouched.

   One currency at a time. The footer is the only primary action
   (Save count, or Close the till). There is no round + on this screen.
   Amounts go through window.CDOS.formatPhoneMoney, which the phone
   shell owns (docs/PHONE_SHELL.md): "1,765.05 CAD", never a bare "$".
   A figure the ledger did not return is left out, not shown as 0.

   Reconcile is a list of currencies. Hand off, Move cash, and the
   vault are desktop panels: on a phone they say so, and they do
   not open those panels.
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

  /* Desktop panels. The phone does not open them. */
  const COMPUTER = {
    move: 'Moving cash posts a real movement between the till and the vault. That form is a desktop panel.',
    vault: 'The vault is the desktop cash room. It is not laid out for a phone.',
    handoff: 'Handing off the drawer is a desktop dialog. It keeps a local note and does not change who the book says is on the till.',
  };

  function reconCopy(r) {
    const expected = r.expected == null ? null : money(r.expected, r.c);
    const counted = r.counted == null ? null : money(r.counted, r.c);
    const words = diffWords(r.c, r.counted, r.expected);
    const countedLine = counted ? ('Counted ' + counted) : 'Not counted yet';
    return {
      title: r.c,
      subtitle: 'Expected ' + (expected || '—'),
      note: words ? (countedLine + ' · ' + words) : countedLine,
    };
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
      <div className="till-den-row" data-till-coin={d.t === 'coin' ? '' : undefined}>
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
    const [aside, setAside] = useState(null);
    /* Notes first, even when the book stored a total. The total stays
       in the footer. The big field replaces the notes only when the
       cashier asks for it, so the first screen keeps the rows. */
    const [notes, setNotes] = useState(true);
    const loading = !!(p.serverBacked && p.balances == null && !p.error);
    const failed = !!(p.error && p.balances == null);
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
    const denoms = p.denoms || [];
    const firstCoin = denoms.findIndex(d => d.t === 'coin');
    const amount = (n, ccy) => (n == null || !ccy) ? null : money(n, ccy);
    const Phone = window.CDOS.Phone;

    const footLabel = p.tab === 'reconcile' ? (p.closing ? 'Closing…' : 'Close the till') : (p.saved ? 'Saved' : (p.busy === 'count' ? 'Saving…' : 'Save count'));
    const footDisabled = p.tab === 'reconcile'
      ? (!p.canClose || p.closing || p.closeBlocked)
      : (!open || !counted || p.saved || p.busy === 'count');

    const onFoot = () => {
      if (footDisabled) return;
      if (p.tab === 'reconcile') p.onClose();
      else p.onSave();
    };

    const saveWhy = p.tab === 'reconcile'
      ? (p.closeBlocked ? p.closeReason : '')
      : (!open ? 'Open the till before saving a count' : (!counted ? 'Enter a count first' : ''));

    let sticky = null;
    if (failed) {
      sticky = null;
    } else if (aside) {
      sticky = (
        <div className="till-count-foot">
          <Phone.StickyAction label="Back to count" onClick={() => setAside(null)} />
        </div>
      );
    } else if (p.tab === 'history') {
      sticky = (
        <div className="till-count-foot">
          <Phone.StickyAction label="Back to count" onClick={() => p.setTab('count')} />
        </div>
      );
    } else if (noSession || closed) {
      sticky = (
        <div className="till-count-foot">
          <Phone.StickyAction
            label={p.busy === 'open' || p.opening ? 'Opening…' : (closed ? 'Open next session' : 'Open the till')}
            disabled={!!p.busy || p.opening}
            disabledReason={p.busy || p.opening ? 'Opening the till' : ''}
            onClick={closed ? p.onNext : p.onOpen}
          />
        </div>
      );
    } else if (p.tab === 'reconcile') {
      sticky = (
        <div className="till-count-foot">
          <Phone.StickyAction label={footLabel} disabled={footDisabled} disabledReason={saveWhy} onClick={onFoot} />
        </div>
      );
    } else {
      sticky = (
        <div className="till-count-foot">
          <div className="till-foot-sum">
            <div className="till-phone-top">
              <div className="till-phone-counted">{total == null ? (p.ccy + ' not counted yet') : money(total, p.ccy)}</div>
              {p.blind && (
                <button type="button" className="till-phone-link" aria-label={showExpected ? 'Hide expected amount' : 'Show expected amount'} onClick={() => p.toggleReveal(p.ccy)}>{showExpected ? 'Hide' : 'Show'}</button>
              )}
            </div>
            <div className="till-foot-exp">
              <span>{showExpected ? ('Expected: ' + (expected == null ? '—' : money(expected, p.ccy))) : 'Expected: Hidden'}</span>
              {words ? <span className="till-diff">{words}</span> : null}
            </div>
          </div>
          <Phone.StickyAction label={footLabel} disabled={footDisabled} disabledReason={saveWhy} onClick={onFoot} />
        </div>
      );
    }

    const showWork = !loading && !failed && !noSession && !closed && !aside;

    return (
      <div ref={p.rootRef} className="till-screen till-phone-host" data-tour="till" data-phone-till={loading ? 'loading' : (failed ? 'error' : (aside || (noSession || closed ? 'empty' : p.tab)))}>
        <Phone.Screen
          app="till"
          className="till-phone"
          title="Cash drawer"
          action={failed ? null : <button type="button" className="till-phone-link" onClick={() => { setAside(null); p.setTab('history'); }}>History</button>}
          banner={wait.slow ? (
            <div className="till-wake" role="status">
              <b>Waking the server</b>
              <span>This can take up to a minute. Keep this screen open.</span>
            </div>
          ) : null}
          sticky={sticky}
        >
          {!failed && (
            <div className="phone-seg" role="tablist" aria-label="Cash drawer">
              <button type="button" role="tab" aria-selected={p.tab === 'count' && !aside} className={'phone-seg-btn' + (p.tab === 'count' && !aside ? ' on' : '')} onClick={() => { setAside(null); p.setTab('count'); }}>Count</button>
              <button type="button" role="tab" aria-selected={p.tab === 'reconcile' && !aside} className={'phone-seg-btn' + (p.tab === 'reconcile' && !aside ? ' on' : '')} onClick={() => { setAside(null); p.setTab('reconcile'); }}>Reconcile and close</button>
            </div>
          )}

          {p.error ? <Phone.ErrorState message={p.error} onRetry={p.onRetry} /> : null}
          {loading && wait.skel ? <Phone.LoadingState rows={3} label="Loading the till" /> : null}

          {!loading && !failed && (noSession || closed) && (
            <Phone.EmptyState
              title={closed ? 'This till is closed' : 'This till is not open'}
              message={closed
                ? 'The book is locked. Open the next session to count again.'
                : 'Open it to count the drawer. A count, a cash move, and a deal all record against that session.'}
            />
          )}

          {aside && COMPUTER[aside] && (
            <Phone.EmptyState title="Open this on a computer" message={COMPUTER[aside]} />
          )}

          {showWork && p.tab !== 'history' && (
            <section className="till-phone-card">
              <div className="till-phone-top">
                <div className="till-phone-amount">{amount(p.drawerTotal, p.homeCcy) || '—'}</div>
                {p.tillName ? <button type="button" className="till-phone-till" onClick={() => setSheet(true)}>{p.tillName}</button> : null}
              </div>
              <div className="till-phone-meta">
                {who ? (who.name + (who.since ? ', since ' + clock12(who.since) : '') + ' · ') : 'Nobody on this till · '}
                {p.sessionNumber != null ? ('Session #' + p.sessionNumber + ' open · ' + (clock12(p.openedAt) || '—')) : 'No open session'}
                {' · ' + p.countedN + ' of ' + p.reconCount + ' counted'}
              </div>
              <div className="till-phone-actions">
                <button type="button" onClick={() => setAside('move')} disabled={!p.canMove}>Move cash</button>
                <button type="button" onClick={() => setAside('vault')}>Vault</button>
                <button type="button" onClick={() => setAside('handoff')}>Hand off</button>
              </div>
            </section>
          )}

          {showWork && p.tab === 'count' && (
            <>
              <Phone.FilterChips
                chips={p.currencies.map(c => ({ id: c, label: p.isCounted(c) ? (c + ' counted') : c }))}
                value={p.ccy}
                onChange={p.setCcy}
              />
              <div className="till-phone-sec" data-tour="till-count">
                <h2>Count {p.ccy}</h2>
                <button type="button" className="till-phone-link" onClick={() => setNotes(v => !v)}>{notes ? 'Enter total instead' : 'Count notes'}</button>
              </div>
              {notes ? (
                <div className="till-phone-list">
                  {denoms.map((d, i) => (
                    <React.Fragment key={d.i}>
                      {i === firstCoin ? <h3 className="till-phone-group">Coins</h3> : null}
                      <QtyRow d={d} ccy={p.ccy} counts={p.counts} setCount={(ccy, i, value) => { p.setMode(m => ({ ...m, [ccy]: 'denom' })); p.setCount(ccy, i, value); }} />
                    </React.Fragment>
                  ))}
                </div>
              ) : (
                <label className="till-phone-total">
                  <span>{p.ccy}</span>
                  <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label={p.ccy + ' total'} value={p.quick[p.ccy] ?? ''} onChange={e => { p.setMode(m => ({ ...m, [p.ccy]: 'total' })); p.setQuick(o => ({ ...o, [p.ccy]: e.target.value.replace(/[^0-9.]/g, '') })); p.stamp(p.ccy); }} />
                </label>
              )}
            </>
          )}

          {showWork && p.tab === 'reconcile' && (
            <>
              <Phone.ListSection title="Currencies">
                {p.recon.map(r => {
                  const copy = reconCopy(r);
                  return <Phone.ListRow key={r.c} className="till-recon-row" title={copy.title} subtitle={copy.subtitle} note={copy.note} />;
                })}
              </Phone.ListSection>
              {p.closeBlocked && <p className="till-phone-note">{p.closeReason}</p>}
            </>
          )}

          {showWork && p.tab === 'history' && (
            <div className="till-phone-list">
              {!(p.histKeys || []).length && <p className="till-phone-note">No counts saved on this till.</p>}
              {(p.histKeys || []).slice(0, 12).map(k => (
                <Phone.ListRow key={k} title={k} subtitle={p.history[k] && p.history[k].by} onClick={() => p.onHistory(k)} />
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
            <button type="button" className="till-sheet-scrim" aria-label="Back to the count" onClick={() => p.setConfirmClose(false)} />
            <div className="till-sheet-panel">
              <div className="till-sheet-title">Close the till</div>
              <p className="till-phone-note">The close writes each counted figure back as the till balance.</p>
              {p.recon.map(r => {
                const copy = reconCopy(r);
                return (
                  <div key={r.c} className="till-sheet-line">
                    <b>{copy.title}</b>
                    <span>{copy.subtitle}</span>
                    <span>{copy.note}</span>
                  </div>
                );
              })}
              <button type="button" className="till-save" onClick={p.onConfirmClose}>Close the till</button>
            </div>
          </div>
        )}
        {p.children}
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTill, usePhoneWidth });
})();
