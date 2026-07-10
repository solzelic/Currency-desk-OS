/* ============================================================
   CurrencyDesk OS — Cash on Hand · Vault
   The treasury pillar. ONE NUMBER: the vault never stores a balance —
   every position is DERIVED from the shared window.CDOS.position(),
   the same pure function the Till's "expected" calls, off the same
   posted records. Stock and flow physically cannot disagree.
     • Position   — derived inventory, CAD valuation, FX exposure,
                    concentration, reorder bands.
     • Shifts     — per-teller float accountability. Assigning a float
                    is a LOCATION/accountability record, not a stock
                    change (total holdings are invariant across it).
                    Blind-count enforced at settle. Active float
                    currencies are a setting.
     • Orders     — place a wholesale order (optional, on-order), then
                    mark it received; receiving posts to inventory and
                    re-weights cost basis. Low stock raises a notification.
     • P&L        — realized profit on real (derived) cost basis vs the
                    old mid-spread estimate, with the gap shown.
   The vault owns only accountability records (shifts). Holdings,
   baseline and receipts live in the shared layer; the vault reads them.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, crossRate, perCadLive, TODAY, STAFF } = window.CDOS;

  const VCCYS = ['CAD', 'USD', 'EUR', 'GBP', 'INR', 'PHP', 'CNY', 'MXN', 'AED'];
  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  // CAD value of 1 unit at the live board (valuation only — never stock)
  const cadPer = (c) => c === 'CAD' ? 1 : (crossRate(c, 'CAD') || 0);
  const cadVal = (units, c) => (+units || 0) * cadPer(c);
  // derived position straight from the shared source of truth
  const posOf = (c, rows, baseline, receipts) => window.CDOS.position(c, rows, baseline, receipts);
  const heldOf = (c, rows, baseline, receipts) => window.CDOS.holdings(c, rows, baseline, receipts);

  const SKEY = 'cdos_vault_shifts';
  const DEFAULT_FC = ['CAD', 'USD', 'EUR', 'GBP'];
  const floatCcysOf = (settings) => (settings && Array.isArray(settings.floatCcys) && settings.floatCcys.length) ? settings.floatCcys : DEFAULT_FC;

  /* reorder bands — min (reorder point) / target / max in UNITS */
  const BANDS = {
    CAD: { min: 120000, target: 250000, max: 400000 },
    USD: { min: 40000, target: 90000, max: 150000 },
    EUR: { min: 18000, target: 35000, max: 60000 },
    GBP: { min: 8000, target: 16000, max: 28000 },
    INR: { min: 2500000, target: 4500000, max: 7000000 },
    PHP: { min: 1200000, target: 2000000, max: 3200000 },
    CNY: { min: 120000, target: 240000, max: 400000 },
    MXN: { min: 200000, target: 400000, max: 650000 },
    AED: { min: 35000, target: 70000, max: 120000 },
  };

  /* seed ~3 weeks of settled shifts so "variance by person" has a track record.
     Shifts are accountability records only — they never touch holdings. */
  function seedShifts() {
    try { const ex = JSON.parse(localStorage.getItem(SKEY) || 'null'); if (ex && ex.length) return ex; } catch (e) {}
    const tellers = STAFF.filter(s => s.role !== 'Owner').map(s => s.name);
    const out = [];
    const rnd = (seed) => ((Math.sin(seed * 91.7) * 43758.5) % 1 + 1) % 1;
    const start = new Date(TODAY); start.setDate(start.getDate() - 1);
    let id = 1;
    for (let d = 0; d < 16; d++) {
      const day = new Date(start); day.setDate(start.getDate() - d);
      if (day.getDay() === 0) continue;
      const dk = day.toISOString().slice(0, 10);
      const who = tellers[(d + Math.floor(rnd(d) * 3)) % tellers.length];
      const open = { CAD: 5000, USD: 2000 };
      const off = rnd(d * 7) < 0.32 ? Math.round((rnd(d * 13) - 0.5) * 24) : 0;
      const counted = { CAD: 5000 + off, USD: 2000 };
      out.push({ id: id++, teller: who, date: dk, openedAt: dk + ' 09:02', openedBy: 'J. Masri', opening: open, status: 'settled', counted, settledAt: dk + ' 17:36', settledBy: who, varCad: off, blind: true });
    }
    try { localStorage.setItem(SKEY, JSON.stringify(out)); } catch (e) {}
    return out;
  }

  /* floors: the owner's Settings → Vault floors override the built-in reorder bands.
     CAD uses the base-currency reserve floor; others use per-currency floors. */
  const floorOf = (c, settings) => {
    if (settings) {
      if (c === 'CAD' && settings.vaultReserveCad != null && settings.vaultReserveCad !== '' && +settings.vaultReserveCad > 0) return +settings.vaultReserveCad;
      const f = settings.vaultFloors && settings.vaultFloors[c];
      if (f != null && f !== '' && +f > 0) return +f;
    }
    return BANDS[c] ? BANDS[c].min : 0;
  };
  function bandStatus(c, units, settings) {
    const b = BANDS[c] || {};
    const min = floorOf(c, settings);
    if (!min && !b.max) return { tone: CD.mute, label: 'no band', level: 'ok' };
    if (min && units < min) return { tone: CD.flag, label: 'below reorder', level: 'low' };
    if (b.max && units > b.max) return { tone: CD.amber, label: 'over-stocked', level: 'high' };
    return { tone: CD.green, label: 'in band', level: 'ok' };
  }

  /* ===================== shared bits ===================== */
  function Stat({ label, value, sub, tone, big }) {
    return (<div style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12, padding: big ? '14px 16px' : '12px 14px' }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 19, fontWeight: 800, color: tone || CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, marginTop: 3 }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }
  // simple, legible stock status — replaces the busy reorder-band bar
  function StatusPill({ level }) {
    const cfg = level === 'low' ? { bg: CD.flagSoft, fg: CD.flag, t: 'Low stock' } : level === 'high' ? { bg: CD.amberSoft, fg: CD.amber, t: 'Overstocked' } : { bg: CD.greenSoft, fg: CD.green, t: 'Healthy' };
    return <span className="inline-flex items-center gap-1.5 px-2 py-1" style={{ background: cfg.bg, color: cfg.fg, borderRadius: 999, fontSize: 11, fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.fg }}></span>{cfg.t}</span>;
  }
  function ConcBar({ parts, total }) {
    return (<div className="flex" style={{ height: 14, borderRadius: 5, overflow: 'hidden', border: `1px solid ${CD.line}` }}>
      {parts.map((p, i) => { const w = total ? (p.mkt / total) * 100 : 0; if (w < 0.4) return null;
        const shade = `hsl(${(i * 47) % 360} 8% ${22 + (i % 5) * 11}%)`;
        return <div key={p.c} title={`${p.c} · ${w.toFixed(1)}%`} style={{ width: w + '%', background: p.c === 'CAD' ? CD.ink : shade }}></div>; })}
    </div>);
  }

  /* ===================== POSITION (fully derived) ===================== */
  function Position({ rows, baseline, receipts, settings }) {
    const atCost = !!(settings && settings.vaultBasis === 'cost');   // Settings → Vault · valuation basis
    const rowsAll = VCCYS.map(c => {
      const p = posOf(c, rows, baseline, receipts);
      const mkt = cadVal(p.units, c);
      const basis = p.units * p.cost;
      return { c, units: p.units, cost: p.cost, mkt, basis, upl: mkt - basis, st: bandStatus(c, p.units, settings) };
    });
    const rows2 = rowsAll.filter(r => r.units > 0.5).sort((a, b) => b.mkt - a.mkt);
    const total = rows2.reduce((s, r) => s + r.mkt, 0);
    const totalBasis = rows2.reduce((s, r) => s + r.basis, 0);
    const fxExposure = rows2.filter(r => r.c !== 'CAD').reduce((s, r) => s + r.mkt, 0);
    const top = rows2[0] || { c: '—', mkt: 0 };
    const lowN = rows2.filter(r => r.st.level === 'low').length;
    const totalUpl = total - totalBasis;

    return (<div className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <Stat big label={atCost ? 'Total on hand · at cost' : 'Total on hand · CAD'} value={fmt(atCost ? totalBasis : total, 'CAD')} sub={`${atCost ? 'cost basis' : 'market value'} · ${rows2.length} currencies`} />
        <Stat label="FX exposure" value={`${total ? Math.round(fxExposure / total * 100) : 0}%`} sub={`${fmt(fxExposure, 'CAD')} not in CAD`} tone={fxExposure / total > 0.7 ? CD.amber : CD.ink} />
        <Stat label="Top concentration" value={`${total ? Math.round(top.mkt / total * 100) : 0}%`} sub={`${top.c} ${flagOf(top.c)}`} />
        <Stat label="Unrealized P&L" value={(totalUpl >= 0 ? '+' : '') + fmt(totalUpl, 'CAD')} sub="market vs cost basis" tone={totalUpl >= 0 ? CD.green : CD.flag} />
      </div>

      <div className="p-3 mb-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Concentration by value</span>
        </div>
        <ConcBar parts={rows2} total={total} />
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
          {rows2.slice(0, 6).map(r => <span key={r.c} className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{flagOf(r.c)} {r.c} {total ? Math.round(r.mkt / total * 100) : 0}%</span>)}
        </div>
      </div>

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">On hand</th>
            <th className="px-3 py-2 text-right">Avg cost</th><th className="px-3 py-2 text-right">{atCost ? 'At cost · CAD' : 'Market · CAD'}</th>
            <th className="px-3 py-2 text-right">Unrlzd P&L</th><th className="px-3 py-2 text-right" style={{ width: 130 }}>Status</th>
          </tr></thead>
          <tbody>{rows2.map(r => (<tr key={r.c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2.5 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(r.c)}</span> {r.c}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(r.units))}</td>
            <td className="px-3 py-2.5 text-right text-[12px]" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{r.c === 'CAD' ? '—' : r.cost.toFixed(r.cost < 0.1 ? 5 : 4)}</td>
            <td className="px-3 py-2.5 text-right font-semibold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(atCost ? r.basis : r.mkt))}</td>
            <td className="px-3 py-2.5 text-right text-[12px] font-semibold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: r.c === 'CAD' ? CD.faint : (r.upl >= 0 ? CD.green : CD.flag) }}>{r.c === 'CAD' ? '—' : (r.upl >= 0 ? '+' : '') + num(Math.round(r.upl))}</td>
            <td className="px-3 py-2.5 text-right"><StatusPill level={r.st.level} /></td>
          </tr>))}</tbody>
          <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
            <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total · CAD</td><td></td><td></td>
            <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(atCost ? totalBasis : total))}</td>
            <td className="px-3 py-2 text-right font-bold text-[12px]" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: totalUpl >= 0 ? CD.green : CD.flag }}>{(totalUpl >= 0 ? '+' : '') + num(Math.round(totalUpl))}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>On hand is derived live — opening baseline + received orders + posted ledger legs (voids excluded) — the same figure the Till reconciles its physical count against. {atCost ? 'Valued at weighted-average cost actually paid (Settings → Vault).' : 'Market value is live; cost basis is the weighted average actually paid.'} Reorder floors follow Settings → Vault.</p>
    </div>);
  }

  /* ===================== SHIFTS (per-teller float + blind count) ===================== */
  function Shifts({ rows, baseline, receipts, me, log, shifts, setShifts, settings, setSettings }) {
    const [assigning, setAssigning] = useState(false);
    const [settling, setSettling] = useState(null);
    const fc = floatCcysOf(settings);
    const tellers = STAFF.filter(s => s.role !== 'Owner');
    const open = shifts.filter(s => s.status === 'open');
    const settled = shifts.filter(s => s.status === 'settled').sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''));

    const byPerson = useMemo(() => {
      const m = {};
      settled.forEach(s => { const k = s.teller; (m[k] = m[k] || { teller: k, shifts: 0, net: 0, abs: 0 }); m[k].shifts++; m[k].net += (+s.varCad || 0); m[k].abs += Math.abs(+s.varCad || 0); });
      return Object.values(m).sort((a, b) => a.abs - b.abs);
    }, [shifts]);

    // expected for a shift = the float handed over + that teller's net ledger
    // movement during the shift. Pure read of posted records — no stock mutation.
    const expectedFor = (shift, c) => {
      const opening = (shift.opening && shift.opening[c]) || 0;
      const inSum = rows.filter(r => r.status !== 'void' && r.teller === shift.teller && r.date === shift.date && r.inCcy === c).reduce((s, r) => s + (+r.inAmt || 0), 0);
      const outSum = rows.filter(r => r.status !== 'void' && r.teller === shift.teller && r.date === shift.date && r.outCcy === c).reduce((s, r) => s + (+r.outAmt || 0), 0);
      return opening + inSum - outSum;
    };
    const availOf = (c) => heldOf(c, rows, baseline, receipts);

    // assigning a float is accountability + location only: total holdings are
    // INVARIANT across it (the cash was already in the pool). No setVault here.
    const doAssign = (teller, opening) => {
      const sh = { id: Date.now(), teller, date: TODAY, openedAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), openedBy: me.name, opening: { ...opening }, status: 'open', blind: true };
      setShifts(s => [sh, ...s]);
      log && log('Shift float assigned', `${teller} · ${fmt(fc.reduce((t, c) => t + cadVal(+opening[c] || 0, c), 0), 'CAD')} on the desk (accountability — holdings unchanged)`);
      setAssigning(false);
    };
    const doSettle = (shift, counted) => {
      let varCad = 0;
      Object.keys(shift.opening || {}).forEach(c => { varCad += cadVal((+counted[c] || 0) - expectedFor(shift, c), c); });
      setShifts(list => list.map(s => s.id === shift.id ? { ...s, status: 'settled', counted: { ...counted }, varCad: Math.round(varCad), settledAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), settledBy: me.name } : s));
      log && log('Shift settled', `${shift.teller} · ${Math.abs(varCad) < 0.5 ? 'balanced' : (varCad > 0 ? '+' : '') + fmt(varCad, 'CAD')} variance`);
      setSettling(null);
    };
    const toggleFc = (c) => {
      if (c === 'CAD') return; // base currency always active
      const cur = fc.slice();
      const next = cur.includes(c) ? cur.filter(x => x !== c) : [...cur, c];
      setSettings(s => ({ ...s, floatCcys: next.length ? next : ['CAD'] }));
    };

    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Shift floats · per-teller accountability</div><div className="text-[11px]" style={{ color: CD.mute }}>Hand a teller their working float, settle at close, variance lands on the person. Holdings never move — this is who's responsible, not a second balance.</div></div>
        <button onClick={() => setAssigning(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="userplus" s={15} c="var(--cd-on-ink)" /> Assign float</button>
      </div>

      {/* active float currencies — a setting (Tel Aviv shop sets its own) */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Active float currencies</span>
        {VCCYS.map(c => { const on = fc.includes(c); const locked = c === 'CAD'; return (
          <button key={c} onClick={() => toggleFc(c)} disabled={locked} title={locked ? 'Base currency — always active' : (on ? 'Active' : 'Inactive')} className="px-2 py-1 text-[11px]" style={{ borderRadius: 7, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.faint, fontFamily: 'Space Mono, monospace', cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.85 : 1 }}>{c}</button>); })}
      </div>

      {open.length > 0 && <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>On the floor now</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {open.map(s => { const floatCad = Object.keys(s.opening || {}).reduce((t, c) => t + cadVal(s.opening[c] || 0, c), 0); return (
            <div key={s.id} className="p-3 flex items-center justify-between" style={{ background: CD.panel, border: `1px solid ${CD.ink}`, borderRadius: 12 }}>
              <div>
                <div className="flex items-center gap-2"><span className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: '50%', background: CD.ink, color: 'var(--cd-on-ink)', fontFamily: 'Space Mono', fontSize: 11 }}>{s.teller.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2)}</span><div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{s.teller}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>since {(s.openedAt || '').slice(-5)}</div></div></div>
                <div className="text-[11px] mt-1.5" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>float {fmt(floatCad, 'CAD')}</div>
              </div>
              <button onClick={() => setSettling(s)} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="checkcircle" s={14} /> Settle</button>
            </div>); })}
        </div>
      </div>}

      <div className="p-3 mb-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
        <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Variance by person · settled shifts</div>
        <div className="grid sm:grid-cols-3 gap-2">
          {byPerson.map(p => (<div key={p.teller} className="flex items-center justify-between px-3 py-2" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
            <div><div className="text-[12.5px] font-medium" style={{ color: CD.ink }}>{p.teller}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>{p.shifts} shift{p.shifts === 1 ? '' : 's'}</div></div>
            <div className="text-right"><div className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono, monospace', color: p.abs < 1 ? CD.green : p.abs < 30 ? CD.amber : CD.flag }}>{p.net >= 0 ? '+' : ''}{num(p.net)}</div><div className="text-[9.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>±{num(p.abs)} abs</div></div>
          </div>))}
          {!byPerson.length && <div className="text-[12px] col-span-3 text-center py-3" style={{ color: CD.faint }}>No settled shifts yet.</div>}
        </div>
      </div>

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Date</th><th className="px-3 py-2">Teller</th><th className="px-3 py-2 text-right">Float · CAD</th><th className="px-3 py-2 text-right">Variance</th><th className="px-3 py-2">Count</th>
          </tr></thead>
          <tbody>{settled.slice(0, 30).map(s => { const floatCad = Object.keys(s.opening || {}).reduce((t, c) => t + cadVal(s.opening[c] || 0, c), 0); const off = Math.abs(+s.varCad || 0) >= 0.5; return (
            <tr key={s.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <td className="px-3 py-2 font-medium" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{s.date}{s.date === TODAY && <span className="ml-2 text-[9px] px-1.5 py-0.5" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 4, fontFamily: 'Space Mono' }}>TODAY</span>}</td>
              <td className="px-3 py-2" style={{ color: CD.ink }}>{s.teller}</td>
              <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono, monospace', color: CD.mute }}>{num(Math.round(floatCad))}</td>
              <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono, monospace', color: off ? (s.varCad > 0 ? CD.amber : CD.flag) : CD.green }}>{off ? (s.varCad > 0 ? '+' : '') + num(s.varCad) : '✓ 0'}</td>
              <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 4, color: CD.mute, fontFamily: 'Space Mono' }}>{s.blind ? 'blind' : 'open'}</span></td>
            </tr>); })}</tbody>
        </table>
      </div>

      {assigning && <AssignModal tellers={tellers} fc={fc} availOf={availOf} onClose={() => setAssigning(false)} onAssign={doAssign} />}
      {settling && <SettleModal shift={settling} expectedFor={expectedFor} onClose={() => setSettling(null)} onSettle={doSettle} />}
    </div>);
  }

  function AssignModal({ tellers, fc, availOf, onClose, onAssign }) {
    const [teller, setTeller] = useState(tellers[0] ? tellers[0].name : '');
    const [opening, setOpening] = useState(() => Object.fromEntries(fc.map(c => [c, c === 'CAD' ? 5000 : c === 'USD' ? 2000 : 0])));
    const floatCad = fc.reduce((t, c) => t + cadVal(+opening[c] || 0, c), 0);
    const short = fc.filter(c => (+opening[c] || 0) > availOf(c));
    return (<Modal onClose={onClose} icon="userplus" title="Assign a shift float" sub="Hands existing pool cash to a named teller for the shift. Accountability only — total holdings don't change.">
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Teller</div>
        <div className="flex flex-wrap gap-1.5">{tellers.map(t => <button key={t.name} onClick={() => setTeller(t.name)} className="px-3 py-1.5 text-[12px]" style={{ borderRadius: 8, border: `1px solid ${teller === t.name ? CD.ink : CD.line}`, background: teller === t.name ? CD.ink : 'transparent', color: teller === t.name ? 'var(--cd-on-ink)' : CD.mute }}>{t.name}</button>)}</div>
      </div>
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Opening float</div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {fc.map(c => (<div key={c} className="flex items-center" style={{ border: `1px solid ${short.includes(c) ? CD.flag : CD.line}`, borderRadius: 9 }}>
          <span className="px-2.5 text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono', borderRight: `1px solid ${CD.line}` }}>{flagOf(c)} {c}</span>
          <input type="number" value={opening[c] ?? ''} onChange={e => setOpening(o => ({ ...o, [c]: e.target.value }))} placeholder="0" className="flex-1 min-w-0 px-2.5 py-2 text-right outline-none" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
        </div>))}
      </div>
      {short.length > 0 && <div className="text-[11px] px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>Pool is short on {short.join(', ')} — reduce the float or replenish first.</div>}
      <div className="flex items-center justify-between pt-1">
        <div className="text-[12px]" style={{ color: CD.mute }}>Float value <b style={{ color: CD.ink, fontFamily: 'Space Mono' }}>{fmt(floatCad, 'CAD')}</b></div>
        <button disabled={!teller || short.length > 0 || floatCad <= 0} onClick={() => onAssign(teller, opening)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: (!teller || short.length || floatCad <= 0) ? CD.faint : CD.ink, borderRadius: 9, cursor: (!teller || short.length || floatCad <= 0) ? 'not-allowed' : 'pointer' }}><Ic n="arrowright" s={15} c="var(--cd-on-ink)" /> Assign to desk</button>
      </div>
    </Modal>);
  }

  /* settle modal — BLIND COUNT: expected/variance hidden until the count is locked */
  function SettleModal({ shift, expectedFor, onClose, onSettle }) {
    const ccys = Object.keys(shift.opening || {});
    const [counted, setCounted] = useState(() => Object.fromEntries(ccys.map(c => [c, ''])));
    const [locked, setLocked] = useState(false);
    const anyEntered = ccys.some(c => counted[c] !== '' && counted[c] != null);
    const varCad = ccys.reduce((t, c) => t + cadVal((+counted[c] || 0) - expectedFor(shift, c), c), 0);
    const off = Math.abs(varCad) >= 0.5;
    return (<Modal onClose={onClose} icon="checkcircle" title={`Settle ${shift.teller}'s drawer`} sub="Blind count — enter what you physically counted, then lock to reveal the variance.">
      <div className="grid grid-cols-2 gap-2 mb-3">
        {ccys.map(c => { const exp = expectedFor(shift, c); const cnt = +counted[c] || 0; const d = cnt - exp; return (
          <div key={c} style={{ border: `1px solid ${CD.line}`, borderRadius: 9, padding: '8px 10px' }}>
            <div className="flex items-center justify-between mb-1"><span className="text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono' }}>{flagOf(c)} {c}</span>
              {locked ? <span className="text-[10.5px]" style={{ fontFamily: 'Space Mono', color: Math.abs(d) < 0.005 ? CD.green : (d > 0 ? CD.amber : CD.flag) }}>{Math.abs(d) < 0.005 ? '✓' : (d > 0 ? '+' : '') + num(d)}</span> : <span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>expected hidden</span>}
            </div>
            <input type="number" value={counted[c] ?? ''} disabled={locked} onChange={e => setCounted(o => ({ ...o, [c]: e.target.value }))} placeholder="count…" className="w-full px-2 py-1.5 text-right outline-none" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 7, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', background: locked ? '#f7f6f3' : 'var(--cd-panel)' }} />
            {locked && <div className="text-[10px] mt-1 text-right" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>exp {num(exp)}</div>}
          </div>); })}
      </div>
      {!locked ? (
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px]" style={{ color: CD.faint }}>You can't see the expected figures until you lock.</span>
          <button disabled={!anyEntered} onClick={() => setLocked(true)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: anyEntered ? CD.ink : CD.faint, borderRadius: 9, cursor: anyEntered ? 'pointer' : 'not-allowed' }}><Ic n="lock" s={14} c="var(--cd-on-ink)" /> Lock count</button>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between px-3 py-2.5 mb-3" style={{ background: off ? CD.flagSoft : CD.greenSoft, borderRadius: 10 }}>
            <span className="text-[12px] font-medium" style={{ color: off ? CD.flag : '#1c5c3a' }}>{off ? 'Drawer is off' : 'Drawer balanced'}</span>
            <span className="text-[16px] font-bold" style={{ fontFamily: 'Space Mono', color: off ? CD.flag : '#1c5c3a' }}>{off ? (varCad > 0 ? '+' : '') + fmt(varCad, 'CAD') : '✓ 0.00'}</span>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setLocked(false)} className="text-[12px] px-3 py-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>← Recount</button>
            <button onClick={() => onSettle(shift, counted)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="checkcircle" s={15} c="var(--cd-on-ink)" /> Settle on {shift.teller.split(' ').slice(-1)[0]}</button>
          </div>
        </div>
      )}
    </Modal>);
  }

  /* ===================== ORDERS (on order → received) ===================== */
  // Creating an order is the header's job (one entry point). Low balances are
  // notifications, not cards here. This tab just lists orders: what's on the way,
  // and what's landed.
  function Orders({ receipts, pending, onOrder, onCancel }) {
    const received = (receipts || []).filter(o => o.status === 'received').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return (<div className="p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold" style={{ color: CD.ink }}>Orders</div>
        <div className="text-[11px]" style={{ color: CD.mute }}>Place an order with <b>Order</b> up top; mark it received when the cash lands — that's what lifts inventory and re-weights cost basis. Low balances arrive as notifications.</div>
      </div>

      {/* on order — pending, awaiting delivery */}
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>On order · awaiting delivery</div>
      {pending.length > 0 ? <div className="grid sm:grid-cols-2 gap-2 mb-4">
        {pending.map(o => (<div key={o.id} className="p-3 flex items-center justify-between" style={{ background: CD.panel, border: `1px dashed ${CD.amber}`, borderRadius: 12 }}>
          <div>
            <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{flagOf(o.ccy)} {num(o.units)} {o.ccy}</div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{o.supplier} · placed {o.date}</div>
          </div>
          <div className="flex items-center gap-1.5 flex-none">
            <button onClick={() => onCancel(o.id)} title="Cancel this order" className="px-2.5 py-2 text-[12px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute }}>Cancel</button>
            <button onClick={() => onOrder({ order: o })} className="px-3 py-2 text-[12px] font-semibold text-white flex items-center gap-1.5" style={{ background: CD.green, borderRadius: 8 }}><Ic n="checkcircle" s={14} c="var(--cd-on-ink)" /> Mark received</button>
          </div>
        </div>))}
      </div> : <div className="text-[12px] px-3 py-3 mb-4" style={{ background: 'var(--cd-chip)', color: CD.mute, borderRadius: 10 }}>No open orders. Place one with the <b>Order</b> button above.</div>}

      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Received</div>
      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Ref</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">Units</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">CAD paid</th><th className="px-3 py-2">Supplier</th>
          </tr></thead>
          <tbody>{received.map(o => (<tr key={o.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2 font-medium" style={{ color: CD.ink, fontFamily: 'Space Mono', fontSize: 11.5 }}>{o.ref}</td>
            <td className="px-3 py-2" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{o.date}</td>
            <td className="px-3 py-2" style={{ color: CD.ink }}>{flagOf(o.ccy)} {o.ccy}</td>
            <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(o.units)}</td>
            <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{(o.unitCost || 0).toFixed((o.unitCost || 0) < 0.1 ? 5 : 4)}</td>
            <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(o.costCad || 0))}</td>
            <td className="px-3 py-2 text-[11.5px]" style={{ color: CD.mute }}>{o.supplier}</td>
          </tr>))}
          {!received.length && <tr><td colSpan={7} className="px-3 py-5 text-center text-[12px]" style={{ color: CD.faint }}>No received orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>);
  }

  /* one modal, two outcomes: Place order (pending) or Order received (posts).
     Placing is optional — you can record a received order directly. */
  function OrderModal({ init, onClose, onPlace, onReceive }) {
    const src = (init && init.order) || null;     // receiving an existing pending order
    const receiveOnly = !!src;
    const [ccy, setCcy] = useState((src && src.ccy) || (init && init.ccy) || 'USD');
    const [units, setUnits] = useState((src && src.units) ? String(Math.round(src.units)) : (init && init.units) ? String(Math.round(init.units)) : '');
    const [costCad, setCostCad] = useState('');
    const [supplier, setSupplier] = useState((src && src.supplier) || 'Bank of Montreal — Wholesale Notes');
    const [receiveNow, setReceiveNow] = useState(false);   // "cash already in hand" — opt in
    const [done, setDone] = useState(false);               // green-confirm latch (also blocks double-click)
    const u = +units || 0, cc = +costCad || 0;
    const unitCost = u ? cc / u : 0;
    const mkt = cadPer(ccy);
    const suggestCost = u ? Math.round(u * mkt * 0.999) : 0;
    // ONE action at a time: placing (default) OR receiving. Never two adjacent buttons.
    const receiving = receiveOnly || receiveNow;
    const ready = receiving ? (u > 0 && cc > 0) : (u > 0);
    // press → flash green + lock, then commit a beat later so the confirm is seen
    const fire = () => {
      if (done || !ready) return;
      setDone(true);
      setTimeout(() => {
        if (receiving) onReceive({ id: src ? src.id : null, ccy, units: u, costCad: cc, supplier });
        else onPlace({ ccy, units: u, supplier });
      }, 480);
    };
    return (<Modal onClose={done ? undefined : onClose} icon={receiving ? 'checkcircle' : 'plus'} title={receiveOnly ? 'Receive order' : 'New banknote order'} sub={receiveOnly ? 'Confirm what arrived and what you paid — this posts the cash into inventory.' : 'Record a wholesale order. You’ll mark it received when the cash arrives.'}>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Currency</div>
        <div className="flex flex-wrap gap-1.5">{VCCYS.filter(c => c !== 'CAD').map(c => <button key={c} disabled={receiveOnly} onClick={() => setCcy(c)} className="px-2.5 py-1.5 text-[12px]" style={{ borderRadius: 8, border: `1px solid ${ccy === c ? CD.ink : CD.line}`, background: ccy === c ? CD.ink : 'transparent', color: ccy === c ? 'var(--cd-on-ink)' : CD.mute, fontFamily: 'Space Mono', cursor: receiveOnly ? 'default' : 'pointer', opacity: receiveOnly && ccy !== c ? 0.4 : 1 }}>{flagOf(c)} {c}</button>)}</div>
      </div>
      <div className={receiving ? 'grid grid-cols-2 gap-2 mb-3' : 'mb-3'}>
        <div>
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Units</div>
          <input type="number" autoFocus={!receiveOnly} value={units} onChange={e => setUnits(e.target.value)} placeholder="0" className="w-full px-3 py-2 text-right outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
        </div>
        {receiving && <div>
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>CAD paid</div>
          <input type="number" autoFocus={receiveOnly} value={costCad} onChange={e => setCostCad(e.target.value)} placeholder={suggestCost ? String(suggestCost) : '0'} className="w-full px-3 py-2 text-right outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
        </div>}
      </div>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Supplier</div>
        <input value={supplier} onChange={e => setSupplier(e.target.value)} className="w-full px-3 py-2 outline-none text-[13px]" style={{ border: `1px solid ${CD.line}`, borderRadius: 9 }} />
      </div>
      {receiving && cc > 0 && <div className="flex items-center justify-between px-3 py-2 mb-3" style={{ background: 'var(--cd-chip)', borderRadius: 9 }}>
        <span className="text-[11.5px]" style={{ color: CD.mute }}>Effective unit cost</span>
        <span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink }}>{unitCost ? unitCost.toFixed(unitCost < 0.1 ? 5 : 4) : '—'} {unitCost ? <span className="text-[10px] font-normal" style={{ color: cc > u * mkt ? CD.flag : CD.green }}>· {cc > u * mkt ? 'above' : 'below'} market {mkt.toFixed(mkt < 0.1 ? 5 : 4)}</span> : null}</span>
      </div>}

      {/* opt-in receive — keeps the consequential action off the default path */}
      {!receiveOnly && <button onClick={() => { setReceiveNow(v => !v); if (receiveNow) setCostCad(''); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 mb-3 text-left" style={{ border: `1px solid ${receiveNow ? CD.ink : CD.line}`, borderRadius: 10, background: receiveNow ? 'var(--cd-chip)' : 'transparent' }}>
        <span className="grid place-items-center flex-none" style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${receiveNow ? CD.ink : CD.faint}`, background: receiveNow ? CD.ink : 'transparent' }}>{receiveNow && <Ic n="check" s={12} c="var(--cd-on-ink)" />}</span>
        <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>Cash is already in hand — receive now</span><span className="text-[11px]" style={{ color: CD.mute }}>Posts straight to inventory instead of tracking it as on-order.</span></span>
      </button>}

      <div className="text-[10.5px] px-3 py-2 mb-3 flex items-start gap-1.5" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 8 }}><Ic n="info" s={13} c={CD.brass} /><span>Orders aren’t sent to a wholesaler from the app yet — this records the order. Receiving is what posts the cash to inventory.</span></div>

      <div className="flex items-center justify-end">
        <button disabled={!ready || done} onClick={fire} className="till-save flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white" style={{ background: done ? CD.green : (!ready ? CD.faint : CD.ink), borderRadius: 10, cursor: (!ready || done) ? 'default' : 'pointer', transition: 'background .25s ease, transform .12s ease', minWidth: 168, justifyContent: 'center' }}>
          <Ic n={done ? 'checkcircle' : (receiving ? 'checkcircle' : 'plus')} s={15} c="var(--cd-on-ink)" />
          {done ? (receiving ? 'Received' : 'Order placed') : (receiving ? 'Confirm received' : 'Place order')}
        </button>
      </div>
    </Modal>);
  }

  /* ===================== P&L (real, derived cost basis vs estimate) ===================== */
  function PnL({ rows, baseline, receipts }) {
    const live = rows.filter(r => r.status !== 'void' && r.outCcy !== 'CAD' && r.inCcy === 'CAD');
    // derived cost basis per currency (same source of truth)
    const basisOf = (c) => posOf(c, rows, baseline, receipts).cost;
    const perCcy = {};
    let realTot = 0, estTot = 0, soldCad = 0;
    live.forEach(r => {
      const out = +r.outAmt || 0, inAmt = +r.inAmt || 0, fee = +r.fee || 0;
      const basis = basisOf(r.outCcy) || cadPer(r.outCcy);
      const cost = out * basis;
      const proceeds = inAmt + fee;
      const realized = proceeds - cost;
      const est = fee + (inAmt - out * cadPer(r.outCcy));   // old mid-spread estimate
      realTot += realized; estTot += est; soldCad += proceeds;
      const k = r.outCcy; (perCcy[k] = perCcy[k] || { c: k, n: 0, real: 0, est: 0, vol: 0 });
      perCcy[k].n++; perCcy[k].real += realized; perCcy[k].est += est; perCcy[k].vol += proceeds;
    });
    const list = Object.values(perCcy).sort((a, b) => b.real - a.real);
    const delta = realTot - estTot;
    const margin = soldCad ? (realTot / soldCad * 100) : 0;

    return (<div className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <Stat big label="Realized P&L · cost basis" value={(realTot >= 0 ? '+' : '') + fmt(realTot, 'CAD')} sub={`${live.length} sales valued at real cost`} tone={realTot >= 0 ? CD.green : CD.flag} />
        <Stat label="Mid-spread estimate" value={(estTot >= 0 ? '+' : '') + fmt(estTot, 'CAD')} sub="the old approximation" />
        <Stat label="Estimate gap" value={(delta >= 0 ? '+' : '') + fmt(delta, 'CAD')} sub={delta >= 0 ? 'cost basis ran richer' : 'estimate overstated'} tone={delta >= 0 ? CD.green : CD.flag} />
        <Stat label="Net margin" value={`${margin.toFixed(2)}%`} sub={`on ${fmt(soldCad, 'CAD')} sold`} />
      </div>

      <div className="p-3 mb-3" style={{ background: CD.brassSoft, borderRadius: 12 }}>
        <div className="flex items-start gap-2">
          <Ic n="info" s={15} c={CD.brass} />
          <p className="text-[11.5px]" style={{ color: 'var(--cd-brass-text)' }}>Cost basis is derived from every real acquisition — wholesale receipts and customer sell-ins alike — weighted-averaged per currency. The old estimate marked every sale against the live mid, ignoring whether the notes were bought cheaper or dearer.</p>
        </div>
      </div>

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Volume · CAD</th><th className="px-3 py-2 text-right">Cost basis</th><th className="px-3 py-2 text-right">P&L (real)</th><th className="px-3 py-2 text-right">vs estimate</th>
          </tr></thead>
          <tbody>{list.map(r => { const d = r.real - r.est; const cb = basisOf(r.c); return (<tr key={r.c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2.5 font-medium" style={{ color: CD.ink }}>{flagOf(r.c)} {r.c}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono', color: CD.mute }}>{r.n}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(r.vol))}</td>
            <td className="px-3 py-2.5 text-right text-[12px]" style={{ fontFamily: 'Space Mono', color: CD.mute }}>{cb.toFixed(cb < 0.1 ? 5 : 4)}</td>
            <td className="px-3 py-2.5 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: r.real >= 0 ? CD.green : CD.flag }}>{(r.real >= 0 ? '+' : '') + num(Math.round(r.real))}</td>
            <td className="px-3 py-2.5 text-right text-[12px]" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: Math.abs(d) < 1 ? CD.faint : (d > 0 ? CD.green : CD.flag) }}>{Math.abs(d) < 1 ? '—' : (d > 0 ? '+' : '') + num(Math.round(d))}</td>
          </tr>); })}
          {!list.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-[12px]" style={{ color: CD.faint }}>No outbound foreign-currency sales in the ledger yet.</td></tr>}
          </tbody>
          {list.length > 0 && <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
            <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total</td><td></td>
            <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(soldCad))}</td><td></td>
            <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: realTot >= 0 ? CD.green : CD.flag }}>{(realTot >= 0 ? '+' : '') + num(Math.round(realTot))}</td>
            <td className="px-3 py-2 text-right font-bold text-[12px]" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: delta >= 0 ? CD.green : CD.flag }}>{(delta >= 0 ? '+' : '') + num(Math.round(delta))}</td>
          </tr></tfoot>}
        </table>
      </div>
    </div>);
  }

  /* ===================== shared modal shell ===================== */
  function Modal({ icon, title, sub, children, onClose }) {
    return (<div style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(24,21,17,0.46)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="flex flex-col" style={{ width: 'min(560px, 100%)', maxHeight: '100%', background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 16, boxShadow: '0 24px 60px rgba(0,0,0,0.30)', overflow: 'hidden' }}>
        <div className="px-5 pt-4 pb-3 flex items-start gap-3 flex-none" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, background: CD.ink, borderRadius: 9 }}><Ic n={icon} s={16} c="var(--cd-on-ink)" /></span>
          <div className="flex-1"><div className="text-[15px] font-semibold" style={{ color: CD.ink }}>{title}</div>{sub && <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{sub}</div>}</div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 7, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>
        <div className="overflow-auto px-5 py-4" style={{ flex: 1 }}>{children}</div>
      </div>
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Vault({ rows, me, log, baseline, receipts, setReceipts, settings, setSettings }) {
    const [tab, setTab] = useState('position');
    const [shifts, setShifts] = useState(seedShifts);
    const [ordering, setOrdering] = useState(null);   // null | { ccy?, units?, order? }
    const [notifOpen, setNotifOpen] = useState(false);
    useEffect(() => { try { localStorage.setItem(SKEY, JSON.stringify(shifts)); } catch (e) {} }, [shifts]);

    const total = VCCYS.reduce((s, c) => s + cadVal(heldOf(c, rows, baseline, receipts), c), 0);
    // low-stock notifications honour Settings → Vault: the alert switch + the owner's floors
    const lowAlert = !settings || settings.vaultLowAlert !== false;
    const lowList = !lowAlert ? [] : VCCYS.map(c => { const units = heldOf(c, rows, baseline, receipts); const min = floorOf(c, settings); const b = BANDS[c] || {}; if (!min || units >= min) return null; return { c, units, need: Math.max((b.target || min * 2) - units, 0) }; }).filter(Boolean);
    const pending = (receipts || []).filter(o => o.status === 'pending').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const onOrderCcys = new Set(pending.map(o => o.ccy));
    const notifs = [
      ...lowList.filter(s => !onOrderCcys.has(s.c)).map(s => ({ type: 'low', c: s.c, units: s.units, need: s.need })),
      ...pending.map(o => ({ type: 'pending', order: o }))
    ];
    const openShifts = shifts.filter(s => s.status === 'open').length;

    const onOrder = (init) => { setNotifOpen(false); setOrdering(init || {}); };
    const onPlace = (p) => {
      const units = +p.units || 0; if (!units) return;
      const ord = { id: Date.now(), ccy: p.ccy, units, costCad: 0, unitCost: 0, supplier: p.supplier || 'Wholesale notes', ref: 'WO-' + TODAY.slice(2).replace(/-/g, '') + '-' + p.ccy, date: TODAY, by: me.name, status: 'pending' };
      setReceipts(list => [ord, ...(list || [])]);
      log && log('Order placed', `${num(units)} ${p.ccy} from ${ord.supplier} — on order`);
      setOrdering(null); setTab('receive');
    };
    const onReceive = (p) => {
      const units = +p.units || 0, costCad = +p.costCad || 0; if (!units || !costCad) return;
      const unitCost = +(costCad / units).toFixed(6);
      if (p.id) {
        setReceipts(list => (list || []).map(o => o.id === p.id ? { ...o, ccy: p.ccy, units, costCad, unitCost, supplier: p.supplier, status: 'received', date: TODAY, receivedAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '') } : o));
      } else {
        const rec = { id: Date.now(), ccy: p.ccy, units, costCad, unitCost, supplier: p.supplier || 'Wholesale notes', ref: 'WO-' + TODAY.slice(2).replace(/-/g, '') + '-' + p.ccy, date: TODAY, by: me.name, status: 'received' };
        setReceipts(list => [rec, ...(list || [])]);
      }
      log && log('Order received', `${num(units)} ${p.ccy} @ ${fmt(unitCost, 'CAD')} · ${fmt(costCad, 'CAD')} posted to inventory`);
      setOrdering(null); setTab('receive');
    };
    const onCancel = (id) => { setReceipts(list => (list || []).filter(o => o.id !== id)); log && log('Order cancelled', 'Pending banknote order removed'); };

    const TABS = [['position', 'Position', 'pie'], ['shifts', 'Shift floats', 'users'], ['receive', 'Orders', 'arrowdown'], ['pnl', 'P&L', 'trendup']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper, position: 'relative' }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="vaultsafe" s={17} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Cash on Hand · Vault</div><div className="text-[11px]" style={{ color: CD.mute }}>{fmt(total, 'CAD')} on hand{lowList.length ? ` · ${lowList.length} low` : ''}{openShifts ? ` · ${openShifts} float${openShifts === 1 ? '' : 's'} out` : ''}</div></div>
          </div>
          <div className="flex items-center gap-2" style={{ position: 'relative' }}>
            {/* notifications */}
            <button onClick={() => setNotifOpen(o => !o)} title="Notifications" className="grid place-items-center relative" style={{ width: 36, height: 36, borderRadius: 9, border: `1px solid ${notifOpen ? CD.ink : CD.line}`, background: notifOpen ? CD.ink : 'transparent', color: notifOpen ? 'var(--cd-on-ink)' : CD.ink }}>
              <Ic n="alert" s={17} c={notifOpen ? 'var(--cd-on-ink)' : CD.ink} />
              {notifs.length > 0 && <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 4px', background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 999, fontSize: 10, fontWeight: 700, fontFamily: 'Space Mono', display: 'grid', placeItems: 'center', border: '2px solid var(--cd-panel)' }}>{notifs.length}</span>}
            </button>
            <button onClick={() => onOrder({})} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Order</button>
            {notifOpen && (<>
              <div onClick={() => setNotifOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}></div>
              <div style={{ position: 'absolute', top: 44, right: 0, width: 320, maxHeight: 360, overflow: 'auto', background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 12, boxShadow: '0 18px 44px rgba(0,0,0,0.22)', zIndex: 41 }}>
                <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.line}` }}><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Notifications</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: 'var(--cd-chip)', color: CD.mute, borderRadius: 999, fontFamily: 'Space Mono' }}>{notifs.length}</span></div>
                {notifs.length === 0 ? <div className="px-3.5 py-6 text-center text-[12px]" style={{ color: CD.faint }}>All caught up — nothing needs attention.</div> :
                  notifs.map((n, i) => n.type === 'low' ? (
                    <button key={'l' + n.c} onClick={() => onOrder({ ccy: n.c, units: n.need })} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                      <span className="grid place-items-center flex-none mt-0.5" style={{ width: 26, height: 26, borderRadius: 7, background: CD.flagSoft }}><Ic n="alert" s={14} c={CD.flag} /></span>
                      <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>{flagOf(n.c)} {n.c} is low</span><span className="text-[11px]" style={{ color: CD.mute }}>{num(Math.round(n.units))} on hand · tap to order</span></span>
                      <Ic n="arrowright" s={14} c={CD.faint} />
                    </button>
                  ) : (
                    <button key={'p' + n.order.id} onClick={() => onOrder({ order: n.order })} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                      <span className="grid place-items-center flex-none mt-0.5" style={{ width: 26, height: 26, borderRadius: 7, background: CD.amberSoft }}><Ic n="clock" s={14} c={CD.amber} /></span>
                      <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>{flagOf(n.order.ccy)} {num(n.order.units)} {n.order.ccy} on order</span><span className="text-[11px]" style={{ color: CD.mute }}>{n.order.supplier} · tap to receive</span></span>
                      <Ic n="arrowright" s={14} c={CD.faint} />
                    </button>
                  ))}
              </div>
            </>)}
          </div>
        </div>
        <div className="fld-bar" style={{ '--ft': '#17140F', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => { const badge = id === 'receive' ? notifs.length : id === 'shifts' && openShifts ? openShifts : 0; return (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: id === 'receive' ? CD.flag : CD.green, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>); })}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'position' && <Position rows={rows} baseline={baseline} receipts={receipts} settings={settings} />}
        {tab === 'shifts' && <Shifts rows={rows} baseline={baseline} receipts={receipts} me={me} log={log} shifts={shifts} setShifts={setShifts} settings={settings} setSettings={setSettings} />}
        {tab === 'receive' && <Orders receipts={receipts} pending={pending} onOrder={onOrder} onCancel={onCancel} />}
        {tab === 'pnl' && <PnL rows={rows} baseline={baseline} receipts={receipts} />}
      </div>

      {ordering && <OrderModal init={ordering} onClose={() => setOrdering(null)} onPlace={onPlace} onReceive={onReceive} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Vault });
})();
