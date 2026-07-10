/* ============================================================
   CurrencyDesk OS — Cheque cashing & clearance
   Cashing a cheque means FRONTING cash before the cheque clears —
   that's credit risk, not just a fee. This module adds the depth:
     • Capture — cheque number, maker, drawee bank, type, the cheque
       image and endorsement, with the fee taken from a per-type
       schedule and a hold period set by risk.
     • Clearance lifecycle — received → on hold → cleared / returned,
       with the hold-until date front and centre.
     • Outstanding exposure — the cash out the door that hasn't cleared,
       i.e. what's actually at risk right now.
     • NSF / fraud — flag a held cheque, record the return as a loss.
     • Fee schedule — fee % / minimum / hold days per cheque type.
   Cashing posts a ledger row (Cheque Cashing) so cash, fees and the
   audit trail stay on the one source of truth; the risk layer lives here.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, TODAY, crossRate, newTx, mkRef } = window.CDOS;
  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const addDays = (date, n) => { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + (+n || 0)); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

  /* ---- default fee schedule by cheque type (editable in the Fee schedule tab) ---- */
  function defaultSchedule() {
    return [
      { id: 'government', label: 'Government', feePct: 1.5, feeMin: 4, holdDays: 0, risk: 'low' },
      { id: 'payroll', label: 'Payroll', feePct: 2.0, feeMin: 5, holdDays: 1, risk: 'low' },
      { id: 'certified', label: 'Certified / bank draft', feePct: 1.0, feeMin: 5, holdDays: 0, risk: 'low' },
      { id: 'money_order', label: 'Money order', feePct: 1.5, feeMin: 4, holdDays: 0, risk: 'low' },
      { id: 'business', label: 'Business', feePct: 3.0, feeMin: 10, holdDays: 3, risk: 'medium' },
      { id: 'personal', label: 'Personal', feePct: 3.5, feeMin: 10, holdDays: 5, risk: 'high' },
    ];
  }
  const RISK_TONE = { low: { t: 'Low', c: CD.green, bg: CD.greenSoft }, medium: { t: 'Medium', c: CD.amber, bg: CD.amberSoft }, high: { t: 'High', c: CD.flag, bg: CD.flagSoft } };
  const feeFor = (amount, type) => { const t = type || {}; return Math.max(+t.feeMin || 0, (+amount || 0) * (+t.feePct || 0) / 100); };

  const STATUS = {
    held:     { label: 'On hold',  tone: CD.amber, soft: CD.amberSoft, ink: 'var(--cd-brass-text)', icon: 'clock' },
    cleared:  { label: 'Cleared',  tone: CD.green, soft: CD.greenSoft, ink: '#1c5c3a', icon: 'checkcircle' },
    returned: { label: 'Returned', tone: CD.flag,  soft: CD.flagSoft,  ink: CD.flag,  icon: 'ban' },
  };

  /* ---- seed cheques across the lifecycle ---- */
  function defaultCheques() {
    const sched = defaultSchedule();
    const T = (id) => sched.find(s => s.id === id);
    const mk = (o) => { const t = T(o.typeId); const fee = +feeFor(o.amount, t).toFixed(2); return Object.assign({
      id: 'c' + Math.random().toString(36).slice(2, 8), ccy: 'CAD', feeCad: fee, netCad: +(o.amount - fee).toFixed(2),
      typeId: o.typeId, typeLabel: t.label, holdDays: t.holdDays, endorsed: true, image: null, nsf: false, fraud: false,
      timeline: [], createdBy: 'A. Singh', txId: null,
    }, o); };
    return [
      mk({ ref: 'CHQ-260618-002', chequeNumber: '004821', maker: 'Northbridge Imports Ltd.', draweeBank: 'RBC Royal Bank', customer: 'Jakob Miller', typeId: 'business', amount: 4200, receivedDate: '2026-06-18', status: 'held', holdUntil: '2026-06-23',
        timeline: [{ status: 'held', ts: '2026-06-18 09:48', by: 'A. Singh', note: 'Cash fronted — 3-day business hold' }] }),
      mk({ ref: 'CHQ-260618-001', chequeNumber: '1180', maker: 'Service Canada', draweeBank: 'Bank of Canada', customer: 'Rachel Carter', typeId: 'government', amount: 1340, receivedDate: '2026-06-18', status: 'cleared', holdUntil: '2026-06-18',
        timeline: [{ status: 'held', ts: '2026-06-18 10:20', by: 'M. Costa' }, { status: 'cleared', ts: '2026-06-18 14:02', by: 'System', note: 'Government cheque — same-day clearance' }] }),
      mk({ ref: 'CHQ-260616-004', chequeNumber: '00917', maker: 'Brooke Lawson', draweeBank: 'TD Canada Trust', customer: 'Brooke Lawson', typeId: 'personal', amount: 2600, receivedDate: '2026-06-16', status: 'returned', nsf: true, holdUntil: '2026-06-21', returnedReason: 'NSF — insufficient funds',
        timeline: [{ status: 'held', ts: '2026-06-16 16:30', by: 'A. Singh', note: '5-day personal hold' }, { status: 'returned', ts: '2026-06-19 09:10', by: 'J. Masri', note: 'Returned NSF — cash loss, customer contacted' }] }),
      mk({ ref: 'CHQ-260617-003', chequeNumber: '88204', maker: 'Maple Payroll Services', draweeBank: 'Scotiabank', customer: 'Jakob Miller', typeId: 'payroll', amount: 1850, receivedDate: '2026-06-17', status: 'cleared', holdUntil: '2026-06-18',
        timeline: [{ status: 'held', ts: '2026-06-17 11:05', by: 'A. Singh' }, { status: 'cleared', ts: '2026-06-18 08:30', by: 'System', note: 'Payroll cleared next business day' }] }),
    ];
  }

  const KKEY = 'cdos_cheques_v1', SKEY = 'cdos_cheque_schedule_v1';
  const load = (k, def) => { try { const r = JSON.parse(localStorage.getItem(k) || 'null'); return r && (Array.isArray(r) ? r.length : true) ? r : def(); } catch (e) { return def(); } };

  /* ===================== atoms ===================== */
  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };
  const inputCls = 'w-full text-sm px-2.5 py-2 outline-none';
  function Field({ label, hint, children }) { return (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</label>); }
  function DRow({ k, v, mono, accent }) { return (<div className="flex justify-between items-baseline gap-4 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="text-[12px] flex-none" style={{ color: CD.mute }}>{k}</span><span className="text-sm font-medium text-right" style={{ color: accent || CD.ink, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{v}</span></div>); }
  function StatusPill({ status, small }) { const s = STATUS[status] || STATUS.held; return <span className="inline-flex items-center gap-1.5 font-semibold" style={{ background: s.soft, color: s.ink, borderRadius: 999, fontSize: small ? 10 : 11, padding: small ? '2px 8px' : '3px 10px' }}><Ic n={s.icon} s={small ? 10 : 12} c={s.ink} />{s.label}</span>; }

  /* ===================== CAPTURE MODAL ===================== */
  function CaptureModal({ rows, setRows, clients, schedule, me, log, cheques, setCheques, onClose, onDone }) {
    const names = useMemo(() => { const s = new Set(Object.keys(clients || {})); (rows || []).forEach(r => r.customer && s.add(r.customer)); return Array.from(s).sort(); }, [clients, rows]);
    const [customer, setCustomer] = useState('');
    const [typeId, setTypeId] = useState('payroll');
    const [amount, setAmount] = useState('');
    const [chequeNumber, setChequeNumber] = useState('');
    const [maker, setMaker] = useState('');
    const [draweeBank, setDraweeBank] = useState('');
    const [endorsed, setEndorsed] = useState(false);
    const [image, setImage] = useState(null);
    const [holdOverride, setHoldOverride] = useState(null);

    const type = schedule.find(t => t.id === typeId) || schedule[0];
    const amtN = parseFloat(amount) || 0;
    const fee = +feeFor(amtN, type).toFixed(2);
    const net = +(amtN - fee).toFixed(2);
    const holdDays = holdOverride != null ? holdOverride : type.holdDays;
    const holdUntil = addDays(TODAY, holdDays);
    const rt = RISK_TONE[type.risk] || RISK_TONE.low;
    const canSave = amtN > 0 && maker.trim() && chequeNumber.trim() && customer.trim() && net >= 0;
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);

    const upload = (file) => { const r = new FileReader(); r.onload = () => setImage(r.result); r.readAsDataURL(file); };

    const save = () => {
      if (!canSave) return;
      const seqC = (cheques || []).filter(c => c.receivedDate === TODAY).length + 1;
      const ref = 'CHQ-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seqC).padStart(3, '0');
      // ledger row: cheque cashed — cash fronted out of the drawer (one source of truth)
      const seqL = (rows || []).filter(r => r.date === TODAY && r.status !== 'void').length + 1;
      const lref = mkRef(TODAY, seqL);
      const tx = newTx({ ref: lref, type: 'Cheque Cashing', customer, inCcy: 'CAD', inAmt: amtN, rate: 1, outCcy: 'CAD', outAmt: net, fee, teller: me.name, notes: `${ref} · ${type.label} cheque #${chequeNumber} · ${maker} (${draweeBank})`, chequeRef: ref, createdBy: me.name, createdAt: stamp() });
      setRows(r => [tx, ...r]);
      const chq = { id: 'c' + Date.now(), ref, chequeNumber: chequeNumber.trim(), maker: maker.trim(), draweeBank: draweeBank.trim(), customer: customer.trim(), typeId, typeLabel: type.label, ccy: 'CAD', amount: amtN, feeCad: fee, netCad: net, endorsed, image, holdDays, receivedDate: TODAY, holdUntil, status: holdDays === 0 ? 'held' : 'held', nsf: false, fraud: false, timeline: [{ status: 'held', ts: stamp(), by: me.name, note: `Cash fronted ${fmt(net, 'CAD')} · ${holdDays === 0 ? 'no hold' : holdDays + '-day hold'}` }], txId: tx.id, txRef: lref, createdBy: me.name };
      setCheques(list => [chq, ...list]);
      log && log('Cheque cashed', `${ref} · ${fmt(amtN, 'CAD')} ${type.label} · fronted ${fmt(net, 'CAD')} · hold to ${holdUntil}`);
      onDone && onDone(chq.id);
    };

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 560, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex-none flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="receipt" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Cash a cheque</div><div className="text-[11px]" style={{ color: CD.mute }}>Teller {me.name} · {TODAY}</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {/* customer */}
          <Field label="Customer (presenting the cheque)">
            <input value={customer} onChange={e => setCustomer(e.target.value)} list="chq-clients" placeholder="Type a name…" className={inputCls} style={inputSty} />
            <datalist id="chq-clients">{names.map(n => <option key={n} value={n} />)}</datalist>
          </Field>

          {/* cheque type → fee schedule */}
          <Field label="Cheque type" hint={`${type.feePct}% · min ${fmt(type.feeMin, 'CAD')} · ${type.holdDays}d hold`}>
            <div className="flex flex-wrap gap-1.5">
              {schedule.map(t => { const on = typeId === t.id; const r = RISK_TONE[t.risk]; return (
                <button key={t.id} onClick={() => { setTypeId(t.id); setHoldOverride(null); }} className="px-2.5 py-1.5 text-[12px] font-medium flex items-center gap-1.5" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.text }}>
                  {t.label}<span style={{ width: 6, height: 6, borderRadius: '50%', background: on ? 'var(--cd-panel)' : r.c, opacity: on ? 0.7 : 1 }} />
                </button>); })}
            </div>
          </Field>

          {/* cheque capture */}
          <div className="p-3 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cheque amount"><div className="flex" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, overflow: 'hidden' }}><span className="px-2.5 grid place-items-center text-sm font-semibold" style={{ background: 'var(--cd-chip)', borderRight: `1px solid ${CD.line}` }}>CAD</span><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder="0.00" className="flex-1 min-w-0 px-3 py-2 text-lg font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums' }} /></div></Field>
              <Field label="Cheque number"><input value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} placeholder="e.g. 004821" className={inputCls} style={inputSty} /></Field>
              <Field label="Maker (who wrote it)"><input value={maker} onChange={e => setMaker(e.target.value)} placeholder="Payer name / business" className={inputCls} style={inputSty} /></Field>
              <Field label="Drawee bank"><input value={draweeBank} onChange={e => setDraweeBank(e.target.value)} placeholder="e.g. RBC Royal Bank" className={inputCls} style={inputSty} /></Field>
            </div>
            {/* image + endorsement */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cheque image">
                {image ? <div className="flex items-center gap-2"><img src={image} alt="cheque" className="h-12" style={{ border: `1px solid ${CD.line}`, borderRadius: 6 }} /><button onClick={() => setImage(null)} className="text-[11px]" style={{ color: CD.flag }}>Remove</button></div>
                  : <label className="flex items-center justify-center gap-1.5 text-[11px] px-2 py-2.5 cursor-pointer" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8 }}><Ic n="camera" s={13} /> Capture / upload<input type="file" accept="image/*" className="hidden" onChange={e => e.target.files[0] && upload(e.target.files[0])} /></label>}
              </Field>
              <Field label="Endorsement">
                <button onClick={() => setEndorsed(v => !v)} className="w-full flex items-center gap-2 px-2.5 py-2" style={{ border: `1px solid ${endorsed ? CD.ink : CD.line}`, borderRadius: 8, background: endorsed ? 'var(--cd-chip)' : 'var(--cd-panel)' }}>
                  <span className="grid place-items-center" style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${endorsed ? CD.ink : CD.faint}`, background: endorsed ? CD.ink : 'transparent' }}>{endorsed && <Ic n="check" s={12} c="var(--cd-on-ink)" />}</span>
                  <span className="text-[12.5px]" style={{ color: CD.ink }}>Signed on the back</span>
                </button>
              </Field>
            </div>
          </div>

          {/* fronting + hold summary — the risk */}
          <div className="p-3" style={{ background: rt.bg, borderRadius: 10, border: `1px solid ${rt.c}` }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: rt.c }}><Ic n="shield" s={13} c={rt.c} /> Fronting cash · {rt.t.toLowerCase()} risk</span>
              <span className="text-[11px]" style={{ color: CD.mute }}>fee {fmt(fee, 'CAD')}</span>
            </div>
            <div className="flex items-center justify-between">
              <div><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Cash to customer now</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(net, 'CAD')}</div></div>
              <Ic n="arrowright" s={16} c={CD.faint} />
              <div className="text-right"><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>At risk until</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{holdDays === 0 ? 'cleared' : holdUntil}</div></div>
            </div>
            <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: `1px solid ${rt.c}33` }}>
              <span className="text-[11px]" style={{ color: CD.mute }}>Hold</span>
              {[0, 1, 3, 5, 7].map(d => <button key={d} onClick={() => setHoldOverride(d)} className="text-[11px] px-2 py-0.5 font-medium" style={{ borderRadius: 6, border: `1px solid ${holdDays === d ? CD.ink : CD.line}`, background: holdDays === d ? CD.ink : 'transparent', color: holdDays === d ? 'var(--cd-on-ink)' : CD.mute }}>{d === 0 ? 'None' : d + 'd'}</button>)}
            </div>
          </div>
        </div>
        <div className="flex-none flex items-center justify-between gap-3 px-5 py-4" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <div className="text-[12px]" style={{ color: CD.mute }}>{amtN > 0 ? <>Front <b style={{ color: CD.ink }}>{fmt(net, 'CAD')}</b> · keep <b style={{ color: CD.green }}>{fmt(fee, 'CAD')}</b></> : 'Enter the cheque amount'}</div>
          <button onClick={save} disabled={!canSave} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: canSave ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: canSave ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> Cash & hold</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== DETAIL DRAWER ===================== */
  function ChequeDetail({ c, me, log, setCheques, onClose }) {
    const overdue = c.status === 'held' && c.holdUntil < TODAY;
    const update = (patch, action, note) => { setCheques(list => list.map(x => x.id === c.id ? { ...x, ...patch, timeline: [...(x.timeline || []), { status: patch.status || x.status, ts: stamp(), by: me.name, note }] } : x)); log && log(action, `${c.ref} · ${note || ''}`); };
    const clear = () => update({ status: 'cleared' }, 'Cheque cleared', 'Funds confirmed by drawee bank');
    const returnNsf = () => update({ status: 'returned', nsf: true, returnedReason: 'NSF — insufficient funds' }, 'Cheque returned NSF', `loss ${fmt(c.netCad, 'CAD')}`);
    const returnFraud = () => update({ status: 'returned', fraud: true, returnedReason: 'Fraud — suspect cheque' }, 'Cheque flagged fraud', `loss ${fmt(c.netCad, 'CAD')}`);
    const sched = STATUS[c.status] || STATUS.held;
    return (<Portal><div className="fixed inset-0 flex justify-end" style={{ background: 'var(--cd-scrim)', zIndex: 9100 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="h-full overflow-auto" style={{ width: 440, maxWidth: '92vw', background: CD.paper, borderLeft: `1px solid ${CD.ink}`, boxShadow: '-12px 0 40px var(--cd-shade)' }}>
        <div className="sticky top-0 px-5 py-4 flex items-start justify-between" style={{ background: CD.paper, borderBottom: `1px solid ${CD.line}`, zIndex: 5 }}>
          <div>
            <div className="flex items-center gap-2"><span className="font-semibold text-lg" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{c.ref}</span><StatusPill status={c.status} /></div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{c.typeLabel} · #{c.chequeNumber} · {c.createdBy}</div>
          </div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4 space-y-5">
          {/* exposure banner */}
          {c.status === 'held' && <div className="p-3" style={{ background: overdue ? CD.flagSoft : CD.amberSoft, borderRadius: 11 }}>
            <div className="flex items-center justify-between">
              <div><div className="text-[10px] uppercase tracking-widest" style={{ color: overdue ? CD.flag : 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace' }}>Cash at risk</div><div className="text-xl font-bold" style={{ color: overdue ? CD.flag : 'var(--cd-brass-text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(c.netCad, 'CAD')}</div></div>
              <div className="text-right"><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{overdue ? 'Overdue' : 'Clears'}</div><div className="text-[15px] font-bold" style={{ color: overdue ? CD.flag : CD.ink }}>{c.holdUntil}{overdue ? '' : ` · ${Math.max(0, daysBetween(TODAY, c.holdUntil))}d`}</div></div>
            </div>
          </div>}
          {c.status === 'returned' && <div className="p-3 flex items-center gap-2" style={{ background: CD.flagSoft, borderRadius: 11 }}><Ic n="alert" s={18} c={CD.flag} /><div><div className="text-[13px] font-semibold" style={{ color: CD.flag }}>Returned — {fmt(c.netCad, 'CAD')} loss</div><div className="text-[11px]" style={{ color: '#8a3b30' }}>{c.returnedReason}{c.fraud ? ' · fraud' : c.nsf ? ' · NSF' : ''}</div></div></div>}

          {/* cheque capture */}
          <div>
            <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Cheque</div>
            <DRow k="Maker" v={c.maker} />
            <DRow k="Drawee bank" v={c.draweeBank || '—'} />
            <DRow k="Cheque #" v={c.chequeNumber} mono />
            <DRow k="Type" v={c.typeLabel} />
            <DRow k="Customer" v={c.customer} />
            <DRow k="Endorsed" v={c.endorsed ? 'Yes — signed' : 'Not endorsed'} accent={c.endorsed ? CD.green : CD.flag} />
            <DRow k="Face value" v={fmt(c.amount, 'CAD')} mono />
            <DRow k="Fee kept" v={fmt(c.feeCad, 'CAD')} mono accent={CD.green} />
            <DRow k="Cash fronted" v={fmt(c.netCad, 'CAD')} mono />
            {c.image && <div className="mt-2"><img src={c.image} alt="cheque" style={{ maxWidth: '100%', border: `1px solid ${CD.line}`, borderRadius: 8 }} /></div>}
          </div>

          {/* lifecycle */}
          <div>
            <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Clearance timeline</div>
            <div className="space-y-2">
              {(c.timeline || []).map((e, i) => { const s = STATUS[e.status] || STATUS.held; return (
                <div key={i} className="flex gap-2.5">
                  <span className="grid place-items-center flex-none mt-0.5" style={{ width: 22, height: 22, borderRadius: '50%', background: s.soft }}><Ic n={s.icon} s={12} c={s.ink} /></span>
                  <div><div className="text-[12.5px] font-medium" style={{ color: CD.ink }}>{s.label}</div><div className="text-[11px]" style={{ color: CD.mute }}>{e.ts} · {e.by}{e.note ? ` — ${e.note}` : ''}</div></div>
                </div>); })}
            </div>
          </div>

          {/* actions */}
          {c.status === 'held' && (
            <div className="flex flex-wrap gap-2">
              <button onClick={clear} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.green, borderRadius: 8 }}><Ic n="checkcircle" s={15} c="var(--cd-on-ink)" /> Mark cleared</button>
              <button onClick={returnNsf} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.flagSoft}`, background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="ban" s={15} c={CD.flag} /> Return NSF</button>
              <button onClick={returnFraud} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, color: CD.flag, borderRadius: 8 }}><Ic n="alert" s={15} c={CD.flag} /> Flag fraud</button>
            </div>
          )}
          {c.txRef && <div className="text-[11px]" style={{ color: CD.faint }}>Ledger {c.txRef}</div>}
        </div>
      </div>
    </div></Portal>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    _cheques: { defaultSchedule, defaultCheques, KKEY, SKEY, load, STATUS, RISK_TONE, feeFor, addDays, daysBetween, StatusPill, CaptureModal, ChequeDetail }
  });
})();
