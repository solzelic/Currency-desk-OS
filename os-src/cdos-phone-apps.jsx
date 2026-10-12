/* Phone screens for the remaining More apps.
   Calculator and Tagged are LongTailScreen. Dashboard, the loan
   calculator, and Store say to open them on a computer. None of
   these mount the desktop window at 430px. */
(function () {
  const { useState } = React;

  function Computer({ app, title, sentence, icon, action, onAction }) {
    const Phone = window.CDOS.Phone;
    const Ic = window.CDOS.Ic;
    const Back = window.CDOS.LongTail && window.CDOS.LongTail.BackLink;
    return (
      <Phone.Screen
        app={app}
        className="longtail"
        title={title}
        action={Back ? <Back /> : null}
        sticky={action ? <Phone.StickyAction label={action} onClick={onAction} /> : null}
      >
        {Ic && icon ? <div className="phone-empty-ico" aria-hidden="true"><Ic n={icon} s={28} /></div> : null}
        <Phone.EmptyState title="Open this on a computer" message={sentence} />
      </Phone.Screen>
    );
  }

  function scratch(n) {
    if (!Number.isFinite(n)) return '';
    return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 8 }).format(n);
  }

  function money(amount, code) {
    const text = window.CDOS.formatPhoneMoney(amount, code);
    return text || null;
  }

  function codesOf() {
    const list = window.CDOS.deskCurrencyList && window.CDOS.deskCurrencyList();
    return (list && list.length) ? list : ['CAD', 'USD', 'EUR', 'GBP'];
  }

  /* A scratch pad. The result is not a ledger figure. */
  function PhoneCalc({ onUseInDeal }) {
    const Long = window.CDOS.LongTail;
    const home = (window.CDOS.deskHomeCcy && window.CDOS.deskHomeCcy()) || 'CAD';
    const codes = codesOf();
    const [mode, setMode] = useState('add');
    const [acc, setAcc] = useState(null);
    const [op, setOp] = useState(null);
    const [entry, setEntry] = useState('');
    const [shown, setShown] = useState('0');
    const [hist, setHist] = useState([]);
    const [amt, setAmt] = useState('100');
    const [from, setFrom] = useState(codes.find(c => c !== home) || codes[0]);
    const [to, setTo] = useState(home);
    const [take, setTake] = useState('');
    const [pay, setPay] = useState('');
    const [mCcy, setMCcy] = useState(home);

    const apply = (next) => {
      const typed = entry === '' ? null : Number(entry);
      if (typed != null && !Number.isFinite(typed)) return;
      const cur = typed == null ? Number(String(shown).replace(/,/g, '')) : typed;
      if (!Number.isFinite(cur)) return;
      let result = cur;
      if (op && acc != null && typed != null) {
        if (op === '÷' && cur === 0) { setShown('Cannot divide by zero'); setEntry(''); return; }
        result = op === '+' ? acc + cur : op === '−' ? acc - cur : op === '×' ? acc * cur : acc / cur;
      }
      const text = scratch(result);
      if (next === '=') {
        const label = (op && typed != null) ? (scratch(acc) + ' ' + op + ' ' + entry) : text;
        setHist(h => [{ label, result: text }].concat(h).slice(0, 8));
        setAcc(null); setOp(null); setEntry(''); setShown(text);
        return;
      }
      setAcc(result); setOp(next); setShown(text); setEntry('');
    };

    const rate = window.CDOS.crossRate ? window.CDOS.crossRate(from, to) : 0;
    const converted = rate ? (Number(amt) || 0) * rate : null;
    const takeN = take === '' ? null : Number(take);
    const payN = pay === '' ? null : Number(pay);
    const marginReady = takeN != null && payN != null && Number.isFinite(takeN) && Number.isFinite(payN);
    const profit = marginReady ? takeN - payN : null;
    const marginPct = marginReady && takeN !== 0 ? (profit / takeN) * 100 : null;

    let summary = null;
    let body = null;
    if (mode === 'add') {
      summary = [{ label: op ? ('Result, ' + op + ' next') : 'Result', value: shown || '0', sub: 'A scratch total, not the ledger' }];
      body = (
        <div>
          <label className="phone-field">Next number
            <input inputMode="decimal" value={entry} aria-label="Next number" placeholder="0" onChange={e => { if (e.target.value === '' || /^-?\d*\.?\d*$/.test(e.target.value)) setEntry(e.target.value); }} />
          </label>
          <div className="phone-ops">
            {['+', '−', '×', '÷', '='].map(key => (
              <button key={key} type="button" onClick={() => apply(key)}>{key}</button>
            ))}
          </div>
          {hist.length > 0 && (
            <div className="phone-list">{hist.map((row, i) => (
              <window.CDOS.Phone.ListRow key={i} title={row.label} subtitle={row.result} />
            ))}</div>
          )}
        </div>
      );
    } else if (mode === 'convert') {
      summary = [{ label: 'Result', value: converted == null ? null : money(converted, to), sub: rate ? ('1 ' + from + ' = ' + rate + ' ' + to) : 'No rate yet' }];
      body = (
        <div>
          <label className="phone-field">Amount
            <input inputMode="decimal" value={amt} aria-label="Amount to convert" onChange={e => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setAmt(e.target.value); }} />
          </label>
          <label className="phone-field">From
            <select value={from} aria-label="From currency" onChange={e => setFrom(e.target.value)}>{codes.map(c => <option key={c} value={c}>{c}</option>)}</select>
          </label>
          <label className="phone-field">To
            <select value={to} aria-label="To currency" onChange={e => setTo(e.target.value)}>{codes.map(c => <option key={c} value={c}>{c}</option>)}</select>
          </label>
        </div>
      );
    } else {
      summary = [{
        label: 'Margin',
        value: profit == null ? 'Enter both amounts' : (money(profit, mCcy) || 'No rate yet'),
        sub: marginPct == null ? 'Take-in minus pay-out' : (marginPct.toFixed(2) + '% of the take-in'),
      }];
      body = (
        <div>
          <label className="phone-field">Currency
            <select value={mCcy} aria-label="Margin currency" onChange={e => setMCcy(e.target.value)}>{codes.map(c => <option key={c} value={c}>{c}</option>)}</select>
          </label>
          <label className="phone-field">We take in
            <input inputMode="decimal" value={take} aria-label="We take in" placeholder="0.00" onChange={e => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setTake(e.target.value); }} />
          </label>
          <label className="phone-field">We pay out
            <input inputMode="decimal" value={pay} aria-label="We pay out" placeholder="0.00" onChange={e => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setPay(e.target.value); }} />
          </label>
        </div>
      );
    }

    return (
      <Long.LongTailScreen
        app="calc" title="Calculator" search={false}
        summary={summary}
        segments={[{ id: 'add', label: 'Add up' }, { id: 'convert', label: 'Convert' }, { id: 'margin', label: 'Margin' }]}
        segment={mode} onSegment={setMode}
        action={mode === 'convert' ? 'Use in a new deal' : null}
        onAction={onUseInDeal}
      >
        {body}
      </Long.LongTailScreen>
    );
  }

  function rowWhen(row) {
    const day = window.CDOS.formatPhoneDate(row.date || '');
    const time = window.CDOS.formatPhoneTime(row.time || '');
    return [day, time].filter(Boolean).join(', ');
  }

  function reasonOf(row) {
    const info = row.tagInfo || {};
    if (info.note) return info.note;
    if (info.by) return 'Tagged by ' + info.by;
    return 'Tagged for another look';
  }

  /* Open rows are still tagged. Done is what this phone marked
     checked in this sitting. Checking uses the row's own id. */
  function PhoneTagged({ rows, onCheck }) {
    const Phone = window.CDOS.Phone;
    const Long = window.CDOS.LongTail;
    const [chip, setChip] = useState('open');
    const [q, setQ] = useState('');
    const [done, setDone] = useState([]);
    const [open, setOpen] = useState(null);
    const needle = q.trim().toLowerCase();
    const match = (row) => {
      if (!needle) return true;
      const hay = [row.customer, row.ref, row.inCcy, row.outCcy, reasonOf(row)].join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    };
    const openRows = (rows || []).filter(r => r.tagged).filter(match);
    const doneRows = done.filter(match);
    const list = chip === 'done' ? doneRows : openRows;
    const check = (row) => {
      if (onCheck) onCheck(row);
      setDone(d => d.some(x => x.id === row.id) ? d : d.concat(row));
      setOpen(null);
      setChip('done');
    };
    return (
      <Long.LongTailScreen
        app="tagged" title="Tagged deals"
        summary={[{ label: 'Tagged', value: String(openRows.length), sub: 'Still open' }]}
        chips={[{ id: 'open', label: 'Open', count: openRows.length }, { id: 'done', label: 'Done', count: doneRows.length }]}
        chip={chip} onChip={setChip}
        search={q} onSearch={setQ} searchPlaceholder="Find a name or number"
        sheet={open && (
          <div className="phone-sheet" role="dialog" aria-label="Tagged deal">
            <div className="phone-sheet-h"><span /><h2>{open.customer || 'Walk-in'}</h2><button type="button" className="phone-sheet-x" onClick={() => setOpen(null)}>Close</button></div>
            <div className="phone-sheet-b">
              {open.ref && <div className="phone-kv"><span>Reference</span><b>{open.ref}</b></div>}
              <div className="phone-kv"><span>When</span><b>{rowWhen(open) || 'No date'}</b></div>
              <div className="phone-kv"><span>Why</span><b>{reasonOf(open)}</b></div>
              {open.inCcy && <div className="phone-kv"><span>Paid in</span><b>{money(open.inAmt, open.inCcy) || 'No rate yet'}</b></div>}
              {open.outCcy && <div className="phone-kv"><span>Paid out</span><b>{money(open.outAmt, open.outCcy) || 'No rate yet'}</b></div>}
              {chip !== 'done' && <button type="button" className="phone-sticky-btn" onClick={() => check(open)}>Mark as checked</button>}
            </div>
          </div>
        )}
      >
        {list.length === 0
          ? <p className="phone-miss">{chip === 'done' ? 'Nothing has been marked checked.' : 'No tagged deals.'}</p>
          : <div className="phone-list">{list.map(row => (
              <Phone.ListRow
                key={row.id}
                title={row.customer || row.ref || 'Walk-in'}
                subtitle={[reasonOf(row), rowWhen(row)].filter(Boolean).join(' · ')}
                amount={money(row.inAmt, row.inCcy)}
                onClick={() => setOpen(row)}
              />
            ))}</div>}
      </Long.LongTailScreen>
    );
  }

  window.CDOS.PhoneApps = { Computer, PhoneCalc, PhoneTagged };
})();
