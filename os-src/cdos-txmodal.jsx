/* ============================================================
   CurrencyDesk OS — New Transaction (guided, type-aware)
   A single counter flow that reshapes itself to the job: exchange,
   remittance, cheque, money order, bill payment. The right rail is a
   live "before you post" checklist + deal ticket, so a teller trained
   once just fills until everything turns green. Compliance (the pack's
   identification and reporting lines, structuring, purpose/source
   capture) is part of the checklist, not an afterthought.
   Exposed as window.CDOS.TxModal — the Ledger prefers it when present.
   ============================================================ */
(function () {
  const { useState, useMemo, useRef, useEffect, useSyncExternalStore } = React;
  const {
    CD, Ic, CCY, reportingLimit, TODAY, crossRate, fmt, num, currencyPlaces, effectiveRate, unitText, mkRef, nowTime, newTx,
    priceDeal, spreadOf, sellUnitCad, CommitBtn
  } = window.CDOS;
  /* The sentence the server returns when a deal needs ID. The
     checklist and the Record ID button key off it, so a refusal and
     the fix path stay the same words. server/src/ledger/id-on-file.ts */
  const ID_NEEDED = "ID needed for this amount. Record the customer's ID.";
  const deskHome = () => {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    return (pack && pack.homeCurrency) || 'CAD';
  };
  /* The published board's home-per-unit mid — the same number the server
     multiplies the cash by (`input × fromMid`). A missing row is null,
     never zero: zero is how a real pile of foreign notes looks like
     nothing and walks past the identification line. */
  function boardHomePerUnit(ccy) {
    try {
      const cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || 'null');
      const row = cfg && cfg.rows && cfg.rows[String(ccy || '').toUpperCase()];
      if (!row || row.show === false) return null;
      const mid = typeof row.mid === 'number' ? row.mid : Number(row.mid);
      if (mid > 0 && isFinite(mid)) return mid;
    } catch (e) {}
    return null;
  }
  /* Home value of cash handed over. Canada keeps the CAD cross this
     form has always used. Any other desk uses the board mid above.
     Nothing handed over is 0. A positive foreign amount with no mid
     is null — identification required, not "no ID needed". */
  function cashInHome(amount, ccy, home) {
    const n = +amount || 0;
    if (!ccy || ccy === home) return n;
    if (home === 'CAD') return n / (crossRate('CAD', ccy) || 1);
    if (!(n > 0)) return 0;
    const per = boardHomePerUnit(ccy);
    return per == null ? null : n * per;
  }
  /* An exchange shows the server customerRate. A typed override is
     sent to the server. It is not priced on this screen. */
  const RATE_NOTE = (window.CDOS && window.CDOS.RATE_NOTE) || 'Rate rounded. The amounts are exact.';
  const pricedRate = (amount, payout, ccy) => {
    if (typeof effectiveRate !== 'function') return { text: '', rounded: false };
    return effectiveRate(amount, payout, currencyPlaces(ccy)) || { text: '', rounded: false };
  };
  const dealRateLine = (from, to, amount, payout) => {
    const rate = pricedRate(amount, payout, to);
    if (!rate.text) return 'Rate unavailable';
    return '1 ' + from + ' = ' + rate.text + ' ' + to;
  };
  function SheetRateNote({ on, hold }) {
    if (!on && !hold) return null;
    return <div className="cd-rate-note text-center" aria-hidden={on ? undefined : true} style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cd-pin-note)', marginTop: 2, visibility: on ? 'visible' : 'hidden' }}>{RATE_NOTE}</div>;
  }
  const phoneMoney = (n, ccy) => {
    const fn = window.CDOS.formatPhoneMoney;
    return typeof fn === 'function' ? fn(n, ccy) : (num(n) + (ccy ? ' ' + ccy : ''));
  };
  const phoneDay = (iso) => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return iso || '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const parts = String(iso).split('-');
    return months[Number(parts[1]) - 1] + ' ' + Number(parts[2]) + ', ' + parts[0];
  };

  /* ---- Texts (SMS) hold redemption: read the quote store, validate, write back on post ---- */
  const TG_RKEY = 'cdos_tg_requests_v2', TG_LKEY = 'cdos_tg_log_v2';
  const tgRead = () => { try { return JSON.parse(localStorage.getItem(TG_RKEY) || '[]') || []; } catch (e) { return []; } };
  const tgDigits = (p) => (p || '').replace(/\D/g, '').slice(-10);
  const tgContactName = (phone) => { try { const cs = JSON.parse(localStorage.getItem('cdos_tg_contacts_v2') || '[]') || []; const hit = cs.find(c => c.name && tgDigits(c.phone) === tgDigits(phone)); return hit ? hit.name : ''; } catch (e) { return ''; } };
  function tgFind(refRaw) {
    const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const q = norm(refRaw);
    if (!q) return { err: 'Enter the ref from their text.' };
    const list = tgRead();
    const digits = q.replace(/[^0-9]/g, '');
    let r = list.find(x => norm(x.ref) === q);
    if (!r && digits.length >= 2) r = list.find(x => norm(x.ref).endsWith(digits));
    return r ? { r } : { err: 'No text quote matches that ref — the last digits are enough.' };
  }
  function tgRedeem(tqRef, ledgerRef) {
    try {
      const t = new Date().toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
      let phone = '';
      const next = tgRead().map(x => x.ref === tqRef ? (phone = x.phone, { ...x, status: 'collected', ledgerRef, thread: [...(x.thread || []), { d: 'sys', t: 'Redeemed at the counter \u2192 ' + ledgerRef + ' \u00b7 ' + t }] }) : x);
      localStorage.setItem(TG_RKEY, JSON.stringify(next));
      const lg = (() => { try { return JSON.parse(localStorage.getItem(TG_LKEY) || '[]') || []; } catch (e) { return []; } })();
      lg.unshift({ t: Date.now(), kind: 'System', dir: 'sys', to: phone, detail: tqRef + ' redeemed at the counter \u2192 ' + ledgerRef });
      localStorage.setItem(TG_LKEY, JSON.stringify(lg.slice(0, 400)));
      window.dispatchEvent(new Event('cdos_tg_sync'));
    } catch (e) {}
  }

  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const FLAG = { CAD: '🇨🇦', USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', INR: '🇮🇳', PHP: '🇵🇭', CNY: '🇨🇳', MXN: '🇲🇽', AED: '🇦🇪' };
  const ccyLabel = (c) => (FLAG[c] ? FLAG[c] + ' ' : '') + c;
  const CCY_NAME = { CAD: 'Canadian Dollar', USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', INR: 'Indian Rupee', PHP: 'Philippine Peso', CNY: 'Chinese Yuan', MXN: 'Mexican Peso', AED: 'UAE Dirham' };
  // mirror the staff-published rate-board order so this picker matches the board
  // (reorder currencies on the Rate Board and they reorder here too).
  function boardOrderedCCY() {
    const home = deskHome();
    const base = (home && CCY.indexOf(home) < 0) ? [home].concat(CCY) : CCY;
    try {
      const order = JSON.parse(localStorage.getItem('yorkfx_board_order') || 'null');
      if (Array.isArray(order) && order.length) {
        const rank = {}; order.forEach((c, i) => { rank[c] = i; });
        return [...base].sort((a, b) => (rank[a] != null ? rank[a] : 999) - (rank[b] != null ? rank[b] : 999));
      }
    } catch (e) {}
    return base;
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
    return <div className="tx-lbl flex items-center justify-between mb-1"><span className="text-[11px]" style={{ color: CD.mute }}>{children}</span>{hint && <span className="text-[10px]" style={{ color: CD.faint }}>{hint}</span>}</div>;
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

  function Money({ value, onChange, ccy, onCcy, big, readOnly, accent, autoFocus, mark }) {
    return (
      <div className="cd-money flex items-stretch" style={{ border: `1px solid ${readOnly ? CD.line : CD.ink}`, borderRadius: 9, overflow: 'hidden', background: readOnly ? 'var(--cd-paper-soft)' : 'var(--cd-panel)' }}>
        <CcyPicker value={ccy} onChange={onCcy} disabled={!onCcy} />
        {readOnly
          ? <div className={'flex-1 min-w-0 px-3 py-2.5 font-semibold text-right' + (mark ? ' ' + mark : '')} style={{ fontVariantNumeric: 'tabular-nums', color: accent || CD.ink, fontSize: big ? 22 : 16 }}>{value}</div>
          : <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" autoFocus={autoFocus} placeholder="0.00" className="flex-1 min-w-0 px-3 py-2.5 font-semibold text-right outline-none" style={{ fontVariantNumeric: 'tabular-nums', fontSize: big ? 22 : 16 }} />}
      </div>
    );
  }

  /* ---------- customer combobox (search / add with inline KYC) ---------- */
  function CustomerPicker({ label, hint, value, query, setQuery, onPick, names, clients, onAddNew, onClear, idRequired }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef(null);
    /* A tap on the amount used to leave this list open, because only a
       mousedown outside the box closed it, and the list then sat on top
       of the amount. Focus leaving the box closes it too: blur, a pick,
       or the amount field taking focus. */
    useEffect(() => {
      const closeIfOutside = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', closeIfOutside);
      document.addEventListener('focusin', closeIfOutside);
      return () => { document.removeEventListener('mousedown', closeIfOutside); document.removeEventListener('focusin', closeIfOutside); };
    }, []);
    const shown = names.filter(n => n.toLowerCase().includes((query || '').toLowerCase()));
    return (
      <div>
        <Lbl hint={hint}>{label}</Lbl>
        <div ref={wrap} className="relative">
          <div className="cd-tx-customer flex items-center gap-2 px-2.5 py-2" style={inSty}>
            {/* display:contents on the desk, so this span is not a box
                there. On a phone it is the icon's slot in the one row. */}
            <span className="cd-tx-customer-icon"><Ic n="search" s={15} c={CD.mute} /></span>
            <input value={query} onFocus={() => setOpen(true)} onBlur={() => { requestAnimationFrame(() => { if (wrap.current && wrap.current.contains(document.activeElement)) return; setOpen(false); }); }} onChange={e => { setQuery(e.target.value); setOpen(true); }} placeholder="Type a name…" className="w-full outline-none text-sm bg-transparent" />
            {query && <button type="button" className="cd-tx-clear" aria-label="Clear customer" onClick={() => { onClear(); setOpen(false); }}><Ic n="x" s={14} c={CD.mute} /></button>}
          </div>
          {open && (
            <div className="cd-tx-suggest absolute left-0 right-0 mt-1 py-1 max-h-52 overflow-auto" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10, boxShadow: '0 12px 30px var(--cd-shade)', zIndex: 30 }}>
              {shown.map(n => { const c = clients[n] || {}; const ver = (() => { try { return ((window.CDOS.KYC && window.CDOS.KYC.checksFor(n)) || []).some(k => (k.template === 'verify' || k.template === 'plus') && k.status === 'completed' && k.result && k.result.decision === 'approved'); } catch (e) { return false; } })(); const standing = c.idStanding && c.idStanding.label ? c.idStanding : null; const st = standing ? standing.label : (!c.idType) ? 'missing ID' : (c.idExpiry && c.idExpiry < TODAY ? 'ID expired' : ver ? 'verified' : 'ID on file'); const ok = standing ? standing.tone === 'ok' : st === 'verified'; const onfile = standing ? false : st === 'ID on file'; return (
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
    const phone = useSyncExternalStore(subscribePhoneSheet, phoneSheetNow, () => false);
    const s = useMemo(() => {
      const h = live.filter(r => r.customer === name);
      const home = deskHome();
      const winDays = (settings && settings.structuringDays) || 30;
      const cutoff = new Date(Date.now() - winDays * 86400000).toISOString().slice(0, 10);
      let total = 0, windowCad = 0, unknown = false; const cc = {};
      h.forEach(r => { const cad = cashInHome(r.inAmt, r.inCcy, home); if (cad == null) { unknown = true; } else { total += cad; if (r.date >= cutoff) windowCad += cad; } const c = (r.outCcy && r.outCcy !== home) ? r.outCcy : (r.inCcy !== home ? r.inCcy : null); if (c) cc[c] = (cc[c] || 0) + 1; });
      if (unknown) { total = null; windowCad = null; }
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
    const line = reportingLimit(settings).amount;
    const over = line != null && s.windowCad != null && s.windowCad >= line;
    const near = line != null && s.windowCad != null && !over && s.windowCad >= line * 0.7;
    const lastLbl = s.days == null ? 'First visit' : s.days === 0 ? 'In today already' : s.days === 1 ? 'Yesterday' : `${s.days} days ago`;
    return (
      <div className="mt-2 overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 11, background: 'var(--cd-panel)' }}>
        <div className="cd-tx-person flex items-center gap-3 px-3.5 py-2.5" style={{ background: CD.lineSoft, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none font-semibold" style={{ width: 34, height: 34, borderRadius: 9, background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 13 }}>{initials}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2"><span className="font-semibold truncate" style={{ color: CD.ink }}>{name}</span>{s.count >= 3 && <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 flex-none" style={{ background: CD.amberSoft, color: 'var(--cd-brass-text)', borderRadius: 999, fontWeight: 600 }}><Ic n="star" s={10} c="var(--cd-brass-text)" /> Regular</span>}</div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{s.count > 0 ? `${s.count} deal${s.count !== 1 ? 's' : ''} · ${lastLbl}` : 'No prior deals here'}</div>
          </div>
          <span className="flex items-center gap-1 text-[11px] px-2 py-1 flex-none font-medium" style={{ background: badge.bg, color: badge.c, borderRadius: 999 }}><Ic n={badge.ic} s={12} c={badge.c} /> {badge.t}</span>
        </div>
        <div className="cd-tx-stats grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <CCstat label="ID on file" sentence={phone} value={idMissing ? '—' : (rec.idType || 'ID')} sub={idMissing ? 'collect below' : (rec.idExpiry ? `exp ${phone ? phoneDay(rec.idExpiry) : rec.idExpiry}` : 'on file')} tone={idOk ? CD.ink : CD.flag} />
          <CCstat label={phone ? `Last ${s.winDays} days` : `Last ${s.winDays}d`} sentence={phone} value={s.windowCad == null ? 'Rate unavailable' : fmt(s.windowCad, deskHome())} sub={s.windowCad == null ? 'cannot value' : over ? 'over the line' : near ? 'nearing line' : 'within range'} tone={over ? CD.flag : near ? CD.amber : CD.ink} divider />
          <CCstat label="Usually" value={s.top || '—'} sub={s.count > 0 ? (s.total == null ? 'Rate unavailable' : `${fmt(s.total, deskHome())} lifetime`) : 'new'} tone={CD.ink} divider />
        </div>
      </div>
    );
  }
  function CCstat({ label, value, sub, tone, divider, sentence }) {
    return (<div className="px-3 py-2.5" style={{ borderLeft: divider ? `1px solid ${CD.lineSoft}` : 'none' }}>
      <div className={'text-[9.5px] tracking-wider' + (sentence ? ' cd-tx-stat-label' : ' uppercase')} style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
      <div className="text-[13px] font-semibold leading-tight mt-0.5 truncate" style={{ color: tone || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div className="text-[9.5px] mt-0.5 truncate" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }

  /* ---------- present-to-customer fullscreen quote ---------- */
  function PresentQuote({ q, onClose }) {
    useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
    return ReactDOM.createPortal(
      <div data-quote-face className="cd-quote-face fixed inset-0">
        <div className="cd-quote-head">
          <div><div className="cd-quote-biz">{q.biz}</div><div className="cd-quote-title">{q.title}</div></div>
          <span className="cd-quote-tag">{q.tag}</span>
        </div>
        <div className="cd-quote-body">
          <div><div className="cd-quote-label">{q.giveLbl}</div><div className="cd-quote-amount" data-quote-give>{q.give}</div></div>
          {q.rateLine ? <div className="cd-quote-rate" data-quote-rate>{q.rateLine}</div> : null}
          {q.rateNote ? <div className="cd-rate-note cd-quote-note">{q.rateNote}</div> : null}
          <div><div className="cd-quote-label">{q.getLbl}</div><div className="cd-quote-amount cd-quote-get" data-quote-get>{q.get}</div></div>
        </div>
        <div className="cd-quote-foot">
          <span className="cd-quote-foot-copy">{q.foot}</span>
          <button onClick={onClose} className="cd-quote-back"><Ic n="arrowleft" s={16} c={CD.ink} /> Back to desk</button>
        </div>
      </div>, document.body);
  }

  /* ---------- checklist row ---------- */
  function Check({ ok, warn, label, sub, action, mark, onActivate }) {
    const copy = (
      <>
        <div className="text-[12.5px] leading-tight" style={{ color: ok ? CD.ink : warn ? 'var(--cd-brass-text)' : CD.mute, fontWeight: ok ? 500 : 400 }}>{label}</div>
        {sub && <div className="text-[11px] mt-0.5 leading-snug" style={{ color: warn ? CD.amber : CD.faint }}>{sub}</div>}
        {action}
      </>
    );
    return (
      <div className={'flex items-start gap-2 py-1.5' + (mark ? ' cd-tx-missing' : '')}>
        <span className="flex-none grid place-items-center" style={{ width: 18, height: 18, borderRadius: '50%', border: ok ? 'none' : `1.5px solid ${warn ? CD.amber : CD.line}`, background: ok ? CD.green : 'transparent', marginTop: 1 }}>
          {ok ? <Ic n="check" s={11} c="var(--cd-on-ink)" /> : warn ? <Ic n="alert" s={11} c={CD.amber} /> : null}
        </span>
        {onActivate
          ? <button type="button" onClick={onActivate} className="cd-tx-check-go min-w-0 flex-1">{copy}</button>
          : <div className="min-w-0 flex-1">{copy}</div>}
      </div>
    );
  }

  /* =====================================================================
     MAIN
  ===================================================================== */
  /* Phone sheet is under 600px only. The desk placeholder strings stay
     the long ones, so a 1280 screenshot does not move. */
  function subscribePhoneSheet(onChange) {
    const query = window.matchMedia('(max-width: 599px)');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  function phoneSheetNow() {
    return window.matchMedia('(max-width: 599px)').matches;
  }

  function TxModal({ rows, clients, setClients, setRows, settings, me, log, onClose, onDone, prefillClient, rateVersion, cheques, setCheques, chequeSchedule, onOpenCheques, serverBacked, onServerPosted, onRecordId }) {
    const home = deskHome();
    const live = useMemo(() => rows.filter(r => r.status !== 'void'), [rows]);
    const names = useMemo(() => { const s = new Set(Object.keys(clients)); live.forEach(r => r.customer && s.add(r.customer)); return Array.from(s).sort(); }, [clients, live]);

    const [type, setType] = useState('Currency Exchange');
    const meta = TYPE_META[type];
    const phoneSheet = useSyncExternalStore(subscribePhoneSheet, phoneSheetNow, () => false);
    const smsOn = !!(window.CDOS.smsConfigured && window.CDOS.smsConfigured());
    const personaOn = !!(window.CDOS.KYC && window.CDOS.KYC.personaConnected && window.CDOS.KYC.personaConnected());
    const [missKey, setMissKey] = useState('');
    const [touched, setTouched] = useState({});
    const markTouched = (k) => setTouched(t => (t[k] ? t : { ...t, [k]: true }));
    const openBorder = (k, filled) => (!phoneSheet || touched[k]) && !filled ? CD.flag : CD.line;
    const rateShown = (from, to, amount, payout) => dealRateLine(from, to, amount, payout);
    const selectedChip = useRef(null);
    useEffect(() => {
      if (!phoneSheet || !selectedChip.current) return;
      const chip = selectedChip.current;
      const row = chip.parentElement;
      if (!row) return;
      const gutter = 16;
      const left = chip.offsetLeft;
      const right = left + chip.offsetWidth;
      if (left - gutter < row.scrollLeft) row.scrollLeft = Math.max(0, left - gutter);
      else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
    }, [phoneSheet, type]);
    const purposePh = phoneSheet ? 'e.g. vacation, invoice' : 'e.g. vacation funds, invoice settlement';
    const sourcePh = phoneSheet ? 'e.g. salary, savings' : 'e.g. employment income, savings';
    const notePh = phoneSheet ? 'Add a note' : 'Anything worth keeping on the record…';

    /* ---- the key that says "this attempt, and no other" ----

       The idempotency key used to be built from `ref` — mkRef(TODAY,
       seq), where seq counts THIS browser's rows for today. That number
       restarts at 1 whenever local state does, so the second money order
       ever posted from a freshly signed-in till carried the same key as
       the first: the ledger recognised it as a replay, returned the
       first deal's response, and moved no cash. The screen said posted,
       the drawer never changed, and nothing anywhere said so.

       One key per ticket instead. It survives a refusal — a deal the
       ledger REFUSED leaves no idempotency row behind, so re-submitting
       the corrected ticket under the same key is exactly right — and a
       new ticket gets a new one. */
    const attempt = useRef(null);
    const attemptKey = () => {
      if (!attempt.current)
        attempt.current = (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID()
          : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      return attempt.current;
    };

    // customer
    const [customer, setCustomer] = useState(prefillClient || '');
    const [query, setQuery] = useState(prefillClient || '');
    const [addFlow, setAddFlow] = useState(false);   // launches the KYC scan-ID walk-through
    const [recordId, setRecordId] = useState(false); // the client file's identity editor
    const [discardAsk, setDiscardAsk] = useState(false);
    const [quickChk, setQuickChk] = useState(null);   // tier string → opens the SendModal chooser
    const sheetRef = useRef(null);

    // exchange
    const [inCcy, setInCcy] = useState(home);
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
    const [identityNumber, setIdentityNumber] = useState('');
    const [reportSuspicion, setReportSuspicion] = useState(false);
    const [usdLargeNotes, setUsdLargeNotes] = useState(null);
    const [usdSerials, setUsdSerials] = useState('');
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
    // Texts hold redemption — the ref the customer reads at the counter
    const [tqIn, setTqIn] = useState('');
    const [tq, setTq] = useState(null);
    const [tqErr, setTqErr] = useState('');
    const [tqOpen, setTqOpen] = useState(false);
    const [serverQuote, setServerQuote] = useState(null);
    const [preview, setPreview] = useState(null);
    const [serverBusy, setServerBusy] = useState(false);
    const [serverError, setServerError] = useState('');

    /* Anything the teller put on this ticket. Closing from the phone is
       the X alone, so that gesture asks before it throws the ticket away.
       An empty sheet still closes. The desk keeps the old close: Cancel
       is still there, and this confirm is not on that dialog. */
    const feeDefault = settings && settings.defaultFee != null ? String(settings.defaultFee) : '';
    const dealDirty = !!(
      String(customer || '').trim() || String(query || '').trim() || String(inAmt || '').trim()
      || type !== 'Currency Exchange' || inCcy !== home || outCcy !== 'USD'
      || override || tq || String(purpose || '').trim() || String(memo || '').trim()
      || String(cap.source || '').trim() || cap.thirdParty
      || String(benName || '').trim() || String(recvRef || '').trim()
      || String(chequeNumber || '').trim() || String(maker || '').trim() || String(draweeBank || '').trim()
      || chequeImage || endorsed || String(payee || '').trim() || String(biller || '').trim()
      || String(account || '').trim() || String(fee || '') !== feeDefault
      || marginAck || String(marginReason || '').trim()
      || String(identityNumber || '').trim() || reportSuspicion || usdLargeNotes != null || String(usdSerials || '').trim()
    );
    const requestClose = () => {
      if (phoneSheet && dealDirty) { setDiscardAsk(true); return; }
      onClose();
    };
    useEffect(() => {
      const h = (e) => {
        if (e.key !== 'Escape' || present || addFlow || quickChk || recordId) return;
        if (discardAsk) { setDiscardAsk(false); return; }
        if (phoneSheet && dealDirty) { setDiscardAsk(true); return; }
        onClose();
      };
      document.addEventListener('keydown', h);
      return () => document.removeEventListener('keydown', h);
    }, [onClose, present, addFlow, quickChk, recordId, discardAsk, phoneSheet, dealDirty]);
    /* The soft keyboard shrinks the visual viewport and leaves the layout
       viewport tall, so a footer pinned to the layout bottom sits under
       the keys. The sheet tracks the visual viewport, and the footer sits
       on that bottom edge. */
    useEffect(() => {
      if (!phoneSheet) return undefined;
      const el = sheetRef.current;
      if (!el) return undefined;
      const apply = () => {
        const view = window.visualViewport;
        const height = view ? view.height : window.innerHeight;
        const offset = view ? view.offsetTop : 0;
        const keyboard = Math.max(0, Math.round(window.innerHeight - height - offset));
        el.style.setProperty('--cd-tx-vvh', Math.round(height) + 'px');
        el.style.setProperty('--cd-tx-vvt', Math.round(offset) + 'px');
        el.style.setProperty('--cd-tx-kb', keyboard + 'px');
        const actions = el.querySelector('.cd-tx-actions');
        if (actions) el.style.setProperty('--cd-tx-footer', actions.offsetHeight + 'px');
      };
      apply();
      const view = window.visualViewport;
      if (view) {
        view.addEventListener('resize', apply);
        view.addEventListener('scroll', apply);
      }
      window.addEventListener('resize', apply);
      const actions = el.querySelector('.cd-tx-actions');
      const observed = actions && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
      if (observed && actions) observed.observe(actions);
      return () => {
        if (view) {
          view.removeEventListener('resize', apply);
          view.removeEventListener('scroll', apply);
        }
        window.removeEventListener('resize', apply);
        if (observed) observed.disconnect();
      };
    }, [phoneSheet, type]);
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
    const priceArgs = isSend
      ? { inCcy: home, outCcy: payoutCcy, inAmt: amtN, settings, lockedRate: null, overrideRate: null }
      : null;
    const pricing = useMemo(() => priceArgs ? priceDeal(priceArgs) : { rate: 1, outAmt: amtN, midRate: null, marginCad: 0, side: null, midCadIn: amtN, deskRate: 1, outAmtRaw: amtN }, [JSON.stringify(priceArgs), rateVersion]);
    const rateN = pricing.rate;
    useEffect(() => {
      setServerQuote(null);
      setServerError('');
    }, [customer, inCcy, outCcy, inAmt, fee, override, manualRate, lock && lock.rate]);
    useEffect(() => {
      if (!isExchange || !(parseFloat(inAmt) > 0) || !window.CDOS.Backend || !window.CDOS.Backend.previewQuote) {
        setPreview(null);
        return undefined;
      }
      let dead = false;
      setPreview(null);
      const timer = setTimeout(() => {
        window.CDOS.Backend.previewQuote({
          from: inCcy,
          to: outCcy,
          inputAmount: window.CDOS.Backend.asMoney(parseFloat(inAmt) || 0),
          feeCad: window.CDOS.Backend.asMoney(parseFloat(fee) || 0),
          direction: inCcy === home ? 'customer_buy_foreign' : outCcy === home ? 'customer_sell_foreign' : 'customer_cross',
        }).then((q) => { if (!dead) setPreview(q); }).catch(() => { if (!dead) setPreview(null); });
      }, 80);
      return () => { dead = true; clearTimeout(timer); };
    }, [isExchange, inCcy, outCcy, inAmt, fee, home]);

    // cheque fee/hold from shared schedule
    const _K = window.CDOS._cheques;
    const chequeSched = chequeSchedule || (_K ? _K.defaultSchedule() : []);
    const chequeType = chequeSched.find(t => t.id === chequeTypeId) || chequeSched[0] || { feePct: 0, feeMin: 0, holdDays: 0, label: 'Cheque' };
    const chequeFee = isCheque && _K ? +_K.feeFor(amtN, chequeType).toFixed(2) : (parseFloat(fee) || 0);

    // what the customer receives / what we collect, per type
    const feeN = parseFloat(fee) || 0;
    const out = isExchange ? { amt: pricing.outAmt, ccy: outCcy }
      : isSend ? { amt: pricing.outAmt, ccy: payoutCcy }
      : isCheque ? { amt: +(amtN - chequeFee).toFixed(2), ccy: home }
      : isReceive ? { amt: amtN, ccy: outCcy }
      : { amt: amtN, ccy: home };   // MO / Bill: face value out
    /* Once the server has priced the deal, that figure is the one on
       the ticket. The local preview is only what shows before then. */
    const typedRate = override && String(manualRate).trim() ? String(manualRate).trim() : '';
    const heldRateText = !typedRate && lockLive && lockLive.rate != null ? String(lockLive.rate) : '';
    const frozenQuote = serverQuote && isExchange && serverQuote.from === inCcy && serverQuote.to === outCcy ? serverQuote : null;
    const liveQuote = frozenQuote || (heldRateText ? null : (preview && preview.from === inCcy && preview.to === outCcy ? preview : null));
    const shownOut = isExchange
      ? (liveQuote && liveQuote.outputAmount != null ? liveQuote.outputAmount : null)
      : out.amt;
    const dealSide = isExchange
      ? (liveQuote && liveQuote.buyOrSellSide === 'we_buy' ? 'buy' : liveQuote && liveQuote.buyOrSellSide === 'we_sell' ? 'sell' : (inCcy === home ? 'sell' : outCcy === home ? 'buy' : 'cross'))
      : pricing.side;
    const serverRateText = liveQuote && liveQuote.customerRate != null ? String(liveQuote.customerRate) : '';
    const liveFace = typedRate ? { text: typedRate, rounded: false } : (liveQuote && window.CDOS.frozenRateFace ? window.CDOS.frozenRateFace(liveQuote.customerRate, liveQuote.inputAmount, liveQuote.outputAmount) : { text: '', rounded: false });
    const exchangeRateLine = liveFace.text ? ('1 ' + inCcy + ' = ' + liveFace.text + ' ' + outCcy) : (heldRateText ? ('1 ' + inCcy + ' = ' + heldRateText + ' ' + outCcy) : '');
    const quotePending = !!(isExchange && amtN > 0 && !liveQuote && !heldRateText);

    // Home value of the cash the customer hands over (threshold basis).
    const toHome = (amount, ccy) => cashInHome(amount, ccy, home);
    const collectCad = isExchange ? toHome(amtN, inCcy)
      : (isMO || isBill) ? amtN + feeN
      : isCheque ? amtN
      : amtN; // send/receive amounts are already in the desk's currency
    const inCadEquiv = isExchange ? toHome(amtN, inCcy) : amtN;

    // margin (exchange + send carry FX spread; others are fee-only)
    const spreadCadLive = isExchange
      ? (liveQuote && liveQuote.spreadCad != null ? +liveQuote.spreadCad : 0)
      : (isSend ? (pricing.marginCad || 0) : 0);
    const profitCad = +(spreadCadLive + (isCheque ? chequeFee : feeN)).toFixed(2);
    const marginBasis = isExchange ? (liveQuote ? (liveQuote.from === home ? +liveQuote.inputAmount : liveQuote.to === home ? +liveQuote.outputAmount : +liveQuote.inputAmount * +liveQuote.marketMid) : 0) : (isSend ? (pricing.midCadIn || 0) : inCadEquiv);
    const marginPct = marginBasis > 0 ? (profitCad / marginBasis) * 100 : 0;
    const mFloor = settings && settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const mTarget = settings && settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const mEnforce = (settings && settings.marginEnforce) || 'block';
    const belowFloor = amtN > 0 && (isSend || (isExchange && liveQuote)) && marginPct < mFloor;
    const needOverride = belowFloor && mEnforce === 'block';

    // ---- compliance ----
    // resolve the live regime pack FIRST — the reportable threshold and ID-required
    // floor must come from settings (via getRegime), not the bare fallback constants,
    // so this screen never drifts from the Ledger/Compliance desk when the owner
    // tunes them in Settings → Compliance & jurisdiction.
    const limit = reportingLimit(settings);
    const regime = window.CDOS.getRegime ? window.CDOS.getRegime(settings) : { largeCode: limit.code, threshold: limit.amount, idAt: null };
    const TH = limit.amount;
    const paused = window.CDOS.rulesMissing && window.CDOS.rulesMissing(settings);
    const idFloor = paused ? null : (regime.idAt == null ? null : regime.idAt);
    const rec = clients[customer];
    /* A server-backed file uses the server's standing. Reading the
       primary document here is how a secondary passport, or a primary
       that only says "Not stated", used to disagree with the gate. */
    /* The server's object, when the file came from it. The checklist
       shows its reason in those words. A record with no object still
       falls through to the fields on the screen. */
    const standing = rec && rec.idStanding && rec.idStanding.label ? rec.idStanding : null;
    const kyc = standing ? (standing.tone === 'ok' ? 'ok' : standing.label === 'Expired' ? 'expired' : 'missing')
      : (!rec || !rec.idType || !rec.idNum) ? 'missing'
      : (rec.idExpiry && rec.idExpiry < TODAY ? 'expired' : 'ok');
    /* Null-safe: with no threshold the honest answer is "cannot say", and
       coercing it makes `>= null` mean `>= 0` — every deal reportable. A
       compliance screen that flags everything gets ignored, which is how a
       real reportable transaction walks past somebody. */
    const unpriced = inCadEquiv == null;
    const reportCmp = regime && regime.comparator === 'gt' ? 'gt' : 'gte';
    const single = TH != null && !unpriced && (reportCmp === 'gt' ? inCadEquiv > TH : inCadEquiv >= TH);
    /* A remittance used to require identification at every amount.
       pack-gb-v2 does not: a transfer of funds needs it only above
       the statutory line, which the server has already resolved
       (including a desk number that tightens it). Cents, not a float.
       pack-ae-v2 is the other way: a money transfer, money order, or
       bill needs identification at any amount. The 3,500 line is
       foreign exchange. The Philippines identifies a remittance only
       above its own line. A missing Philippines line identifies every
       deal. Canada still identifies every remittance. */
    const packNow = window.CDOS.deskPack && window.CDOS.deskPack();
    const packIdNow = packNow && packNow.packId;
    const aeV2 = packIdNow === 'pack-ae-v2';
    const ph = packIdNow === 'pack-ph-v1';
    const diligence = (window.CDOS.deskThresholds && window.CDOS.deskThresholds() || {}).transferDueDiligence || null;
    const ukTransfer = packIdNow === 'pack-gb-v2' ? diligence : null;
    const transferKind = isSend || isReceive || isMO || isBill;
    let ukIdRequired = null;
    if (ukTransfer && transferKind && window.CDOS._transfers && window.CDOS._transfers.transferRuling) {
      const cashText = (n) => (Number.isFinite(n) ? n.toFixed(2) : '');
      const ruling = window.CDOS._transfers.transferRuling({
        direction: isReceive ? 'receive' : 'send',
        principal: isReceive ? '' : cashText(isSend ? amtN : (amtN + feeN)),
        fee: isReceive || !isSend ? '0' : cashText(feeN),
        payout: isReceive ? cashText(amtN) : '',
        baseline: false,
        ukTransfer,
        reportLine: TH,
      });
      ukIdRequired = !!ruling.idRequired || unpriced;
    }
    const aeTransfer = aeV2 && transferKind;
    const idRows = window.CDOS.deskIdThresholds ? (window.CDOS.deskIdThresholds() || []) : [];
    const idKind = (isCheque || isBill) ? 'eft' : (isSend || isReceive || isMO) ? 'remittance' : 'fx';
    const idRow = ph ? (idRows.find(r => r && r.dealKind === idKind) || null) : null;
    const idCmp = idRow && idRow.comparator === 'gt' ? 'gt' : 'gte';
    const idAmount = idRow && idRow.threshold != null && idRow.threshold !== '' ? +idRow.threshold : idFloor;
    const overId = idAmount != null && inCadEquiv != null && (idCmp === 'gt' ? inCadEquiv > idAmount : inCadEquiv >= idAmount);
    const idRequired = !paused && (ukIdRequired != null
      ? ukIdRequired
      : aeTransfer
      ? true
      : ph
      ? (unpriced || !idRow || idRow.threshold == null || overId)
      : (unpriced || single || idFloor == null || inCadEquiv >= idFloor || isSend));
    const idOk = kyc === 'ok';
    const recent = useMemo(() => {
      if (!customer) return { sum: 0, unknown: false };
      let sum = 0, unknown = false;
      live.forEach(o => {
        if (o.customer !== customer) return;
        const v = toHome(o.inAmt, o.inCcy);
        if (v == null) unknown = true;
        else sum += v;
      });
      return { sum, unknown };
    }, [customer, live, inCcy, home]);
    const recentTotal = recent.unknown || unpriced ? null : recent.sum + inCadEquiv;
    /* A prior deal we cannot value is not a zero. Leaving it out would
       let the window sit under the line. The deal in front of us is
       already identification-required when it itself has no rate. */
    const structuring = TH != null && !single && !!customer && (recent.unknown || (recentTotal != null && recentTotal >= TH) || (unpriced && recent.sum >= TH));

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
    const serverNeedsId = serverError === ID_NEEDED;
    const blockedReason = standing && standing.reason ? standing.reason : (phoneSheet ? 'ID not recorded yet' : ID_NEEDED);
    if (idRequired) reqs.push({ key: 'id', ok: !!customer && idOk && !serverNeedsId, warn: !!customer && (!idOk || serverNeedsId), label: standing && !idOk ? standing.label : `${custLabel} identified`, sub: !customer ? `ID required ${single ? `over ${limit.label}` : isSend ? 'for remittance' : idFloor == null ? 'on every deal' : 'over ' + fmt(idFloor, home)} — search or add them` : (!idOk || serverNeedsId) ? blockedReason : null });
    else reqs.push({ key: 'cust', ok: !!customer.trim(), label: customer.trim() ? `${custLabel}: ${customer}` : `${custLabel} name`, sub: !customer.trim() ? 'A name is required — ID not needed at this amount, but capture who this is' : 'No ID needed at this amount' });
    // reportable capture
    if (single) {
      const capOk = purpose.trim() && cap.source.trim() && (!cap.thirdParty || cap.thirdPartyName.trim());
      reqs.push({ key: 'cap', ok: capOk, warn: !capOk, label: `${regime.largeCode} details captured`, sub: !capOk ? 'Purpose, source of funds & third-party — fill below' : 'Pre-fills the filing in Compliance' });
    }
    /* A United Kingdom desk following the pack has no cash report, so
       a small exchange does not need purpose and source of funds.
       A UAE desk following the pack is the same under AED 35,000, and
       needs the fields at 35,000 or more. A reporting number the desk
       typed still does, and so does every other pack. */
    const noStatutoryCashReport = !!(packIdNow === 'pack-gb-v2' && !(TH > 0));
    const aeCdd = aeV2 && isExchange && !unpriced && (inCadEquiv >= 35000 || (TH != null && TH > 0 && inCadEquiv >= TH));
    if (serverBacked && isExchange && !single && !noStatutoryCashReport && (!aeV2 || aeCdd)) {
      const serverFactsOk = purpose.trim() && cap.source.trim();
      reqs.push({ key: 'server-facts', ok: serverFactsOk, warn: !serverFactsOk, label: phoneSheet ? 'Purpose and source of funds' : 'Ledger facts captured', sub: !serverFactsOk ? (phoneSheet ? 'Needed for this amount' : 'Purpose and source of funds are required for an authoritative post') : null });
    }
    if (needOverride) reqs.push({ key: 'mgn', ok: marginAck && marginReason.trim(), warn: true, label: 'Below-floor margin — needs a reason', sub: marginAck && marginReason.trim() ? null : 'Acknowledge & give a reason below' });

    const hardReqs = reqs.filter(r => !r.soft);
    const allGreen = hardReqs.every(r => r.ok);
    const canSave = amtN > 0 && allGreen;
    const remaining = hardReqs.filter(r => !r.ok).length;
    const stepsLabel = `${remaining} ${remaining === 1 ? 'step' : 'steps'} left`;
    const missField = !missKey ? '' : missKey === 'id' ? (customer ? 'id' : 'cust') : (missKey === 'cap' || missKey === 'server-facts') ? 'facts' : missKey;
    const showMissing = () => {
      const first = hardReqs.find(r => !r.ok);
      if (!first) return;
      setMissKey(first.key);
      const field = first.key === 'id' ? (customer ? 'id' : 'cust') : (first.key === 'cap' || first.key === 'server-facts') ? 'facts' : first.key;
      const el = document.querySelector('.cd-tx [data-req-field="' + field + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    const focusFacts = () => {
      const card = document.querySelector('.cd-tx [data-req-field="facts"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const purpose = document.querySelector('.cd-tx .cd-tx-purpose');
      if (purpose && purpose.focus) purpose.focus();
    };

    // ---- actions ----
    const resetPricing = () => { setLock(null); setOverride(false); setManualRate(''); };
    const swap = () => { setInCcy(outCcy); setOutCcy(inCcy); resetPricing(); };
    const lockRate = () => { const mins = (settings && settings.rateLockMins) || 15; setOverride(false); setManualRate(''); setLock({ rate: pricing.deskRate, until: Date.now() + mins * 60000, ref: 'Q-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(live.filter(r => r.date === TODAY).length + 1).padStart(3, '0'), mins }); };
    const lockSecs = lockLive ? Math.max(0, Math.round((lockLive.until - nowMs) / 1000)) : 0;
    const lockClock = `${Math.floor(lockSecs / 60)}:${String(lockSecs % 60).padStart(2, '0')}`;

    const onPick = (n) => { setCustomer(n); setQuery(n); };
    const onAddNew = () => setAddFlow(true);
    const onClear = () => { setQuery(''); setCustomer(''); };
    /* Opens the client file on the identity documents. The modal
       closes because the file sits under it; the teller records the
       ID and comes back to the deal. */
    const leaveForId = () => {
      if (typeof onRecordId === 'function') onRecordId(customer);
      onClose();
    };
    const showRecordId = idRequired && !!String(customer || '').trim() && (!idOk || serverError === ID_NEEDED);

    const applyTqWith = (val) => {
      const { r, err } = tgFind(val);
      if (err) { setTqErr(err); return; }
      if (r.status === 'collected' || r.status === 'closed') { setTqErr(r.ref + (r.status === 'collected' ? ' was already collected' + (r.ledgerRef ? ' (' + r.ledgerRef + ')' : '') + '.' : ' is closed — no live quote.')); return; }
      if (r.status === 'expired' || ((r.status === 'held' || r.status === 'verified') && r.holdUntil && r.holdUntil <= Date.now())) { setTqErr(r.ref + ' — the hold has expired. Re-quote from the Texts app, or price at today’s board.'); return; }
      if (r.kind === 'order' && r.status !== 'order_arrived') { setTqErr(r.ref + ' is a currency order still in transit — redeem it once the stock arrives.'); return; }
      if (r.status === 'new' || r.status === 'order_new') { setTqErr(r.ref + ' hasn’t been quoted yet — answer it in the Texts app first.'); return; }
      if (CCY.indexOf(r.ccy) < 0) { setTqErr(r.ccy + ' isn’t on your board — price this one by hand.'); return; }
      const held = (r.status === 'held' || r.status === 'verified') && r.rate > 0 && r.total > 0;
      setInCcy(home); setOutCcy(r.ccy);
      if (held) { setInAmt(String(r.total)); setOverride(false); setManualRate(''); setLock({ rate: r.amount / r.total, until: r.holdUntil, ref: r.ref }); }
      else { const est = Math.round(r.amount * sellUnitCad(r.ccy, settings) * 100) / 100; setInAmt(String(est)); setLock(null); setOverride(false); setManualRate(''); }
      const nm = r.name || tgContactName(r.phone);
      if (nm) { setCustomer(nm); setQuery(nm); }
      setMemo(m => m || ('Texts ' + r.ref + ' · ' + r.phone));
      setTq({ ref: r.ref, phone: r.phone, name: r.name, ccy: r.ccy, amount: r.amount, rate: r.rate, holdUntil: r.holdUntil, kind: r.kind, held });
      setTqErr(''); setTqIn(''); setTqOpen(false);
    };
    const applyTq = () => applyTqWith(tqIn);
    const clearTq = () => { setTq(null); setLock(null); setTqErr(''); setTqOpen(false); };
    // hand-pricing usually means the customer is showing a texted quote — offer the ref box
    useEffect(() => { if (override && !tq && (!phoneSheet || smsOn)) setTqOpen(true); }, [override, phoneSheet, smsOn, tq]);
    // a ref handed over by the Texts app (Start transaction) — apply on mount
    useEffect(() => { const p = window.__cdosTqPrefill; if (p) { window.__cdosTqPrefill = null; applyTqWith(String(p)); } }, []);

    const getServerQuote = async () => {
      if (!canSave || !window.CDOS.Backend) return;
      setServerBusy(true);
      setServerError('');
      try {
        const synced = await window.CDOS.Backend.syncCustomer(customer, rec);
        setClients(list => ({ ...list, [customer]: { ...(list[customer] || {}), ledgerCustomerId: synced.customerId, ledgerExternalRef: synced.externalRef } }));
        let quote = await window.CDOS.Backend.createQuote({
          customerId: synced.customerId,
          from: inCcy,
          to: outCcy,
          inputAmount: window.CDOS.Backend.asMoney(amtN),
          feeCad: window.CDOS.Backend.asMoney(feeN),
          /* Sell only when the customer is paid in the home currency.
             Neither side home, such as INR for USD on a CAD desk, is a cross. */
          direction: inCcy === home ? 'customer_buy_foreign' : outCcy === home ? 'customer_sell_foreign' : 'customer_cross',
        });
        const sentRate = typedRate || heldRateText;
        if (sentRate) {
          quote = await window.CDOS.Backend.overrideQuote(quote.quoteId, {
            customerRate: sentRate,
            reason: marginReason.trim() || (tq ? `Text quote ${tq.ref}` : 'Held rate'),
          });
        }
        setServerQuote(quote);
      } catch (error) {
        setServerError(error.message || 'The server quote could not be created.');
      } finally {
        setServerBusy(false);
      }
    };

    const postServerQuote = async () => {
      if (!serverQuote || serverBusy || !window.CDOS.Backend) return;
      setServerBusy(true);
      setServerError('');
      try {
        const packId = window.CDOS.deskPack && window.CDOS.deskPack() && window.CDOS.deskPack().packId;
        const serbia = packId === 'pack-rs-v1';
        const posted = await window.CDOS.Backend.postQuote(serverQuote.quoteId, {
          idempotencyKey: `web:${serverQuote.quoteId}`,
          purpose: purpose.trim(),
          sourceOfFunds: cap.source.trim(),
          thirdParty: !!cap.thirdParty,
          thirdPartyName: cap.thirdParty ? cap.thirdPartyName.trim() : undefined,
          identityNumber: identityNumber.trim() || undefined,
          ...(serbia && reportSuspicion ? { reportSuspicion: true } : {}),
          ...(serbia && outCcy === 'USD' && (usdLargeNotes === true || usdLargeNotes === false)
            ? {
                usdLargeNotes,
                usdNoteSerials: usdLargeNotes ? usdSerials.split(/[\s,]+/).filter(Boolean) : undefined,
              }
            : {}),
        });
        const row = window.CDOS.Backend.transactionToRow(posted, customer, { purpose: purpose.trim(), sourceOfFunds: cap.source.trim(), thirdParty: !!cap.thirdParty, thirdPartyName: cap.thirdParty ? cap.thirdPartyName.trim() : '' });
        setRows(current => window.CDOS.Backend.mergeRows(current, [row]));
        log('Transaction recorded', `${posted.transactionRef} · Exchange · ${customer} · ${posted.inputAmount} ${posted.from} · server ledger`);
        if (tq) { tgRedeem(tq.ref, posted.transactionRef); log('Text quote redeemed', tq.ref + ' → ' + posted.transactionRef + ' · ' + tq.phone); }
        if (onServerPosted) {
          try { await onServerPosted(); }
          catch (refreshError) { log && log('Ledger refresh failed', refreshError.message || 'The posted transaction will refresh on the next ledger open'); }
        }
        onDone && onDone(row.id);
      } catch (error) {
        if (error.code === 'QUOTE_EXPIRED' || error.code === 'QUOTE_NOT_ACTIVE') setServerQuote(null);
        setServerError(error.message || 'The transaction was not posted.');
      } finally {
        setServerBusy(false);
      }
    };

    /* ---- money order and bill payment reach the ledger ----

       Both are cash over the counter against a promise the desk then
       owes — a biller waiting to be remitted, a payee waiting to present
       an instrument — and both used to be a row in an array and nothing
       else. The drawer on the server never moved, so a day of them left
       the till and the book disagreeing by exactly what the shop had
       taken in.

       The ledger goes first and the browser row follows it. What is
       booked as earned is the fee and only the fee; the obligation is
       carried at the face the desk undertook to deliver. See
       docs/OBLIGATION_LINES.md.

       Deliberately narrow: this posts the two lines it names and leaves
       every other type on the path it was already on. A cheque is the
       other agent's, an exchange goes through the frozen-quote path
       above, and a remittance is posted from the Transfers app where its
       corridor, partner and beneficiary actually live. */
    const postObligationDeal = async (ref) => {
      const B = window.CDOS.Backend;
      const synced = await B.syncCustomer(customer, rec);
      setClients(list => ({ ...list, [customer]: { ...(list[customer] || {}), ledgerCustomerId: synced.customerId, ledgerExternalRef: synced.externalRef } }));
      const capture = { purpose: purpose.trim(), sourceOfFunds: cap.source.trim(), thirdParty: !!cap.thirdParty, thirdPartyName: cap.thirdParty ? cap.thirdPartyName.trim() : undefined };
      return isMO
        ? B.postMoneyOrder({
            idempotencyKey: 'web:mo:' + attemptKey(),
            customerId: synced.customerId,
            reference: ref,
            faceAmount: B.asMoney(amtN),
            feeAmount: B.asMoney(feeN),
            payee: payee.trim(),
            /* The desk's own reference stands in for the instrument's
               serial. This screen has no serial field — a money order is
               issued from a pre-printed book and its number is on the
               paper — so what is recorded is the reference the desk can
               actually produce, not a number nobody typed. Named as a
               missing field in docs/OBLIGATION_LINES.md. */
            serial: ref,
            ...capture,
          })
        : B.postBillPayment({
            idempotencyKey: 'web:bill:' + attemptKey(),
            customerId: synced.customerId,
            reference: ref,
            billAmount: B.asMoney(amtN),
            feeAmount: B.asMoney(feeN),
            biller: biller.trim(),
            accountRef: account.trim(),
            ...capture,
          });
    };

    /* ---- a cheque cashed from this ticket is the same cheque ----

       The Cheques desk posts to the ledger; this screen used to write a
       browser row and a local cheque record, so the very same act — a
       customer cashing a payroll cheque — reached the book from one
       screen and not from the other. That is not a missing feature, it
       is two implementations of one rule, and the drawer disagrees with
       itself depending on which door the customer came through.

       So it calls the SAME service, through the same module that owns
       the cheque record, and maps the server's answer with the same
       `fromServer` the register uses. Nothing about a cheque is decided
       here: the hold date, the reference and the net are the server's,
       and this screen contributes the capture the teller typed. See
       docs/CHEQUE_CASHING.md. */
    const postCheque = async () => {
      const book = _K.ledger();
      const synced = await window.CDOS.Backend.syncCustomer(customer.trim(), rec);
      setClients(list => ({ ...list, [customer]: { ...(list[customer] || {}), ledgerCustomerId: synced.customerId, ledgerExternalRef: synced.externalRef } }));
      const posted = await book.cashCheque({
        /* This ticket's key, not the clock. Two taps are one cashing.
           See attemptKey above — the same rule as a money order. */
        idempotencyKey: 'web-chq:' + attemptKey(),
        customerId: synced.customerId,
        chequeNumber: chequeNumber.trim(),
        maker: maker.trim(),
        draweeBank: draweeBank.trim() || undefined,
        chequeType: chequeType.id,
        typeLabel: chequeType.label,
        currency: home,
        faceAmount: window.CDOS.Backend.asMoney(amtN),
        feeAmount: window.CDOS.Backend.asMoney(chequeFee),
        holdDays: chequeType.holdDays || 0,
        endorsed: endorsed,
      });
      /* The image never leaves the browser — see the note in
         017_cheque_cashing.sql about not putting a megabyte of JPEG
         inside a SERIALIZABLE money transaction — so it is carried onto
         the mapped record rather than being lost on the way through. */
      const mapped = _K.fromServer(Object.assign({ customerName: customer.trim() }, posted.cheque));
      if (chequeImage) mapped.image = chequeImage;
      setCheques && setCheques(list => [mapped, ...(list || []).filter(c => c.chequeId !== mapped.chequeId)]);
      return { transactionId: posted.transactionId, transactionRef: posted.transactionRef, obligationId: null };
    };

    const record = async () => {
      if (!canSave || serverBusy) return;
      const seq = live.filter(r => r.date === TODAY).length + 1;
      let ref = mkRef(TODAY, seq);
      let posted = null;
      const chequeOnLedger = serverBacked && isCheque && _K && _K.ledger();
      if (chequeOnLedger) {
        setServerBusy(true);
        setServerError('');
        try {
          posted = await postCheque();
          ref = posted.transactionRef;
        } catch (error) {
          setServerError(error.message || 'The cheque was not cashed.');
          setServerBusy(false);
          return;
        }
        setServerBusy(false);
      } else if (serverBacked && (isMO || isBill) && window.CDOS.Backend) {
        setServerBusy(true);
        setServerError('');
        try {
          posted = await postObligationDeal(ref);
          ref = posted.transactionRef;
        } catch (error) {
          /* Nothing was written anywhere. There is no offline mode —
             docs/CASH_OWNERSHIP_INVARIANTS.md — so a deal the ledger
             refused is a deal that did not happen, and recording it here
             would be inventing money. */
          setServerError(error.message || 'The transaction was not posted.');
          setServerBusy(false);
          return;
        }
        setServerBusy(false);
      }
      const base = { ref, type, customer: customer || 'Walk-in (no client)', teller: me.name, createdBy: me.name, createdAt: stamp(),
        capture: single ? { purpose: purpose.trim(), source: cap.source.trim(), thirdParty: cap.thirdParty, thirdPartyName: cap.thirdPartyName.trim(), by: me.name, at: stamp() } : null,
        marginOverride: needOverride ? { by: me.name, at: stamp(), pct: +marginPct.toFixed(2), reason: marginReason.trim() } : null,
        thread: memo ? [{ ts: stamp(), user: me.name, text: memo }] : [], notes: memo };
      let tx;
      if (isExchange) {
        tx = newTx({ ...base, inCcy, inAmt: amtN, rate: rateN, outCcy, outAmt: pricing.outAmt, fee: feeN, midRate: pricing.midRate, spreadCad: pricing.marginCad, side: pricing.side, priced: override ? 'override' : (lockLive ? 'locked' : 'desk'), quoteRef: tq ? tq.ref : (lockLive ? lockLive.ref : null), quotePhone: tq ? tq.phone : null, quoteVia: tq ? 'texts' : null, marginPct: +marginPct.toFixed(2), profitCad, lockedUntil: lockLive ? new Date(lockLive.until).toLocaleString('en-CA', { hour12: false }).replace(',', '') : null });
      } else if (isSend) {
        tx = newTx({ ...base, beneficiary: `${benName.trim()} · ${dest.country}`, inCcy: home, inAmt: amtN, rate: rateN, outCcy: payoutCcy, outAmt: pricing.outAmt, fee: feeN, midRate: pricing.midRate, spreadCad: pricing.marginCad, side: pricing.side, marginPct: +marginPct.toFixed(2), profitCad, notes: purpose || memo });
      } else if (isReceive) {
        tx = newTx({ ...base, inCcy: outCcy, inAmt: amtN, rate: 1, outCcy, outAmt: amtN, fee: feeN, profitCad, notes: `Ref ${recvRef.trim()}${memo ? ' · ' + memo : ''}` });
      } else if (isCheque) {
        tx = newTx({ ...base, inCcy: home, inAmt: amtN, rate: 1, outCcy: home, outAmt: +(amtN - chequeFee).toFixed(2), fee: chequeFee, profitCad: chequeFee, notes: `${chequeType.label} cheque #${chequeNumber.trim()}${memo ? ' · ' + memo : ''}` });
      } else if (isMO) {
        tx = newTx({ ...base, beneficiary: payee.trim(), inCcy: home, inAmt: amtN, rate: 1, outCcy: home, outAmt: amtN, fee: feeN, profitCad: feeN, notes: `Money order to ${payee.trim()}${memo ? ' · ' + memo : ''}` });
      } else { // bill
        tx = newTx({ ...base, beneficiary: biller.trim(), inCcy: home, inAmt: amtN, rate: 1, outCcy: home, outAmt: amtN, fee: feeN, profitCad: feeN, notes: `Bill: ${biller.trim()} · acct ${account.trim()}${memo ? ' · ' + memo : ''}` });
      }
      /* Where the ledger holds it, the browser row carries the book's own
         names for the deal and for the promise it left behind, so the two
         can be joined. It carries no cash figure of its own. */
      if (posted) {
        tx.serverTransactionId = posted.transactionId;
        tx.serverObligationId = posted.obligationId;
      }
      // house auto-tag rules (Settings → Tagged) — applied once, as the deal posts
      const _atOver = +((settings || {}).autoTagOver) > 0 && collectCad != null && collectCad >= +settings.autoTagOver;
      const _atRiskLvl = (window.CDOS && window.CDOS.normalizeRisk) ? window.CDOS.normalizeRisk(rec && (rec.risk || rec.riskRating)) : (/enhanced|high/i.test(String((rec && (rec.risk || rec.riskRating)) || '')) ? 'High' : 'Normal');
      const _atRisk = !!(settings || {}).autoTagRisk && rec && (_atRiskLvl === 'Medium' || _atRiskLvl === 'High');
      const _atNew = !!(settings || {}).autoTagNew && customer && !live.some(o => o.customer === customer);
      if (_atOver || _atRisk || _atNew) {
        tx.tagged = true;
        tx.tagInfo = { by: 'Auto-rule', at: stamp(), note: _atOver ? `Auto-tagged: at/over ${fmt(+settings.autoTagOver, home)}` : _atRisk ? `Auto-tagged: ${rec.risk || 'risk'} risk client` : 'Auto-tagged: first deal for a new client' };
      }
      setRows(r => [tx, ...r]);
      /* The local cheque register is written HERE only when the ledger
         did not take it — `postCheque` above has already put the server's
         own record in place, and minting a second one beside it is the
         two-books problem in miniature. */
      if (isCheque && setCheques && _K && !posted) {
        const net = +(amtN - chequeFee).toFixed(2);
        const holdUntil = _K.addDays(TODAY, chequeType.holdDays || 0);
        const seqC = (cheques || []).filter(c => c.receivedDate === TODAY).length + 1;
        const cref = 'CHQ-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + String(seqC).padStart(3, '0');
        setCheques(listv => [{ id: 'c' + Date.now(), ref: cref, chequeNumber: chequeNumber.trim(), maker: maker.trim(), draweeBank: draweeBank.trim(), customer: customer || 'Walk-in (no client)', typeId: chequeType.id, typeLabel: chequeType.label, ccy: home, amount: amtN, feeCad: chequeFee, netCad: net, endorsed: endorsed, image: chequeImage, holdDays: chequeType.holdDays || 0, receivedDate: TODAY, holdUntil, status: 'held', nsf: false, fraud: false, timeline: [{ status: 'held', ts: stamp(), by: me.name, note: `Cashed at the till · ${(chequeType.holdDays || 0) === 0 ? 'no hold' : chequeType.holdDays + '-day hold'}${chequeImage ? ' · image on file' : ''}` }], txId: tx.id, txRef: ref, createdBy: me.name }, ...(listv || [])]);
      }
      log('Transaction recorded', `${ref} · ${meta.short} · ${customer || 'walk-in'} · ${num(amtN)} ${isExchange ? inCcy : home}${single ? ' · REPORTABLE' : ''}${needOverride ? ' · below-floor' : ''}`);
      if (tq && isExchange) { tgRedeem(tq.ref, ref); log('Text quote redeemed', tq.ref + ' → ' + ref + ' · ' + tq.phone); }
      /* The drawer just moved on the server, so the screen behind this
         modal is showing yesterday's figure until it is told. */
      if (posted && onServerPosted) {
        try { await onServerPosted(); }
        catch (refreshError) { log && log('Ledger refresh failed', refreshError.message || 'The drawer will refresh on the next ledger open'); }
      }
      onDone && onDone(tx.id);
    };

    // present-quote payload (exchange + send)
    const presentQ = isSend
      ? { biz: (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk', title: 'Send money', tag: `${dest.flag} ${dest.country}`, giveLbl: 'You pay', give: `${unitText(amtN, home)} ${home}`, rateLine: rateShown(home, payoutCcy, amtN, out.amt), rateNote: pricedRate(amtN, out.amt, payoutCcy).rounded ? RATE_NOTE : '', getLbl: `${benName || 'Beneficiary'} receives`, get: `${unitText(out.amt, payoutCcy)} ${payoutCcy}`, foot: feeN > 0 ? `Includes ${fmt(feeN, home)} fee` : 'No service fee' }
      : (serverQuote ? { biz: (settings && (settings.operatingName || settings.bizName)) || 'CurrencyDesk', title: 'Your quote', tag: serverQuote.buyOrSellSide === 'we_buy' ? `We buy ${serverQuote.from}` : serverQuote.buyOrSellSide === 'we_sell' ? `We sell ${serverQuote.to}` : `${serverQuote.from} → ${serverQuote.to}`, giveLbl: 'You give', give: `${unitText(serverQuote.inputAmount, serverQuote.from)} ${serverQuote.from}`, rateLine: `1 ${serverQuote.from} = ${(window.CDOS.frozenRateFace ? window.CDOS.frozenRateFace(serverQuote.customerRate, serverQuote.inputAmount, serverQuote.outputAmount) : { text: serverQuote.customerRate, rounded: false }).text} ${serverQuote.to}`, rateNote: (window.CDOS.frozenRateFace ? window.CDOS.frozenRateFace(serverQuote.customerRate, serverQuote.inputAmount, serverQuote.outputAmount) : { rounded: false }).rounded ? RATE_NOTE : '', getLbl: 'You receive', get: `${unitText(serverQuote.outputAmount, serverQuote.to)} ${serverQuote.to}`, foot: feeN > 0 ? `Includes ${fmt(feeN, home)} service fee` : 'Rate as quoted now' } : null);

    /* ---------------- render ---------------- */
    return ReactDOM.createPortal((
      <div className="cd-tx-overlay fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: (addFlow || quickChk || recordId) ? 8000 : 9200 }} onMouseDown={(addFlow || quickChk || recordId) ? undefined : requestClose}>
        <div ref={sheetRef} onMouseDown={e => e.stopPropagation()} className="cd-tx w-full flex flex-col" style={{ maxWidth: 940, maxHeight: 'calc(100vh - 32px)', background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 16, boxShadow: '0 24px 70px var(--cd-scrim)', overflow: 'hidden' }}>
          {/* header */}
          <div className="cd-tx-head flex-none flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 32, height: 32, background: CD.ink, borderRadius: 9 }}><Ic n={meta.icon} s={17} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>New transaction</div><div className="cd-tx-quiet text-[11px]" style={{ color: CD.mute }}>{meta.short} · {me.name} · {phoneSheet ? phoneDay(TODAY) : TODAY}</div></div></div>
            <button type="button" onClick={requestClose} aria-label="Close" className="cd-tx-x p-1.5" style={{ borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
          </div>

          {/* type selector. cd-tx-scroll is display:contents on a desk,
              so this bar stays a full-width row above the two columns.
              On a phone the scroll owns the bar, and the bar moves off
              with the fields instead of staying pinned. */}
          <div className="cd-tx-scroll">
          <div className="cd-tx-types-bar flex-none px-5 pt-3.5 pb-3" style={{ borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <div className="cd-tx-types grid gap-1.5" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
              {TYPE_LIST.map(t => { const on = type === t; const m = TYPE_META[t]; return (
                <button key={t} ref={on ? selectedChip : null} onClick={() => setType(t)} className={"flex flex-col items-center gap-1.5 py-2.5 px-1" + (on ? " is-on" : "")} style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 10, transition: 'all .12s' }}>
                  <Ic n={m.icon} s={18} c={on ? 'var(--cd-on-ink)' : CD.mute} />
                  <span className="text-[11px] font-medium leading-tight text-center" style={{ color: on ? 'var(--cd-on-ink)' : CD.ink }}>{m.short}</span>
                </button>); })}
            </div>
            <div className="cd-tx-blurb text-[12px] mt-2.5 flex items-center gap-1.5" style={{ color: CD.mute }}><Ic n={meta.icon} s={13} c={CD.mute} /> {meta.blurb}</div>
          </div>

          {/* body: form | rail.
              The cd-tx-* classes are how a phone stacks this. Under 600px,
              york-os.css puts the rail under the form. Wider than that
              the classes do not change the row. */}
          <div className="cd-tx-body flex-1 min-h-0 flex">
            {/* LEFT — the form */}
            <div className="cd-tx-form flex-1 min-w-0 overflow-auto px-5 py-4 space-y-4" style={{ borderRight: `1px solid ${CD.line}` }}>
              {/* customer (sender/purchaser/payer) */}
              <div data-req-field="cust" className={missField === 'cust' ? 'cd-tx-missing' : undefined}>
              <CustomerPicker label={custLabel} hint={idRequired ? 'ID required' : 'optional'} value={customer} query={query} setQuery={(v) => { setQuery(v); setCustomer(v); }} onPick={onPick} names={names} clients={clients} onAddNew={onAddNew} onClear={onClear} idRequired={idRequired} />
              </div>
              {window.CDOS.deskPack && window.CDOS.deskPack() && window.CDOS.deskPack().packId === 'pack-rs-v1' && type === 'Currency Exchange' && (
                <div data-testid="serbia-receipt" className="space-y-2">
                  <label data-testid="serbia-suspicion" className="flex items-start gap-2 text-[12px]" style={{ color: CD.ink }}>
                    <input type="checkbox" checked={reportSuspicion} onChange={e => setReportSuspicion(e.target.checked)} className="mt-0.5" />
                    <span>Report suspicion and do not post this deal. The desk saves a draft and does not send it to APML.</span>
                  </label>
                  <label className="block text-[12px]" style={{ color: CD.mute }}>
                    JMBG or passport number
                    <input data-testid="serbia-identity" value={identityNumber} onChange={e => setIdentityNumber(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none mt-1" style={inSty} />
                  </label>
                  {outCcy === 'USD' && (
                    <div data-testid="serbia-usd-notes">
                      <div className="text-[12px] mb-1" style={{ color: CD.mute }}>Does this sale include 50 or 100 US dollar notes?</div>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setUsdLargeNotes(true)} className="text-[12px] px-2.5 py-1.5" style={{ borderRadius: 7, border: `1px solid ${usdLargeNotes === true ? CD.ink : CD.line}`, background: usdLargeNotes === true ? CD.ink : 'transparent', color: usdLargeNotes === true ? 'var(--cd-on-ink)' : CD.ink }}>Yes</button>
                        <button type="button" onClick={() => setUsdLargeNotes(false)} className="text-[12px] px-2.5 py-1.5" style={{ borderRadius: 7, border: `1px solid ${usdLargeNotes === false ? CD.ink : CD.line}`, background: usdLargeNotes === false ? CD.ink : 'transparent', color: usdLargeNotes === false ? 'var(--cd-on-ink)' : CD.ink }}>No</button>
                      </div>
                      {usdLargeNotes === true && (
                        <input data-testid="serbia-serials" value={usdSerials} onChange={e => setUsdSerials(e.target.value)} placeholder="Serial numbers, separated by spaces" className="w-full text-sm px-2.5 py-2 outline-none mt-2" style={inSty} />
                      )}
                    </div>
                  )}
                </div>
              )}
              {customer && clients[customer] && <CustomerCard name={customer} rec={clients[customer]} live={live} settings={settings} />}
              {/* The customer's ID, where the teller actually is when the
                  question comes up. Covered until it is clicked, and the
                  click writes a server audit row — same component, same
                  rules, as the client file's. Renders nothing at all when
                  the name resolves to no record with a scan on it. */}
              {customer && window.CDOS.ClientIdViewer &&
                React.createElement(window.CDOS.ClientIdViewer, { name: customer, rec: clients[customer], log, compact: true })}
              {customer && clients[customer] && window.CDOS.KYC && window.CDOS.KYC.VerificationNudge && (!phoneSheet || personaOn) &&
                React.createElement(window.CDOS.KYC.VerificationNudge, { key: customer + ':' + single + ':' + idRequired, name: customer, rec: clients[customer], settings, amountCad: inCadEquiv, idRequired: idRequired && kyc !== 'ok', onRun: (tpl) => setQuickChk(tpl), onRecordId: leaveForId })}
              {/* Phone only, and display:none at a desk width so the 1280
                  dialog does not move. This is not an ID form. It opens
                  the client file's identity editor, which writes the
                  document — type, number, and expiry — on the server. */}
              {idRequired && String(customer || '').trim() && !idOk && (
                <div data-req-field="id" className={'cd-tx-id-need' + (missField === 'id' ? ' cd-tx-missing' : '')}>
                  <span className="cd-tx-id-need-label">ID needed for this amount</span>
                  <button type="button" onClick={() => setRecordId(true)} className="cd-tx-id-need-go">Record the ID</button>
                </div>
              )}
              {idRequired && idOk && (
                <div className="cd-tx-id-need">
                  <Ic n="checkcircle" s={14} c={CD.green} />
                  <span className="cd-tx-id-need-label">{(rec && rec.idType) || 'ID'} on file{rec && rec.idExpiry ? ` · exp ${phoneSheet ? phoneDay(rec.idExpiry) : rec.idExpiry}` : ''}</span>
                </div>
              )}

              {/* ---------------- EXCHANGE ---------------- */}
              {isExchange && (
                <div className="p-3.5" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <Lbl>Customer pays in</Lbl>
                  <div data-req-field="amt" className={missField === 'amt' ? 'cd-tx-missing' : undefined}>
                  <Money value={inAmt} onChange={setInAmt} ccy={inCcy} onCcy={(v) => { setInCcy(v); resetPricing(); }} big autoFocus />
                  </div>
                  <div className="py-2">
                    <div className="cd-tx-rate-line flex items-center justify-center gap-2">
                      <span data-side={dealSide || ''} className="cd-tx-side text-[10px] px-2 py-0.5 font-semibold uppercase tracking-wide" style={{ borderRadius: 5, background: dealSide === 'buy' ? CD.flagSoft : dealSide === 'sell' ? CD.greenSoft : CD.lineSoft, color: dealSide === 'buy' ? CD.flag : dealSide === 'sell' ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>{dealSide === 'buy' ? `We buy ${inCcy}` : dealSide === 'sell' ? `We sell ${outCcy}` : (dealSide === 'cross' ? 'Cross' : 'Rate')}</span>
                      <span className="cd-tx-rate-shown">{exchangeRateLine || (quotePending ? 'Pending' : '')}</span>
                      <button onClick={swap} title="Swap" aria-label="Swap" className="cd-tx-hit cd-tx-swap p-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7 }}><Ic n="swap" s={13} c={CD.mute} /></button>
                    </div>
                    <SheetRateNote on={liveFace.rounded} hold={quotePending} />
                  </div>
                  <Lbl>Customer receives</Lbl>
                  <Money value={shownOut ? unitText(shownOut, outCcy) : '—'} ccy={outCcy} onCcy={(v) => { setOutCcy(v); resetPricing(); }} readOnly accent={CD.green} mark="cd-tx-receive" big />
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <div className="cd-tx-rate-field"><Lbl hint={override ? 'hand-priced' : lockLive ? 'held' : 'as published · tap to edit'}>Board rate</Lbl><div className="flex items-center" style={{ ...inSty, borderColor: lockLive && !override ? CD.amber : override ? CD.ink : CD.line }}><input value={override ? manualRate : (heldRateText || serverRateText || 'Rate unavailable')} onFocus={() => { if (!override && !lockLive) { setManualRate(serverRateText); setOverride(true); } }} onChange={e => { setLock(null); setOverride(true); setManualRate(e.target.value); }} inputMode="decimal" title="Type to hand-price this deal" className="cd-tx-rate w-full text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink, cursor: 'text' }} />{lockLive && !override && <span className="px-1.5 flex-none flex items-center gap-1 text-[10px]" style={{ color: CD.amber, fontFamily: 'Space Mono, monospace' }}><Ic n="lock" s={11} c={CD.amber} />{lockClock}</span>}</div></div>
                    <div><Lbl>Fee ({home})</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="cd-tx-fee w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  </div>
                  <div className="flex items-center justify-between gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                    {tq
                      ? <span className="flex items-center gap-1.5 text-[11px]" style={{ color: '#8A4B2F', fontFamily: 'Space Mono, monospace' }}><Ic n="smartphone" s={12} c="#8A4B2F" />Priced by {tq.ref}</span>
                      : (!phoneSheet || smsOn) && <button onClick={() => { setTqOpen(o => !o); setTqErr(''); }} title="The customer got a quote by text — enter their ref and it fills this deal in" className="cd-tx-hit tg-send flex items-center gap-2 text-[12.5px] px-3.5 py-2 font-semibold" style={{ border: '1px solid #8A4B2F', background: tqOpen ? '#F2E6DD' : '#8A4B2F', color: tqOpen ? '#8A4B2F' : '#fff', borderRadius: 8 }}><Ic n="smartphone" s={14} c={tqOpen ? '#8A4B2F' : '#fff'} /> Text quote</button>}
                    <button onClick={() => { if (override) { setOverride(false); setManualRate(''); } else { setManualRate(serverRateText); setOverride(true); setLock(null); } }} title={override ? 'Back to the desk rate' : 'Hand-price this deal'} className="cd-tx-hit flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${override ? CD.ink : CD.line}`, background: override ? CD.ink : 'transparent', color: override ? 'var(--cd-on-ink)' : CD.ink, borderRadius: 7 }}><Ic n="pencil" s={11} c={override ? 'var(--cd-on-ink)' : CD.ink} /> {override ? 'Hand-priced' : 'Override'}</button>
                  </div>
                </div>
              )}

              {/* Texts hold redemption — pops in from the Text quote button, or when hand-pricing */}
              {isExchange && tq && (
                <div className="flex items-center gap-2.5 px-3 py-2.5 tg-bub" style={{ background: '#F2E6DD', border: '1px solid #E0CCBE', borderRadius: 12 }}>
                  <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: '50%', background: '#fff' }}><Ic n="smartphone" s={14} c="#8A4B2F" /></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{tq.ref}<span className="font-normal" style={{ fontFamily: 'Archivo', color: CD.mute }}> · {tq.name || tq.phone}{tq.name ? ' · ' + tq.phone : ''}</span></div>
                    <div className="text-[11px]" style={{ color: CD.mute }}>{tq.held ? (lockLive ? `Held rate applied — ${num(tq.amount)} ${tq.ccy} at the texted price. Posting marks it collected in Texts.` : 'The hold just expired — repriced at today’s board.') : 'Order pickup — today’s board rate applies. Posting marks it collected in Texts.'}</div>
                  </div>
                  <button onClick={clearTq} className="px-2.5 py-1.5 text-[11px] flex-none" style={{ border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 7, background: 'transparent' }}>Detach</button>
                </div>
              )}
              {isExchange && !tq && tqOpen && (
                <div className="px-3 py-2.5 tg-bub" style={{ background: 'var(--cd-panel)', border: '1px dashed #E0CCBE', borderRadius: 12 }}>
                  <div className="flex items-start gap-2 mb-2">
                    <Ic n="smartphone" s={14} c="#8A4B2F" />
                    <span className="text-[11px] flex-1 min-w-0" style={{ color: CD.mute }}><b style={{ color: CD.ink }}>The customer has a texted quote.</b> They asked your website for a rate and got it by SMS with a ref like TQ-1044. Enter it — their held rate, amounts and name fill in, and posting marks it collected.</span>
                    <button onClick={() => { setTqOpen(false); setTqErr(''); }} title="Close" className="p-1 flex-none" style={{ borderRadius: 6 }}><span style={{ display: 'inline-flex', transform: 'rotate(45deg)' }}><Ic n="plus" s={13} c={CD.faint} /></span></button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input autoFocus value={tqIn} onChange={e => { setTqIn(e.target.value); setTqErr(''); }} onKeyDown={e => { if (e.key === 'Enter') applyTq(); }} placeholder="TQ-1044" className="text-[12.5px] px-2.5 py-1.5 outline-none flex-none" style={{ border: `1px solid ${tqErr ? CD.flag : CD.line}`, borderRadius: 7, fontFamily: 'Space Mono, monospace', width: 120, background: 'var(--cd-panel)', letterSpacing: '0.03em' }} />
                    <button onClick={applyTq} disabled={!tqIn.trim()} className="tg-send px-3.5 py-1.5 text-[12px] font-semibold flex-none" style={{ background: tqIn.trim() ? CD.ink : CD.lineSoft, color: tqIn.trim() ? 'var(--cd-on-ink)' : CD.faint, borderRadius: 7 }}>Fill it in</button>
                    <span className="text-[11px] flex-1 min-w-0 truncate" style={{ color: tqErr ? CD.flag : CD.faint }}>{tqErr || 'Any format works — the last digits are enough.'}</span>
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
                    <Lbl>Customer pays ({home})</Lbl>
                    <Money value={inAmt} onChange={setInAmt} ccy={home} big autoFocus />
                    <div className="py-2">
                      <div className="flex items-center justify-center gap-2 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}><Ic n="arrowdown" s={13} c={CD.faint} /> {rateShown(home, payoutCcy, amtN, out.amt)}</div>
                      <SheetRateNote on={pricedRate(amtN, out.amt, payoutCcy).rounded} />
                    </div>
                    <Lbl>{benName || 'Beneficiary'} receives</Lbl>
                    <Money value={out.amt ? unitText(out.amt, payoutCcy) : '—'} ccy={payoutCcy} readOnly accent={CD.green} big />
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div><Lbl>Fee ({home})</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
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
                  <div><Lbl>Fee ({home})</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                </div>
              )}

              {/* ---------------- CHEQUE ---------------- */}
              {isCheque && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div><Lbl hint={`${chequeType.feePct}% · min ${fmt(chequeType.feeMin, home)} · ${chequeType.holdDays}d hold`}>Cheque type</Lbl>
                    <div className="flex flex-wrap gap-1.5">{chequeSched.map(t => { const on = chequeTypeId === t.id; return <button key={t.id} onClick={() => setChequeTypeId(t.id)} className="px-2.5 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', color: on ? 'var(--cd-on-ink)' : CD.text }}>{t.label}</button>; })}</div>
                  </div>
                  <div><Lbl>Cheque amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy={home} big autoFocus /></div>
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
                  <div className="flex items-center gap-2 p-2.5" style={{ background: CD.amberSoft, borderRadius: 9 }}><span className="text-[11px]" style={{ color: 'var(--cd-brass-text)' }}>{amtN > 0 ? <>Front <b>{fmt(out.amt, home)}</b> · keep <b>{fmt(chequeFee, home)}</b>{(chequeType.holdDays || 0) > 0 && _K ? <> · holds to {_K.addDays(TODAY, chequeType.holdDays)}</> : ' · no hold'}</> : 'Enter the cheque amount'}</span></div>
                </div>
              )}

              {/* ---------------- MONEY ORDER ---------------- */}
              {isMO && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div><Lbl>Payee</Lbl><input value={payee} onChange={e => setPayee(e.target.value)} placeholder="Who the money order is for" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  <div><Lbl>Face amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy={home} big autoFocus /></div>
                  <div><Lbl>Fee ({home})</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  {amtN > 0 && <div className="text-[11px] px-3 py-2" style={{ background: CD.lineSoft, borderRadius: 9, color: CD.mute }}>Customer pays <b style={{ color: CD.ink }}>{fmt(amtN + feeN, home)}</b> for a <b style={{ color: CD.ink }}>{fmt(amtN, home)}</b> money order.</div>}
                </div>
              )}

              {/* ---------------- BILL PAYMENT ---------------- */}
              {isBill && (
                <div className="p-3.5 space-y-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Lbl>Biller</Lbl><input value={biller} onChange={e => setBiller(e.target.value)} placeholder="e.g. Toronto Hydro" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                    <div><Lbl>Account number</Lbl><input value={account} onChange={e => setAccount(e.target.value)} placeholder="Biller account #" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
                  </div>
                  <div><Lbl>Amount</Lbl><Money value={inAmt} onChange={setInAmt} ccy={home} big autoFocus /></div>
                  <div><Lbl>Fee ({home})</Lbl><input value={fee} onChange={e => setFee(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, fontVariantNumeric: 'tabular-nums' }} /></div>
                  {amtN > 0 && <div className="text-[11px] px-3 py-2" style={{ background: CD.lineSoft, borderRadius: 9, color: CD.mute }}>Customer pays <b style={{ color: CD.ink }}>{fmt(amtN + feeN, home)}</b> — {fmt(amtN, home)} to biller, {fmt(feeN, home)} fee.</div>}
                </div>
              )}

              {/* reportable capture — shown for every type at/over the line */}
              {single && (
                <div data-req-field="facts" className={'p-3.5 space-y-2.5' + (missField === 'facts' ? ' cd-tx-missing' : '')} style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.flag}`, borderRadius: 12 }}>
                  <div className="flex items-center gap-1.5"><Ic n="filetext" s={14} c={CD.flag} /><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Reportable — capture for the {regime.largeCode}</span></div>
                  <div className="text-[11px]" style={{ color: CD.mute }}>This deal is ≥ {limit.label}. Capture now while the customer is here — it pre-fills the filing.</div>
                  <div><Lbl>Purpose of transaction</Lbl><input value={purpose} onBlur={() => markTouched('purpose')} onChange={e => setPurpose(e.target.value)} placeholder={purposePh} className="cd-tx-purpose w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: openBorder('purpose', !!purpose.trim()) }} /></div>
                  <div><Lbl>Source of funds</Lbl><input value={cap.source} onBlur={() => markTouched('source')} onChange={e => setCap(s => ({ ...s, source: e.target.value }))} placeholder={sourcePh} className="cd-tx-source w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: openBorder('source', !!cap.source.trim()) }} /></div>
                  <div><Lbl>Acting for someone else?</Lbl>
                    <div className="cd-tx-pair flex items-center gap-2">
                      <div className="inline-flex flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{[['no', 'No'], ['yes', 'Yes']].map(([v, l], i) => { const on = (cap.thirdParty ? 'yes' : 'no') === v; return <button key={v} onClick={() => setCap(s => ({ ...s, thirdParty: v === 'yes' }))} className="text-xs px-3 py-1.5" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none' }}>{l}</button>; })}</div>
                      {cap.thirdParty && <input value={cap.thirdPartyName} onChange={e => setCap(s => ({ ...s, thirdPartyName: e.target.value }))} placeholder="Name of that person / entity" className="flex-1 min-w-0 text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: cap.thirdPartyName.trim() ? CD.line : CD.flag }} />}
                    </div>
                  </div>
                </div>
              )}

              {serverBacked && isExchange && !single && (
                <div data-req-field="facts" className={'p-3.5 space-y-2.5' + (missField === 'facts' ? ' cd-tx-missing' : '')} style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="cd-tx-facts-intro flex items-center gap-1.5"><Ic n="shield" s={14} c={CD.green} /><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Authoritative ledger record</span></div>
                  <div className="cd-tx-facts-intro text-[11px]" style={{ color: CD.mute }}>Required for server posting and the permanent audit trail.</div>
                  <div><Lbl>Purpose of transaction</Lbl><input value={purpose} onBlur={() => markTouched('purpose')} onChange={e => setPurpose(e.target.value)} placeholder={purposePh} className="cd-tx-purpose w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: openBorder('purpose', !!purpose.trim()) }} /></div>
                  <div><Lbl>Source of funds</Lbl><input value={cap.source} onBlur={() => markTouched('source')} onChange={e => setCap(s => ({ ...s, source: e.target.value }))} placeholder={sourcePh} className="cd-tx-source w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, borderColor: openBorder('source', !!cap.source.trim()) }} /></div>
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
              <div><Lbl>Note (optional)</Lbl><input value={memo} onChange={e => setMemo(e.target.value)} placeholder={notePh} className="cd-tx-note w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></div>
            </div>

            {/* RIGHT — ticket + checklist */}
            <div className="cd-tx-rail flex-none flex flex-col" style={{ width: 320, background: 'var(--cd-chip)' }}>
              <div className="cd-tx-rail-scroll flex-1 overflow-auto p-4 space-y-3">
                {/* deal ticket */}
                <div className="cd-tx-ticket" style={{ background: CD.ink, borderRadius: 12, padding: 16, color: 'var(--cd-on-ink)' }}>
                  <div className="flex items-center justify-between" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)', paddingBottom: 10 }}>
                    <span className="cd-tx-kicker" style={{ fontFamily: 'Space Mono, monospace', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cd-on-ink-soft)' }}>{meta.short}</span>
                    <Ic n={meta.icon} s={14} c="var(--cd-on-ink-soft)" />
                  </div>
                  <div style={{ padding: '12px 0' }}>
                    <div style={{ fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? 'Customer gives' : isCheque ? 'Cheque face' : isReceive ? 'Pay out' : 'Customer pays'}</div>
                    <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{phoneSheet ? phoneMoney(amtN > 0 ? (isExchange || isCheque || isReceive ? amtN : amtN + feeN) : 0, isExchange ? inCcy : isReceive ? out.ccy : home) : <>{amtN > 0 ? unitText(isExchange || isCheque || isReceive ? amtN : amtN + feeN, isExchange ? inCcy : isReceive ? out.ccy : home) : '0'} <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? inCcy : isReceive ? out.ccy : home}</span></>}</div>
                  </div>
                  {(isExchange || isSend || isCheque) && <div className="flex items-center gap-2 py-1" style={{ color: 'var(--cd-on-ink-faint)' }}><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span><Ic n="arrowdown" s={13} c="var(--cd-on-ink-soft)" /><span style={{ flex: 1, borderTop: '1px dashed var(--cd-on-ink-faint)' }}></span></div>}
                  <div style={{ paddingTop: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>{isExchange ? 'Customer receives' : isSend ? `${benName || 'Beneficiary'} gets` : isCheque ? 'Cash out' : isReceive ? 'Recipient gets' : isMO ? 'Money order' : 'To biller'}</div>
                    <div className="cd-tx-ticket-get" style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', color: '#7fd1a3', lineHeight: 1.1 }}>{isExchange && shownOut == null ? 'Pending' : phoneSheet ? phoneMoney(shownOut || 0, out.ccy) : <>{shownOut ? unitText(shownOut, out.ccy) : '0'} <span style={{ fontWeight: 500, fontSize: 15, color: 'rgba(127,209,163,0.7)' }}>{out.ccy}</span></>}</div>
                  </div>
                  <div style={{ borderTop: '1px solid var(--cd-on-ink-faint)', marginTop: 12, paddingTop: 10, fontSize: 11, color: 'var(--cd-on-ink-soft)' }}>
                    <div className="flex items-center justify-between">
                      <span className="cd-tx-kicker">{isExchange ? <span className="cd-tx-rate-shown">{exchangeRateLine || (quotePending ? 'Pending' : '')}</span> : isSend ? rateShown(home, out.ccy, amtN, out.amt) : isCheque ? `${chequeType.holdDays || 0}d hold` : 'Face value'}</span>
                      <span>{isCheque ? `fee ${fmt(chequeFee, home)}` : feeN > 0 ? `fee ${fmt(feeN, home)}` : 'no fee'}</span>
                    </div>
                    {isSend && pricedRate(amtN, out.amt, out.ccy).rounded ? <div className="cd-rate-note" style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cd-note-on-ink)', marginTop: 4 }}>{RATE_NOTE}</div> : null}
                  </div>
                </div>

                {/* margin chip (exchange/send only) */}
                {((isExchange && liveQuote) || isSend) && amtN > 0 && (
                  <div className="flex items-center justify-between px-3 py-2" style={{ background: 'var(--cd-panel)', border: `1px solid ${belowFloor ? CD.flag : CD.line}`, borderRadius: 10 }}>
                    <span className="cd-tx-kicker text-[11px] flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="activity" s={12} c={belowFloor ? CD.flag : marginPct >= mTarget ? CD.green : CD.amber} /> {phoneSheet ? 'Margin' : 'MARGIN'}</span>
                    <span className="text-[12px] font-bold" style={{ color: belowFloor ? CD.flag : marginPct >= mTarget ? CD.green : CD.amber, fontVariantNumeric: 'tabular-nums' }}>{fmt(profitCad, home)} · {marginPct.toFixed(2)}%</span>
                  </div>
                )}

                {/* the checklist */}
                <div className="px-3.5 py-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12 }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="cd-tx-kicker cd-tx-quiet text-[10px] uppercase tracking-wider font-semibold" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Before you post</span>
                    <span className="cd-tx-kicker cd-tx-quiet text-[10px] px-1.5 py-0.5" style={{ borderRadius: 999, background: allGreen ? CD.greenSoft : CD.lineSoft, color: allGreen ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>{allGreen ? (phoneSheet ? 'Ready' : 'READY') : (phoneSheet ? `${remaining} left` : `${remaining} LEFT`)}</span>
                  </div>
                  {reqs.map(r => <Check key={r.key} ok={r.ok} warn={r.warn && !r.ok} label={r.label} sub={!r.ok ? r.sub : null} mark={phoneSheet && missKey === r.key} onActivate={phoneSheet && r.key === 'server-facts' && !r.ok ? focusFacts : undefined} action={phoneSheet && r.key === 'id' && !r.ok && customer ? <button type="button" onClick={() => setRecordId(true)} className="cd-tx-id-need-go mt-1">Record the ID</button> : null} />)}
                </div>

                {/* compliance note */}
                {(single || structuring) && (
                  <div className="px-3 py-2.5 text-[11px] flex items-start gap-2" style={{ background: single ? CD.flagSoft : CD.amberSoft, borderRadius: 10, color: single ? CD.flag : 'var(--cd-brass-text)' }}>
                    <Ic n="shield" s={13} c={single ? CD.flag : 'var(--cd-brass-text)'} />
                    <span>{single ? `Reportable — a ${regime.largeCode} will be required.` : `Structuring watch — ${customer}'s ${settings.structuringDays}-day total reaches ${fmt(recentTotal, home)}.`}</span>
                  </div>
                )}
              </div>

              {/* rail footer actions */}
              <div className="cd-tx-actions flex-none p-3 space-y-2" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
                {(isExchange || isSend) && <button onClick={() => presentQ && setPresent(true)} disabled={isExchange ? !serverQuote : !(amtN > 0 && rateN > 0)} className="w-full flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: (isExchange ? serverQuote : (amtN > 0 && rateN > 0)) ? CD.ink : CD.faint }}><Ic n="smartphone" s={15} /> Show customer the quote</button>}
                {/* A refusal from the ledger, wherever it came from. The
                    exchange path has its own copy inside the branch
                    below; this one is for the lines that post through
                    `record` — a money order or a bill payment the server
                    turned down, where the teller would otherwise get a
                    button that simply did nothing. */}
                {serverError && !isExchange && <div role="alert" className="px-3 py-2 text-[11px]" style={{ background: CD.flagSoft, borderRadius: 9, color: CD.flag }}><b>Nothing was posted.</b> {serverError}</div>}
                {/* The phone sheet already offers Record the ID in the
                    scroll. A second button in this bar makes the footer
                    taller than the phone layout allows. */}
                {showRecordId && !phoneSheet && <button type="button" data-testid="record-id" onClick={leaveForId} className="w-full flex items-center justify-center gap-1.5 py-2 text-[13px] font-semibold" style={{ borderRadius: 9, background: CD.ink, color: 'var(--cd-on-ink)' }}>Record ID</button>}
                {serverBacked && isExchange ? <>
                  {serverQuote && <div className="px-3 py-2 text-[11px]" style={{ background: CD.greenSoft, borderRadius: 9, color: CD.green }}>
                    Frozen quote · {unitText(serverQuote.inputAmount, serverQuote.from)} {serverQuote.from} → {unitText(serverQuote.outputAmount, serverQuote.to)} {serverQuote.to} · expires {new Date(serverQuote.expiresAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>}
                  {serverError && <div role="alert" className="px-3 py-2 text-[11px]" style={{ background: CD.flagSoft, borderRadius: 9, color: CD.flag }}>{serverError}</div>}
                  {phoneSheet && !allGreen
                    ? <button type="button" onClick={showMissing} disabled={quotePending} className="cd-tx-go w-full flex items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold" style={{ borderRadius: 9, background: quotePending ? CD.line : CD.ink, color: quotePending ? CD.faint : 'var(--cd-on-ink)' }}><Ic n="lock" s={15} c="currentColor" /> {stepsLabel}</button>
                    : <button onClick={serverQuote ? postServerQuote : getServerQuote} disabled={!canSave || serverBusy || quotePending} className="cd-tx-go w-full flex items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold" style={{ borderRadius: 9, background: (!canSave || serverBusy || quotePending) ? CD.line : CD.ink, color: (!canSave || serverBusy || quotePending) ? CD.faint : 'var(--cd-on-ink)' }}>
                        <Ic n={serverQuote ? 'check' : 'lock'} s={15} c="currentColor" /> {serverBusy ? 'Working…' : serverQuote ? 'Post frozen quote' : allGreen ? 'Get server quote' : `${remaining} to complete`}
                      </button>}
                </> : phoneSheet && !allGreen
                  ? <button type="button" onClick={showMissing} className="cd-tx-go w-full flex items-center justify-center gap-1.5 py-2.5 text-[13px] font-semibold" style={{ borderRadius: 9, background: CD.ink, color: 'var(--cd-on-ink)' }}>{stepsLabel}</button>
                  : <CommitBtn onCommit={record} disabled={!canSave} icon="check" label={allGreen ? 'Record transaction' : `${remaining} to complete`} doneLabel="Recorded" title="Post this transaction to the ledger" className="cd-tx-go w-full justify-center" style={{ padding: '0.65rem 1rem', fontSize: 14 }} />}
                <button onClick={onClose} className="cd-tx-cancel w-full py-2 text-[12px]" style={{ color: CD.mute }}>Cancel</button>
              </div>
            </div>
          </div>
          </div>
          {discardAsk && (
            <div className="cd-tx-discard" onMouseDown={e => { e.stopPropagation(); setDiscardAsk(false); }}>
              <div role="dialog" aria-label="Discard this deal?" onMouseDown={e => e.stopPropagation()} className="cd-tx-discard-sheet">
                <div className="text-[15px] font-semibold" style={{ color: CD.ink }}>Discard this deal?</div>
                <div className="text-[12.5px] mt-1" style={{ color: CD.mute }}>What you entered on this ticket will be lost.</div>
                <div className="flex flex-col gap-2 mt-4">
                  <button type="button" onClick={onClose} className="cd-tx-discard-yes w-full text-sm font-semibold" style={{ background: CD.flag, color: '#fff', borderRadius: 9, minHeight: 44 }}>Discard</button>
                  <button type="button" onClick={() => setDiscardAsk(false)} className="w-full text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'var(--cd-panel)', minHeight: 44 }}>Keep editing</button>
                </div>
              </div>
            </div>
          )}
        </div>
        {present && presentQ && <PresentQuote q={presentQ} onClose={() => setPresent(false)} />}
        {addFlow && window.CDOS.KYC && React.createElement(window.CDOS.KYC.NewContactFlow, { initialName: (customer || query).trim(), by: me.name, setClients, requireId: idRequired, onClose: () => setAddFlow(false), onDone: (nm) => { setCustomer(nm); setQuery(nm); setAddFlow(false); } })}
        {recordId && window.CDOS.RecordIdSheet && React.createElement(window.CDOS.RecordIdSheet, { name: String(customer || '').trim(), rec: clients[customer] || null, setClients, log, onClose: () => setRecordId(false), onDone: () => setRecordId(false) })}
        {quickChk && window.CDOS.KYC && React.createElement(window.CDOS.KYC.SendModal, { subject: customer, kind: (clients[customer] && clients[customer].kind) || 'individual', rec: clients[customer], by: me.name, initialTpl: quickChk, onClose: () => setQuickChk(null) })}
      </div>
    ), document.body);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { TxModal });
})();
