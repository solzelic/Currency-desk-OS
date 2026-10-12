/* ============================================================
   Phone cash drawer. At 430px and under, TillDrawer renders this
   instead of the desktop drawer. Wider than that, this file is
   loaded and not mounted, so the desktop drawer is untouched.

   One currency at a time. The footer is the only primary action
   (Save count, or Close the till). There is no round + on this screen.
   Amounts go through window.CDOS.formatPhoneMoney, which the phone
   shell owns (docs/PHONE_SHELL.md): "1,765.05 CAD", never a bare "$".
   Session times go through formatPhoneTime: "3:02 PM".
   A figure the ledger did not return is left out, not shown as 0.

   Reconcile is a list of currencies. Move cash and the vault are
   desktop panels: on a phone they say so, and they do not open
   those panels. Hand off is not on this card until a phone
   hand-off exists.
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

  function clock12(ms, timeZone) {
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const fn = window.CDOS && window.CDOS.formatPhoneTime;
    /* A Date is an instant. The shared formatter leaves it as an em
       dash unless the shop zone comes with it. */
    return fn ? (fn(d, timeZone) || '') : '';
  }

  /* "A. Singh" from a roster name, or from a staff id "a.singh".
     The same shape the close panel uses: an initial, then the surname. */
  function initialSurname(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const shape = (first, last) => first.charAt(0).toUpperCase() + '. ' + last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const first = words[0].replace(/\./g, '');
      const last = words[words.length - 1].replace(/\./g, '');
      if (first && last) return shape(first, last);
    }
    const bits = raw.split('.').filter(Boolean);
    if (bits.length >= 2) return shape(bits[0], bits[bits.length - 1]);
    return raw;
  }

  function operatorOf(current, roster) {
    if (!current || !current.operator || current.operator === '—') return null;
    const id = String(current.operator).toLowerCase();
    const hit = (roster || []).find(s => String(s.staffId || '').toLowerCase() === id || String(s.name || '').toLowerCase() === id);
    const source = (hit && hit.name) || current.operator;
    return { name: initialSurname(source), since: current.since || null };
  }

  function faceOf(v, ccy) {
    const n = v >= 1 && Number.isInteger(v) ? String(v) : Number(v).toFixed(2);
    return n + ' ' + ccy;
  }

  /* Counted minus expected, in words. No figure until both exist. */
  /* The amount is its own piece so Reconcile can weight it. A match
     has no amount: the phrase is the figure. Over is the amount
     plus the word, and only a short is the danger colour. */
  function diffParts(ccy, counted, expected) {
    if (counted == null || expected == null) return null;
    const v = Math.round((Number(counted) - Number(expected)) * 100) / 100;
    if (Math.abs(v) < 0.005) return { tone: 'match', amount: 'Matches the book', tail: '' };
    const said = money(Math.abs(v), ccy);
    if (!said) return null;
    return { tone: v < 0 ? 'short' : 'over', amount: said, tail: v < 0 ? ' short' : ' over' };
  }

  function diffWords(ccy, counted, expected) {
    const parts = diffParts(ccy, counted, expected);
    if (!parts) return '';
    return parts.tone === 'match' ? parts.amount : (parts.amount + parts.tail);
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
    const parts = diffParts(r.c, r.counted, r.expected);
    const words = parts ? (parts.tone === 'match' ? parts.amount : (parts.amount + parts.tail)) : '';
    const countedLine = counted ? ('Counted ' + counted) : 'Not counted yet';
    return {
      title: r.c,
      subtitle: 'Expected ' + (expected || '—'),
      countedLine: countedLine,
      figure: parts ? parts.amount : '',
      tail: parts ? parts.tail : '',
      note: words ? (countedLine + ' · ' + words) : countedLine,
      tone: parts ? parts.tone : '',
    };
  }

  /* The ledger id is till-01. The desk already calls that drawer Till 1.
     A stored display name wins ("Till 1", "Express"). A raw id such as
     till-day is not a name: the sheet says Till N for its place in
     the list. That label is never sent back as an id. */
  function spokenTill(name, index) {
    const text = String(name || '').replace(/\s+—.*/, '').trim();
    const numbered = /^till-0*(\d+)$/i.exec(text);
    if (numbered) {
      const n = Number(numbered[1]);
      if (Number.isFinite(n)) return 'Till ' + n;
    }
    if (text && !/^till[-_]/i.test(text)) return text;
    const n = index == null ? null : Number(index) + 1;
    return n ? ('Till ' + n) : 'Till';
  }

  function statusLine(note) {
    const text = String(note || '').trim();
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* A teller counting blind must not see the whole drawer valued in
     the home currency. That figure is the book. Owner and Manager
     still see it, labelled, because the desktop already shows it. */
  function tellerRole(role) {
    return role === 'Cashier' || role === 'Trainee' || role === 'Senior teller';
  }

  function QtyRow({ d, ccy, counts, setCount }) {
    const raw = (counts[ccy] || {})[d.i];
    const digits = raw == null || raw === '' ? '' : String(raw).replace(/\D/g, '');
    const have = digits === '' ? 0 : (parseInt(digits, 10) || 0);
    const shown = String(have);
    const sub = d.v * have;
    const face = faceOf(d.v, ccy);
    /* An empty row is a count of zero, which the book can answer.
       The code stays on the figure. */
    const line = money(sub, ccy) || ('0.00 ' + ccy);
    return (
      <div className="till-den-row" data-till-coin={d.t === 'coin' ? '' : undefined}>
        <span className="till-den-face">{face}</span>
        <button type="button" className="till-step" aria-label={'Remove one ' + face} onClick={() => { if (have <= 0) return; setCount(ccy, d.i, String(have - 1)); }}>−</button>
        <input className="till-den-qty" type="text" inputMode="numeric" autoComplete="off" enterKeyHint="done" aria-label={face + ' count'} value={shown} onChange={e => setCount(ccy, d.i, e.target.value.replace(/\D/g, ''))} />
        <button type="button" className="till-step" aria-label={'Add one ' + face} onClick={() => setCount(ccy, d.i, String(have + 1))}>+</button>
        <span className="till-den-sub">{line}</span>
      </div>
    );
  }

  function PhoneTill(p) {
    const [sheet, setSheet] = useState(false);
    const [aside, setAside] = useState(null);
    const [diffSheet, setDiffSheet] = useState(false);
    const loading = !!(p.serverBacked && p.balances == null && !p.error);
    const failed = !!(p.error && p.balances == null);
    const wait = useWait(loading);
    const who = operatorOf(p.current, p.roster);
    const denoms = p.denoms || [];
    /* The notes grid and the entered total are the same mode the book
       saves. A stored total opens the total field, labelled, so the
       footer never shows that figure beside rows of zero. While the
       rows are on screen the footer is their sum, including 0.00. */
    const enteringTotal = p.ccyMode(p.ccy) === 'total';
    const rowSum = denoms.reduce((sum, d) => {
      const n = parseInt((p.counts[p.ccy] || {})[d.i], 10);
      return sum + d.v * (Number.isFinite(n) ? n : 0);
    }, 0);
    const enteredRaw = parseFloat(p.quick[p.ccy]);
    const entered = Number.isFinite(enteredRaw) ? enteredRaw : null;
    const counted = p.isCounted(p.ccy);
    const total = enteringTotal ? (counted ? entered : null) : rowSum;
    const expected = p.expectedOf(p.ccy);
    const showExpected = !p.blind || !!p.revealExp[p.ccy];
    const words = showExpected && counted ? diffWords(p.ccy, total, expected) : '';
    const open = !!p.sessionOpen;
    const noSession = !!(p.serverBacked && p.balances != null && !p.error && !p.serverSession);
    const closed = !!(p.sessionClosed);
    const firstCoin = denoms.findIndex(d => d.t === 'coin');
    const amount = (n, ccy) => (n == null || !ccy) ? null : money(n, ccy);
    const Phone = window.CDOS.Phone;
    const Ic = window.CDOS.Ic;
    const tillList = p.tills || [];
    const tillIndex = tillList.findIndex(o => o.on);
    const tillSource = p.tillName || (tillIndex >= 0 ? tillList[tillIndex].name : '');
    const tillLabel = spokenTill(tillSource, tillIndex >= 0 ? tillIndex : null);
    const countStale = p.error === 'Money moved since you counted. Count again.';
    /* The headline is every currency the drawer holds, valued in the
       home currency. It is not the CAD to count. A teller in a blind
       count does not see it: expected is hidden, and this total is
       the expected drawer. */
    const showDrawer = p.drawerTotal != null && !!p.homeCcy && !(p.blind && tellerRole(p.role));

    const offLines = (p.recon || []).map(r => {
      const parts = diffParts(r.c, r.counted, r.expected);
      if (!parts || parts.tone === 'match') return null;
      const suffix = ' ' + r.c;
      const number = parts.amount.endsWith(suffix) ? parts.amount.slice(0, -suffix.length) : parts.amount;
      return { ccy: r.c, text: r.c + ' is ' + number + parts.tail + '.' };
    }).filter(Boolean);
    const footLabel = p.tab === 'reconcile' ? (p.closing ? 'Closing…' : 'Close the till') : (p.saved ? 'Saved' : (p.busy === 'count' ? 'Saving…' : 'Save count'));
    const footDisabled = p.tab === 'reconcile'
      ? (!p.canClose || p.closing || p.closeBlocked)
      : (!open || !counted || p.saved || p.busy === 'count');

    const onFoot = () => {
      if (footDisabled) return;
      if (p.tab !== 'reconcile') { p.onSave(); return; }
      /* A match keeps the review that is already there. A short or an
         over has to be named first. The first tap never posts. */
      if (offLines.length) setDiffSheet(true);
      else p.onClose();
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
              <div className="till-phone-drawer">
                {enteringTotal ? <div className="till-phone-k">Entered total</div> : null}
                <div className="till-phone-counted">{total == null ? (p.ccy + ' not counted yet') : money(total, p.ccy)}</div>
              </div>
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
      <div ref={p.rootRef} className="till-screen till-phone-host" data-app="till" data-tour="till" data-phone-till={loading ? 'loading' : (failed ? 'error' : (aside || (noSession || closed ? 'empty' : p.tab)))} data-till-blind={p.blind && tellerRole(p.role) ? '' : undefined}>
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

          {p.error ? (countStale ? (
            <div className="phone-error" role="alert">
              <p>{p.error}</p>
              <button type="button" className="phone-text-btn" onClick={() => { setAside(null); p.onCountAgain(); }}>Count again</button>
            </div>
          ) : <Phone.ErrorState message={p.error} onRetry={p.onRetry} />) : null}
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
              <div className="till-phone-head">
                <div className="till-phone-id">
                  {tillLabel ? <button type="button" className="till-phone-till" onClick={() => setSheet(true)}>{tillLabel}</button> : null}
                  <div className="till-phone-meta">
                    <div>{who ? (who.name + (who.since ? ', since ' + clock12(who.since, p.timeZone) : '')) : 'Nobody on this till'}</div>
                    <div>
                      {p.sessionNumber != null ? ('Session #' + p.sessionNumber + ' open') : 'No open session'}
                      {', ' + p.countedN + ' of ' + p.reconCount + ' counted'}
                    </div>
                  </div>
                </div>
                {showDrawer ? (
                  <div className="till-phone-drawer">
                    <div className="till-phone-k">Drawer value, all currencies in {p.homeCcy}</div>
                    <div className="till-phone-amount">{amount(p.drawerTotal, p.homeCcy)}</div>
                  </div>
                ) : null}
              </div>
              {/* Hand off is a desktop dialog and a dead end on a phone.
                  Put the button back beside these two when a phone hand-off exists. */}
              <div className="till-phone-actions">
                <button type="button" onClick={() => setAside('move')} disabled={!p.canMove}>Move cash</button>
                <button type="button" onClick={() => setAside('vault')}>Vault</button>
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
                <button type="button" className="till-phone-link" onClick={() => {
                  if (enteringTotal) {
                    p.setMode(m => ({ ...m, [p.ccy]: 'denom' }));
                    return;
                  }
                  const any = denoms.some(d => parseInt((p.counts[p.ccy] || {})[d.i], 10) > 0);
                  if (any) p.setQuick(o => ({ ...o, [p.ccy]: rowSum.toFixed(2) }));
                  p.setMode(m => ({ ...m, [p.ccy]: 'total' }));
                  p.stamp(p.ccy);
                }}>{enteringTotal ? 'Count notes' : 'Enter total instead'}</button>
              </div>
              {enteringTotal ? (
                <label className="till-phone-total">
                  <span>{p.ccy}</span>
                  <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label={p.ccy + ' total'} value={p.quick[p.ccy] ?? ''} onChange={e => { p.setMode(m => ({ ...m, [p.ccy]: 'total' })); p.setQuick(o => ({ ...o, [p.ccy]: e.target.value.replace(/[^0-9.]/g, '') })); p.stamp(p.ccy); }} />
                </label>
              ) : (
                <div className="till-phone-list">
                  {denoms.map((d, i) => (
                    <React.Fragment key={d.i}>
                      {i === firstCoin ? <h3 className="till-phone-group">Coins</h3> : null}
                      <QtyRow d={d} ccy={p.ccy} counts={p.counts} setCount={(ccy, i, value) => { p.setMode(m => ({ ...m, [ccy]: 'denom' })); p.setCount(ccy, i, value); }} />
                    </React.Fragment>
                  ))}
                </div>
              )}
            </>
          )}

          {showWork && p.tab === 'reconcile' && (
            <>
              <Phone.ListSection title="Currencies">
                {p.recon.map(r => {
                  const copy = reconCopy(r);
                  const note = copy.figure ? (
                    <>
                      {copy.countedLine}
                      {' · '}
                      <span className={'till-recon-amt is-' + copy.tone}>{copy.figure}</span>
                      {copy.tail}
                    </>
                  ) : copy.countedLine;
                  return <Phone.ListRow key={r.c} className={'till-recon-row' + (copy.tone ? (' is-' + copy.tone) : '')} title={copy.title} subtitle={copy.subtitle} note={note} />;
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
              {tillList.map((o, i) => (
                <button type="button" key={o.key} className="till-sheet-row" aria-current={o.on ? 'true' : undefined} onClick={() => { setSheet(false); p.onPickTill(o.key); }}>
                  <span>{spokenTill(o.name, i)}</span>
                  {o.on
                    ? <span className="till-sheet-check" aria-label="Current till">{Ic ? <Ic n="check" s={16} /> : null}</span>
                    : <span className="till-sheet-status">{o.occupant || statusLine(o.note)}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {diffSheet && (
          <div className="till-sheet" role="dialog" aria-label="Close anyway">
            <button type="button" className="till-sheet-scrim" aria-label="Back to reconcile" onClick={() => setDiffSheet(false)} />
            <div className="till-sheet-panel">
              <div className="till-sheet-title">Close anyway?</div>
              {offLines.map(line => <p key={line.ccy} className="till-diff-line">{line.text}</p>)}
              <button type="button" className="till-save" onClick={() => {
                const first = offLines[0];
                setDiffSheet(false);
                if (first) p.setCcy(first.ccy);
                p.setTab('count');
              }}>Count again</button>
              <button type="button" className="till-sheet-quiet" onClick={() => { setDiffSheet(false); p.onConfirmClose(); }}>Close with difference</button>
            </div>
          </div>
        )}

        {p.confirmClose && (
          <div className="till-sheet" role="dialog" aria-label="Close the till">
            <button type="button" className="till-sheet-scrim" aria-label="Back to the count" onClick={() => p.setConfirmClose(false)} />
            <div className="till-sheet-panel">
              <div className="till-sheet-title">Close the till</div>
              <p className="till-phone-note">Review the difference on each currency. Closing writes each counted figure back as the till balance.</p>
              {p.recon.map(r => {
                const copy = reconCopy(r);
                return (
                  <div key={r.c} className={'till-sheet-line' + (copy.tone ? (' is-' + copy.tone) : '')}>
                    <b>{copy.title}</b>
                    <span>{copy.subtitle}</span>
                    <span className="till-sheet-diff">{copy.note}</span>
                  </div>
                );
              })}
              {p.closeNote ? <p className="till-phone-note">{p.closeNote}</p> : null}
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
