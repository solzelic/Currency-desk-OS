/* ============================================================
   CurrencyDesk OS — Transfers (remittance & wires)
   The biggest line of business for most shops. Built on the same
   spine as everything else: a transfer POSTS a ledger row (so cash
   position, LCTR/structuring flags and revenue all see it — one
   source of truth) and stores its rich layer here:
     • Beneficiaries — first-class, reusable receiver records
       (identity, relationship, bank / cash-pickup / wallet).
     • Corridors & payout partners — where money lands and who pays it.
     • Status lifecycle — created → sent → in transit → paid out,
       with a tracking reference and a full timeline.
     • Cross-border EFT report (FINTRAC EFTR) — the international
       electronic-funds-transfer filing the majors keep getting fined
       for missing.
   FX on every transfer is priced through the shared two-sided engine
   (priceDeal), so the spread booked here lands in Revenue & Earnings.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, TODAY, STAFF, CCY, crossRate, priceDeal, dealMargin, newTx, mkRef, THRESHOLD } = window.CDOS;

  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  const cadOf = (amt, c) => c === 'CAD' ? (+amt || 0) : (+amt || 0) / (crossRate('CAD', c) || 1);

  /* ---- the lifecycle. Same keys for send & receive; labels adapt. ---- */
  const FLOW = ['created', 'sent', 'transit', 'paid'];
  const STATUS = {
    created:  { send: 'Created',   recv: 'Logged',          tone: CD.mute,  soft: CD.lineSoft, ink: CD.ink,   icon: 'plus' },
    sent:     { send: 'Sent',      recv: 'Funded',          tone: CD.brass, soft: CD.brassSoft, ink: 'var(--cd-brass-text)', icon: 'send' },
    transit:  { send: 'In transit',recv: 'Ready for pickup',tone: '#2a6f97', soft: '#dcebf3', ink: '#1c4a63', icon: 'globe' },
    paid:     { send: 'Paid out',  recv: 'Paid to customer',tone: CD.green, soft: CD.greenSoft, ink: '#1c5c3a', icon: 'checkcircle' },
    hold:     { send: 'On hold',   recv: 'On hold',         tone: CD.flag,  soft: CD.flagSoft, ink: CD.flag,  icon: 'alert' },
    cancelled:{ send: 'Cancelled', recv: 'Cancelled',       tone: CD.faint, soft: CD.lineSoft, ink: CD.mute,  icon: 'ban' },
  };
  const statusLabel = (key, dir) => (STATUS[key] || STATUS.created)[dir === 'receive' ? 'recv' : 'send'];
  const METHODS = [['bank', 'Bank deposit', 'building'], ['cash', 'Cash pickup', 'coins'], ['wallet', 'Mobile wallet', 'smartphone']];
  const methodLabel = (m) => (METHODS.find(x => x[0] === m) || [, m])[1];
  const RELATIONSHIPS = ['Parent', 'Spouse', 'Child', 'Sibling', 'Other family', 'Friend', 'Self', 'Business', 'Other'];
  const PURPOSES = ['Family support', 'Gift', 'Education', 'Medical', 'Property / rent', 'Savings', 'Business / invoice', 'Other'];

  /* ---- seed corridors: destination country, payout currency, partners ---- */
  function defaultCorridors() {
    return [
      { id: 'PH', country: 'Philippines', ccy: 'PHP', flag: '🇵🇭', active: true, partners: [
        { name: 'Cebuana Lhuillier', methods: ['cash', 'wallet'], etaH: 1 },
        { name: 'Palawan Express', methods: ['cash'], etaH: 2 },
        { name: 'BDO Unibank', methods: ['bank'], etaH: 24 } ] },
      { id: 'IN', country: 'India', ccy: 'INR', flag: '🇮🇳', active: true, partners: [
        { name: 'ICICI Bank', methods: ['bank'], etaH: 6 },
        { name: 'Paytm Wallet', methods: ['wallet'], etaH: 1 } ] },
      { id: 'CN', country: 'China', ccy: 'CNY', flag: '🇨🇳', active: true, partners: [
        { name: 'Bank of China', methods: ['bank'], etaH: 24 },
        { name: 'Alipay', methods: ['wallet'], etaH: 1 } ] },
      { id: 'MX', country: 'Mexico', ccy: 'MXN', flag: '🇲🇽', active: true, partners: [
        { name: 'Elektra', methods: ['cash'], etaH: 1 },
        { name: 'BBVA México', methods: ['bank'], etaH: 12 } ] },
      { id: 'AE', country: 'United Arab Emirates', ccy: 'AED', flag: '🇦🇪', active: true, partners: [
        { name: 'Al Ansari Exchange', methods: ['cash', 'bank'], etaH: 2 } ] },
      { id: 'GB', country: 'United Kingdom', ccy: 'GBP', flag: '🇬🇧', active: true, partners: [
        { name: 'Barclays (Faster Payments)', methods: ['bank'], etaH: 2 } ] },
      { id: 'EU', country: 'Eurozone', ccy: 'EUR', flag: '🇪🇺', active: false, partners: [
        { name: 'SEPA Network', methods: ['bank'], etaH: 24 } ] },
      { id: 'US', country: 'United States', ccy: 'USD', flag: '🇺🇸', active: true, partners: [
        { name: 'Wells Fargo (ACH)', methods: ['bank'], etaH: 24 } ] },
    ];
  }

  function defaultBeneficiaries() {
    return [
      { id: 'b1', name: 'Maria Carter', relationship: 'Parent', sender: 'Rachel Carter', corridor: 'PH', method: 'cash', partner: 'Cebuana Lhuillier', pickupCity: 'Cebu City', phone: '+63 917 555 0102', address: '', bank: '', branch: '', account: '', walletId: '', createdAt: '2026-04-02 10:12' },
      { id: 'b2', name: 'Rohan Miller', relationship: 'Sibling', sender: 'Jakob Miller', corridor: 'IN', method: 'bank', partner: 'ICICI Bank', bank: 'ICICI Bank', branch: 'Mumbai — Andheri', account: '00412•••8841', pickupCity: '', phone: '+91 98•••• 4471', address: '', walletId: '', createdAt: '2026-05-11 14:30' },
      { id: 'b3', name: 'Lin Wei', relationship: 'Spouse', sender: 'Brooke Lawson', corridor: 'CN', method: 'wallet', partner: 'Alipay', walletId: 'lin.wei@alipay', pickupCity: '', phone: '+86 138•••• 9920', bank: '', branch: '', account: '', address: '', createdAt: '2026-05-28 09:05' },
    ];
  }

  /* seed a believable pipeline across every status */
  function defaultTransfers() {
    const mk = (o) => Object.assign({ direction: 'send', fee: 9.99, purpose: 'Family support', sourceOfFunds: 'Salary', timeline: [], createdBy: 'M. Costa', txId: null }, o);
    const mid = (c) => crossRate('CAD', c);
    return [
      mk({ id: 't1', ref: 'TR-260618-003', pin: '48 221 905', senderName: 'Rachel Carter', beneficiaryId: 'b1', corridor: 'PH', ccy: 'PHP', method: 'cash', partner: 'Cebuana Lhuillier', payAmt: 600, recvAmt: +(600 * mid('PHP') * 0.97).toFixed(2), date: '2026-06-18', status: 'transit',
        timeline: [{ status: 'created', ts: '2026-06-18 10:12', by: 'M. Costa' }, { status: 'sent', ts: '2026-06-18 10:14', by: 'M. Costa', note: 'Funded to Cebuana settlement' }, { status: 'transit', ts: '2026-06-18 10:31', by: 'System', note: 'Partner acknowledged — ready in ~1h' }] }),
      mk({ id: 't2', ref: 'TR-260618-002', pin: '77 410 663', senderName: 'Jakob Miller', beneficiaryId: 'b2', corridor: 'IN', ccy: 'INR', method: 'bank', partner: 'ICICI Bank', payAmt: 1800, recvAmt: +(1800 * mid('INR') * 0.97).toFixed(2), date: '2026-06-18', status: 'sent', fee: 12.5, purpose: 'Education', createdBy: 'A. Singh',
        timeline: [{ status: 'created', ts: '2026-06-18 09:40', by: 'A. Singh' }, { status: 'sent', ts: '2026-06-18 09:43', by: 'A. Singh', note: 'Submitted to ICICI batch' }] }),
      mk({ id: 't3', ref: 'TR-260617-019', pin: '20 884 137', senderName: 'Brooke Lawson', beneficiaryId: 'b3', corridor: 'CN', ccy: 'CNY', method: 'wallet', partner: 'Alipay', payAmt: 14200, recvAmt: +(14200 * mid('CNY') * 0.97).toFixed(2), date: '2026-06-17', status: 'hold', fee: 95, purpose: 'Property / rent', sourceOfFunds: 'Property sale', createdBy: 'R. Haddad',
        timeline: [{ status: 'created', ts: '2026-06-17 15:02', by: 'R. Haddad' }, { status: 'hold', ts: '2026-06-17 15:06', by: 'J. Masri', note: 'Reportable EFT — source of funds review before release' }] }),
      mk({ id: 't4', ref: 'TR-260616-031', pin: '63 102 558', senderName: 'Rachel Carter', beneficiaryId: 'b1', corridor: 'PH', ccy: 'PHP', method: 'cash', partner: 'Cebuana Lhuillier', payAmt: 450, recvAmt: +(450 * mid('PHP') * 0.97).toFixed(2), date: '2026-06-16', status: 'paid', createdBy: 'M. Costa',
        timeline: [{ status: 'created', ts: '2026-06-16 11:20', by: 'M. Costa' }, { status: 'sent', ts: '2026-06-16 11:22', by: 'M. Costa' }, { status: 'transit', ts: '2026-06-16 11:40', by: 'System' }, { status: 'paid', ts: '2026-06-16 13:18', by: 'System', note: 'Collected in Cebu City — ID verified at counter' }] }),
    ].map(t => Object.assign(t, { rate: t.rate || +(t.recvAmt / t.payAmt).toFixed(4), midRate: t.midRate || +crossRate('CAD', t.ccy).toFixed(4), spreadCad: t.spreadCad != null ? t.spreadCad : +(t.payAmt * 0.03).toFixed(2) }));
  }

  const BKEY = 'cdos_beneficiaries_v1', CKEY = 'cdos_corridors_v1', TKEY = 'cdos_transfers_v1';
  const load = (k, def) => { try { const r = JSON.parse(localStorage.getItem(k) || 'null'); return r && (Array.isArray(r) ? r.length : true) ? r : def(); } catch (e) { return def(); } };

  /* ===================== shared atoms ===================== */
  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };
  const inputCls = 'w-full text-sm px-2.5 py-2 outline-none';
  function Field({ label, hint, children }) { return (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</label>); }
  function DRow({ k, v, mono, accent }) { return (<div className="flex justify-between items-baseline gap-4 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="text-[12px] flex-none" style={{ color: CD.mute }}>{k}</span><span className="text-sm font-medium text-right" style={{ color: accent || CD.ink, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{v}</span></div>); }
  function StatusPill({ status, dir, small }) {
    const s = STATUS[status] || STATUS.created;
    return <span className="inline-flex items-center gap-1.5 font-semibold" style={{ background: s.soft, color: s.ink, borderRadius: 999, fontSize: small ? 10 : 11, padding: small ? '2px 8px' : '3px 10px' }}><Ic n={s.icon} s={small ? 10 : 12} c={s.ink} />{statusLabel(status, dir)}</span>;
  }
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);

  /* ===================== BENEFICIARY MODAL ===================== */
  function BeneficiaryModal({ init, sender, corridors, lockSender, onClose, onSave }) {
    const [b, setB] = useState(() => init || { id: 'b' + Date.now(), name: '', relationship: 'Parent', sender: sender || '', corridor: corridors.find(c => c.active) ? corridors.find(c => c.active).id : corridors[0].id, method: 'cash', partner: '', pickupCity: '', phone: '', address: '', bank: '', branch: '', account: '', walletId: '' });
    const cor = corridors.find(c => c.id === b.corridor) || corridors[0];
    const partners = cor.partners.filter(p => p.methods.includes(b.method));
    useEffect(() => { if (!partners.find(p => p.name === b.partner)) setB(s => ({ ...s, partner: partners[0] ? partners[0].name : '' })); }, [b.corridor, b.method]);
    const set = (k, v) => setB(s => ({ ...s, [k]: v }));
    const valid = b.name.trim() && b.partner;
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 480, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex-none flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="userplus" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>{init ? 'Edit beneficiary' : 'New beneficiary'}</div><div className="text-[11px]" style={{ color: CD.mute }}>Reusable receiver — saved for next time</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name"><input value={b.name} onChange={e => set('name', e.target.value)} autoFocus placeholder="Receiver's name" className={inputCls} style={inputSty} /></Field>
            <Field label="Relationship to sender"><select value={b.relationship} onChange={e => set('relationship', e.target.value)} className={inputCls} style={inputSty}>{RELATIONSHIPS.map(r => <option key={r}>{r}</option>)}</select></Field>
          </div>
          <Field label="Sender (your client)">{lockSender ? <div className="flex items-center gap-2 px-2.5 py-2" style={{ ...inputSty, background: 'var(--cd-chip)', color: CD.ink }}><Ic n="users" s={14} c={CD.mute} /> <span className="text-sm font-medium">{b.sender}</span></div> : <input value={b.sender} onChange={e => set('sender', e.target.value)} placeholder="Who sends to this person" className={inputCls} style={inputSty} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Destination"><select value={b.corridor} onChange={e => set('corridor', e.target.value)} className={inputCls} style={inputSty}>{corridors.map(c => <option key={c.id} value={c.id}>{c.flag} {c.country} · {c.ccy}</option>)}</select></Field>
            <Field label="Payout method"><select value={b.method} onChange={e => set('method', e.target.value)} className={inputCls} style={inputSty}>{METHODS.filter(m => cor.partners.some(p => p.methods.includes(m[0]))).map(m => <option key={m[0]} value={m[0]}>{m[1]}</option>)}</select></Field>
          </div>
          <Field label="Payout partner"><select value={b.partner} onChange={e => set('partner', e.target.value)} className={inputCls} style={inputSty}>{partners.map(p => <option key={p.name}>{p.name}</option>)}{!partners.length && <option value="">No partner for this method</option>}</select></Field>
          {b.method === 'bank' && (<div className="grid grid-cols-2 gap-3">
            <Field label="Bank"><input value={b.bank} onChange={e => set('bank', e.target.value)} className={inputCls} style={inputSty} /></Field>
            <Field label="Branch"><input value={b.branch} onChange={e => set('branch', e.target.value)} className={inputCls} style={inputSty} /></Field>
            <Field label="Account number"><input value={b.account} onChange={e => set('account', e.target.value)} className={inputCls} style={inputSty} /></Field>
            <Field label="Phone"><input value={b.phone} onChange={e => set('phone', e.target.value)} className={inputCls} style={inputSty} /></Field>
          </div>)}
          {b.method === 'cash' && (<div className="grid grid-cols-2 gap-3">
            <Field label="Pickup city"><input value={b.pickupCity} onChange={e => set('pickupCity', e.target.value)} className={inputCls} style={inputSty} /></Field>
            <Field label="Phone"><input value={b.phone} onChange={e => set('phone', e.target.value)} className={inputCls} style={inputSty} /></Field>
          </div>)}
          {b.method === 'wallet' && (<div className="grid grid-cols-2 gap-3">
            <Field label="Wallet ID / number"><input value={b.walletId} onChange={e => set('walletId', e.target.value)} className={inputCls} style={inputSty} /></Field>
            <Field label="Phone"><input value={b.phone} onChange={e => set('phone', e.target.value)} className={inputCls} style={inputSty} /></Field>
          </div>)}
        </div>
        <div className="flex-none flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
          <button onClick={() => valid && onSave({ ...b, createdAt: b.createdAt || stamp() })} disabled={!valid} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: valid ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: valid ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> Save beneficiary</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== NEW TRANSFER MODAL ===================== */
  function TransferModal({ rows, setRows, clients, settings, me, log, corridors, beneficiaries, setBeneficiaries, transfers, setTransfers, onClose, onDone }) {
    const [direction, setDirection] = useState('send');
    const [senderName, setSenderName] = useState('');
    const [benId, setBenId] = useState('');
    const [addBen, setAddBen] = useState(false);
    const [corridorId, setCorridorId] = useState('PH');
    const [partner, setPartner] = useState('');
    const [method, setMethod] = useState('cash');
    const [payAmt, setPayAmt] = useState('');
    const [fee, setFee] = useState(settings && settings.defaultFee ? String(settings.defaultFee) : '9.99');
    const requirePurpose = !(settings && settings.transferRequirePurpose === false);   // Settings › Transfers
    const [purpose, setPurpose] = useState(requirePurpose ? '' : 'Family support');
    const [sourceOfFunds, setSourceOfFunds] = useState('Salary');
    const senderWrap = useRef(null);
    const [senderOpen, setSenderOpen] = useState(false);

    const names = useMemo(() => { const s = new Set(Object.keys(clients)); rows.forEach(r => r.customer && s.add(r.customer)); return Array.from(s).sort(); }, [clients, rows]);
    const myBens = beneficiaries.filter(b => direction === 'send' && (!senderName || b.sender === senderName));
    const ben = beneficiaries.find(b => b.id === benId);
    // when a saved beneficiary is picked, it drives corridor/partner/method
    useEffect(() => { if (ben) { setCorridorId(ben.corridor); setMethod(ben.method); setPartner(ben.partner); } }, [benId]);
    const cor = corridors.find(c => c.id === corridorId) || corridors[0];
    const recvCcy = cor.ccy;
    const partners = cor.partners.filter(p => p.methods.includes(method));
    useEffect(() => { if (!partners.find(p => p.name === partner)) setPartner(partners[0] ? partners[0].name : ''); }, [corridorId, method]);

    const amtN = parseFloat(payAmt) || 0;
    // SEND: customer pays CAD, beneficiary gets foreign. RECEIVE: foreign in, customer gets CAD.
    const pricing = useMemo(() => direction === 'send'
      ? priceDeal({ inCcy: 'CAD', outCcy: recvCcy, inAmt: amtN, settings })
      : priceDeal({ inCcy: recvCcy, outCcy: 'CAD', inAmt: amtN, settings }), [direction, recvCcy, amtN, settings]);
    const recvAmt = pricing.outAmt;
    const payCad = direction === 'send' ? amtN + (parseFloat(fee) || 0) : 0;

    const cadEquiv = direction === 'send' ? amtN : cadOf(amtN, recvCcy);
    const reportable = cadEquiv >= (settings.threshold || THRESHOLD);   // cross-border EFT ≥ $10k
    const kyc = (() => { const c = clients[senderName]; return !c || !c.idType || !c.idNum ? 'missing ID' : (c.idExpiry && c.idExpiry < TODAY ? 'ID expired' : 'ok'); })();
    const idRequired = cadEquiv >= (settings.idRequiredOver || 3000);
    const needBen = direction === 'send';
    const canSave = amtN > 0 && partner && (!needBen || benId) && senderName && !(idRequired && kyc !== 'ok') && (!requirePurpose || purpose);

    const pickSender = (n) => { setSenderName(n); setSenderOpen(false); setBenId(''); };
    useEffect(() => { const h = (e) => { if (senderWrap.current && !senderWrap.current.contains(e.target)) setSenderOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);

    const create = () => {
      if (!canSave) return;
      const seqT = transfers.filter(t => t.date === TODAY).length + 1;
      const ref = 'TR-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seqT).padStart(3, '0');
      const pin = (Math.floor(10 + Math.random() * 89) + ' ' + Math.floor(100 + Math.random() * 899) + ' ' + Math.floor(100 + Math.random() * 899));
      // post the ledger row — this is the money movement (one source of truth)
      const seqL = rows.filter(r => r.date === TODAY && r.status !== 'void').length + 1;
      const lref = mkRef(TODAY, seqL);
      const lin = direction === 'send' ? 'CAD' : recvCcy, lout = direction === 'send' ? recvCcy : 'CAD';
      const tx = newTx({
        ref: lref, type: direction === 'send' ? 'Remittance — Send' : 'Remittance — Receive',
        customer: senderName, inCcy: lin, inAmt: amtN, rate: pricing.rate, outCcy: lout, outAmt: recvAmt,
        fee: parseFloat(fee) || 0, midRate: pricing.midRate, spreadCad: pricing.marginCad, side: pricing.side,
        teller: me.name, notes: `${ref} · ${direction === 'send' ? 'to ' + (ben ? ben.name : '') : 'from ' + senderName} (${cor.country}) · ${partner}`,
        transferRef: ref, createdBy: me.name, createdAt: stamp(),
      });
      setRows(r => [tx, ...r]);
      const transfer = {
        id: 't' + Date.now(), ref, pin, direction, senderName, beneficiaryId: benId || null, corridor: corridorId, ccy: recvCcy,
        method, partner, payAmt: amtN, recvAmt, rate: pricing.rate, midRate: pricing.midRate, spreadCad: pricing.marginCad,
        fee: parseFloat(fee) || 0, purpose, sourceOfFunds, date: TODAY, status: 'created', txId: tx.id, txRef: lref,
        timeline: [{ status: 'created', ts: stamp(), by: me.name }], createdBy: me.name,
      };
      setTransfers(t => [transfer, ...t]);
      log && log('Transfer created', `${ref} · ${num(amtN)} ${direction === 'send' ? 'CAD → ' + num(recvAmt) + ' ' + recvCcy : recvCcy + ' → ' + num(recvAmt) + ' CAD'} · ${cor.country}${reportable ? ' · EFT REPORTABLE' : ''}`);
      onDone && onDone(transfer.id);
    };

    const saveBen = (b) => { setBeneficiaries(list => { const ex = list.find(x => x.id === b.id); return ex ? list.map(x => x.id === b.id ? b : x) : [b, ...list]; }); setBenId(b.id); setAddBen(false); log && log('Beneficiary saved', `${b.name} · ${b.partner}`); };

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 560, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex-none flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="send" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>New transfer</div><div className="text-[11px]" style={{ color: CD.mute }}>Teller {me.name} · {TODAY}</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {/* direction */}
          <div className="flex gap-1.5">
            {[['send', 'Send out', 'arrowup'], ['receive', 'Receive in', 'arrowdown']].map(([d, l, ic]) => (
              <button key={d} onClick={() => { setDirection(d); setBenId(''); }} className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium" style={{ borderRadius: 9, border: `1px solid ${direction === d ? CD.ink : CD.line}`, background: direction === d ? CD.ink : 'var(--cd-panel)', color: direction === d ? 'var(--cd-on-ink)' : CD.mute }}><Ic n={ic} s={14} c={direction === d ? 'var(--cd-on-ink)' : CD.mute} /> {l}</button>
            ))}
          </div>

          {/* sender */}
          <Field label={direction === 'send' ? 'Sender (your client)' : 'Recipient (your client)'}>
            <div ref={senderWrap} className="relative">
              <div className="flex items-center gap-2 px-2.5 py-2" style={inputSty}>
                <Ic n="search" s={15} c={CD.mute} />
                <input value={senderName} onFocus={() => setSenderOpen(true)} onChange={e => { setSenderName(e.target.value); setSenderOpen(true); setBenId(''); }} placeholder="Type a name…" className="w-full outline-none text-sm bg-transparent" />
                {senderName && <button onClick={() => { setSenderName(''); setBenId(''); }}><Ic n="x" s={14} c={CD.mute} /></button>}
              </div>
              {senderOpen && (
                <div className="absolute left-0 right-0 mt-1 py-1 max-h-44 overflow-auto" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10, boxShadow: '0 12px 30px var(--cd-shade)', zIndex: 20 }}>
                  {names.filter(n => n.toLowerCase().includes(senderName.toLowerCase())).map(n => <button key={n} onClick={() => pickSender(n)} onMouseDown={e => e.preventDefault()} className="w-full text-left px-3 py-2 text-sm" style={{ color: CD.ink }}>{n}</button>)}
                  {!names.filter(n => n.toLowerCase().includes(senderName.toLowerCase())).length && <div className="px-3 py-2 text-[11px]" style={{ color: CD.faint }}>No match — type a new name.</div>}
                </div>
              )}
            </div>
          </Field>

          {/* beneficiary (send only) */}
          {direction === 'send' && (
            <Field label={senderName ? `${(senderName.split(/\s+/)[0])}'s beneficiary` : 'Beneficiary'} hint={senderName ? (myBens.length ? `${myBens.length} on file — pick one` : 'none on file yet') : 'choose a sender first'}>
              <div className="space-y-1.5">
                {myBens.map(b => { const bc = corridors.find(c => c.id === b.corridor); return (
                  <button key={b.id} onClick={() => setBenId(b.id)} className="w-full flex items-center justify-between px-3 py-2.5 text-left" style={{ border: `1px solid ${benId === b.id ? CD.ink : CD.line}`, borderRadius: 10, background: benId === b.id ? 'var(--cd-chip)' : 'var(--cd-panel)' }}>
                    <div className="flex items-center gap-2.5">
                      <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: '50%', background: CD.lineSoft, fontSize: 14 }}>{bc ? bc.flag : '🌐'}</span>
                      <div><div className="text-[13px] font-medium" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint }}>· {b.relationship}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{bc ? bc.country : ''} · {methodLabel(b.method)} · {b.partner}</div></div>
                    </div>
                    {benId === b.id && <Ic n="check" s={16} c={CD.ink} />}
                  </button>); })}
                <button onClick={() => setAddBen(true)} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium" style={{ border: `1px dashed ${CD.line}`, borderRadius: 10, color: CD.ink }}><Ic n="userplus" s={15} /> New beneficiary{senderName ? ` for ${senderName}` : ''}</button>
              </div>
            </Field>
          )}

          {/* corridor + partner + method (receive, or send w/o saved ben) */}
          {(direction === 'receive' || !benId) && (
            <div className="grid grid-cols-3 gap-2">
              <Field label={direction === 'send' ? 'Destination' : 'Source country'}><select value={corridorId} onChange={e => setCorridorId(e.target.value)} className={inputCls} style={inputSty}>{corridors.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.flag} {c.country}</option>)}</select></Field>
              <Field label="Method"><select value={method} onChange={e => setMethod(e.target.value)} className={inputCls} style={inputSty}>{METHODS.filter(m => cor.partners.some(p => p.methods.includes(m[0]))).map(m => <option key={m[0]} value={m[0]}>{m[1]}</option>)}</select></Field>
              <Field label="Partner"><select value={partner} onChange={e => setPartner(e.target.value)} className={inputCls} style={inputSty}>{partners.map(p => <option key={p.name}>{p.name}</option>)}</select></Field>
            </div>
          )}

          {/* amount + FX */}
          <div className="p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10 }}>
            <Field label={direction === 'send' ? 'Customer pays in (CAD)' : `Amount received (${recvCcy})`}>
              <div className="flex" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, overflow: 'hidden' }}>
                <span className="px-3 grid place-items-center font-semibold text-sm" style={{ background: 'var(--cd-chip)', borderRight: `1px solid ${CD.line}` }}>{direction === 'send' ? 'CAD' : recvCcy}</span>
                <input value={payAmt} onChange={e => setPayAmt(e.target.value)} inputMode="decimal" autoFocus placeholder="0.00" className="flex-1 min-w-0 px-3 py-2.5 text-xl font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </Field>
            <div className="flex items-center justify-center gap-2 py-2">
              <span className="text-[10px] px-2 py-0.5 font-semibold uppercase tracking-wide" style={{ borderRadius: 5, background: CD.greenSoft, color: CD.green, fontFamily: 'Space Mono, monospace' }}>{cor.flag} {cor.country}</span>
              <span className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>1 {direction === 'send' ? 'CAD' : recvCcy} = {pricing.rate ? num(pricing.rate) : '—'} {direction === 'send' ? recvCcy : 'CAD'}</span>
            </div>
            <Field label={direction === 'send' ? `Beneficiary receives (${recvCcy})` : 'Customer receives (CAD)'}>
              <div className="flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
                <span className="px-3 grid place-items-center font-semibold text-sm" style={{ background: 'var(--cd-chip)', borderRight: `1px solid ${CD.line}` }}>{direction === 'send' ? recvCcy : 'CAD'}</span>
                <div className="flex-1 px-3 py-2.5 text-xl font-semibold text-right" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green }}>{recvAmt ? num(recvAmt) : '—'}</div>
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Field label="Transfer fee (CAD)"><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inputSty, fontVariantNumeric: 'tabular-nums' }} /></Field>
              <Field label={requirePurpose ? 'Purpose (required)' : 'Purpose'}><select value={purpose} onChange={e => setPurpose(e.target.value)} className={inputCls} style={{ ...inputSty, borderColor: (requirePurpose && !purpose) ? CD.flag : undefined }}>{requirePurpose && <option value="">Select a purpose…</option>}{PURPOSES.map(p => <option key={p}>{p}</option>)}</select></Field>
            </div>
            {amtN > 0 && (<div className="flex items-center justify-between mt-2 pt-2" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <span className="text-[11px]" style={{ color: CD.mute }}>Spread captured <b style={{ color: CD.green }}>{fmt(pricing.marginCad, 'CAD')}</b>{(parseFloat(fee) || 0) > 0 && <span style={{ color: CD.faint }}> · +{fmt(fee, 'CAD')} fee</span>}</span>
              {direction === 'send' && <span className="text-[11px] font-medium" style={{ color: CD.ink }}>Collect {fmt(payCad, 'CAD')}</span>}
            </div>)}
          </div>

          {/* source of funds (reportable) */}
          {(reportable || idRequired) && (
            <div className="p-3 space-y-2" style={{ background: reportable ? CD.flagSoft : CD.lineSoft, borderRadius: 10, border: `1px solid ${reportable ? CD.flag : CD.line}` }}>
              <div className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: reportable ? CD.flag : CD.ink }}><Ic n="shield" s={13} /> Cross-border compliance</div>
              {reportable && <div className="text-[12px]" style={{ color: CD.ink }}>Reportable EFT — {fmt(cadEquiv, 'CAD')} (≥ {fmt(settings.threshold || THRESHOLD, 'CAD')}). An international EFT report will be required.</div>}
              {idRequired && <div className="text-[12px] flex items-center gap-1.5" style={{ color: kyc === 'ok' ? CD.green : CD.flag }}><Ic n={kyc === 'ok' ? 'checkcircle' : 'alert'} s={13} /> {kyc === 'ok' ? 'Sender ID on file — OK.' : `ID required — sender ID is ${kyc}.`}</div>}
              <Field label="Source of funds"><input value={sourceOfFunds} onChange={e => setSourceOfFunds(e.target.value)} placeholder="Salary, savings, property sale…" className={inputCls} style={inputSty} /></Field>
            </div>
          )}
        </div>
        <div className="flex-none flex items-center justify-between gap-3 px-5 py-4" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <div className="text-[12px]" style={{ color: CD.mute }}>{amtN > 0 ? <>{cor.flag} {num(recvAmt)} {recvCcy} to <b style={{ color: CD.ink }}>{ben ? ben.name : (direction === 'receive' ? senderName : 'beneficiary')}</b></> : 'Enter an amount to begin'}</div>
          <button onClick={create} disabled={!canSave} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: canSave ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: canSave ? 'pointer' : 'not-allowed' }}><Ic n="send" s={15} c="var(--cd-on-ink)" /> Create transfer</button>
        </div>
      </div>
    </div>
    {addBen && <BeneficiaryModal sender={senderName} corridors={corridors} onClose={() => setAddBen(false)} onSave={saveBen} />}
    </Portal>);
  }

  /* ===================== TRANSFER DETAIL DRAWER ===================== */
  function TransferDetail({ t, beneficiaries, corridors, me, log, setTransfers, onClose, onReceipt }) {
    const ben = beneficiaries.find(b => b.id === t.beneficiaryId);
    const cor = corridors.find(c => c.id === t.corridor) || {};
    const dir = t.direction;
    const idx = FLOW.indexOf(t.status);
    const nextKey = idx >= 0 && idx < FLOW.length - 1 ? FLOW[idx + 1] : null;
    const terminal = t.status === 'paid' || t.status === 'cancelled';
    const advance = (to, note) => {
      setTransfers(list => list.map(x => x.id === t.id ? { ...x, status: to, timeline: [...(x.timeline || []), { status: to, ts: stamp(), by: me.name, note }] } : x));
      log && log('Transfer ' + statusLabel(to, dir).toLowerCase(), `${t.ref} · ${cor.country || ''}`);
    };
    return (<Portal><div className="fixed inset-0 flex justify-end" style={{ background: 'var(--cd-scrim)', zIndex: 9100 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="h-full overflow-auto" style={{ width: 440, maxWidth: '92vw', background: CD.paper, borderLeft: `1px solid ${CD.ink}`, boxShadow: '-12px 0 40px var(--cd-shade)' }}>
        <div className="sticky top-0 px-5 py-4 flex items-start justify-between" style={{ background: CD.paper, borderBottom: `1px solid ${CD.line}`, zIndex: 5 }}>
          <div>
            <div className="flex items-center gap-2"><span className="font-semibold text-lg" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{t.ref}</span><StatusPill status={t.status} dir={dir} /></div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{t.date} · {t.createdBy} · {dir === 'send' ? 'outbound' : 'inbound'}</div>
          </div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4 space-y-5">
          {/* tracking */}
          <div className="p-3 flex items-center justify-between" style={{ background: CD.ink, borderRadius: 11 }}>
            <div><div className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--cd-on-ink-soft)', fontFamily: 'Space Mono, monospace' }}>Tracking PIN</div><div className="text-lg font-bold text-white" style={{ fontFamily: 'Space Mono, monospace', letterSpacing: '0.08em' }}>{t.pin}</div></div>
            <Ic n="send" s={22} c="var(--cd-on-ink-soft)" />
          </div>

          {/* amounts */}
          <div>
            <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Transfer</div>
            <DRow k={dir === 'send' ? 'Sender' : 'Recipient'} v={t.senderName} />
            {ben && <DRow k="Beneficiary" v={`${ben.name} · ${ben.relationship}`} />}
            <DRow k="Destination" v={`${cor.flag || ''} ${cor.country || ''}`} />
            <DRow k="Payout" v={`${methodLabel(t.method)} · ${t.partner}`} />
            {ben && ben.method === 'bank' && <DRow k="Account" v={`${ben.bank} · ${ben.account}`} mono />}
            {ben && ben.method === 'cash' && <DRow k="Pickup" v={ben.pickupCity} />}
            {ben && ben.method === 'wallet' && <DRow k="Wallet" v={ben.walletId} mono />}
            <DRow k={dir === 'send' ? 'Customer pays' : 'Amount in'} v={`${num(t.payAmt)} ${dir === 'send' ? 'CAD' : t.ccy}`} mono />
            <DRow k="Rate" v={`${num(t.rate)} ${dir === 'send' ? t.ccy : 'CAD'}/${dir === 'send' ? 'CAD' : t.ccy}`} mono />
            <DRow k="Fee" v={fmt(t.fee, 'CAD')} mono />
            <DRow k={dir === 'send' ? 'Beneficiary gets' : 'Customer gets'} v={`${num(t.recvAmt)} ${dir === 'send' ? t.ccy : 'CAD'}`} mono accent={CD.green} />
            <DRow k="Purpose" v={t.purpose} />
          </div>

          {/* lifecycle */}
          <div>
            <div className="text-[11px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Status timeline</div>
            <div className="space-y-0">
              {FLOW.map((k, i) => { const done = FLOW.indexOf(t.status) >= i && t.status !== 'cancelled'; const evt = (t.timeline || []).find(e => e.status === k); const cur = t.status === k; return (
                <div key={k} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: '50%', background: done ? (STATUS[k].tone) : 'var(--cd-panel)', border: `2px solid ${done ? STATUS[k].tone : CD.line}` }}>{done ? <Ic n="check" s={13} c="var(--cd-on-ink)" /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: CD.line }} />}</span>
                    {i < FLOW.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 22, background: FLOW.indexOf(t.status) > i ? STATUS[k].tone : CD.line }} />}
                  </div>
                  <div className="pb-3" style={{ marginTop: 1 }}>
                    <div className="text-[13px] font-medium" style={{ color: done ? CD.ink : CD.faint }}>{statusLabel(k, dir)}{cur && <span className="ml-2 text-[10px] px-1.5 py-0.5" style={{ background: STATUS[k].soft, color: STATUS[k].ink, borderRadius: 4, fontFamily: 'Space Mono' }}>NOW</span>}</div>
                    {evt && <div className="text-[11px]" style={{ color: CD.mute }}>{evt.ts} · {evt.by}{evt.note ? ` — ${evt.note}` : ''}</div>}
                  </div>
                </div>); })}
            </div>
            {t.status === 'hold' && <div className="px-3 py-2 mt-1 text-[12px] flex items-center gap-1.5" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 9 }}><Ic n="alert" s={14} /> On hold — release to resume, or cancel.</div>}
          </div>

          {/* actions */}
          {!terminal && (
            <div className="flex flex-wrap gap-2">
              {t.status !== 'hold' && nextKey && <button onClick={() => advance(nextKey)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n={STATUS[nextKey].icon} s={15} c="var(--cd-on-ink)" /> Advance to {statusLabel(nextKey, dir)}</button>}
              {t.status === 'hold'
                ? <button onClick={() => advance('sent', 'Released after review')} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.green, borderRadius: 8 }}><Ic n="checkcircle" s={15} c="var(--cd-on-ink)" /> Release</button>
                : <button onClick={() => advance('hold', 'Placed on hold')} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, color: CD.amber, borderRadius: 8 }}><Ic n="alert" s={15} c={CD.amber} /> Hold</button>}
              <button onClick={() => advance('cancelled', 'Cancelled by teller')} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.flagSoft}`, background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="ban" s={15} c={CD.flag} /> Cancel</button>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => onReceipt(t)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="receipt" s={15} /> Print receipt</button>
            {t.txRef && <span className="text-[11px]" style={{ color: CD.faint }}>Ledger {t.txRef}</span>}
          </div>
        </div>
      </div>
    </div></Portal>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    _transfers: { defaultCorridors, defaultBeneficiaries, defaultTransfers, BKEY, CKEY, TKEY, load, FLOW, STATUS, statusLabel, METHODS, methodLabel, StatusPill, flagOf, cadOf, BeneficiaryModal, TransferModal, TransferDetail }
  });
})();
