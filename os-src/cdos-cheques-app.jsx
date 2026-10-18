/* ============================================================
   CurrencyDesk OS — Cheques app shell
   Clearing pipeline (with live cash-at-risk exposure) + the per-type
   fee schedule. Reads the data layer + modals from window.CDOS._cheques.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, TODAY } = window.CDOS;
  const homeCcy = () => (window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : 'CAD');
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
          <div className="text-xl font-bold" style={{ color: 'var(--cd-brass-text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(stats.exposure, homeCcy())}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>{stats.held} on hold{stats.overdue ? ` · ${stats.overdue} overdue` : ''}</div>
        </div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Clearing ≤ 1 day</div>
          <div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{stats.soon}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>ready to release soon</div>
        </div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${stats.lossN ? CD.flag : CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest flex items-center gap-1" style={{ color: stats.lossN ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>{stats.lossN > 0 && <Ic n="alert" s={11} c={CD.flag} />} Returned losses</div>
          <div className="text-xl font-bold" style={{ color: stats.lossN ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(stats.losses, homeCcy())}</div>
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
              <div className="text-[13px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.amount, homeCcy())}</div>
              <div className="text-[10.5px] mt-0.5" style={{ color: overdue ? CD.flag : CD.mute }}>{c.status === 'held' ? (overdue ? `overdue ${c.holdUntil}` : `holds to ${c.holdUntil}`) : (STATUS[c.status] || STATUS.held).label}</div>
            </div>
          </button>); })}
        {!list.length && <div className="text-center py-14" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="receipt" s={26} c={CD.faint} /><div className="mt-2 text-sm font-medium" style={{ color: CD.ink }}>Nothing here</div><div className="text-[12px] mt-0.5">Cash a cheque to start tracking it.</div></div>}
      </div>
    </div>);
  }

  /* ===================== FEE SCHEDULE =====================
     The fee is the price of cash the desk has not yet collected.
     The owner and a manager can change it, including to 0%. A teller cannot. The
     server is the check. This screen only stops inviting the edit.
     The table follows who is signed in now. A cashier sees the lock
     and the read-only figures, with no inputs, before any Save.
     The lock sits in that sentence, and the sentence wraps. */
  const FEE_SENTENCE = 'Only the owner or a manager can change cheque fees. Ask a manager to make this change.';
  const FEE_BANNER = "That change didn't save. Only the owner or a manager can change cheque fees.";
  const FEE_CONFLICT = "That change didn't save. Someone changed these fees. Reload to see the latest, then try again.";
  const FEE_PLACES = "That change didn't save. A fee % can have up to 2 decimals, like 2.25.";
  /* Two decimals while a digit is still being typed. */
  function money2(n) {
    if (typeof n === 'string' && /^\d*\.\d{0,1}$/.test(n)) return n;
    const x = Number(n);
    return Number.isFinite(x) ? x.toFixed(2) : '';
  }
  function FeeSchedule({ schedule, setSchedule, me }) {
    const mayEdit = !!(me && (me.role === 'Owner' || me.role === 'Manager'));
    const shownSchedule = (list) => (Array.isArray(list) ? list.map(row => {
      const shown = row && window.CDOS_CHEQUE_FEE.feePctShown(row.feePct);
      return shown == null ? row : { ...row, feePct: shown };
    }) : list);
    const [draft, setDraft] = useState(() => shownSchedule(schedule));
    const [refused, setRefused] = useState(false);
    const [places, setPlaces] = useState(null);
    const [conflict, setConflict] = useState(false); const [trouble, setTrouble] = useState(false);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => { setDraft(shownSchedule(schedule)); }, [schedule]);
    const set = (id, k, v) => { setSaved(false); setDraft(list => list.map(t => t.id === id ? { ...t, [k]: v } : t)); };
    const rows = mayEdit ? draft : shownSchedule(schedule);
    const save = async () => {
      setBusy(true);
      try {
        const persist = window.CDOS_PERSIST;
        const snap = persist && persist.snapshot ? persist.snapshot() : {};
        const version = persist && persist.status ? persist.status().version : 0;
        const clean = draft.map(row => {
          const saved = (schedule || []).find(item => item.id === row.id);
          const fee = window.CDOS_CHEQUE_FEE;
          const committed = fee.feePctCommit(row.feePct);
          let pct = row.feePct;
          if (committed === '' && saved) {
            const shown = fee.feePctShown(saved.feePct);
            pct = shown == null ? saved.feePct : shown;
          } else if (committed != null) pct = committed;
          const next = /^\d{1,6}(?:\.\d{1,2})?$/.test(String(pct)) ? { ...row, feePct: Number(pct) } : { ...row };
          const minShown = fee.moneyShown(row.feeMin);
          if (minShown != null) next.feeMin = minShown === '' ? '' : Number(minShown);
          return next;
        });
        snap[SKEY] = JSON.stringify(clean);
        const res = await fetch('/api/tenant/state', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ state: snap, version: version }),
        });
        let body = null; try { body = await res.json(); } catch (e) { body = null; }
        if (res.status === 409) { setConflict(true); setRefused(false); setPlaces(null); setTrouble(false); setSaved(false); return; }
        if (res.status === 403) { setRefused(true); setConflict(false); setPlaces(null); setTrouble(false); setSaved(false); return; }
        if (res.status === 400 && body && body.error === 'fee_places') { setPlaces({ detail: body.detail || FEE_PLACES, field: body.field || '', id: body.id == null ? '' : String(body.id) }); setRefused(false); setConflict(false); setTrouble(false); setSaved(false); return; }
        if (!res.ok || !body) throw new Error('The fee schedule was not saved.');
        if (persist && persist.noteVersion && body && typeof body.version === 'number') persist.noteVersion(body.version);
        localStorage.setItem(SKEY, JSON.stringify(clean));
        setDraft(clean);
        setSchedule(clean);
        setRefused(false); setPlaces(null);
        setConflict(false); setTrouble(false);
        setSaved(true);
      } catch (e) { setTrouble(true); setConflict(false); setRefused(false); setPlaces(null); setSaved(false); } finally { setBusy(false); }
    };
    const cell = { color: mayEdit ? CD.ink : CD.mute, fontVariantNumeric: 'tabular-nums' };
    return (<div className="p-4" data-testid="fee-schedule" style={{ minWidth: 0, maxWidth: '100%' }}>
      {!mayEdit && <p data-testid="fee-schedule-lock" className="fee-lock mb-3 text-[12px]" style={{ color: CD.ink }}><Ic n="lock" s={14} c={CD.mute} /> {FEE_SENTENCE}</p>}
      <div className="mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Fee schedule by cheque type</div><div className="text-[11px]" style={{ color: CD.mute }}>Fee is the greater of the percentage or the minimum. Hold days set how long the cash is at risk. Wider on riskier paper.</div></div>
      <div className="fee-schedule-card overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Type</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2 text-right">Fee %</th><th className="px-3 py-2 text-right">Min fee</th><th className="px-3 py-2 text-right">Hold days</th><th className="px-3 py-2 text-right">e.g. $2,000.00</th>
          </tr></thead>
          <tbody>{rows.map(t => { const rt = RISK_TONE[t.risk] || RISK_TONE.low; const eg = feeFor(2000, t); const marked = places && String(places.id) === String(t.id); const badPct = !!(marked && places.field === 'feePct'); const badMin = !!(marked && places.field === 'feeMin'); return (
            <tr key={t.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <td className="px-3 py-2 font-medium" style={{ color: mayEdit ? CD.ink : CD.mute }}>{t.label}</td>
              <td className="px-3 py-2">{mayEdit
                ? <select value={t.risk} onChange={e => set(t.id, 'risk', e.target.value)} className="fee-field text-[12px] px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, color: rt.c, background: rt.bg }}>{['low', 'medium', 'high'].map(r => <option key={r} value={r}>{RISK_TONE[r].t}</option>)}</select>
                : <span className="text-[12px]" style={{ color: CD.mute }}>{rt.t}</span>}</td>
              <td className="px-3 py-2 text-right">{mayEdit
                ? <input type="text" inputMode="decimal" data-testid="fee-pct" aria-invalid={badPct ? 'true' : 'false'} value={t.feePct} onChange={e => { const next = window.CDOS_CHEQUE_FEE.feePctText(e.target.value); if (next != null) set(t.id, 'feePct', next); }} onBlur={() => { const committed = window.CDOS_CHEQUE_FEE.feePctCommit(t.feePct); if (committed == null) return; if (committed !== '') { set(t.id, 'feePct', committed); return; } const saved = (schedule || []).find(row => row.id === t.id); const shown = saved ? window.CDOS_CHEQUE_FEE.feePctShown(saved.feePct) : null; set(t.id, 'feePct', shown == null ? (saved ? saved.feePct : '') : shown); }} className="fee-field w-16 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums', outline: badPct ? `2px solid ${CD.amber}` : 'none' }} />
                : <span style={cell}>{window.CDOS_CHEQUE_FEE.feePctShown(t.feePct) || t.feePct}</span>}</td>
              <td className="px-3 py-2 text-right">{mayEdit
                ? <input type="text" inputMode="decimal" data-testid="fee-min" aria-invalid={badMin ? 'true' : 'false'} value={money2(t.feeMin)} onChange={e => set(t.id, 'feeMin', e.target.value.replace(/[^\d.]/g, ''))} onBlur={e => { const shown = window.CDOS_CHEQUE_FEE.moneyShown(e.target.value); if (shown == null) return; set(t.id, 'feeMin', shown); }} className="fee-field w-20 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums', outline: badMin ? `2px solid ${CD.amber}` : 'none' }} />
                : <span style={cell}>{money2(t.feeMin)}</span>}</td>
              <td className="px-3 py-2 text-right">{mayEdit
                ? <input type="number" value={t.holdDays} onChange={e => set(t.id, 'holdDays', +e.target.value)} className="fee-field w-14 text-right px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontVariantNumeric: 'tabular-nums' }} />
                : <span style={cell}>{t.holdDays}</span>}</td>
              <td className="px-3 py-2 text-right" data-testid="fee-example" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money2(eg)} {homeCcy()}</td>
            </tr>); })}</tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>Government and certified cheques clear fast and cheap; personal cheques carry the longest hold and the widest fee because they're the most likely to bounce.</p>
      {mayEdit && <div className="mt-3">
        {refused && <p role="alert" data-testid="fee-schedule-refused" className="fee-lock fee-banner mb-2 px-3 py-2 text-[12px]" style={{ background: CD.amberSoft, borderRadius: 8 }}><Ic n="lock" s={13} c={CD.amber} /> {FEE_BANNER}</p>}{places && <p role="alert" data-testid="fee-schedule-places" className="fee-lock fee-banner mb-2 px-3 py-2 text-[13px]" style={{ background: CD.amberSoft, borderRadius: 8 }}><Ic n="alert" s={13} c={CD.amber} /> {places.detail}</p>}{trouble && <p role="alert" data-testid="fee-schedule-error" className="fee-lock fee-banner mb-2 px-3 py-2 text-[12px]" style={{ background: CD.amberSoft, borderRadius: 8 }}>That change didn't save. Try again.</p>}
        {conflict && <p role="alert" data-testid="fee-schedule-conflict" className="fee-lock fee-banner fee-conflict mb-2 px-3 py-2 text-[12px]" style={{ background: CD.amberSoft, borderRadius: 8 }}>{FEE_CONFLICT} <button type="button" data-testid="fee-schedule-reload" onClick={async () => { try { const res = await fetch('/api/tenant/state', { credentials: 'same-origin' }); if (!res.ok) throw new Error('reload'); const body = await res.json(); const persist = window.CDOS_PERSIST; if (persist && persist.noteVersion && body && typeof body.version === 'number') persist.noteVersion(body.version); const raw = body && body.state ? body.state[SKEY] : null; const next = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : schedule); setDraft(shownSchedule(next)); setSchedule(next); setConflict(false); setTrouble(false); } catch (e) { setTrouble(true); } }} className="fee-reload">Reload</button></p>}
        <div className="flex items-center gap-2">
          <button type="button" data-testid="fee-schedule-save" onClick={save} disabled={busy} className="fee-save px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9, opacity: busy ? 0.6 : 1 }}>Save</button>
          {saved && <span data-testid="fee-schedule-saved" className="text-[12px] font-semibold" style={{ color: CD.green }}>Saved</span>}
        </div>
      </div>}
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Cheques({ rows, setRows, clients, settings, me, log, cheques: pChq, setCheques: pSetChq, schedule: pSched, setSchedule: pSetSched, captureSignal, serverBacked, onTillChanged, onRefreshCheques }) {
    const [tab, setTab] = useState('clearing');
    // cheques + schedule are lifted to the OS shell so the Ledger shares them;
    // fall back to local stores if mounted standalone.
    const [lChq, lSetChq] = useState(() => (K.ledger() ? [] : load(KKEY, defaultCheques)));
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
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Cheques</div><div className="text-[11px]" style={{ color: CD.mute }}>{fmt(exposure, homeCcy())} at risk{overdue ? ` · ${overdue} overdue` : ''}</div></div>
          </div>
          <button onClick={() => setModal(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Cash a cheque</button>
        </div>
        <div className="fld-bar" style={{ margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => { const badge = id === 'clearing' && overdue ? overdue : 0; return (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>); })}
        </div>
      </div>

      <div className="flex-1 overflow-auto" style={{ minWidth: 0 }}>
        {tab === 'clearing' && <Clearing cheques={cheques} onOpen={setDetailId} onNew={() => setModal(true)} />}
        {tab === 'schedule' && <FeeSchedule schedule={schedule} setSchedule={setSchedule} me={me} />}
      </div>

      {modal && <CaptureModal {...{ rows, setRows, clients, settings, schedule, me, log, cheques, setCheques, onTillChanged }} onClose={() => setModal(false)} onDone={(id) => { setModal(false); setTab('clearing'); setDetailId(id); }} />}
      {detail && <ChequeDetail c={detail} me={me} log={log} setCheques={setCheques} onTillChanged={onTillChanged} onClose={() => setDetailId(null)} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Cheques });
})();
