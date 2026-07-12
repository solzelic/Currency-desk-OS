/* ============================================================
   CurrencyDesk OS — Ledger (records-grade)
   Immutable transaction records. New deals are created through a
   guided modal (TxModal) that can create a client inline and shows
   live compliance before anything is committed. Saved records can be
   inspected/annotated/voided in a detail drawer (TxDetail) but never
   silently edited or deleted — every change is appended to the audit
   log, which is what makes the book examiner-ready.
   ============================================================ */
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const {
    CD, Ic, TYPES, CCY, THRESHOLD, TODAY, crossRate, perCadLive, fmt, num, mkRef, nowTime, newTx,
    computeFlags, dDiff, makeSearch, SEARCH_EXAMPLES, priceDeal, spreadOf, dealMargin, CommitBtn
  } = window.CDOS;

  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  // overlays portal to the document root so the window's stacking context
  // (and the rate ticker at z-360) can't occlude them
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const ID_TYPES = ["Driver's Licence", 'Passport', 'Provincial ID', 'PR Card', 'Business Number'];

  /* ---------- small shared UI ---------- */
  function StatCard({ label, value, sub, flag, active, onClick }) {
    return (
      <button onClick={onClick} disabled={!onClick}
        className="text-left px-5 py-3.5"
        style={{ borderRight: `1px solid ${CD.lineSoft}`, background: active ? 'var(--cd-chip)' : 'transparent', cursor: onClick ? 'pointer' : 'default', transition: 'background .12s' }}>
        <div className="text-[11px] flex items-center gap-1.5" style={{ color: CD.mute }}>{label}{active && <Ic n="x" s={11} c={CD.mute} />}</div>
        <div className="text-lg font-semibold leading-tight" style={{ color: flag ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {sub && <div className="text-[10px] mt-0.5" style={{ color: CD.faint }}>{sub}</div>}
      </button>
    );
  }
  /* ---- Compliance-workspace list primitives — defined at MODULE scope so their
     component identity is STABLE. When they lived inside LedgerCompliance, every
     re-render (e.g. the window focusing itself on pointer-down) created new
     component types, so React unmounted/remounted the whole list mid-click and
     the button's click never fired. Hoisting keeps the DOM nodes in place. ---- */
  function CompKpi({ label, value, tone }) {
    return (<div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div><div className="text-2xl font-bold mt-0.5" style={{ color: tone || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div></div>);
  }
  function CompItem({ r, onOpenDetail, cadIn, children }) {
    return (<div className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${CD.lineSoft}`, borderRadius: 10 }}>
      <button onClick={() => onOpenDetail(r.id)} className="text-left flex-1 min-w-0">
        <div className="text-[13px] font-medium" style={{ color: CD.ink }}>{r.customer || '—'} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>· {r.ref}</span></div>
        <div className="text-[11px]" style={{ color: CD.mute }}>{r.type} · {fmt(cadIn(r), 'CAD')} · {r.date} {r.time}</div>
      </button>
      <div className="flex items-center gap-1.5 flex-none"><button onClick={() => onOpenDetail(r.id)} title="View this record" className="flex items-center gap-1 text-[11px] font-medium px-2 py-1.5" style={{ borderRadius: 7, border: `1px solid ${CD.line}`, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="scroll" s={13} c={CD.mute} /> View records</button>{children}</div>
    </div>);
  }
  function CompGroup({ title, tone, items, empty, info }) {
    return (<div className="mb-4">
      <div className="flex items-center gap-2 mb-2">{info && <window.CDOS.InfoTip title={info.title} body={info.body} />}<span className="text-[12px] font-semibold" style={{ color: CD.ink }}>{title}</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: items.length ? (tone || CD.ink) : CD.lineSoft, color: items.length ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{items.length}</span></div>
      {items.length ? <div className="space-y-1.5">{items}</div> : <div className="text-[12px] px-3 py-2.5" style={{ color: CD.faint, background: CD.panel, border: `1px dashed ${CD.line}`, borderRadius: 10 }}>{empty}</div>}
    </div>);
  }
  function Chip({ on, onClick, c, bg, children }) {
    return (<button onClick={onClick} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 font-medium" style={{ background: on ? (bg || CD.ink) : 'transparent', color: on ? (c || 'var(--cd-on-ink)') : CD.mute, border: `1px solid ${on ? 'transparent' : CD.line}`, borderRadius: 8 }}>{children}</button>);
  }
  function FlagTag({ kind, filed, ack, onClick, title }) {
    const map = {
      RPT: filed ? ['FILED', CD.green, CD.greenSoft, 'checkcircle'] : ['REPORT', CD.flag, CD.flagSoft, 'alert'],
      STR: ack ? ['STR ✓', CD.mute, CD.lineSoft, 'check'] : ['STR', CD.amber, CD.amberSoft, 'alert'],
      ID:  ['ID', CD.ink, CD.lineSoft, 'id']
    };
    const [t, c, bg, icon] = map[kind];
    return (<button onClick={onClick} title={title} className="flex items-center gap-1 text-[10px] px-1.5 py-1 font-semibold" style={{ background: bg, color: c, borderRadius: 5, fontFamily: 'Space Mono, monospace', letterSpacing: '0.02em' }}><Ic n={icon} s={11} c={c} /> {t}</button>);
  }
  function DRow({ k, v, mono, accent, onClick }) { return (<div className="flex justify-between items-baseline gap-4 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="text-[12px] flex-none whitespace-nowrap" style={{ color: CD.mute }}>{k}</span>{onClick ? <button onClick={onClick} className="text-sm font-medium text-right hover:underline inline-flex items-center gap-1" style={{ color: accent || CD.ink }} title="Open KYC profile">{v}<Ic n="arrowright" s={12} c={CD.faint} /></button> : <span className="text-sm font-medium text-right" style={{ color: accent || CD.ink, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{v}</span>}</div>); }
  function Field({ label, hint, children }) { return (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</label>); }
  const inputCls = "w-full text-sm px-2.5 py-2 outline-none";
  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };

  /* =====================================================================
     CUSTOMER CARD — the "who is this" panel that fills in the moment a known
     client is picked in the New-Transaction flow. Pulls their KYC status and
     their history with this desk so the teller has the whole picture without
     leaving the counter.
  ===================================================================== */
  function CustomerCard({ name, rec, live, settings }) {
    const s = useMemo(() => {
      const h = live.filter(r => r.customer === name);
      const cadOf = (amt, ccy) => ccy === 'CAD' ? (+amt || 0) : (+amt || 0) / (crossRate('CAD', ccy) || 1);
      const winDays = (settings && settings.structuringDays) || 30;
      const cutoff = new Date(Date.now() - winDays * 86400000).toISOString().slice(0, 10);
      let total = 0, windowCad = 0; const ccyCount = {};
      h.forEach(r => {
        const cad = cadOf(r.inAmt, r.inCcy); total += cad;
        if (r.date >= cutoff) windowCad += cad;
        const c = (r.outCcy && r.outCcy !== 'CAD') ? r.outCcy : (r.inCcy !== 'CAD' ? r.inCcy : null);
        if (c) ccyCount[c] = (ccyCount[c] || 0) + 1;
      });
      const lastVisit = h.reduce((m, r) => r.date > m ? r.date : m, '');
      const topCcy = Object.keys(ccyCount).sort((a, b) => ccyCount[b] - ccyCount[a])[0] || null;
      const daysSince = lastVisit ? Math.round((Date.parse(TODAY) - Date.parse(lastVisit)) / 86400000) : null;
      return { count: h.length, total, windowCad, winDays, lastVisit, daysSince, topCcy };
    }, [name, live, settings]);

    const idMissing = !rec || !rec.idType || !rec.idNum;
    const idExpired = rec && rec.idExpiry && rec.idExpiry < TODAY;
    const idOk = !idMissing && !idExpired;
    const idTone = idOk ? CD.green : CD.flag;
    const idLabel = idMissing ? 'No ID on file' : idExpired ? 'ID expired' : 'ID verified';
    const maskedId = rec && rec.idNum ? '••••' + String(rec.idNum).slice(-3) : '';
    const regular = s.count >= 3;
    const initials = name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const nearThreshold = s.windowCad >= THRESHOLD * 0.7 && s.windowCad < THRESHOLD;
    const overThreshold = s.windowCad >= THRESHOLD;
    const lastLabel = s.daysSince == null ? 'First visit' : s.daysSince === 0 ? 'In today already' : s.daysSince === 1 ? 'Yesterday' : `${s.daysSince} days ago`;

    return (
      <div className="mt-2 overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 11, background: 'var(--cd-panel)' }}>
        {/* identity strip */}
        <div className="flex items-center gap-3 px-3.5 py-3" style={{ background: CD.lineSoft, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none font-semibold" style={{ width: 38, height: 38, borderRadius: 10, background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 14, letterSpacing: '0.02em' }}>{initials}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold truncate" style={{ color: CD.ink }}>{name}</span>
              {regular && <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 flex-none" style={{ background: CD.amberSoft, color: 'var(--cd-brass-text)', borderRadius: 999, fontWeight: 600 }}><Ic n="star" s={10} c="var(--cd-brass-text)" /> Regular</span>}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{s.count > 0 ? <>{s.count} deal{s.count !== 1 ? 's' : ''} · {lastLabel}</> : 'No prior deals at this desk'}</div>
          </div>
          <span className="flex items-center gap-1 text-[11px] px-2 py-1 flex-none font-medium" style={{ background: idOk ? CD.greenSoft : CD.flagSoft, color: idTone, borderRadius: 999 }}><Ic n={idOk ? 'checkcircle' : 'alert'} s={12} c={idTone} /> {idLabel}</span>
        </div>

        {/* facts */}
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <CCstat label="ID on file" value={idMissing ? '—' : (rec.idType || 'ID')} sub={idMissing ? 'collect below' : (maskedId + (rec.idExpiry ? ` · exp ${rec.idExpiry}` : ''))} tone={idMissing ? CD.flag : idExpired ? CD.flag : CD.ink} />
          <CCstat label={`Last ${s.winDays}d`} value={fmt(s.windowCad, 'CAD')} sub={overThreshold ? 'over reporting line' : nearThreshold ? 'nearing the line' : 'within range'} tone={overThreshold ? CD.flag : nearThreshold ? CD.amber : CD.ink} divider />
          <CCstat label="Usually buys" value={s.topCcy || '—'} sub={s.count > 0 ? `lifetime ${fmt(s.total, 'CAD')}` : 'new customer'} tone={CD.ink} divider />
        </div>

        {(overThreshold || nearThreshold) && (
          <div className="flex items-center gap-1.5 px-3.5 py-2 text-[11px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, background: overThreshold ? CD.flagSoft : CD.amberSoft, color: overThreshold ? CD.flag : 'var(--cd-brass-text)' }}>
            <Ic n="shield" s={12} c={overThreshold ? CD.flag : 'var(--cd-brass-text)'} />
            {overThreshold ? `Already ${fmt(s.windowCad, 'CAD')} in ${s.winDays} days — watch for structuring on this deal.` : `${fmt(s.windowCad, 'CAD')} in ${s.winDays} days — getting close to the ${fmt(THRESHOLD, 'CAD')} line.`}
          </div>
        )}
      </div>
    );
  }
  function CCstat({ label, value, sub, tone, divider }) {
    return (
      <div className="px-3.5 py-2.5" style={{ borderLeft: divider ? `1px solid ${CD.lineSoft}` : 'none' }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
        <div className="text-[13px] font-semibold leading-tight mt-0.5 truncate" style={{ color: tone || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        {sub && <div className="text-[10px] mt-0.5 truncate" style={{ color: CD.faint }}>{sub}</div>}
      </div>
    );
  }

  /* =====================================================================
     PRESENT QUOTE — turn-the-screen customer-facing view. The customer is
     standing at the counter; this is the big, unambiguous "here's your deal"
     they read and agree to before you post it. Esc or the button returns.
  ===================================================================== */
  function PresentQuote({ q, onClose }) {
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
    const sideLabel = q.side === 'buy' ? `We buy ${q.inCcy}` : q.side === 'sell' ? `We sell ${q.outCcy}` : `${q.inCcy} → ${q.outCcy}`;
    return ReactDOM.createPortal(
      <div className="fixed inset-0" style={{ zIndex: 99999, background: CD.ink, display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center justify-between px-10 pt-8 pb-4" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}>
          <div>
            <div style={{ fontFamily: 'Space Mono, monospace', fontSize: 13, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--cd-on-ink-soft)' }}>{q.biz}</div>
            <div style={{ fontWeight: 800, fontSize: 30, color: 'var(--cd-on-ink)', letterSpacing: '-0.02em', marginTop: 4 }}>Your quote</div>
          </div>
          <span className="px-3 py-1.5" style={{ fontFamily: 'Space Mono, monospace', fontSize: 13, color: 'var(--cd-on-ink)', background: 'var(--cd-on-ink-faint)', borderRadius: 999 }}>{sideLabel}</span>
        </div>

        <div className="flex-1 flex flex-col justify-center" style={{ gap: 30, padding: '24px 10vw' }}>
          <div>
            <div style={{ fontSize: 17, color: 'var(--cd-on-ink-soft)' }}>You give</div>
            <div style={{ fontWeight: 800, fontSize: 'clamp(48px, 9vw, 96px)', letterSpacing: '-0.02em', color: 'var(--cd-on-ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.02 }}>{num(q.inAmt)} <span style={{ fontWeight: 500, fontSize: '0.45em', color: 'var(--cd-on-ink-soft)' }}>{q.inCcy}</span></div>
          </div>
          <div className="flex items-center gap-4" style={{ color: 'var(--cd-on-ink-soft)' }}>
            <span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span>
            <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 16 }}>1 {q.inCcy} = {num(q.rate)} {q.outCcy}</span>
            <span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span>
          </div>
          <div>
            <div style={{ fontSize: 17, color: 'var(--cd-on-ink-soft)' }}>You receive</div>
            <div style={{ fontWeight: 800, fontSize: 'clamp(48px, 9vw, 96px)', letterSpacing: '-0.02em', color: '#7fd1a3', fontVariantNumeric: 'tabular-nums', lineHeight: 1.02 }}>{num(q.outAmt)} <span style={{ fontWeight: 500, fontSize: '0.45em', color: 'rgba(127,209,163,0.7)' }}>{q.outCcy}</span></div>
          </div>
        </div>

        <div className="flex items-center justify-between px-10 py-6" style={{ borderTop: '1px solid var(--cd-on-ink-faint)', background: 'var(--cd-ink-strong)' }}>
          <span style={{ color: 'var(--cd-on-ink-soft)', fontSize: 14 }}>{q.fee > 0 ? `Includes ${fmt(q.fee, 'CAD')} service fee · ` : ''}{q.held ? `Rate held until ${q.held}` : 'Rate as quoted now — moves with the market'}</span>
          <button onClick={onClose} className="flex items-center gap-2 px-5 py-2.5 font-semibold" style={{ background: 'var(--cd-panel)', color: CD.ink, borderRadius: 10 }}><Ic n="arrowleft" s={16} c={CD.ink} /> Back to desk</button>
        </div>
      </div>, document.body);
  }

  /* =====================================================================
     NEW TRANSACTION MODAL — the guided "anyone can do it" flow
  ===================================================================== */
  function TxModal({ rows, clients, setClients, setRows, settings, me, log, onClose, onDone, prefillClient, rateVersion, cheques, setCheques, chequeSchedule, onOpenCheques }) {
    const live = useMemo(() => rows.filter(r => r.status !== 'void'), [rows]);
    const names = useMemo(() => {
      const s = new Set(Object.keys(clients)); live.forEach(r => r.customer && s.add(r.customer));
      return Array.from(s).sort();
    }, [clients, live]);

    const [type, setType] = useState('Currency Exchange');
    const [customer, setCustomer] = useState(prefillClient || '');
    const [custQuery, setCustQuery] = useState(prefillClient || '');
    const [custOpen, setCustOpen] = useState(false);
    const [newClient, setNewClient] = useState(false);
    const [nc, setNc] = useState({ idType: '', idNum: '', idExpiry: '' });

    const [inCcy, setInCcy] = useState('CAD');
    const [outCcy, setOutCcy] = useState('USD');
    const [inAmt, setInAmt] = useState('');
    const [override, setOverride] = useState(false);     // teller hand-prices instead of the desk rate
    const [manualRate, setManualRate] = useState('');
    const [lock, setLock] = useState(null);              // rate lock: { rate, until, ref }
    const [nowMs, setNowMs] = useState(Date.now());      // ticks the lock countdown
    const [fee, setFee] = useState(settings && settings.defaultFee != null ? String(settings.defaultFee) : '');
    const [memo, setMemo] = useState('');
    const [present, setPresent] = useState(false);   // turn-the-screen customer quote
    // quick cheque capture (the fast walk-in path; the Cheques desk is the full one)
    const [chequeNumber, setChequeNumber] = useState('');
    const [maker, setMaker] = useState('');
    const [draweeBank, setDraweeBank] = useState('');
    const [chequeTypeId, setChequeTypeId] = useState('payroll');
    // margin-floor override + reportable point-of-sale capture
    const [marginAck, setMarginAck] = useState(false);
    const [marginReason, setMarginReason] = useState('');
    const [cap, setCap] = useState({ purpose: '', source: '', thirdParty: false, thirdPartyName: '' });

    const custWrap = useRef(null);
    useEffect(() => { const h = (e) => { if (custWrap.current && !custWrap.current.contains(e.target)) setCustOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);

    const amtN = parseFloat(inAmt) || 0;
    const isCheque = type === 'Cheque Cashing';
    // a held lock expires on its own; pricing recomputes against the live board
    useEffect(() => { if (!lock) return; const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, [lock]);
    const lockLive = lock && lock.until > nowMs ? lock : null;
    useEffect(() => { if (lock && lock.until <= nowMs) setLock(null); }, [nowMs, lock]);

    // THE pricing call — one source of truth (also drives Reports' earnings)
    const pricing = useMemo(() => priceDeal({
      inCcy, outCcy, inAmt: amtN, settings,
      lockedRate: lockLive && !override ? lockLive.rate : null,
      overrideRate: override && manualRate !== '' ? manualRate : null,
    }), [inCcy, outCcy, amtN, settings, lockLive, override, manualRate, rateVersion]);
    const rateN = pricing.rate;
    // cheque fee comes from the shared fee schedule (same numbers as the Cheques desk)
    const _K = window.CDOS._cheques;
    const chequeSched = chequeSchedule || (_K ? _K.defaultSchedule() : []);
    const chequeType = chequeSched.find(t => t.id === chequeTypeId) || chequeSched[0] || { feePct: 0, feeMin: 0, holdDays: 0, label: 'Cheque' };
    const chequeFee = isCheque && _K ? +_K.feeFor(amtN, chequeType).toFixed(2) : (parseFloat(fee) || 0);
    const outAmt = isCheque ? +(amtN - chequeFee).toFixed(2) : pricing.outAmt;

    // ---- live margin meter: total profit (FX spread + fee) vs the owner's floor ----
    const feeCadN = isCheque ? chequeFee : (parseFloat(fee) || 0);
    const spreadCadLive = isCheque ? 0 : (pricing.marginCad || 0);
    const profitCad = +(spreadCadLive + feeCadN).toFixed(2);
    const marginBasisCad = isCheque ? (inCcy === 'CAD' ? amtN : amtN / (crossRate('CAD', inCcy) || 1)) : (pricing.midCadIn || 0);
    const marginPctLive = marginBasisCad > 0 ? (profitCad / marginBasisCad) * 100 : 0;
    const mTarget = settings && settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const mFloor = settings && settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const mEnforce = (settings && settings.marginEnforce) || 'block';
    const belowFloor = amtN > 0 && marginPctLive < mFloor;
    const needOverride = belowFloor && mEnforce === 'block';
    const marginZone = marginPctLive >= mTarget ? 'good' : (belowFloor ? 'low' : 'warn');
    const zoneColor = marginZone === 'good' ? CD.green : marginZone === 'warn' ? CD.amber : CD.flag;
    const mScaleMax = Math.max(mTarget * 2, mFloor * 2, marginPctLive, 1.5);
    const mPos = (v) => Math.max(0, Math.min(100, (v / mScaleMax) * 100));

    // changing the pair invalidates a lock and any hand-price
    const resetPricing = () => { setLock(null); setOverride(false); setManualRate(''); };
    const swap = () => { setInCcy(outCcy); setOutCcy(inCcy); resetPricing(); };
    const lockRate = () => { const mins = (settings && settings.rateLockMins) || 15; const seq = live.filter(r => r.date === TODAY).length + 1; setOverride(false); setManualRate(''); setLock({ rate: pricing.deskRate, until: Date.now() + mins * 60000, ref: 'Q-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seq).padStart(3, '0'), mins }); };
    const lockSecsLeft = lockLive ? Math.max(0, Math.round((lockLive.until - nowMs) / 1000)) : 0;
    const lockClock = `${Math.floor(lockSecsLeft / 60)}:${String(lockSecsLeft % 60).padStart(2, '0')}`;

    // live compliance preview (in CAD-equivalent for the threshold test)
    const inCadEquiv = inCcy === 'CAD' ? amtN : amtN / (crossRate('CAD', inCcy) || 1);
    const single = inCadEquiv >= THRESHOLD;
    const recentTotal = useMemo(() => {
      if (!customer) return 0;
      return live.filter(o => o.customer === customer).reduce((s, o) => {
        const cad = o.inCcy === 'CAD' ? (+o.inAmt || 0) : (+o.inAmt || 0) / (crossRate('CAD', o.inCcy) || 1);
        return s + cad;
      }, 0) + inCadEquiv;
    }, [customer, live, inCadEquiv]);
    const structuring = !single && customer && recentTotal >= THRESHOLD;
    const rec = clients[customer];
    const kyc = newClient
      ? (nc.idType && nc.idNum ? 'ok' : 'missing ID')
      : (!rec || !rec.idType || !rec.idNum ? 'missing ID' : (rec.idExpiry && rec.idExpiry < TODAY ? 'ID expired' : 'ok'));
    const idRequired = single || inCadEquiv >= 3000;     // FINTRAC: ID at $3k, LCTR at $10k
    const idBlocked = idRequired && kyc !== 'ok';

    const canSave = amtN > 0 && (isCheque ? (maker.trim() && chequeNumber.trim()) : rateN > 0) && (customer || !idRequired) && !idBlocked && (!needOverride || (marginAck && marginReason.trim())) && (!single || (cap.purpose.trim() && cap.source.trim() && (!cap.thirdParty || cap.thirdPartyName.trim())));

    const pickClient = (n) => { setCustomer(n); setCustQuery(n); setCustOpen(false); setNewClient(false); };
    const startNewClient = () => { setNewClient(true); setCustomer(custQuery.trim()); setCustOpen(false); };

    const shownNames = names.filter(n => n.toLowerCase().includes(custQuery.toLowerCase()));

    const record = () => {
      if (!canSave) return;
      // create client inline if needed
      if (newClient && customer) {
        setClients(c => ({ ...c, [customer]: { idType: nc.idType, idNum: nc.idNum, idExpiry: nc.idExpiry, photo: null } }));
        log('Client created', `${customer} · ${nc.idType || 'no ID'}`);
      }
      const seq = live.filter(r => r.date === TODAY).length + 1;
      const ref = mkRef(TODAY, seq);
      const tx = newTx({
        ref, type, customer: customer || 'Walk-in (no client)',
        inCcy, inAmt: amtN, rate: isCheque ? 1 : rateN, outCcy: isCheque ? inCcy : outCcy,
        outAmt: isCheque ? +(amtN - chequeFee).toFixed(2) : outAmt,
        fee: isCheque ? chequeFee : (parseFloat(fee) || 0), teller: me.name, notes: memo,
        // two-sided pricing provenance — the spread booked is the spread reported
        midRate: isCheque ? null : pricing.midRate, spreadCad: isCheque ? 0 : pricing.marginCad,
        side: isCheque ? null : pricing.side, priced: override ? 'override' : (lockLive ? 'locked' : 'desk'),
        quoteRef: lockLive ? lockLive.ref : null,
        marginPct: isCheque ? null : +marginPctLive.toFixed(2), profitCad,
        marginOverride: needOverride ? { by: me.name, at: stamp(), pct: +marginPctLive.toFixed(2), reason: marginReason.trim() } : null,
        capture: single ? { purpose: cap.purpose.trim(), source: cap.source.trim(), thirdParty: cap.thirdParty, thirdPartyName: cap.thirdPartyName.trim(), by: me.name, at: stamp() } : null,
        lockedUntil: lockLive ? new Date(lockLive.until).toLocaleString('en-CA', { hour12: false }).replace(',', '') : null,
        createdBy: me.name, createdAt: stamp(),
        thread: memo ? [{ ts: stamp(), user: me.name, text: memo }] : []
      });
      setRows(r => [tx, ...r]);
      // a cashed cheque feeds the SAME clearance system the Cheques desk uses
      if (isCheque && setCheques && _K) {
        const net = +(amtN - chequeFee).toFixed(2);
        const holdUntil = _K.addDays(TODAY, chequeType.holdDays || 0);
        const seqC = (cheques || []).filter(c => c.receivedDate === TODAY).length + 1;
        const cref = 'CHQ-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seqC).padStart(3, '0');
        const chq = { id: 'c' + Date.now(), ref: cref, chequeNumber: chequeNumber.trim(), maker: maker.trim(), draweeBank: draweeBank.trim(), customer: customer || 'Walk-in (no client)', typeId: chequeType.id, typeLabel: chequeType.label, ccy: 'CAD', amount: amtN, feeCad: chequeFee, netCad: net, endorsed: true, image: null, holdDays: chequeType.holdDays || 0, receivedDate: TODAY, holdUntil, status: 'held', nsf: false, fraud: false, timeline: [{ status: 'held', ts: stamp(), by: me.name, note: `Cashed at the till · ${(chequeType.holdDays || 0) === 0 ? 'no hold' : chequeType.holdDays + '-day hold'}` }], txId: tx.id, txRef: ref, createdBy: me.name };
        setCheques(list => [chq, ...(list || [])]);
      }
      log('Transaction recorded', `${ref} · ${customer || 'walk-in'} · ${num(amtN)} ${inCcy} → ${num(tx.outAmt)} ${tx.outCcy}${isCheque ? ' · cheque on hold' : ''}${single ? ' · REPORTABLE' : ''}${needOverride ? ' · below-floor override' : ''}`);
      onDone && onDone(tx.id);
    };

    // printable customer quote — the rate-lock take-away
    const printQuote = () => {
      const lk = lockLive; const mins = (settings && settings.rateLockMins) || 15;
      const ref = lk ? lk.ref : 'Q-' + String(TODAY).slice(2).replace(/-/g, '') + '-PRE';
      const until = lk ? new Date(lk.until).toLocaleString('en-CA', { hour12: false }).replace(',', '') : `${mins} min from print`;
      const sideLabel = pricing.side === 'buy' ? `We buy ${inCcy}` : pricing.side === 'sell' ? `We sell ${outCcy}` : `${inCcy} → ${outCcy} cross`;
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      const biz = (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk';
      const w = window.open('', '_blank', 'width=460,height=720');
      if (!w) { log('Quote blocked', 'Allow pop-ups to print the quote'); return; }
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quote ${esc(ref)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:'Space Mono',ui-monospace,monospace;margin:0;padding:26px 24px;color:#0a0a0a;max-width:380px}
.h{text-align:center;border-bottom:2px solid #0a0a0a;padding-bottom:12px;margin-bottom:14px}.h .b{font-family:'Archivo';font-weight:800;font-size:17px}.h .s{font-size:10px;color:#777;margin-top:2px;text-transform:uppercase;letter-spacing:.08em}
.tag{display:inline-block;font-size:10px;font-weight:700;background:#0a0a0a;color:#fff;border-radius:5px;padding:3px 9px;letter-spacing:.04em}
.lock{margin:12px 0;padding:10px 12px;border:1px dashed #9a6b1f;border-radius:8px;background:#f5e8cf;color:#6b5119;font-size:11px;text-align:center}
.lock b{font-size:15px;font-family:'Archivo'}
.big{text-align:center;margin:16px 0}.big .o{font-size:11px;color:#777}.big .v{font-size:30px;font-weight:800;font-family:'Archivo';letter-spacing:-.01em}.big .v.grn{color:#1f8a4c}
.r{display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-top:1px solid #eee}.r .k{color:#777}.mut{color:#999}
.ft{margin-top:16px;border-top:1px dashed #ccc;padding-top:10px;font-size:9.5px;color:#999;text-align:center;line-height:1.5}
@page{margin:8mm}</style></head><body>
<div class="h"><div class="b">${esc(biz)}</div><div class="s">Currency quote · ${esc(ref)}</div></div>
<div style="text-align:center"><span class="tag">${esc(sideLabel)}</span></div>
<div class="lock">RATE LOCKED &nbsp; <b>1 ${esc(inCcy)} = ${num(pricing.rate)} ${esc(outCcy)}</b><br/>held until ${esc(until)}</div>
<div class="big"><div class="o">Customer gives</div><div class="v">${num(amtN)} ${esc(inCcy)}</div></div>
<div class="big"><div class="o">Customer receives</div><div class="v grn">${num(outAmt)} ${esc(outCcy)}</div></div>
<div class="r"><span class="k">Locked rate</span><span>${num(pricing.rate)} ${esc(outCcy)}/${esc(inCcy)}</span></div>
<div class="r"><span class="k">Spot reference</span><span class="mut">${num(pricing.midRate)}</span></div>
${(parseFloat(fee)||0)>0?`<div class="r"><span class="k">Commission</span><span>${fmt(fee,'CAD')}</span></div>`:''}
<div class="r"><span class="k">Quoted</span><span class="mut">${esc(stamp())}</span></div>
<div class="ft">This quote holds the rate above until the stated time. Final settlement on presentation. Not a receipt of sale.<br/>${esc((settings && settings.receiptDisclaimer) || 'Rates as quoted at time of transaction.')}</div>
<script>setTimeout(function(){window.focus();window.print();},350)<\/script>
</body></html>`);
      w.document.close();
      log('Quote printed', `${ref} · ${num(amtN)} ${inCcy} → ${num(outAmt)} ${outCcy}`);
    };

    return ReactDOM.createPortal((
      <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }} onMouseDown={onClose}>
        <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 560, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
          {/* header */}
          <div className="flex-none flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
            <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="plus" s={17} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>New transaction</div><div className="text-[11px]" style={{ color: CD.mute }}>Teller {me.name} · {TODAY}</div></div></div>
            <button onClick={onClose} className="p-1.5" style={{ borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
            {/* type */}
            <Field label="Transaction type">
              <div className="flex flex-wrap gap-1.5">
                {TYPES.map(t => <button key={t} onClick={() => setType(t)} className="text-xs px-2.5 py-1.5 font-medium" style={{ borderRadius: 8, border: `1px solid ${type === t ? CD.ink : CD.line}`, background: type === t ? CD.ink : 'var(--cd-panel)', color: type === t ? 'var(--cd-on-ink)' : CD.text }}>{t}</button>)}
              </div>
            </Field>

            {/* customer combobox */}
            <Field label="Customer" hint={newClient ? 'creating new client' : 'search or add'}>
              <div ref={custWrap} className="relative">
                <div className="flex items-center gap-2 px-2.5 py-2" style={{ ...inputSty }}>
                  <Ic n={newClient ? 'userplus' : 'search'} s={15} c={CD.mute} />
                  <input value={custQuery} onFocus={() => setCustOpen(true)} onChange={e => { setCustQuery(e.target.value); setCustomer(e.target.value); setCustOpen(true); setNewClient(false); }} placeholder="Type a name…" className="w-full outline-none text-sm bg-transparent" />
                  {custQuery && <button onClick={() => { setCustQuery(''); setCustomer(''); setNewClient(false); }}><Ic n="x" s={14} c={CD.mute} /></button>}
                </div>
                {custOpen && (
                  <div className="absolute left-0 right-0 mt-1 py-1 max-h-52 overflow-auto" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10, boxShadow: '0 12px 30px var(--cd-shade)', zIndex: 20 }}>
                    {shownNames.map(n => { const st = (!clients[n] || !clients[n].idType) ? 'missing ID' : (clients[n].idExpiry && clients[n].idExpiry < TODAY ? 'ID expired' : 'verified'); const ok = st === 'verified'; return (
                      <button key={n} onClick={() => pickClient(n)} className="w-full flex items-center justify-between px-3 py-2 text-left text-sm" style={{ color: CD.ink }} onMouseDown={e => e.preventDefault()}>
                        <span>{n}</span><span className="text-[10px] px-1.5 py-0.5" style={{ borderRadius: 4, background: ok ? CD.greenSoft : CD.flagSoft, color: ok ? CD.green : CD.flag }}>{st}</span>
                      </button>); })}
                    {shownNames.length === 0 && <div className="px-3 py-2 text-[11px]" style={{ color: CD.faint }}>No match.</div>}
                    <button onClick={startNewClient} onMouseDown={e => e.preventDefault()} className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium" style={{ color: CD.ink, borderTop: `1px solid ${CD.lineSoft}` }}><Ic n="userplus" s={15} /> Create new client{custQuery ? ` "${custQuery.trim()}"` : ''}</button>
                  </div>
                )}
              </div>
              {newClient && (
                <div className="mt-2 p-3 grid grid-cols-2 gap-2" style={{ background: 'var(--cd-panel)', border: `1px dashed ${CD.line}`, borderRadius: 10 }}>
                  <div className="col-span-2 text-[11px] flex items-center gap-1.5" style={{ color: CD.mute }}><Ic n="id" s={13} /> New client KYC — saved to the client file on record</div>
                  <select value={nc.idType} onChange={e => setNc(s => ({ ...s, idType: e.target.value }))} className="text-sm px-2 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-panel)' }}><option value="">ID type…</option>{ID_TYPES.map(o => <option key={o}>{o}</option>)}</select>
                  <input value={nc.idNum} onChange={e => setNc(s => ({ ...s, idNum: e.target.value }))} placeholder="ID number" className="text-sm px-2 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7 }} />
                  <Field label="ID expiry"><input type="date" value={nc.idExpiry} onChange={e => setNc(s => ({ ...s, idExpiry: e.target.value }))} className="w-full text-sm px-2 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7 }} /></Field>
                </div>
              )}
            </Field>

            {/* who is this — fills in the moment a known client is picked */}
            {!newClient && customer && clients[customer] && (
              <CustomerCard name={customer} rec={clients[customer]} live={live} settings={settings} />
            )}

            {/* exchange — two-sided pricing */}
            <div className="p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
              <Field label={isCheque ? 'Cheque amount' : 'Customer pays in'}>
                <div className="flex" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, overflow: 'hidden' }}>
                  <select value={inCcy} onChange={e => { setInCcy(e.target.value); resetPricing(); }} className="px-2 outline-none font-semibold text-sm" style={{ borderRight: `1px solid ${CD.line}`, background: 'var(--cd-chip)' }}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                  <input value={inAmt} onChange={e => setInAmt(e.target.value)} inputMode="decimal" autoFocus placeholder="0.00" className="flex-1 min-w-0 px-3 py-2.5 text-xl font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums' }} />
                </div>
              </Field>

              {!isCheque && (<>
                {/* side + rate line */}
                <div className="flex items-center justify-center gap-2 py-2">
                  <span className="text-[10px] px-2 py-0.5 font-semibold uppercase tracking-wide" style={{ borderRadius: 5, background: pricing.side === 'buy' ? CD.flagSoft : pricing.side === 'sell' ? CD.greenSoft : CD.lineSoft, color: pricing.side === 'buy' ? CD.flag : pricing.side === 'sell' ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>
                    {pricing.side === 'buy' ? `We buy ${inCcy}` : pricing.side === 'sell' ? `We sell ${outCcy}` : 'Cross'}
                  </span>
                  <span className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>1 {inCcy} = {rateN ? num(rateN) : '—'} {outCcy}</span>
                  <button onClick={swap} title="Swap direction" className="p-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7 }}><Ic n="swap" s={13} c={CD.mute} /></button>
                </div>
                <Field label="Customer receives">
                  <div className="flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
                    <select value={outCcy} onChange={e => { setOutCcy(e.target.value); resetPricing(); }} className="px-2 outline-none font-semibold text-sm" style={{ borderRight: `1px solid ${CD.line}`, background: 'var(--cd-chip)' }}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                    <div className="flex-1 px-3 py-2.5 text-xl font-semibold text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green }}>{outAmt ? num(outAmt) : '—'}</div>
                  </div>
                </Field>
                {amtN > 0 && pricing.outAmtRaw && Math.abs(pricing.outAmtRaw - outAmt) > 0.004 && (
                  <div className="text-[10.5px] mt-1 text-right" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>rounded from {num(pricing.outAmtRaw)} {outCcy}</div>
                )}
              </>)}

              {isCheque ? (
                <div className="mt-2 space-y-2">
                  <Field label="Cheque type" hint={`${chequeType.feePct}% · min ${fmt(chequeType.feeMin, 'CAD')} · ${chequeType.holdDays}d hold`}>
                    <div className="flex flex-wrap gap-1.5">
                      {chequeSched.map(t => { const on = chequeTypeId === t.id; return <button key={t.id} onClick={() => setChequeTypeId(t.id)} className="px-2.5 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.text }}>{t.label}</button>; })}
                    </div>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Cheque number"><input value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} placeholder="e.g. 004821" className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty} /></Field>
                    <Field label="Drawee bank"><input value={draweeBank} onChange={e => setDraweeBank(e.target.value)} placeholder="e.g. RBC" className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty} /></Field>
                  </div>
                  <Field label="Maker (who wrote it)"><input value={maker} onChange={e => setMaker(e.target.value)} placeholder="Payer name / business" className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty} /></Field>
                  <div className="flex items-center justify-between gap-2 p-2.5" style={{ background: CD.amberSoft, borderRadius: 9 }}>
                    <span className="text-[11px]" style={{ color: 'var(--cd-brass-text)' }}>{amtN > 0 ? <>Front <b>{fmt(outAmt, 'CAD')}</b> · keep <b>{fmt(chequeFee, 'CAD')}</b>{(chequeType.holdDays || 0) > 0 && _K ? <> · holds to {_K.addDays(TODAY, chequeType.holdDays)}</> : ' · no hold'}</> : 'Enter the cheque amount'}</span>
                    {onOpenCheques && <button onClick={() => { onClose(); onOpenCheques(); }} className="text-[11px] font-medium flex-none flex items-center gap-1" style={{ color: CD.ink }}><Ic n="arrowright" s={12} /> Full capture</button>}
                  </div>
                </div>
              ) : (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <Field label="Rate" hint={override ? 'hand-priced' : lockLive ? 'locked' : 'desk price'}>
                  <div className="flex items-center" style={{ ...inputSty, borderColor: lockLive && !override ? CD.amber : override ? CD.ink : CD.line }}>
                    <input value={override ? manualRate : num(rateN)} disabled={!override} onChange={e => setManualRate(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ fontVariantNumeric: 'tabular-nums' }} />
                    {lockLive && !override && <span className="px-1.5 flex-none flex items-center gap-1 text-[10px]" style={{ color: CD.amber, fontFamily: 'Space Mono, monospace' }}><Ic n="lock" s={11} c={CD.amber} />{lockClock}</span>}
                  </div>
                </Field>
                <Field label="Fee (CAD)">
                  <input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inputSty, fontVariantNumeric: 'tabular-nums' }} />
                </Field>
              </div>
              )}

              {!isCheque && (
                <div className="flex items-center justify-end gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  <div className="flex items-center gap-1.5 flex-none">
                    {lockLive
                      ? <button onClick={() => setLock(null)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.amber}`, color: CD.amber, borderRadius: 7 }}><Ic n="lock" s={12} c={CD.amber} /> Unlock</button>
                      : <button onClick={lockRate} disabled={!(rateN > 0) || override} title={override ? 'Turn off hand-pricing to lock the desk rate' : 'Hold this rate for the customer'} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, color: (rateN > 0 && !override) ? CD.ink : CD.faint, borderRadius: 7, cursor: (rateN > 0 && !override) ? 'pointer' : 'not-allowed' }}><Ic n="lock" s={12} /> Lock rate</button>}
                    <button onClick={() => { setOverride(o => !o); if (!override) { setManualRate(num(pricing.deskRate)); setLock(null); } }} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${override ? CD.ink : CD.line}`, background: override ? CD.ink : 'transparent', color: override ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 7 }}><Ic n="pencil" s={11} c={override ? 'var(--cd-on-ink)' : CD.mute} /> {override ? 'Hand-priced' : 'Override'}</button>
                  </div>
                </div>
              )}
            </div>

            {/* live margin meter — total profit vs the owner's floor */}
            {amtN > 0 && (
              <div className="p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${needOverride ? CD.flag : (marginZone === 'good' ? CD.line : zoneColor)}`, borderRadius: 10 }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="activity" s={13} c={zoneColor} /> Margin on this deal</span>
                  <span className="text-[12px] font-bold px-2 py-0.5" style={{ background: marginZone === 'good' ? CD.greenSoft : marginZone === 'warn' ? CD.amberSoft : CD.flagSoft, color: zoneColor, borderRadius: 999, fontVariantNumeric: 'tabular-nums' }}>{marginPctLive.toFixed(2)}%</span>
                </div>
                <div className="relative" style={{ height: 8, borderRadius: 999, overflow: 'hidden', display: 'flex' }}>
                  <div style={{ width: mPos(mFloor) + '%', background: CD.flagSoft }} />
                  <div style={{ width: (mPos(mTarget) - mPos(mFloor)) + '%', background: CD.amberSoft }} />
                  <div style={{ flex: 1, background: CD.greenSoft }} />
                  <div style={{ position: 'absolute', top: -2, bottom: -2, left: `calc(${mPos(marginPctLive)}% - 1px)`, width: 2, background: zoneColor }} />
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px]">
                  <span style={{ color: CD.ink }}>Profit <b style={{ color: zoneColor, fontVariantNumeric: 'tabular-nums' }}>{fmt(profitCad, 'CAD')}</b></span>
                  <span style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{!isCheque ? `spread ${fmt(spreadCadLive, 'CAD')} · ` : ''}fee {fmt(feeCadN, 'CAD')} · floor {mFloor}%</span>
                </div>
                {belowFloor && (
                  <div className="mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${CD.flagSoft}` }}>
                    <div className="text-[12px] font-medium flex items-center gap-1.5 mb-1.5" style={{ color: CD.flag }}><Ic n="alert" s={13} c={CD.flag} /> Below your {mFloor}% floor{spreadCadLive < 0 ? ' — losing on the rate' : ''}.</div>
                    {needOverride ? (<>
                      <label className="flex items-start gap-2 mb-1.5" style={{ color: CD.ink, cursor: 'pointer' }}>
                        <input type="checkbox" checked={marginAck} onChange={e => setMarginAck(e.target.checked)} style={{ marginTop: 2, cursor: 'pointer' }} />
                        <span className="text-[12px]">Override and post below the floor</span>
                      </label>
                      {marginAck && <input value={marginReason} onChange={e => setMarginReason(e.target.value)} placeholder="Reason — e.g. regular client, price match, large volume…" className="w-full text-[12.5px] px-2.5 py-2 outline-none" style={{ ...inputSty, borderColor: marginReason.trim() ? CD.line : CD.flag }} />}
                    </>) : (
                      <div className="text-[11px]" style={{ color: CD.mute }}>You can still post — it's logged for owner review.</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* memo */}
            <Field label="Note (optional)">
              <input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Source of funds, beneficiary, purpose…" className={inputCls} style={inputSty} />
            </Field>

            {/* live compliance preview */}
            {(single || structuring || idRequired) && (
              <div className="p-3 space-y-2" style={{ background: single ? CD.flagSoft : structuring ? CD.amberSoft : CD.lineSoft, borderRadius: 10, border: `1px solid ${single ? CD.flag : structuring ? CD.amber : CD.line}` }}>
                <div className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: single ? CD.flag : structuring ? CD.amber : CD.ink }}><Ic n="shield" s={13} /> Compliance check</div>
                {single && <div className="text-[12px]" style={{ color: CD.ink }}>Reportable — pay-in ≈ {fmt(inCadEquiv, 'CAD')} (≥ {fmt(THRESHOLD, 'CAD')}). A Large Cash Transaction Report will be required.</div>}
                {structuring && <div className="text-[12px]" style={{ color: CD.ink }}>Structuring watch — this client's {settings.structuringDays}-day total reaches {fmt(recentTotal, 'CAD')} with this deal.</div>}
                {idRequired && <div className="text-[12px] flex items-center gap-1.5" style={{ color: kyc === 'ok' ? CD.green : CD.flag }}><Ic n={kyc === 'ok' ? 'checkcircle' : 'alert'} s={13} /> {kyc === 'ok' ? 'Customer ID on file — OK to proceed.' : `ID required at this amount — customer ID is ${kyc}.`}</div>}
              </div>
            )}
            {/* reportable — capture the FINTRAC info at the counter, pre-fills the filing */}
            {single && (
              <div className="p-3 space-y-2.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.flag}`, borderRadius: 10 }}>
                <div className="flex items-center gap-1.5"><Ic n="filetext" s={14} c={CD.flag} /><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Reportable — capture for the {(window.CDOS.getRegime ? window.CDOS.getRegime(settings).largeCode : 'LCTR')}</span></div>
                <div className="text-[11px]" style={{ color: CD.mute }}>This deal is ≥ {fmt(THRESHOLD, 'CAD')}. Capture these now, while the customer is here — it pre-fills the filing in Compliance so nothing is chased down later.</div>
                <Field label="Purpose of transaction"><input value={cap.purpose} onChange={e => setCap(s => ({ ...s, purpose: e.target.value }))} placeholder="e.g. vacation funds, invoice settlement, family support" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inputSty, borderColor: cap.purpose.trim() ? CD.line : CD.flag }} /></Field>
                <Field label="Source of funds"><input value={cap.source} onChange={e => setCap(s => ({ ...s, source: e.target.value }))} placeholder="e.g. employment income, business revenue, savings" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inputSty, borderColor: cap.source.trim() ? CD.line : CD.flag }} /></Field>
                <div>
                  <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Acting on behalf of someone else?</div>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
                      {[['no', 'No'], ['yes', 'Yes']].map(([v, l], i) => { const on = (cap.thirdParty ? 'yes' : 'no') === v; return <button key={v} onClick={() => setCap(s => ({ ...s, thirdParty: v === 'yes' }))} className="text-xs px-3 py-1.5" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none', cursor: 'pointer' }}>{l}</button>; })}
                    </div>
                    {cap.thirdParty && <input value={cap.thirdPartyName} onChange={e => setCap(s => ({ ...s, thirdPartyName: e.target.value }))} placeholder="Name of that person / entity" className="flex-1 min-w-0 text-sm px-2.5 py-2 outline-none" style={{ ...inputSty, borderColor: cap.thirdPartyName.trim() ? CD.line : CD.flag }} />}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* footer */}
          <div className="flex-none flex items-center justify-between gap-3 px-5 py-4" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
            <div className="text-[12px]" style={{ color: CD.mute }}>
              {amtN > 0 ? (<>Give <b style={{ color: CD.ink }}>{num(amtN)} {inCcy}</b>{!isCheque && <> · get <b style={{ color: CD.green }}>{num(outAmt)} {outCcy}</b></>}{(parseFloat(fee) || 0) > 0 && <> · fee {fmt(fee, 'CAD')}</>}</>) : 'Enter an amount to begin'}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
              {!isCheque && <button onClick={() => setPresent(true)} disabled={!(amtN > 0 && rateN > 0)} title="Turn the screen — show this quote to the customer" className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: (amtN > 0 && rateN > 0) ? CD.ink : CD.faint, cursor: (amtN > 0 && rateN > 0) ? 'pointer' : 'not-allowed' }}><Ic n="smartphone" s={15} /> Show customer</button>}
              {!isCheque && <button onClick={printQuote} disabled={!(amtN > 0 && rateN > 0)} title="Print a customer quote with the locked rate" className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: (amtN > 0 && rateN > 0) ? CD.ink : CD.faint, cursor: (amtN > 0 && rateN > 0) ? 'pointer' : 'not-allowed' }}><Ic n="printer" s={15} /> Quote</button>}
              <CommitBtn onCommit={record} disabled={!canSave} icon="check" label="Record transaction" doneLabel="Recorded" title="Post this transaction to the ledger" />
            </div>
          </div>
        </div>
        {present && <PresentQuote q={{ biz: (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk', inCcy, inAmt: amtN, outCcy, outAmt, rate: rateN, fee: parseFloat(fee) || 0, side: pricing.side, held: lockLive ? new Date(lockLive.until).toLocaleString('en-CA', { hour12: false, hour: '2-digit', minute: '2-digit' }) : null }} onClose={() => setPresent(false)} />}
      </div>
    ), document.body);
  }

  /* =====================================================================
     TYPE-AWARE DETAIL — the hero "flow" band and the record facts adapt to
     what kind of transaction this is. An exchange, a remittance, a cheque and
     a bill payment each foreground different information.
  ===================================================================== */
  function FlowCard({ label, amount, ccy, sub, accent }) {
    return (<div className="flex-1 min-w-0 px-4 py-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11 }}>
      <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
      <div className="text-[20px] font-semibold leading-tight whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: accent || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{amount} <span className="text-[13px] font-medium" style={{ color: CD.mute }}>{ccy}</span></div>
      {sub && <div className="text-[12px] mt-0.5 truncate" style={{ color: CD.mute }}>{sub}</div>}
    </div>);
  }
  // split a "Name · Place" beneficiary string
  function benParts(b) { const s = String(b || ''); const i = s.indexOf('·'); return i < 0 ? { name: s.trim(), place: '' } : { name: s.slice(0, i).trim(), place: s.slice(i + 1).trim() }; }
  function TxFlow({ row }) {
    const t = row.type, ben = benParts(row.beneficiary), fee = +row.fee || 0;
    let fromL = 'Paid in', fromV = num(row.inAmt), fromC = row.inCcy, fromS = row.customer || 'Walk-in';
    let toL = 'Paid out', toV = num(row.outAmt), toC = row.outCcy, toS = '';
    let center = '';
    if (t === 'Currency Exchange') {
      fromL = 'We received'; toL = 'We paid out';
      toS = row.side === 'buy' ? `Bought ${row.inCcy}` : row.side === 'sell' ? `Sold ${row.outCcy}` : 'Exchange';
      center = `${row.rate} ${row.outCcy}/${row.inCcy}`;
    } else if (t === 'Remittance — Send') {
      fromL = 'Sender pays'; toL = 'Beneficiary gets';
      toS = ben.name + (ben.place ? ` · ${ben.place}` : '');
      center = `${row.rate} ${row.outCcy}/${row.inCcy}`;
    } else if (t === 'Remittance — Receive') {
      fromL = 'Received'; fromS = `from ${row.inCcy}`;
      toL = 'Paid to recipient'; toS = row.customer || '';
      center = `${row.rate} ${row.outCcy}/${row.inCcy}`;
    } else if (t === 'Cheque Cashing') {
      fromL = 'Cheque face'; fromS = row.notes || 'Cheque deposited';
      toL = 'Cash paid out'; toS = `less ${fmt(fee, 'CAD')} fee`;
      center = `−${fmt(fee, 'CAD')}`;
    } else if (t === 'Money Order') {
      fromL = 'Customer pays'; fromV = num((+row.inAmt || 0) + fee);
      toL = 'Money order issued'; toS = row.notes || 'Bearer instrument';
    } else if (t === 'Bill Payment') {
      fromL = 'Customer pays'; fromV = num((+row.inAmt || 0) + fee);
      toL = 'Paid to biller'; toS = row.notes || 'Biller';
    }
    return (<div className="flex items-stretch gap-2">
      <FlowCard label={fromL} amount={fromV} ccy={fromC} sub={fromS} />
      <div className="flex flex-col items-center justify-center flex-none" style={{ minWidth: 58 }}>
        <Ic n="arrowright" s={18} c={CD.faint} />
        {center && <div className="text-[9.5px] mt-1 text-center leading-tight" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{center}</div>}
      </div>
      <FlowCard label={toL} amount={toV} ccy={toC} sub={toS} accent={CD.green} />
    </div>);
  }
  function TxFacts({ row, onOpenClient }) {
    const t = row.type, ben = benParts(row.beneficiary), fee = +row.fee || 0, cust = row.customer || '';
    const custLabel = t.startsWith('Remittance — Send') ? 'Sender' : t === 'Remittance — Receive' ? 'Recipient' : t === 'Cheque Cashing' ? 'Depositor' : t === 'Money Order' ? 'Purchaser' : t === 'Bill Payment' ? 'Payer' : 'Customer';
    const custRow = <DRow k={custLabel} v={cust || '—'} onClick={cust ? () => onOpenClient && onOpenClient(cust, row.ref) : undefined} />;
    let title = 'Transaction', rows = [];
    if (t === 'Currency Exchange') {
      title = 'Exchange';
      rows = [custRow,
        <DRow k="Rate" v={`${row.rate} ${row.outCcy}/${row.inCcy}`} mono />,
        row.side && <DRow k="Priced" v={`${row.side === 'buy' ? `We bought ${row.inCcy}` : row.side === 'sell' ? `We sold ${row.outCcy}` : 'Cross deal'}${row.priced === 'override' ? ' · hand-priced' : row.priced === 'locked' ? ' · rate locked' : ''}`} />,
        row.midRate && <DRow k="Spot at deal" v={`${row.midRate} ${row.outCcy}/${row.inCcy}`} mono />,
        row.quoteRef && <DRow k="Quote" v={`${row.quoteRef}${row.lockedUntil ? ` · held to ${row.lockedUntil}` : ''}`} mono />];
    } else if (t === 'Remittance — Send') {
      title = 'Remittance — outbound';
      rows = [custRow,
        <DRow k="Beneficiary" v={ben.name || '—'} />,
        ben.place && <DRow k="Destination" v={ben.place} />,
        <DRow k="Beneficiary gets" v={`${num(row.outAmt)} ${row.outCcy}`} mono accent={CD.green} />,
        <DRow k="Exchange rate" v={`${row.rate} ${row.outCcy}/${row.inCcy}`} mono />,
        row.notes && <DRow k="Purpose" v={row.notes} />];
    } else if (t === 'Remittance — Receive') {
      title = 'Remittance — inbound';
      rows = [custRow,
        <DRow k="Received" v={`${num(row.inAmt)} ${row.inCcy}`} mono />,
        <DRow k="Paid to recipient" v={`${num(row.outAmt)} ${row.outCcy}`} mono accent={CD.green} />,
        <DRow k="Exchange rate" v={`${row.rate} ${row.outCcy}/${row.inCcy}`} mono />,
        row.notes && <DRow k="Source / note" v={row.notes} />];
    } else if (t === 'Cheque Cashing') {
      title = 'Cheque';
      rows = [custRow,
        <DRow k="Face value" v={`${num(row.inAmt)} ${row.inCcy}`} mono />,
        <DRow k="Fee withheld" v={fmt(fee, 'CAD')} mono />,
        <DRow k="Net paid out" v={`${num(row.outAmt)} ${row.outCcy}`} mono accent={CD.green} />,
        row.notes && <DRow k="Cheque type" v={row.notes} />];
    } else if (t === 'Money Order') {
      title = 'Money order';
      rows = [custRow,
        <DRow k="Face value" v={`${num(row.inAmt)} ${row.inCcy}`} mono />,
        <DRow k="Service fee" v={fmt(fee, 'CAD')} mono />,
        <DRow k="Total collected" v={fmt((+row.inAmt || 0) + fee, 'CAD')} mono />,
        row.notes && <DRow k="Payee / memo" v={row.notes} />];
    } else if (t === 'Bill Payment') {
      title = 'Bill payment';
      rows = [custRow,
        row.notes && <DRow k="Biller" v={row.notes} />,
        <DRow k="Amount" v={`${num(row.inAmt)} ${row.inCcy}`} mono />,
        <DRow k="Service fee" v={fmt(fee, 'CAD')} mono />,
        <DRow k="Total collected" v={fmt((+row.inAmt || 0) + fee, 'CAD')} mono />];
    } else {
      rows = [custRow, <DRow k="Pay-in" v={`${num(row.inAmt)} ${row.inCcy}`} mono />, <DRow k="Pay-out" v={`${num(row.outAmt)} ${row.outCcy}`} mono accent={CD.green} />];
    }
    rows.push(<DRow k="Booked by" v={`${row.teller || row.createdBy || '—'}`} />);
    return (<div>
      <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{title}</div>
      {rows.filter(Boolean).map((el, i) => React.cloneElement(el, { key: i }))}
    </div>);
  }

  /* =====================================================================
     TRANSACTION DETAIL DRAWER — inspect, annotate, file, void
  ===================================================================== */
  /* =====================================================================
     CORRECTION FLOW — fix a mis-keyed deal without deleting anything.
     The original is voided (kept on file, struck-through, cross-linked as
     "Corrected") and a corrected copy is posted, linked back to the original.
     Reason-coded and fully audit-logged on both records.
  ===================================================================== */
  const CORRECTION_REASONS = [
    { id: 'amount', label: 'Wrong amount', fields: ['inAmt'] },
    { id: 'rate', label: 'Wrong rate', fields: ['rate'] },
    { id: 'currency', label: 'Wrong currency', fields: ['inCcy', 'outCcy'] },
    { id: 'customer', label: 'Wrong customer', fields: ['customer'] },
    { id: 'fee', label: 'Fee error', fields: ['fee'] },
    { id: 'duplicate', label: 'Duplicate — reverse only', fields: [] },
    { id: 'other', label: 'Other', fields: ['inAmt', 'rate', 'fee', 'customer'] }
  ];

  function CorrectionModal({ row, settings, me, clients, setRows, log, onClose, onDone }) {
    const [reason, setReason] = useState('amount');
    const [detail, setDetail] = useState('');
    const [inCcy, setInCcy] = useState(row.inCcy);
    const [outCcy, setOutCcy] = useState(row.outCcy);
    const [inAmt, setInAmt] = useState(String(row.inAmt ?? ''));
    const [rate, setRate] = useState(String(row.rate ?? ''));
    const [fee, setFee] = useState(String(row.fee ?? ''));
    const [customer, setCustomer] = useState(row.customer || '');
    const [shown, setShown] = useState(false);
    useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);

    const reasonMeta = CORRECTION_REASONS.find(r => r.id === reason) || CORRECTION_REASONS[0];
    const isDuplicate = reason === 'duplicate';
    const highlight = (f) => reasonMeta.fields.includes(f);

    const amtN = parseFloat(inAmt) || 0;
    const feeN = parseFloat(fee) || 0;
    const rateN = parseFloat(rate) || 0;
    const sameCcy = inCcy === outCcy;
    const priced = useMemo(() => sameCcy ? null : priceDeal({ inCcy, outCcy, inAmt: amtN, settings, overrideRate: rateN || null }), [inCcy, outCcy, amtN, rateN, settings, sameCcy]);
    const outAmt = sameCcy ? +(amtN - feeN).toFixed(2) : (priced ? priced.outAmt : 0);
    const effRate = sameCcy ? 1 : (priced ? priced.rate : rateN);

    // what actually changed vs the original (drives the review list)
    const changes = [];
    if (!isDuplicate) {
      if (inCcy !== row.inCcy) changes.push(['Pay-in currency', row.inCcy, inCcy]);
      if (outCcy !== row.outCcy) changes.push(['Pay-out currency', row.outCcy, outCcy]);
      if (amtN !== (+row.inAmt || 0)) changes.push(['Amount in', `${num(row.inAmt)} ${row.inCcy}`, `${num(amtN)} ${inCcy}`]);
      if (!sameCcy && Math.abs(effRate - (+row.rate || 0)) > 1e-9) changes.push(['Rate', num(row.rate), num(effRate)]);
      if (feeN !== (+row.fee || 0)) changes.push(['Fee', fmt(row.fee || 0, 'CAD'), fmt(feeN, 'CAD')]);
      if ((customer || '') !== (row.customer || '')) changes.push(['Customer', row.customer || '—', customer || '—']);
    }
    const nothingChanged = !isDuplicate && changes.length === 0;
    const canPost = !!detail.trim() || reason !== 'other';   // "Other" needs a written reason
    const blocked = (!isDuplicate && (amtN <= 0 || (!sameCcy && rateN <= 0))) || nothingChanged || !canPost;

    const names = useMemo(() => Object.keys(clients || {}).sort(), [clients]);
    const reasonText = () => reasonMeta.label + (detail.trim() ? ` — ${detail.trim()}` : '');

    const doCorrect = () => {
      if (blocked) return;
      const newRef = row.ref + '-C' + Math.floor(10 + Math.random() * 89);
      const st = stamp();
      // 1) void the original, cross-linked to the correction
      setRows(rs => rs.map(r => r.id === row.id ? {
        ...r, status: 'void', voidReason: 'Corrected — ' + reasonText(), voidBy: me.name, voidAt: st,
        correctedTo: isDuplicate ? null : newRef,
        thread: [...(r.thread || []), { ts: st, user: me.name, text: (isDuplicate ? 'REVERSED (duplicate) — ' : 'CORRECTED → ' + newRef + ' — ') + reasonText() }]
      } : r));
      log('Transaction voided', `${row.ref} · ${isDuplicate ? 'duplicate reversed' : 'corrected → ' + newRef} · ${reasonMeta.label}`);

      // 2) post the corrected copy (skipped for a pure duplicate reversal)
      if (!isDuplicate) {
        const corrected = newTx({
          ...row, id: Date.now() + Math.floor(Math.random() * 1000), ref: newRef,
          date: TODAY, time: nowTime(), inCcy, outCcy, inAmt: amtN, rate: effRate, outAmt,
          fee: feeN, customer: customer || 'Walk-in (no client)',
          midRate: sameCcy ? row.midRate : (priced ? priced.midRate : null),
          spreadCad: sameCcy ? row.spreadCad : (priced ? priced.marginCad : null),
          side: sameCcy ? row.side : (priced ? priced.side : null),
          marginPct: null, profitCad: null,
          // a corrected deal makes its own fresh compliance decisions
          status: 'posted', filed: false, filedInfo: null, ackStr: false, ackStrInfo: null,
          tagged: false, tagInfo: null, voidReason: '', voidBy: '', voidAt: '', correctedTo: null,
          correctionOf: row.ref, correctionReason: reasonText(),
          createdBy: me.name, createdAt: st,
          thread: [{ ts: st, user: me.name, text: 'CORRECTION of ' + row.ref + ' — ' + reasonText() }]
        });
        setRows(rs => [corrected, ...rs]);
        log('Correction posted', `${newRef} · corrects ${row.ref} · ${reasonMeta.label}`);
      }
      onDone && onDone();
    };

    const inSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };
    const fieldWrap = (f) => ({ ...inSty, borderColor: highlight(f) ? CD.ink : CD.line, boxShadow: highlight(f) ? `0 0 0 3px ${CD.lineSoft}` : 'none' });

    return (<Portal>
      <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300, opacity: shown ? 1 : 0, transition: 'opacity .18s' }} onMouseDown={onClose}>
        <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 720, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 16, boxShadow: '0 24px 70px var(--cd-scrim)', overflow: 'hidden', transform: shown ? 'scale(1)' : 'scale(0.98)', transition: 'transform .18s' }}>
          {/* header */}
          <div className="flex items-center gap-3 px-5 py-3.5 flex-none" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <span className="grid place-items-center" style={{ width: 32, height: 32, background: CD.ink, borderRadius: 9 }}><Ic n="edit" s={17} c="var(--cd-on-ink)" /></span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold leading-tight" style={{ color: CD.ink }}>Correct transaction</div>
              <div className="text-[11px]" style={{ color: CD.mute }}>Reverses <b style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{row.ref}</b> and posts a corrected copy · nothing is deleted</div>
            </div>
            <button onClick={onClose} className="p-1.5" style={{ borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-4">
            {/* reason */}
            <div>
              <div className="text-[11px] mb-1.5 font-semibold uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>What went wrong?</div>
              <div className="flex flex-wrap gap-1.5">
                {CORRECTION_REASONS.map(r => { const on = reason === r.id; return (
                  <button key={r.id} onClick={() => setReason(r.id)} className="px-3 py-1.5 text-[12.5px] font-medium" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.ink }}>{r.label}</button>); })}
              </div>
              <input value={detail} onChange={e => setDetail(e.target.value)} placeholder={reason === 'other' ? 'Describe what needs fixing (required)…' : 'Add a note (optional)…'} className="w-full mt-2 text-sm px-3 py-2 outline-none" style={{ ...inSty, borderColor: reason === 'other' && !detail.trim() ? CD.flag : CD.line }} />
            </div>

            {isDuplicate ? (
              <div className="p-3.5 flex items-start gap-2.5" style={{ background: CD.flagSoft, borderRadius: 11 }}>
                <Ic n="ban" s={16} c={CD.flag} />
                <div className="text-[12.5px]" style={{ color: CD.flag }}><b>Reverse only.</b> {row.ref} will be voided as a duplicate and no corrected copy is posted. The record stays on file with this reason.</div>
              </div>
            ) : (
              <>
                {/* editable fields */}
                <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Amount in</div>
                      <div className="flex" style={{ ...fieldWrap('inAmt'), overflow: 'hidden' }}>
                        <input value={inAmt} onChange={e => setInAmt(e.target.value)} inputMode="decimal" className="flex-1 min-w-0 px-2.5 py-2 text-sm text-right outline-none bg-transparent" style={{ fontVariantNumeric: 'tabular-nums' }} />
                        <select value={inCcy} onChange={e => setInCcy(e.target.value)} className="px-2 outline-none text-sm font-semibold" style={{ borderLeft: `1px solid ${CD.line}`, background: highlight('inCcy') ? CD.lineSoft : 'var(--cd-chip)' }}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Pay-out currency</div>
                      <select value={outCcy} onChange={e => setOutCcy(e.target.value)} className="w-full px-2.5 py-2 text-sm font-semibold outline-none" style={fieldWrap('outCcy')}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Rate {sameCcy && <span style={{ color: CD.faint }}>· n/a same currency</span>}</div>
                      <input value={sameCcy ? '1' : rate} onChange={e => setRate(e.target.value)} disabled={sameCcy} inputMode="decimal" className="w-full px-2.5 py-2 text-sm text-right outline-none" style={{ ...fieldWrap('rate'), fontVariantNumeric: 'tabular-nums', opacity: sameCcy ? 0.5 : 1 }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Fee (CAD)</div>
                      <input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full px-2.5 py-2 text-sm text-right outline-none" style={{ ...fieldWrap('fee'), fontVariantNumeric: 'tabular-nums' }} />
                    </div>
                    <div className="col-span-2">
                      <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Customer</div>
                      <input list="cdos-correct-clients" value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Walk-in (no client)" className="w-full px-2.5 py-2 text-sm outline-none" style={fieldWrap('customer')} />
                      <datalist id="cdos-correct-clients">{names.map(n => <option key={n} value={n} />)}</datalist>
                    </div>
                  </div>
                </div>

                {/* corrected payout preview */}
                <div className="p-3.5 flex items-center justify-between" style={{ background: CD.ink, borderRadius: 12 }}>
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--cd-on-ink-soft)', fontFamily: 'Space Mono, monospace' }}>Corrected — customer receives</div>
                    <div className="font-bold" style={{ fontSize: 24, color: '#7fd1a3', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{num(outAmt)} <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(127,209,163,0.7)' }}>{outCcy}</span></div>
                  </div>
                  <div className="text-right text-[11px]" style={{ color: 'var(--cd-on-ink-soft)', fontFamily: 'Space Mono, monospace' }}>
                    <div>{num(amtN)} {inCcy} in</div>
                    {!sameCcy && <div>@ {num(effRate)}</div>}
                    <div>{feeN > 0 ? `fee ${fmt(feeN, 'CAD')}` : 'no fee'}</div>
                  </div>
                </div>

                {/* what changes */}
                <div className="px-3.5 py-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="text-[11px] mb-2 font-semibold uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{changes.length ? `${changes.length} change${changes.length > 1 ? 's' : ''} from ${row.ref}` : 'No changes yet'}</div>
                  {changes.length === 0
                    ? <div className="text-[12px]" style={{ color: CD.mute }}>Edit a field above — the correction must differ from the original.</div>
                    : <div className="space-y-1.5">{changes.map(([lbl, from, to], i) => (
                        <div key={i} className="flex items-center gap-2 text-[12.5px]">
                          <span style={{ color: CD.mute, minWidth: 120 }}>{lbl}</span>
                          <span style={{ color: CD.flag, textDecoration: 'line-through' }}>{from}</span>
                          <Ic n="arrowright" s={12} c={CD.faint} />
                          <span style={{ color: CD.green, fontWeight: 600 }}>{to}</span>
                        </div>))}</div>}
                </div>
              </>
            )}
          </div>

          {/* footer */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <div className="text-[11px] flex items-center gap-1.5" style={{ color: CD.faint }}><Ic n="shield" s={13} c={CD.faint} /> {isDuplicate ? 'Original kept on file, marked void.' : 'Original voided & kept · corrected copy audit-linked.'}</div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="px-3.5 py-2 text-[13px] font-medium" style={{ color: CD.mute }}>Cancel</button>
              <CommitBtn onCommit={doCorrect} disabled={blocked} tone={isDuplicate ? 'danger' : 'default'} bg={isDuplicate ? undefined : CD.green} icon={isDuplicate ? 'ban' : 'check'} label={isDuplicate ? 'Reverse duplicate' : 'Post correction'} doneLabel={isDuplicate ? 'Reversed' : 'Corrected'} delay={460} style={{ padding: '0.55rem 1rem', fontSize: 13.5 }} title={nothingChanged ? 'Edit a field first' : 'Reverse and repost'} />
            </div>
          </div>
        </div>
      </div>
    </Portal>);
  }

  function TxDetail({ row, flag, settings, me, can, log, setRows, clients, onClose, onReceipt, onOpenClient, onFileLCTR }) {
    const [note, setNote] = useState('');
    const [voiding, setVoiding] = useState(false);
    const [pinAsk, setPinAsk] = useState(false);   // PIN gate before a void (Settings › Employees)
    const [correcting, setCorrecting] = useState(false);
    // filing status comes from the real Compliance filing record, not a local flag
    const filing = (() => { try { return (JSON.parse(localStorage.getItem('cdos_submissions_v1') || '{}') || {})['L-' + row.ref]; } catch (e) { return null; } })();
    const isFiled = filing && filing.status === 'submitted';
    const [voidReason, setVoidReason] = useState('');
    const [shown, setShown] = useState(false);
    useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
    const isVoid = row.status === 'void';
    // a void can require the operator's transaction PIN
    const _emp = (settings.employees || []).find(x => x.name === me.name);
    const _myPin = (_emp && _emp.pin) || '0000';
    const voidNeedsPin = settings.pinOnVoid !== false && (!_emp || _emp.requirePin !== false);
    const patch = (fn, action, detail) => { setRows(rs => rs.map(r => r.id === row.id ? fn(r) : r)); log(action, `${row.ref} · ${detail}`); };

    const addNote = () => { if (!note.trim()) return; const entry = { ts: stamp(), user: me.name, text: note.trim() }; patch(r => ({ ...r, thread: [...(r.thread || []), entry] }), 'Note added', note.trim().slice(0, 60)); setNote(''); };
    const toggleFiled = () => {
      if (row.filed) { patch(r => ({ ...r, filed: false, filedInfo: null }), 'LCTR filing reversed', `report withdrawn`); }
      else { const ref = 'LCTR-' + Math.floor(1000 + Math.random() * 9000); patch(r => ({ ...r, filed: true, filedInfo: { ref, by: me.name, at: stamp() } }), 'LCTR filed', `${ref} for ${fmt(row.inAmt, row.inCcy)}`); }
    };
    const toggleAck = () => {
      if (row.ackStr) patch(r => ({ ...r, ackStr: false, ackStrInfo: null }), 'Structuring note cleared', 'watch reopened');
      else patch(r => ({ ...r, ackStr: true, ackStrInfo: { by: me.name, at: stamp() } }), 'Structuring acknowledged', `reviewed by ${me.name}`);
    };
    // one-tap: file the LCTR (if reportable) AND acknowledge the structuring watch
    const ackAll = () => {
      const ref = 'LCTR-' + Math.floor(1000 + Math.random() * 9000);
      patch(r => {
        const u = { ...r };
        if (flag.single && !r.filed) { u.filed = true; u.filedInfo = { ref, by: me.name, at: stamp() }; }
        if (flag.str && !r.ackStr) { u.ackStr = true; u.ackStrInfo = { by: me.name, at: stamp() } }
        return u;
      }, 'Compliance cleared', `all items acknowledged by ${me.name}`);
    };
    const doVoid = () => { if (!voidReason.trim()) return; patch(r => ({ ...r, status: 'void', voidReason: voidReason.trim(), voidBy: me.name, voidAt: stamp(), thread: [...(r.thread || []), { ts: stamp(), user: me.name, text: 'VOID — ' + voidReason.trim() }] }), 'Transaction voided', voidReason.trim().slice(0, 60)); setVoiding(false); };
    const toggleTag = () => {
      if (row.tagged) patch(r => ({ ...r, tagged: false, tagInfo: null }), 'Tag removed', 'untagged');
      else patch(r => ({ ...r, tagged: true, tagInfo: { by: me.name, at: stamp(), note: '' } }), 'Transaction tagged', `flagged for follow-up by ${me.name}`);
    };
    const toggleIdNote = () => {
      if (row.idNoteAcked) patch(r => ({ ...r, idNoteAcked: false, idNoteInfo: null }), 'ID note reopened', 'below-threshold ID note reopened');
      else patch(r => ({ ...r, idNoteAcked: true, idNoteInfo: { by: me.name, at: stamp() } }), 'ID note acknowledged', `no ID needed under ${fmt(flag.idFloor, 'CAD')} · ${me.name}`);
    };

    // earnings: posted fee + the spread actually booked at the counter (exact when
    // the deal was two-side priced; falls back to the live-mid estimate for legacy rows)
    const inCad = row.inCcy === 'CAD' ? (+row.inAmt || 0) : (+row.inAmt || 0) / (crossRate('CAD', row.inCcy) || 1);
    const spreadCad = dealMargin(row);
    const feeCad = +row.fee || 0;
    const earned = feeCad + spreadCad;
    const marginPct = inCad ? (earned / inCad) * 100 : 0;
    const spreadPct = inCad ? (spreadCad / inCad) * 100 : 0;

    return (
      <div className="absolute inset-0 flex flex-col" style={{ background: CD.paper, zIndex: 50, transform: shown ? 'translateX(0)' : 'translateX(2.5%)', opacity: shown ? 1 : 0, transition: 'transform .22s ease, opacity .2s ease' }}>
        {/* header */}
        <div className="flex items-center gap-3 px-5 py-3 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-lg" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace', textDecoration: isVoid ? 'line-through' : 'none' }}>{row.ref}</span>
              <span className="text-[10px] px-2 py-0.5 font-semibold uppercase tracking-wide" style={{ borderRadius: 5, background: isVoid ? CD.lineSoft : CD.greenSoft, color: isVoid ? CD.mute : CD.green }}>{isVoid ? 'Void' : 'Posted'}</span>
              {row.tagged && <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 font-semibold" style={{ borderRadius: 5, background: CD.green, color: 'var(--cd-on-ink)', fontFamily: 'Space Mono, monospace' }}><Ic n="bookmark" s={10} c="var(--cd-on-ink)" /> TAGGED</span>}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{row.date} {row.time} · {row.teller}</div>
          </div>
          <div className="ml-auto flex items-center gap-1.5 flex-none">
            <button onClick={() => onReceipt(row)} className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="receipt" s={14} /> Receipt</button>
            <button onClick={toggleTag} title={row.tagged ? 'Remove tag' : 'Tag for follow-up'} className="grid place-items-center" style={{ width: 34, height: 34, borderRadius: 8, background: row.tagged ? CD.green : 'transparent', border: `1px solid ${row.tagged ? CD.green : CD.line}` }}><Ic n="bookmark" s={15} c={row.tagged ? 'var(--cd-on-ink)' : CD.mute} /></button>
            {!isVoid && can('canDelete') && !voiding && !correcting && <button onClick={() => setCorrecting(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium" style={{ color: CD.ink, border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="edit" s={14} /> Correct</button>}
            {!isVoid && can('canDelete') && !voiding && <button onClick={() => setVoiding(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium" style={{ color: CD.flag, border: `1px solid ${CD.flagSoft}`, background: CD.flagSoft, borderRadius: 8 }}><Ic n="ban" s={14} /> Void</button>}
          </div>
        </div>
        {correcting && <CorrectionModal row={row} settings={settings} me={me} clients={clients} setRows={setRows} log={log} onClose={() => setCorrecting(false)} onDone={() => { setCorrecting(false); onClose(); }} />}
        {voiding && (
          <div className="flex items-center gap-2 px-5 py-2.5 flex-none" style={{ background: CD.flagSoft, borderBottom: `1px solid ${CD.flag}` }}>
            <span className="text-[12px] font-medium flex-none" style={{ color: CD.flag }}>Void reason</span>
            <input value={voidReason} onChange={e => setVoidReason(e.target.value)} autoFocus placeholder="Reason (required)…" className="flex-1 text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.flag}`, borderRadius: 8 }} />
            {voidNeedsPin
              ? <button onClick={() => voidReason.trim() && setPinAsk(true)} disabled={!voidReason.trim()} className="text-[13px] font-semibold text-white" style={{ padding: '0.5rem 0.75rem', borderRadius: 8, background: voidReason.trim() ? CD.flag : 'var(--cd-disabled)', cursor: voidReason.trim() ? 'pointer' : 'not-allowed' }} title="Enter your PIN to void">Confirm void</button>
              : <CommitBtn onCommit={doVoid} disabled={!voidReason.trim()} tone="danger" label="Confirm void" doneLabel="Voided" delay={420} style={{ padding: '0.5rem 0.75rem' }} title="Void this record" />}
            <button onClick={() => setVoiding(false)} className="p-2 flex-none"><Ic n="x" s={15} c={CD.mute} /></button>
          </div>
        )}
        {pinAsk && window.CDOS.PinPrompt && <window.CDOS.PinPrompt title="Confirm void" sub="Enter your PIN to void this record" name={me.name} expected={_myPin} onOk={() => { setPinAsk(false); doVoid(); }} onCancel={() => setPinAsk(false)} />}
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full px-5 py-6 space-y-5" style={{ maxWidth: 760 }}>
            {isVoid && (<div className="p-3 text-[12px]" style={{ background: row.correctedTo ? CD.amberSoft : CD.lineSoft, borderRadius: 10, color: CD.ink }}><b>{row.correctedTo ? 'Corrected & voided' : 'Voided'}</b> by {row.voidBy} · {row.voidAt}<div style={{ color: CD.mute }}>Reason: {row.voidReason}</div>{row.correctedTo && <div className="mt-1 font-medium" style={{ color: 'var(--cd-brass-text)' }}>Replaced by <span style={{ fontFamily: 'Space Mono, monospace' }}>{row.correctedTo}</span> — the corrected record.</div>}</div>)}
            {row.correctionOf && (<div className="p-3 text-[12px] flex items-start gap-2" style={{ background: CD.greenSoft, borderRadius: 10, color: '#14543a' }}><Ic n="edit" s={14} c={CD.green} /><div><b>Correction</b> of <span style={{ fontFamily: 'Space Mono, monospace' }}>{row.correctionOf}</span>{row.correctionReason ? ` — ${row.correctionReason}` : ''}. <span style={{ color: CD.mute }}>The original was voided and kept on file.</span></div></div>)}

            {/* hero flow — what this transaction actually is, at a glance */}
            <TxFlow row={row} />

            {/* compliance */}
            <div>
              {(() => {
                const kycBad = flag.kyc && flag.kyc !== 'ok' && flag.idNeeded;
                const flagCount = (flag.single ? 1 : 0) + (flag.str ? 1 : 0) + (kycBad ? 1 : 0);
                const openAckable = (flag.single && !row.filed) || (flag.str && !row.ackStr);
                return (<div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Compliance</div>
                  {!isVoid && flagCount >= 2 && openAckable && <button onClick={ackAll} title="Mark every open compliance item on this deal as reviewed" className="flex items-center gap-1 text-[11px] px-2 py-1" style={{ background: 'transparent', color: CD.mute, border: `1px solid ${CD.line}`, borderRadius: 7 }} onMouseEnter={e => { e.currentTarget.style.color = CD.ink; e.currentTarget.style.borderColor = CD.mute; }} onMouseLeave={e => { e.currentTarget.style.color = CD.mute; e.currentTarget.style.borderColor = CD.line; }}><Ic n="check" s={12} c="currentColor" /> Acknowledge all</button>}
                </div>);
              })()}
              {!flag.single && !flag.str && (flag.kyc === 'ok' || !flag.idNeeded) && !(flag.kyc !== 'ok' && !flag.idNeeded) && <div className="text-[12px] flex items-center gap-1.5 px-3 py-2.5" style={{ color: CD.green, background: CD.greenSoft, borderRadius: 9 }}><Ic n="checkcircle" s={14} /> No flags — within thresholds, ID on file.</div>}

              {flag.single && (
                <div className="px-3 py-2.5 mb-2" style={{ background: isFiled ? CD.greenSoft : CD.flagSoft, borderRadius: 9 }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium" style={{ color: isFiled ? CD.green : CD.flag }}><div className="flex items-center gap-1.5"><Ic n={isFiled ? 'checkcircle' : 'alert'} s={14} /> Reportable — LCTR{isFiled ? ' filed & sealed' : ' required'}</div>{isFiled && <div className="text-[10px] mt-0.5" style={{ color: CD.mute }}>FWR {filing.ackNo} · {filing.by} · {filing.submittedAt}</div>}</div>
                    {!isVoid && !isFiled && <button onClick={() => { onClose(); onFileLCTR && onFileLCTR({ id: 'L-' + row.ref, kind: window.CDOS.getRegime(settings).largeCode, subject: row.customer, beneficiary: row.beneficiary, amount: (row.inCcy === 'CAD' ? (+row.inAmt || 0) : (+row.inAmt || 0) / (crossRate('CAD', row.inCcy) || 1)), refs: [row.ref], basis: null }); }} className="flex-none whitespace-nowrap text-xs px-2.5 py-1.5 font-semibold" style={{ borderRadius: 7, background: CD.ink, color: 'var(--cd-on-ink)' }}>File LCTR →</button>}
                  </div>
                </div>
              )}
              {flag.str && (
                <div className="px-3 py-2.5 mb-2" style={{ background: row.ackStr ? CD.lineSoft : CD.amberSoft, borderRadius: 9 }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium" style={{ color: row.ackStr ? CD.mute : CD.amber }}><div className="flex items-center gap-1.5"><Ic n={row.ackStr ? 'check' : 'alert'} s={14} /> Structuring watch{row.ackStr ? ' — reviewed' : ''}</div><div className="text-[10px] mt-0.5" style={{ color: CD.mute }}>{settings.structuringDays}-day total {fmt(flag.agg, 'CAD')}{row.ackStrInfo ? ` · ${row.ackStrInfo.by}` : ''}</div></div>
                    {!isVoid && <button onClick={toggleAck} className="flex-none whitespace-nowrap text-xs px-2.5 py-1.5 font-medium" style={{ borderRadius: 7, background: row.ackStr ? 'transparent' : CD.ink, color: row.ackStr ? CD.mute : 'var(--cd-on-ink)', border: row.ackStr ? `1px solid ${CD.line}` : 'none' }}>{row.ackStr ? 'Reopen' : 'Acknowledge'}</button>}
                  </div>
                </div>
              )}
              {flag.kyc && flag.kyc !== 'ok' && flag.idNeeded && (
                <div className="px-3 py-2.5 flex items-center justify-between gap-2" style={{ background: CD.flagSoft, borderRadius: 9 }}>
                  <div className="text-[12px] font-medium flex items-center gap-1.5" style={{ color: CD.flag }}><Ic n="id" s={14} /> Client ID — {flag.kyc} <span style={{ color: CD.mute, fontWeight: 400 }}>· required over {fmt(flag.idFloor, 'CAD')}</span></div>
                  <button onClick={() => onOpenClient(row.customer, row.ref)} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 font-medium" style={{ borderRadius: 7, background: CD.ink, color: 'var(--cd-on-ink)' }}><Ic n="users" s={13} c="var(--cd-on-ink)" /> Open in Clients</button>
                </div>
              )}
              {flag.kyc && flag.kyc !== 'ok' && !flag.idNeeded && (
                <div className="px-3 py-2.5" style={{ background: row.idNoteAcked ? CD.lineSoft : CD.amberSoft, borderRadius: 9 }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium" style={{ color: row.idNoteAcked ? CD.mute : CD.amber }}><div className="flex items-center gap-1.5"><Ic n={row.idNoteAcked ? 'check' : 'id'} s={14} /> No ID on file{row.idNoteAcked ? ' — acknowledged' : ''}</div><div className="text-[10px] mt-0.5" style={{ color: CD.mute }}>Not required under {fmt(flag.idFloor, 'CAD')} · {fmt(inCad, 'CAD')} deal{row.idNoteInfo ? ` · ${row.idNoteInfo.by}` : ''}</div></div>
                    {!isVoid && <div className="flex items-center gap-1.5 flex-none">
                      {!row.idNoteAcked && <button onClick={() => onOpenClient(row.customer, row.ref)} title="Add their ID anyway" className="text-xs px-2.5 py-1.5 font-medium" style={{ borderRadius: 7, background: 'transparent', color: CD.mute, border: `1px solid ${CD.line}` }}>Add ID</button>}
                      <button onClick={toggleIdNote} className="whitespace-nowrap text-xs px-2.5 py-1.5 font-medium" style={{ borderRadius: 7, background: row.idNoteAcked ? 'transparent' : CD.ink, color: row.idNoteAcked ? CD.mute : 'var(--cd-on-ink)', border: row.idNoteAcked ? `1px solid ${CD.line}` : 'none' }}>{row.idNoteAcked ? 'Reopen' : 'Acknowledge'}</button>
                    </div>}
                  </div>
                </div>
              )}
            </div>

            {/* captured FINTRAC details — purpose, source of funds, third party.
               Logged on the deal at the counter; surfaced here so the record is complete. */}
            {row.capture && (
              <div>
                <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Reportable details captured</div>
                <div className="p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                  <DRow k="Purpose of transaction" v={row.capture.purpose || '—'} />
                  <DRow k="Source of funds" v={row.capture.source || '—'} />
                  <DRow k="Acting for a third party" v={row.capture.thirdParty ? (row.capture.thirdPartyName ? `Yes — ${row.capture.thirdPartyName}` : 'Yes') : 'No'} accent={row.capture.thirdParty ? CD.ink : undefined} />
                  <div className="text-[11px] mt-1.5" style={{ color: CD.faint }}>Captured by {row.capture.by} · {row.capture.at}</div>
                </div>
              </div>
            )}

            {/* type-aware record facts */}
            <TxFacts row={row} onOpenClient={onOpenClient} />

            {/* earnings — FX deals show fee + spread; flat services show the service fee */}
            {!isVoid && (() => {
              const flat = row.inCcy === row.outCcy;
              return (<div>
                <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Earnings on this deal</div>
                <div className="p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                  <div className="grid grid-cols-2 gap-3 mb-1">
                    <div><div className="text-[11px]" style={{ color: CD.mute }}>Total earned</div><div className="text-xl font-semibold" style={{ color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{fmt(earned, 'CAD')}</div></div>
                    <div><div className="text-[11px]" style={{ color: CD.mute }}>{flat ? 'Fee on amount' : 'Margin on volume'}</div><div className="text-xl font-semibold" style={{ color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{marginPct.toFixed(2)}%</div></div>
                  </div>
                  <DRow k={flat ? 'Service fee' : 'Commission / fee'} v={`${fmt(feeCad, 'CAD')}${inCad ? `  ·  ${((feeCad / inCad) * 100).toFixed(2)}%` : ''}`} mono />
                  {!flat && <DRow k="FX spread (rate markup)" v={spreadCad > 0 ? `${fmt(spreadCad, 'CAD')}  ·  ${spreadPct.toFixed(2)}%` : '—'} mono />}
                  {row.marginOverride && (
                    <div className="mt-2 px-2.5 py-2 text-[11.5px]" style={{ background: CD.flagSoft, borderRadius: 8, color: CD.flag }}>
                      <div className="font-semibold flex items-center gap-1.5"><Ic n="alert" s={13} c={CD.flag} /> Below-floor margin override</div>
                      <div className="mt-0.5" style={{ color: CD.ink }}>Booked at {row.marginOverride.pct}% by {row.marginOverride.by} · {row.marginOverride.at}{row.marginOverride.reason ? ` — "${row.marginOverride.reason}"` : ''}</div>
                    </div>
                  )}
                </div>
                <p className="mt-1.5 text-[11px]" style={{ color: CD.faint }}>{flat ? 'Flat service fee charged on this transaction.' : 'Fee is the flat commission charged on top. Spread is the markup baked into the rate vs. the live mid. Margin % = total earned ÷ pay-in.'}</p>
              </div>);
            })()}

            {/* notes thread */}
            <div>
              <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Notes & history</div>
              <div className="space-y-2 mb-2">
                {(row.thread || []).length === 0 && <div className="text-[12px]" style={{ color: CD.faint }}>No notes yet.</div>}
                {(row.thread || []).map((n, i) => (
                  <div key={i} className="px-3 py-2" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
                    <div className="flex items-center justify-between text-[10px] mb-0.5" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}><span>{n.user}</span><span>{n.ts}</span></div>
                    <div className="text-[12px]" style={{ color: CD.ink }}>{n.text}</div>
                  </div>
                ))}
              </div>
              {!isVoid && (
                <div className="flex items-end gap-2">
                  <input value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} placeholder="Add a note (appended, not editable)…" className="flex-1 text-sm px-2.5 py-2 outline-none" style={inputSty} />
                  <button onClick={addNote} className="px-3 py-2 text-sm font-medium text-white" style={{ background: CD.ink, borderRadius: 8 }}>Add</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* =====================================================================
     VOLUME / FEES BREAKDOWN — drill-down from the stat cards, with charts
  ===================================================================== */
  function MiniBars({ data, fmtV, accent, empty }) {
    if (!data.length) return <div className="text-[12px] py-2" style={{ color: CD.faint }}>{empty || 'No data.'}</div>;
    const max = Math.max(1, ...data.map(d => d[1]));
    return (<div>{data.map(([k, v]) => (
      <div key={k} className="mb-2.5">
        <div className="flex justify-between items-baseline text-[12px] mb-1"><span style={{ color: CD.text }}>{k}</span><span style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{fmtV(v)}</span></div>
        <div className="h-2" style={{ background: CD.lineSoft, borderRadius: 4 }}><div className="h-2" style={{ width: `${(v / max) * 100}%`, background: accent || CD.ink, borderRadius: 4, minWidth: v > 0 ? 3 : 0 }} /></div>
      </div>))}</div>);
  }
  function Kpi({ label, value, accent, sub }) {
    return (<div className="px-3.5 py-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
      <div className="text-[11px]" style={{ color: CD.mute }}>{label}</div>
      <div className="text-xl font-semibold leading-tight" style={{ color: accent || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }
  function SubHead({ children }) { return <div className="text-[11px] uppercase tracking-widest mb-2 mt-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{children}</div>; }

  function BreakdownModal({ rows, client, focus, onClose }) {
    const [tab, setTab] = useState(focus || 'volume');
    const cadOf = (amt, ccy) => ccy === 'CAD' ? (+amt || 0) : (+amt || 0) / (crossRate('CAD', ccy) || 1);
    const d = useMemo(() => {
      const live = rows.filter(r => r.status !== 'void' && (!client || r.customer === client));
      let vol = 0, fees = 0, margin = 0;
      const byCcy = {}, byType = {}, feeType = {}, feeTeller = {}, perTx = [];
      live.forEach(r => {
        const v = cadOf(r.inAmt, r.inCcy); const fee = +r.fee || 0;
        const m = dealMargin(r);
        vol += v; fees += fee; margin += m;
        byCcy[r.inCcy] = (byCcy[r.inCcy] || 0) + v;
        byType[r.type] = (byType[r.type] || 0) + v;
        feeType[r.type] = (feeType[r.type] || 0) + fee;
        feeTeller[r.teller] = (feeTeller[r.teller] || 0) + fee;
        perTx.push({ ref: r.ref, customer: r.customer, type: r.type, inAmt: r.inAmt, inCcy: r.inCcy, vol: v, fee, margin: m, total: fee + m });
      });
      const sortE = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
      return { vol, fees, margin, rev: fees + margin, n: live.length,
        byCcy: sortE(byCcy), byType: sortE(byType), feeType: sortE(feeType), feeTeller: sortE(feeTeller),
        perTx: perTx.sort((a, b) => b.total - a.total) };
    }, [rows, client]);

    const avgTicket = d.n ? d.vol / d.n : 0;
    const avgFee = d.n ? d.fees / d.n : 0;
    const effRate = d.vol ? (d.rev / d.vol) * 100 : 0;

    return ReactDOM.createPortal((
      <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }} onMouseDown={onClose}>
        <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 640, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
          {/* header */}
          <div className="flex-none flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
            <div className="flex items-center gap-2.5">
              <span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="bars" s={16} c="var(--cd-on-ink)" /></span>
              <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Volume & earnings{client ? ` · ${client}` : ''}</div><div className="text-[11px]" style={{ color: CD.mute }}>{d.n} posted transactions · CAD-equivalent</div></div>
            </div>
            <button onClick={onClose} className="p-1.5" style={{ borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
          </div>
          {/* tabs */}
          <div className="flex-none flex gap-1.5 px-5 pt-3">
            {[['volume', 'Pay-in volume'], ['fees', 'Fees & earnings']].map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id)} className="text-sm px-3.5 py-2 font-medium" style={{ borderRadius: 8, background: tab === id ? CD.ink : 'transparent', color: tab === id ? 'var(--cd-on-ink)' : CD.mute, border: `1px solid ${tab === id ? 'transparent' : CD.line}` }}>{lbl}</button>
            ))}
          </div>

          <div className="flex-1 overflow-auto px-5 py-4">
            {tab === 'volume' && (<div>
              <div className="grid grid-cols-3 gap-2 mb-4">
                <Kpi label="Total pay-in" value={fmt(d.vol, 'CAD')} />
                <Kpi label="Transactions" value={d.n} />
                <Kpi label="Avg. ticket" value={fmt(avgTicket, 'CAD')} />
              </div>
              <div className="p-4 mb-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                <SubHead>Pay-in volume by currency</SubHead>
                <MiniBars data={d.byCcy} fmtV={v => fmt(v, 'CAD')} />
              </div>
              <div className="p-4" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                <SubHead>Volume by transaction type</SubHead>
                <MiniBars data={d.byType} fmtV={v => fmt(v, 'CAD')} />
              </div>
              <p className="mt-3 text-[11px]" style={{ color: CD.faint }}>All amounts converted to CAD at the live spot rate for comparison. Voided records excluded.</p>
            </div>)}

            {tab === 'fees' && (<div>
              <div className="grid grid-cols-4 gap-2 mb-4">
                <Kpi label="Fees collected" value={fmt(d.fees, 'CAD')} accent={CD.green} />
                <Kpi label="Est. FX spread" value={fmt(d.margin, 'CAD')} accent={CD.green} sub="rate markup" />
                <Kpi label="Total revenue" value={fmt(d.rev, 'CAD')} accent={CD.green} />
                <Kpi label="Margin %" value={`${effRate.toFixed(2)}%`} accent={CD.green} sub="of pay-in volume" />
              </div>
              <div className="grid md:grid-cols-2 gap-3 mb-3">
                <div className="p-4" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                  <SubHead>Fees by type</SubHead>
                  <MiniBars data={d.feeType} fmtV={v => fmt(v, 'CAD')} accent={CD.green} />
                </div>
                <div className="p-4" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                  <SubHead>Fees by teller</SubHead>
                  <MiniBars data={d.feeTeller} fmtV={v => fmt(v, 'CAD')} accent={CD.green} />
                </div>
              </div>
              <div className="overflow-hidden" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                <div className="px-4 pt-3"><SubHead>Earnings per transaction</SubHead></div>
                <table className="w-full border-collapse text-sm">
                  <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-left text-[11px] uppercase tracking-wide">
                    <th className="px-3 py-2 font-medium">Ref</th><th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium text-right">Fee</th><th className="px-3 py-2 font-medium text-right">Spread</th><th className="px-3 py-2 font-medium text-right">Earned</th><th className="px-3 py-2 font-medium text-right">Margin %</th>
                  </tr></thead>
                  <tbody>{d.perTx.map(t => (
                    <tr key={t.ref} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                      <td className="px-3 py-2" style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, color: CD.mute }}>{t.ref}</td>
                      <td className="px-3 py-2" style={{ color: CD.ink }}>{t.customer}</td>
                      <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(t.fee, 'CAD')}</td>
                      <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{t.margin > 0 ? fmt(t.margin, 'CAD') : '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green }}>{fmt(t.total, 'CAD')}</td>
                      <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{t.vol ? ((t.total / t.vol) * 100).toFixed(2) + '%' : '—'}</td>
                    </tr>))}
                    {d.perTx.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center" style={{ color: CD.mute }}>No transactions.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px]" style={{ color: CD.faint }}>Revenue = posted fees + estimated FX spread (live spot value − actual pay-out). Effective take ≈ {effRate.toFixed(2)}% of volume.</p>
            </div>)}
          </div>
        </div>
      </div>
    ), document.body);
  }

  /* =====================================================================
     LEDGER COMPLIANCE — triage workspace embedded as a tab in the Ledger
  ===================================================================== */
  function LedgerCompliance({ rows, flags, settings, clients, me, setRows, log, onOpenDetail, onOpenClient, onOpenFocus, onOpenCompliance, onOpenAccount, onOpenRecordsWindow, onFileLCTR }) {
    const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
    const cadIn = (r) => r.inCcy === 'CAD' ? (+r.inAmt || 0) : (+r.inAmt || 0) / (crossRate('CAD', r.inCcy) || 1);
    const fileLCTR = (r) => { const reg = window.CDOS.getRegime(settings); onFileLCTR && onFileLCTR({ id: 'L-' + r.ref, kind: reg.largeCode, subject: r.customer, beneficiary: r.beneficiary, amount: cadIn(r), refs: [r.ref], basis: null }); };
    const live = rows.filter(r => r.status !== 'void');
    const toFile = live.filter(r => (flags[r.id] || {}).single && !r.filed);
    const strWatch = live.filter(r => (flags[r.id] || {}).str && !r.ackStr);
    const idIssues = live.filter(r => { const f = flags[r.id] || {}; return f.kyc && f.kyc !== 'ok' && f.idNeeded; });
    const aggs = useMemo(() => { try { const reg = window.CDOS.getRegime(settings); return window.CDOS._compliance.aggClusters(rows, reg, settings); } catch (e) { return []; } }, [rows, settings]);
    const fileRow = (r) => { setRows(rs => rs.map(x => x.id === r.id ? { ...x, filed: true, filedInfo: { ref: 'LCTR-' + Math.floor(1000 + Math.random() * 9000), by: me.name, at: stamp() } } : x)); log && log('LCTR filed', `${r.ref} · ${fmt(cadIn(r), 'CAD')}`); };
    const ackRow = (r) => { setRows(rs => rs.map(x => x.id === r.id ? { ...x, ackStr: true, ackStrInfo: { by: me.name, at: stamp() } } : x)); log && log('Structuring acknowledged', `${r.ref} reviewed`); };

    const Kpi = CompKpi;
    const Group = CompGroup;

    return (<div className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Compliance workspace</div><div className="text-[11px]" style={{ color: CD.mute, maxWidth: 520 }}>Everything in this book that needs a decision — file the report, clear the watch, or fix the ID, right here. For wires, name screening and batch submission, open the full desk.</div></div>
        <button onClick={() => onOpenCompliance && onOpenCompliance()} className="flex items-center gap-2 pl-3.5 pr-3 py-2 text-[12px] font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 9, boxShadow: '0 1px 2px var(--cd-line)', transition: 'transform .12s, box-shadow .12s' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px var(--cd-scrim)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 2px var(--cd-line)'; }}><Ic n="shield" s={14} c="var(--cd-on-ink)" /> Full Compliance desk <span className="grid place-items-center" style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--cd-on-ink-faint)' }}><Ic n="chev" s={12} c="var(--cd-on-ink)" /></span></button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <Kpi label="To file (LCTR)" value={toFile.length} tone={toFile.length ? CD.flag : CD.green} />
        <Kpi label="24h aggregates" value={aggs.length} tone={aggs.length ? CD.amber : CD.ink} />
        <Kpi label="Structuring watch" value={strWatch.length} tone={strWatch.length ? CD.amber : CD.ink} />
        <Kpi label="ID issues" value={idIssues.length} tone={idIssues.length ? CD.flag : CD.ink} />
      </div>
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2"><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>24-hour aggregates</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: aggs.length ? CD.amber : CD.lineSoft, color: aggs.length ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{aggs.length}</span></div>
        {aggs.length > 0 && <div className="text-[11px] mb-2" style={{ color: CD.mute, maxWidth: 560 }}>The {window.CDOS.getRegime(settings).aggHours}-hour rule treats each cluster as <b style={{ color: CD.ink }}>one reportable transaction</b>. View the exact records, then file a single <b style={{ color: CD.ink }}>{window.CDOS.getRegime(settings).largeCode}</b> for the whole group.</div>}
        {aggs.length ? <div className="space-y-1.5">{aggs.map(c => {
          const reg = window.CDOS.getRegime(settings); const kind = c.kind || reg.largeCode;
          let filed = false; try { const s = (JSON.parse(localStorage.getItem('cdos_submissions_v1') || '{}') || {})[c.id]; filed = !!(s && s.status === 'submitted'); } catch (e) {}
          return (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${c.basis === 'beneficiary' ? '#1d4ed8' : CD.lineSoft}`, borderRadius: 10 }}>
            <div className="flex-1 min-w-0"><div className="text-[13px] font-medium flex items-center gap-1.5" style={{ color: CD.ink }}>{c.subject} <span className="text-[9px] px-1.5 py-0.5" style={{ background: c.basis === 'beneficiary' ? '#dbe5fb' : CD.lineSoft, color: c.basis === 'beneficiary' ? '#1d4ed8' : CD.ink, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>{c.basis === 'beneficiary' ? 'BY BENEFICIARY' : 'BY CONDUCTOR'}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{c.txs.length} cash-ins · {fmt(c.total, 'CAD')} · {c.windowLabel}</div></div>
            <div className="flex items-center gap-1.5 flex-none">
              <button onClick={() => onOpenRecordsWindow ? onOpenRecordsWindow(c.txs.map(t => t.ref), `${c.subject} · ${c.basis === 'beneficiary' ? 'beneficiary' : 'conductor'} agg`) : onOpenFocus(c.txs.map(t => t.ref), `${c.subject} aggregate`)} title="Open these records in their own ledger window" className="text-[11px] font-medium px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>View records</button>
              {filed
                ? <span className="text-[11px] font-semibold px-2.5 py-1.5 inline-flex items-center gap-1" style={{ color: CD.green }}><Ic n="checkcircle" s={13} c={CD.green} /> {kind} filed</span>
                : <button onClick={() => onFileLCTR && onFileLCTR({ id: c.id, kind, subject: c.subject, amount: c.total, detail: `${c.txs.length}-deal ${reg.aggHours}h aggregate · by ${c.basis}`, refs: c.txs.map(t => t.ref), basis: c.basis, window: c.windowLabel, windowStart: c.windowStart, windowEnd: c.windowEnd })} title={`Generate the ${kind} for this 24-hour aggregate`} className="text-[11px] font-semibold px-2.5 py-1.5 text-white" style={{ background: CD.ink, borderRadius: 7 }}>File {kind} →</button>}
            </div>
          </div>); })}</div> : <div className="text-[12px] px-3 py-2.5" style={{ color: CD.faint, background: CD.panel, border: `1px dashed ${CD.line}`, borderRadius: 10 }}>No 24-hour aggregates over threshold.</div>}
      </div>
      <Group title="Reportable — needs filing" tone={CD.flag} empty="Nothing to file." info={{ title: 'Reportable — needs filing', body: 'Deals at or over the reporting threshold — single or 24-hour aggregate — that the law requires you to file: LCTRs for cash, EFTRs for wires. Each opens a worksheet pre-filled from the record; file it before its deadline.' }} items={toFile.map(r => <CompItem key={r.id} r={r} onOpenDetail={onOpenDetail} cadIn={cadIn}>{r.customer && <button onClick={() => onOpenClient(r.customer, r.ref)} className="text-[11px] font-medium px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Client</button>}<button onClick={() => fileLCTR(r)} className="text-[11px] font-semibold px-2.5 py-1.5 text-white" style={{ background: CD.ink, borderRadius: 7 }}>File LCTR →</button></CompItem>)} />
      <Group title="Structuring watch" tone={CD.amber} empty="No open structuring patterns." info={{ title: 'Structuring watch', body: 'Not a filing — a heads-up. One person running several deals kept deliberately just under the threshold. Review the pattern; if it looks intentional, file a suspicious-transaction report (STR).' }} items={strWatch.map(r => <CompItem key={r.id} r={r} onOpenDetail={onOpenDetail} cadIn={cadIn}>{r.customer && <button onClick={() => onOpenClient(r.customer, r.ref)} className="text-[11px] font-medium px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Client</button>}<button onClick={() => ackRow(r)} className="text-[11px] font-semibold px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Acknowledge</button></CompItem>)} />
      <Group title="ID / KYC issues" tone={CD.flag} empty="All clients have ID on file." info={{ title: 'ID / KYC issues', body: 'Clients who transacted without complete identification on file. Collect or re-verify their ID before the next deal — an incomplete file is the gap examiners look for.' }} items={idIssues.map(r => <CompItem key={r.id} r={r} onOpenDetail={onOpenDetail} cadIn={cadIn}><button onClick={() => onOpenClient(r.customer, r.ref)} className="text-[11px] font-semibold px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Open client</button></CompItem>)} />
    </div>);
  }

  /* =====================================================================
     LEDGER — immutable record list
  ===================================================================== */
  function Ledger({ rows, setRows, clients, setClients, settings, me, perms, log, setReceipt, client, setClient, newSignal, onNewConsumed, openLedgerForClient, openLedgerForRefs, openClientProfile, txToOpen, viewSignal, focusSignal, rateVersion, dayClosed, onOpenDayClose, cheques, setCheques, chequeSchedule, onOpenCheques, onOpenCompliance, registerNav, winId, onFileLCTR }) {
    const can = (k) => me.role === 'Owner' ? true : !!perms.Teller[k];
    const [q, setQ] = useState('');
    const [tf, setTf] = useState('All');
    const [view, setView] = useState('open');     // open (posted) | RPT | STR | ID | void | all
    const [section, setSection] = useState('records');   // records | compliance
    const [modal, setModal] = useState(false);
    const [detailId, setDetailId] = useState(null);
    const [breakdown, setBreakdown] = useState(null);   // 'volume' | 'fees' | null
    const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
    const [helpOpen, setHelpOpen] = useState(false);
    const searchWrap = useRef(null);
    useEffect(() => { if (!helpOpen) return; const h = (e) => { if (searchWrap.current && !searchWrap.current.contains(e.target)) setHelpOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [helpOpen]);
    const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' || key === 'payin' || key === 'payout' || key === 'fee' ? 'desc' : 'asc' });

    // date-range filter on the Records card
    const RANGES = [['24h', 'Past 24 hours', 1], ['7d', 'Past 7 days', 7], ['30d', 'Past 30 days', 30], ['90d', 'Past quarter', 90], ['180d', 'Past 6 months', 180], ['365d', 'Past year', 365], ['all', 'All time', null]];
    const [range, setRange] = useState('all');
    const [rangeMenu, setRangeMenu] = useState(false);
    const rangeRef = useRef(null);
    useEffect(() => { if (!rangeMenu) return; const h = (e) => { if (rangeRef.current && !rangeRef.current.contains(e.target)) setRangeMenu(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [rangeMenu]);
    const years = useMemo(() => { const ys = new Set(rows.map(r => +String(r.date).slice(0, 4))); const cur = +String(TODAY).slice(0, 4); for (let y = cur; y >= cur - 6; y--) ys.add(y); return Array.from(ys).filter(Boolean).sort((a, b) => b - a); }, [rows]);
    const rangeLabel = typeof range === 'number' ? String(range) : (RANGES.find(r => r[0] === range) || [, 'All time'])[1];
    const inRange = (date) => {
      if (range === 'all') return true;
      if (typeof range === 'number') return String(date).slice(0, 4) === String(range);
      const days = (RANGES.find(r => r[0] === range) || [])[2];
      if (days == null) return true;
      const ago = dDiff(date, TODAY);
      return ago >= -0.0001 && ago <= days;
    };

    // menu-bar "New" signal opens the modal — works whether the Ledger was
    // already open or is being mounted fresh by the same click (timestamped intent)
    const lastNew = useRef(0);
    useEffect(() => {
      if (newSignal && newSignal.n && newSignal.n !== lastNew.current) {
        lastNew.current = newSignal.n;
        setModal(true);
        onNewConsumed && onNewConsumed();
      }
    }, [newSignal]);

    // external request (e.g. from the Tagged app) to open a record's detail
    const lastTx = useRef(null);
    useEffect(() => { if (txToOpen && txToOpen.n !== lastTx.current) { lastTx.current = txToOpen.n; setDetailId(txToOpen.id); } }, [txToOpen]);

    // alerts jump: open pre-filtered to a flag bucket
    const lastView = useRef(0);
    useEffect(() => { if (viewSignal && viewSignal.n && viewSignal.n !== lastView.current) { lastView.current = viewSignal.n; setView(viewSignal.view || 'open'); } }, [viewSignal]);

    // focus mode: show exactly the set of records behind a compliance aggregate
    const [focusRefs, setFocusRefs] = useState(null);
    const [focusLabel, setFocusLabel] = useState('');
    const lastFocus = useRef(0);
    useEffect(() => { if (focusSignal && focusSignal.n && focusSignal.n !== lastFocus.current) { lastFocus.current = focusSignal.n; setFocusRefs((focusSignal.refs && focusSignal.refs.length) ? focusSignal.refs : null); setFocusLabel(focusSignal.label || ''); } }, [focusSignal]);

    // day-closed guard: block opening the New-Transaction modal
    const openNew = () => { if (dayClosed) { onOpenDayClose && onOpenDayClose(); return; } setModal(true); };

    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    const detail = detailId != null ? rows.find(r => r.id === detailId) : null;
    // surface a Back control in the window title bar (next to the traffic
    // lights) whenever a transaction page is open over the list.
    useEffect(() => {
      if (!registerNav) return;
      registerNav(winId, { canBack: detailId != null, back: () => setDetailId(null) });
      return () => registerNav(winId, null);
    }, [detailId, winId, registerNav]);
    const compCount = useMemo(() => { let n = 0; rows.forEach(r => { if (r.status === 'void') return; const f = flags[r.id] || {}; if (f.single && !r.filed) n++; if (f.str && !r.ackStr) n++; if (f.kyc && f.kyc !== 'ok' && f.idNeeded) n++; }); return n; }, [rows, flags]);

    // structured search over the book
    const search = useMemo(() => makeSearch(q), [q]);

    const filtered = useMemo(() => {
      const SORT = {
        ref: r => r.ref, date: r => r.date + ' ' + r.time, customer: r => (r.customer || '').toLowerCase(),
        type: r => r.type, payin: r => +r.inAmt || 0, payout: r => +r.outAmt || 0, fee: r => +r.fee || 0,
        // flags rank: reportable-needs-filing first, filed last (asc) — "report up, filed down"
        flags: r => { const f = flags[r.id] || {}; if (f.single && !r.filed) return 0; if (f.str && !r.ackStr) return 1; if (f.kyc && f.kyc !== 'ok' && f.idNeeded) return 2; if (r.filed) return 4; return 3; },
      };
      const get = SORT[sort.key] || SORT.date;
      // focus mode overrides every other filter — show exactly the named records
      if (focusRefs && focusRefs.length) {
        const set = new Set(focusRefs);
        const fl = rows.filter(x => set.has(x.ref));
        fl.sort((a, b) => { const va = get(a), vb = get(b); const c = va < vb ? -1 : va > vb ? 1 : 0; return sort.dir === 'asc' ? c : -c; });
        return fl;
      }
      const list = rows.filter(x => {
        const f = flags[x.id] || {};
        if (!inRange(x.date)) return false;
        if (client && x.customer !== client) return false;
        if (tf !== 'All' && x.type !== tf) return false;
        // quick chip view
        if (view === 'void' && x.status !== 'void') return false;
        if (view === 'RPT' && !(f.single && x.status !== 'void')) return false;
        if (view === 'STR' && !(f.str && x.status !== 'void')) return false;
        if (view === 'ID' && !(f.kyc && f.kyc !== 'ok' && f.idNeeded && x.status !== 'void')) return false;
        if (view === 'tagged' && !x.tagged) return false;
        // hide voided in the default 'open' view unless the search explicitly asks
        if (view === 'open' && x.status === 'void' && !search.wantsVoid) return false;
        return search.match(x, f);
      });
      list.sort((a, b) => { const va = get(a), vb = get(b); const c = va < vb ? -1 : va > vb ? 1 : 0; return sort.dir === 'asc' ? c : -c; });
      return list;
    }, [rows, q, tf, client, view, flags, range, sort, search, focusRefs]);

    // headline stats follow the active range + client (unchanged top cards)
    const stats = useMemo(() => {
      const cadOf = (a, ccy) => ccy === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', ccy) || 1);
      const src = (client ? rows.filter(r => r.customer === client) : rows).filter(r => r.status !== 'void' && inRange(r.date));
      let rpt = 0, openRpt = 0, str = new Set();
      src.forEach(r => { const f = flags[r.id] || {}; if (f.single) { rpt++; if (!r.filed) openRpt++; } if (f.str && !r.ackStr) str.add(r.customer); });
      // pay-in volume in CAD-equivalent so mixed currencies sum correctly
      return { n: src.length, vol: src.reduce((s, x) => s + cadOf(x.inAmt, x.inCcy), 0), fees: src.reduce((s, x) => s + (+x.fee || 0), 0), rpt, openRpt, str: str.size, tagged: (client ? rows.filter(r => r.customer === client) : rows).filter(r => r.tagged).length };
    }, [rows, client, flags, range]);

    // live summary of exactly what's on screen (CAD-equivalent)
    const result = useMemo(() => {
      const cadOf = (a, ccy) => ccy === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', ccy) || 1);
      let vol = 0, fees = 0, posted = 0;
      filtered.forEach(r => { if (r.status !== 'void') { vol += cadOf(r.inAmt, r.inCcy); fees += (+r.fee || 0); posted++; } });
      return { count: filtered.length, posted, vol, fees };
    }, [filtered]);

    const exportCsv = () => {
      const head = ['Ref', 'Date', 'Time', 'Customer', 'Type', 'InCcy', 'InAmt', 'Rate', 'OutCcy', 'OutAmt', 'Fee', 'Teller', 'Status', 'Filed', 'Notes'];
      const lines = rows.map(x => [x.ref, x.date, x.time, x.customer, x.type, x.inCcy, x.inAmt, x.rate, x.outCcy, x.outAmt, x.fee, x.teller, x.status, x.filed ? (x.filedInfo && x.filedInfo.ref || 'yes') : '', x.notes].map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','));
      const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ledger.csv'; a.click(); log('Exported CSV', `${rows.length} records`);
    };

    // ---- one-touch report off the CURRENT search + filters ----
    const filterChips = () => {
      const viewName = { open: 'All posted', RPT: 'Reportable ≥ $10k', STR: 'Structuring watch', ID: 'ID / KYC issues', tagged: 'Tagged', void: 'Voided' }[view] || 'All posted';
      const c = [viewName];
      if (tf !== 'All') c.push(tf);
      if (client) c.push('Client · ' + client);
      (search.chips || []).forEach(ch => c.push(ch));
      c.push(rangeLabel);
      return c;
    };
    const genReport = () => {
      const recs = filtered;
      const cadOf = (a, ccy) => ccy === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', ccy) || 1);
      let vol = 0, fees = 0, n = 0;
      recs.forEach(r => { if (r.status !== 'void') { vol += cadOf(r.inAmt, r.inCcy); fees += (+r.fee || 0); n++; } });
      const chips = filterChips();
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      const body = recs.map(r => {
        const f = flags[r.id] || {}; const v = r.status === 'void';
        const fl = v ? 'VOID' : ([f.single ? 'RPT' : '', f.str ? 'STR' : '', (f.kyc && f.kyc !== 'ok' && f.idNeeded) ? 'ID' : ''].filter(Boolean).join(' ') || '—');
        return `<tr${v ? ' class="void"' : ''}><td class="mono">${esc(r.ref)}</td><td>${esc(r.date)} <span class="mut">${esc(r.time)}</span></td><td class="b">${esc(r.customer)}</td><td class="mut">${esc(r.type)}</td><td class="r">${num(r.inAmt)} <span class="mut">${esc(r.inCcy)}</span></td><td class="r grn">${r.outAmt === '' ? '—' : num(r.outAmt)} <span class="mut">${esc(r.outCcy)}</span></td><td class="r">${fmt(r.fee, 'CAD')}</td><td class="mut">${esc(r.teller)}</td><td class="mono c">${fl}</td></tr>`;
      }).join('');
      const w = window.open('', '_blank', 'width=980,height=1100');
      if (!w) { log('Report blocked', 'Allow pop-ups to print the report'); return; }
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ledger report</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:34px 40px;color:#0a0a0a;}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0a0a0a;padding-bottom:15px;margin-bottom:18px;}
.bd{display:flex;align-items:center;gap:9px;}
.logo{width:30px;height:30px;background:#0a0a0a;color:#fff;border-radius:7px;display:grid;place-items:center;font-family:'Space Mono',monospace;font-weight:700;font-size:13px;}
.wm{font-family:'Space Mono',monospace;font-weight:700;font-size:12px;letter-spacing:.04em;}
.h1{font-size:22px;font-weight:800;margin-top:11px;}
.meta{text-align:right;font-size:11px;color:#666;line-height:1.7;}
.meta b{color:#0a0a0a;font-family:'Space Mono',monospace;}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px;}
.chip{font-size:11px;font-family:'Space Mono',monospace;background:#f1f0ec;border:1px solid #e2e0d9;border-radius:999px;padding:3px 10px;color:#333;}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#e2e0d9;border:1px solid #e2e0d9;margin-bottom:18px;}
.kpi{background:#fff;padding:11px 14px;}
.kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#777;}
.kpi .v{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px;}
table{border-collapse:collapse;width:100%;}
th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#777;font-weight:600;padding:7px 9px;background:#f1f0ec;border-bottom:1px solid #ddd;}
td{font-size:11.5px;padding:6px 9px;border-bottom:1px solid #f0efe9;}
.r{text-align:right;font-variant-numeric:tabular-nums;}.c{text-align:center;}
.mono{font-family:'Space Mono',monospace;font-size:10px;color:#666;}
.mut{color:#999;}.b{font-weight:600;}.grn{color:#1f8a4c;}
tr.void td{opacity:.5;text-decoration:line-through;}
.ft{margin-top:14px;font-size:10px;color:#999;}
@page{margin:13mm;}
</style></head><body>
<div class="hd"><div><div class="bd"><span class="logo">CD</span><span class="wm">CURRENCYDESK OS</span></div><div class="h1">Ledger Report</div></div>
<div class="meta"><b>${esc(rangeLabel)}</b><div>Generated ${esc(new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''))}</div><div>By ${esc(me.name)} · ${esc(me.role)}</div></div></div>
<div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>
<div class="kpis"><div class="kpi"><div class="l">Records</div><div class="v">${recs.length}</div></div><div class="kpi"><div class="l">Pay-in volume (CAD)</div><div class="v">${fmt(vol, 'CAD')}</div></div><div class="kpi"><div class="l">Fees collected</div><div class="v">${fmt(fees, 'CAD')}</div></div></div>
<table><thead><tr><th>Ref</th><th>Date / time</th><th>Customer</th><th>Type</th><th class="r">Pay-in</th><th class="r">Pay-out</th><th class="r">Fee</th><th>Teller</th><th class="c">Flags</th></tr></thead><tbody>${body || '<tr><td colspan="9" style="padding:14px;color:#999;">No records match the current filters.</td></tr>'}</tbody></table>
<div class="ft">RPT = reportable ≥ ${fmt(THRESHOLD, 'CAD')} · STR = structuring watch · ID = KYC exception. Volume shown in CAD-equivalent at live spot. ${n} posted of ${recs.length} shown.</div>
</body></html>`);
      w.document.close();
      setTimeout(() => { w.focus(); w.print(); }, 400);
      log('Report generated', `${recs.length} records · ${chips.join(' · ')}`);
    };

    const setViewToggle = (v) => { setFocusRefs(null); setView(cur => cur === v ? 'open' : v); };
    const toggleTag = (x) => { setRows(rs => rs.map(r => r.id === x.id ? { ...r, tagged: !r.tagged, tagInfo: r.tagged ? null : { by: me.name, at: stamp(), note: '' } } : r)); log(x.tagged ? 'Tag removed' : 'Transaction tagged', `${x.ref} · follow-up`); };
    const COLS = [['', null], ['Ref', 'ref'], ['Date', 'date'], ['Customer', 'customer'], ['Type', 'type'], ['Pay-in', 'payin'], ['Pay-out', 'payout'], ['Fee', 'fee'], ['Flags', 'flags']];

    return (<div className="flex flex-col" style={{ height: '100%', position: 'relative', background: CD.paper, overflow: 'hidden' }}>
      <div className="fld-bar fld-pinned" style={{ '--ft': '#1D6B45' }}>
        {[['records', 'Records', 'scroll'], ['compliance', 'Compliance', 'shield']].map(([id, label, ic]) => { const on = section === id; const badge = id === 'compliance' ? compCount : 0; return (
          <button key={id} onClick={() => setSection(id)} className={'fld-tab' + (on ? ' on' : '')}><Ic n={ic} s={13} c={on ? '#fff' : CD.mute} /> {label}{badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: CD.flag, color: '#fff', borderRadius: 4, fontFamily: 'Space Mono, monospace', marginLeft: 2 }}>{badge}</span>}</button>); })}
      </div>
      <div className="flex-1 overflow-auto">
      {section === 'compliance' && <LedgerCompliance rows={rows} flags={flags} settings={settings} clients={clients} me={me} setRows={setRows} log={log} onOpenDetail={setDetailId} onOpenRecordsWindow={openLedgerForRefs} onOpenClient={(n, ref) => { openClientProfile ? openClientProfile(n, ref) : (openLedgerForClient && openLedgerForClient(n)); }} onOpenFocus={(refs, label) => { setSection('records'); setFocusRefs(refs); setFocusLabel(label || ''); }} onOpenCompliance={onOpenCompliance} onOpenAccount={openLedgerForClient} onFileLCTR={onFileLCTR} />}
      {section === 'records' && (<>
      {dayClosed && (
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: CD.inkSoft, color: 'var(--cd-on-ink)' }}>
          <Ic n="lock" s={14} c="var(--cd-on-ink)" />
          <span className="text-[12.5px]">The trading day is closed — the book is read-only. Reopen from Till & Cash Drawer to post new transactions.</span>
          {onOpenDayClose && <button onClick={onOpenDayClose} className="ml-auto text-[11px] font-semibold px-2.5 py-1" style={{ background: 'var(--cd-on-ink-faint)', borderRadius: 6 }}>Open Till →</button>}
        </div>
      )}
      {/* stat strip — cards filter / drill into the list */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ borderBottom: `1px solid ${CD.line}`, background: CD.panel }}>
        <div className="relative" ref={rangeRef} style={{ borderRight: `1px solid ${CD.lineSoft}` }}>
          <button onClick={() => setRangeMenu(o => !o)} className="w-full text-left px-5 py-3.5" style={{ cursor: 'pointer', background: rangeMenu ? 'var(--cd-chip)' : 'transparent' }}>
            <div className="text-[11px] flex items-center gap-1" style={{ color: CD.mute }}>{client ? `Records · ${client}` : 'Records'} <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><Ic n="chev" s={11} c={CD.mute} /></span></div>
            <div className="text-lg font-semibold leading-tight" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{stats.n}</div>
            <div className="text-[10px] mt-0.5" style={{ color: CD.faint }}>{rangeLabel}{view !== 'open' ? ' · filtered' : ''}</div>
          </button>
          {rangeMenu && (
            <div className="absolute left-3 top-full mt-1 py-1.5" style={{ width: 216, background: 'var(--cd-paper-soft)', border: `1px solid ${CD.line}`, borderRadius: 12, boxShadow: '0 14px 34px -10px var(--cd-shade)', zIndex: 40 }}>
              <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Time range</div>
              {RANGES.map(([id, label]) => { const on = range === id; return (
                <button key={id} onClick={() => { setRange(id); setRangeMenu(false); }} className="w-full flex items-center justify-between px-3 py-1.5 text-left text-sm" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.text }}>
                  {label}{on && <Ic n="check" s={13} c="var(--cd-on-ink)" />}
                </button>); })}
              <div className="my-1" style={{ borderTop: `1px solid ${CD.lineSoft}` }}></div>
              <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>By year</div>
              <div className="px-2.5 pb-1 flex flex-wrap gap-1.5">
                {years.map(y => { const on = range === y; return (
                  <button key={y} onClick={() => { setRange(y); setRangeMenu(false); }} className="px-2 py-1 text-xs font-medium" style={{ borderRadius: 7, fontFamily: 'Space Mono, monospace', background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, border: `1px solid ${on ? CD.ink : CD.line}` }}>{y}</button>); })}
              </div>
            </div>
          )}
        </div>
        <StatCard label="Pay-in volume" value={fmt(stats.vol, 'CAD')} sub="view breakdown ›" onClick={() => setBreakdown('volume')} />
        <StatCard label="Fees collected" value={fmt(stats.fees, 'CAD')} sub="view earnings ›" onClick={() => setBreakdown('fees')} />
        <StatCard label={`Reportable ≥ ${fmt(THRESHOLD, 'CAD')}`} value={stats.openRpt > 0 ? `${stats.openRpt} open` : (stats.rpt > 0 ? 'all filed' : '0')} sub={stats.rpt > 0 ? `${stats.rpt} total` : null} flag={stats.openRpt > 0} onClick={() => setViewToggle('RPT')} active={view === 'RPT'} />
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {client && <span className="flex items-center gap-2 text-xs px-2.5 py-1.5" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}>Viewing {client} <button onClick={() => setClient(null)}><Ic n="x" s={13} /></button></span>}
        <div ref={searchWrap} className="relative flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${helpOpen ? CD.ink : CD.line}`, borderRadius: 8, transition: 'border-color .12s' }}>
            <Ic n="search" s={15} c={CD.mute} />
            <input value={q} onChange={e => { setQ(e.target.value); if (e.target.value) setFocusRefs(null); }} onFocus={() => setHelpOpen(true)} placeholder="Search anything — e.g. payout php, fee &gt; 50, remittance aran…" className="w-full outline-none text-sm bg-transparent" style={{ minWidth: 0 }} />
            {q && <button onClick={() => setQ('')} title="Clear" className="grid place-items-center flex-none" style={{ width: 18, height: 18, borderRadius: 5, background: CD.lineSoft }}><Ic n="x" s={12} c={CD.mute} /></button>}
            <button onClick={() => setHelpOpen(o => !o)} title="Search tips" className="grid place-items-center flex-none" style={{ width: 18, height: 18, borderRadius: 5, color: CD.mute }}><span style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 700 }}>?</span></button>
          </div>
          {helpOpen && (
            <div className="absolute left-0 top-full mt-1.5 p-2.5" style={{ width: 340, maxWidth: '90vw', background: 'var(--cd-paper-soft)', border: `1px solid ${CD.line}`, borderRadius: 12, boxShadow: '0 16px 40px -12px var(--cd-shade)', zIndex: 50 }}>
              <div className="px-1.5 pb-1.5 text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Try a search — terms stack with AND</div>
              <div className="grid grid-cols-1 gap-0.5">
                {(SEARCH_EXAMPLES || []).map(([ex, desc]) => (
                  <button key={ex} onClick={() => { setQ(ex); setHelpOpen(false); }} className="flex items-center justify-between gap-3 px-2 py-1.5 text-left" style={{ borderRadius: 7 }} onMouseEnter={e => e.currentTarget.style.background = 'var(--cd-chip)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, color: CD.ink }}>{ex}</span>
                    <span className="text-[11px] text-right" style={{ color: CD.mute }}>{desc}</span>
                  </button>
                ))}
              </div>
              <div className="px-1.5 pt-2 mt-1 text-[10.5px] leading-relaxed" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.faint }}>Search by currency (php, usd, euro), side (payin / payout), type (cheque, remittance), people (customer / teller), money (fee, amount, payout with &gt; &lt; or 1000..5000), date, or status (reportable, unfiled, structuring, tagged, voided).</div>
            </div>
          )}
        </div>
        <select value={tf} onChange={e => setTf(e.target.value)} className="px-3 py-2 text-sm outline-none" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 8 }}><option>All</option>{TYPES.map(t => <option key={t}>{t}</option>)}</select>
        <button onClick={openNew} disabled={dayClosed} title={dayClosed ? 'Day is closed — reopen to post' : 'New transaction'} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: dayClosed ? CD.mute : CD.ink, borderRadius: 8, cursor: dayClosed ? 'not-allowed' : 'pointer', opacity: dayClosed ? 0.7 : 1, transition: 'background .16s ease, transform .07s ease' }} onMouseEnter={e => { if (!dayClosed) e.currentTarget.style.background = CD.green; }} onMouseLeave={e => { if (!dayClosed) e.currentTarget.style.background = CD.ink; }} onMouseDown={e => { if (!dayClosed) e.currentTarget.style.transform = 'scale(0.97)'; }} onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}><Ic n="plus" s={15} /> New transaction</button>
        {can('canExport') && <button onClick={genReport} title="Generate a printable report from the current search & filters" className="flex items-center gap-1.5 pl-2.5 pr-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8, transition: 'background .16s ease, transform .07s ease' }} onMouseEnter={e => e.currentTarget.style.background = CD.flag} onMouseLeave={e => e.currentTarget.style.background = CD.ink} onMouseDown={e => e.currentTarget.style.transform = 'scale(0.97)'} onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}>
          <span className="grid place-items-center" style={{ width: 18, height: 18, background: 'var(--cd-on-ink-faint)', borderRadius: 5 }}><Ic n="plus" s={13} c="var(--cd-on-ink)" /></span>
          Generate report
        </button>}
      </div>

      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
        <Chip on={view === 'open'} onClick={() => { setFocusRefs(null); setView('open'); }}>All posted</Chip>
        <Chip on={view === 'RPT'} onClick={() => setViewToggle('RPT')} c={CD.flag} bg={CD.flagSoft}>Reportable {stats.openRpt > 0 && `· ${stats.openRpt}`}</Chip>
        <Chip on={view === 'STR'} onClick={() => setViewToggle('STR')} c={CD.amber} bg={CD.amberSoft}>Structuring {stats.str > 0 && `· ${stats.str}`}</Chip>
        <Chip on={view === 'ID'} onClick={() => setViewToggle('ID')} c={CD.ink} bg={CD.lineSoft}>ID issues</Chip>
        <Chip on={view === 'tagged'} onClick={() => setViewToggle('tagged')} c={CD.ink} bg={CD.lineSoft}>Tagged {stats.tagged > 0 && `· ${stats.tagged}`}</Chip>
        <Chip on={view === 'void'} onClick={() => setViewToggle('void')}>Voided</Chip>
        <span className="flex items-center" style={{ marginLeft: 2 }}><window.CDOS.InfoTip title="Compliance flags" body="The desk tags each record so nothing slips through. Click a flag on a row to act on it." lines={[{k:'RPT',c:CD.flag,v:'Reportable — a Large Cash Transaction Report is due'},{k:'STR',c:CD.amber,v:'Structuring watch — smaller deals adding up'},{k:'ID',c:CD.ink,v:'KYC exception — ID missing or expired'}]} /></span>
      </div>
      {focusRefs && focusRefs.length > 0 && (
        <div className="mx-4 mb-2 flex items-center justify-between gap-2 px-3 py-2" style={{ background: CD.brassSoft, border: `1px solid ${CD.brass}`, borderRadius: 9 }}>
          <span className="text-[12px] flex items-center gap-1.5" style={{ color: 'var(--cd-brass-text)' }}><Ic n="shield" s={13} c={CD.brass} /> Showing the <b>{focusRefs.length}</b> record{focusRefs.length === 1 ? '' : 's'} {focusLabel ? <span>behind <b>{focusLabel}</b></span> : 'from a compliance aggregate'}.</span>
          <button onClick={() => setFocusRefs(null)} className="text-[11px] font-semibold px-2.5 py-1" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 6 }}>Clear focus</button>
        </div>
      )}

      {/* parsed search + live result summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-2.5">
        {search.active && search.chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Matching</span>
            {search.chips.map((c, i) => (
              <span key={i} className="inline-flex items-center text-[11px] px-2 py-1 font-medium" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 6 }}>{c}</span>
            ))}
            <button onClick={() => setQ('')} className="text-[11px] px-1.5 py-1" style={{ color: CD.mute }}>clear</button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-[11.5px]" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>
          <span><b style={{ color: CD.ink }}>{result.count}</b> {result.count === 1 ? 'record' : 'records'}</span>
          <span style={{ width: 1, height: 11, background: CD.line }}></span>
          <span>{fmt(result.vol, 'CAD')} <span style={{ color: CD.faint }}>vol</span></span>
          <span>{fmt(result.fees, 'CAD')} <span style={{ color: CD.faint }}>fees</span></span>
        </div>
      </div>

      {/* table */}
      <div className="px-4 pb-6"><div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 10 }}>
        <table className="w-full border-collapse text-sm" style={{ background: CD.panel }}>
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-left text-[11px] uppercase tracking-wide">{COLS.map(([h, key], i) => (
            <th key={i} onClick={() => key && toggleSort(key)} className="px-3 py-2.5 font-medium select-none" style={{ borderBottom: `1px solid ${CD.line}`, cursor: key ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
              <span className="inline-flex items-center gap-1" style={{ color: key && sort.key === key ? CD.ink : 'inherit' }}>{h}{key && sort.key === key && <span style={{ fontSize: 9 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}</span>
            </th>))}</tr></thead>
          <tbody>{filtered.map(x => { const f = flags[x.id] || {}; const isVoid = x.status === 'void'; return (
            <tr key={x.id} onClick={() => setDetailId(x.id)} className="cursor-pointer" style={{ borderBottom: `1px solid ${CD.lineSoft}`, opacity: isVoid ? 0.5 : 1, background: detailId === x.id ? '#f6f5f1' : 'transparent' }}
              onMouseEnter={e => { if (detailId !== x.id) e.currentTarget.style.background = 'var(--cd-paper-soft)'; }} onMouseLeave={e => { if (detailId !== x.id) e.currentTarget.style.background = 'transparent'; }}>
              <td className="pl-3 pr-0 py-2.5" onClick={e => e.stopPropagation()}><button onClick={() => toggleTag(x)} title={x.tagged ? 'Remove tag' : 'Tag for follow-up'} className="p-0.5 grid place-items-center" style={{ borderRadius: 5 }}><Ic n="bookmark" s={14} c={x.tagged ? CD.green : 'var(--cd-shade)'} /></button></td>
              <td className="px-3 py-2.5" style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, color: CD.mute, textDecoration: isVoid ? 'line-through' : 'none' }}>{x.ref}</td>
              <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: CD.text, fontVariantNumeric: 'tabular-nums' }}>{x.date}<span className="text-[11px]" style={{ color: CD.faint }}> {x.time}</span></td>
              <td className="px-3 py-2.5 font-medium" style={{ color: CD.ink }}>{x.customer ? <button onClick={e => { e.stopPropagation(); openClientProfile && openClientProfile(x.customer); }} className="text-left hover:underline" style={{ color: CD.ink, fontWeight: 500 }} title={`Open ${x.customer}'s KYC profile`}>{x.customer}</button> : <span style={{ color: CD.faint }}>—</span>}</td>
              <td className="px-3 py-2.5" style={{ color: CD.mute }}>{x.type}</td>
              <td className="px-3 py-2.5 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(x.inAmt)} <span style={{ color: CD.faint }}>{x.inCcy}</span></td>
              <td className="px-3 py-2.5 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green, fontWeight: 600 }}>{x.outAmt === '' ? '—' : num(x.outAmt)} <span style={{ color: CD.faint, fontWeight: 400 }}>{x.outCcy}</span></td>
              <td className="px-3 py-2.5 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(x.fee, 'CAD')}</td>
              <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}><div className="flex flex-wrap gap-1">
                {f.single && <FlagTag kind="RPT" filed={x.filed} onClick={() => setDetailId(x.id)} title={x.filed ? `LCTR ${x.filedInfo && x.filedInfo.ref} filed` : 'Reportable ≥ $10k — click to file'} />}
                {f.str && <FlagTag kind="STR" ack={x.ackStr} onClick={() => setDetailId(x.id)} title={`Structuring watch — ${fmt(f.agg, 'CAD')}`} />}
                {f.kyc && f.kyc !== 'ok' && f.idNeeded && <FlagTag kind="ID" onClick={() => setDetailId(x.id)} title={f.kyc} />}
                {isVoid && <span className="text-[10px] px-1.5 py-1 font-semibold" style={{ borderRadius: 5, background: CD.lineSoft, color: CD.mute, fontFamily: 'Space Mono, monospace' }}>VOID</span>}
                {!f.single && !f.str && (!f.kyc || f.kyc === 'ok' || !f.idNeeded) && !isVoid && <span style={{ color: CD.faint }}>—</span>}
              </div></td>
            </tr>); })}
            {filtered.length === 0 && <tr><td colSpan={COLS.length} className="px-4 py-14 text-center" style={{ color: CD.mute }}>
              <div className="flex flex-col items-center gap-2">
                <Ic n="search" s={26} c={CD.faint} />
                <div className="text-sm font-medium" style={{ color: CD.ink }}>No records match{search.active ? ' this search' : ''}</div>
                {search.active
                  ? <div className="text-[12px]" style={{ maxWidth: 360 }}>Nothing matches <b>{search.chips.join(' + ') || `"${q}"`}</b> in {rangeLabel.toLowerCase()}. Try removing a term or widening the date range.</div>
                  : <div className="text-[12px]">No transactions in this range yet.</div>}
                {search.active && <button onClick={() => setQ('')} className="mt-1 text-[12px] font-semibold px-3 py-1.5" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 7 }}>Clear search</button>}
              </div>
            </td></tr>}
          </tbody></table></div>
        <p className="mt-3 text-[11px] flex items-center gap-1.5" style={{ color: CD.faint }}><Ic n="shield" s={12} /> Records are permanent — a posted transaction can't be edited or deleted, only voided with a reason. Every action is written to the audit trail.</p>
      </div>
      </>)}
      </div>

      {modal && <Portal>{React.createElement((window.CDOS && window.CDOS.TxModal) || TxModal, { rows, clients, setClients, setRows, settings, me, log, prefillClient: client, rateVersion, cheques, setCheques, chequeSchedule, onOpenCheques, onClose: () => setModal(false), onDone: (id) => { setModal(false); setView('open'); setDetailId(id); } })}</Portal>}
      {detail && <TxDetail key={detail.id} {...{ row: detail, flag: flags[detail.id] || {}, settings, me, can, log, setRows, clients }} onClose={() => setDetailId(null)} onReceipt={setReceipt} onFileLCTR={onFileLCTR} onOpenClient={(n, ref) => { setDetailId(null); openClientProfile ? openClientProfile(n, ref) : (openLedgerForClient && openLedgerForClient(n)); }} />}
      {breakdown && <Portal><BreakdownModal rows={rows.filter(r => inRange(r.date))} client={client} focus={breakdown} onClose={() => setBreakdown(null)} /></Portal>}
    </div>);
  }

  /* =====================================================================
     TAGGED — desktop app: every transaction flagged for follow-up
  ===================================================================== */
  function Tagged({ rows, clients, settings, onOpen }) {
    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    const tagged = useMemo(() => rows.filter(r => r.tagged).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)), [rows]);
    return (<div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="taggedbookmark" s={16} c="var(--cd-on-ink)" /></span>
        <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Tagged transactions</div><div className="text-[11px]" style={{ color: CD.mute }}>{tagged.length} flagged for follow-up · click to open the record</div></div>
      </div>
      {tagged.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-16 px-6" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}>
          <Ic n="bookmark" s={28} c={CD.faint} />
          <div className="mt-3 text-sm font-medium" style={{ color: CD.ink }}>No tagged transactions yet</div>
          <div className="mt-1 text-[12px] max-w-xs">Open any record and press the bookmark to tag it for follow-up — flagged deals collect here for you and the owner to review.</div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-2.5">{tagged.map(x => { const f = flags[x.id] || {}; const isVoid = x.status === 'void'; return (
          <div key={x.id} onClick={() => onOpen(x.id)} role="button" tabIndex={0} className="text-left p-3.5 cursor-pointer" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11, opacity: isVoid ? 0.55 : 1 }}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-1.5" style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, color: CD.mute, textDecoration: isVoid ? 'line-through' : 'none' }}><Ic n="bookmark" s={13} c={CD.ink} />{x.ref}</span>
              <span className="text-[11px]" style={{ color: CD.faint, fontVariantNumeric: 'tabular-nums' }}>{x.date}</span>
            </div>
            <div className="font-medium mb-0.5" style={{ color: CD.ink }}>{x.customer}</div>
            <div className="text-[12px] mb-2" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{x.type} · {num(x.inAmt)} {x.inCcy} → <span style={{ color: CD.green }}>{num(x.outAmt)} {x.outCcy}</span></div>
            <div className="flex flex-wrap items-center gap-1">
              {f.single && <FlagTag kind="RPT" filed={x.filed} onClick={() => onOpen(x.id)} />}
              {f.str && <FlagTag kind="STR" ack={x.ackStr} onClick={() => onOpen(x.id)} />}
              {f.kyc && f.kyc !== 'ok' && f.idNeeded && <FlagTag kind="ID" onClick={() => onOpen(x.id)} />}
              {isVoid && <span className="text-[10px] px-1.5 py-1 font-semibold" style={{ borderRadius: 5, background: CD.lineSoft, color: CD.mute, fontFamily: 'Space Mono, monospace' }}>VOID</span>}
            </div>
            {x.tagInfo && (x.tagInfo.note || x.tagInfo.by) && <div className="mt-2 pt-2 text-[11px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.mute }}>{x.tagInfo.note ? `"${x.tagInfo.note}" — ` : 'Tagged by '}{x.tagInfo.by}</div>}
          </div>); })}</div>
      )}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Ledger, TxModal, TxDetail, Tagged });
})();
