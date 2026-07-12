/* ============================================================
   CurrencyDesk OS — New Transaction (guided, type-aware)
   A single counter flow that reshapes itself to the job: exchange,
   remittance, cheque, money order, bill payment. The right rail is a
   live "before you post" checklist + deal ticket, so a teller trained
   once just fills until everything turns green. Compliance (ID at $3k,
   LCTR at $10k, structuring, purpose/source capture) is part of the
   checklist, not an afterthought.
   Exposed as window.CDOS.TxModal — the Ledger prefers it when present.
   ============================================================ */
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const {
    CD, Ic, CCY, THRESHOLD, TODAY, crossRate, fmt, num, mkRef, nowTime, newTx,
    priceDeal, spreadOf, CommitBtn
  } = window.CDOS;

  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const ID_TYPES = ["Driver's Licence", 'Passport', 'Provincial ID', 'PR Card', 'Business Number'];
  const FLAG = { CAD: '🇨🇦', USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', INR: '🇮🇳', PHP: '🇵🇭', CNY: '🇨🇳', MXN: '🇲🇽', AED: '🇦🇪' };
  const ccyLabel = (c) => (FLAG[c] ? FLAG[c] + ' ' : '') + c;
  const CCY_NAME = { CAD: 'Canadian Dollar', USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', INR: 'Indian Rupee', PHP: 'Philippine Peso', CNY: 'Chinese Yuan', MXN: 'Mexican Peso', AED: 'UAE Dirham' };
  // mirror the staff-published rate-board order so this picker matches the board
  // (reorder currencies on the Rate Board and they reorder here too).
  function boardOrderedCCY() {
    try {
      const order = JSON.parse(localStorage.getItem('yorkfx_board_order') || 'null');
      if (Array.isArray(order) && order.length) {
        const rank = {}; order.forEach((c, i) => { rank[c] = i; });
        return [...CCY].sort((a, b) => (rank[a] != null ? rank[a] : 999) - (rank[b] != null ? rank[b] : 999));
      }
    } catch (e) {}
    return CCY;
  }
  // remittance destinations → payout currency
  const DEST = [
    { country: 'Philippines', ccy: 'PHP', flag: '🇵🇭' },
    { country: 'India', ccy: 'INR', flag: '🇮🇳' },
    { country: 'China', ccy: 'CNY', flag: '🇨🇳' },
    { country: 'Mexico', ccy: 'MXN', flag: '🇲🇽' },
    { country: 'UAE', ccy: 'AED', flag: '🇦🇪' },
    { country: 'United States', ccy: 'USD', flag: '🇺🇸' },
    { country: 'United Kingdom', ccy: 'GBP', flag: '🇬🇧' },
    { country: 'Eurozone', ccy: 'EUR', flag: '🇪🇺' },
  ];

  // the six jobs, each with its own identity
  const TYPE_META = {
    'Currency Exchange':   { icon: 'coins',    short: 'Exchange',     blurb: 'Buy or sell foreign cash over the counter.' },
    'Remittance — Send':   { icon: 'send',     short: 'Send money',   blurb: 'Send funds abroad to a beneficiary.' },
    'Remittance — Receive':{ icon: 'wallet',   short: 'Pay out',      blurb: 'Pay out an incoming transfer to a recipient.' },
    'Cheque Cashing':      { icon: 'receipt',  short: 'Cash cheque',  blurb: 'Cash a cheque, less fee, with a clearing hold.' },
    'Money Order':         { icon: 'card',     short: 'Money order',  blurb: 'Issue a money order to a named payee.' },
    'Bill Payment':        { icon: 'filetext', short: 'Pay a bill',   blurb: 'Take a payment on behalf of a biller.' },
  };
  const TYPE_LIST = Object.keys(TYPE_META);

  /* ---------- tiny shared bits ---------- */
  const inSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 9 };
  function Lbl({ children, hint }) {
    return <div className="flex items-center justify-between mb-1"><span className="text-[11px]" style={{ color: CD.mute }}>{children}</span>{hint && <span className="text-[10px]" style={{ color: CD.faint }}>{hint}</span>}</div>;
  }
  /* ---------- currency picker (custom dropdown, board-ordered) ----------
     Native <select> can't show a short code in the trigger but a code+name in
     the list, and renders flag emoji unreliably. This portals a styled menu so
     it never clips inside the scrolling form, and follows the rate-board order. */
  function CcyPicker({ value, onChange, disabled }) {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState(null);
    const btnRef = useRef(null);
    useEffect(() => {
      if (!open) return;
      const h = (e) => { if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false); };
      const sc = () => setOpen(false);
      document.addEventListener('mousedown', h); window.addEventListener('scroll', sc, true);
      return () => { document.removeEventListener('mousedown', h); window.removeEventListener('scroll', sc, true); };
    }, [open]);
    if (disabled) return <div className="px-3 grid place-items-center font-semibold text-sm flex-none" style={{ borderRight: `1px solid ${CD.line}`, background: 'var(--cd-chip)', color: CD.ink, minWidth: 64 }}>{value}</div>;
    const list = boardOrderedCCY();
    const toggle = () => { if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect()); setOpen(o => !o); };
    return (<>
      <button ref={btnRef} type="button" onClick={toggle} className="px-3 flex items-center gap-1.5 font-semibold text-sm flex-none" style={{ borderRight: `1px solid ${CD.line}`, background: 'var(--cd-chip)', color: CD.ink, minWidth: 64 }}>{value}<Ic n="chev" s={12} c={CD.mute} /></button>
      {open && rect && ReactDOM.createPortal(
        <div style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4, width: 224, maxHeight: 288, overflowY: 'auto', background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11, boxShadow: '0 16px 38px var(--cd-shade)', zIndex: 99998 }}>
          {list.map(c => { const on = c === value; return (
            <button key={c} type="button" onClick={() => { onChange(c); setOpen(false); }} className="w-full flex items-center justify-between px-3 py-2 text-left" style={{ background: on ? CD.lineSoft : 'transparent' }} onMouseEnter={e => { if (!on) e.currentTarget.style.background = CD.paper; }} onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
              <span className="flex items-baseline gap-2.5"><span className="font-semibold text-sm" style={{ color: CD.ink, width: 36, display: 'inline-block' }}>{c}</span><span className="text-[11.5px]" style={{ color: CD.mute }}>{CCY_NAME[c] || ''}</span></span>
              {on && <Ic n="check" s={14} c={CD.green} />}
            </button>); })}
        </div>, document.body)}
    </>);
  }

  /* ---------- ID/cheque scan: live camera OR upload (self-contained) ---------- */
  function ScanControl({ image, onCapture, onClear, title }) {
    const [cam, setCam] = useState(false);
    const [pick, setPick] = useState(false);
    const [err, setErr] = useState('');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const fileRef = useRef(null);
    const close = () => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } setCam(false); };
    const open = async () => {
      setErr(''); setCam(true);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        streamRef.current = s;
        const attach = () => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } else setTimeout(attach, 30); };
        attach();
      } catch (e) { setErr(e && e.name === 'NotAllowedError' ? 'Camera was blocked — allow it in your browser, or upload instead.' : 'No camera available — upload a photo instead.'); }
    };
    const capture = () => { const v = videoRef.current; if (!v || !v.videoWidth) return; const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); onCapture(cv.toDataURL('image/jpeg', 0.85)); close(); };
    const onFile = (f) => { if (!f) return; const r = new FileReader(); r.onload = () => onCapture(r.result); r.readAsDataURL(f); };
    useEffect(() => () => close(), []);
    if (image) return <div className="flex items-center gap-2 px-2 py-1.5" style={{ ...inSty }}><img src={image} alt="" style={{ height: 30, borderRadius: 4, border: `1px solid ${CD.line}` }} /><span className="text-[11px] flex-1" style={{ color: CD.green }}>Captured</span><button onClick={onClear} className="text-[11px]" style={{ color: CD.flag }}>Remove</button></div>;
    return (<>
      <button type="button" onClick={() => setPick(true)} className="w-full flex items-center justify-center gap-1.5 text-[12px] px-2 py-2 cursor-pointer" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 9 }}><Ic n="camera" s={14} c={CD.mute} /> Scan / upload</button>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { onFile(e.target.files[0]); setPick(false); }} />
      {pick && ReactDOM.createPortal(
        <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 100000 }} onMouseDown={() => setPick(false)}>
          <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 360, background: CD.paper, borderRadius: 14, border: `1px solid ${CD.ink}`, boxShadow: '0 24px 60px var(--cd-scrim)', overflow: 'hidden' }}>
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${CD.line}` }}><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{title || 'Add image'}</span><button onClick={() => setPick(false)} className="grid place-items-center" style={{ width: 26, height: 26, borderRadius: 7, color: CD.mute }}><Ic n="x" s={16} c={CD.mute} /></button></div>
            <div className="grid grid-cols-2 gap-2.5 p-4">
              <button type="button" onClick={() => { setPick(false); open(); }} className="flex flex-col items-center justify-center gap-2 py-6" style={{ border: `1.5px dashed ${CD.line}`, borderRadius: 12, background: CD.panel, cursor: 'pointer' }}><span className="grid place-items-center" style={{ width: 40, height: 40, borderRadius: 10, background: CD.lineSoft }}><Ic n="camera" s={18} c={CD.mute} /></span><span className="text-[12.5px] font-medium" style={{ color: CD.ink }}>Take a photo</span></button>
              <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="flex flex-col items-center justify-center gap-2 py-6" style={{ border: `1.5px dashed ${CD.line}`, borderRadius: 12, background: CD.panel, cursor: 'pointer' }}><span className="grid place-items-center" style={{ width: 40, height: 40, borderRadius: 10, background: CD.lineSoft }}><Ic n="upload" s={18} c={CD.mute} /></span><span className="text-[12.5px] font-medium" style={{ color: CD.ink }}>Choose a file</span></button>
            </div>
          </div>
        </div>, document.body)}
      {cam && ReactDOM.createPortal(
        <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 100000 }}>
          <div className="w-full flex flex-col" style={{ maxWidth: 520, background: 'var(--cd-ink)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 70px -20px rgba(0,0,0,0.7)' }}>
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}><div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--cd-on-ink)' }}><Ic n="camera" s={15} c="var(--cd-on-ink)" /> {title || 'Photograph it'}</div><button onClick={close} className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8, color: 'var(--cd-on-ink-soft)' }}><Ic n="x" s={16} c="var(--cd-on-ink-soft)" /></button></div>
            <div style={{ position: 'relative', background: 'var(--cd-ink-strong)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>{err ? <div className="text-center px-6" style={{ color: 'var(--cd-on-ink-soft)' }}><Ic n="alert" s={22} c="#e7b34a" /><div className="text-[13px] mt-2">{err}</div></div> : <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}{!err && <div style={{ position: 'absolute', inset: '18% 8%', border: '2px dashed var(--cd-on-ink-soft)', borderRadius: 12, pointerEvents: 'none' }} />}</div>
            <div className="flex items-center justify-center gap-3 px-4 py-4">{err ? <button onClick={close} className="px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}>Close</button> : <><button onClick={close} className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--cd-on-ink-soft)', border: '1px solid var(--cd-on-ink-faint)', borderRadius: 9 }}>Cancel</button><button onClick={capture} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cd-ink)', display: 'inline-block' }} /> Capture</button></>}</div>
          </div>
        </div>, document.body)}
    </>);
  }

  function Money({ value, onChange, ccy, onCcy, big, readOnly, accent, autoFocus }) {
    return (
      <div className="flex items-stretch" style={{ border: `1px solid ${readOnly ? CD.line : CD.ink}`, borderRadius: 9, overflow: 'hidden', background: readOnly ? 'var(--cd-paper-soft)' : 'var(--cd-panel)' }}>
        <CcyPicker value={ccy} onChange={onCcy} disabled={!onCcy} />
        {readOnly
          ? <div className="flex-1 min-w-0 px-3 py-2.5 font-semibold text-right" style={{ fontVariantNumeric: 'tabular-nums', color: accent || CD.ink, fontSize: big ? 22 : 16 }}>{value}</div>
          : <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" autoFocus={autoFocus} placeholder="0.00" className="flex-1 min-w-0 px-3 py-2.5 font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums', fontSize: big ? 22 : 16 }} />}
      </div>
    );
  }

  /* ---------- customer combobox (search / add with inline KYC) ---------- */
  function CustomerPicker({ label, hint, value, query, setQuery, onPick, names, clients, onAddNew, onClear, idRequired }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef(null);
    useEffect(() => { const h = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
    const shown = names.filter(n => n.toLowerCase().includes((query || '').toLowerCase()));
    return (
      <div>
        <Lbl hint={hint}>{label}</Lbl>
        <div ref={wrap} className="relative">
          <div className="flex items-center gap-2 px-2.5 py-2" style={inSty}>
            <Ic n="search" s={15} c={CD.mute} />
            <input value={query} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); }} placeholder="Type a name…" className="w-full outline-none text-sm bg-transparent" />
            {query && <button onClick={() => { onClear(); setOpen(false); }}><Ic n="x" s={14} c={CD.mute} /></button>}
          </div>
          {open && (
            <div className="absolute left-0 right-0 mt-1 py-1 max-h-52 overflow-auto" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10, boxShadow: '0 12px 30px var(--cd-shade)', zIndex: 30 }}>
              {shown.map(n => { const c = clients[n] || {}; const ver = (() => { try { return ((window.CDOS.KYC && window.CDOS.KYC.checksFor(n)) || []).some(k => (k.template === 'verify' || k.template === 'plus') && k.status === 'completed' && k.result && k.result.decision === 'approved'); } catch (e) { return false; } })(); const st = (!c.idType) ? 'missing ID' : (c.idExpiry && c.idExpiry < TODAY ? 'ID expired' : ver ? 'verified' : 'ID on file'); const ok = st === 'verified'; const onfile = st === 'ID on file'; return (
                <button key={n} onMouseDown={e => e.preventDefault()} onClick={() => { onPick(n); setOpen(false); }} className="w-full flex items-center justify-between px-3 py-2 text-left text-sm" style={{ color: CD.ink }}>
                  <span>{n}</span><span className="text-[10px] px-1.5 py-0.5" style={{ borderRadius: 4, background: ok ? CD.greenSoft : onfile ? CD.amberSoft : CD.flagSoft, color: ok ? CD.green : onfile ? CD.amber : CD.flag }}>{st}</span>
                </button>); })}
              {shown.length === 0 && <div className="px-3 py-2 text-[11px]" style={{ color: CD.faint }}>No match.</div>}
              <button onMouseDown={e => e.preventDefault()} onClick={() => { onAddNew(); setOpen(false); }} className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium" style={{ color: CD.ink, borderTop: `1px solid ${CD.lineSoft}` }}><Ic n="userplus" s={15} /> {idRequired ? 'Scan ID & add new client' : 'Add new client'}{query ? ` “${query.trim()}”` : ''}</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- known-customer snapshot ---------- */
  function CustomerCard({ name, rec, live, settings }) {
    const s = useMemo(() => {
      const h = live.filter(r => r.customer === name);
      const cadOf = (a, c) => c === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', c) || 1);
      const winDays = (settings && settings.structuringDays) || 30;
      const cutoff = new Date(Date.now() - winDays * 86400000).toISOString().slice(0, 10);
      let total = 0, windowCad = 0; const cc = {};
      h.forEach(r => { const cad = cadOf(r.inAmt, r.inCcy); total += cad; if (r.date >= cutoff) windowCad += cad; const c = (r.outCcy && r.outCcy !== 'CAD') ? r.outCcy : (r.inCcy !== 'CAD' ? r.inCcy : null); if (c) cc[c] = (cc[c] || 0) + 1; });
      const last = h.reduce((m, r) => r.date > m ? r.date : m, '');
      const days = last ? Math.round((Date.parse(TODAY) - Date.parse(last)) / 86400000) : null;
      return { count: h.length, total, windowCad, winDays, days, top: Object.keys(cc).sort((a, b) => cc[b] - cc[a])[0] || null };
    }, [name, live, settings]);
    const idMissing = !rec || !rec.idType || !rec.idNum;
    const idExpired = rec && rec.idExpiry && rec.idExpiry < TODAY;
    const idOk = !idMissing && !idExpired;
    // green ONLY after a real provider verification (Verified / Verified Plus).
    // A typed / scanned ID with no KYC is amber “ID on file” — present, not verified.
    const verified = (() => { try { const ch = (window.CDOS.KYC && window.CDOS.KYC.checksFor(name)) || []; return ch.some(c => (c.template === 'verify' || c.template === 'plus') && c.status === 'completed' && c.result && c.result.decision === 'approved'); } catch (e) { return false; } })();
    const badge = idMissing ? { t: 'No ID', c: CD.flag, bg: CD.flagSoft, ic: 'alert' }
      : idExpired ? { t: 'ID expired', c: CD.flag, bg: CD.flagSoft, ic: 'alert' }
      : verified ? { t: 'ID verified', c: CD.green, bg: CD.greenSoft, ic: 'checkcircle' }
      : { t: 'ID on file', c: CD.amber, bg: CD.amberSoft, ic: 'id' };
    const initials = name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const over = s.windowCad >= THRESHOLD, near = !over && s.windowCad >= THRESHOLD * 0.7;
    const lastLbl = s.days == null ? 'First visit' : s.days === 0 ? 'In today already' : s.days === 1 ? 'Yesterday' : `${s.days} days ago`;
    return (
      <div className="mt-2 overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 11, background: 'var(--cd-panel)' }}>
        <div className="flex items-center gap-3 px-3.5 py-2.5" style={{ background: CD.lineSoft, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none font-semibold" style={{ width: 34, height: 34, borderRadius: 9, background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 13 }}>{initials}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2"><span className="font-semibold truncate" style={{ color: CD.ink }}>{name}</span>{s.count >= 3 && <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 flex-none" style={{ background: CD.amberSoft, color: 'var(--cd-brass-text)', borderRadius: 999, fontWeight: 600 }}><Ic n="star" s={10} c="var(--cd-brass-text)" /> Regular</span>}</div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{s.count > 0 ? `${s.count} deal${s.count !== 1 ? 's' : ''} · ${lastLbl}` : 'No prior deals here'}</div>
          </div>
          <span className="flex items-center gap-1 text-[11px] px-2 py-1 flex-none font-medium" style={{ background: badge.bg, color: badge.c, borderRadius: 999 }}><Ic n={badge.ic} s={12} c={badge.c} /> {badge.t}</span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <CCstat label="ID on file" value={idMissing ? '—' : (rec.idType || 'ID')} sub={idMissing ? 'collect below' : (rec.idExpiry ? `exp ${rec.idExpiry}` : 'on file')} tone={idOk ? CD.ink : CD.flag} />
          <CCstat label={`Last ${s.winDays}d`} value={fmt(s.windowCad, 'CAD')} sub={over ? 'over the line' : near ? 'nearing line' : 'within range'} tone={over ? CD.flag : near ? CD.amber : CD.ink} divider />
          <CCstat label="Usually" value={s.top || '—'} sub={s.count > 0 ? `${fmt(s.total, 'CAD')} lifetime` : 'new'} tone={CD.ink} divider />
        </div>
      </div>
    );
  }
  function CCstat({ label, value, sub, tone, divider }) {
    return (<div className="px-3 py-2.5" style={{ borderLeft: divider ? `1px solid ${CD.lineSoft}` : 'none' }}>
      <div className="text-[9.5px] uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
      <div className="text-[13px] font-semibold leading-tight mt-0.5 truncate" style={{ color: tone || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[9.5px] mt-0.5 truncate" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }

  /* ---------- present-to-customer fullscreen quote ---------- */
  function PresentQuote({ q, onClose }) {
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
    return ReactDOM.createPortal(
      <div className="fixed inset-0" style={{ zIndex: 99999, background: CD.ink, display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center justify-between px-10 pt-8 pb-4" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}>
          <div><div style={{ fontFamily: 'Space Mono, monospace', fontSize: 13, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--cd-on-ink-soft)' }}>{q.biz}</div><div style={{ fontWeight: 800, fontSize: 30, color: 'var(--cd-on-ink)', letterSpacing: '-0.02em', marginTop: 4 }}>{q.title}</div></div>
          <span className="px-3 py-1.5" style={{ fontFamily: 'Space Mono, monospace', fontSize: 13, color: 'var(--cd-on-ink)', background: 'var(--cd-on-ink-faint)', borderRadius: 999 }}>{q.tag}</span>
        </div>
        <div className="flex-1 flex flex-col justify-center" style={{ gap: 30, padding: '24px 10vw' }}>
          <div><div style={{ fontSize: 17, color: 'var(--cd-on-ink-soft)' }}>{q.giveLbl}</div><div style={{ fontWeight: 800, fontSize: 'clamp(46px, 8.5vw, 92px)', letterSpacing: '-0.02em', color: 'var(--cd-on-ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.02 }}>{q.give}</div></div>
          {q.rateLine && <div className="flex items-center gap-4" style={{ color: 'var(--cd-on-ink-soft)' }}><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span><span style={{ fontFamily: 'Space Mono, monospace', fontSize: 16 }}>{q.rateLine}</span><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span></div>}
          <div><div style={{ fontSize: 17, color: 'var(--cd-on-ink-soft)' }}>{q.getLbl}</div><div style={{ fontWeight: 800, fontSize: 'clamp(46px, 8.5vw, 92px)', letterSpacing: '-0.02em', color: '#7fd1a3', fontVariantNumeric: 'tabular-nums', lineHeight: 1.02 }}>{q.get}</div></div>
        </div>
        <div className="flex items-center justify-between px-10 py-6" style={{ borderTop: '1px solid var(--cd-on-ink-faint)', background: 'var(--cd-ink-strong)' }}>
          <span style={{ color: 'var(--cd-on-ink-soft)', fontSize: 14 }}>{q.foot}</span>
          <button onClick={onClose} className="flex items-center gap-2 px-5 py-2.5 font-semibold" style={{ background: 'var(--cd-panel)', color: CD.ink, borderRadius: 10 }}><Ic n="arrowleft" s={16} c={CD.ink} /> Back to desk</button>
        </div>
      </div>, document.body);
  }

  /* ---------- checklist row ---------- */
  function Check({ ok, warn, label, sub }) {
    const tone = ok ? CD.green : warn ? CD.amber : CD.faint;
    const ic = ok ? 'checkcircle' : warn ? 'alert' : 'circle';
    return (
      <div className="flex items-start gap-2 py-1.5">
        <span className="flex-none grid place-items-center" style={{ width: 18, height: 18, borderRadius: '50%', border: ok ? 'none' : `1.5px solid ${warn ? CD.amber : CD.line}`, background: ok ? CD.green : 'transparent', marginTop: 1 }}>
          {ok ? <Ic n="check" s={11} c="var(--cd-on-ink)" /> : warn ? <Ic n="alert" s={11} c={CD.amber} /> : null}
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] leading-tight" style={{ color: ok ? CD.ink : warn ? 'var(--cd-brass-text)' : CD.mute, fontWeight: ok ? 500 : 400 }}>{label}</div>
          {sub && <div className="text-[11px] mt-0.5 leading-snug" style={{ color: warn ? CD.amber : CD.faint }}>{sub}</div>}
        </div>
      </div>
    );
  }

  /* =====================================================================
     MAIN
  ===================================================================== */
  function TxModal({ rows, clients, setClients, setRows, settings, me, log, onClose, onDone, prefillClient, rateVersion, cheques, setCheques, chequeSchedule, onOpenCheques }) {
    const live = useMemo(() => rows.filter(r => r.status !== 'void'), [rows]);
    const names = useMemo(() => { const s = new Set(Object.keys(clients)); live.forEach(r => r.customer && s.add(r.customer)); return Array.from(s).sort(); }, [clients, live]);

    const [type, setType] = useState('Currency Exchange');
    const meta = TYPE_META[type];

    // customer
    const [customer, setCustomer] = useState(prefillClient || '');
    const [query, setQuery] = useState(prefillClient || '');
    const [addFlow, setAddFlow] = useState(false);   // launches the KYC scan-ID walk-through
    const [quickChk, setQuickChk] = useState(null);   // tier string → opens the SendModal chooser

    // exchange
    const [inCcy, setInCcy] = useState('CAD');
    const [outCcy, setOutCcy] = useState('USD');
    const [inAmt, setInAmt] = useState('');
    const [override, setOverride] = useState(false);
    const [manualRate, setManualRate] = useState('');
    const [lock, setLock] = useState(null);
    const [nowMs, setNowMs] = useState(Date.now());
    const [fee, setFee] = useState(settings && settings.defaultFee != null ? String(settings.defaultFee) : '');

    // remittance
    const [dest, setDest] = useState(DEST[0]);
    const [benName, setBenName] = useState('');
    const [purpose, setPurpose] = useState('');
    const [recvRef, setRecvRef] = useState('');   // remittance-receive tracking ref

    // cheque
    const [chequeNumber, setChequeNumber] = useState('');
    const [maker, setMaker] = useState('');
    const [draweeBank, setDraweeBank] = useState('');
    const [chequeTypeId, setChequeTypeId] = useState('payroll');
    const [chequeImage, setChequeImage] = useState(null);
    const [endorsed, setEndorsed] = useState(false);

    // money order / bill
    const [payee, setPayee] = useState('');
    const [biller, setBiller] = useState('');
    const [account, setAccount] = useState('');

    // compliance capture + margin override
    const [cap, setCap] = useState({ source: '', thirdParty: false, thirdPartyName: '' });
    const [marginAck, setMarginAck] = useState(false);
    const [marginReason, setMarginReason] = useState('');
    const [memo, setMemo] = useState('');
    const [present, setPresent] = useState(false);

    useEffect(() => { const h = (e) => { if (e.key === 'Escape' && !present) onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose, present]);
    useEffect(() => { if (!lock) return; const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, [lock]);

    const amtN = parseFloat(inAmt) || 0;
    const isExchange = type === 'Currency Exchange';
    const isSend = type === 'Remittance — Send';
    const isReceive = type === 'Remittance — Receive';
    const isCheque = type === 'Cheque Cashing';
    const isMO = type === 'Money Order';
    const isBill = type === 'Bill Payment';

    // remittance send: customer pays CAD, beneficiary gets payout ccy
    const payoutCcy = isSend ? dest.ccy : outCcy;
    const lockLive = lock && lock.until > nowMs ? lock : null;
    useEffect(() => { if (lock && lock.until <= nowMs) setLock(null); }, [nowMs, lock]);

    // pricing: exchange uses both legs; send uses CAD→payout; receive/mo/bill are face-value
    const priceArgs = isExchange
      ? { inCcy, outCcy, inAmt: amtN, settings, lockedRate: lockLive && !override ? lockLive.rate : null, overrideRate: override && manualRate !== '' ? manualRate : null }
      : isSend ? { inCcy: 'CAD', outCcy: payoutCcy, inAmt: amtN, settings, lockedRate: null, overrideRate: null }
      : null;
    const pricing = useMemo(() => priceArgs ? priceDeal(priceArgs) : { rate: 1, outAmt: amtN, midRate: null, marginCad: 0, side: null, midCadIn: amtN, deskRate: 1, outAmtRaw: amtN }, [JSON.stringify(priceArgs), rateVersion]);
    const rateN = pricing.rate;

    // cheque fee/hold from shared schedule
    const _K = window.CDOS._cheques;
    const chequeSched = chequeSchedule || (_K ? _K.defaultSchedule() : []);
    const chequeType = chequeSched.find(t => t.id === chequeTypeId) || chequeSched[0] || { feePct: 0, feeMin: 0, holdDays: 0, label: 'Cheque' };
    const chequeFee = isCheque && _K ? +_K.feeFor(amtN, chequeType).toFixed(2) : (parseFloat(fee) || 0);

    // what the customer receives / what we collect, per type
    const feeN = parseFloat(fee) || 0;
    const out = isExchange ? { amt: pricing.outAmt, ccy: outCcy }
      : isSend ? { amt: pricing.outAmt, ccy: payoutCcy }
      : isCheque ? { amt: +(amtN - chequeFee).toFixed(2), ccy: 'CAD' }
      : isReceive ? { amt: amtN, ccy: outCcy }
      : { amt: amtN, ccy: 'CAD' };   // MO / Bill: face value out

    // CAD-equivalent of the cash the customer hands over (threshold basis)
    const collectCad = isExchange ? (inCcy === 'CAD' ? amtN : amtN / (crossRate('CAD', inCcy) || 1))
      : (isMO || isBill) ? amtN + feeN
      : isCheque ? amtN
      : amtN; // send/receive amounts are in CAD or treated as CAD-equiv
    const inCadEquiv = isExchange ? (inCcy === 'CAD' ? amtN : amtN / (crossRate('CAD', inCcy) || 1)) : amtN;

    // margin (exchange + send carry FX spread; others are fee-only)
    const spreadCadLive = (isExchange || isSend) ? (pricing.marginCad || 0) : 0;
    const profitCad = +(spreadCadLive + (isCheque ? chequeFee : feeN)).toFixed(2);
    const marginBasis = (isExchange || isSend) ? (pricing.midCadIn || 0) : inCadEquiv;
    const marginPct = marginBasis > 0 ? (profitCad / marginBasis) * 100 : 0;
    const mFloor = settings && settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const mTarget = settings && settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const mEnforce = (settings && settings.marginEnforce) || 'block';
    const belowFloor = amtN > 0 && (isExchange || isSend) && marginPct < mFloor;
    const needOverride = belowFloor && mEnforce === 'block';

    // ---- compliance ----
    // resolve the live regime pack FIRST — the reportable threshold and ID-required
    // floor must come from settings (via getRegime), not the bare fallback constants,
    // so this screen never drifts from the Ledger/Compliance desk when the owner
    // tunes them in Settings → Compliance & jurisdiction.
    const regime = window.CDOS.getRegime ? window.CDOS.getRegime(settings) : { largeCode: 'LCTR', threshold: THRESHOLD, idAt: 3000 };
    const TH = regime.threshold || THRESHOLD;
    const idFloor = regime.idAt || 3000;
    const rec = clients[customer];
    const kyc = (!rec || !rec.idType || !rec.idNum) ? 'missing' : (rec.idExpiry && rec.idExpiry < TODAY ? 'expired' : 'ok');
    const single = inCadEquiv >= TH;
    const idRequired = single || inCadEquiv >= idFloor || isSend;   // remittance always needs sender ID
    const idOk = kyc === 'ok';
    const recentTotal = useMemo(() => {
      if (!customer) return 0;
      return live.filter(o => o.customer === customer).reduce((s, o) => s + (o.inCcy === 'CAD' ? (+o.inAmt || 0) : (+o.inAmt || 0) / (crossRate('CAD', o.inCcy) || 1)), 0) + inCadEquiv;
    }, [customer, live, inCadEquiv]);
    const structuring = !single && customer && recentTotal >= TH;

    // ---- per-type requirement checklist (the "make it green" list) ----
    const reqs = [];
    reqs.push({ key: 'amt', ok: amtN > 0, label: isCheque ? 'Cheque amount entered' : 'Amount entered' });
    if (isSend) {
      reqs.push({ key: 'ben', ok: !!benName.trim(), label: 'Beneficiary name' });
      reqs.push({ key: 'dest', ok: !!dest, label: `Destination — ${dest.flag} ${dest.country}` });
    }
    if (isReceive) reqs.push({ key: 'ref', ok: !!recvRef.trim(), label: 'Transfer / tracking reference' });
    if (isCheque) { reqs.push({ key: 'cn', ok: !!chequeNumber.trim(), label: 'Cheque number' }); reqs.push({ key: 'mk', ok: !!maker.trim(), label: 'Maker (who wrote it)' }); reqs.push({ key: 'img', ok: !!chequeImage, soft: true, warn: !chequeImage, label: 'Cheque image on file', sub: !chequeImage ? 'Scan the cheque so it can be cleared / followed up (recommended)' : null }); }
    if (isMO) reqs.push({ key: 'payee', ok: !!payee.trim(), label: 'Payee name' });
    if (isBill) { reqs.push({ key: 'biller', ok: !!biller.trim(), label: 'Biller' }); reqs.push({ key: 'acct', ok: !!account.trim(), label: 'Account number' }); }
    // identity
    const custLabel = isSend ? 'Sender' : isReceive ? 'Recipient' : isMO ? 'Purchaser' : isBill ? 'Payer' : 'Customer';
    if (idRequired) reqs.push({ key: 'id', ok: !!customer && idOk, warn: !!customer && !idOk, label: `${custLabel} identified`, sub: !customer ? `ID required ${single ? `over ${fmt(TH, 'CAD')}` : isSend ? 'for remittance' : 'over ' + fmt(idFloor, 'CAD')} — search or add them` : !idOk ? `Their ID is ${kyc} — fix on the client file` : null });
    else reqs.push({ key: 'cust', ok: !!customer.trim(), label: customer.trim() ? `${custLabel}: ${customer}` : `${custLabel} name`, sub: !customer.trim() ? 'A name is required — ID not needed at this amount, but capture who this is' : 'No ID needed at this amount' });
    // reportable capture
    if (single) {
      const capOk = purpose.trim() && cap.source.trim() && (!cap.thirdParty || cap.thirdPartyName.trim());
      reqs.push({ key: 'cap', ok: capOk, warn: !capOk, label: `${regime.largeCode} details captured`, sub: !capOk ? 'Purpose, source of funds & third-party — fill below' : 'Pre-fills the filing in Compliance' });
    }
    if (needOverride) reqs.push({ key: 'mgn', ok: marginAck && marginReason.trim(), warn: true, label: 'Below-floor margin — needs a reason', sub: marginAck && marginReason.trim() ? null : 'Acknowledge & give a reason below' });

    const hardReqs = reqs.filter(r => !r.soft);
    const allGreen = hardReqs.every(r => r.ok);
    const canSave = amtN > 0 && allGreen;
    const remaining = hardReqs.filter(r => !r.ok).length;

    // ---- actions ----
    const resetPricing = () => { setLock(null); setOverride(false); setManualRate(''); };
    const swap = () => { setInCcy(outCcy); setOutCcy(inCcy); resetPricing(); };
    const lockRate = () => { const mins = (settings && settings.rateLockMins) || 15; setOverride(false); setManualRate(''); setLock({ rate: pricing.deskRate, until: Date.now() + mins * 60000, ref: 'Q-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(live.filter(r => r.date === TODAY).length + 1).padStart(3, '0'), mins }); };
    const lockSecs = lockLive ? Math.max(0, Math.round((lockLive.until - nowMs) / 1000)) : 0;
    const lockClock = `${Math.floor(lockSecs / 60)}:${String(lockSecs % 60).padStart(2, '0')}`;

    const onPick = (n) => { setCustomer(n); setQuery(n); };
    const onAddNew = () => setAddFlow(true);
    const onClear = () => { setQuery(''); setCustomer(''); };

    const record = () => {
      if (!canSave) return;
      const seq = live.filter(r => r.date === TODAY).length + 1;
      const ref = mkRef(TODAY, seq);
      const base = { ref, type, customer: customer || 'Walk-in (no client)', teller: me.name, createdBy: me.name, createdAt: stamp(),
        capture: single ? { purpose: purpose.trim(), source: cap.source.trim(), thirdParty: cap.thirdParty, thirdPartyName: cap.thirdPartyName.trim(), by: me.name, at: stamp() } : null,
        marginOverride: needOverride ? { by: me.name, at: stamp(), pct: +marginPct.toFixed(2), reason: marginReason.trim() } : null,
        thread: memo ? [{ ts: stamp(), user: me.name, text: memo }] : [], notes: memo };
      let tx;
      if (isExchange) {
        tx = newTx({ ...base, inCcy, inAmt: amtN, rate: rateN, outCcy, outAmt: pricing.outAmt, fee: feeN, midRate: pricing.midRate, spreadCad: pricing.marginCad, side: pricing.side, priced: override ? 'override' : (lockLive ? 'locked' : 'desk'), quoteRef: lockLive ? lockLive.ref : null, marginPct: +marginPct.toFixed(2), profitCad, lockedUntil: lockLive ? new Date(lockLive.until).toLocaleString('en-CA', { hour12: false }).replace(',', '') : null });
      } else if (isSend) {
        tx = newTx({ ...base, beneficiary: `${benName.trim()} · ${dest.country}`, inCcy: 'CAD', inAmt: amtN, rate: rateN, outCcy: payoutCcy, outAmt: pricing.outAmt, fee: feeN, midRate: pricing.midRate, spreadCad: pricing.marginCad, side: pricing.side, marginPct: +marginPct.toFixed(2), profitCad, notes: purpose || memo });
      } else if (isReceive) {
        tx = newTx({ ...base, inCcy: outCcy, inAmt: amtN, rate: 1, outCcy, outAmt: amtN, fee: feeN, profitCad, notes: `Ref ${recvRef.trim()}${memo ? ' · ' + memo : ''}` });
      } else if (isCheque) {
        tx = newTx({ ...base, inCcy: 'CAD', inAmt: amtN, rate: 1, outCcy: 'CAD', outAmt: +(amtN - chequeFee).toFixed(2), fee: chequeFee, profitCad: chequeFee, notes: `${chequeType.label} cheque #${chequeNumber.trim()}${memo ? ' · ' + memo : ''}` });
      } else if (isMO) {
        tx = newTx({ ...base, beneficiary: payee.trim(), inCcy: 'CAD', inAmt: amtN, rate: 1, outCcy: 'CAD', outAmt: amtN, fee: feeN, profitCad: feeN, notes: `Money order to ${payee.trim()}${memo ? ' · ' + memo : ''}` });
      } else { // bill
        tx = newTx({ ...base, beneficiary: biller.trim(), inCcy: 'CAD', inAmt: amtN, rate: 1, outCcy: 'CAD', outAmt: amtN, fee: feeN, profitCad: feeN, notes: `Bill: ${biller.trim()} · acct ${account.trim()}${memo ? ' · ' + memo : ''}` });
      }
      // house auto-tag rules (Settings → Tagged) — applied once, as the deal posts
      const _atOver = +((settings || {}).autoTagOver) > 0 && collectCad >= +settings.autoTagOver;
      const _atRiskLvl = (window.CDOS && window.CDOS.normalizeRisk) ? window.CDOS.normalizeRisk(rec && (rec.risk || rec.riskRating)) : (/enhanced|high/i.test(String((rec && (rec.risk || rec.riskRating)) || '')) ? 'High' : 'Normal');
      const _atRisk = !!(settings || {}).autoTagRisk && rec && (_atRiskLvl === 'Medium' || _atRiskLvl === 'High');
      const _atNew = !!(settings || {}).autoTagNew && customer && !live.some(o => o.customer === customer);
      if (_atOver || _atRisk || _atNew) {
        tx.tagged = true;
        tx.tagInfo = { by: 'Auto-rule', at: stamp(), note: _atOver ? `Auto-tagged: at/over ${fmt(+settings.autoTagOver, 'CAD')}` : _atRisk ? `Auto-tagged: ${rec.risk || 'risk'} risk client` : 'Auto-tagged: first deal for a new client' };
      }
      setRows(r => [tx, ...r]);
      if (isCheque && setCheques && _K) {
        const net = +(amtN - chequeFee).toFixed(2);
        const holdUntil = _K.addDays(TODAY, chequeType.holdDays || 0);
        const seqC = (cheques || []).filter(c => c.receivedDate === TODAY).length + 1;
        const cref = 'CHQ-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seqC).padStart(3, '0');
        setCheques(listv => [{ id: 'c' + Date.now(), ref: cref, chequeNumber: chequeNumber.trim(), maker: maker.trim(), draweeBank: draweeBank.trim(), customer: customer || 'Walk-in (no client)', typeId: chequeType.id, typeLabel: chequeType.label, ccy: 'CAD', amount: amtN, feeCad: chequeFee, netCad: net, endorsed: endorsed, image: chequeImage, holdDays: chequeType.holdDays || 0, receivedDate: TODAY, holdUntil, status: 'held', nsf: false, fraud: false, timeline: [{ status: 'held', ts: stamp(), by: me.name, note: `Cashed at the till · ${(chequeType.holdDays || 0) === 0 ? 'no hold' : chequeType.holdDays + '-day hold'}${chequeImage ? ' · image on file' : ''}` }], txId: tx.id, txRef: ref, createdBy: me.name }, ...(listv || [])]);
      }
      log('Transaction recorded', `${ref} · ${meta.short} · ${customer || 'walk-in'} · ${num(amtN)} ${isExchange ? inCcy : 'CAD'}${single ? ' · REPORTABLE' : ''}${needOverride ? ' · below-floor' : ''}`);
      onDone && onDone(tx.id);
    };

    // present-quote payload (exchange + send)
    const presentQ = isSend
      ? { biz: (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk', title: 'Send money', tag: `${dest.flag} ${dest.country}`, giveLbl: 'You pay', give: `${num(amtN)} CAD`, rateLine: `1 CAD = ${num(rateN)} ${payoutCcy}`, getLbl: `${benName || 'Beneficiary'} receives`, get: `${num(out.amt)} ${payoutCcy}`, foot: feeN > 0 ? `Includes ${fmt(feeN, 'CAD')} fee` : 'No service fee' }
      : { biz: (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk', title: 'Your quote', tag: pricing.side === 'buy' ? `We buy ${inCcy}` : pricing.side === 'sell' ? `We sell ${outCcy}` : `${inCcy} → ${outCcy}`, giveLbl: 'You give', give: `${num(amtN)} ${inCcy}`, rateLine: `1 ${inCcy} = ${num(rateN)} ${outCcy}`, getLbl: 'You receive', get: `${num(out.amt)} ${outCcy}`, foot: feeN > 0 ? `Includes ${fmt(feeN, 'CAD')} service fee` : (lockLive ? `Rate held ${lockClock}` : 'Rate as quoted now') };

    /* ---------------- render ---------------- */
    return ReactDOM.createPortal((
      <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: (addFlow || quickChk) ? 8000 : 9200 }} onMouseDown={(addFlow || quickChk) ? undefined : onClose}>
        <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 940, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 16, boxShadow: '0 24px 70px var(--cd-scrim)', overflow: 'hidden' }}>
          {/* header */}
          <div className="flex-none flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 32, height: 32, background: CD.ink, borderRadius: 9 }}><Ic n={meta.icon} s={17} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>New transaction</div><div className="text-[11px]" style={{ color: CD.mute }}>{meta.short} · {me.name} · {TODAY}</div></div></div>
            <button onClick={onClose} className="p-1.5" style={{ borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
          </div>

          {/* type selector */}
          <div className="flex-none px-5 pt-3.5 pb-3" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
              {TYPE_LIST.map(t => { const on = type === t; const m = TYPE_META[t]; return (
                <button key={t} onClick={() => setType(t)} className="flex flex-col items-center gap-1.5 py-2.5 px-1" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 10, transition: 'all .12s' }}>
                  <Ic n={m.icon} s={18} c={on ? 'var(--cd-on-ink)' : CD.mute} />
                  <span className="text-[11px] font-medium leading-tight text-center" style={{ color: on ? 'var(--cd-on-ink)' : CD.ink }}>{m.short}</span>
                </button>); })}
            </div>
            <div className="text-[12px] mt-2.5 flex items-center gap-1.5" style={{ color: CD.mute }}><Ic n={meta.icon} s={13} c={CD.mute} /> {meta.blurb}</div>
          </div>

          {/* body: form | rail */}
          <div className="flex-1 min-h-0 flex">
            {/* LEFT — the form */}
            <div className="flex-1 min-w-0 overflow-auto px-5 py-4 space-y-4" style={{ borderRight: `1px solid ${CD.line}` }}>
              {/* customer (sender/purchaser/payer) */}
              <CustomerPicker label={custLabel} hint={idRequired ? 'ID required' : 'optional'} value={customer} query={query} setQuery={(v) => { setQuery(v); setCustomer(v); }} onPick={onPick} names={names} clients={clients} onAddNew={onAddNew} onClear={onClear} idRequired={idRequired} />
              {customer && clients[customer] && <CustomerCard name={customer} rec={clients[customer]} live={live} settings={settings} />}
              {customer && clients[customer] && window.CDOS.KYC && window.CDOS.KYC.VerificationNudge &&
                React.createElement(window.CDOS.KYC.VerificationNudge, { key: customer + ':' + (inCadEquiv >= TH) + ':' + idRequired, name: customer, rec: clients[customer], settings, amountCad: inCadEquiv, idRequired: idRequired && kyc !== 'ok', onRun: (tpl) => setQuickChk(tpl) })}

              {/* ---------------- EXCHANGE ---------------- */}
              {isExchange && (
                <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <Lbl>Customer pays in</Lbl>
                  <Money value={inAmt} onChange={setInAmt} ccy={inCcy} onCcy={(v) => { setInCcy(v); resetPricing(); }} big autoFocus />
                  <div className="flex items-center justify-center gap-2 py-2">
                    <span className="text-[10px] px-2 py-0.5 font-semibold uppercase tracking-wide" style={{ borderRadius: 5, background: pricing.side === 'buy' ? CD.flagSoft : pricing.side === 'sell' ? CD.greenSoft : CD.lineSoft, color: pricing.side === 'buy' ? CD.flag : pricing.side === 'sell' ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>{pricing.side === 'buy' ? `We buy ${inCcy}` : pricing.side === 'sell' ? `We sell ${outCcy}` : 'Cross'}</span>
                    <span className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>1 {inCcy} = {rateN ? num(rateN) : '—'} {outCcy}</span>
                    <button onClick={swap} title="Swap" className="p-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7 }}><Ic n="swap" s={13} c={CD.mute} /></button>
                  </div>
                  <Lbl>Customer receives</Lbl>
                  <Money value={out.amt ? num(out.amt) : '—'} ccy={outCcy} onCcy={(v) => { setOutCcy(v); resetPricing(); }} readOnly accent={CD.green} big />
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <div><Lbl hint={override ? 'hand-priced' : lockLive ? 'locked' : 'tap to edit'}>Rate</Lbl><div className="flex items-center" style={{ ...inSty, borderColor: lockLive && !override ? CD.amber : override ? CD.ink : CD.line }}><input value={override ? manualRate : num(rateN)} onFocus={() => { if (!override && !lockLive) { setManualRate(num(pricing.deskRate)); setOverride(true); } }} onChange={e => { setLock(null); setOverride(true); setManualRate(e.target.value); }} inputMode="decimal" title="Type to hand-price this deal" className="w-full text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink, cursor: 'text' }} />{lockLive && !override && <span className="px-1.5 flex-none flex items-center gap-1 text-[10px]" style={{ color: CD.amber, fontFamily: 'Space Mono, monospace' }}><Ic n="lock" s={11} c={CD.amber} />{lockClock}</span>}</div></div>
                    <div><Lbl>Fee (CAD)</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  </div>
                  <div className="flex items-center justify-end gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                    {lockLive ? <button onClick={() => setLock(null)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.amber}`, color: CD.amber, borderRadius: 7 }}><Ic n="lock" s={12} c={CD.amber} /> Unlock</button>
                      : <button onClick={lockRate} disabled={!(rateN > 0) || override} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, color: (rateN > 0 && !override) ? CD.ink : CD.faint, borderRadius: 7 }}><Ic n="lock" s={12} /> Lock rate</button>}
                    <button onClick={() => { if (override) { setOverride(false); setManualRate(''); } else { setManualRate(num(pricing.deskRate)); setOverride(true); setLock(null); } }} title={override ? 'Back to the desk rate' : 'Hand-price this deal'} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${override ? CD.ink : CD.line}`, background: override ? CD.ink : 'transparent', color: override ? 'var(--cd-on-ink)' : CD.ink, borderRadius: 7 }}><Ic n="pencil" s={11} c={override ? 'var(--cd-on-ink)' : CD.ink} /> {override ? 'Hand-priced' : 'Override'}</button>
                  </div>
                </div>
              )}

              {/* ---------------- REMITTANCE — SEND ---------------- */}
              {isSend && (
                <div className="space-y-3">
                  <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                    <Lbl>Send to</Lbl>
                    <div className="grid grid-cols-2 gap-2">
                      <select value={dest.country} onChange={e => setDest(DEST.find(d => d.country === e.target.value))} className="text-sm px-2.5 py-2 outline-none" style={inSty}>{DEST.map(d => <option key={d.country} value={d.country}>{d.flag} {d.country}</option>)}</select>
                      <div className="flex items-center px-2.5 text-[12px]" style={{ ...inSty, color: CD.mute }}>Pays out in <b className="ml-1" style={{ color: CD.ink }}>{dest.ccy}</b></div>
                    </div>
                    <div className="mt-2"><Lbl>Beneficiary name</Lbl><input value={benName} onChange={e => setBenName(e.target.value)} placeholder="Who receives the money" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  </div>
                  <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                    <Lbl>Customer pays (CAD)</Lbl>
                    <Money value={inAmt} onChange={setInAmt} ccy="CAD" big autoFocus />
                    <div className="flex items-center justify-center gap-2 py-2 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}><Ic n="arrowdown" s={13} c={CD.faint} /> 1 CAD = {num(rateN)} {payoutCcy}</div>
                    <Lbl>{benName || 'Beneficiary'} receives</Lbl>
                    <Money value={out.amt ? num(out.amt) : '—'} ccy={payoutCcy} readOnly accent={CD.green} big />
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div><Lbl>Fee (CAD)</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                      <div><Lbl>Purpose</Lbl><input value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="Family support, etc." className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                    </div>
                  </div>
                  {onOpenCheques == null && null}
                  <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ background: CD.lineSoft, borderRadius: 9, color: CD.mute }}><Ic n="send" s={13} c={CD.mute} /> Need partner routing, tracking PIN & settlement? Use the <b style={{ color: CD.ink }}>Transfers</b> desk — this is the quick over-the-counter record.</div>
                </div>
              )}

              {/* ---------------- REMITTANCE — RECEIVE ---------------- */}
              {isReceive && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div><Lbl>Transfer / tracking reference</Lbl><input value={recvRef} onChange={e => setRecvRef(e.target.value)} placeholder="MTCN or partner reference" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  <div><Lbl>Pay recipient</Lbl><Money value={inAmt} onChange={setInAmt} ccy={outCcy} onCcy={setOutCcy} big autoFocus /></div>
                  <div><Lbl>Fee (CAD)</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                </div>
              )}

              {/* ---------------- CHEQUE ---------------- */}
              {isCheque && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div><Lbl hint={`${chequeType.feePct}% · min ${fmt(chequeType.feeMin, 'CAD')} · ${chequeType.holdDays}d hold`}>Cheque type</Lbl>
                    <div className="flex flex-wrap gap-1.5">{chequeSched.map(t => { const on = chequeTypeId === t.id; return <button key={t.id} onClick={() => setChequeTypeId(t.id)} className="px-2.5 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.text }}>{t.label}</button>; })}</div>
                  </div>
                  <div><Lbl>Cheque amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy="CAD" big autoFocus /></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Lbl>Cheque number</Lbl><input value={chequeNumber} onChange={e => setChequeNumber(e.target.value)} placeholder="e.g. 004821" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                    <div><Lbl>Drawee bank</Lbl><input value={draweeBank} onChange={e => setDraweeBank(e.target.value)} placeholder="e.g. RBC" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  </div>
                  <div><Lbl>Maker (who wrote it)</Lbl><input value={maker} onChange={e => setMaker(e.target.value)} placeholder="Payer name / business" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  {/* image scan + endorsement — everything the clearing desk needs to follow up */}
                  <div className="grid grid-cols-2 gap-2">
                    <div><Lbl hint="front of cheque">Cheque image</Lbl>
                      <ScanControl image={chequeImage} onCapture={setChequeImage} onClear={() => setChequeImage(null)} title="Photograph the cheque" />
                    </div>
                    <div><Lbl>Endorsement</Lbl>
                      <button onClick={() => setEndorsed(v => !v)} className="w-full flex items-center gap-2 px-2.5 py-2" style={{ border: `1px solid ${endorsed ? CD.ink : CD.line}`, borderRadius: 9, background: endorsed ? 'var(--cd-chip)' : 'var(--cd-panel)' }}>
                        <span className="grid place-items-center" style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${endorsed ? CD.ink : CD.faint}`, background: endorsed ? CD.ink : 'transparent' }}>{endorsed && <Ic n="check" s={12} c="var(--cd-on-ink)" />}</span>
                        <span className="text-[12.5px]" style={{ color: CD.ink }}>Signed on the back</span>
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2.5" style={{ background: CD.amberSoft, borderRadius: 9 }}><span className="text-[11px]" style={{ color: 'var(--cd-brass-text)' }}>{amtN > 0 ? <>Front <b>{fmt(out.amt, 'CAD')}</b> · keep <b>{fmt(chequeFee, 'CAD')}</b>{(chequeType.holdDays || 0) > 0 && _K ? <> · holds to {_K.addDays(TODAY, chequeType.holdDays)}</> : ' · no hold'}</> : 'Enter the cheque amount'}</span></div>
                </div>
              )}

              {/* ---------------- MONEY ORDER ---------------- */}
              {isMO && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div><Lbl>Payee</Lbl><input value={payee} onChange={e => setPayee(e.target.value)} placeholder="Who the money order is for" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  <div><Lbl>Face amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy="CAD" big autoFocus /></div>
                  <div><Lbl>Fee (CAD)</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  {amtN > 0 && <div className="text-[11px] px-3 py-2" style={{ background: CD.lineSoft, borderRadius: 9, color: CD.mute }}>Customer pays <b style={{ color: CD.ink }}>{fmt(amtN + feeN, 'CAD')}</b> for a <b style={{ color: CD.ink }}>{fmt(amtN, 'CAD')}</b> money order.</div>}
                </div>
              )}

              {/* ---------------- BILL PAYMENT ---------------- */}
              {isBill && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Lbl>Biller</Lbl><input value={biller} onChange={e => setBiller(e.target.value)} placeholder="e.g. Toronto Hydro" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                    <div><Lbl>Account number</Lbl><input value={account} onChange={e => setAccount(e.target.value)} placeholder="Biller account #" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  </div>
                  <div><Lbl>Amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy="CAD" big autoFocus /></div>
                  <div><Lbl>Fee (CAD)</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  {amtN > 0 && <div className="text-[11px] px-3 py-2" style={{ background: CD.lineSoft, borderRadius: 9, color: CD.mute }}>Customer pays <b style={{ color: CD.ink }}>{fmt(amtN + feeN, 'CAD')}</b> — {fmt(amtN, 'CAD')} to biller, {fmt(feeN, 'CAD')} fee.</div>}
                </div>
              )}

              {/* reportable capture — shown for every type at/over the line */}
              {single && (
                <div className="p-3.5 space-y-2.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.flag}`, borderRadius: 12 }}>
                  <div className="flex items-center gap-1.5"><Ic n="filetext" s={14} c={CD.flag} /><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Reportable — capture for the {regime.largeCode}</span></div>
                  <div className="text-[11px]" style={{ color: CD.mute }}>This deal is ≥ {fmt(TH, 'CAD')}. Capture now while the customer is here — it pre-fills the filing.</div>
                  <div><Lbl>Purpose of transaction</Lbl><input value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="e.g. vacation funds, invoice settlement" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: purpose.trim() ? CD.line : CD.flag }} /></div>
                  <div><Lbl>Source of funds</Lbl><input value={cap.source} onChange={e => setCap(s => ({ ...s, source: e.target.value }))} placeholder="e.g. employment income, savings" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: cap.source.trim() ? CD.line : CD.flag }} /></div>
                  <div><Lbl>Acting for someone else?</Lbl>
                    <div className="flex items-center gap-2">
                      <div className="inline-flex flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{[['no', 'No'], ['yes', 'Yes']].map(([v, l], i) => { const on = (cap.thirdParty ? 'yes' : 'no') === v; return <button key={v} onClick={() => setCap(s => ({ ...s, thirdParty: v === 'yes' }))} className="text-xs px-3 py-1.5" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none' }}>{l}</button>; })}</div>
                      {cap.thirdParty && <input value={cap.thirdPartyName} onChange={e => setCap(s => ({ ...s, thirdPartyName: e.target.value }))} placeholder="Name of that person / entity" className="flex-1 min-w-0 text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: cap.thirdPartyName.trim() ? CD.line : CD.flag }} />}
                    </div>
                  </div>
                </div>
              )}

              {/* below-floor margin override */}
              {needOverride && (
                <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.flag}`, borderRadius: 12 }}>
                  <div className="text-[12px] font-medium flex items-center gap-1.5 mb-1.5" style={{ color: CD.flag }}><Ic n="alert" s={13} c={CD.flag} /> Below your {mFloor}% floor{spreadCadLive < 0 ? ' — losing on the rate' : ''}.</div>
                  <label className="flex items-start gap-2 mb-1.5" style={{ color: CD.ink, cursor: 'pointer' }}><input type="checkbox" checked={marginAck} onChange={e => setMarginAck(e.target.checked)} style={{ marginTop: 2 }} /><span className="text-[12px]">Override and post below the floor</span></label>
                  {marginAck && <input value={marginReason} onChange={e => setMarginReason(e.target.value)} placeholder="Reason — regular client, price match, volume…" className="w-full text-[12.5px] px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: marginReason.trim() ? CD.line : CD.flag }} />}
                </div>
              )}

              {/* note */}
              <div><Lbl>Note (optional)</Lbl><input value={memo} onChange={e => setMemo(e.target.value)} placeholder="Anything worth keeping on the record…" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
            </div>

            {/* RIGHT — ticket + checklist */}
            <div className="flex-none flex flex-col" style={{ width: 320, background: 'var(--cd-chip)' }}>
              <div className="flex-1 overflow-auto p-4 space-y-3">
                {/* deal ticket */}
                <div style={{ background: CD.ink, borderRadius: 12, padding: 16, color: 'var(--cd-on-ink)' }}>
                  <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)', paddingBottom: 10 }}>
                    <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cd-on-ink-soft)' }}>{meta.short}</span>
                    <Ic n={meta.icon} s={14} c="var(--cd-on-ink-soft)" />
                  </div>
                  <div style={{ padding: '12px 0' }}>
                    <div style={{ fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? 'Customer gives' : isCheque ? 'Cheque face' : isReceive ? 'Pay out' : 'Customer pays'}</div>
                    <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{amtN > 0 ? num(isExchange || isCheque || isReceive ? amtN : amtN + feeN) : '0'} <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? inCcy : isReceive ? out.ccy : 'CAD'}</span></div>
                  </div>
                  {(isExchange || isSend || isCheque) && <div className="flex items-center gap-2 py-1" style={{ color: 'var(--cd-on-ink-faint)' }}><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span><Ic n="arrowdown" s={13} c="var(--cd-on-ink-soft)" /><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span></div>}
                  <div style={{ paddingTop: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? 'Customer receives' : isSend ? `${benName || 'Beneficiary'} gets` : isCheque ? 'Cash out' : isReceive ? 'Recipient gets' : isMO ? 'Money order' : 'To biller'}</div>
                    <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', color: '#7fd1a3', lineHeight: 1.1 }}>{out.amt ? num(out.amt) : '0'} <span style={{ fontWeight: 500, fontSize: 15, color: 'rgba(127,209,163,0.7)' }}>{out.ccy}</span></div>
                  </div>
                  <div className="flex items-center justify-between" style={{ borderTop: '1px solid var(--cd-on-ink-faint)', marginTop: 12, paddingTop: 10, fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>
                    <span>{(isExchange || isSend) ? `1 ${isExchange ? inCcy : 'CAD'} = ${num(rateN)} ${out.ccy}` : isCheque ? `${chequeType.holdDays || 0}d hold` : 'Face value'}</span>
                    <span>{isCheque ? `fee ${fmt(chequeFee, 'CAD')}` : feeN > 0 ? `fee ${fmt(feeN, 'CAD')}` : 'no fee'}</span>
                  </div>
                </div>

                {/* margin chip (exchange/send only) */}
                {(isExchange || isSend) && amtN > 0 && (
                  <div className="flex items-center justify-between px-3 py-2" style={{ background: 'var(--cd-panel)', border: `1px solid ${belowFloor ? CD.flag : CD.line}`, borderRadius: 10 }}>
                    <span className="text-[11px] flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="activity" s={12} c={belowFloor ? CD.flag : marginPct >= mTarget ? CD.green : CD.amber} /> MARGIN</span>
                    <span className="text-[12px] font-bold" style={{ color: belowFloor ? CD.flag : marginPct >= mTarget ? CD.green : CD.amber, fontVariantNumeric: 'tabular-nums' }}>{fmt(profitCad, 'CAD')} · {marginPct.toFixed(2)}%</span>
                  </div>
                )}

                {/* the checklist */}
                <div className="px-3.5 py-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Before you post</span>
                    <span className="text-[10px] px-1.5 py-0.5" style={{ borderRadius: 999, background: allGreen ? CD.greenSoft : CD.lineSoft, color: allGreen ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>{allGreen ? 'READY' : `${remaining} LEFT`}</span>
                  </div>
                  {reqs.map(r => <Check key={r.key} ok={r.ok} warn={r.warn && !r.ok} label={r.label} sub={!r.ok ? r.sub : null} />)}
                </div>

                {/* compliance note */}
                {(single || structuring) && (
                  <div className="px-3 py-2.5 text-[11px] flex items-start gap-2" style={{ background: single ? CD.flagSoft : CD.amberSoft, borderRadius: 10, color: single ? CD.flag : 'var(--cd-brass-text)' }}>
                    <Ic n="shield" s={13} c={single ? CD.flag : 'var(--cd-brass-text)'} />
                    <span>{single ? `Reportable — a ${regime.largeCode} will be required.` : `Structuring watch — ${customer}'s ${settings.structuringDays}-day total reaches ${fmt(recentTotal, 'CAD')}.`}</span>
                  </div>
                )}
              </div>

              {/* rail footer actions */}
              <div className="flex-none p-3 space-y-2" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
                {(isExchange || isSend) && <button onClick={() => setPresent(true)} disabled={!(amtN > 0 && rateN > 0)} className="w-full flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: (amtN > 0 && rateN > 0) ? CD.ink : CD.faint }}><Ic n="smartphone" s={15} /> Show customer the quote</button>}
                <CommitBtn onCommit={record} disabled={!canSave} icon="check" label={allGreen ? 'Record transaction' : `${remaining} to complete`} doneLabel="Recorded" title="Post this transaction to the ledger" className="w-full justify-center" style={{ padding: '0.65rem 1rem', fontSize: 14 }} />
                <button onClick={onClose} className="w-full py-2 text-[12px]" style={{ color: CD.mute }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
        {present && <PresentQuote q={presentQ} onClose={() => setPresent(false)} />}
        {addFlow && window.CDOS.KYC && React.createElement(window.CDOS.KYC.NewContactFlow, { initialName: (customer || query).trim(), by: me.name, setClients, requireId: idRequired, onClose: () => setAddFlow(false), onDone: (nm) => { setCustomer(nm); setQuery(nm); setAddFlow(false); } })}
        {quickChk && window.CDOS.KYC && React.createElement(window.CDOS.KYC.SendModal, { subject: customer, kind: (clients[customer] && clients[customer].kind) || 'individual', rec: clients[customer], by: me.name, initialTpl: quickChk, onClose: () => setQuickChk(null) })}
      </div>
    ), document.body);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { TxModal });
})();
