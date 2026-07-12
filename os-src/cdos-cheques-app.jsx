/* ============================================================
   CurrencyDesk OS — Cheques app shell
   Clearing pipeline (with live cash-at-risk exposure) + the per-type
   fee schedule. Reads the data layer + modals from window.CDOS._cheques.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, TODAY } = window.CDOS;
  const K = window.CDOS._cheques;
  const { defaultSchedule, defaultCheques, KKEY, SKEY, load, STATUS, RISK_TONE, feeFor, daysBetween, StatusPill, CaptureModal, ChequeDetail } = K;

  /* ===================== CLEARING ===================== */
  function Clearing({ cheques, onOpen, onNew }) {
    const [filter, setFilter] = useState('held');
    const stats = useMemo(() => {
      let exposure = 0, soon = 0, overdue = 0, losses = 0, lossN = 0, cleared = 0;
      cheques.forEach(c => {
        if (c.status === 'held') { exposure += c.netCad; if (c.holdUntil < TODAY) overdue++; else if (daysBetween(TODAY, c.holdUntil) <= 1) soon++; }
        if (c.status === 'returned') { losses += c.netCad; lossN++; }
        if (c.status === 'cleared') cleared++;
      });
      return { exposure, soon, overdue, losses, lossN, cleared, held: cheques.filter(c => c.status === 'held').length };
    }, [cheques]);
    const list = useMemo(() => cheques.filter(c => filter === 'all' ? true : c.status === filter).sort((a, b) => (b.receivedDate + b.ref).localeCompare(a.receivedDate + a.ref)), [cheques, filter]);
    const FILTERS = [['held', 'On hold', stats.held], ['cleared', 'Cleared', stats.cleared], ['returned', 'Returned', stats.lossN], ['all', 'All', cheques.length]];

    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Cheque clearing</div><div className="text-[11px]" style={{ color: CD.mute }}>Cash you've fronted, tracked until it clears — or bounces.</div></div>
        <button onClick={onNew} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="receipt" s={15} c="var(--cd-on-ink)" /> Cash a cheque</button>
      </div>

      {/* exposure — the credit risk */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-3" style={{ background: stats.exposure > 0 ? CD.amberSoft : CD.panel, border: `1px solid ${stats.exposure > 0 ? CD.amber : CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest flex items-center gap-1" style={{ color: 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace' }}><Ic n="shield" s={11} c={CD.amber} /> Cash at risk</div>
          <div className="text-xl font-bold" style={{ color: 'var(--cd-brass-text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(stats.exposure, 'CAD')}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>{stats.held} on hold{stats.overdue ? ` · ${stats.overdue} overdue` : ''}</div>
        </div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Clearing ≤ 1 day</div>
          <div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{stats.soon}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>ready to release soon</div>
        </div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${stats.lossN ? CD.flag : CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest flex items-center gap-1" style={{ color: stats.lossN ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>{stats.lossN > 0 && <Ic n="alert" s={11} c={CD.flag} />} Returned losses</div>
          <div className="text-xl font-bold" style={{ color: stats.lossN ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(stats.losses, 'CAD')}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>{stats.lossN} NSF / fraud</div>
        </div>
      </div>

      {stats.overdue > 0 && <div className="flex items-center gap-2 px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 9 }}><Ic n="clock" s={14} c={CD.flag} /><span className="text-[12px]">{stats.overdue} cheque{stats.overdue === 1 ? '' : 's'} past the hold date and still uncleared — chase the drawee bank.</span></div>}

      <div className="flex flex-wrap gap-1.5 mb-3">
        {FILTERS.map(([id, label, n]) => <button key={id} onClick={() => setFilter(id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${filter === id ? 'transparent' : CD.line}`, background: filter === id ? CD.ink : 'transparent', color: filter === id ? 'var(--cd-on-ink)' : CD.mute }}>{label}{n > 0 && <span className="text-[10px] px-1 py-0.5" style={{ background: filter === id ? 'var(--cd-on-ink-faint)' : CD.lineSoft, borderRadius: 4, fontFamily: 'Space Mono' }}>{n}</span>}</button>)}
      </div>

      <div className="space-y-2">
        {list.map(c => { const overdue = c.status === 'held' && c.holdUntil < TODAY; const rt = RISK_TONE[(K.defaultSchedule().find(s => s.id === c.typeId) || {}).risk] || RISK_TONE.low; return (
          <button key={c.id} onClick={() => onOpen(c.id)} className="w-full text-left p-3 flex items-center gap-3" style={{ background: CD.panel, border: `1px solid ${overdue ? CD.flag : CD.line}`, borderRadius: 11 }}>
            <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, borderRadius: 9, background: (STATUS[c.status] || STATUS.held).soft }}><Ic n={(STATUS[c.status] || STATUS.held).icon} s={17} c={(STATUS[c.status] || STATUS.held).ink} /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap"><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{c.maker}</span><span className="text-[11px]" style={{ color: CD.faint }}>#{c.chequeNumber}</span></div>
              <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{c.ref} · {c.typeLabel} · {c.draweeBank} · for {c.customer}</div>
            </div>
            <div className="text-right flex-none">
              <div className="text-[13px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.amount, 'CAD')}</div>
              <div className="text-[10.5px] mt-0.5" style={{ color: overdue ? CD.flag : CD.mute }}>{c.status === 'held' ? (overdue ? `overdue ${c.holdUntil}` : `holds to ${c.holdUntil}`) : (STATUS[c.status] || STATUS.held).label}</div>
            </div>
          </button>); })}
        {!list.length && <div className="text-center py-14" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="receipt" s={26} c={CD.faint} /><div className="mt-2 text-sm font-medium" style={{ color: CD.ink }}>Nothing here</div><div className="text-[12px] mt-0.5">Cash a cheque to start tracking it.</div></div>}
      </div>
    </div>);
  }

  /* ===================== FEE SCHEDULE ===================== */
  function FeeSchedule({ schedule, setSchedule, log }) {
    const set = (id, k, v) => setSchedule(list => list.map(t => t.id === id ? { ...t, [k]: v } : t));
    return (<div className="p-4">
      <div className="mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Fee schedule by cheque type</div><div className="text-[11px]" style={{ color: CD.mute }}>Fee is the greater of the percentage or the minimum. Hold days set how long the cash is at risk — wider on riskier paper.</div></div>
      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Type</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2 text-right">Fee %</th><th className="px-3 py-2 text-right">Min fee</th><th className="px-3 py-2 text-right">Hold days</th><th className="px-3 py-2 text-right">e.g. $2,000</th>
          </tr></thead>
          <tbody>{schedule.map(t => { const rt = RISK_TONE[t.risk] || RISK_TONE.low; const eg = feeFor(2000, t); return (
            <tr key={t.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}>{t.label}</td>
              <td className="px-3 py-2"><select value={t.risk} onChange={e => set(t.id, 'risk', e.target.value)} className="text-[12px] px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, color: rt.c, background: rt.bg }}>{['low', 'medium', 'high'].map(r => <option key={r} value={r}>{RISK_TONE[r].t}</option>)}</select></td>
              <td className="px-3 py-2 text-right"><input type="number" step="0.1" value={t.feePct} onChange={e => set(t.id, 'feePct', +e.target.value)} className="w-16 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums' }} /></td>
              <td className="px-3 py-2 text-right"><input type="number" value={t.feeMin} onChange={e => set(t.id, 'feeMin', +e.target.value)} className="w-16 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums' }} /></td>
              <td className="px-3 py-2 text-right"><input type="number" value={t.holdDays} onChange={e => set(t.id, 'holdDays', +e.target.value)} className="w-14 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums' }} /></td>
              <td className="px-3 py-2 text-right font-semibold" style={{ color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{fmt(eg, 'CAD')}</td>
            </tr>); })}</tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>Government and certified cheques clear fast and cheap; personal cheques carry the longest hold and the widest fee because they're the most likely to bounce.</p>
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Cheques({ rows, setRows, clients, settings, me, log, cheques: pChq, setCheques: pSetChq, schedule: pSched, setSchedule: pSetSched, captureSignal }) {
    const [tab, setTab] = useState('clearing');
    // cheques + schedule are lifted to the OS shell so the Ledger shares them;
    // fall back to local stores if mounted standalone.
    const [lChq, lSetChq] = useState(() => load(KKEY, defaultCheques));
    const [lSched, lSetSched] = useState(() => load(SKEY, defaultSchedule));
    const cheques = pChq || lChq, setCheques = pSetChq || lSetChq;
    const schedule = pSched || lSched, setSchedule = pSetSched || lSetSched;
    const [modal, setModal] = useState(false);
    const [detailId, setDetailId] = useState(null);
    useEffect(() => { if (!pSetChq) { try { localStorage.setItem(KKEY, JSON.stringify(lChq)); } catch (e) {} } }, [lChq]);
    useEffect(() => { if (!pSetSched) { try { localStorage.setItem(SKEY, JSON.stringify(lSched)); } catch (e) {} } }, [lSched]);
    // the Ledger's "Cheque Cashing" type opens this same capture flow
    const lastSig = useRef(0);
    useEffect(() => { if (captureSignal && captureSignal !== lastSig.current) { lastSig.current = captureSignal; setTab('clearing'); setModal(true); } }, [captureSignal]);

    const detail = detailId ? cheques.find(c => c.id === detailId) : null;
    const exposure = cheques.filter(c => c.status === 'held').reduce((s, c) => s + c.netCad, 0);
    const overdue = cheques.filter(c => c.status === 'held' && c.holdUntil < TODAY).length;
    const TABS = [['clearing', 'Clearing', 'receipt'], ['schedule', 'Fee schedule', 'percent']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="cheque" s={16} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Cheques</div><div className="text-[11px]" style={{ color: CD.mute }}>{fmt(exposure, 'CAD')} at risk{overdue ? ` · ${overdue} overdue` : ''}</div></div>
          </div>
          <button onClick={() => setModal(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Cash a cheque</button>
        </div>
        <div className="fld-bar" style={{ '--ft': '#8F6410', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => { const badge = id === 'clearing' && overdue ? overdue : 0; return (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>); })}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'clearing' && <Clearing cheques={cheques} onOpen={setDetailId} onNew={() => setModal(true)} />}
        {tab === 'schedule' && <FeeSchedule schedule={schedule} setSchedule={setSchedule} log={log} />}
      </div>

      {modal && <CaptureModal {...{ rows, setRows, clients, settings, schedule, me, log, cheques, setCheques }} onClose={() => setModal(false)} onDone={(id) => { setModal(false); setTab('clearing'); setDetailId(id); }} />}
      {detail && <ChequeDetail c={detail} me={me} log={log} setCheques={setCheques} onClose={() => setDetailId(null)} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Cheques });
})();
