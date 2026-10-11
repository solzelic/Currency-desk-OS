/* ============================================================
   Long-tail phone template.

   One screen for the apps under More. It is the phone shell's
   Screen, cards, chips, search, rows, and one sticky button.
   Read-only apps omit the button.

   Phone only. usePhone() is false above 430px, and the caller
   does not mount this tree there. The shop header and the bottom
   bar belong to the shell. This file is the content between them.

   Amounts go through window.CDOS.formatPhoneMoney, which the
   phone shell installs. A figure it will not format stays absent
   and the screen says "No rate yet". Never a bare zero.

   See docs/PHONE_SHELL.md.
   ============================================================ */
(function () {
  const { useState, useEffect, useRef } = React;
  const QUERY = '(max-width: 430px)';

  function usePhone() {
    const [on, setOn] = useState(() => window.matchMedia(QUERY).matches);
    useEffect(() => {
      const mq = window.matchMedia(QUERY);
      const go = () => setOn(mq.matches);
      go();
      mq.addEventListener('change', go);
      return () => mq.removeEventListener('change', go);
    }, []);
    return on;
  }

  /* '' from the formatter means there is no figure. A real zero is "0.00 CAD". */
  function money(amount, code) {
    const text = window.CDOS.formatPhoneMoney(amount, code);
    return text || null;
  }

  function ccyName(code) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) || code;
    } catch (e) {
      /* An unknown code has no English name. The code itself is the label. */
      return code;
    }
  }

  function Segments({ items, value, onChange }) {
    return (
      <div className="phone-seg" role="tablist">
        {items.map(s => (
          <button key={s.id} type="button" role="tab" aria-selected={value === s.id} className={value === s.id ? 'is-on' : ''} onClick={() => onChange(s.id)}>{s.label}</button>
        ))}
      </div>
    );
  }

  function LongTailScreen(props) {
    const Phone = window.CDOS.Phone;
    const ready = props.state == null || props.state === 'ready';
    const showAction = props.action && props.state !== 'loading' && props.state !== 'error';
    const cards = (props.summary || []).map(card => ({
      label: card.label,
      value: card.value == null ? 'No rate yet' : card.value,
      caption: card.sub,
    }));
    const filters = ready && props.segments && props.segments.length >= 2 && props.segments.length <= 4
      ? <Segments items={props.segments} value={props.segment} onChange={props.onSegment} />
      : (ready && props.chips ? <Phone.FilterChips chips={props.chips} value={props.chip} onChange={props.onChip} /> : null);
    return (
      <Phone.Screen
        app={props.app}
        className="longtail"
        title={props.title}
        sticky={showAction ? <Phone.StickyAction label={props.action} onClick={props.onAction} /> : null}
        top={<>
          {props.toast ? <div className="phone-toast" role="status">{props.toast}</div> : null}
          {props.sheet || null}
        </>}
      >
        {props.state === 'loading' && (
          <div>
            <p className="phone-note">{props.loadingText || 'Loading…'}</p>
            <Phone.LoadingState rows={6} label={props.loadingText || 'Loading'} />
          </div>
        )}
        {props.state === 'error' && (
          <div>
            <Phone.ErrorState message={props.errorText} onRetry={props.onRetry} />
            {props.errorDetail && props.errorDetail !== props.errorText ? <p className="phone-error-detail">{props.errorDetail}</p> : null}
          </div>
        )}
        {props.state === 'empty' && (
          <Phone.EmptyState title={props.emptyText} actionLabel={props.emptyAction} onAction={props.onEmpty} />
        )}
        {ready && cards.length > 0 && <Phone.SummaryCards columns={cards.length > 1 ? 2 : 3} cards={cards} />}
        {filters}
        {ready && (
          <Phone.Search value={props.search || ''} onChange={props.onSearch} placeholder={props.searchPlaceholder || 'Search'} label={props.searchPlaceholder || 'Search'} />
        )}
        {ready ? props.children : null}
      </Phone.Screen>
    );
  }

  /* ---- Vault ---------------------------------------------------------- */

  const VAULT_TABS = [
    { id: 'cash', label: 'Cash' },
    { id: 'floats', label: 'Floats' },
    { id: 'orders', label: 'Orders' },
    { id: 'profit', label: 'Profit' },
  ];

  function stockBadge(code, qty, settings) {
    const fn = window.CDOS.vaultStock;
    if (!fn) return null;
    const band = fn(code, Number(qty), settings);
    if (!band || band.label === 'no band') return null;
    if (band.level === 'low') return { tone: 'neg', label: 'Running low' };
    if (band.level === 'high') return { tone: 'warn', label: 'Too much' };
    return { tone: 'pos', label: 'Healthy' };
  }

  function homeOf(position) {
    return (position && position.homeCurrency) || (window.CDOS.deskHomeCcy && window.CDOS.deskHomeCcy()) || 'CAD';
  }

  function clockLabel(date) {
    if (!date) return '';
    return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
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
          <div className="phone-worth"><span>Float worth</span><b>{worth == null ? 'No rate yet' : worth}</b></div>
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
    const [readAt, setReadAt] = useState(null);
    useEffect(() => { if (!loading && position) setReadAt(new Date()); }, [loading, position]);
    useEffect(() => {
      if (!toast) return undefined;
      const t = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(t);
    }, [toast]);
    const home = homeOf(position);
    const rows = (position && position.vaultTracked)
      ? (position.currencies || []).filter(r => r.vault && Number(r.vault.quantity) > 0).map(r => ({
          code: r.currency,
          name: ccyName(r.currency),
          qty: r.vault.quantity,
          worth: r.vault.marketValueHome,
          badge: stockBadge(r.currency, r.vault.quantity, settings),
        }))
      : null;
    const needle = q.trim().toLowerCase();
    const match = (text) => !needle || String(text || '').toLowerCase().includes(needle);
    let state = 'ready';
    let emptyText = '';
    let emptyAction = '';
    if (loading) state = 'loading';
    else if (error) state = 'error';
    else if (!rows) {
      state = 'empty';
      emptyText = 'This vault has no opening position on the ledger, so there is nothing it can say the safe holds.';
      emptyAction = 'Put the vault on the ledger';
    }
    const held = rows || [];
    const shown = held.filter(r => match(r.name + ' ' + r.code));
    const total = position && position.vaultTotals ? position.vaultTotals.marketValueHome : null;
    const when = clockLabel(readAt);
    const summaryCard = [{
      label: 'Cash in the vault, valued in ' + home,
      value: total == null ? null : money(total, home),
      sub: (rows ? rows.length : 0) + (rows && rows.length === 1 ? ' currency' : ' currencies') + ' · from the ledger' + (when ? ', ' + when : ''),
    }];
    const openShifts = (shifts || []).filter(s => s.status === 'open');
    const orders = (receipts || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const profitRows = ((summary && summary.data && summary.data.byCurrency) || []).filter(r => r.deals > 0);
    const realized = summary && summary.data ? summary.data.realizedPnlHome : null;
    const worthLine = (r) => r.code === home ? 'home currency' : (r.worth == null ? 'No rate yet' : 'worth ' + money(r.worth, home));

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
            <div className="phone-kv"><span>Worth</span><b>{detail.code === home ? 'Home currency' : (detail.worth == null ? 'No rate yet' : money(detail.worth, home))}</b></div>
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
        emptyAction={emptyAction}
        onEmpty={onRecordOpening}
        summary={state === 'ready' ? (tab === 'profit'
          ? [{ label: 'Realized profit, in ' + home, value: realized == null ? null : money(realized, home), sub: 'From the ledger, past 30 days' }]
          : summaryCard) : null}
        segments={VAULT_TABS} segment={tab} onSegment={setTab}
        search={q} onSearch={setQ} searchPlaceholder={tab === 'floats' ? 'Find a cashier' : tab === 'orders' ? 'Find an order' : 'Find a currency'}
        action="Give out a float"
        onAction={() => setSheet(true)}
        toast={toast}
        sheet={<>{sheet && <FloatSheet settings={settings} branches={branches} station={station} position={position} onClose={() => setSheet(false)} onAssignPerson={onAssignPerson} onIssueTill={onIssueTill} onDone={(label, worthText) => { setSheet(false); setToast('Float given to ' + label + '. ' + worthText + '.'); }} />}{detailNode}</>}
      >
        {body}
      </LongTailScreen>
    );
  }

  /* ---- Audit trail (read-only) --------------------------------------- */

  const AUDIT_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'deals', label: 'Deals' },
    { id: 'cash', label: 'Cash' },
    { id: 'sign', label: 'Sign-ins' },
    { id: 'settings', label: 'Settings' },
    { id: 'staff', label: 'Staff' },
  ];
  const PLAIN = {
    'transaction.post': 'Deal posted',
    'transaction.reverse': 'Deal reversed',
    'vault.run': 'Vault run',
    'compliance.jurisdiction_pack.adopt': 'Rules updated',
  };

  function plainAction(action) {
    if (!action) return 'Recorded';
    if (PLAIN[action]) return PLAIN[action];
    /* A dotted internal code is not a name a person can read. */
    if (/^[a-z0-9_.]+$/.test(action) && action.indexOf('.') !== -1) {
      const last = action.split('.').pop().replace(/_/g, ' ');
      return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return action;
  }

  function auditGroup(action) {
    const a = String(action || '').toLowerCase();
    if (/sign/.test(a)) return 'sign';
    if (/setting|rate|permission|threshold|rule/.test(a)) return 'settings';
    if (/staff|kyc|employee|role/.test(a)) return 'staff';
    if (/float|cash|vault|till|order|cheque|drawer/.test(a)) return 'cash';
    if (/deal|transaction|posted|void|tag/.test(a)) return 'deals';
    return 'other';
  }

  function localDay(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function PhoneAudit({ audit, settings, onOpenRef }) {
    const Phone = window.CDOS.Phone;
    const [q, setQ] = useState('');
    const [chip, setChip] = useState('all');
    const [open, setOpen] = useState(null);
    const use12 = ((settings && settings.timeFormat) || '12h') !== '24h';
    const items = (audit || []).map((a, i) => {
      const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(a.ts || '');
      const date = m ? m[1] : String(a.ts || '').slice(0, 10);
      const hh = m ? +m[2] : 0;
      const mm = m ? m[3] : '00';
      let time = m ? m[2] + ':' + mm : '';
      if (m && use12) {
        const ap = hh < 12 ? 'AM' : 'PM';
        let h = hh % 12; if (h === 0) h = 12;
        time = h + ':' + mm + ' ' + ap;
      }
      return { ...a, i, date, time, title: plainAction(a.action), group: auditGroup(a.action) };
    });
    const needle = q.trim().toLowerCase();
    const filtered = items.filter(a => {
      if (chip !== 'all' && a.group !== chip) return false;
      if (!needle) return true;
      const hay = (a.title + ' ' + a.action + ' ' + a.detail + ' ' + a.user + ' ' + a.ts).toLowerCase();
      return hay.includes(needle);
    });
    const today = localDay(new Date());
    const yestDate = new Date(); yestDate.setDate(yestDate.getDate() - 1);
    const yesterday = localDay(yestDate);
    const dayName = (d) => d === today ? 'Today' : d === yesterday ? 'Yesterday' : d;
    const groups = [];
    filtered.forEach(a => {
      const last = groups[groups.length - 1];
      if (!last || last.date !== a.date) groups.push({ date: a.date, label: dayName(a.date), rows: [a] });
      else last.rows.push(a);
    });
    const refOf = (detail) => {
      const m = /\b([A-Z]{2,4}-\d[\w-]*)/.exec(detail || '');
      return m ? m[1] : '';
    };
    const state = !audit ? 'loading' : (items.length === 0 ? 'empty' : 'ready');
    return (
      <LongTailScreen
        app="audit" title="Audit trail" state={state}
        loadingText="Reading the trail…"
        errorText="The audit trail did not load. Try again."
        emptyText="Nothing is on the trail yet."
        chips={AUDIT_CHIPS} chip={chip} onChip={setChip}
        search={q} onSearch={setQ} searchPlaceholder="Find an action, name or number"
        sheet={open && (
          <div className="phone-sheet" role="dialog" aria-label="Audit detail">
            <div className="phone-sheet-h"><span /><h2>{open.title}</h2><button type="button" className="phone-sheet-x" onClick={() => setOpen(null)}>Close</button></div>
            <div className="phone-sheet-b">
              <div className="phone-kv"><span>When</span><b>{open.ts}</b></div>
              <div className="phone-kv"><span>Who</span><b>{open.user}</b></div>
              <div className="phone-kv"><span>What</span><b>{open.title}</b></div>
              {open.detail && <div className="phone-kv"><span>Detail</span><b>{open.detail}</b></div>}
              {refOf(open.detail) && onOpenRef && (
                <button type="button" className="phone-sticky-btn" onClick={() => onOpenRef([refOf(open.detail)], refOf(open.detail))}>Open {refOf(open.detail)}</button>
              )}
            </div>
          </div>
        )}
      >
        {filtered.length === 0 && <p className="phone-miss">Nothing matches that search.</p>}
        {groups.map(g => (
          <Phone.ListSection key={g.date} title={g.label}>
            {g.rows.map(a => (
              <Phone.ListRow key={a.i} title={a.title} subtitle={a.detail || ('By ' + a.user)} meta={(a.time ? a.time + ' · ' : '') + 'By ' + a.user} onClick={() => setOpen(a)} />
            ))}
          </Phone.ListSection>
        ))}
      </LongTailScreen>
    );
  }

  window.CDOS.LongTail = { usePhone, LongTailScreen, PhoneVault, PhoneAudit, money };
})();
