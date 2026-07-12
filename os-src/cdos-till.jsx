/* ============================================================
   CurrencyDesk OS — Till & Cash Drawer
   Count the physical drawer down to the cent: every bill and coin
   of every currency. Saves a dated snapshot, reconciles against the
   ledger's expected float, closes the trading day, and keeps a
   year of daily history you can scroll back through.
   Day Close is folded in here as the "Reconcile & close" tab.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, crossRate, perCadLive, TODAY, dDiff, STAFF } = window.CDOS;

  // denominations per currency — { v: face value in that ccy, t: 'bill' | 'coin' }
  const DEN = {
    CAD: [[100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [2, 'coin'], [1, 'coin'], [0.25, 'coin'], [0.10, 'coin'], [0.05, 'coin']],
    USD: [[100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [1, 'bill'], [0.25, 'coin'], [0.10, 'coin'], [0.05, 'coin'], [0.01, 'coin']],
    EUR: [[500, 'bill'], [200, 'bill'], [100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [2, 'coin'], [1, 'coin'], [0.50, 'coin'], [0.20, 'coin'], [0.10, 'coin'], [0.05, 'coin'], [0.02, 'coin'], [0.01, 'coin']],
    GBP: [[50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [2, 'coin'], [1, 'coin'], [0.50, 'coin'], [0.20, 'coin'], [0.10, 'coin'], [0.05, 'coin']],
    INR: [[2000, 'bill'], [500, 'bill'], [200, 'bill'], [100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [10, 'coin'], [5, 'coin'], [2, 'coin'], [1, 'coin']],
    PHP: [[1000, 'bill'], [500, 'bill'], [200, 'bill'], [100, 'bill'], [50, 'bill'], [20, 'bill'], [20, 'coin'], [10, 'coin'], [5, 'coin'], [1, 'coin'], [0.25, 'coin']],
    CNY: [[100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [1, 'bill'], [1, 'coin'], [0.5, 'coin'], [0.1, 'coin']],
    MXN: [[1000, 'bill'], [500, 'bill'], [200, 'bill'], [100, 'bill'], [50, 'bill'], [20, 'bill'], [20, 'coin'], [10, 'coin'], [5, 'coin'], [2, 'coin'], [1, 'coin'], [0.5, 'coin']],
    AED: [[1000, 'bill'], [500, 'bill'], [200, 'bill'], [100, 'bill'], [50, 'bill'], [20, 'bill'], [10, 'bill'], [5, 'bill'], [1, 'coin'], [0.5, 'coin'], [0.25, 'coin']],
  };
  const CCYS = Object.keys(DEN);
  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  const denLabel = (v) => v >= 1 ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : (Math.round(v * 100) + '¢');
  const cadOf = (amt, ccy) => ccy === 'CAD' ? amt : amt / (crossRate('CAD', ccy) || 1);
  const HKEY = 'cdos_till_history_v2', CKEY = 'cdos_till_counts';
  const SHIFT_KEY = 'cdos_till_operator_v1', HANDOFF_KEY = 'cdos_till_handoffs_v1';
  const shiftStamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const clockOf = (ms) => ms ? new Date(ms).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

  /* seed a year of plausible daily history once, so the owner can scroll back */
  function seedHistory() {
    try { const ex = JSON.parse(localStorage.getItem(HKEY) || 'null'); if (ex && Object.keys(ex).length > 30) return ex; } catch (e) {}
    const hist = {};
    const base = { CAD: 238500, USD: 84000, EUR: 31000, GBP: 6400, PHP: 1760000, INR: 4180000, CNY: 96000, MXN: 372000, AED: 61500 };
    const start = new Date(TODAY); start.setDate(start.getDate() - 364);
    for (let i = 0; i < 365; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const wd = d.getDay(); if (wd === 0) continue; // closed Sundays
      const key = d.toISOString().slice(0, 10);
      const wob = (seed) => 0.78 + ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.5;
      const byCcy = {}; let grand = 0;
      CCYS.forEach((c, ci) => { if (!base[c]) return; const amt = Math.round(base[c] * wob(i * 9 + ci)); byCcy[c] = amt; grand += cadOf(amt, c); });
      hist[key] = { byCcy, grand: Math.round(grand), at: key + ' 17:30', by: 'System' };
    }
    try { localStorage.setItem(HKEY, JSON.stringify(hist)); } catch (e) {}
    return hist;
  }

  /* One denomination row. Hoisted to module scope (NOT defined inside
     TillDrawer) so its component identity is stable across renders —
     otherwise React remounts every row on each keystroke and the input
     loses focus after a single digit, making multi-digit counts impossible. */
  function DenRow({ d, ccy, counts, setCount }) {
    const cnt = parseInt((counts[ccy] || {})[d.i], 10) || 0;
    const sub = d.v * cnt;
    return (<div className="flex items-center gap-2 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
      <span className="grid place-items-center flex-none" style={{ width: 44, fontFamily: 'Space Mono, monospace', fontSize: 12.5, fontWeight: 700, color: CD.ink }}>{ccy === 'CAD' || ccy === 'USD' || d.v >= 1 ? (d.v < 1 ? denLabel(d.v) : (['CAD', 'USD', 'GBP', 'EUR', 'AED'].includes(ccy) ? '$' : '') + denLabel(d.v)) : denLabel(d.v)}</span>
      <span className="text-[9px] px-1.5 py-0.5 flex-none" style={{ borderRadius: 4, background: d.t === 'bill' ? CD.lineSoft : 'transparent', border: d.t === 'coin' ? `1px solid ${CD.line}` : 'none', color: CD.mute, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{d.t}</span>
      <div className="flex items-center flex-none" style={{ marginLeft: 'auto' }}>
        <button onClick={() => setCount(ccy, d.i, String(Math.max(0, cnt - 1)))} className="till-step grid place-items-center" style={{ width: 26, height: 28, border: `1px solid ${CD.line}`, borderRadius: '7px 0 0 7px', color: CD.mute }}>−</button>
        <input type="number" value={(counts[ccy] || {})[d.i] ?? ''} onChange={e => setCount(ccy, d.i, e.target.value)} placeholder="0" className="text-center outline-none" style={{ width: 52, height: 28, border: `1px solid ${CD.line}`, borderLeft: 0, borderRight: 0, fontVariantNumeric: 'tabular-nums', fontFamily: 'Space Mono, monospace', fontSize: 13 }} />
        <button onClick={() => setCount(ccy, d.i, String(cnt + 1))} className="till-step grid place-items-center" style={{ width: 26, height: 28, border: `1px solid ${CD.line}`, borderRadius: '0 7px 7px 0', color: CD.mute }}>+</button>
      </div>
      <span style={{ width: 92, textAlign: 'right', fontFamily: 'Space Mono, monospace', fontSize: 12.5, color: sub ? CD.ink : CD.faint, fontVariantNumeric: 'tabular-nums', fontWeight: sub ? 600 : 400 }}>{sub ? num(sub) : '—'}</span>
    </div>);
  }

  /* =====================================================================
     SHIFT HANDOFF — who's on the drawer, and passing it on.
     Mom-and-pop friendly: usually the same person all day, so the operator
     just sits in the header. When the drawer changes hands, a quick modal
     asks whether to count first (optional unless the owner requires it),
     then records the handoff with any variance. Nothing bank-heavy.
  ===================================================================== */
  function HandoffModal({ tillId, tillName, current, roster, me, expected, requireCount, onClose, onDone }) {
    const [step, setStep] = useState('who');      // who → count? → done
    const [toName, setToName] = useState('');
    const [counts, setCounts] = useState(() => { const o = {}; expected.forEach(x => { o[x.ccy] = ''; }); return o; });
    const cadOfLocal = (amt, ccy) => ccy === 'CAD' ? amt : amt / (crossRate('CAD', ccy) || 1);
    const to = roster.find(s => s.name === toName);
    const expCad = expected.reduce((s, x) => s + cadOfLocal(x.units, x.ccy), 0);
    const countedCad = expected.reduce((s, x) => s + cadOfLocal(counts[x.ccy] === '' ? x.units : (parseFloat(counts[x.ccy]) || 0), x.ccy), 0);
    const variance = +(countedCad - expCad).toFixed(2);
    const anyEntered = expected.some(x => counts[x.ccy] !== '' && counts[x.ccy] != null);

    const finish = (counted) => {
      const rec = {
        id: 'ho' + Date.now(), tillId, tillName,
        from: current ? current.operator : '—', to: toName, toRole: to ? to.role : '',
        at: shiftStamp(), atMs: Date.now(), by: me.name,
        counted, expectedCad: +expCad.toFixed(2),
        countedCad: counted ? +countedCad.toFixed(2) : null,
        variance: counted ? variance : null
      };
      onDone(rec);
    };

    return ReactDOM.createPortal(
      <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9400 }} onMouseDown={onClose}>
        <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 460, maxHeight: 'calc(100vh - 40px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 16, boxShadow: '0 24px 70px var(--cd-scrim)', overflow: 'hidden' }}>
          {/* header */}
          <div className="flex items-center gap-3 px-5 py-3.5 flex-none" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <span className="grid place-items-center" style={{ width: 32, height: 32, background: CD.ink, borderRadius: 9 }}><Ic n="users" s={17} c="var(--cd-on-ink)" /></span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold leading-tight" style={{ color: CD.ink }}>Hand off the drawer</div>
              <div className="text-[11px]" style={{ color: CD.mute }}>{tillName} · leaving <b style={{ color: CD.ink }}>{current ? current.operator : '—'}</b></div>
            </div>
            <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
          </div>

          {step === 'who' && (<div className="px-5 py-4">
            <div className="text-[11px] mb-2 font-semibold uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Who's taking the drawer?</div>
            <div className="flex flex-col gap-1.5">
              {roster.map(s => { const on = toName === s.name; const isMe = s.name === me.name; return (
                <button key={s.name} onClick={() => setToName(s.name)} className="flex items-center gap-3 px-3 py-2.5 text-left" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', borderRadius: 10 }}>
                  <span className="grid place-items-center flex-none font-semibold" style={{ width: 30, height: 30, borderRadius: 8, background: on ? 'var(--cd-on-ink-faint)' : CD.lineSoft, color: on ? 'var(--cd-on-ink)' : CD.ink, fontSize: 11 }}>{s.name.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase()}</span>
                  <span className="flex-1 min-w-0"><span className="block text-[13.5px] font-medium" style={{ color: on ? 'var(--cd-on-ink)' : CD.ink }}>{s.name}{isMe ? ' (me)' : ''}</span><span className="block text-[11px]" style={{ color: on ? 'var(--cd-on-ink-soft)' : CD.mute }}>{s.role}</span></span>
                  {on && <Ic n="check" s={16} c="var(--cd-on-ink)" />}
                </button>); })}
            </div>
            <button disabled={!toName || toName === (current && current.operator)} onClick={() => setStep('count')} className="w-full mt-3 py-2.5 text-sm font-semibold text-white" style={{ background: (toName && toName !== (current && current.operator)) ? CD.ink : 'var(--cd-disabled)', borderRadius: 10 }}>Continue</button>
            {toName && toName === (current && current.operator) && <div className="text-[11px] mt-1.5 text-center" style={{ color: CD.faint }}>{toName} is already on the drawer.</div>}
          </div>)}

          {step === 'count' && (<>
            <div className="px-5 py-4 overflow-auto">
              <div className="flex items-center justify-between mb-1"><div className="text-[13.5px] font-semibold" style={{ color: CD.ink }}>Count the drawer before handing to {toName}?</div></div>
              <div className="text-[12px] mb-3" style={{ color: CD.mute }}>{requireCount ? 'Your shop requires a count at handoff.' : 'Optional — skip it if it’s a quick swap and the same drawer.'}</div>

              {/* compact count: prefilled to expected, edit only what's off */}
              <div style={{ border: `1px solid ${CD.line}`, borderRadius: 11, overflow: 'hidden' }}>
                {expected.map((x, i) => { const val = counts[x.ccy] === '' ? '' : counts[x.ccy]; const cnt = val === '' ? x.units : (parseFloat(val) || 0); const dv = +(cadOfLocal(cnt, x.ccy) - cadOfLocal(x.units, x.ccy)).toFixed(2); const off = Math.abs(dv) > 0.005; return (
                  <div key={x.ccy} className="flex items-center gap-2 px-3 py-2" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none', background: 'var(--cd-panel)' }}>
                    <span className="font-semibold flex-none" style={{ width: 42, fontFamily: 'Space Mono, monospace', fontSize: 12.5, color: CD.ink }}>{x.ccy}</span>
                    <span className="flex-1 text-[11px]" style={{ color: CD.mute }}>expected <b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(x.units)}</b></span>
                    <input value={val} onChange={e => setCounts(o => ({ ...o, [x.ccy]: e.target.value }))} inputMode="decimal" placeholder={num(x.units)} className="text-right outline-none text-[13px] px-2 py-1.5" style={{ width: 96, border: `1px solid ${off ? CD.flag : CD.line}`, borderRadius: 7, fontVariantNumeric: 'tabular-nums', color: off ? CD.flag : CD.ink }} />
                  </div>); })}
              </div>

              <div className="flex items-center justify-between mt-3 px-3 py-2.5" style={{ background: Math.abs(variance) > 0.005 ? CD.flagSoft : CD.greenSoft, borderRadius: 10 }}>
                <span className="text-[12px] font-medium" style={{ color: Math.abs(variance) > 0.005 ? CD.flag : CD.green }}>{anyEntered ? (Math.abs(variance) < 0.005 ? '✓ Balances to expected' : (variance > 0 ? 'Over by ' : 'Short by ') + fmt(Math.abs(variance), 'CAD')) : 'Not counted yet'}</span>
                <span className="text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{fmt(countedCad, 'CAD')}</span>
              </div>
            </div>
            <div className="px-5 py-3.5 flex items-center justify-between gap-2 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
              <button onClick={() => setStep('who')} className="text-[13px] px-3 py-2 font-medium" style={{ color: CD.mute }}>Back</button>
              <div className="flex items-center gap-2">
                {!requireCount && <button onClick={() => finish(false)} className="text-[13px] px-3.5 py-2 font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'var(--cd-on-ink)' }}>Skip — hand off as-is</button>}
                <button onClick={() => finish(true)} className="flex items-center gap-1.5 text-[13px] px-4 py-2 font-semibold text-white" style={{ background: CD.green, borderRadius: 9 }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> {anyEntered ? 'Confirm count & hand off' : 'Confirm as counted'}</button>
              </div>
            </div>
          </>)}
        </div>
      </div>, document.body);
  }

  function TillDrawer({ rows: allRows, log, day, onCloseDay, onOpenNextDay, me, canCloseDay = true, baseline, setBaseline, receipts, stationName, stationTill, branches, station, setStation, onOpenReport, settings, onMoveCash, onOpenVault, moves }) {
    const rows = useMemo(() => allRows.filter(r => r.status !== 'void'), [allRows]);
    const [tab, setTab] = useState('count');
    // switch tills at THIS location only (same logic as the header) — change store = sign out
    const [tillMenu, setTillMenu] = useState(false);
    const tillMenuRef = useRef(null);
    useEffect(() => { if (!tillMenu) return; const h = (e) => { if (tillMenuRef.current && !tillMenuRef.current.contains(e.target)) setTillMenu(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [tillMenu]);
    const _ab = (branches || []).find(b => b.id === (station && station.branchId)) || (branches || [])[0];
    const _tills = ((_ab && _ab.tills) || []).filter(t => t.status !== 'closed');
    const [pendingTill, setPendingTill] = useState(null);   // till id awaiting switch confirmation
    const pickTill = (tId) => { setTillMenu(false); if (!station || tId === station.tillId) return; setPendingTill(tId); };
    const confirmPickTill = () => { const tId = pendingTill; setPendingTill(null); if (!tId) return; setStation && setStation({ branchId: _ab.id, tillId: tId }); const t = (_ab.tills || []).find(x => x.id === tId) || {}; if (t.operator && t.operator !== me.name) log && log('Till handover', `${t.operator} → ${me.name} · ${_ab.code} ${t.name}`); log && log('Till switched', (_ab.name || '') + ' · ' + (t.name || '')); };
    const [ccy, setCcy] = useState('CAD');
    const [counts, setCounts] = useState(() => { try { return JSON.parse(localStorage.getItem(CKEY) || '{}') || {}; } catch (e) { return {}; } });
    const [quick, setQuick] = useState(() => { try { return JSON.parse(localStorage.getItem('cdos_till_quick') || '{}') || {}; } catch (e) { return {}; } });
    const [mode, setMode] = useState(() => { try { return JSON.parse(localStorage.getItem('cdos_till_mode') || '{}') || {}; } catch (e) { return {}; } });
    // per-currency timestamp of when each drawer was last counted (ms epoch)
    const [countedAt, setCountedAt] = useState(() => { try { return JSON.parse(localStorage.getItem('cdos_till_counted_at') || '{}') || {}; } catch (e) { return {}; } });
    // last SAVED count per currency — amount + when + by whom (survives reloads)
    const [lastSaved, setLastSaved] = useState(() => { try { return JSON.parse(localStorage.getItem('cdos_till_lastcount_v1') || '{}') || {}; } catch (e) { return {}; } });
    // blind-count: expected float stays blurred per-currency until the teller reveals it
    const [revealExp, setRevealExp] = useState({});
    const [confirmClose, setConfirmClose] = useState(false);
    const [, forceTick] = useState(0); // ticks every 30s so "x min ago" labels stay fresh
    const [history, setHistory] = useState(seedHistory);
    // ---- shift operator (who's on the drawer) ----
    const tillId = (station && station.tillId) || 'main';
    const tillNm = stationTill || (((_ab && _ab.tills) || []).find(t => t.id === tillId) || {}).name || 'This till';
    const roster = useMemo(() => ((settings && settings.employees && settings.employees.length ? settings.employees : STAFF) || []).filter(s => s.active !== false), [settings]);
    const requireCount = !!(settings && settings.requireCountOnHandoff);
    // blind count: expected float stays blurred until revealed (Settings › Cash drawer)
    const blind = !(settings && settings.tillBlindCount === false);
    const [shifts, setShifts] = useState(() => { try { return JSON.parse(localStorage.getItem(SHIFT_KEY) || '{}') || {}; } catch (e) { return {}; } });
    const [handoffs, setHandoffs] = useState(() => { try { return JSON.parse(localStorage.getItem(HANDOFF_KEY) || '[]') || []; } catch (e) { return []; } });
    const [handoffOpen, setHandoffOpen] = useState(false);
    // the operator strip is usually the same person all day, so let it be dismissed
    // to a small chip; the owner can pop it back open when the drawer changes hands.
    const [stripOpen, setStripOpen] = useState(() => { try { return localStorage.getItem('cdos_till_strip_open') !== '0'; } catch (e) { return true; } });
    useEffect(() => { try { localStorage.setItem('cdos_till_strip_open', stripOpen ? '1' : '0'); } catch (e) {} }, [stripOpen]);
    useEffect(() => { try { localStorage.setItem(SHIFT_KEY, JSON.stringify(shifts)); } catch (e) {} }, [shifts]);
    useEffect(() => { try { localStorage.setItem(HANDOFF_KEY, JSON.stringify(handoffs)); } catch (e) {} }, [handoffs]);
    const current = shifts[tillId];
    // seed the operator for this till on first view — from the till's assigned teller, else me
    useEffect(() => {
      if (!shifts[tillId] && tillId) {
        const seededName = (((_ab && _ab.tills) || []).find(t => t.id === tillId) || {}).teller || me.name;
        const r = roster.find(s => s.name === seededName);
        setShifts(o => ({ ...o, [tillId]: { operator: seededName, role: r ? r.role : (seededName === me.name ? me.role : 'Cashier'), since: Date.now() } }));
      }
    }, [tillId]);
    const doHandoff = (rec) => {
      setHandoffs(h => [rec, ...h].slice(0, 200));
      setShifts(o => ({ ...o, [tillId]: { operator: rec.to, role: rec.toRole, since: rec.atMs } }));
      log && log('Drawer handed off', `${tillNm} · ${rec.from} → ${rec.to}${rec.counted ? (Math.abs(rec.variance || 0) < 0.005 ? ' · counted ✓' : ' · counted · ' + (rec.variance > 0 ? '+' : '') + fmt(rec.variance, 'CAD')) : ' · no count'}`);
      setHandoffOpen(false);
    };
    const sinceOperator = current && current.since ? (() => { const m = Math.round((Date.now() - current.since) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min`; const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; })() : '';
    const [viewDay, setViewDay] = useState(null);
    const [saved, setSaved] = useState(false);
    const [opening, setOpening] = useState(false);
    const [closing, setClosing] = useState(false);
    // when the day's open/closed state actually flips, clear the transient
    // button flags — backstop in case a render slips through
    useEffect(() => { setOpening(false); setClosing(false); busyRef.current = false; }, [day && day.closed, day && day.num]);
    // synchronous re-entrancy lock: a quick second click (or one that lands
    // before React re-renders) reads a stale `opening`/`closing` and slips past
    // the state guard — this ref blocks it in the same tick so we never queue a
    // second open/close and never get stuck mid-animation on a later loop.
    const busyRef = useRef(false);
    const saveLock = useRef(0);
    const savedTimer = useRef(null);
    useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
    useEffect(() => { try { localStorage.setItem(CKEY, JSON.stringify(counts)); } catch (e) {} }, [counts]);
    useEffect(() => { try { localStorage.setItem('cdos_till_quick', JSON.stringify(quick)); } catch (e) {} }, [quick]);
    useEffect(() => { try { localStorage.setItem('cdos_till_mode', JSON.stringify(mode)); } catch (e) {} }, [mode]);
    useEffect(() => { try { localStorage.setItem('cdos_till_counted_at', JSON.stringify(countedAt)); } catch (e) {} }, [countedAt]);
    useEffect(() => { const id = setInterval(() => forceTick(t => t + 1), 30000); return () => clearInterval(id); }, []);
    const ccyMode = (c) => mode[c] || (settings && settings.tillCountMode) || 'denom';

    // stamp the moment a drawer was last touched, so we can show staleness
    const stampCount = (c) => setCountedAt(o => ({ ...o, [c]: Date.now() }));
    const clearCount = (c) => { setQuick(o => ({ ...o, [c]: '' })); setCounts(o => ({ ...o, [c]: {} })); setCountedAt(o => { const n = { ...o }; delete n[c]; return n; }); };
    const setCount = (c, idx, val) => { setCounts(o => ({ ...o, [c]: { ...(o[c] || {}), [idx]: val } })); stampCount(c); };
    // relative + absolute labels for "last counted"
    const sinceLabel = (ts) => { if (!ts) return null; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (s < 45) return 'just now'; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ${m % 60}m ago`; const d = Math.floor(h / 24); return `${d} day${d > 1 ? 's' : ''} ago`; };
    const atLabel = (ts) => ts ? new Date(ts).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
    // total held per currency — quick-entered total overrides the denomination count
    const denTotal = (c) => (DEN[c] || []).reduce((s, [v], i) => s + v * (parseInt((counts[c] || {})[i], 10) || 0), 0);
    const ccyTotal = (c) => ccyMode(c) === 'total' ? (parseFloat(quick[c]) || 0) : denTotal(c);
    const isCounted = (c) => ccyMode(c) === 'total' ? (parseFloat(quick[c]) > 0) : Object.values(counts[c] || {}).some(v => parseInt(v, 10) > 0);
    const countedCcys = useMemo(() => CCYS.filter(isCounted), [counts, quick, mode]);
    const grandCad = useMemo(() => countedCcys.reduce((s, c) => s + cadOf(ccyTotal(c), c), 0), [counts, quick, mode, countedCcys]);

    // expected float per currency — DERIVED from the one shared source of truth
    // (opening baseline + wholesale receipts + posted ledger legs, void-aware).
    // Identical to the figure the Vault shows because both call position().
    const expectedOf = (c) => window.CDOS.holdings(c, allRows, baseline, receipts);
    // reveal + read out the expected float (audible cue for a blind / hands-busy count)
    const announceExpected = (c) => {
      try {
        const amt = expectedOf(c);
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.06; o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18); o.stop(ctx.currentTime + 0.2); }
      } catch (e) {}
    };
    const toggleReveal = (c) => { const nx = !revealExp[c]; setRevealExp(o => ({ ...o, [c]: nx })); if (nx) announceExpected(c); };

    /* ---------------- COUNT TAB ---------------- */
    const dlist = DEN[ccy] || [];
    const bills = dlist.map((d, i) => ({ v: d[0], t: d[1], i })).filter(d => d.t === 'bill');
    const coins = dlist.map((d, i) => ({ v: d[0], t: d[1], i })).filter(d => d.t === 'coin');
    const saveSnapshot = () => {
      const now = Date.now();
      if (saved || now - saveLock.current < 1800) return;   // debounce: no accidental double-save
      saveLock.current = now;
      const byCcy = {}; let grand = 0;
      countedCcys.forEach(c => { const t = ccyTotal(c); byCcy[c] = t; grand += cadOf(t, c); });
      const snap = { byCcy, grand: Math.round(grand), at: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), by: me.name, denoms: JSON.parse(JSON.stringify(counts)) };
      setHistory(h => { const n = { ...h, [TODAY]: snap }; try { localStorage.setItem(HKEY, JSON.stringify(n)); } catch (e) {} return n; });
      // remember each currency's saved count — the reconcile table shows this as
      // "last count": the amount that was on record, when, and by whom
      setLastSaved(o => { const n = { ...o }; countedCcys.forEach(c => { n[c] = { amt: ccyTotal(c), ts: now, by: me.name }; }); try { localStorage.setItem('cdos_till_lastcount_v1', JSON.stringify(n)); } catch (e) {} return n; });
      log && log('Drawer counted', `${fmt(grand, 'CAD')} across ${countedCcys.length} currenc${countedCcys.length === 1 ? 'y' : 'ies'}`);
      setSaved(true);
      savedTimer.current = setTimeout(() => setSaved(false), 1900);
    };

    /* ---------------- RECONCILE / CLOSE TAB ---------------- */
    const recon = CCYS.map(c => { const expected = expectedOf(c); const counted = countedCcys.includes(c) ? ccyTotal(c) : null; const variance = counted == null ? null : counted - expected; return { c, expected, counted, variance }; }).filter(r => r.expected || r.counted != null || ['CAD', 'USD'].includes(r.c));
    // a drawer is "off" only when its CAD variance exceeds the owner's tolerance (Settings › Cash drawer)
    const tolCad = Math.max(0, +((settings && settings.tillVarianceTol)) || 0);
    const offOf = (r) => r.variance != null && Math.abs(cadOf(r.variance, r.c)) > tolCad + 0.005;
    const offRows = recon.filter(offOf);
    const countedN = recon.filter(r => r.counted != null).length;
    const closeBlocked = !!(settings && settings.requireCountOnClose) && countedN < recon.length;
    // grand totals across all drawers, expressed in CAD, for the reconcile total row + close modal
    const totalExpCad = recon.reduce((s, r) => s + cadOf(r.expected, r.c), 0);
    const totalCountCad = recon.reduce((s, r) => s + (r.counted != null ? cadOf(r.counted, r.c) : 0), 0);
    const totalVarCad = recon.reduce((s, r) => s + (r.variance != null ? cadOf(r.variance, r.c) : 0), 0);
    const doClose = () => {
      const offSumCad = offRows.reduce((s, r) => s + cadOf(r.variance, r.c), 0);
      // what the desk made today: fees + estimated FX spread, in CAD
      const spreadOf = (r) => { const mid = (+r.inAmt || 0) * crossRate(r.inCcy, r.outCcy); const d = mid - (+r.outAmt || 0); return d > 0 ? d / (perCadLive(r.outCcy) || 1) : 0; };
      const dayRows = rows.filter(r => r.date === TODAY);
      const earned = dayRows.reduce((s, r) => s + (+r.fee || 0) + spreadOf(r), 0);
      onCloseDay && onCloseDay({ txns: dayRows.length, ccys: recon.length, counted: countedN, offCount: offRows.length, offSum: Math.round(offSumCad), grand: Math.round(grandCad), earned: Math.round(earned), note: offRows.length ? `${offRows.length} drawer(s) off · ${fmt(offSumCad, 'CAD')} net` : 'All counted drawers balanced' });
      saveSnapshot();
    };
    // first click opens a review modal; the irreversible commit lives in confirmAndClose
    const clickClose = () => { if (!canCloseDay || closing || busyRef.current || closeBlocked) return; setConfirmClose(true); };
    const confirmAndClose = () => {
      if (closing || busyRef.current) return;
      busyRef.current = true;
      setConfirmClose(false);
      setClosing(true);
      setTimeout(() => { doClose(); setClosing(false); busyRef.current = false; }, 540);
    };

    /* ---------------- HISTORY ---------------- */
    const histKeys = useMemo(() => Object.keys(history).sort().reverse(), [history]);
    const histSeries = useMemo(() => Object.keys(history).sort().slice(-90).map(k => history[k].grand), [history]);

    const TABS = [['count', 'Cash drawer', 'wallet'], ['reconcile', 'Reconcile & close', 'coins'], ['history', 'History', 'clock']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper, position: 'relative' }}>
      {/* header + tabs */}
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center gap-2.5 pb-3">
          <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="tilldrawer" s={17} c="var(--cd-on-ink)" /></span>
          <div className="min-w-0"><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Cash Drawer</div><div className="text-[11px] flex items-center gap-1 flex-wrap" style={{ color: CD.mute }}>
            {stationName ? <b style={{ color: CD.ink }}>{stationName}</b> : null}
            {stationName ? <span>·</span> : null}
            {_tills.length ? (<span ref={tillMenuRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button onClick={() => setTillMenu(o => !o)} title="Switch till at this location" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 0, background: tillMenu ? 'var(--cd-hover)' : 'transparent', borderRadius: 6, padding: '1px 5px', margin: '0 -3px', cursor: 'pointer', color: 'inherit', fontWeight: 600 }}>{stationTill || (_ab && _ab.tills[0] && _ab.tills[0].name) || 'Till'}<span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><Ic n="chev" s={10} c={CD.faint} /></span></button>
              {tillMenu && (<div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 5, width: 230, background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11, boxShadow: '0 14px 36px var(--cd-shade)', zIndex: 9999, overflow: 'hidden' }}>
                <div style={{ padding: '8px 11px', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: CD.faint, fontFamily: 'Space Mono, monospace', borderBottom: `1px solid ${CD.lineSoft}` }}>{_ab ? _ab.name : ''} · switch till</div>
                {_tills.map(t => { const on = station && station.tillId === t.id; return (<button key={t.id} onClick={() => pickTill(t.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', background: on ? CD.brassSoft : 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }}><Ic n="wallet" s={12} c={on ? CD.ink : CD.mute} /><span style={{ flex: 1, fontSize: 12, color: CD.ink }}>{t.name}{t.teller ? <span style={{ color: CD.faint }}> · {t.teller}</span> : null}</span>{on && <Ic n="check" s={12} c={CD.ink} />}</button>); })}
                <div style={{ padding: '7px 11px', borderTop: `1px solid ${CD.lineSoft}`, fontSize: 10, color: CD.faint, display: 'flex', alignItems: 'center', gap: 5 }}><Ic n="logout" s={10} c={CD.faint} /> To change store, sign out &amp; back in.</div>
              </div>)}
            </span>) : (stationTill ? <b style={{ color: CD.ink }}>{stationTill}</b> : null)}
            <span>· Day {day && day.num || 1}{day && day.closed ? ' · closed' : ''} · {countedCcys.length} drawer(s) counted</span>
          </div></div>
          <div className="flex items-center gap-1.5 flex-none ml-auto">
            {(() => {
              // the drawer's rail balance — changes the moment cash is issued or returned.
              // floats are ISSUED AT THE VAULT (Vault / Branch Network), never from here:
              // the drawer only shows what it holds and links to where floats happen.
              const _tRec = ((_ab && _ab.tills) || []).find(t => t.id === (station && station.tillId));
              const _tc = _tRec && window.CDOS._stations && window.CDOS._stations.tillCad ? window.CDOS._stations.tillCad(_tRec) : null;
              return (<>
                {_tc != null && <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 8, background: 'var(--cd-chip)', color: CD.mute }} title="What this drawer holds on the cash rail — floats are issued and returned at the vault">Float in drawer <b style={{ color: CD.ink, fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{fmt(_tc, 'CAD')}</b></span>}
                <button onClick={() => onOpenVault && onOpenVault()} title="Floats are issued & returned at the vault" className="flex items-center gap-1 text-[11px] px-2.5 py-1.5" style={{ color: CD.mute, border: 0, background: 'transparent' }}><Ic n="vaultsafe" s={13} c={CD.mute} /> Vault ›</button>
              </>);
            })()}
          </div>
        </div>
        <div className="fld-bar" style={{ '--ft': '#17140F', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}><Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}</button>)}
        </div>
      </div>

      {/* who's on the drawer — mom-and-pop operator strip (dismissible to a chip) */}
      {pendingTill && window.CDOS._stations && window.CDOS._stations.ConfirmStationModal && React.createElement(window.CDOS._stations.ConfirmStationModal, { branch: _ab, till: ((_ab && _ab.tills) || []).find(x => x.id === pendingTill), me, onClose: () => setPendingTill(null), onConfirm: confirmPickTill })}
      {stripOpen ? (
      <div className="flex items-center justify-between gap-2 px-4 py-2 flex-none" style={{ background: 'var(--cd-panel)', borderBottom: `1px solid ${CD.line}` }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid place-items-center flex-none font-semibold" style={{ width: 28, height: 28, borderRadius: 8, background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 10.5 }}>{current ? current.operator.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase() : '—'}</span>
          <div className="min-w-0 leading-tight">
            <div className="text-[12.5px]" style={{ color: CD.ink }}><span style={{ color: CD.mute }}>On the drawer:</span> <b>{current ? current.operator : '—'}</b>{current && current.role ? <span className="text-[11px]" style={{ color: CD.faint }}> · {current.role}</span> : null}</div>
            <div className="text-[10.5px]" style={{ color: CD.faint }}>{current && current.since ? `since ${clockOf(current.since)} · ${sinceOperator}` : 'unassigned'}{requireCount ? ' · count required at handoff' : ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-none">
          <button onClick={() => setHandoffOpen(true)} className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="users" s={13} c={CD.mute} /> Hand off</button>
          <button onClick={() => setStripOpen(false)} title="Hide operator bar" className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${CD.line}`, background: CD.panel, color: CD.mute }}><Ic n="x" s={13} c={CD.mute} /></button>
        </div>
      </div>
      ) : (
      <div className="flex-none px-4 py-1.5" style={{ background: 'var(--cd-panel)', borderBottom: `1px solid ${CD.line}` }}>
        <button onClick={() => setStripOpen(true)} title="Show who's on the drawer" className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 999, color: CD.mute, background: CD.panel }}><span className="grid place-items-center flex-none font-semibold" style={{ width: 16, height: 16, borderRadius: 5, background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 8 }}>{current ? current.operator.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase() : '—'}</span>{current ? current.operator : 'Operator'} · on the drawer</button>
      </div>
      )}

      <div className="flex-1 overflow-auto">

        {/* ===== COUNT ===== */}
        {tab === 'count' && (<div className="p-4 pb-0">
          {/* currency chips */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {CCYS.map(c => { const on = c === ccy; const has = countedCcys.includes(c); return (
              <button key={c} onClick={() => setCcy(c)} className="till-chip flex items-center gap-1.5 px-2.5 py-1.5 text-xs" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : CD.panel, color: on ? 'var(--cd-on-ink)' : CD.mute, fontFamily: 'Space Mono, monospace' }}>
                <span style={{ fontFamily: 'system-ui' }}>{flagOf(c)}</span>{c}{has && <span style={{ width: 5, height: 5, borderRadius: '50%', background: on ? 'var(--cd-panel)' : CD.green }}></span>}
              </button>); })}
          </div>
          {/* denomination columns */}
          {/* count mode: by denomination, or a quick total */}
          <div className="flex items-center justify-between mb-3">
            <div className="inline-flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
              {[['denom', 'Count denominations'], ['total', 'Enter total']].map(([m, l]) => <button key={m} onClick={() => setMode(o => ({ ...o, [ccy]: m }))} className="text-[11.5px] px-3 py-1.5" style={{ background: ccyMode(ccy) === m ? CD.ink : 'transparent', color: ccyMode(ccy) === m ? 'var(--cd-on-ink)' : CD.mute, fontFamily: 'Space Mono, monospace' }}>{l}</button>)}
            </div>
            {isCounted(ccy) && <button onClick={() => clearCount(ccy)} className="text-[11px]" style={{ color: CD.mute }}>Clear {ccy}</button>}
          </div>

          {ccyMode(ccy) === 'total' ? (
            <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
              <div className="text-[11px] mb-2" style={{ color: CD.mute }}>Skip the breakdown — just enter the total {ccy} you counted in the drawer.</div>
              <div className="flex items-center" style={{ border: `1px solid ${CD.ink}`, borderRadius: 10, maxWidth: 340 }}>
                <span className="px-3 text-sm" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace', borderRight: `1px solid ${CD.line}` }}>{ccy}</span>
                <input type="number" autoFocus value={quick[ccy] ?? ''} onChange={e => { setQuick(o => ({ ...o, [ccy]: e.target.value })); stampCount(ccy); }} placeholder="0.00" className="flex-1 min-w-0 px-3 py-2.5 text-2xl font-bold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'Space Mono, monospace' }} />
              </div>
              {ccy !== 'CAD' && <div className="mt-2 text-[12px]" style={{ color: CD.mute }}>≈ {fmt(cadOf(parseFloat(quick[ccy]) || 0, ccy), 'CAD')}</div>}
            </div>
          ) : (
          <div className="grid md:grid-cols-2 gap-x-5 gap-y-0">
            <div>
              <div className="text-[10px] uppercase tracking-widest mb-1 mt-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Notes</div>
              {bills.map(d => <DenRow key={d.i} d={d} ccy={ccy} counts={counts} setCount={setCount} />)}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest mb-1 mt-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Coin</div>
              {coins.map(d => <DenRow key={d.i} d={d} ccy={ccy} counts={counts} setCount={setCount} />)}
            </div>
          </div>
          )}
          {/* per-currency footer — counted (typeable), expected, then the grand total */}
          <div style={{ position: 'sticky', bottom: 0, background: CD.paper, paddingTop: 10, marginTop: 8 }}>
            <div className="flex items-end justify-between gap-4 pt-3" style={{ borderTop: `1px solid ${CD.line}` }}>
              <div>
                <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{ccy} counted</div>
                <div className="flex items-center" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, maxWidth: 220, marginTop: 3, background: ccyMode(ccy) === 'total' ? 'var(--cd-panel)' : 'transparent' }}>
                  <input type="text" inputMode="decimal" value={ccyMode(ccy) === 'total' ? (quick[ccy] ?? '') : num(ccyTotal(ccy))} readOnly={ccyMode(ccy) !== 'total'} onFocus={() => { if (ccyMode(ccy) !== 'total') { setMode(o => ({ ...o, [ccy]: 'total' })); setQuick(o => ({ ...o, [ccy]: String(denTotal(ccy) || '') })); } }} onChange={e => { setQuick(o => ({ ...o, [ccy]: e.target.value.replace(/[^0-9.]/g, '') })); stampCount(ccy); }} className="min-w-0 px-2.5 py-1.5 text-lg font-bold text-right outline-none bg-transparent" style={{ width: 150, fontVariantNumeric: 'tabular-nums', fontFamily: 'Space Mono, monospace', color: CD.ink, cursor: ccyMode(ccy) !== 'total' ? 'pointer' : 'text' }} />
                  <span className="px-2.5 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace', borderLeft: `1px solid ${CD.line}` }}>{ccy}</span>
                </div>
                <div className="text-[11px] mt-1.5 flex items-center gap-2 flex-wrap" style={{ color: CD.faint }}>
                  <button onClick={() => toggleReveal(ccy)} title={revealExp[ccy] ? 'Hide expected — keep the count blind' : 'Reveal & read out the expected float'} className="inline-flex items-center gap-1.5" style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: 'inherit' }}>
                    <span>Expected</span>
                    <b style={{ color: CD.mute, fontFamily: 'Space Mono, monospace', filter: (blind && !revealExp[ccy]) ? 'blur(6px)' : 'none', transition: 'filter .15s', userSelect: 'none' }}>{num(expectedOf(ccy))} {ccy}</b>
                    {isCounted(ccy) && (() => { const v = ccyTotal(ccy) - expectedOf(ccy); const off = Math.abs(v) > 0.005; return <b style={{ color: revealExp[ccy] ? (off ? CD.flag : CD.green) : CD.faint, fontFamily: 'Space Mono, monospace', filter: (blind && !revealExp[ccy]) ? 'blur(6px)' : 'none', transition: 'filter .15s', userSelect: 'none' }}>{off ? `${v > 0 ? '+' : ''}${num(v)} ${v > 0 ? 'over' : 'short'}` : '\u2713 balanced'}</b>; })()}
                    <Ic n={revealExp[ccy] ? 'power' : 'lock'} s={11} c={CD.faint} />
                  </button>
                  {ccy !== 'CAD' && isCounted(ccy) && <span>· ≈ {fmt(cadOf(ccyTotal(ccy), ccy), 'CAD')}</span>}
                </div>
                <div className="text-[11px] mt-1" style={{ color: CD.faint }}>{(() => { const ts = countedAt[ccy]; return ts ? <span>Last counted <b style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{sinceLabel(ts)}</b> · {atLabel(ts)}</span> : <span>Not counted yet today</span>; })()}</div>
              </div>
              <div className="text-right flex-none">
                <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Total drawer · CAD</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmt(grandCad, 'CAD')}</div>
                <button onClick={saveSnapshot} disabled={saved} className="till-save mt-2 flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: saved ? CD.green : CD.ink, borderRadius: 9, marginLeft: 'auto', transition: 'background .25s ease, transform .12s ease' }}><Ic n={saved ? 'checkcircle' : 'checkcircle'} s={15} c="var(--cd-on-ink)" /> {saved ? 'Saved' : 'Save count'}</button>
              </div>
            </div>
            <div className="text-[10.5px] py-2" style={{ color: CD.faint }}>Counting denominations updates the total live · or tap the counted figure to type it in directly · expected comes from the ledger float.</div>
          </div>
        </div>)}

        {/* ===== RECONCILE / CLOSE ===== */}
        {tab === 'reconcile' && (day && day.closed ? (<div className="p-5 flex flex-col" style={{ minHeight: '100%' }}>
          {/* pleasant green closed banner */}
          <div className="flex items-start gap-3 p-4" style={{ background: CD.greenSoft, border: `1px solid ${CD.green}`, borderRadius: 14 }}>
            <span className="grid place-items-center flex-none" style={{ width: 40, height: 40, background: CD.green, borderRadius: 11 }}><Ic n="checkcircle" s={21} c="var(--cd-on-ink)" /></span>
            <div className="flex-1">
              <div className="text-[15px] font-semibold" style={{ color: '#1c5c3a' }}>Day {day.num || 1} closed — nicely done</div>
              <div className="text-[12px] mt-0.5" style={{ color: '#3a7a56' }}>Closed by {day.closedBy || '—'} · {day.closedAt || ''}. The book is locked until you open the next day.</div>
            </div>
            {(day.summary && day.summary.earned != null) && <div className="text-right flex-none">
              <div className="text-[10px] uppercase tracking-widest" style={{ color: '#3a7a56', fontFamily: 'Space Mono, monospace' }}>Earned today</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1c5c3a', fontVariantNumeric: 'tabular-nums' }}>{fmt(day.summary.earned, 'CAD')}</div>
            </div>}
          </div>
          <div className="grid grid-cols-3 gap-3 mt-4">
            <Kpi label="Drawer value" value={fmt((day.summary && day.summary.grand) || grandCad, 'CAD')} />
            <Kpi label="Transactions" value={`${(day.summary && day.summary.txns) ?? rows.filter(r => r.date === TODAY).length}`} />
            <Kpi label="Drawers off" value={(day.summary && day.summary.offCount) || 0} tone={((day.summary && day.summary.offCount) || 0) > 0 ? CD.flag : CD.green} sub={(day.summary && day.summary.note) || 'balanced'} />
          </div>

          {/* big, deliberate (not automatic) end-of-day report generation */}
          {onOpenReport && (
            <button onClick={() => onOpenReport('endofday')} className="flex items-center gap-3.5 mt-4 w-full text-left" style={{ background: CD.ink, borderRadius: 14, padding: '17px 18px', cursor: 'pointer', transition: 'transform .12s, box-shadow .12s' }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 12px 28px -12px var(--cd-scrim)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
              <span className="grid place-items-center flex-none" style={{ width: 46, height: 46, background: CD.green, borderRadius: 12 }}><Ic n="receipt" s={23} c="var(--cd-on-ink)" /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[15.5px] font-semibold" style={{ color: 'var(--cd-on-ink)' }}>Generate End-of-Day Sign-Off sheet</span>
                <span className="block text-[12px] mt-0.5" style={{ color: 'var(--cd-on-ink-soft)' }}>The signed close-out: drawer counts, day totals &amp; compliance — ready to print, sign and file.</span>
              </span>
              <span className="flex items-center gap-1.5 flex-none px-3 py-2 text-[12.5px] font-semibold" style={{ background: 'var(--cd-on-ink-faint)', color: 'var(--cd-on-ink)', borderRadius: 9 }}>Open <Ic n="arrowright" s={15} c="var(--cd-on-ink)" /></span>
            </button>
          )}
          {/* spacer pushes the open-next-day control to the bottom, out of accidental reach */}
          <div style={{ flex: 1, minHeight: 28 }}></div>
          <div className="flex items-center justify-between gap-3 pt-3" style={{ borderTop: `1px solid ${CD.line}` }}>
            <p className="text-[11px]" style={{ color: CD.faint, maxWidth: 360 }}>Ready for a new session? Opening the next day unlocks the book and starts Day {(day.num || 1) + 1}.</p>
            {canCloseDay
              ? <button onClick={() => { if (opening || busyRef.current) return; busyRef.current = true; setOpening(true); setTimeout(() => { onOpenNextDay && onOpenNextDay(); setOpening(false); busyRef.current = false; }, 520); }} disabled={opening} className="till-save flex items-center gap-2 px-4 py-2.5 text-sm font-semibold flex-none" style={{ background: opening ? CD.green : 'transparent', color: opening ? 'var(--cd-on-ink)' : CD.ink, border: `1px solid ${opening ? CD.green : CD.line}`, borderRadius: 9, transition: 'background .25s ease, color .25s ease, border-color .25s ease' }} onMouseEnter={e => { if (!opening) { e.currentTarget.style.background = CD.ink; e.currentTarget.style.color = '#fff'; } }} onMouseLeave={e => { if (!opening) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = CD.ink; } }}><Ic n={opening ? 'checkcircle' : 'calendar'} s={15} c={opening ? 'var(--cd-on-ink)' : 'currentColor'} /> {opening ? 'Opening…' : 'Open next day'}</button>
              : <span className="flex items-center gap-2 px-3 py-2 text-[12px] flex-none" style={{ color: CD.mute }}><Ic n="lock" s={14} c={CD.faint} /> Owner / permitted staff only</span>}
          </div>
        </div>) : (<div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Reconcile & close — Day {day && day.num || 1}</div><div className="text-[11px]" style={{ color: CD.mute }}>Opening comes from the vault · expected = opening + today's deals · counted is your physical count · {countedN} of {recon.length} counted</div></div>
            <span className="text-[11px] px-2.5 py-1" style={{ background: countedN === recon.length ? CD.greenSoft : 'var(--cd-chip)', color: countedN === recon.length ? CD.green : CD.mute, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{countedN}/{recon.length} counted</span>
          </div>
          <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 10 }}>
            <table className="w-full text-sm border-collapse"><thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[11px] uppercase tracking-wide text-left"><th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right"><span title="Issued by the vault — not editable here" className="inline-flex items-center gap-1">Opening · vault <Ic n="lock" s={10} c={CD.faint} /></span></th><th className="px-3 py-2 text-right">Expected</th><th className="px-3 py-2 text-right">Last count</th><th className="px-3 py-2 text-right">Counted now</th><th className="px-3 py-2 text-right">Variance</th></tr></thead>
              <tbody>{recon.map(r => { const ls = lastSaved[r.c]; return (<tr key={r.c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(r.c)}</span> {r.c}</td>
                <td className="px-3 py-2 text-right" title="What the vault issued to this drawer — change it with Issue float / Return at the vault, never by typing" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{num((baseline && baseline.units && baseline.units[r.c]) || 0)}</td>
                <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(r.expected)}</td>
                <td className="px-3 py-2 text-right" style={{ color: ls ? CD.mute : CD.faint }}>{ls ? <span title={`${num(ls.amt)} ${r.c} · ${atLabel(ls.ts)}${ls.by ? ' · ' + ls.by : ''}`} style={{ cursor: 'help', borderBottom: `1px dotted ${CD.line}`, fontVariantNumeric: 'tabular-nums' }}>{sinceLabel(ls.ts)}</span> : '— never'}</td>
                <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: r.counted == null ? CD.faint : CD.ink, fontWeight: r.counted == null ? 400 : 700 }}>{r.counted == null ? <button onClick={() => { setCcy(r.c); setTab('count'); }} className="text-[11px] underline" style={{ color: CD.mute }}>count →</button> : <span title={countedAt[r.c] ? 'Counted ' + sinceLabel(countedAt[r.c]) + ' · ' + atLabel(countedAt[r.c]) : ''} style={{ cursor: countedAt[r.c] ? 'help' : 'default' }}>{num(r.counted)}</span>}</td>
                <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: r.variance == null ? CD.mute : !offOf(r) ? CD.green : CD.flag }}>{r.variance == null ? '—' : (r.variance > 0 ? '+' : '') + num(r.variance)}</td>
              </tr>); })}</tbody><tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}><td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total · CAD</td><td></td><td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{num(totalExpCad)}</td><td></td><td className="px-3 py-2 text-right font-bold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(totalCountCad)}</td><td className="px-3 py-2 text-right font-bold" style={{ fontVariantNumeric: 'tabular-nums', color: Math.abs(totalVarCad) <= tolCad + 0.005 ? CD.green : CD.flag }}>{(totalVarCad > 0 ? '+' : '') + num(totalVarCad)}</td></tr></tfoot></table>
          </div>
          <div className="flex items-center gap-3 mt-3">
            {canCloseDay
              ? <button onClick={clickClose} disabled={closing || closeBlocked} title={closeBlocked ? 'Count every drawer first — required in Settings › Cash drawer' : ''} className="till-save flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white" style={{ background: closing ? CD.green : CD.ink, borderRadius: 9, transition: 'background .22s ease' }} onMouseEnter={e => { if (!closing) e.currentTarget.style.background = CD.flag; }} onMouseLeave={e => { if (!closing) e.currentTarget.style.background = CD.ink; }}><Ic n={closing ? 'checkcircle' : 'lock'} s={14} c="var(--cd-on-ink)" /> {closing ? 'Closing…' : 'Close day & lock book'}</button>
              : <span className="flex items-center gap-2 px-3 py-2 text-[12px]" style={{ background: 'var(--cd-chip)', borderRadius: 9, color: CD.mute }}><Ic n="lock" s={14} c={CD.faint} /> Closing the day isn’t in your role — the owner enables it in Settings › Permissions.</span>}
            {canCloseDay && closeBlocked && <span className="text-[11px]" style={{ color: CD.mute }}>Count all {recon.length} drawers before closing</span>}
            {canCloseDay && offRows.length > 0 && <span className="text-[11px]" style={{ color: CD.flag }}>{offRows.length} drawer(s) off</span>}
            {canCloseDay && offRows.length === 0 && countedN > 0 && <span className="text-[11px]" style={{ color: CD.green }}>All counted drawers balanced</span>}
          </div>
          <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>One direction only: the vault issues your <b>opening</b> (locked here — floats move at the vault), the day's deals produce <b>expected</b>, your physical count is <b>counted</b>, and <b>variance</b> = counted − expected — it lands on the operator. Closing locks the ledger until the next day is opened.</p>
        </div>))}

        {/* ===== HISTORY ===== */}
        {tab === 'history' && (<div className="p-4">
          {/* the cash rail — every issue & return for THIS drawer */}
          {(() => {
            const _tRec = ((_ab && _ab.tills) || []).find(t => t.id === (station && station.tillId));
            const tLabel = _ab && _tRec ? _ab.code + ' · ' + _tRec.name.replace(/\s+—.*/, '') : null;
            const railMoves = tLabel ? (moves || []).filter(m => m.from === tLabel || m.to === tLabel) : [];
            return (<div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] uppercase tracking-widest font-semibold flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="swap" s={12} c={CD.faint} /> Cash rail · this drawer</div>
                {railMoves.length > 0 && <span className="text-[11px]" style={{ color: CD.faint }}>{railMoves.length} recorded</span>}
              </div>
              {railMoves.length === 0
                ? <div className="text-[12px] px-3 py-3" style={{ color: CD.mute, background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}>No floats yet — cash issued to or returned from this drawer is recorded here.</div>
                : <div style={{ border: `1px solid ${CD.line}`, borderRadius: 11, overflow: 'hidden' }}>
                    {railMoves.slice(0, 8).map((m, i) => { const out = m.from === tLabel; return (
                      <div key={m.id} className="flex items-center gap-2.5 px-3 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none', background: 'var(--cd-panel)' }}>
                        <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, background: out ? CD.lineSoft : CD.greenSoft }}><Ic n={out ? 'arrowup' : 'arrowdown'} s={13} c={out ? CD.mute : CD.green} /></span>
                        <div className="flex-1 min-w-0 leading-tight">
                          <div className="text-[12.5px]" style={{ color: CD.ink }}><b>{out ? 'Returned to vault' : 'Float issued'}</b> <span style={{ color: CD.faint }}>{out ? '→' : '←'}</span> {out ? m.to : m.from}</div>
                          <div className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{m.ref} · {m.date} · {m.by}</div>
                        </div>
                        <span className="text-[12px] font-bold flex-none" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: out ? CD.mute : CD.green }}>{out ? '−' : '+'}{num(m.amount)} {m.ccy}</span>
                      </div>); })}
                  </div>}
            </div>);
          })()}
          {/* shift handoff log */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-widest font-semibold flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="users" s={12} c={CD.faint} /> Shift handoffs</div>
              {handoffs.length > 0 && <span className="text-[11px]" style={{ color: CD.faint }}>{handoffs.length} recorded</span>}
            </div>
            {handoffs.length === 0
              ? <div className="text-[12px] px-3 py-3" style={{ color: CD.mute, background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}>No handoffs yet — the drawer has stayed with {current ? current.operator : 'one operator'}.</div>
              : <div style={{ border: `1px solid ${CD.line}`, borderRadius: 11, overflow: 'hidden' }}>
                  {handoffs.slice(0, 8).map((h, i) => (
                    <div key={h.id} className="flex items-center gap-2.5 px-3 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none', background: 'var(--cd-panel)' }}>
                      <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, background: h.counted ? (Math.abs(h.variance || 0) < 0.005 ? CD.greenSoft : CD.flagSoft) : CD.lineSoft }}><Ic n={h.counted ? (Math.abs(h.variance || 0) < 0.005 ? 'check' : 'alert') : 'arrowright'} s={13} c={h.counted ? (Math.abs(h.variance || 0) < 0.005 ? CD.green : CD.flag) : CD.mute} /></span>
                      <div className="flex-1 min-w-0 leading-tight">
                        <div className="text-[12.5px]" style={{ color: CD.ink }}><b>{h.from}</b> <span style={{ color: CD.faint }}>→</span> <b>{h.to}</b>{h.tillName ? <span className="text-[11px]" style={{ color: CD.faint }}> · {h.tillName}</span> : null}</div>
                        <div className="text-[10.5px]" style={{ color: CD.faint }}>{h.at} · by {h.by}</div>
                      </div>
                      <span className="text-[11px] flex-none text-right" style={{ fontFamily: 'Space Mono, monospace', color: h.counted ? (Math.abs(h.variance || 0) < 0.005 ? CD.green : CD.flag) : CD.mute }}>{h.counted ? (Math.abs(h.variance || 0) < 0.005 ? '✓ balanced' : (h.variance > 0 ? '+' : '') + fmt(h.variance, 'CAD')) : 'no count'}</span>
                    </div>))}
                </div>}
          </div>
          {viewDay ? (<div>
            <button onClick={() => setViewDay(null)} className="flex items-center gap-1.5 text-[12px] mb-3" style={{ color: CD.mute }}><Ic n="arrowleft" s={14} /> All days</button>
            <div className="text-sm font-semibold mb-1" style={{ color: CD.ink }}>{viewDay} · {fmt(history[viewDay].grand, 'CAD')}</div>
            <div className="text-[11px] mb-3" style={{ color: CD.faint }}>Counted by {history[viewDay].by} · {history[viewDay].at}</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {Object.entries(history[viewDay].byCcy).sort((a, b) => cadOf(b[1], b[0]) - cadOf(a[1], a[0])).map(([c, amt]) => (
                <div key={c} className="flex items-center justify-between px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 9 }}>
                  <span className="flex items-center gap-2 text-sm" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(c)}</span> {c}</span>
                  <span className="text-right"><span style={{ fontFamily: 'Space Mono, monospace', fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(amt)}</span> {c !== 'CAD' && <span className="text-[11px]" style={{ color: CD.mute }}> · {fmt(cadOf(amt, c), 'CAD')}</span>}</span>
                </div>))}
            </div>
          </div>) : (<div>
            {/* 90-day trend */}
            <div className="p-4 mb-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
              <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Drawer value · last 90 days</span><span style={{ fontFamily: 'Space Mono, monospace', fontSize: 13, fontWeight: 700, color: CD.ink }}>{fmt(histSeries[histSeries.length - 1] || 0, 'CAD')}</span></div>
              <HistChart data={histSeries} />
            </div>
            <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.panel }}>
              <table className="w-full text-sm border-collapse"><thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[11px] uppercase tracking-wide text-left"><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">Total (CAD)</th><th className="px-3 py-2">Currencies</th><th className="px-3 py-2">Counted by</th></tr></thead>
                <tbody>{histKeys.slice(0, 60).map(k => { const h = history[k]; return (<tr key={k} onClick={() => setViewDay(k)} className="cursor-pointer" style={{ borderTop: `1px solid ${CD.lineSoft}` }} onMouseEnter={e => e.currentTarget.style.background = 'var(--cd-paper-soft)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td className="px-3 py-2 font-medium" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{k}{k === TODAY && <span className="ml-2 text-[9px] px-1.5 py-0.5" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>TODAY</span>}</td>
                  <td className="px-3 py-2 text-right font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(h.grand, 'CAD')}</td>
                  <td className="px-3 py-2" style={{ color: CD.mute }}>{Object.keys(h.byCcy).length}</td>
                  <td className="px-3 py-2" style={{ color: CD.mute }}>{h.by}</td>
                </tr>); })}</tbody></table>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>A snapshot is saved each time you count the drawer. Click any day to see its full denomination breakdown.</p>
          </div>)}
        </div>)}
      </div>
      {/* ===== CLOSE-OUT REVIEW MODAL ===== */}
      {confirmClose && (<div style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(24,21,17,0.46)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={() => setConfirmClose(false)}>
        <div onClick={e => e.stopPropagation()} className="flex flex-col" style={{ width: 'min(580px, 100%)', maxHeight: '100%', background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 16, boxShadow: '0 24px 60px rgba(0,0,0,0.30)', overflow: 'hidden' }}>
          <div className="px-5 pt-4 pb-3 flex items-start gap-3 flex-none" style={{ borderBottom: `1px solid ${CD.line}` }}>
            <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, background: CD.ink, borderRadius: 9 }}><Ic n="lock" s={16} c="var(--cd-on-ink)" /></span>
            <div className="flex-1">
              <div className="text-[15px] font-semibold" style={{ color: CD.ink }}>Close out the day — Day {day && day.num || 1}</div>
              <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>Review each drawer against expected, then lock the book. You won't be able to post again until you open the next day.</div>
            </div>
          </div>
          <div className="overflow-auto px-5 py-3" style={{ flex: 1 }}>
            <table className="w-full text-sm border-collapse">
              <thead><tr className="text-[10px] uppercase tracking-wide text-left" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><th className="py-1.5">Drawer</th><th className="py-1.5 text-right">Expected</th><th className="py-1.5 text-right">Counted</th><th className="py-1.5 text-right">Last counted</th><th className="py-1.5 text-right">Variance</th></tr></thead>
              <tbody>{recon.map(r => { const ts = countedAt[r.c]; return (<tr key={r.c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                <td className="py-1.5 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(r.c)}</span> {r.c}</td>
                <td className="py-1.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{num(r.expected)}</td>
                <td className="py-1.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: r.counted == null ? CD.faint : CD.ink, fontFamily: 'Space Mono, monospace' }}>{r.counted == null ? '— not counted' : num(r.counted)}</td>
                <td className="py-1.5 text-right text-[11px]" style={{ color: ts ? CD.mute : CD.faint }}>{ts ? `${sinceLabel(ts)} · ${atLabel(ts)}` : '—'}</td>
                <td className="py-1.5 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: r.variance == null ? CD.faint : Math.abs(r.variance) < 0.005 ? CD.green : CD.flag, fontFamily: 'Space Mono, monospace' }}>{r.variance == null ? '—' : (r.variance > 0 ? '+' : '') + num(r.variance)}</td>
              </tr>); })}</tbody>
              <tfoot><tr style={{ borderTop: `2px solid ${CD.line}` }}><td className="py-2 font-semibold" style={{ color: CD.ink }}>Total · CAD</td><td className="py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{num(totalExpCad)}</td><td className="py-2 text-right font-bold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{num(totalCountCad)}</td><td></td><td className="py-2 text-right font-bold" style={{ fontVariantNumeric: 'tabular-nums', color: Math.abs(totalVarCad) < 0.005 ? CD.green : CD.flag, fontFamily: 'Space Mono, monospace' }}>{(totalVarCad > 0 ? '+' : '') + num(totalVarCad)}</td></tr></tfoot>
            </table>
            {countedN < recon.length && <div className="mt-3 text-[11.5px] px-3 py-2" style={{ background: 'var(--cd-chip)', borderRadius: 8, color: CD.mute }}>{recon.length - countedN} drawer(s) not counted yet — they'll lock at expected with no variance. Go back and count them first if you want a true close.</div>}
          </div>
          <div className="px-5 py-3 flex items-center justify-between gap-3 flex-none" style={{ borderTop: `1px solid ${CD.line}` }}>
            <button onClick={() => { setConfirmClose(false); setTab('count'); }} className="text-sm font-medium px-3.5 py-2" style={{ color: CD.ink, border: `1px solid ${CD.line}`, borderRadius: 9, background: 'transparent' }}>← Back to count</button>
            <button onClick={confirmAndClose} className="till-save flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }} onMouseEnter={e => e.currentTarget.style.background = CD.flag} onMouseLeave={e => e.currentTarget.style.background = CD.ink}><Ic n="lock" s={14} c="var(--cd-on-ink)" /> Close day & lock book</button>
          </div>
        </div>
      </div>)}
      {handoffOpen && <HandoffModal tillId={tillId} tillName={tillNm} current={current} roster={roster} me={me} requireCount={requireCount} expected={CCYS.map(c => ({ ccy: c, units: expectedOf(c) })).filter(x => Math.abs(x.units) > 0.005 || x.ccy === 'CAD')} onClose={() => setHandoffOpen(false)} onDone={doHandoff} />}
    </div>);
  }

  function HistChart({ data, h = 70 }) {
    if (!data || data.length < 2) return <div style={{ height: h, display: 'grid', placeItems: 'center', color: CD.faint, fontSize: 11 }}>No history</div>;
    const w = 600, max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
    const X = (i) => (i / (data.length - 1)) * w, Y = (v) => h - ((v - min) / rng) * (h - 8) - 4;
    const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    return (<svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs><linearGradient id="tillArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={CD.ink} stopOpacity="0.12" /><stop offset="100%" stopColor={CD.ink} stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="url(#tillArea)" /><path d={line} fill="none" stroke={CD.ink} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>);
  }
  function Kpi({ label, value, sub, tone }) {
    return (<div style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 10, padding: '12px 14px' }}>
      <div className="text-[11px]" style={{ color: CD.mute }}>{label}</div>
      <div className="text-xl font-semibold mt-0.5" style={{ color: tone || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[10.5px] mt-0.5" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { TillDrawer });
})();
