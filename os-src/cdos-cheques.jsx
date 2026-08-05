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

   ---- WHERE A CHEQUE ACTUALLY LIVES ----

   On the ledger. `cdos_cheques_v1` is a cache of it.

   This header used to claim that "cashing posts a ledger row … so cash,
   fees and the audit trail stay on the one source of truth", and none of
   it was true: `save()` built a browser transaction, pushed it into an
   array, wrote the cheque into localStorage, and the server never heard
   about a dollar of it. The desk paid out real money from a real drawer
   and the book that the drawer is counted against went on showing the
   figure from before.

   Now every one of the four money events — cashing, clearing, a return,
   and a reversal of a cashing done in error — is a server call, and the
   server answers with the cheque and with the drawer's new balances.
   Nothing here computes cash, and nothing here is applied optimistically:
   if the ledger refuses, nothing is cashed and the screen says why. See
   docs/CHEQUE_CASHING.md for the three journals and
   docs/CASH_OWNERSHIP_INVARIANTS.md for why there is only one book.

   The one thing still held locally is the cheque IMAGE, deliberately —
   images are being dealt with separately and there is a ceiling on intake
   (tests/e2e/id-intake-seam.spec.ts). It lives in its own small store
   keyed by the ledger's cheque id, so refreshing the register from the
   server cannot silently drop the scans.
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
    /* A cashing that should never have happened, undone. Its own state and
       not a shade of "returned": a returned cheque cost the desk the face
       amount, a reversed one cost it nothing, and a screen that showed
       them the same would put a mis-key into the losses figure. */
    reversed: { label: 'Reversed', tone: CD.mute,  soft: CD.lineSoft,  ink: CD.mute,  icon: 'x' },
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

  const KKEY = 'cdos_cheques_v1', SKEY = 'cdos_cheque_schedule_v1', IKEY = 'cdos_cheque_images_v1';
  const load = (k, def) => { try { const r = JSON.parse(localStorage.getItem(k) || 'null'); return r && (Array.isArray(r) ? r.length : true) ? r : def(); } catch (e) { return def(); } };

  /* ---- talking to the book ----

     `ledger()` answers null on a desk that has no server — a standalone
     demonstration, or a plan without the ledger. That desk keeps the
     screens and keeps its local store, and the difference is stated on
     screen rather than hidden: a browser copy is not a record. */
  const ledger = () => (window.CDOS.Backend && window.CDOS.Backend.cashCheque ? window.CDOS.Backend : null);

  /* The cheque image, held apart from the cheque. A scan is tens of
     kilobytes and is not going to the server in this change, so it cannot
     live on the cached cheque object — the cache is replaced wholesale
     every time the register is re-read and the images would go with it.
     Keyed by the LEDGER's cheque id, which is the only identifier both
     sides agree on. */
  const images = () => { try { return JSON.parse(localStorage.getItem(IKEY) || '{}') || {}; } catch (e) { return {}; } };
  const keepImage = (chequeId, dataUrl) => {
    if (!chequeId || !dataUrl) return;
    try { const all = images(); all[chequeId] = dataUrl; localStorage.setItem(IKEY, JSON.stringify(all)); } catch (e) {}
  };

  /* One cheque from the ledger, in the shape these screens already speak.
     Money arrives as decimal strings and is turned into numbers only for
     rendering — the figures themselves are the server's and nothing here
     recomputes one of them. */
  function fromServer(c, imgs) {
    const held = imgs || images();
    return {
      id: c.chequeId, chequeId: c.chequeId, ref: c.ref,
      chequeNumber: c.chequeNumber, maker: c.maker, draweeBank: c.draweeBank || '',
      customer: c.customerName || c.customerId, customerId: c.customerId,
      typeId: c.chequeType, typeLabel: c.typeLabel, ccy: c.currency,
      amount: Number(c.faceAmount), feeCad: Number(c.feeAmount), netCad: Number(c.netAmount),
      endorsed: !!c.endorsed, image: held[c.chequeId] || null,
      holdDays: c.holdDays, holdUntil: c.holdUntil, receivedDate: c.receivedDate,
      status: c.status, nsf: !!c.nsf, fraud: !!c.fraud, returnedReason: c.returnedReason || '',
      timeline: (c.timeline || []).map(e => ({
        status: e.status,
        ts: String(e.at || '').replace('T', ' ').slice(0, 19),
        by: String(e.actorId || '').split(':').pop(),
        note: e.note || '',
      })),
      txId: c.cashingTransactionId, txRef: c.cashingTransactionRef,
      createdBy: String(c.createdBy || '').split(':').pop(), server: true,
    };
  }

  /* ===================== atoms ===================== */
  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };
  const inputCls = 'w-full text-sm px-2.5 py-2 outline-none';
  function Field({ label, hint, children }) { return (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</label>); }
  function DRow({ k, v, mono, accent }) { return (<div className="flex justify-between items-baseline gap-4 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="text-[12px] flex-none" style={{ color: CD.mute }}>{k}</span><span className="text-sm font-medium text-right" style={{ color: accent || CD.ink, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{v}</span></div>); }
  function StatusPill({ status, small }) { const s = STATUS[status] || STATUS.held; return <span className="inline-flex items-center gap-1.5 font-semibold" style={{ background: s.soft, color: s.ink, borderRadius: 999, fontSize: small ? 10 : 11, padding: small ? '2px 8px' : '3px 10px' }}><Ic n={s.icon} s={small ? 10 : 12} c={s.ink} />{s.label}</span>; }

  /* ===================== CAPTURE MODAL ===================== */
  function CaptureModal({ rows, setRows, clients, settings, schedule, me, log, cheques, setCheques, onClose, onDone, onTillChanged }) {
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
    // Settings › Cheques can set a minimum hold that floors every cheque's scheduled hold
    const minHold = Math.max(0, +((settings && settings.chequeMinHoldDays)) || 0);
    const holdDays = Math.max(minHold, holdOverride != null ? holdOverride : type.holdDays);
    const holdUntil = addDays(TODAY, holdDays);
    const rt = RISK_TONE[type.risk] || RISK_TONE.low;
    const canSave = amtN > 0 && maker.trim() && chequeNumber.trim() && customer.trim() && net >= 0;
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);

    /* A cheque image is stored the same way an ID scan is, and used to
       arrive at whatever size the scanner produced. Same ceiling. */
    const [imgErr, setImgErr] = useState('');
    const upload = async (file) => {
      const taken = await window.CDOS.intakeIdImage(file);
      if (!taken.ok) { setImgErr(taken.why); return; }
      setImgErr(''); setImage(taken.dataUrl);
    };

    /* Cashing, which is a movement of money and therefore a server call.

       The whole of this used to happen in the browser — a transaction row
       pushed into an array, a cheque written to localStorage, and a
       reference number minted from the length of the local list, which
       meant two tills cashing at the same moment both produced
       CHQ-260618-003 for different money. None of it reached the ledger,
       so the drawer on screen fell and the drawer on the server did not.

       Nothing is applied here until the server has agreed, and nothing is
       applied optimistically afterwards either: the cheque, its reference,
       its dates and the drawer's new balances all come back in the
       response and are rendered as sent. The ledger row shows up in the
       Ledger the same way every other posted deal does, by re-reading it
       from the book. */
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const save = async () => {
      if (!canSave || busy) return;
      const book = ledger();
      if (!book) {
        setErr('This desk has no ledger to post to, so a cheque cannot be cashed here. Nothing was recorded.');
        return;
      }
      setBusy(true); setErr('');
      try {
        /* The ledger's own customer record. A cheque cashing is a deal
           against a named person — the identification line is enforced
           on the server against THIS record — so the desk's client is
           mirrored across before the money moves. */
        const synced = await book.syncCustomer(customer.trim(), (clients || {})[customer.trim()]);
        const posted = await book.cashCheque({
          idempotencyKey: `web-chq:${synced.customerId}:${chequeNumber.trim()}:${book.asMoney(amtN)}:${Date.now()}`,
          customerId: synced.customerId,
          chequeNumber: chequeNumber.trim(),
          maker: maker.trim(),
          draweeBank: draweeBank.trim() || undefined,
          chequeType: typeId,
          typeLabel: type.label,
          /* The desk's home currency, which is what the capture form
             offers and the only thing the server will take. A cheque in
             anything else is an exchange as well as a cheque and belongs
             on the quote path; the server refuses it by name. */
          currency: 'CAD',
          faceAmount: book.asMoney(amtN),
          feeAmount: book.asMoney(fee),
          holdDays: holdDays,
          endorsed: endorsed,
        });
        keepImage(posted.cheque.chequeId, image);
        const chq = fromServer(Object.assign({ customerName: customer.trim() }, posted.cheque));
        setCheques(list => [chq, ...(list || []).filter(c => c.chequeId !== chq.chequeId)]);
        /* The posted row belongs to the Ledger, and the Ledger reads it
           from the book rather than being handed a copy — a locally
           minted row would sit beside the server's own for the same deal,
           which is the two-books problem in miniature. */
        if (book.loadLedger && setRows) {
          try {
            const serverRows = await book.loadLedger();
            setRows(current => book.mergeRows(current, serverRows));
          } catch (refreshError) {
            log && log('Ledger refresh failed', refreshError.message || 'The cashed cheque will appear on the next ledger open');
          }
        }
        onTillChanged && onTillChanged(posted.balances);
        log && log('Cheque cashed', `${posted.cheque.ref} · ${fmt(amtN, 'CAD')} ${type.label} · fronted ${fmt(Number(posted.cheque.netAmount), 'CAD')} · hold to ${posted.cheque.holdUntil}`);
        onDone && onDone(chq.id);
      } catch (error) {
        setErr(error.message || 'The cheque was not cashed.');
      } finally {
        setBusy(false);
      }
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
                  {imgErr && <div className="text-[11px] mt-1" style={{ color: CD.flag }}>{imgErr}</div>}
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
        {/* What the ledger said when it refused. Shown in full and never
            swallowed: a cheque that was not cashed must not leave the
            teller thinking it was, and the server's own words name the
            reason — the drawer is short, the till is closed, the customer
            needs identifying, the cheque is in the wrong currency. */}
        {err && <div className="flex-none px-5 pb-2 text-[12px]" style={{ color: CD.flag }} role="alert">{err}</div>}
        <div className="flex-none flex items-center justify-between gap-3 px-5 py-4" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <div className="text-[12px]" style={{ color: CD.mute }}>{amtN > 0 ? <>Front <b style={{ color: CD.ink }}>{fmt(net, 'CAD')}</b> · keep <b style={{ color: CD.green }}>{fmt(fee, 'CAD')}</b></> : 'Enter the cheque amount'}</div>
          <button onClick={save} disabled={!canSave || busy} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: (canSave && !busy) ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: (canSave && !busy) ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> {busy ? 'Posting…' : 'Cash & hold'}</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== DETAIL DRAWER ===================== */
  function ChequeDetail({ c, me, log, setCheques, onClose, onTillChanged }) {
    const overdue = c.status === 'held' && c.holdUntil < TODAY;
    const [busy, setBusy] = useState('');
    const [err, setErr] = useState('');

    /* Every one of these is a posting. A clearance moves a receivable to
       the bank, a return books the face amount as a loss, and a reversal
       puts the cash back in the drawer — three journals, none of which a
       browser may write for itself. This used to be a `setCheques` call
       that patched a status in localStorage and told nobody. */
    const act = async (kind, call, action, note) => {
      const book = ledger();
      if (!book) { setErr('This desk has no ledger to post to. Nothing was recorded.'); return; }
      if (busy) return;
      setBusy(kind); setErr('');
      try {
        const answer = await call(book, `web-chq-${kind}:${c.chequeId}:${Date.now()}`);
        /* The status and the timeline come back from the register rather
           than being guessed at here — a cheque somebody else has already
           dealt with reads correctly instead of showing this teller's
           optimistic patch over the top of it. */
        const refreshed = await book.loadCheques();
        setCheques(() => (refreshed.cheques || []).map(x => fromServer(x)));
        if (answer && answer.balances) onTillChanged && onTillChanged(answer.balances);
        log && log(action, `${c.ref} · ${note}`);
        onClose && onClose();
      } catch (error) {
        setErr(error.message || 'The ledger refused this. Nothing was posted.');
      } finally {
        setBusy('');
      }
    };
    const clear = () => act('clear',
      (book, key) => book.clearCheque(c.chequeId, { idempotencyKey: key }),
      'Cheque cleared', 'Funds confirmed by drawee bank');
    const returnNsf = () => act('nsf',
      (book, key) => book.returnCheque(c.chequeId, { idempotencyKey: key, reason: 'NSF — insufficient funds', nsf: true }),
      'Cheque returned NSF', `loss ${fmt(c.netCad, 'CAD')}`);
    const returnFraud = () => act('fraud',
      (book, key) => book.returnCheque(c.chequeId, { idempotencyKey: key, reason: 'Fraud — suspect cheque', fraud: true }),
      'Cheque flagged fraud', `loss ${fmt(c.netCad, 'CAD')}`);
    /* Undoing a cashing done in error, which is NOT the same act as an
       NSF and does not share its button. The cash comes back into the
       drawer and the fee is reversed with it, because the desk did not
       perform a service it can charge for. On a bounced cheque the money
       is genuinely gone and the fee stays. */
    const reverse = () => {
      const why = window.prompt('Why is this cashing being reversed? The cash goes back into the drawer and the fee is refunded.');
      if (!why || !why.trim()) return;
      return act('reverse',
        (book, key) => book.reverseCheque(c.chequeId, { idempotencyKey: key, reason: why.trim() }),
        'Cheque cashing reversed', why.trim());
    };
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
              <button onClick={clear} disabled={!!busy} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: busy ? 'var(--cd-disabled)' : CD.green, borderRadius: 8 }}><Ic n="checkcircle" s={15} c="var(--cd-on-ink)" /> {busy === 'clear' ? 'Posting…' : 'Mark cleared'}</button>
              <button onClick={returnNsf} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.flagSoft}`, background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="ban" s={15} c={CD.flag} /> {busy === 'nsf' ? 'Posting…' : 'Return NSF'}</button>
              <button onClick={returnFraud} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, color: CD.flag, borderRadius: 8 }}><Ic n="alert" s={15} c={CD.flag} /> {busy === 'fraud' ? 'Posting…' : 'Flag fraud'}</button>
              {/* Set apart from the three above, and worded for what it is.
                  A return says the cheque failed; this says the CASHING did
                  — wrong amount, wrong customer, keyed twice — and it is
                  the only one of the four that puts cash back in the
                  drawer and hands the fee back with it. */}
              <button onClick={reverse} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8 }}><Ic n="x" s={15} c={CD.mute} /> {busy === 'reverse' ? 'Posting…' : 'Reverse cashing'}</button>
            </div>
          )}
          {err && <div className="text-[12px]" style={{ color: CD.flag }} role="alert">{err}</div>}
          {c.txRef && <div className="text-[11px]" style={{ color: CD.faint }}>Ledger {c.txRef}</div>}
        </div>
      </div>
    </div></Portal>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    _cheques: { defaultSchedule, defaultCheques, KKEY, SKEY, IKEY, load, ledger, fromServer, STATUS, RISK_TONE, feeFor, addDays, daysBetween, StatusPill, CaptureModal, ChequeDetail }
  });
})();
