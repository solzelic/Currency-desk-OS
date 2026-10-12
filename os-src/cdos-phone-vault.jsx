/* Phone vault. Caller of LongTailScreen. The ledger still owns
   the position, the opening count, and the till movement. */
(function () {
  const { useState, useEffect, useRef } = React;
  const { LongTailScreen, money, ccyName } = window.CDOS.LongTail;

  /* ---- Vault ---------------------------------------------------------- */

  const VAULT_TABS = [
    { id: 'cash', label: 'Cash' },
    { id: 'floats', label: 'Floats' },
    { id: 'orders', label: 'Orders' },
    { id: 'profit', label: 'Profit' },
  ];

  /* A low-stock badge only when the owner set a level. The built-in
     reorder bands are not that level, and they are not shown here.
     Home currency: settings.vaultReserveCad. Any other currency:
     settings.vaultFloors[code]. Both have to be a number above zero.
     Below that level the row says "Running low". Otherwise no badge. */
  function configuredFloor(code, settings, home) {
    if (!settings) return 0;
    if (code === home && settings.vaultReserveCad != null && settings.vaultReserveCad !== '' && +settings.vaultReserveCad > 0) {
      return +settings.vaultReserveCad;
    }
    const floor = settings.vaultFloors && settings.vaultFloors[code];
    if (floor != null && floor !== '' && +floor > 0) return +floor;
    return 0;
  }

  function stockBadge(code, qty, settings, home) {
    const floor = configuredFloor(code, settings, home);
    if (!floor || !(Number(qty) < floor)) return null;
    return { tone: 'neg', label: 'Running low' };
  }

  /* The position prices a currency only from ledger_rates. This desk's
     hourly board lives in the rate book the Rates app shows, which
     homePerUnit already reads. A missing board rate stays absent. */
  function boardPerUnit(code, home) {
    if (!code || code === home) return 1;
    const per = window.CDOS.homePerUnit ? Number(window.CDOS.homePerUnit(code)) : 0;
    return per > 0 && Number.isFinite(per) ? per : 0;
  }

  function priceHolding(marketValueHome, code, qty, home) {
    const ledger = marketValueHome == null || marketValueHome === ''
      ? null
      : Number(String(marketValueHome).replace(/,/g, ''));
    if (ledger != null && Number.isFinite(ledger)) return { worth: ledger, fromBoard: false };
    const per = boardPerUnit(code, home);
    const units = Number(qty);
    if (per && Number.isFinite(units)) return { worth: units * per, fromBoard: true };
    return { worth: null, fromBoard: false };
  }

  function homeOf(position) {
    return (position && position.homeCurrency) || (window.CDOS.deskHomeCcy && window.CDOS.deskHomeCcy()) || 'CAD';
  }

  /* The board's publishedAt is epoch milliseconds. A Date needs the
     shop zone or the formatter returns a dash. No stamp, or a dash,
     means the time clause is left off. */
  function boardClock(settings) {
    let at = null;
    try {
      const cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || 'null');
      if (cfg && cfg.publishedAt != null && cfg.publishedAt !== '') at = cfg.publishedAt;
    } catch (e) { /* A missing board has no updated time. */ }
    const fn = window.CDOS.formatPhoneTime;
    if (at == null || typeof fn !== 'function') return '';
    const zone = (settings && settings.timezone) || 'America/Toronto';
    const instant = typeof at === 'number' ? new Date(at) : at;
    const text = fn(instant, zone);
    if (!text || /[\u2014\u2013]/.test(text)) return '';
    return /^\d{1,2}:\d{2} (AM|PM)$/.test(text) ? text : '';
  }

  /* Sum of the home figures the position already returned. A currency
     with no rate is named, not counted as zero, and not given a rate
     the ledger did not publish. */
  function knownHomeWorth(rows) {
    const unvalued = [];
    let sum = 0;
    let any = false;
    (rows || []).forEach(r => {
      if (r.worth == null || r.worth === '') { unvalued.push(r.code); return; }
      const n = Number(String(r.worth).replace(/,/g, ''));
      if (!Number.isFinite(n)) { unvalued.push(r.code); return; }
      any = true;
      sum += n;
    });
    return { unvalued, sum: any ? sum : null };
  }

  function FloatSheet({ settings, branches, station, position, onClose, onAssignPerson, onIssueTill, onDone }) {
    const home = homeOf(position);
    const tracked = !!(position && position.vaultTracked);
    const staff = (settings && settings.employees && settings.employees.length) ? settings.employees : (window.CDOS.STAFF || []);
    const people = staff.filter(e => e.active !== false && (e.role === 'Cashier' || e.role === 'Senior teller'));
    const cashiers = people.filter(e => e.role === 'Cashier');
    const branch = (branches || []).find(b => b.id === (station && station.branchId)) || (branches || [])[0];
    const tills = (branch && branch.tills) || [];
    const usual = (settings && Array.isArray(settings.floatCcys) && settings.floatCcys.length)
      ? settings.floatCcys
      : Array.from(new Set([home, 'USD', 'EUR', 'GBP']));
    const [target, setTarget] = useState('person');
    const [teller, setTeller] = useState(cashiers.length === 1 ? cashiers[0].name : (people[0] && people[0].name) || '');
    const [tillId, setTillId] = useState((station && station.tillId) || (tills[0] && tills[0].id) || '');
    const [codes, setCodes] = useState(usual);
    const [amounts, setAmounts] = useState({});
    const [err, setErr] = useState('');
    const [issuing, setIssuing] = useState(false);
    /* One key per currency for the life of this sheet. A second tap
       resends the same key, and the ledger records the movement once. */
    const keys = useRef({});
    const busy = useRef(false);
    const keyFor = (code) => {
      if (!keys.current[code]) {
        keys.current[code] = (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID()
          : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      }
      return keys.current[code];
    };
    const deskCodes = (window.CDOS.deskCurrencyList && window.CDOS.deskCurrencyList()) || usual;
    const extra = deskCodes.filter(c => !codes.includes(c));
    const lines = codes.map(code => {
      const n = Number(amounts[code]);
      if (!amounts[code] || !n) return { code, n: 0, missing: false, home: 0 };
      if (code === home) return { code, n, missing: false, home: n };
      const per = window.CDOS.homePerUnit ? window.CDOS.homePerUnit(code) : 0;
      if (!per) return { code, n, missing: true, home: null };
      return { code, n, missing: false, home: n * per };
    }).filter(l => l.n > 0);
    const missingRate = lines.some(l => l.missing);
    const total = missingRate ? null : lines.reduce((s, l) => s + l.home, 0);
    const worth = lines.length === 0 ? money(0, home) : (missingRate ? null : money(total, home));
    const who = target === 'person' ? teller : ((tills.find(t => t.id === tillId) || {}).name || '').replace(/\s+—.*/, '');
    const valid = lines.length > 0 && (target === 'person' ? !!teller : !!tillId);
    const setAmt = (code, raw) => {
      if (raw === '' || /^\d*\.?\d{0,2}$/.test(raw)) setAmounts(a => ({ ...a, [code]: raw }));
    };
    const submit = async () => {
      if (busy.current || issuing || !valid) return;
      busy.current = true;
      setIssuing(true);
      setErr('');
      const opening = {};
      lines.forEach(l => { opening[l.code] = l.n; });
      try {
        if (target === 'person') {
          onAssignPerson(teller, opening);
          onDone(teller, worth || lines.map(l => money(l.n, l.code)).filter(Boolean).join(', '));
          return;
        }
        const keyMap = {};
        lines.forEach(l => { keyMap[l.code] = 'web-move:' + keyFor(l.code); });
        const result = await onIssueTill(tillId, opening, keyMap);
        if (result && result.ok === false) {
          setErr(result.message || 'That float was refused.');
          return;
        }
        onDone(who || 'the till', worth || lines.map(l => money(l.n, l.code)).filter(Boolean).join(', '));
      } catch (e) {
        setErr((e && e.message) || 'That float was refused.');
      } finally {
        busy.current = false;
        setIssuing(false);
      }
    };
    return (
      <div className="phone-sheet" role="dialog" aria-label="Give out a float">
        <div className="phone-sheet-h">
          <span />
          <h2>Give out a float</h2>
          <button type="button" className="phone-sheet-x" onClick={onClose}>Cancel</button>
        </div>
        <div className="phone-sheet-b">
          <div className="phone-label">Who gets it?</div>
          <div className="phone-tiles">
            <button type="button" className={'phone-tile' + (target === 'person' ? ' is-on' : '')} onClick={() => setTarget('person')}>
              <b>A cashier</b><small>They answer for it at close</small>
            </button>
            <button type="button" className={'phone-tile' + (target === 'till' ? ' is-on' : '')} onClick={() => setTarget('till')}>
              <b>A till</b><small>Moves cash to the drawer</small>
            </button>
          </div>
          {target === 'person' ? (
            <label className="phone-field">Cashier
              <select value={teller} onChange={e => setTeller(e.target.value)} aria-label="Cashier">
                {people.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </label>
          ) : (
            <label className="phone-field">Till
              <select value={tillId} onChange={e => setTillId(e.target.value)} aria-label="Till">
                {tills.map(t => <option key={t.id} value={t.id}>{t.name.replace(/\s+—.*/, '')}</option>)}
              </select>
            </label>
          )}
          {!tracked && <p className="phone-warn" role="status">This vault has no opening position on the ledger yet. A float to a till is refused until the safe is counted.</p>}
          <div className="phone-label">Opening float</div>
          {codes.map(code => (
            <label key={code} className="phone-crow">
              <b>{code}</b>
              <input inputMode="decimal" value={amounts[code] || ''} placeholder="0.00" aria-label={code + ' amount'} onChange={e => setAmt(code, e.target.value)} />
            </label>
          ))}
          {extra.length > 0 && (
            <label className="phone-add">
              <select value="" aria-label="Add a currency" onChange={e => { if (e.target.value) setCodes(list => list.concat(e.target.value)); }}>
                <option value="">Add a currency</option>
                {extra.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <div className="phone-worth"><span>Float worth</span><b>{worth == null ? 'The rate board has not published a rate.' : worth}</b></div>
          {err && <p className="phone-warn" role="alert">{err}</p>}
        </div>
        <div className="phone-sheet-f">
          <button type="button" className="phone-sticky-btn" disabled={!valid || issuing} onClick={submit}>
            {issuing ? 'Giving the float…' : (who ? 'Give float to ' + who : 'Give float')}
          </button>
        </div>
      </div>
    );
  }

  function PhoneVault(props) {
    const Phone = window.CDOS.Phone;
    const { position, loading, error, onRetry, settings, shifts, receipts, summary, branches, station, onAssignPerson, onIssueTill, onRecordOpening } = props;
    const [tab, setTab] = useState('cash');
    const [q, setQ] = useState('');
    const [sheet, setSheet] = useState(false);
    const [detail, setDetail] = useState(null);
    const [toast, setToast] = useState('');
    const [ratesAt, setRatesAt] = useState(0);
    useEffect(() => {
      const bump = () => setRatesAt(n => n + 1);
      window.addEventListener('storage', bump);
      return () => window.removeEventListener('storage', bump);
    }, []);
    useEffect(() => {
      if (!toast) return undefined;
      const t = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(t);
    }, [toast]);
    const home = homeOf(position);
    void ratesAt;
    const rows = (position && position.vaultTracked)
      ? (position.currencies || []).filter(r => r.vault && Number(r.vault.quantity) > 0).map(r => {
          const priced = priceHolding(r.vault.marketValueHome, r.currency, r.vault.quantity, home);
          return {
            code: r.currency,
            name: ccyName(r.currency),
            qty: r.vault.quantity,
            worth: priced.worth,
            fromBoard: priced.fromBoard,
            badge: stockBadge(r.currency, r.vault.quantity, settings, home),
          };
        })
      : null;
    const needle = q.trim().toLowerCase();
    const match = (text) => !needle || String(text || '').toLowerCase().includes(needle);
    let state = 'ready';
    let emptyText = '';
    let emptyBody = '';
    let emptyAction = '';
    if (loading) state = 'loading';
    else if (error) state = 'error';
    else if (!rows) {
      state = 'empty';
      emptyText = 'No opening count yet';
      emptyBody = 'Count the safe once so the vault knows what it holds.';
      emptyAction = 'Count the vault';
    }
    const held = rows || [];
    const shown = held.filter(r => match(r.name + ' ' + r.code));
    const total = position && position.vaultTotals ? position.vaultTotals.marketValueHome : null;
    const known = knownHomeWorth(held);
    const pricedOnBoard = held.some(r => r.fromBoard);
    const when = pricedOnBoard ? boardClock(settings) : '';
    /* homePerUnit is the board mid: CAD per 1 unit, the same figure
       cadValue uses. Buy and sell are that mid plus or minus the
       margin, and this total does not use them. */
    const countLine = (rows ? rows.length : 0) + (rows && rows.length === 1 ? ' currency' : ' currencies')
      + (pricedOnBoard ? ' · mid-market rate' : ' · from the ledger')
      + (when ? ', ' + when : '');
    /* The ledger total is the headline only when it priced every row.
       A gap is filled from the rate board. A currency neither source
       can price is named, and it is not counted as zero. */
    const headline = known.unvalued.length
      ? (known.sum == null ? null : money(known.sum, home))
      : (pricedOnBoard ? (known.sum == null ? null : money(known.sum, home)) : (total == null ? null : money(total, home)));
    const summaryCard = [{
      label: 'Cash in the vault, valued in ' + home,
      value: headline,
      sub: known.unvalued.length
        ? ('The rate board has not published a rate for ' + known.unvalued.map(code => ccyName(code)).join(', ') + '.')
        : countLine,
    }];
    const openShifts = (shifts || []).filter(s => s.status === 'open');
    const orders = (receipts || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const profitRows = ((summary && summary.data && summary.data.byCurrency) || []).filter(r => r.deals > 0);
    const realized = summary && summary.data ? summary.data.realizedPnlHome : null;
    const worthLine = (r) => r.code === home ? 'home currency' : (r.worth == null ? ('The rate board has not published a ' + r.name + ' rate.') : 'worth ' + money(r.worth, home));

    let body = null;
    if (state === 'ready' && tab === 'cash') {
      body = rows.length === 0
        ? <p className="phone-miss">This vault is on the ledger and holds nothing.</p>
        : shown.length
        ? <div className="phone-list">{shown.map(r => (
            <div key={r.code} data-currency={r.code}>
              <Phone.ListRow title={r.name} subtitle={worthLine(r)} amount={money(r.qty, r.code)} badge={r.badge} onClick={() => setDetail(r)} />
            </div>
          ))}</div>
        : <p className="phone-miss">No currency matches that.</p>;
    } else if (state === 'ready' && tab === 'floats') {
      const list = openShifts.filter(s => match(s.teller));
      body = list.length
        ? <div className="phone-list">{list.map(s => (
            <Phone.ListRow key={s.id} title={s.teller} subtitle="The count stays hidden until it is locked." amount="Open" onClick={() => setDetail({ shift: s })} />
          ))}</div>
        : <p className="phone-miss">No float is out.</p>;
    } else if (state === 'ready' && tab === 'orders') {
      const list = orders.filter(o => match((o.ref || '') + ' ' + (o.ccy || '') + ' ' + (o.supplier || '')));
      body = list.length
        ? <div className="phone-list">{list.map(o => (
            <Phone.ListRow key={o.id} title={o.ccy + ' · ' + (o.status === 'pending' ? 'On order' : 'Received')} subtitle={o.supplier || o.ref} amount={money(o.units, o.ccy)} onClick={() => setDetail({ order: o })} />
          ))}</div>
        : <p className="phone-miss">No orders.</p>;
    } else if (state === 'ready' && tab === 'profit') {
      if (summary && summary.loading) body = <p className="phone-miss">Reading the book…</p>;
      else if (summary && summary.error) body = <p className="phone-warn" role="alert">{summary.error}</p>;
      else if (!profitRows.length) body = <p className="phone-miss">Nothing posted in this period.</p>;
      else body = <div className="phone-list">{profitRows.filter(r => match(r.currency)).map(r => (
        <Phone.ListRow key={r.currency} title={r.currency} subtitle={r.deals + ' deal' + (r.deals === 1 ? '' : 's') + ' · realized'} amount={r.realizedPnlHome == null ? 'No rate yet' : money(r.realizedPnlHome, home)} />
      ))}</div>;
    }

    const detailNode = detail && (
      <div className="phone-sheet" role="dialog" aria-label="Detail">
        <div className="phone-sheet-h"><span /><h2>Detail</h2><button type="button" className="phone-sheet-x" onClick={() => setDetail(null)}>Close</button></div>
        <div className="phone-sheet-b">
          {detail.shift && <>
            <p className="phone-label">{detail.shift.teller}</p>
            <p>The count stays hidden until it is locked. Settle this float at the desk.</p>
            {Object.keys(detail.shift.opening || {}).map(c => (
              <div key={c} className="phone-kv"><span>{c}</span><b>{money(detail.shift.opening[c], c)}</b></div>
            ))}
          </>}
          {detail.order && <>
            <div className="phone-kv"><span>Currency</span><b>{detail.order.ccy}</b></div>
            <div className="phone-kv"><span>Units</span><b>{money(detail.order.units, detail.order.ccy)}</b></div>
            <div className="phone-kv"><span>Status</span><b>{detail.order.status}</b></div>
            {detail.order.ref && <div className="phone-kv"><span>Reference</span><b>{detail.order.ref}</b></div>}
          </>}
          {detail.code && <>
            <div className="phone-kv"><span>Currency</span><b>{detail.name}</b></div>
            <div className="phone-kv"><span>In the vault</span><b>{money(detail.qty, detail.code)}</b></div>
            <div className="phone-kv"><span>Worth</span><b>{detail.code === home ? 'Home currency' : (detail.worth == null ? ('The rate board has not published a ' + detail.name + ' rate.') : money(detail.worth, home))}</b></div>
          </>}
        </div>
      </div>
    );

    return (
      <LongTailScreen
        app="vault" title="Vault"
        state={state}
        loadingText="Reading the vault off the ledger…"
        errorText="The vault did not load. Try again."
        errorDetail={error}
        onRetry={onRetry}
        emptyText={emptyText}
        emptyBody={emptyBody}
        emptyAction={emptyAction}
        onEmpty={onRecordOpening}
        summary={state === 'ready' ? (tab === 'profit'
          ? [{ label: 'Realized profit, in ' + home, value: realized == null ? null : money(realized, home), sub: 'From the ledger, past 30 days' }]
          : summaryCard) : null}
        segments={VAULT_TABS} segment={tab} onSegment={setTab}
        search={q} onSearch={setQ} searchPlaceholder={tab === 'floats' ? 'Find a cashier' : tab === 'orders' ? 'Find an order' : 'Find a currency'}
        action={state === 'ready' ? 'Give out a float' : null}
        onAction={() => setSheet(true)}
        toast={toast}
        sheet={<>{sheet && <FloatSheet settings={settings} branches={branches} station={station} position={position} onClose={() => setSheet(false)} onAssignPerson={onAssignPerson} onIssueTill={onIssueTill} onDone={(label, worthText) => { setSheet(false); setToast('Float given to ' + label + '. ' + worthText + '.'); }} />}{detailNode}</>}
      >
        {body}
      </LongTailScreen>
    );
  }


  window.CDOS.LongTail.PhoneVault = PhoneVault;
})();
