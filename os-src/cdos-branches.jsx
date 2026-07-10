/* ============================================================
   CurrencyDesk OS — Branch Network  (multi-branch / multi-till)
   The operating backbone the desk was missing: the network is a
   set of BRANCHES, each holding one or more TILLS (cash drawers
   with an assigned teller). Branch cash is the sum of its tills;
   network cash is the sum of its branches. Cash moves till→till
   (within a branch) or branch→branch (an armoured run) and always
   nets to zero — the same conservation discipline as the Vault.

   The OS shell reads the ACTIVE STATION (branch + till) from here,
   set at sign-in and switchable from the header; this module is the
   single source of truth for the station model, and the place
   head-office reads consolidated cash position & FX mix.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, TODAY, crossRate, STAFF } = window.CDOS;
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  const cadOf = (a, c) => c === 'CAD' ? (+a || 0) : (+a || 0) * (crossRate(c, 'CAD') || 0);
  const SKEY = 'cdos_stations_v2', MKEY = 'cdos_branch_moves_v2';
  const BCCYS = ['CAD', 'USD', 'EUR', 'GBP', 'INR', 'PHP', 'CNY'];
  // on-brand grayscale ramp + one amber accent, for FX-mix stacks
  const TONE = { CAD: 'var(--cd-ink)', USD: '#3c3b38', EUR: '#615f58', GBP: '#86837b', INR: '#a8a59b', PHP: '#c6c2b8', CNY: CD.brass };

  /* ---- station model: branches → tills ---------------------------------- */
  function defaultBranches() {
    return [
      { id: 'b01', name: 'Front Desk 01', code: 'FD-01', city: 'Toronto — Adelaide St W', status: 'open', dealsToday: 23, volToday: 44277, tills: [
        { id: 'b01t1', name: 'Till 1 — Main counter', teller: 'A. Singh', status: 'open', cash: { CAD: 120000, USD: 42000, EUR: 16000, GBP: 3200, INR: 2100000, PHP: 900000, CNY: 48000 } },
        { id: 'b01t2', name: 'Till 2 — Express',       teller: 'M. Costa', status: 'open', cash: { CAD: 70000, USD: 26000, EUR: 9600, GBP: 2000, INR: 1300000, PHP: 560000, CNY: 30000 } },
        { id: 'b01t3', name: 'Wholesale desk',         teller: 'J. Masri', status: 'open', cash: { CAD: 48500, USD: 16200, EUR: 6000, GBP: 1200, INR: 780000, PHP: 300000, CNY: 18000 } },
      ] },
      { id: 'b02', name: 'North York', code: 'NY-02', city: 'Toronto — Yonge & Sheppard', status: 'open', dealsToday: 17, volToday: 31840, tills: [
        { id: 'b02t1', name: 'Till 1', teller: 'R. Haddad', status: 'open', cash: { CAD: 96000, USD: 31000, EUR: 9000, GBP: 2000, INR: 1600000, PHP: 600000, CNY: 26000 } },
        { id: 'b02t2', name: 'Till 2', teller: '', status: 'open', cash: { CAD: 66000, USD: 20000, EUR: 5200, GBP: 1100, INR: 1000000, PHP: 380000, CNY: 16000 } },
      ] },
      { id: 'b03', name: 'Scarborough', code: 'SC-03', city: 'Toronto — Kennedy Rd', status: 'open', dealsToday: 11, volToday: 18920, tills: [
        { id: 'b03t1', name: 'Till 1', teller: '', status: 'open', cash: { CAD: 96000, USD: 28500, EUR: 6400, GBP: 1200, INR: 5100000, PHP: 2200000, CNY: 19000 } },
      ] },
      { id: 'b04', name: 'Mississauga', code: 'MS-04', city: 'Square One', status: 'closed', dealsToday: 0, volToday: 0, tills: [
        { id: 'b04t1', name: 'Till 1', teller: '', status: 'closed', cash: { CAD: 41000, USD: 12000, EUR: 2200, GBP: 600, INR: 880000, PHP: 410000, CNY: 8000 } },
      ] },
    ];
  }
  const tillCad = (t) => BCCYS.reduce((s, c) => s + cadOf((t.cash && t.cash[c]) || 0, c), 0);
  const branchUnits = (b, c) => (b.tills || []).reduce((s, t) => s + ((t.cash && t.cash[c]) || 0), 0);
  const branchCad = (b) => (b.tills || []).reduce((s, t) => s + tillCad(t), 0);
  const defaultStation = (branches) => { const b = (branches || defaultBranches()).find(x => x.status === 'open') || branches[0]; const t = (b.tills || []).find(x => x.status === 'open') || b.tills[0]; return { branchId: b.id, tillId: t && t.id }; };

  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };

  /* ===================== MOVE CASH (till → till / branch → branch) ===================== */
  function MoveModal({ branches, station, onClose, onMove }) {
    const tillOpts = useMemo(() => branches.flatMap(b => (b.tills || []).map(t => ({ key: b.id + '/' + t.id, bId: b.id, tId: t.id, label: b.code + ' · ' + t.name, b, t }))), [branches]);
    const activeKey = station ? station.branchId + '/' + station.tillId : (tillOpts[0] && tillOpts[0].key);
    const [from, setFrom] = useState(activeKey || (tillOpts[0] && tillOpts[0].key));
    const [to, setTo] = useState((tillOpts.find(o => o.key !== from) || tillOpts[1] || {}).key);
    const [ccy, setCcy] = useState('CAD');
    const [amount, setAmount] = useState('');
    const fo = tillOpts.find(o => o.key === from) || {};
    const too = tillOpts.find(o => o.key === to) || {};
    const avail = (fo.t && fo.t.cash && fo.t.cash[ccy]) || 0;
    const amt = +amount || 0;
    const short = amt > avail;
    const sameBranch = fo.bId && too.bId && fo.bId === too.bId;
    const valid = from && to && from !== to && amt > 0 && !short;
    const Opt = ({ o }) => <option value={o.key}>{o.label}</option>;
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 480, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="swap" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Move cash</div><div className="text-[11px]" style={{ color: CD.mute }}>{sameBranch ? 'Till transfer within a branch' : 'Armoured run between branch vaults'}</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><div className="text-[11px] mb-1" style={{ color: CD.mute }}>From till</div><select value={from} onChange={e => setFrom(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty}>{tillOpts.map(o => <Opt key={o.key} o={o} />)}</select></div>
            <div><div className="text-[11px] mb-1" style={{ color: CD.mute }}>To till</div><select value={to} onChange={e => setTo(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty}>{tillOpts.map(o => <Opt key={o.key} o={o} />)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Currency</div><select value={ccy} onChange={e => setCcy(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty}>{BCCYS.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><div className="text-[11px] mb-1 flex justify-between" style={{ color: CD.mute }}><span>Amount</span><span style={{ color: CD.faint }}>avail {num(avail)}</span></div><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inputSty, borderColor: short ? CD.flag : CD.line, fontFamily: 'Space Mono' }} /></div>
          </div>
          {from === to && <div className="text-[11px] px-3 py-2" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>Pick two different tills.</div>}
          {short && <div className="text-[11px] px-3 py-2" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>That till only holds {num(avail)} {ccy}.</div>}
          {amt > 0 && !short && from !== to && <div className="flex items-center justify-between px-3 py-2" style={{ background: 'var(--cd-chip)', borderRadius: 8 }}><span className="text-[11.5px]" style={{ color: CD.mute }}>{fo.label} → {too.label}</span><span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink }}>{num(amt)} {ccy} · {fmt(cadOf(amt, ccy), 'CAD')}</span></div>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
          <button onClick={() => valid && onMove(fo, too, ccy, amt, sameBranch)} disabled={!valid} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: valid ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: valid ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> Move cash</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== FX-MIX STACK ===================== */
  function MixBar({ b, h = 10 }) {
    const total = branchCad(b) || 1;
    const segs = BCCYS.map(c => ({ c, v: cadOf(branchUnits(b, c), c) })).filter(s => s.v > 0).sort((a, z) => z.v - a.v);
    return (<div className="flex w-full overflow-hidden" style={{ height: h, borderRadius: 999, background: CD.lineSoft }}>
      {segs.map(s => <div key={s.c} title={`${s.c} · ${Math.round(s.v / total * 100)}%`} style={{ width: (s.v / total * 100) + '%', background: TONE[s.c] || CD.faint }}></div>)}
    </div>);
  }

  /* ===================== MAIN ===================== */
  function Branches({ me, log, branches, setBranches, moves, setMoves, station, setStation, onOpenTill }) {
    const [tab, setTab] = useState('network');
    const [moving, setMoving] = useState(false);

    const netCash = branches.reduce((s, b) => s + branchCad(b), 0);
    const netVol = branches.reduce((s, b) => s + (b.volToday || 0), 0);
    const netDeals = branches.reduce((s, b) => s + (b.dealsToday || 0), 0);
    const openN = branches.filter(b => b.status === 'open').length;
    const tillsOpen = branches.reduce((s, b) => s + (b.status === 'open' ? (b.tills || []).filter(t => t.status === 'open').length : 0), 0);
    const activeBranch = branches.find(b => b.id === (station && station.branchId));
    const activeTill = activeBranch && (activeBranch.tills || []).find(t => t.id === station.tillId);

    const doMove = (fo, too, ccy, amt, sameBranch) => {
      setBranches(list => list.map(b => {
        if (b.id !== fo.bId && b.id !== too.bId) return b;
        return { ...b, tills: (b.tills || []).map(t => {
          if (t.id === fo.tId) return { ...t, cash: { ...t.cash, [ccy]: ((t.cash && t.cash[ccy]) || 0) - amt } };
          if (t.id === too.tId) return { ...t, cash: { ...t.cash, [ccy]: ((t.cash && t.cash[ccy]) || 0) + amt } };
          return t;
        }) };
      }));
      const ref = 'MV-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + (moves.filter(m => m.date === TODAY).length + 1).toString().padStart(2, '0');
      setMoves(list => [{ id: 'm' + Date.now(), ref, kind: sameBranch ? 'till' : 'branch', from: fo.label, to: too.label, ccy, amount: amt, cadVal: +cadOf(amt, ccy).toFixed(2), date: TODAY, by: me.name }, ...list]);
      log && log(sameBranch ? 'Till transfer' : 'Inter-branch movement', `${num(amt)} ${ccy} · ${fo.label} → ${too.label}`);
      setMoving(false);
    };
    const toggleBranch = (id) => setBranches(list => list.map(b => b.id === id ? { ...b, status: b.status === 'open' ? 'closed' : 'open' } : b));
    const toggleTill = (bId, tId) => setBranches(list => list.map(b => b.id === bId ? { ...b, tills: b.tills.map(t => t.id === tId ? { ...t, status: t.status === 'open' ? 'closed' : 'open' } : t) } : b));
    const setTeller = (bId, tId, name) => setBranches(list => list.map(b => b.id === bId ? { ...b, tills: b.tills.map(t => t.id === tId ? { ...t, teller: name } : t) } : b));
    const addTill = (bId) => setBranches(list => list.map(b => {
      if (b.id !== bId) return b;
      const n = (b.tills || []).length + 1;
      return { ...b, tills: [...b.tills, { id: b.id + 't' + Date.now(), name: 'Till ' + n, teller: '', status: 'open', cash: { CAD: 0 } }] };
    }));
    const makeActive = (bId, tId) => { setStation && setStation({ branchId: bId, tillId: tId }); log && log('Station switched', branches.find(b => b.id === bId).code + ' · ' + (branches.find(b => b.id === bId).tills.find(t => t.id === tId) || {}).name); };

    const TABS = [['network', 'Network', 'building'], ['tills', 'Branches & tills', 'wallet'], ['movements', 'Cash movements', 'swap']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="branchnet" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Branch Network</div><div className="text-[11px]" style={{ color: CD.mute }}>{openN} of {branches.length} branches open · {tillsOpen} tills live · {fmt(netCash, 'CAD')} network cash</div></div></div>
          <button onClick={() => setMoving(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="swap" s={15} c="var(--cd-on-ink)" /> Move cash</button>
        </div>
        {activeBranch && activeTill && <div className="flex items-center gap-2 pt-2 text-[11px]" style={{ color: CD.mute }}><span className="grid place-items-center" style={{ width: 6, height: 6, borderRadius: 999, background: CD.green }}></span>You're operating <b style={{ color: CD.ink }}>{activeBranch.name}</b> · {activeTill.name}{activeTill.teller ? ` · ${activeTill.teller}` : ''}</div>}
        <div className="fld-bar" style={{ '--ft': '#17140F', margin: '2px -16px 0', padding: '0 16px' }}>{TABS.map(([id, label, ic]) => (
          <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}><Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}</button>))}</div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* ===================== NETWORK — consolidated cash position & FX mix ===================== */}
        {tab === 'network' && (<div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[['Network cash · CAD', fmt(netCash, 'CAD')], ['Branches open', `${openN} / ${branches.length}`], ['Tills live', String(tillsOpen)], ['Volume today', fmt(netVol, 'CAD')]].map(([l, v]) => (
              <div key={l} className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
          </div>

          {/* consolidated cash position: currency × branch matrix */}
          <div className="overflow-hidden mb-4" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
            <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.line}` }}><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Consolidated cash position</span><span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>units held · CAD value</span></div>
            <table className="w-full text-sm border-collapse">
              <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
                <th className="px-3 py-2">Currency</th>
                {branches.map(b => <th key={b.id} className="px-2 py-2 text-right" style={{ color: b.id === (station && station.branchId) ? CD.ink : CD.mute }}>{b.code}</th>)}
                <th className="px-3 py-2 text-right" style={{ color: CD.ink }}>Network</th>
                <th className="px-3 py-2 text-right">CAD value</th>
                <th className="px-3 py-2 text-right">Mix</th>
              </tr></thead>
              <tbody>{BCCYS.map(c => {
                const netUnits = branches.reduce((s, b) => s + branchUnits(b, c), 0);
                const cad = cadOf(netUnits, c);
                const mix = netCash ? cad / netCash * 100 : 0;
                if (netUnits <= 0) return null;
                return (<tr key={c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(c)}</span> {c}</td>
                  {branches.map(b => <td key={b.id} className="px-2 py-2 text-right" style={{ fontFamily: 'Space Mono', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: branchUnits(b, c) ? CD.mute : CD.faint }}>{branchUnits(b, c) ? num(branchUnits(b, c)) : '—'}</td>)}
                  <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(netUnits)}</td>
                  <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(cad, 'CAD')}</td>
                  <td className="px-3 py-2 text-right"><div className="flex items-center justify-end gap-2"><span className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono', width: 32, textAlign: 'right' }}>{mix.toFixed(0)}%</span><span style={{ width: 44, height: 7, borderRadius: 999, background: CD.lineSoft, overflow: 'hidden', display: 'inline-block' }}><span style={{ display: 'block', height: '100%', width: mix + '%', background: TONE[c] || CD.faint }}></span></span></div></td>
                </tr>); })}
              </tbody>
              <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
                <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total · CAD</td>
                {branches.map(b => <td key={b.id} className="px-2 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{Math.round(branchCad(b) / 1000)}k</td>)}
                <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }} colSpan={2}>{fmt(netCash, 'CAD')}</td>
                <td></td>
              </tr></tfoot>
            </table>
          </div>

          {/* FX mix by branch */}
          <div className="text-[12px] font-semibold mb-2" style={{ color: CD.ink }}>FX mix by branch</div>
          <div className="grid sm:grid-cols-2 gap-2.5 mb-2">
            {branches.map(b => { const cash = branchCad(b); const closed = b.status === 'closed'; const fx = BCCYS.filter(c => c !== 'CAD').reduce((s, c) => s + cadOf(branchUnits(b, c), c), 0); return (
              <div key={b.id} className="p-3.5" style={{ background: CD.panel, border: `1px solid ${b.id === (station && station.branchId) ? CD.ink : CD.line}`, borderRadius: 12, opacity: closed ? 0.72 : 1 }}>
                <div className="flex items-start justify-between mb-2.5">
                  <div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {b.code}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{(b.tills || []).length} till{b.tills.length === 1 ? '' : 's'} · {fmt(cash, 'CAD')} · {cash ? Math.round(fx / cash * 100) : 0}% in FX</div></div>
                  <button onClick={() => toggleBranch(b.id)} className="text-[10px] px-2 py-0.5 font-semibold" style={{ background: closed ? CD.lineSoft : CD.greenSoft, color: closed ? CD.mute : CD.green, borderRadius: 999 }}>{closed ? 'CLOSED' : 'OPEN'}</button>
                </div>
                <MixBar b={b} />
                <div className="mt-2.5 flex flex-wrap gap-1.5">{BCCYS.filter(c => branchUnits(b, c) > 0).map(c => <span key={c} className="flex items-center gap-1 text-[10.5px]" style={{ color: CD.mute }}><span style={{ width: 8, height: 8, borderRadius: 2, background: TONE[c] || CD.faint, display: 'inline-block' }}></span>{c}</span>)}</div>
              </div>); })}
          </div>
          <p className="mt-1 text-[11px]" style={{ color: CD.faint }}>Each till holds its own cash; a branch is the sum of its tills, the network the sum of its branches. This rollup is what head-office reconciles against — and the FX mix shows where each branch is long or thin.</p>
        </div>)}

        {/* ===================== BRANCHES & TILLS ===================== */}
        {tab === 'tills' && (<div className="space-y-3">
          {branches.map(b => { const closed = b.status === 'closed'; return (
            <div key={b.id} style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12, opacity: closed ? 0.78 : 1 }}>
              <div className="flex items-center justify-between px-3.5 py-3" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
                <div className="flex items-center gap-2.5">
                  <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 9, background: CD.ink }}><Ic n="building" s={17} c="var(--cd-on-ink)" /></span>
                  <div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {b.code}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{b.city} · {fmt(branchCad(b), 'CAD')}</div></div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => addTill(b.id)} className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute }}><Ic n="plus" s={12} c={CD.mute} /> Add till</button>
                  <button onClick={() => toggleBranch(b.id)} className="text-[10px] px-2 py-1 font-semibold" style={{ background: closed ? CD.lineSoft : CD.greenSoft, color: closed ? CD.mute : CD.green, borderRadius: 999 }}>{closed ? 'CLOSED' : 'OPEN'}</button>
                </div>
              </div>
              <div className="divide-y" style={{ borderColor: CD.lineSoft }}>
                {(b.tills || []).map(t => { const isActive = station && station.branchId === b.id && station.tillId === t.id; const tClosed = t.status === 'closed'; return (
                  <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}`, background: isActive ? CD.brassSoft : 'transparent' }}>
                    <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: isActive ? CD.ink : 'var(--cd-chip)' }}><Ic n="wallet" s={15} c={isActive ? 'var(--cd-on-ink)' : CD.mute} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium flex items-center gap-2" style={{ color: CD.ink }}>{t.name}{isActive && <span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 4, letterSpacing: '0.06em' }}>OPERATING</span>}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10.5px]" style={{ color: CD.faint }}>Teller</span>
                        <select value={t.teller} onChange={e => setTeller(b.id, t.id, e.target.value)} className="text-[11px] px-1.5 py-0.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, background: 'var(--cd-panel)', color: t.teller ? CD.ink : CD.faint }}>
                          <option value="">unassigned</option>
                          {STAFF.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="text-right flex-none" style={{ width: 110 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Drawer · CAD</div><div className="text-[13.5px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }}>{fmt(tillCad(t), 'CAD')}</div></div>
                    <div className="flex items-center gap-1.5 flex-none">
                      <button onClick={() => toggleTill(b.id, t.id)} title={tClosed ? 'Open till' : 'Close till'} className="text-[9.5px] px-1.5 py-1 font-semibold" style={{ background: tClosed ? CD.lineSoft : CD.greenSoft, color: tClosed ? CD.mute : CD.green, borderRadius: 6 }}>{tClosed ? 'CLOSED' : 'OPEN'}</button>
                      {isActive ? <span className="text-[11px] px-2.5 py-1.5 font-semibold" style={{ color: CD.brass }}>Operating</span>
                        : <button onClick={() => makeActive(b.id, t.id)} disabled={closed || tClosed} className="text-[11px] px-2.5 py-1.5 font-semibold text-white" style={{ background: (closed || tClosed) ? 'var(--cd-disabled)' : CD.ink, borderRadius: 7, cursor: (closed || tClosed) ? 'not-allowed' : 'pointer' }}>Operate</button>}
                    </div>
                  </div>); })}
              </div>
            </div>); })}
          <p className="text-[11px]" style={{ color: CD.faint }}>Set which till you're working from with <b>Operate</b> — the OS header, Till &amp; the cash drawer all follow the active station. Tellers and tills can be reassigned without leaving the counter.</p>
        </div>)}

        {/* ===================== CASH MOVEMENTS ===================== */}
        {tab === 'movements' && (<div>
          <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
            <table className="w-full text-sm border-collapse">
              <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left"><th className="px-3 py-2">Ref</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">From</th><th className="px-3 py-2">To</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">CAD</th><th className="px-3 py-2">By</th></tr></thead>
              <tbody>{moves.map(m => (<tr key={m.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                <td className="px-3 py-2" style={{ fontFamily: 'Space Mono', fontSize: 11.5, color: CD.mute }}>{m.ref}</td>
                <td className="px-3 py-2" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{m.date}</td>
                <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5 font-semibold" style={{ background: m.kind === 'till' ? CD.lineSoft : CD.brassSoft, color: m.kind === 'till' ? CD.mute : CD.brass, borderRadius: 5 }}>{m.kind === 'till' ? 'TILL' : 'BRANCH'}</span></td>
                <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}>{m.from}</td>
                <td className="px-3 py-2" style={{ color: CD.ink }}><Ic n="arrowright" s={11} c={CD.faint} /> {m.to}</td>
                <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(m.amount)} {m.ccy}</td>
                <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(m.cadVal, 'CAD')}</td>
                <td className="px-3 py-2 text-[11.5px]" style={{ color: CD.mute }}>{m.by}</td>
              </tr>))}
              {!moves.length && <tr><td colSpan={8} className="px-3 py-10 text-center text-[12px]" style={{ color: CD.faint }}>No movements yet. Use <b>Move cash</b> to rebalance a till or run cash between branches.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>Every movement debits one till and credits another — the network total never changes, only where the cash sits.</p>
        </div>)}
      </div>
      {moving && <MoveModal branches={branches} station={station} onClose={() => setMoving(false)} onMove={doMove} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Branches });
  window.CDOS._stations = { SKEY, MKEY, defaultBranches, defaultStation, branchCad, tillCad, branchUnits };
})();
