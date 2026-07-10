/* ============================================================
   CurrencyDesk OS — back-office modules
   Ported from the worked-out logic: Ledger, Clients/KYC, Dashboard,
   Day Close, Audit, Settings + Calculator + Receipt.
   Recolored to the CurrencyDesk black/white palette; the ledger's
   auto pay-out now uses the live rate engine (crossRate).
   ============================================================ */
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const { CD, Ic, TYPES, CCY, THRESHOLD, TODAY, crossRate, perCadLive, fmt, num, dDiff } = window.CDOS;

  /* ---- shared compliance computation (also used by the app-bar badge) ---- */
  function computeFlags(rows, clients, settings) {
    const map = {};
    const live = rows.filter(r => r.status !== 'void');   /* voided records leave the books */
    // threshold + 24h window come from the active jurisdiction pack (regime) so the
    // same engine serves FINTRAC, FinCEN, … — see window.CDOS.getRegime
    const regime = (window.CDOS.getRegime ? window.CDOS.getRegime(settings) : null) || { threshold: (settings && +settings.threshold) || THRESHOLD, aggHours: 24 };
    const TH = regime.threshold;
    const cadIn = (r) => r.inCcy === 'CAD' ? (Number(r.inAmt) || 0) : (Number(r.inAmt) || 0) / (crossRate('CAD', r.inCcy) || 1);
    const dt = (r) => new Date(r.date + 'T' + (r.time || '00:00'));
    rows.forEach(row => {
      if (row.status === 'void') { map[row.id] = { void: true, single: false, str: false, agg24: false, kyc: 'ok', agg: 0 }; return; }
      const single = cadIn(row) >= TH;
      // structuring SUSPICION — many just-under deals over the longer window (a watch)
      const agg = live.filter(o => o.customer && o.customer === row.customer && dDiff(o.date, row.date) >= 0 && dDiff(o.date, row.date) <= settings.structuringDays)
        .reduce((s, o) => s + cadIn(o), 0);
      const str = !single && agg >= TH;
      // TRUE rolling-24h aggregation RULE — same person, cash-in within aggHours
      // ending at this deal ≥ threshold ⇒ a single REPORTABLE aggregated transaction
      const end = dt(row);
      const cluster = live.filter(o => o.customer && o.customer === row.customer && (() => { const h = (end - dt(o)) / 3600000; return h >= 0 && h <= (regime.aggHours || 24); })());
      const agg24Sum = cluster.reduce((s, o) => s + cadIn(o), 0);
      // the aggregate is reported once — at the deal that crosses the line (the latest
      // in the window with no later deal still inside the same window pushing it on)
      const isClusterEnd = !live.some(o => o.customer === row.customer && dt(o) > end && (dt(o) - end) / 3600000 <= (regime.aggHours || 24) && cadIn(o) >= 0);
      const agg24 = !single && agg24Sum >= TH && isClusterEnd;
      const rec = clients[row.customer]; let kyc = 'ok';
      if (!rec || !rec.idType || !rec.idNum) kyc = 'missing ID';
      else if (rec.idExpiry && rec.idExpiry < TODAY) kyc = 'ID expired';
      else if (settings.requireIdPhoto && !rec.photo) kyc = 'photo needed';
      // ID is only REQUIRED once the deal reaches the owner's ID threshold (or the
      // mandatory reportable line). Below that a missing ID is a soft note the
      // teller can acknowledge — not a compliance warning and not a notification.
      const idFloor = +settings.idRequiredOver || 3000;
      const idNeeded = single || cadIn(row) >= idFloor;
      map[row.id] = { single, str, agg, agg24, agg24Sum, kyc, idNeeded, idFloor, void: false };
    });
    return map;
  }
  /* alerts count only OPEN items: unfiled reportables (single + 24h aggregate),
     unacknowledged structuring, KYC gaps */
  function computeAlerts(rows, flags) {
    const str = new Set(), idI = new Set(); let rpt = 0;
    rows.forEach(r => {
      const f = flags[r.id]; if (!f || f.void) return;
      if ((f.single || f.agg24) && !r.filed) rpt++;
      if (f.str && !r.ackStr) str.add(r.customer);
      // only an OPEN alert when ID is actually required for the deal's size
      if (f.kyc !== 'ok' && f.idNeeded) idI.add(r.customer);
    });
    return { str: str.size, id: idI.size, rpt };
  }

  /* ---- atoms ---- */
  function Stat({ label, value, mono, flag }) { return (<div className="px-5 py-3" style={{ borderRight: `1px solid ${CD.lineSoft}` }}><div className="text-[11px]" style={{ color: CD.mute }}>{label}</div><div className="text-lg font-semibold" style={{ color: flag ? CD.flag : CD.ink, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{value}</div></div>); }
  function Kpi({ label, value, accent }) { return (<div className="px-4 py-3" style={{ background: CD.panel, border: `1px solid ${CD.line}` }}><div className="text-[11px]" style={{ color: CD.mute }}>{label}</div><div className="text-xl font-semibold" style={{ color: accent || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div></div>); }
  function Pill({ icon, c, bg, t }) { return (<span className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 font-medium" style={{ background: bg, color: c }}><Ic n={icon} s={13} /> {t}</span>); }
  function Tag({ c, bg, t, title }) { return (<span title={title} className="text-[10px] px-1 font-medium" style={{ background: bg, color: c }}>{t}</span>); }
  function Field({ label, children }) { return (<div><div className="text-[11px] mb-1" style={{ color: CD.mute }}>{label}</div>{children}</div>); }
  function Section({ title, sub, children }) { return (<div className="mb-5 p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}` }}><div className="font-semibold" style={{ color: CD.ink }}>{title}</div>{sub && <div className="text-[11px] mt-0.5 mb-1" style={{ color: CD.mute }}>{sub}</div>}{children}</div>); }
  function BarCard({ title, data, fmtV }) { const max = Math.max(1, ...data.map(d => d[1])); return (<div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}` }}><div className="text-sm font-semibold mb-3" style={{ color: CD.ink }}>{title}</div>{data.map(([k, v]) => (<div key={k} className="mb-2"><div className="flex justify-between text-[11px] mb-0.5"><span style={{ color: CD.text }}>{k}</span><span style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{fmtV(v)}</span></div><div className="h-2" style={{ background: CD.lineSoft }}><div className="h-2" style={{ width: `${(v / max) * 100}%`, background: CD.ink }} /></div></div>))}</div>); }
  function Cell({ v, on, ph, w, type }) { return (<td className="px-1 py-1" style={{ width: w ? `${w}px` : 'auto' }}><input value={v} onChange={e => on(e.target.value)} placeholder={ph} type={type || 'text'} className="w-full px-1.5 py-1 outline-none text-sm bg-transparent" style={{ border: '1px solid transparent' }} onFocus={e => e.target.style.border = `1px solid ${CD.ink}`} onBlur={e => e.target.style.border = '1px solid transparent'} /></td>); }
  function Num({ v, on, ph, w }) { return (<input value={v} onChange={e => on(e.target.value)} placeholder={ph} type="number" className="px-1.5 py-1 outline-none text-sm bg-transparent text-right" style={{ border: '1px solid transparent', width: w ? `${w}px` : '90px', fontVariantNumeric: 'tabular-nums' }} onFocus={e => e.target.style.border = `1px solid ${CD.ink}`} onBlur={e => e.target.style.border = '1px solid transparent'} />); }
  function Sel({ v, on, opts, narrow }) { return (<select value={v} onChange={e => on(e.target.value)} className="px-1 py-1 outline-none text-sm bg-transparent" style={{ border: '1px solid transparent', width: narrow ? '62px' : 'auto' }}>{opts.map(o => <option key={o}>{o}</option>)}</select>); }
  function SelCell({ v, on, opts, w }) { return (<td className="px-1 py-1" style={{ width: w ? `${w}px` : 'auto' }}><Sel v={v} on={on} opts={opts} /></td>); }
  function Line({ k, v }) { return (<div className="flex justify-between text-sm py-0.5"><span style={{ color: CD.mute }}>{k}</span><span style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</span></div>); }

  /* ---- LEDGER lives in cdos-ledger.jsx (immutable records + modal + drawer) ---- */

  /* ---- CLIENTS / KYC lives in cdos-clients.jsx (full MSB contact system) ---- */

  /* ---- DASHBOARD lives in cdos-dashboard.jsx (owner command center) ---- */

  /* ---- TILL & CASH DRAWER lives in cdos-till.jsx (Day Close folded in) ---- */

  /* ---- AUDIT TRAIL — searchable, day-grouped, append-only, with a 24h scrubber ---- */
  function Audit({ audit, settings }) {
    const [q, setQ] = useState('');
    const [actionF, setActionF] = useState('all');
    const [staffF, setStaffF] = useState('all');
    const [range, setRange] = useState('all');   // all | year | 6mo | quarter | week | today
    const RANGES = [['all', 'All time', null], ['year', 'Past year', 365], ['6mo', 'Past 6 months', 182], ['quarter', 'Past quarter', 90], ['week', 'Past week', 7], ['today', 'Today', 0]];
    const [cursor, setCursor] = useState(null);   // index into the chronological (filtered) list, or null
    const scroller = useRef(null);
    const trackRef = useRef(null);
    const rowRefs = useRef({});
    const dragging = useRef(false);

    const parse = (ts) => {
      const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(ts || '');
      if (!m) return { date: (ts || '').slice(0, 10), time: '', min: 0 };
      return { date: m[1], time: m[2] + ':' + m[3] + (m[4] ? ':' + m[4] : ''), min: (+m[2]) * 60 + (+m[3]) };
    };
    const inits = (n) => (n || '?').split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    const use12 = ((settings && settings.timeFormat) || '12h') !== '24h';
    const hhmm = (min) => {
      const h = Math.floor(min / 60), m = min % 60;
      if (use12) { const ap = h < 12 ? 'AM' : 'PM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + String(m).padStart(2, '0') + ' ' + ap; }
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    };

    const items = useMemo(() => audit.map((a, i) => ({ ...a, i, ...parse(a.ts) })), [audit]);
    const actions = useMemo(() => Array.from(new Set(items.map(a => a.action))).sort(), [items]);
    const staff = useMemo(() => Array.from(new Set(items.map(a => a.user))).sort(), [items]);

    const filtered = useMemo(() => {
      const needle = q.trim().toLowerCase();
      // range cutoff measured from the most recent entry's day (so the demo data reads naturally)
      const days = (RANGES.find(r => r[0] === range) || [])[2];
      let cutoff = null;
      if (days != null) { const ds = items.map(a => a.date).filter(Boolean).sort(); const refDate = ds.length ? ds[ds.length - 1] : new Date().toISOString().slice(0, 10); const d = new Date(refDate + 'T00:00:00'); d.setDate(d.getDate() - days); cutoff = d.toISOString().slice(0, 10); }
      return items.filter(a => {
        if (cutoff && a.date < cutoff) return false;
        if (actionF !== 'all' && a.action !== actionF) return false;
        if (staffF !== 'all' && a.user !== staffF) return false;
        if (needle) { const hay = (a.ts + ' ' + a.user + ' ' + a.action + ' ' + a.detail).toLowerCase(); if (!hay.includes(needle)) return false; }
        return true;
      });
    }, [items, q, actionF, staffF, range]);

    const groups = useMemo(() => {
      const map = new Map();
      filtered.forEach(a => { if (!map.has(a.date)) map.set(a.date, []); map.get(a.date).push(a); });
      return Array.from(map.entries());
    }, [filtered]);

    const fmtDay = (d) => { const dt = new Date(d + 'T00:00:00'); return isNaN(dt) ? d : dt.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); };
    const shortDay = (d) => { const dt = new Date(d + 'T00:00:00'); return isNaN(dt) ? d : dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); };

    // The scrubber runs over the whole filtered timeline (top = newest, bottom = oldest),
    // so it works no matter how many days are present.
    const ordered = filtered;
    const cursorEntry = (cursor != null && ordered[cursor]) ? ordered[cursor] : null;
    const nearestI = cursorEntry ? cursorEntry.i : null;
    const setFromY = (clientY) => {
      const el = trackRef.current; if (!el) return;
      const n = ordered.length; if (!n) { setCursor(null); return; }
      const r = el.getBoundingClientRect();
      let pct = (clientY - r.top) / r.height; pct = Math.max(0, Math.min(1, pct));
      const idx = Math.round(pct * (n - 1)); setCursor(idx);   // top = most recent, scrubbing down moves back in time
      const target = ordered[idx];
      if (target && rowRefs.current[target.i] && scroller.current) {
        const rb = rowRefs.current[target.i].getBoundingClientRect();
        const sb = scroller.current.getBoundingClientRect();
        scroller.current.scrollTop += (rb.top - sb.top) - 64;
      }
    };
    const onTrackDown = (e) => {
      e.preventDefault(); dragging.current = true; setFromY(e.clientY);
      const mv = (ev) => { if (dragging.current) setFromY(ev.clientY); };
      const up = () => { dragging.current = false; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    };
    const selSty = { border: `1px solid ${CD.line}`, borderRadius: 8, background: CD.paper, color: CD.ink };

    return (
      <div className="flex" style={{ height: '100%', background: CD.paper }}>
        {/* LEFT — minimal 24-hour scrubber: a thin track that shows the time only while grabbed */}
        <div className="flex-none flex flex-col" style={{ width: 30, borderRight: `1px solid ${CD.line}`, background: CD.panel, padding: '16px 0' }}>
          <div ref={trackRef} onPointerDown={onTrackDown} className="relative" style={{ flex: 1, width: 4, margin: '0 auto', background: CD.lineSoft, borderRadius: 999, cursor: 'pointer', touchAction: 'none' }}>
            {cursorEntry && (() => { const n = ordered.length; const pct = n > 1 ? cursor / (n - 1) : 0; return (<>
              <div className="absolute" style={{ left: 0, top: 0, width: '100%', height: (pct * 100) + '%', background: CD.ink, borderRadius: 999 }}></div>
              <div className="absolute" style={{ top: (pct * 100) + '%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 3 }}>
                <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 5, fontFamily: 'Space Mono, monospace', fontSize: 10, padding: '1px 5px', whiteSpace: 'nowrap', boxShadow: '0 1px 5px var(--cd-scrim)' }}>{shortDay(cursorEntry.date)} · {hhmm(cursorEntry.min)}</span>
                <span style={{ display: 'block', width: 12, height: 12, borderRadius: '50%', background: CD.ink, border: '2px solid var(--cd-panel)', boxShadow: '0 1px 4px var(--cd-scrim)' }}></span>
              </div>
            </>); })()}
          </div>
        </div>

        {/* RIGHT — search + filters + grouped list */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-none px-4 py-3 flex items-center gap-2" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
            <div className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0" style={{ background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 9 }}>
              <Ic n="search" s={15} c={CD.mute} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search time, action, detail or staff…" className="outline-none bg-transparent text-sm w-full" style={{ minWidth: 0 }} />
              {q && <button onClick={() => setQ('')} className="flex-none"><Ic n="x" s={14} c={CD.faint} /></button>}
            </div>
            <select value={actionF} onChange={e => setActionF(e.target.value)} className="text-[12px] px-2.5 py-2 outline-none flex-none" style={selSty}><option value="all">All actions</option>{actions.map(a => <option key={a} value={a}>{a}</option>)}</select>
            <select value={staffF} onChange={e => setStaffF(e.target.value)} className="text-[12px] px-2.5 py-2 outline-none flex-none" style={selSty}><option value="all">All staff</option>{staff.map(s => <option key={s} value={s}>{s}</option>)}</select>
            <select value={range} onChange={e => setRange(e.target.value)} className="text-[12px] px-2.5 py-2 outline-none flex-none" style={selSty}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div className="flex-none px-4 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
            <span className="text-[11px]" style={{ color: CD.mute }}>{filtered.length} {filtered.length === 1 ? 'entry' : 'entries'} · {groups.length} {groups.length === 1 ? 'day' : 'days'}{(q || actionF !== 'all' || staffF !== 'all') ? ' · filtered' : ''}</span>
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5" style={{ color: CD.mute, background: CD.lineSoft, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}><Ic n="lock" s={10} c={CD.mute} /> APPEND-ONLY</span>
          </div>
          <div ref={scroller} className="flex-1 overflow-auto">
            {groups.length ? groups.map(([date, list]) => (
              <div key={date}>
                <div className="sticky top-0 px-4 py-1.5 flex items-center gap-2" style={{ background: 'var(--cd-chip)', borderBottom: `1px solid ${CD.line}`, zIndex: 1 }}>
                  <span className="text-[11px] font-semibold" style={{ color: CD.ink }}>{fmtDay(date)}</span>
                  <span className="text-[10px] px-1.5 py-0.5" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{list.length}</span>
                </div>
                {list.map(a => { const on = nearestI === a.i; return (
                  <div key={a.i} ref={el => { if (el) rowRefs.current[a.i] = el; }} className="px-4 py-2.5 flex items-center gap-3" style={{ borderBottom: `1px solid ${CD.lineSoft}`, background: on ? CD.brassSoft : 'transparent', transition: 'background .2s' }}>
                    <span className="text-[11px] tabular-nums flex-none" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace', width: use12 ? 72 : 56 }}>{hhmm(a.min)}</span>
                    <span className="flex items-center gap-1.5 flex-none" style={{ width: 104 }}>
                      <span className="grid place-items-center flex-none" style={{ width: 22, height: 22, borderRadius: '50%', background: a.user === 'System' ? CD.lineSoft : CD.ink, color: a.user === 'System' ? CD.mute : 'var(--cd-on-ink)', fontSize: 9, fontFamily: 'Space Mono, monospace', fontWeight: 700 }}>{inits(a.user)}</span>
                      <span className="text-[11.5px] truncate" style={{ color: CD.ink }}>{a.user}</span>
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium" style={{ color: CD.ink }}>{a.action}</div>
                      {a.detail && <div className="text-[11.5px] truncate" style={{ color: CD.mute }}>{a.detail}</div>}
                    </div>
                  </div>); })}
              </div>
            )) : <div className="text-center py-16" style={{ color: CD.faint }}><Ic n="search" s={22} c={CD.faint} /><div className="mt-2 text-[13px]">No entries match your search.</div></div>}
          </div>
        </div>
      </div>
    );
  }

  /* ---- SETTINGS lives in cdos-settings.jsx (full MSB configuration) ---- */

  /* ---- CALCULATOR — Apple-style keypad + FX convert + margin % ---- */
  function Calc({ settings }) {
    const { useEffect } = React;
    const FXC = (typeof CUR !== 'undefined') ? CUR.filter(c => c.code !== 'CAD').map(c => c.code) : CCY.filter(c => c !== 'CAD');
    let _s = {}; try { _s = JSON.parse(localStorage.getItem('cdos_calc_v1')) || {}; } catch (e) {}
    const [mode, setMode] = useState(_s.mode || 'calc');
    const [disp, setDisp] = useState(_s.disp || '0');
    const [acc, setAcc] = useState(_s.acc != null ? _s.acc : null);
    const [op, setOp] = useState(_s.op || null);
    const [waiting, setWaiting] = useState(_s.waiting != null ? _s.waiting : true);
    const [amt, setAmt] = useState(_s.amt || '100'); const [from, setFrom] = useState(_s.from || 'USD'); const [to, setTo] = useState(_s.to || 'CAD');
    const [mIn, setMIn] = useState(_s.mIn || ''); const [mOut, setMOut] = useState(_s.mOut || ''); const [mCcy, setMCcy] = useState(_s.mCcy || 'CAD'); const [mTgt, setMTgt] = useState(_s.mTgt || '');
    const [hist, setHist] = useState(Array.isArray(_s.hist) ? _s.hist : []);
    useEffect(() => { try { localStorage.setItem('cdos_calc_v1', JSON.stringify({ mode, disp, acc, op, waiting, amt, from, to, mIn, mOut, mCcy, mTgt, hist })); } catch (e) {} }, [mode, disp, acc, op, waiting, amt, from, to, mIn, mOut, mCcy, mTgt, hist]);

    const r = crossRate(from, to); const out = (parseFloat(amt) || 0) * r;
    const flagOf = (c) => (typeof BY !== 'undefined' && BY[c] && BY[c].flag) ? BY[c].flag : '';
    const foreign = from !== 'CAD' ? from : (to !== 'CAD' ? to : 'USD');
    const fBuy = window.CDOS.buyUnitCad ? window.CDOS.buyUnitCad(foreign, settings) : crossRate(foreign, 'CAD');
    const fSell = window.CDOS.sellUnitCad ? window.CDOS.sellUnitCad(foreign, settings) : crossRate(foreign, 'CAD');
    const inv = r ? 1 / r : 0;
    const compute = (a, b, o) => o === '+' ? a + b : o === '−' ? a - b : o === '×' ? a * b : o === '÷' ? (b === 0 ? NaN : a / b) : b;
    const fmtR = (v) => { if (!isFinite(v)) return 'Error'; const q = Math.round((v + Number.EPSILON) * 1e8) / 1e8; let str = String(q); if (str.replace('-', '').replace('.', '').length > 12) str = (+q.toPrecision(9)).toString(); return str; };
    const grouped = (s) => { if (s === 'Error') return s; const neg = s[0] === '-'; const t = neg ? s.slice(1) : s; const p = t.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg ? '-' : '') + p.join('.'); };
    const inputDigit = (d) => { if (waiting) { setDisp(d); setWaiting(false); } else { if (disp.replace('-', '').replace('.', '').length >= 12) return; setDisp(disp === '0' ? d : disp + d); } };
    const inputDot = () => { if (waiting) { setDisp('0.'); setWaiting(false); } else if (!disp.includes('.')) setDisp(disp + '.'); };
    const clearAll = () => { setDisp('0'); setAcc(null); setOp(null); setWaiting(true); };
    const clearEntry = () => { setDisp('0'); setWaiting(false); };
    const isAC = disp === '0' && !op && acc === null;
    const negate = () => setDisp(disp === '0' ? '0' : (disp[0] === '-' ? disp.slice(1) : '-' + disp));
    const percent = () => { setDisp(fmtR(parseFloat(disp) / 100)); setWaiting(false); };
    const operate = (next) => { const cur = parseFloat(disp); if (op != null && !waiting) { const rr = compute(acc, cur, op); setAcc(rr); setDisp(fmtR(rr)); } else setAcc(cur); setOp(next); setWaiting(true); };
    const equals = () => { if (op == null) return; const a = acc, b = parseFloat(disp), o = op; const rr = compute(a, b, o); const res = fmtR(rr); setHist(h => [{ x: grouped(fmtR(a)) + ' ' + o + ' ' + grouped(String(b)), r: res }, ...h].slice(0, 20)); setDisp(res); setAcc(null); setOp(null); setWaiting(true); };

    const keyBase = { height: 54, borderRadius: 14, fontSize: 19, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'filter .12s, background .12s', userSelect: 'none' };
    const Num = ({ d, wide }) => <button onClick={() => d === '.' ? inputDot() : inputDigit(d)} style={{ ...keyBase, gridColumn: wide ? 'span 2' : 'auto', justifyContent: wide ? 'flex-start' : 'center', paddingLeft: wide ? 24 : 0, background: 'var(--cd-panel)', color: CD.ink, border: `1px solid ${CD.line}` }}>{d}</button>;
    const Fn = ({ label, on }) => <button onClick={on} style={{ ...keyBase, background: CD.lineSoft, color: CD.ink, border: `1px solid ${CD.line}` }}>{label}</button>;
    const Op = ({ o }) => { const active = op === o && waiting; return <button onClick={() => operate(o)} style={{ ...keyBase, fontSize: 23, background: active ? CD.brass : CD.brassSoft, color: active ? 'var(--cd-on-ink)' : CD.brass, border: `1px solid ${active ? CD.brass : 'transparent'}` }}>{o}</button>; };

    const mi = parseFloat(mIn) || 0, mo = parseFloat(mOut) || 0;
    const profit = +(mi - mo).toFixed(2);
    const marginPct = mi > 0 ? (profit / mi) * 100 : 0;
    const markupPct = mo > 0 ? (profit / mo) * 100 : 0;
    const mFloor = settings && settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const mTarget = settings && settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const mZone = mi > 0 && marginPct >= mTarget ? CD.green : (mi > 0 && marginPct >= mFloor ? CD.amber : (mi > 0 ? CD.flag : CD.faint));

    return (<div style={{ background: CD.panel }} className="h-full flex flex-col">
      <div className="flex" style={{ borderBottom: `1px solid ${CD.line}` }}>
        {[['calc', 'Calculator'], ['fx', 'FX'], ['margin', 'Margin']].map(([m, l]) => <button key={m} onClick={() => setMode(m)} className="flex-1 py-2.5 text-[11px] uppercase tracking-wider" style={{ background: mode === m ? CD.ink : 'var(--cd-chip)', color: mode === m ? 'var(--cd-on-ink)' : CD.mute, borderRight: m !== 'margin' ? `1px solid ${CD.line}` : 0 }}>{l}</button>)}
      </div>

      {mode === 'calc' && (<div className="flex-1 flex flex-col p-3">
        <div className="px-4 pt-4 pb-3 mb-3 text-right" style={{ background: CD.ink, borderRadius: 14, minHeight: 92, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div style={{ color: 'var(--cd-on-ink-soft)', fontFamily: 'Space Mono, monospace', fontSize: 12, minHeight: 16 }}>{acc != null && op ? `${grouped(fmtR(acc))} ${op}` : ''}</div>
          <div style={{ color: 'var(--cd-on-ink)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: grouped(disp).length > 9 ? 28 : 40, lineHeight: 1.05, overflow: 'hidden', whiteSpace: 'nowrap' }}>{grouped(disp)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <Fn label={isAC ? 'AC' : 'C'} on={isAC ? clearAll : clearEntry} />
          <Fn label="±" on={negate} />
          <Fn label="%" on={percent} />
          <Op o="÷" />
          <Num d="7" /><Num d="8" /><Num d="9" /><Op o="×" />
          <Num d="4" /><Num d="5" /><Num d="6" /><Op o="−" />
          <Num d="1" /><Num d="2" /><Num d="3" /><Op o="+" />
          <Num d="0" wide /><Num d="." /><button onClick={equals} style={{ ...keyBase, background: CD.ink, color: 'var(--cd-on-ink)' }}>=</button>
        </div>
        {hist.length > 0 && (<div className="mt-3 flex-1" style={{ borderTop: `1px solid ${CD.line}`, paddingTop: 8, overflow: 'auto', minHeight: 0 }}>
          <div className="flex items-center justify-between mb-1"><span className="text-[10px] uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Previous</span><button onClick={() => setHist([])} className="text-[10px] uppercase tracking-wider" style={{ color: CD.faint }}>Clear</button></div>
          {hist.map((e, i) => <button key={i} onClick={() => { setDisp(e.r); setWaiting(true); }} title="Use this result" className="w-full flex items-center justify-between gap-3 py-1.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 0 }}><span className="text-[11px] truncate" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{e.x}</span><b className="text-[13px] flex-none" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{e.r}</b></button>)}
        </div>)}
      </div>)}

      {mode === 'fx' && (<div className="p-4 flex-1 flex flex-col gap-2">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: CD.mute }}>Amount</div>
        <div className="flex" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, overflow: 'hidden' }}><input value={amt} onChange={e => setAmt(e.target.value)} inputMode="decimal" className="flex-1 min-w-0 px-3 py-2.5 text-xl font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums' }} /><select value={from} onChange={e => setFrom(e.target.value)} className="px-2 outline-none font-semibold text-sm" style={{ borderLeft: `1px solid ${CD.ink}`, background: 'var(--cd-chip)' }}>{[...FXC, 'CAD'].map(c => <option key={c} value={c}>{(flagOf(c) ? flagOf(c) + ' ' : '') + c}</option>)}</select></div>
        <div className="flex items-center justify-center gap-2 py-1"><span style={{ color: CD.faint }}>=</span><button onClick={() => { setFrom(to); setTo(from); }} className="text-[10px] uppercase tracking-wider px-2 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, color: CD.mute }}>swap</button></div>
        <div className="flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}><div className="flex-1 px-3 py-2.5 text-xl font-semibold text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green }}>{num(out)}</div><select value={to} onChange={e => setTo(e.target.value)} className="px-2 outline-none font-semibold text-sm" style={{ borderLeft: `1px solid ${CD.line}`, background: 'var(--cd-chip)' }}>{['CAD', ...FXC].map(c => <option key={c} value={c}>{(flagOf(c) ? flagOf(c) + ' ' : '') + c}</option>)}</select></div>
        <div className="flex gap-1.5 mt-1">{[100, 500, 1000, 5000].map(v => <button key={v} onClick={() => setAmt(String(v))} className="flex-1 py-1.5 text-[11px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-panel)', color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v >= 1000 ? (v / 1000) + 'k' : v}</button>)}</div>
        <div className="mt-2 p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
          <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: CD.mute }}>1 {flagOf(from)} {from}</span><b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(r)} {to}</b></div>
          <div className="flex items-center justify-between text-[12.5px] mt-1"><span style={{ color: CD.mute }}>1 {flagOf(to)} {to}</span><b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(inv)} {from}</b></div>
          <div className="my-2" style={{ borderTop: `1px solid ${CD.lineSoft}` }}></div>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Our desk · {flagOf(foreign)} {foreign} (CAD)</div>
          <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: CD.flag }}>We buy</span><b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fBuy.toFixed(4)}</b></div>
          <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: CD.green }}>We sell</span><b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fSell.toFixed(4)}</b></div>
        </div>
        <div className="mt-auto pt-2 text-[11px] flex items-center gap-1.5" style={{ color: CD.faint }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: CD.green, display: 'inline-block' }}></span> Spot rate · mid-market · updated hourly</div>
      </div>)}

      {mode === 'margin' && (<div className="p-4 flex-1 flex flex-col gap-3">
        <div className="flex items-center justify-between"><span className="text-[11px] uppercase tracking-wider" style={{ color: CD.mute }}>Quick margin check</span><select value={mCcy} onChange={e => setMCcy(e.target.value)} className="text-[12px] font-semibold px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-chip)' }}>{['CAD', ...FXC].map(c => <option key={c} value={c}>{(flagOf(c) ? flagOf(c) + ' ' : '') + c}</option>)}</select></div>
        <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>We take in ({mCcy})</div><input value={mIn} onChange={e => setMIn(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full px-3 py-2.5 text-lg font-semibold text-right outline-none" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, fontVariantNumeric: 'tabular-nums' }} /></label>
        <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>We pay out / cost ({mCcy})</div><input value={mOut} onChange={e => setMOut(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full px-3 py-2.5 text-lg font-semibold text-right outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, fontVariantNumeric: 'tabular-nums' }} /></label>
        <div className="p-3 mt-1" style={{ background: 'var(--cd-panel)', border: `1px solid ${mZone}`, borderRadius: 10 }}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Margin</span>
            <span className="text-xl font-bold" style={{ color: mZone, fontVariantNumeric: 'tabular-nums' }}>{marginPct.toFixed(2)}%</span>
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[12px]"><span style={{ color: CD.mute }}>Profit</span><b style={{ color: mZone, fontVariantNumeric: 'tabular-nums' }}>{fmt(profit, mCcy)}</b></div>
          <div className="flex items-center justify-between text-[12px]"><span style={{ color: CD.mute }}>Markup on cost</span><b style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{markupPct.toFixed(2)}%</b></div>
        </div>
        <div className="text-[11px]" style={{ color: CD.faint }}>Floor {mFloor}% · target {mTarget}% — same thresholds as the deal screen.</div>
        <div className="text-[10px] uppercase tracking-wider mt-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Set pay-out for a target margin</div>
        <div className="flex flex-wrap gap-1.5">{[0.2, 0.5, 1, 3, 5, 10].map(p => { const on = Math.abs(marginPct - p) < 0.005; return <button key={p} onClick={() => { const v = parseFloat(mIn) || 0; if (v > 0) setMOut(fmtR(+(v * (1 - p / 100)).toFixed(2))); }} className="flex-1 py-1.5 text-[12px] font-semibold" style={{ minWidth: 52, border: `1px solid ${on ? CD.ink : CD.line}`, borderRadius: 7, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.ink }}>{p}%</button>; })}</div>
        <div className="flex gap-1.5 mt-1">
          <div className="flex items-center flex-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, overflow: 'hidden', background: 'var(--cd-panel)' }}><input value={mTgt} onChange={e => setMTgt(e.target.value)} inputMode="decimal" placeholder="Custom" className="flex-1 min-w-0 px-2.5 py-1.5 text-[12px] outline-none text-right" style={{ fontVariantNumeric: 'tabular-nums' }} /><span className="px-2 text-[12px]" style={{ color: CD.faint }}>%</span></div>
          <button onClick={() => { const v = parseFloat(mIn) || 0; const p = parseFloat(mTgt); if (v > 0 && !isNaN(p)) setMOut(fmtR(+(v * (1 - p / 100)).toFixed(2))); }} className="px-3 py-1.5 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 7 }}>Apply</button>
        </div>
      </div>)}
    </div>);
  }

  /* ---- RECEIPT ---- */
  function ReceiptModal({ row, onClose, settings }) {
    const s = settings || {};
    const head = s.receiptHeader || 'CurrencyDesk — Exchange Receipt';
    return (<div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="overflow-hidden cd-paper-island" style={{ width: 340, background: CD.panel, border: `1px solid ${CD.ink}` }}>
        <div id="rcpt" className="p-5" style={{ fontFamily: 'Space Mono, ui-monospace, monospace' }}>
          <div className="text-center">
            {s.showLogoOnReceipt && s.logo && <img src={s.logo} alt="" style={{ maxHeight: 38, margin: '0 auto 8px', objectFit: 'contain' }} />}
            <div className="font-semibold" style={{ color: CD.ink }}>{head}</div>
            <div className="text-[11px]" style={{ color: CD.mute }}>Registered MSB{s.showMsbOnReceipt && s.msbNumber ? ` · ${s.msbNumber}` : ''}</div>
            {(s.bizPhone || s.bizCity) && <div className="text-[10px] mt-0.5" style={{ color: CD.faint }}>{[s.bizCity, s.bizPhone].filter(Boolean).join(' · ')}</div>}
          </div>
          <div className="my-3" style={{ borderTop: `1px dashed ${CD.line}` }} />
          <Line k="Date" v={row.date} /><Line k="Customer" v={row.customer || '—'} /><Line k="Type" v={row.type} /><Line k="Teller" v={row.teller} />
          <div className="my-3" style={{ borderTop: `1px dashed ${CD.line}` }} />
          <Line k="Pay-in" v={`${num(row.inAmt)} ${row.inCcy}`} /><Line k="Rate" v={row.rate} /><Line k="Pay-out" v={`${num(row.outAmt)} ${row.outCcy}`} /><Line k="Fee" v={fmt(row.fee, 'CAD')} />
          {row.type !== 'Cheque Cashing' && row.side && <Line k="Pricing" v={row.side === 'buy' ? `We bought ${row.inCcy}` : row.side === 'sell' ? `We sold ${row.outCcy}` : 'Cross'} />}
          {row.quoteRef && <Line k="Quote" v={`${row.quoteRef}${row.lockedUntil ? ` · held to ${row.lockedUntil}` : ''}`} />}
          <div className="my-3" style={{ borderTop: `1px dashed ${CD.line}` }} />
          <div className="text-center text-[11px]" style={{ color: CD.mute }}>{s.receiptFooter || 'Thank you — keep for your records'}</div>
          {s.receiptDisclaimer && <div className="text-center text-[9px] mt-2" style={{ color: CD.faint }}>{s.receiptDisclaimer}</div>}
        </div>
        <div className="flex gap-2 p-3" style={{ borderTop: `1px solid ${CD.line}` }}>
          <button onClick={() => window.print()} className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium text-white" style={{ background: CD.ink }}><Ic n="printer" s={14} /> Print</button>
          <button onClick={onClose} className="px-4 py-2 text-sm" style={{ border: `1px solid ${CD.line}` }}>Close</button>
        </div>
      </div></div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    computeFlags, computeAlerts, Audit, Calc, ReceiptModal
  });
})();
