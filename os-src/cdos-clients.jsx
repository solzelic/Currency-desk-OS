/* ============================================================
   CurrencyDesk OS — Clients & KYC
   A proper contact book for a money-services business. Each client
   is an individual or a corporation with full KYC: ID, contact,
   date of birth / incorporation, address, occupation / nature of
   business, a contact photo (separate from the ID document image),
   a photo gallery, notes and risk rating.

   Interaction:
     • single click  → QuickCard popup (key info, update ID, view txns)
     • double click  → full Profile page (everything + transaction
                        history + one-touch printable client report)

   Clients created inline from the Ledger's New-Transaction flow show
   up here automatically (records are merged with the contact store).
   ============================================================ */
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const { CD, Ic, fmt, num, crossRate, TODAY } = window.CDOS;
  const computeFlags = window.CDOS.computeFlags;
  // render overlays at the document root so the window's stacking context
  // (and the rate ticker at z-360) can never occlude them
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);

  /* Photo affordance — a badge that opens a small menu: take a photo (live
     camera) or upload one. onPhoto receives a data-URL string either way. */
  function PhotoCaptureMenu({ onPhoto, badge, title }) {
    const [menu, setMenu] = useState(false);
    const [cam, setCam] = useState(false);
    const [camErr, setCamErr] = useState('');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const wrapRef = useRef(null);
    const btnRef = useRef(null);
    const menuRef = useRef(null);
    const [pos, setPos] = useState(null);
    const openMenu = () => { const r = btnRef.current && btnRef.current.getBoundingClientRect(); if (r) setPos({ left: r.left + r.width / 2, top: r.bottom + 6 }); setMenu(m => !m); };
    const closeCamera = () => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } setCam(false); };
    const openCamera = async () => {
      setMenu(false); setCamErr(''); setCam(true);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
        streamRef.current = s;
        const attach = () => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } else setTimeout(attach, 30); };
        attach();
      } catch (e) { setCamErr(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser, or upload a photo instead.' : 'No camera available on this device. Upload a photo instead.'); }
    };
    const capture = () => { const v = videoRef.current; if (!v || !v.videoWidth) return; const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); onPhoto(cv.toDataURL('image/jpeg', 0.85)); closeCamera(); };
    const onFile = (file) => { if (!file) return; const r = new FileReader(); r.onload = () => onPhoto(r.result); r.readAsDataURL(file); setMenu(false); };
    useEffect(() => () => closeCamera(), []);
    useEffect(() => { if (!menu) return; const h = (e) => { if (wrapRef.current && wrapRef.current.contains(e.target)) return; if (menuRef.current && menuRef.current.contains(e.target)) return; setMenu(false); }; window.addEventListener('mousedown', h); return () => window.removeEventListener('mousedown', h); }, [menu]);
    return (<span ref={wrapRef} className="relative" style={{ lineHeight: 0 }}>
      <button ref={btnRef} onClick={openMenu} title={title || 'Set photo'} className="grid place-items-center cursor-pointer" style={badge}><Ic n="camera" s={12} c="var(--cd-on-ink)" /></button>
      {menu && pos && <Portal><div ref={menuRef} style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)', zIndex: 10001, background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 10, boxShadow: '0 14px 34px -10px var(--cd-scrim)', padding: 4, width: 172 }}>
        <button onClick={openCamera} className="w-full flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-left" style={{ borderRadius: 7, color: CD.ink }} onMouseEnter={e => e.currentTarget.style.background = CD.panel} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}><Ic n="camera" s={14} c={CD.mute} /> Take a photo</button>
        <label className="w-full flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-left cursor-pointer" style={{ borderRadius: 7, color: CD.ink }} onMouseEnter={e => e.currentTarget.style.background = CD.panel} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}><Ic n="upload" s={14} c={CD.mute} /> Upload a photo<input type="file" accept="image/*" className="hidden" onChange={e => onFile(e.target.files[0])} /></label>
      </div></Portal>}
      {cam && <Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 10000 }}>
        <div className="w-full flex flex-col" style={{ maxWidth: 460, background: 'var(--cd-ink)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 70px -20px rgba(0,0,0,0.7)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}>
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--cd-on-ink)' }}><Ic n="camera" s={15} c="var(--cd-on-ink)" /> Take a photo</div>
            <button onClick={closeCamera} className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8 }}><Ic n="x" s={16} c="var(--cd-on-ink-soft)" /></button>
          </div>
          <div style={{ position: 'relative', background: 'var(--cd-ink-strong)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
            {camErr ? <div className="text-center px-6" style={{ color: 'var(--cd-on-ink-soft)' }}><Ic n="alert" s={22} c="#e7b34a" /><div className="text-[13px] mt-2">{camErr}</div></div>
              : <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
          </div>
          <div className="flex items-center justify-center gap-3 px-4 py-4">
            {camErr ? <button onClick={closeCamera} className="px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}>Close</button>
              : <><button onClick={closeCamera} className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--cd-on-ink-soft)', border: '1px solid var(--cd-on-ink-faint)', borderRadius: 9 }}>Cancel</button>
                <button onClick={capture} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cd-ink)', display: 'inline-block' }} /> Capture</button></>}
          </div>
        </div>
      </div></Portal>}
    </span>);
  }


  const ID_TYPES_IND = ["Driver's Licence", 'Passport', 'Provincial ID', 'PR Card', 'Citizenship Card', 'Health Card', 'Permanent Resident Card'];
  const ID_TYPES_CORP = ['Business Number', 'Incorporation Certificate', 'Master Business Licence', 'Articles of Incorporation'];
  const PROVINCES = ['', 'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
  const US_STATES = ['', 'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];
  const COUNTRIES = ['Canada', 'United States', 'Other'];
  // join an address, including the country only when it isn't the default (Canada)
  const fullAddr = (rec) => [rec.address, rec.city, rec.province, rec.postal, (rec.country && rec.country !== 'Canada') ? rec.country : ''].filter(Boolean).join(', ');
  const RISK = window.CDOS.RISK_TIERS || ['Normal', 'Low', 'Medium', 'High'];
  const normalizeRisk = window.CDOS.normalizeRisk, riskTone = window.CDOS.riskTone;
  const cadOf = (a, ccy) => ccy === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', ccy) || 1);
  const initials = (n) => (n || '?').split(/[\s.]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
  const ageFrom = (dob) => { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const t = new Date(TODAY); let a = t.getFullYear() - d.getFullYear(); const m = t.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--; return a; };

  // The highest verification a contact has actually PAID FOR through the provider.
  // Reads the KYC check history — never inferred from typed-in ID fields.
  //   plus   → Verified Plus  (ID + biometric + deep DB)
  //   verify → Verified       (ID authenticated + screened)
  //   quick  → Screened       (name/DOB watchlist screen — NOT identity verification)
  function kycTier(name) {
    if (!name) return null;
    try {
      const checks = (window.CDOS.KYC && window.CDOS.KYC.checksFor(name)) || [];
      const ok = (t) => checks.some(c => c.template === t && c.status === 'completed' && c.result && c.result.decision === 'approved');
      if (ok('plus')) return 'plus';
      if (ok('verify')) return 'verify';
      if (ok('quick')) return 'quick';
    } catch (e) {}
    return null;
  }
  // Badge ladder:  Missing ID → ID on hand → Screened → Verified → Verified Plus.
  // "ID on hand" is a NEUTRAL state: the desk holds an ID but has not run a provider
  // verification. Only a $6.99+ inquiry that returns approved earns the green "Verified".
  function kycStatus(rec, settings, name) {
    const tier = kycTier(name);
    const expired = rec && rec.idExpiry && rec.idExpiry < TODAY;
    // provider-verified identity — the only true KYC states
    if (tier === 'plus') return expired ? ['ID expired', CD.flag, CD.flagSoft] : ['Verified Plus', CD.green, CD.greenSoft];
    if (tier === 'verify') return expired ? ['ID expired', CD.flag, CD.flagSoft] : ['Verified', CD.green, CD.greenSoft];
    // watchlist screen only — clean name, but identity NOT verified under FINTRAC
    if (tier === 'quick') return ['Screened', CD.amber, CD.amberSoft];
    // no provider check on file — judge by the ID the desk is holding
    if (!rec || !rec.idType || !rec.idNum) return ['Missing ID', CD.flag, CD.flagSoft];
    if (expired) return ['ID expired', CD.flag, CD.flagSoft];
    const warn = settings && +settings.idExpiryWarnDays;
    if (warn && rec.idExpiry) { const days = (new Date(rec.idExpiry) - new Date(TODAY)) / 86400000; if (days >= 0 && days <= warn) return ['ID expiring', CD.amber, CD.amberSoft]; }
    return ['ID on hand', CD.amber, CD.amberSoft];
  }
  const isVerified = (s) => s === 'Verified' || s === 'Verified Plus';
  function clientStats(rows, name) {
    const mine = rows.filter(r => r.customer === name && r.status !== 'void');
    let vol = 0, fees = 0, last = '';
    mine.forEach(r => { vol += cadOf(r.inAmt, r.inCcy); fees += (+r.fee || 0); if (r.date > last) last = r.date; });
    return { n: mine.length, vol, fees, last };
  }

  /* ---------- atoms ---------- */
  function Avatar({ rec, name, size = 44, ring }) {
    const corp = rec && rec.kind === 'corporate';
    const st = { width: size, height: size, borderRadius: corp ? Math.round(size * 0.22) : '50%', flex: 'none' };
    if (rec && rec.avatar) return <img src={rec.avatar} alt={name} style={{ ...st, objectFit: 'cover', boxShadow: ring ? `0 0 0 2px ${CD.panel}, 0 0 0 3px ${CD.line}` : 'none' }} />;
    return (<div className="grid place-items-center" style={{ ...st, background: corp ? CD.inkSoft : CD.ink, color: 'var(--cd-on-ink)' }}>
      {corp ? <Ic n="building" s={size * 0.42} c="var(--cd-on-ink)" /> : <span style={{ fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: size * 0.34 }}>{initials(name)}</span>}
    </div>);
  }
  function Pill({ text, c, bg }) { return <span className="text-[11px] px-2 py-0.5 font-medium" style={{ background: bg, color: c, borderRadius: 999, whiteSpace: 'nowrap' }}>{text}</span>; }
  function KV({ icon, label, value, mono }) {
    return (<div className="flex items-start gap-2.5 py-1.5">
      {icon && <span className="grid place-items-center flex-none mt-0.5" style={{ width: 24, height: 24, borderRadius: 7, background: CD.lineSoft }}><Ic n={icon} s={13} c={CD.mute} /></span>}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
        <div className="text-[13px] break-words" style={{ color: value ? CD.ink : CD.faint, fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{value || '—'}</div>
      </div>
    </div>);
  }
  function EditField({ label, children, full }) { return (<label className={'block' + (full ? ' col-span-2' : '')}><div className="text-[11px] mb-1" style={{ color: CD.mute }}>{label}</div>{children}</label>); }
  const inCls = "w-full text-sm px-2.5 py-2 outline-none";
  const inSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };

  /* ---------- shared editors ---------- */
  function ContactEditor({ rec, set, kind }) {
    const corp = kind === 'corporate';
    const country = rec.country || 'Canada';
    const isCA = country === 'Canada', isUS = country === 'United States';
    const regionLabel = isUS ? 'State' : isCA ? 'Province' : 'State / Region';
    const postalLabel = isUS ? 'ZIP code' : 'Postal code';
    return (<div className="grid grid-cols-2 gap-3">
      <EditField label="Email"><input value={rec.email || ''} onChange={e => set('email', e.target.value)} className={inCls} style={inSty} placeholder="name@email.com" /></EditField>
      <EditField label="Phone"><input value={rec.phone || ''} onChange={e => set('phone', e.target.value)} className={inCls} style={inSty} placeholder="(416) 555-0100" /></EditField>
      {corp ? (<>
        <EditField label="Incorporation date"><input type="date" value={rec.incorpDate || ''} onChange={e => set('incorpDate', e.target.value)} className={inCls} style={inSty} /></EditField>
        <EditField label="Jurisdiction"><input value={rec.jurisdiction || ''} onChange={e => set('jurisdiction', e.target.value)} className={inCls} style={inSty} placeholder="Ontario, Canada" /></EditField>
        <EditField label="Nature of business" full><input value={rec.business || ''} onChange={e => set('business', e.target.value)} className={inCls} style={inSty} placeholder="Import / export of goods" /></EditField>
        <EditField label="Primary contact"><input value={rec.contactName || ''} onChange={e => set('contactName', e.target.value)} className={inCls} style={inSty} placeholder="Full name" /></EditField>
        <EditField label="Contact title"><input value={rec.contactTitle || ''} onChange={e => set('contactTitle', e.target.value)} className={inCls} style={inSty} placeholder="Director" /></EditField>
      </>) : (<>
        <EditField label="Date of birth"><input type="date" value={rec.dob || ''} onChange={e => set('dob', e.target.value)} className={inCls} style={inSty} /></EditField>
        <EditField label="Occupation"><input value={rec.occupation || ''} onChange={e => set('occupation', e.target.value)} className={inCls} style={inSty} placeholder="e.g. Nurse" /></EditField>
      </>)}
      <EditField label="Country"><select value={country} onChange={e => set('country', e.target.value)} className={inCls} style={inSty}>{COUNTRIES.map(c => <option key={c}>{c}</option>)}</select></EditField>
      <EditField label="Street address" full><input value={rec.address || ''} onChange={e => set('address', e.target.value)} className={inCls} style={inSty} placeholder="123 Main St" autoComplete="street-address" /></EditField>
      <EditField label="City"><input value={rec.city || ''} onChange={e => set('city', e.target.value)} className={inCls} style={inSty} autoComplete="address-level2" /></EditField>
      <div className="grid grid-cols-2 gap-3">
        <EditField label={regionLabel}>{isCA || isUS
          ? <select value={rec.province || ''} onChange={e => set('province', e.target.value)} className={inCls} style={inSty} autoComplete="address-level1">{(isUS ? US_STATES : PROVINCES).map(p => <option key={p} value={p}>{p || '—'}</option>)}</select>
          : <input value={rec.province || ''} onChange={e => set('province', e.target.value)} className={inCls} style={inSty} autoComplete="address-level1" placeholder="State / region" />}</EditField>
        <EditField label={postalLabel}><input value={rec.postal || ''} onChange={e => set('postal', e.target.value)} className={inCls} style={inSty} placeholder={isUS ? '90210' : 'M5V 2T6'} autoComplete="postal-code" /></EditField>
      </div>
    </div>);
  }
  function KycEditor({ rec, set, kind, onUpload, canEdit }) {
    const types = kind === 'corporate' ? ID_TYPES_CORP : ID_TYPES_IND;
    return (<div className="grid grid-cols-2 gap-3">
      <EditField label={kind === 'corporate' ? 'Document type' : 'ID type'}><select disabled={!canEdit} value={rec.idType || ''} onChange={e => set('idType', e.target.value)} className={inCls} style={inSty}><option value="">—</option>{types.map(t => <option key={t}>{t}</option>)}</select></EditField>
      <EditField label={kind === 'corporate' ? 'Business / document #' : 'ID number'}><input disabled={!canEdit} value={rec.idNum || ''} onChange={e => set('idNum', e.target.value)} className={inCls} style={inSty} /></EditField>
      <EditField label="Issued"><input disabled={!canEdit} type="date" value={rec.idIssued || ''} onChange={e => set('idIssued', e.target.value)} className={inCls} style={inSty} /></EditField>
      <EditField label="Expiry"><input disabled={!canEdit} type="date" value={rec.idExpiry || ''} onChange={e => set('idExpiry', e.target.value)} className={inCls} style={inSty} /></EditField>
      <EditField label="ID document scan" full>
        {rec.photo
          ? <div className="flex items-center gap-3"><img src={rec.photo} alt="ID" className="h-16" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }} />{canEdit && <button onClick={() => set('photo', null)} className="text-xs font-medium" style={{ color: CD.flag }}>Remove scan</button>}</div>
          : <label className="flex items-center justify-center gap-1.5 text-xs px-3 py-4 cursor-pointer" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8 }}><Ic n="upload" s={14} /> Upload ID document<input type="file" accept="image/*" className="hidden" disabled={!canEdit} onChange={e => e.target.files[0] && onUpload('photo', e.target.files[0])} /></label>}
      </EditField>
    </div>);
  }

  // one ADDITIONAL identity document (the primary ID stays top-level and drives KYC status)
  function IdEditorRow({ doc, i, kind, setId, rmId, uploadId, canEdit }) {
    const types = kind === 'corporate' ? ID_TYPES_CORP : ID_TYPES_IND;
    return (<div className="p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: 'var(--cd-panel)' }}>
      <div className="flex items-center justify-between mb-2"><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Additional ID {i + 1}</div>{canEdit && <button type="button" onClick={() => rmId(i)} className="text-[11px] font-medium" style={{ color: CD.flag }}>Remove</button>}</div>
      <div className="grid grid-cols-2 gap-3">
        <EditField label={kind === 'corporate' ? 'Document type' : 'ID type'}><select disabled={!canEdit} value={doc.type || ''} onChange={e => setId(i, 'type', e.target.value)} className={inCls} style={inSty}><option value="">—</option>{types.map(t => <option key={t}>{t}</option>)}</select></EditField>
        <EditField label={kind === 'corporate' ? 'Document #' : 'ID number'}><input disabled={!canEdit} value={doc.num || ''} onChange={e => setId(i, 'num', e.target.value)} className={inCls} style={inSty} /></EditField>
        <EditField label="Issued"><input disabled={!canEdit} type="date" value={doc.issued || ''} onChange={e => setId(i, 'issued', e.target.value)} className={inCls} style={inSty} /></EditField>
        <EditField label="Expiry"><input disabled={!canEdit} type="date" value={doc.expiry || ''} onChange={e => setId(i, 'expiry', e.target.value)} className={inCls} style={inSty} /></EditField>
        <EditField label="Document scan" full>
          {doc.photo
            ? <div className="flex items-center gap-3"><img src={doc.photo} alt="ID" className="h-16" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }} />{canEdit && <button type="button" onClick={() => setId(i, 'photo', null)} className="text-xs font-medium" style={{ color: CD.flag }}>Remove scan</button>}</div>
            : <label className="flex items-center justify-center gap-1.5 text-xs px-3 py-4 cursor-pointer" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8 }}><Ic n="upload" s={14} /> Upload document<input type="file" accept="image/*" className="hidden" disabled={!canEdit} onChange={e => e.target.files[0] && uploadId(i, e.target.files[0])} /></label>}
        </EditField>
      </div>
    </div>);
  }

  /* ---------- transaction history table ---------- */
  function TxnList({ rows, flags, onOpen, compact, highlightRef }) {
    if (!rows.length) return <div className="text-[12px] py-6 text-center" style={{ color: CD.faint }}>No transactions on record yet.</div>;
    const hlRow = React.useRef(null);
    React.useEffect(() => {
      if (!highlightRef) return;
      let n = 0;
      const tick = () => { n++; if (hlRow.current) { try { hlRow.current.scrollIntoView({ block: 'center', behavior: n > 1 ? 'smooth' : 'auto' }); } catch (e) {} } if (n < 4) setTimeout(tick, 180); };
      const t = setTimeout(tick, 160);
      return () => clearTimeout(t);
    }, [highlightRef]);
    return (<div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 9 }}>
      <table className="w-full border-collapse text-sm" style={{ background: CD.panel }}>
        <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-left text-[10px] uppercase tracking-wide">
          <th className="px-3 py-2 font-medium">Ref</th><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Type</th>
          <th className="px-3 py-2 font-medium text-right">Pay-in</th><th className="px-3 py-2 font-medium text-right">Pay-out</th>{!compact && <th className="px-3 py-2 font-medium text-right">Fee</th>}<th className="px-3 py-2 font-medium text-center">Flags</th>
        </tr></thead>
        <tbody>{rows.map(x => { const f = flags[x.id] || {}; const v = x.status === 'void'; const hl = highlightRef && x.ref === highlightRef; return (
          <tr key={x.id} ref={hl ? hlRow : null} onClick={() => onOpen && onOpen(x.id)} className={onOpen ? 'cursor-pointer' : ''} style={{ borderTop: `1px solid ${CD.lineSoft}`, opacity: v ? 0.5 : 1, background: hl ? CD.brassSoft : 'transparent', boxShadow: hl ? `inset 3px 0 0 ${CD.brass}` : 'none' }}
            onMouseEnter={e => onOpen && (e.currentTarget.style.background = hl ? CD.brassSoft : 'var(--cd-paper-soft)')} onMouseLeave={e => e.currentTarget.style.background = hl ? CD.brassSoft : 'transparent'}>
            <td className="px-3 py-2" style={{ fontFamily: 'Space Mono, monospace', fontSize: 11, color: hl ? 'var(--cd-brass-text)' : CD.mute, fontWeight: hl ? 700 : 400, textDecoration: v ? 'line-through' : 'none' }}>{x.ref}</td>
            <td className="px-3 py-2 whitespace-nowrap" style={{ color: CD.text }}>{x.date}</td>
            <td className="px-3 py-2" style={{ color: CD.mute }}>{x.type}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(x.inAmt)} <span style={{ color: CD.faint }}>{x.inCcy}</span></td>
            <td className="px-3 py-2 text-right whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green, fontWeight: 600 }}>{x.outAmt === '' ? '—' : num(x.outAmt)} <span style={{ color: CD.faint, fontWeight: 400 }}>{x.outCcy}</span></td>
            {!compact && <td className="px-3 py-2 text-right whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(x.fee, 'CAD')}</td>}
            <td className="px-3 py-2 text-center" style={{ fontFamily: 'Space Mono, monospace', fontSize: 10, color: CD.mute }}>{v ? 'VOID' : ([f.single ? 'RPT' : '', f.str ? 'STR' : '', (f.kyc && f.kyc !== 'ok') ? 'ID' : ''].filter(Boolean).join(' ') || '—')}</td>
          </tr>); })}</tbody>
      </table>
    </div>);
  }

  /* ---------- printable client report ---------- */
  function exportClientReport(name, rec, rows, flags) {
    rec = rec || {};
    const mine = rows.filter(r => r.customer === name).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const st = clientStats(rows, name);
    const [stat] = kycStatus(rec, {}, name);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const corp = rec.kind === 'corporate';
    const reportable = mine.filter(r => (flags[r.id] || {}).single).length;
    const row = (l, v) => v ? `<tr><td class="k">${esc(l)}</td><td>${esc(v)}</td></tr>` : '';
    const body = mine.map(r => { const f = flags[r.id] || {}; const v = r.status === 'void'; return `<tr${v ? ' class="void"' : ''}><td class="mono">${esc(r.ref)}</td><td>${esc(r.date)}</td><td class="mut">${esc(r.type)}</td><td class="r">${num(r.inAmt)} ${esc(r.inCcy)}</td><td class="r grn">${r.outAmt === '' ? '—' : num(r.outAmt)} ${esc(r.outCcy)}</td><td class="r">${fmt(r.fee, 'CAD')}</td><td class="c mono">${v ? 'VOID' : ([f.single ? 'RPT' : '', f.str ? 'STR' : '', (f.kyc && f.kyc !== 'ok') ? 'ID' : ''].filter(Boolean).join(' ') || '—')}</td></tr>`; }).join('');
    const addr = fullAddr(rec);
    const w = window.open('', '_blank', 'width=920,height=1100');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)} — client report</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:34px 40px;color:#0a0a0a;}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0a0a0a;padding-bottom:15px;margin-bottom:18px;}
.bd{display:flex;align-items:center;gap:9px;}.logo{width:30px;height:30px;background:#0a0a0a;color:#fff;border-radius:7px;display:grid;place-items:center;font-family:'Space Mono',monospace;font-weight:700;font-size:13px;}
.wm{font-family:'Space Mono',monospace;font-weight:700;font-size:12px;letter-spacing:.04em;}.h1{font-size:23px;font-weight:800;margin-top:11px;}.sub{font-size:12px;color:#666;margin-top:2px;}
.meta{text-align:right;font-size:11px;color:#666;line-height:1.7;}.meta b{color:#0a0a0a;font-family:'Space Mono',monospace;}
.badge{display:inline-block;font-size:10px;font-weight:700;font-family:'Space Mono',monospace;padding:3px 9px;border-radius:999px;border:1px solid #999;margin-top:8px;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px;}
.card{border:1px solid #e2e0d9;border-radius:10px;padding:14px 16px;}
.ct{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#888;font-family:'Space Mono',monospace;margin-bottom:8px;}
.kv{width:100%;border-collapse:collapse;}.kv td{font-size:12.5px;padding:4px 0;vertical-align:top;}.kv td.k{color:#888;width:42%;}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e2e0d9;border:1px solid #e2e0d9;margin-bottom:18px;}
.kpi{background:#fff;padding:11px 14px;}.kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#888;}.kpi .v{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px;}
table.tx{border-collapse:collapse;width:100%;}table.tx th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#888;padding:7px 9px;background:#f1f0ec;border-bottom:1px solid #ddd;}
table.tx td{font-size:11.5px;padding:6px 9px;border-bottom:1px solid #f0efe9;}.r{text-align:right;font-variant-numeric:tabular-nums;}.c{text-align:center;}.mono{font-family:'Space Mono',monospace;font-size:10px;color:#666;}.mut{color:#999;}.grn{color:#1f8a4c;}tr.void td{opacity:.5;text-decoration:line-through;}
.ft{margin-top:14px;font-size:10px;color:#999;}@page{margin:13mm;}</style></head><body>
<div class="hd"><div><div class="bd"><span class="logo">CD</span><span class="wm">CURRENCYDESK OS</span></div><div class="h1">${esc(name)}</div><div class="sub">${corp ? 'Corporate client' : 'Individual client'} · KYC file</div><span class="badge">${esc(stat).toUpperCase()}</span></div>
<div class="meta"><b>CLIENT REPORT</b><div>Generated ${esc(new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''))}</div><div>York Currency Exchange · MSB</div></div></div>
<div class="kpis"><div class="kpi"><div class="l">Transactions</div><div class="v">${st.n}</div></div><div class="kpi"><div class="l">Lifetime volume</div><div class="v">${fmt(st.vol, 'CAD')}</div></div><div class="kpi"><div class="l">Fees paid</div><div class="v">${fmt(st.fees, 'CAD')}</div></div><div class="kpi"><div class="l">Reportable deals</div><div class="v">${reportable}</div></div></div>
<div class="grid">
<div class="card"><div class="ct">${corp ? 'Corporate details' : 'Identity'}</div><table class="kv">${row(corp ? 'Legal name' : 'Full name', name)}${corp ? row('Incorporated', rec.incorpDate) + row('Jurisdiction', rec.jurisdiction) + row('Nature of business', rec.business) + row('Primary contact', [rec.contactName, rec.contactTitle].filter(Boolean).join(' · ')) : row('Date of birth', rec.dob ? rec.dob + (ageFrom(rec.dob) != null ? ' (age ' + ageFrom(rec.dob) + ')' : '') : '') + row('Occupation', rec.occupation)}</table></div>
<div class="card"><div class="ct">Contact</div><table class="kv">${row('Email', rec.email)}${row('Phone', rec.phone)}${row('Address', addr)}</table></div>
<div class="card"><div class="ct">Identification (KYC)</div><table class="kv">${row(corp ? 'Document' : 'ID type', rec.idType)}${row('Number', rec.idNum)}${row('Issued', rec.idIssued)}${row('Expiry', rec.idExpiry)}${row('Risk rating', rec.risk)}</table></div>
<div class="card"><div class="ct">Activity</div><table class="kv">${row('First seen', mine.length ? mine[mine.length - 1].date : '')}${row('Last seen', st.last)}${row('Status', stat)}</table>${rec.notes ? `<div style="margin-top:8px;font-size:11.5px;color:#555;"><b>Notes:</b> ${esc(rec.notes)}</div>` : ''}</div>
</div>
<div class="ct" style="margin-bottom:6px;">Transaction history (${mine.length})</div>
<table class="tx"><thead><tr><th>Ref</th><th>Date</th><th>Type</th><th class="r">Pay-in</th><th class="r">Pay-out</th><th class="r">Fee</th><th class="c">Flags</th></tr></thead><tbody>${body || '<tr><td colspan="7" style="padding:14px;color:#999;">No transactions.</td></tr>'}</tbody></table>
<div class="ft">RPT = reportable ≥ $10,000 · STR = structuring watch · ID = KYC exception. Prepared for FINTRAC record-keeping. Volumes in CAD-equivalent at live mid.</div>
</body></html>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 400);
  }

  /* ---------- QUICK CARD (single click) ---------- */
  function QuickCard({ name, rec, rows, flags, settings, me, canEdit, beneficiaries, corridors, setField, onUpload, onExpand, onOpenLedger, onClose }) {
    const st = clientStats(rows, name);
    const [stat, col, bg] = kycStatus(rec, settings, name);
    const corp = rec.kind === 'corporate';
    const myBens = (beneficiaries || []).filter(b => b.sender === name);
    return (<div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 8000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} onDoubleClick={onExpand} className="w-full" style={{ maxWidth: 420, background: CD.panel, borderRadius: 16, boxShadow: '0 24px 60px -16px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="p-5" style={{ background: 'var(--cd-paper-soft)', borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-start gap-3.5">
            <Avatar rec={rec} name={name} size={56} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2"><button onClick={onExpand} className="text-[17px] font-semibold truncate text-left hover:underline" style={{ color: CD.ink }} title="Open full KYC profile">{name}</button></div>
              <div className="flex items-center gap-2 mt-1"><Pill text={corp ? 'Corporate' : 'Individual'} c={CD.mute} bg={CD.lineSoft} /><Pill text={stat} c={col} bg={bg} /></div>
            </div>
            <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-4">
            <div><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Txns</div><div className="text-[15px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{st.n}</div></div>
            <div><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Volume</div><div className="text-[15px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(st.vol, 'CAD')}</div></div>
            <div><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Last seen</div><div className="text-[15px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{st.last || '—'}</div></div>
          </div>
        </div>
        <div className="p-5">
          {(rec.email || rec.phone) && <div className="flex flex-wrap gap-x-5 gap-y-1 mb-3">
            {rec.email && <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: CD.text }}><Ic n="mail" s={13} c={CD.mute} /> {rec.email}</span>}
            {rec.phone && <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: CD.text }}><Ic n="phone" s={13} c={CD.mute} /> {rec.phone}</span>}
          </div>}
          <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{corp ? 'Document' : 'Identification'}</div>
          <div className="grid grid-cols-2 gap-2.5">
            <EditField label={corp ? 'Doc type' : 'ID type'}><select disabled={!canEdit} value={rec.idType || ''} onChange={e => setField('idType', e.target.value)} className={inCls} style={inSty}><option value="">—</option>{(corp ? ID_TYPES_CORP : ID_TYPES_IND).map(t => <option key={t}>{t}</option>)}</select></EditField>
            <EditField label={corp ? 'Number' : 'ID number'}><input disabled={!canEdit} value={rec.idNum || ''} onChange={e => setField('idNum', e.target.value)} className={inCls} style={inSty} /></EditField>
            <EditField label="Expiry"><input disabled={!canEdit} type="date" value={rec.idExpiry || ''} onChange={e => setField('idExpiry', e.target.value)} className={inCls} style={inSty} /></EditField>
            <EditField label="ID scan">{rec.photo ? <div className="flex items-center gap-2"><img src={rec.photo} alt="ID" className="h-9" style={{ border: `1px solid ${CD.line}`, borderRadius: 6 }} />{canEdit && <button onClick={() => setField('photo', null)} className="text-[11px]" style={{ color: CD.flag }}>Remove</button>}</div> : <label className="flex items-center gap-1.5 text-[11px] px-2 py-2 cursor-pointer justify-center" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8 }}><Ic n="upload" s={12} /> Upload<input type="file" accept="image/*" className="hidden" disabled={!canEdit} onChange={e => e.target.files[0] && onUpload('photo', e.target.files[0])} /></label>}</EditField>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button onClick={() => onOpenLedger(name)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="scroll" s={15} c="var(--cd-on-ink)" /> View {st.n} transactions</button>
            <button onClick={onExpand} title="Open full profile (or double-click the card)" className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-sm font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink }}><Ic n="userplus" s={15} /> Full profile</button>
          </div>
          {myBens.length > 0 && <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Sends money to</div><div className="flex flex-wrap gap-1.5">{myBens.slice(0, 4).map(b => { const cor = (corridors || []).find(c => c.id === b.corridor) || {}; return <span key={b.id} className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px]" style={{ background: 'var(--cd-chip)', borderRadius: 7, color: CD.ink }}>{cor.flag || '🌐'} {b.name} <span style={{ color: CD.faint }}>· {b.relationship}</span></span>; })}{myBens.length > 4 && <span className="text-[11px] px-1.5 py-1" style={{ color: CD.faint }}>+{myBens.length - 4}</span>}</div></div>}
          <div className="text-[10.5px] text-center mt-2.5" style={{ color: CD.faint }}>Double-click anywhere on this card to expand the full contact</div>
        </div>
      </div>
    </div>);
  }

  /* ---------- client beneficiaries (nested under each contact) ---------- */
  function ClientBeneficiaries({ name, beneficiaries, setBeneficiaries, corridors, canEdit, log }) {
    const Tx = window.CDOS._transfers || {};
    const [edit, setEdit] = useState(null);   // 'new' | beneficiary object
    const mine = (beneficiaries || []).filter(b => b.sender === name);
    const corOf = (id) => (corridors || []).find(c => c.id === id) || {};
    const first = (name || '').split(/\s+/)[0];
    const save = (b) => { setBeneficiaries(list => { const ex = list.find(x => x.id === b.id); return ex ? list.map(x => x.id === b.id ? b : x) : [b, ...list]; }); setEdit(null); log && log('Beneficiary saved', `${b.name} · for ${name}`); };
    const remove = (id) => setBeneficiaries(list => list.filter(x => x.id !== id));
    if (!Tx.BeneficiaryModal) return null;
    return (<div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2"><span className="grid place-items-center" style={{ width: 24, height: 24, borderRadius: 7, background: CD.lineSoft }}><Ic n="send" s={13} c={CD.mute} /></span><div className="text-sm font-semibold" style={{ color: CD.ink }}>Sends money to <span style={{ color: CD.faint, fontWeight: 400 }}>· {mine.length}</span></div></div>
        {canEdit && <button onClick={() => setEdit('new')} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="userplus" s={13} /> Add beneficiary</button>}
      </div>
      {mine.length ? (
        <div className="grid sm:grid-cols-2 gap-2">
          {mine.map(b => { const cor = corOf(b.corridor); return (
            <div key={b.id} className="p-2.5 flex items-start gap-2.5" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 10 }}>
              <span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: '50%', background: CD.lineSoft, fontSize: 15 }}>{cor.flag || '🌐'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint }}>· {b.relationship}</span></div>
                <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{cor.country} · {Tx.methodLabel(b.method)} · {b.partner}</div>
                {b.method === 'bank' && b.account && <div className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{b.bank} · {b.account}</div>}
                {b.method === 'cash' && b.pickupCity && <div className="text-[10.5px]" style={{ color: CD.faint }}>Pickup · {b.pickupCity}</div>}
                {b.method === 'wallet' && b.walletId && <div className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{b.walletId}</div>}
              </div>
              {canEdit && <div className="flex flex-col gap-0.5 flex-none">
                <button onClick={() => setEdit(b)} title="Edit" className="p-1" style={{ borderRadius: 6 }}><Ic n="pencil" s={13} c={CD.mute} /></button>
                <button onClick={() => remove(b.id)} title="Remove" className="p-1" style={{ borderRadius: 6 }}><Ic n="trash" s={13} c={CD.faint} /></button>
              </div>}
            </div>); })}
        </div>
      ) : (
        <div className="text-[12px] py-4 text-center" style={{ color: CD.faint }}>No beneficiaries on file. {canEdit ? `Add who ${first} sends money to — it'll be ready at the counter.` : ''}</div>
      )}
      {edit && <Portal><Tx.BeneficiaryModal init={edit === 'new' ? null : edit} sender={name} lockSender corridors={corridors} onClose={() => setEdit(null)} onSave={save} /></Portal>}
    </div>);
  }

  /* ---------- CLIENT COMPLIANCE SUMMARY (top of profile) ---------- */
  /* mirrors the bell / computeAlerts logic exactly so what's flagged at the
     menu bar is the same thing surfaced here on the contact. */
  function CompRow({ tone, soft, icon, title, sub, actionLabel, onAction }) {
    return (<div className="flex items-center gap-3 px-3.5 py-3" style={{ background: soft, borderRadius: 10 }}>
      <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--cd-panel)' }}><Ic n={icon} s={16} c={tone} /></span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{title}</div>
        <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{sub}</div>
      </div>
      {actionLabel && <button onClick={onAction} className="flex items-center gap-1 text-[12px] font-medium flex-none px-2.5 py-1.5" style={{ color: tone, border: `1px solid ${tone}`, borderRadius: 7, background: 'var(--cd-panel)', whiteSpace: 'nowrap' }}>{actionLabel} <Ic n="chev" s={12} c={tone} /></button>}
    </div>);
  }
  function ClientCompliance({ name, rec, mine, flags, settings, canEdit, onOpenLedger, onFixId }) {
    const live = mine.filter(r => r.status !== 'void');
    const rpt = live.filter(r => { const f = flags[r.id] || {}; return (f.single || f.agg24) && !r.filed; });
    const strRows = live.filter(r => { const f = flags[r.id] || {}; return f.str && !r.ackStr; });
    const kycRow = live.find(r => { const f = flags[r.id] || {}; return f.kyc && f.kyc !== 'ok'; });
    const kycReason = kycRow ? (flags[kycRow.id] || {}).kyc : ((!rec || !rec.idType || !rec.idNum) ? 'missing ID' : null);
    const strAgg = strRows.reduce((m, r) => Math.max(m, (flags[r.id] || {}).agg || 0), 0);
    const win = (settings && +settings.structuringDays) || 7;
    const open = rpt.length + (strRows.length ? 1 : 0) + (kycReason ? 1 : 0);
    return (<div className="mb-5 p-4" style={{ background: CD.panel, border: `1px solid ${open ? CD.flag : CD.line}`, borderRadius: 12 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="shield" s={13} c={open ? CD.flag : CD.green} /> Compliance</div>
        {open ? <Pill text={`${open} open`} c={CD.flag} bg={CD.flagSoft} /> : <Pill text="All clear" c={CD.green} bg={CD.greenSoft} />}
      </div>
      {open === 0 ? (
        <div className="flex items-center gap-2 text-[12.5px] px-1 py-1" style={{ color: CD.mute }}><Ic n="checkcircle" s={15} c={CD.green} /> No open flags — reportables filed, ID on file, no structuring pattern.</div>
      ) : (
        <div className="space-y-2">
          {rpt.length > 0 && <CompRow tone={CD.flag} soft={CD.flagSoft} icon="alert" title="Reportable — not yet filed" sub={`${rpt.length} transaction${rpt.length === 1 ? '' : 's'} over the reporting threshold awaiting a report.`} actionLabel="Review & file" onAction={() => onOpenLedger(name)} />}
          {strRows.length > 0 && <CompRow tone={CD.amber} soft={CD.amberSoft} icon="alert" title="Structuring watch" sub={`${win}-day cash-in ${fmt(strAgg, 'CAD')} across ${strRows.length} just-under deal${strRows.length === 1 ? '' : 's'}.`} actionLabel="Review in ledger" onAction={() => onOpenLedger(name)} />}
          {kycReason && <CompRow tone={CD.flag} soft={CD.flagSoft} icon="id" title="KYC / ID gap" sub={`Identification issue: ${kycReason}.`} actionLabel={canEdit ? 'Fix ID' : null} onAction={onFixId} />}
        </div>
      )}
    </div>);
  }

  /* ---------- FULL PROFILE (double click) ---------- */
  function Profile({ name, rec, rows, clients, setClients, settings, me, canEdit, canExport, beneficiaries, setBeneficiaries, corridors, onOpenLedger, onClose, log, highlightTx }) {
    const [edit, setEdit] = useState(false);   // always open read-only; Edit button enters edit mode
    const set = (k, v) => setClients(c => ({ ...c, [name]: { ...(c[name] || {}), [k]: v, updatedAt: new Date().toISOString().slice(0, 10) } }));
    const upload = (k, file) => { const r = new FileReader(); r.onload = () => { set(k, r.result); log && log(k === 'photo' ? 'ID scan saved' : 'Photo added', name); }; r.readAsDataURL(file); };
    const addGallery = (file) => { const r = new FileReader(); r.onload = () => { setClients(c => { const cur = c[name] || {}; const g = (cur.gallery || []).concat(r.result); return { ...c, [name]: { ...cur, gallery: g } }; }); log && log('Photo added', name); }; r.readAsDataURL(file); };
    const rmGallery = (i) => setClients(c => { const cur = c[name] || {}; const g = (cur.gallery || []).slice(); g.splice(i, 1); return { ...c, [name]: { ...cur, gallery: g } }; });
    const stamp = () => new Date().toISOString().slice(0, 10);
    // additional identity documents (the primary top-level ID drives KYC status; these are extra IDs on file)
    const addId = () => setClients(c => { const cur = c[name] || {}; const ids = (cur.ids || []).concat({ type: '', num: '', issued: '', expiry: '', photo: null }); return { ...c, [name]: { ...cur, ids, updatedAt: stamp() } }; });
    const setId = (i, k, v) => setClients(c => { const cur = c[name] || {}; const ids = (cur.ids || []).slice(); ids[i] = { ...(ids[i] || {}), [k]: v }; return { ...c, [name]: { ...cur, ids, updatedAt: stamp() } }; });
    const rmId = (i) => setClients(c => { const cur = c[name] || {}; const ids = (cur.ids || []).slice(); ids.splice(i, 1); return { ...c, [name]: { ...cur, ids, updatedAt: stamp() } }; });
    const uploadId = (i, file) => { const r = new FileReader(); r.onload = () => { setId(i, 'photo', r.result); log && log('ID document added', name); }; r.readAsDataURL(file); };
    // supporting documents (proof of address, source of funds, corporate filings, …)
    const addDoc = (file) => { const r = new FileReader(); r.onload = () => setClients(c => { const cur = c[name] || {}; const docs = (cur.docs || []).concat({ label: (file.name || 'Document').replace(/\.[^.]+$/, ''), fileName: file.name || '', mime: file.type || '', file: r.result, addedAt: stamp() }); return { ...c, [name]: { ...cur, docs, updatedAt: stamp() } }; }); r.readAsDataURL(file); log && log('Document added', name); };
    const setDoc = (i, k, v) => setClients(c => { const cur = c[name] || {}; const docs = (cur.docs || []).slice(); docs[i] = { ...(docs[i] || {}), [k]: v }; return { ...c, [name]: { ...cur, docs, updatedAt: stamp() } }; });
    const rmDoc = (i) => setClients(c => { const cur = c[name] || {}; const docs = (cur.docs || []).slice(); docs.splice(i, 1); return { ...c, [name]: { ...cur, docs, updatedAt: stamp() } }; });
    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    const mine = useMemo(() => rows.filter(r => r.customer === name).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)), [rows, name]);
    const st = clientStats(rows, name);
    const [stat, col, bg] = kycStatus(rec, settings, name);
    const corp = rec.kind === 'corporate';
    const reportable = mine.filter(r => (flags[r.id] || {}).single).length;
    const addr = fullAddr(rec);

    return (<div className="fixed inset-0 flex items-center justify-center p-3 md:p-6" style={{ background: 'var(--cd-scrim)', zIndex: 8000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 880, height: '92%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        {/* header */}
        <div className="flex items-start gap-4 px-6 py-5 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <div className="relative flex-none">
            <Avatar rec={rec} name={name} size={64} />
            {canEdit && <span className="absolute -bottom-1 -right-1"><PhotoCaptureMenu onPhoto={(data) => { set('avatar', data); log && log('Photo added', name); }} title="Set contact photo" badge={{ width: 24, height: 24, borderRadius: '50%', background: CD.ink, border: `2px solid ${CD.panel}` }} /></span>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap"><span className="text-[20px] font-bold" style={{ color: CD.ink }}>{name}</span><Pill text={corp ? 'Corporate' : 'Individual'} c={CD.mute} bg={CD.lineSoft} /><Pill text={stat} c={col} bg={bg} />{normalizeRisk(rec.risk) !== 'Normal' && <Pill text={normalizeRisk(rec.risk) + ' risk'} c={riskTone(rec.risk).c} bg={riskTone(rec.risk).bg} />}<window.CDOS.InfoTip title="Status & risk" body="Two independent reads on this contact: the KYC status is the ID you hold on file; the risk rating is the tier you've assigned for your own compliance." lines={[{k:'Verified',v:'ID on file & valid'},{k:'Missing ID',v:'no ID captured yet'},{k:'ID expiring',v:'expires soon — re-collect'},{k:'Risk tier',v:'Normal · Low · Medium · High'}]} /></div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[12.5px]" style={{ color: CD.mute }}>
              {rec.email && <span className="flex items-center gap-1.5"><Ic n="mail" s={12} c={CD.faint} /> {rec.email}</span>}
              {rec.phone && <span className="flex items-center gap-1.5"><Ic n="phone" s={12} c={CD.faint} /> {rec.phone}</span>}
              {settings && settings.requireClientEmail && !rec.email && <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ color: CD.amber, background: CD.amberSoft, borderRadius: 5 }}><Ic n="mail" s={11} c={CD.amber} /> email required</span>}
              {settings && settings.requireClientPhone && !rec.phone && <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ color: CD.amber, background: CD.amberSoft, borderRadius: 5 }}><Ic n="phone" s={11} c={CD.amber} /> phone required</span>}
              {(corp ? rec.jurisdiction : rec.occupation) && <span className="flex items-center gap-1.5"><Ic n={corp ? 'mappin' : 'briefcase'} s={12} c={CD.faint} /> {corp ? rec.jurisdiction : rec.occupation}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-none">
            {canEdit && <button onClick={() => setEdit(e => !e)} className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium" style={{ border: `1px solid ${edit ? CD.ink : CD.line}`, background: edit ? CD.ink : 'transparent', color: edit ? 'var(--cd-on-ink)' : CD.ink, borderRadius: 8 }}><Ic n={edit ? 'check' : 'pencil'} s={14} c={edit ? 'var(--cd-on-ink)' : CD.ink} /> {edit ? 'Done' : 'Edit'}</button>}
            {canExport && <button onClick={() => exportClientReport(name, rec, rows, flags)} className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="filetext" s={14} c="var(--cd-on-ink)" /> Export report</button>}
            <button onClick={onClose} className="grid place-items-center" style={{ width: 34, height: 34, borderRadius: 8, color: CD.mute }}><Ic n="x" s={18} /></button>
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto px-6 py-5">
          {/* COMPLIANCE — first thing the owner sees, mirrors the menu-bar bell */}
          <ClientCompliance name={name} rec={rec} mine={mine} flags={flags} settings={settings} canEdit={canEdit} onOpenLedger={onOpenLedger} onFixId={() => setEdit(true)} />
          {/* risk rating — always visible on the profile, set inline without entering edit mode */}
          <div className="flex items-center justify-between gap-3 flex-wrap mb-5 p-3.5" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
            <div className="flex items-center gap-2.5"><span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: 9, background: CD.lineSoft }}><Ic n="shield" s={16} c={CD.mute} /></span><div><div className="flex items-center gap-1.5"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>Risk rating</div><window.CDOS.InfoTip title="Risk rating" body="Your own read on how much scrutiny a client needs. Setting it puts your judgment on the file — proof to examiners you run an active, risk-based program. It sharpens what the desk recommends, but never replaces the checks themselves: you still verify ID and file the reports required by law. You do your part — CurrencyDesk does the rest." lines={[{k:'Low · Normal',v:'standard handling'},{k:'Medium',v:'a closer watch'},{k:'High',v:'auto-deepens the ID check'}]} /></div><div className="text-[11px]" style={{ color: CD.mute }}>Your own compliance rating for this profile.</div></div></div>
            <div className="inline-flex items-stretch flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 999, overflow: 'hidden', opacity: canEdit ? 1 : 0.65 }}>{RISK.map((r, i) => { const on = normalizeRisk(rec.risk) === r; const tn = riskTone(r); return <button key={r} type="button" disabled={!canEdit} onClick={() => set('risk', r)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium" style={{ background: on ? tn.bg : 'transparent', color: on ? tn.c : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none', cursor: canEdit ? 'pointer' : 'default' }}><span style={{ width: 6, height: 6, borderRadius: 999, background: tn.c, flex: 'none' }} />{r}</button>; })}</div>
          </div>
          {/* identity verification — partner KYC / sanctions screening (compliance) */}
          <div className="mb-5">
            {window.CDOS.KYC ? <window.CDOS.KYC.SubjectPanel name={name} kind={rec.kind || 'individual'} rec={rec} by={me && me.name} setClients={setClients} settings={settings} /> : null}
          </div>
          {/* KPI strip */}
          <div className="grid grid-cols-4 gap-px mb-5" style={{ background: CD.line, border: `1px solid ${CD.line}`, borderRadius: 10, overflow: 'hidden' }}>
            {[['Transactions', String(st.n)], ['Lifetime volume', fmt(st.vol, 'CAD')], ['Fees paid', fmt(st.fees, 'CAD')], ['Reportable', String(reportable)]].map(([l, v], i) => (
              <div key={i} className="px-4 py-3" style={{ background: CD.panel }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[18px] font-semibold mt-0.5" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>
            ))}
          </div>

          {edit ? (
            <div className="space-y-5">
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="flex items-center justify-between mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Contact details</div>
                  <div className="inline-flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{['individual', 'corporate'].map(k => <button key={k} onClick={() => set('kind', k)} className="px-3 py-1.5 text-xs capitalize" style={{ background: (rec.kind || 'individual') === k ? CD.ink : 'transparent', color: (rec.kind || 'individual') === k ? 'var(--cd-on-ink)' : CD.mute }}>{k}</button>)}</div>
                </div>
                <ContactEditor rec={rec} set={set} kind={rec.kind || 'individual'} />
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="flex items-center justify-between mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Identity documents</div>{canEdit && <button type="button" onClick={addId} className="flex items-center gap-1 text-[12px] font-medium" style={{ color: CD.ink }}><Ic n="plus" s={13} c={CD.ink} /> Add ID</button>}</div>
                <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Primary ID · drives KYC status</div>
                <KycEditor rec={rec} set={set} kind={rec.kind || 'individual'} onUpload={upload} canEdit={canEdit} />
                {(rec.ids || []).length > 0 && <div className="mt-3 space-y-3">{(rec.ids || []).map((d, i) => <IdEditorRow key={i} doc={d} i={i} kind={rec.kind || 'individual'} setId={setId} rmId={rmId} uploadId={uploadId} canEdit={canEdit} />)}</div>}
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="flex items-center justify-between mb-3 gap-3"><div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Documents</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute, maxWidth: 340 }}>Proof of address, source of funds, corporate filings — anything supporting the file.</div></div>{canEdit && <label className="flex items-center gap-1 text-[12px] font-medium cursor-pointer flex-none" style={{ color: CD.ink }}><Ic n="upload" s={13} c={CD.ink} /> Add<input type="file" accept="image/*,application/pdf" className="hidden" onChange={e => { if (e.target.files[0]) { addDoc(e.target.files[0]); e.target.value = ''; } }} /></label>}</div>
                {(rec.docs || []).length ? <div className="space-y-2">{(rec.docs || []).map((d, i) => { const img = /^image\//.test(d.mime || '') || /^data:image\//.test(d.file || ''); return (
                  <div key={i} className="flex items-center gap-3 p-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 10 }}>
                    <a href={d.file} target="_blank" rel="noreferrer" className="grid place-items-center flex-none" style={{ width: 40, height: 40, borderRadius: 8, background: CD.lineSoft, overflow: 'hidden' }}>{img ? <img src={d.file} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Ic n="filetext" s={16} c={CD.mute} />}</a>
                    <div className="flex-1 min-w-0"><input value={d.label || ''} onChange={e => setDoc(i, 'label', e.target.value)} disabled={!canEdit} className="w-full text-[13px] font-medium px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-panel)', color: CD.ink }} placeholder="Document label" /><div className="text-[10.5px] mt-1 truncate" style={{ color: CD.faint }}>{d.fileName || 'file'} · added {d.addedAt}</div></div>
                    <a href={d.file} target="_blank" rel="noreferrer" className="text-[12px] font-medium flex-none" style={{ color: CD.ink }}>View</a>
                    {canEdit && <button type="button" onClick={() => rmDoc(i)} className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, color: CD.flag }}><Ic n="x" s={14} c={CD.flag} /></button>}
                  </div>); })}</div>
                  : <div className="text-[12px] py-3 text-center" style={{ color: CD.faint }}>No documents attached yet.</div>}
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="text-sm font-semibold mb-2" style={{ color: CD.ink }}>Notes</div>
                <textarea value={rec.notes || ''} onChange={e => set('notes', e.target.value)} rows={3} className="w-full text-sm px-3 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, resize: 'vertical' }} placeholder="Source of funds, relationship, anything the next teller should know…" />
              </div>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{corp ? 'Corporate details' : 'Identity'}</div>
                {corp ? (<>
                  <KV icon="building" label="Legal name" value={name} />
                  <KV icon="calendar" label="Incorporated" value={rec.incorpDate} />
                  <KV icon="globe" label="Jurisdiction" value={rec.jurisdiction} />
                  <KV icon="briefcase" label="Nature of business" value={rec.business} />
                  <KV icon="users" label="Primary contact" value={[rec.contactName, rec.contactTitle].filter(Boolean).join(' · ')} />
                </>) : (<>
                  <KV icon="cake" label="Date of birth" value={rec.dob ? rec.dob + (ageFrom(rec.dob) != null ? `  ·  age ${ageFrom(rec.dob)}` : '') : ''} />
                  <KV icon="briefcase" label="Occupation" value={rec.occupation} />
                </>)}
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Contact</div>
                <KV icon="mail" label="Email" value={rec.email} />
                <KV icon="phone" label="Phone" value={rec.phone} />
                <KV icon="mappin" label="Address" value={addr} />
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Identification (KYC){(rec.ids || []).length > 0 && <span style={{ color: CD.mute }}> · {1 + (rec.ids || []).length} on file</span>}</div>
                <KV icon="id" label={corp ? 'Document' : 'ID type'} value={rec.idType} />
                <KV icon="scroll" label="Number" value={rec.idNum} mono />
                <KV icon="calendar" label="Expiry" value={rec.idExpiry} />
                {rec.photo && <div className="mt-2"><img src={rec.photo} alt="ID document" style={{ maxHeight: 120, border: `1px solid ${CD.line}`, borderRadius: 8 }} /></div>}
                {(rec.ids || []).map((d, i) => (<div key={i} className="mt-3 pt-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Additional ID {i + 1}</div>
                  <KV icon="id" label="Type" value={d.type} />
                  <KV icon="scroll" label="Number" value={d.num} mono />
                  <KV icon="calendar" label="Expiry" value={d.expiry} />
                  {d.photo && <div className="mt-2"><img src={d.photo} alt="ID" style={{ maxHeight: 100, border: `1px solid ${CD.line}`, borderRadius: 8 }} /></div>}
                </div>))}
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Documents{(rec.docs || []).length > 0 && <span style={{ color: CD.mute }}> · {(rec.docs || []).length}</span>}</div>
                {(rec.docs || []).length ? <div className="space-y-2">{(rec.docs || []).map((d, i) => { const img = /^image\//.test(d.mime || '') || /^data:image\//.test(d.file || ''); return (
                  <a key={i} href={d.file} target="_blank" rel="noreferrer" className="flex items-center gap-3 p-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 9 }}>
                    <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 7, background: CD.lineSoft, overflow: 'hidden' }}>{img ? <img src={d.file} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Ic n="filetext" s={15} c={CD.mute} />}</span>
                    <div className="flex-1 min-w-0"><div className="text-[12.5px] font-medium truncate" style={{ color: CD.ink }}>{d.label || d.fileName || 'Document'}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>added {d.addedAt}</div></div>
                    <Ic n="chev" s={14} c={CD.faint} />
                  </a>); })}</div>
                  : <div className="text-[12px] py-3 text-center" style={{ color: CD.faint }}>No documents attached.</div>}
              </div>
              <div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                <div className="flex items-center justify-between mb-2"><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Photos</div>
                  {canEdit && <label className="flex items-center gap-1 text-[11px] cursor-pointer" style={{ color: CD.mute }}><Ic n="camera" s={12} /> Add<input type="file" accept="image/*" className="hidden" onChange={e => e.target.files[0] && addGallery(e.target.files[0])} /></label>}
                </div>
                {(rec.gallery && rec.gallery.length) ? <div className="flex flex-wrap gap-2">{rec.gallery.map((g, i) => (<div key={i} className="relative group"><img src={g} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: `1px solid ${CD.line}` }} />{canEdit && <button onClick={() => rmGallery(i)} className="absolute -top-1.5 -right-1.5 grid place-items-center" style={{ width: 18, height: 18, borderRadius: '50%', background: CD.flag, color: 'var(--cd-on-ink)' }}><Ic n="x" s={10} c="var(--cd-on-ink)" /></button>}</div>))}</div>
                  : <div className="text-[12px] py-3 text-center" style={{ color: CD.faint }}>No extra photos. {canEdit ? 'Add photos of the client or documents.' : ''}</div>}
                {rec.notes && <div className="mt-3 pt-3 text-[12px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.mute }}><b style={{ color: CD.ink }}>Notes:</b> {rec.notes}</div>}
              </div>
            </div>
          )}

          {/* beneficiaries — nested under this client */}
          <div className="mt-5">
            <ClientBeneficiaries name={name} beneficiaries={beneficiaries} setBeneficiaries={setBeneficiaries} corridors={corridors} canEdit={canEdit} log={log} />
          </div>

          {/* transactions */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Transaction history · {mine.length}</div>
              <button onClick={() => onOpenLedger(name)} className="text-[12px] font-medium flex items-center gap-1" style={{ color: CD.ink }}>Open in ledger <Ic n="chev" s={12} /></button>
            </div>
            <TxnList rows={mine} flags={flags} onOpen={() => onOpenLedger(name)} highlightRef={highlightTx} />
          </div>
        </div>
      </div>
    </div>);
  }

  /* ---------- NEW CONTACT ---------- */
  function NewContact({ onCreate, onClose, existing }) {
    const [name, setName] = useState('');
    const [kind, setKind] = useState('individual');
    const dupe = name.trim() && existing.includes(name.trim());
    return (<div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 8100 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full p-5" style={{ maxWidth: 380, background: CD.panel, borderRadius: 14, boxShadow: '0 24px 60px -16px var(--cd-scrim)' }}>
        <div className="flex items-center justify-between mb-3"><div className="text-[15px] font-semibold" style={{ color: CD.ink }}>New contact</div><button onClick={onClose} style={{ color: CD.mute }}><Ic n="x" s={16} /></button></div>
        <div className="inline-flex w-full mb-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{['individual', 'corporate'].map(k => <button key={k} onClick={() => setKind(k)} className="flex-1 px-3 py-2 text-sm capitalize" style={{ background: kind === k ? CD.ink : 'transparent', color: kind === k ? 'var(--cd-on-ink)' : CD.mute }}>{k}</button>)}</div>
        <EditField label={kind === 'corporate' ? 'Legal / business name' : 'Full name'}><input autoFocus value={name} onChange={e => setName(e.target.value)} className={inCls} style={inSty} placeholder={kind === 'corporate' ? 'Acme Imports Ltd.' : 'Jane Doe'} onKeyDown={e => { if (e.key === 'Enter' && name.trim() && !dupe) onCreate(name.trim(), kind); }} /></EditField>
        {dupe && <div className="text-[11px] mt-1.5" style={{ color: CD.flag }}>A contact with this name already exists.</div>}
        <button disabled={!name.trim() || dupe} onClick={() => onCreate(name.trim(), kind)} className="w-full mt-4 py-2.5 text-sm font-semibold text-white" style={{ background: !name.trim() || dupe ? CD.mute : CD.ink, borderRadius: 9, opacity: !name.trim() || dupe ? 0.7 : 1 }}>Create contact</button>
      </div>
    </div>);
  }

  /* ---------- MAIN ---------- */
  function Clients({ rows, clients, setClients, settings, me, perms, log, openLedgerForClient, openProfileSignal, beneficiaries, setBeneficiaries, corridors }) {
    const can = (k) => me.role === 'Owner' ? true : !!perms.Teller[k];
    const canEdit = can('canEditKYC');
    const canExport = can('canExport');
    const [q, setQ] = useState('');
    const [filter, setFilter] = useState('all');   // all | individual | corporate | verified | attention
    const [quick, setQuick] = useState(null);
    const [profile, setProfile] = useState(null);
    const [highlightTx, setHighlightTx] = useState(null);
    const [adding, setAdding] = useState(false);
    const clickTimer = useRef(null);
    // external request (e.g. from a ledger transaction's KYC flag) to open a profile
    const lastSig = useRef(0);
    useEffect(() => { if (openProfileSignal && openProfileSignal.n && openProfileSignal.n !== lastSig.current) { lastSig.current = openProfileSignal.n; setQuick(null); setProfile(openProfileSignal.name); setHighlightTx(openProfileSignal.txRef || null); } }, [openProfileSignal]);

    const list = useMemo(() => {
      const m = {};
      rows.filter(r => r.status !== 'void').forEach(x => { const k = x.customer || '—'; if (!m[k]) m[k] = { name: k }; });
      Object.keys(clients).forEach(k => { if (!m[k]) m[k] = { name: k }; });
      return Object.values(m).map(c => ({ ...c, rec: clients[c.name] || {}, st: clientStats(rows, c.name) }))
        .sort((a, b) => b.st.vol - a.st.vol || a.name.localeCompare(b.name));
    }, [rows, clients]);

    const counts = useMemo(() => {
      let ind = 0, corp = 0, ver = 0, att = 0;
      list.forEach(c => { if ((c.rec.kind || 'individual') === 'corporate') corp++; else ind++; const [s] = kycStatus(c.rec, settings, c.name); if (isVerified(s)) ver++; else att++; });
      return { all: list.length, individual: ind, corporate: corp, verified: ver, attention: att };
    }, [list, settings]);

    const shown = useMemo(() => list.filter(c => {
      const r = c.rec;
      if (filter === 'individual' && (r.kind || 'individual') !== 'individual') return false;
      if (filter === 'corporate' && r.kind !== 'corporate') return false;
      const [s] = kycStatus(r, settings, c.name);
      if (filter === 'verified' && !isVerified(s)) return false;
      if (filter === 'attention' && isVerified(s)) return false;
      if (!q) return true;
      const blob = `${c.name} ${r.email || ''} ${r.phone || ''} ${r.idNum || ''} ${r.occupation || ''} ${r.business || ''} ${r.contactName || ''}`.toLowerCase();
      return blob.includes(q.toLowerCase());
    }), [list, q, filter, settings]);

    const onClick = (name) => { setQuick(null); setHighlightTx(null); setProfile(name); };
    const onDbl = (name) => { setProfile(name); };
    const setField = (name, k, v) => setClients(c => ({ ...c, [name]: { ...(c[name] || {}), [k]: v, updatedAt: new Date().toISOString().slice(0, 10) } }));
    const upload = (name, k, file) => { const r = new FileReader(); r.onload = () => { setField(name, k, r.result); log && log('ID scan saved', name); }; r.readAsDataURL(file); };
    const createContact = (name, kind) => { setClients(c => ({ ...c, [name]: { ...(c[name] || {}), kind, createdAt: new Date().toISOString().slice(0, 10) } })); log && log('Contact created', `${name} · ${kind}`); setAdding(false); setProfile(name); };

    const quickRec = quick ? (clients[quick] || {}) : null;
    const profileRec = profile ? (clients[profile] || {}) : null;
    const FILTERS = [['all', 'All', counts.all], ['individual', 'People', counts.individual], ['corporate', 'Businesses', counts.corporate], ['verified', 'Verified', counts.verified], ['attention', 'Needs attention', counts.attention]];

    return (<div className="flex flex-col" style={{ height: '100%' }}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 flex-none" style={{ borderBottom: `1px solid ${CD.line}`, background: CD.panel }}>
        <div className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0" style={{ background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="search" s={15} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email, phone, ID number…" className="w-full outline-none text-sm bg-transparent" />{q && <button onClick={() => setQ('')} style={{ color: CD.mute }}><Ic n="x" s={13} /></button>}</div>
        {canEdit && <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="userplus" s={15} c="var(--cd-on-ink)" /> New contact</button>}
      </div>
      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 flex-none" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
        {FILTERS.map(([id, label, n]) => (
          <button key={id} onClick={() => setFilter(id)} className="text-[12px] px-2.5 py-1.5 font-medium flex items-center gap-1.5" style={{ borderRadius: 999, background: filter === id ? CD.ink : 'transparent', color: filter === id ? 'var(--cd-on-ink)' : CD.mute, border: `1px solid ${filter === id ? CD.ink : CD.line}` }}>
            {label}<span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
          </button>
        ))}
        <span className="ml-auto text-[11.5px]" style={{ color: CD.faint }}>{shown.length} of {list.length} contacts</span>
      </div>
      {/* grid */}
      <div className="flex-1 overflow-auto p-4">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-16" style={{ color: CD.mute }}>
            <Ic n="users" s={28} c={CD.faint} /><div className="mt-3 text-sm font-medium" style={{ color: CD.ink }}>No contacts match</div>
            <div className="text-[12px] mt-1">{q ? 'Try a different search.' : 'Add your first contact or post a transaction.'}</div>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))' }}>
            {shown.map(c => { const [st, col, bg] = kycStatus(c.rec, settings, c.name); const corp = c.rec.kind === 'corporate'; const verified = isVerified(st); const risk = normalizeRisk ? normalizeRisk(c.rec.risk) : (c.rec.risk || 'Normal'); const rt = riskTone ? riskTone(risk) : { c: CD.mute, bg: CD.lineSoft }; const attention = /expir|no id|missing/i.test(st); const accent = attention ? CD.flag : verified ? CD.green : CD.line; return (
              <div key={c.name} onClick={() => onClick(c.name)} onDoubleClick={() => onDbl(c.name)} role="button" tabIndex={0}
                className="cursor-pointer select-none" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 13, overflow: 'hidden', transition: 'border-color .12s, box-shadow .12s, transform .08s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = CD.ink; e.currentTarget.style.boxShadow = '0 8px 22px -12px var(--cd-shade)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = CD.line; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}>
                {/* header — dossier style, accent keyed to KYC standing */}
                <div className="flex items-start gap-3 p-3.5" style={{ borderLeft: `3px solid ${accent}` }}>
                  <Avatar rec={c.rec} name={c.name} size={44} ring />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold truncate" style={{ color: CD.ink, fontSize: 14 }}>{c.name}</span>
                      {verified && <Ic n="checkcircle" s={13} c={CD.green} />}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="inline-flex items-center gap-1 text-[9.5px] px-1.5 py-0.5" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 5, fontFamily: 'Space Mono, monospace', letterSpacing: '.03em' }}><Ic n={corp ? 'building' : 'users'} s={10} c={CD.mute} />{corp ? 'BUSINESS' : 'INDIVIDUAL'}</span>
                      <span className="text-[9.5px] px-1.5 py-0.5 font-semibold" style={{ background: rt.bg, color: rt.c, borderRadius: 5 }}>{risk}</span>
                    </div>
                  </div>
                  <Pill text={st} c={col} bg={bg} />
                </div>
                {/* rate-board readout: the numbers that matter, in mono */}
                <div className="grid grid-cols-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  {[['TXNS', String(c.st.n)], ['VOLUME', fmt(c.st.vol, 'CAD')], ['LAST SEEN', c.st.last || '—']].map(([l, v], i) => (
                    <div key={l} className="px-3 py-2.5" style={{ borderLeft: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                      <div className="text-[8.5px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div>
                      <div className="text-[12.5px] font-bold truncate" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>); })}
          </div>
        )}
        <p className="mt-3 text-[11px] flex items-center gap-1.5" style={{ color: CD.faint }}><Ic n="id" s={12} /> Click a contact to open their full profile. Contacts created at the till appear here automatically.</p>
      </div>

      {quick && <Portal><QuickCard name={quick} rec={quickRec} rows={rows} flags={computeFlags(rows, clients, settings)} settings={settings} me={me} canEdit={canEdit} beneficiaries={beneficiaries} corridors={corridors} setField={(k, v) => setField(quick, k, v)} onUpload={(k, f) => upload(quick, k, f)} onExpand={() => { setProfile(quick); setQuick(null); }} onOpenLedger={(n) => { setQuick(null); openLedgerForClient(n); }} onClose={() => setQuick(null)} /></Portal>}
      {profile && <Portal><Profile name={profile} rec={profileRec} rows={rows} clients={clients} setClients={setClients} settings={settings} me={me} canEdit={canEdit} canExport={canExport} beneficiaries={beneficiaries} setBeneficiaries={setBeneficiaries} corridors={corridors} onOpenLedger={(n) => { setProfile(null); openLedgerForClient(n); }} onClose={() => { setProfile(null); setHighlightTx(null); }} log={log} highlightTx={highlightTx} /></Portal>}
      {adding && (window.CDOS.KYC && window.CDOS.KYC.NewContactFlow
        ? <window.CDOS.KYC.NewContactFlow by={me && me.name} setClients={setClients} onClose={() => setAdding(false)} onDone={(n) => { setAdding(false); setProfile(n); }} />
        : <Portal><NewContact existing={Object.keys(clients)} onCreate={createContact} onClose={() => setAdding(false)} /></Portal>)}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Clients });
})();
