/* ============================================================
   CurrencyDesk OS — desktop shell
   Window manager (drag / focus / minimise / resize), lock + 2FA
   login, menu bar, app sub-bar, and the shared data model that
   every module window reads from.
   ============================================================ */
(function () {
  const { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } = React;
  const {
    CD, Ic, STAFF, ROLE_CAPS, ROLE_SCOPE, seedRows, seedClients, perCadLive, crossRate, TODAY, fmt,
    computeFlags, computeAlerts, publishedBook, applyBook, bookSig,
    Ledger, Clients, Dashboard, TillDrawer, Audit, SettingsView, Calc, ReceiptModal, Tagged,
    Assistant, LoanCalc, AppStore, COMING, STORE_DESC, Reports, Vault, Transfers, Cheques, Compliance, Branches, APP_ACCENT, Pricing, Telegraph
  } = window.CDOS;

  const APPMETA = {
    rates:     { title: 'Rate Board',      icon: 'rateboard', w: 1060, h: 660 },
    telegraph: { title: 'Texts',           icon: 'telegraphbubble', w: 1120, h: 700 },
    ledger:    { title: 'Ledger',          icon: 'ledgerbook', w: 1040, h: 600 },
    transfers: { title: 'Transfers',       icon: 'transferarrows', w: 1040, h: 660 },
    cheques:   { title: 'Cheques',         icon: 'cheque', w: 940, h: 640 },
    compliance:{ title: 'Compliance',      icon: 'complianceshield', w: 960, h: 660 },
    clients:   { title: 'Clients · KYC',   icon: 'clientskyc',  w: 760,  h: 560 },
    dashboard: { title: 'Dashboard',       icon: 'dashboardgrid',   w: 900,  h: 560 },
    till:      { title: 'Cash Drawer', icon: 'tilldrawer', w: 900, h: 580 },
    vault:     { title: 'Cash on Hand · Vault', icon: 'vaultsafe', w: 1000, h: 680 },
    branches:  { title: 'Branch Network',  icon: 'branchnet', w: 1040, h: 660 },
    audit:     { title: 'Audit Trail',     icon: 'audittrail', w: 860,  h: 580 },
    calc:      { title: 'Calculator',      icon: 'calcdevice',   w: 340,  h: 560 },
    loan:      { title: 'Loan Centre', icon: 'loancentre', w: 780, h: 600 },
    reports:   { title: 'Reports',         icon: 'reportsdoc', w: 920, h: 680 },
    pricing:   { title: 'Pricing & Rates', icon: 'pricingpercent', w: 1000, h: 700 },
    assistant: { title: 'AI Assistant',    icon: 'aispark', w: 560, h: 660 },
    tagged:    { title: 'Tagged',          icon: 'taggedbookmark', w: 720, h: 560 },
    settings:  { title: 'Settings',        icon: 'gearsettings',   w: 640,  h: 520 }
  };
  const APP_ORDER = ['rates', 'telegraph', 'ledger', 'transfers', 'cheques', 'clients', 'compliance', 'reports', 'pricing', 'dashboard', 'assistant', 'till', 'vault', 'branches', 'audit', 'calc', 'loan', 'tagged', 'settings'];
  // the storefront opens as a window
  APPMETA.store = { title: 'Store', icon: 'storefront', w: 860, h: 640 };
  const AUTH_KEY = 'yorkfx_staff_auth';

  /* ====================== WINDOW ====================== */
  function Win({ win, meta, active, nav, onFocus, onClose, onMin, onZoom, onDrag, onResize, onSnap, onAdd, children }) {
    const drag = useRef(null);
    const [shown, setShown] = useState(false);
    const [barHidden, setBarHidden] = useState(false);
    const [tileMenu, setTileMenu] = useState(false);
    const [menuPos, setMenuPos] = useState(null);
    const tileRef = useRef(null);
    const menuRef = useRef(null);
    useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
    // show the title bar on launch, then let it retract to a sliver after a beat
    useEffect(() => { const t = setTimeout(() => setBarHidden(true), 2600); return () => clearTimeout(t); }, []);
    useEffect(() => { if (!tileMenu) return; const h = (e) => { if (tileRef.current && tileRef.current.contains(e.target)) return; if (menuRef.current && menuRef.current.contains(e.target)) return; setTileMenu(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [tileMenu]);
    const openTile = (e) => {
      e.stopPropagation(); onFocus(win.id);
      if (tileMenu) { setTileMenu(false); return; }
      const r = e.currentTarget.getBoundingClientRect();
      setMenuPos({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) });
      setTileMenu(true);
    };
    const snap = (region) => { onSnap(win.id, region); setTileMenu(false); };
    const startDrag = (e) => {
      if (e.target.closest('.win-tb-btn') || e.target.closest('.win-back') || e.target.closest('.win-rtools')) return;
      if (win.max) return;                 // maximised windows don't drag
      onFocus(win.id);
      drag.current = { sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y };
      const move = (ev) => { const d = drag.current; if (!d) return; onDrag(win.id, Math.max(0, d.ox + ev.clientX - d.sx), Math.max(0, d.oy + ev.clientY - d.sy)); };
      const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    const startResize = (dir) => (e) => {
      e.stopPropagation(); e.preventDefault(); onFocus(win.id);
      const s = { sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h };
      const move = (ev) => {
        const dx = ev.clientX - s.sx, dy = ev.clientY - s.sy;
        const box = {};
        if (dir.indexOf('e') >= 0) box.w = Math.max(300, s.ow + dx);
        if (dir.indexOf('s') >= 0) box.h = Math.max(200, s.oh + dy);
        if (dir.indexOf('w') >= 0) { const nw = Math.max(300, s.ow - dx); box.w = nw; box.x = Math.max(0, s.ox + (s.ow - nw)); }
        onResize(win.id, box);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    return (
      <div className={'win' + (shown ? ' show' : '') + (active ? ' active' : '') + (win.max ? ' max' : '') + (barHidden ? ' bar-hidden' : '')} onPointerDown={() => onFocus(win.id)}
        style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}>
        <div className="win-bar" onPointerDown={startDrag} onDoubleClick={(e) => { if (!e.target.closest('.win-tb-btn') && !e.target.closest('.win-back') && !e.target.closest('.win-rtools')) onZoom(win.id); }}>
          <div className="win-lights">
            <button className="win-tb-btn win-close" title="Close" onClick={() => onClose(win.id)}></button>
            <button className="win-tb-btn win-min" title="Minimise" onClick={() => onMin(win.id)}></button>
            <button className="win-tb-btn win-zoom" title={win.max ? 'Restore' : 'Zoom'} onClick={() => onZoom(win.id)}></button>
          </div>
          {nav && nav.canBack && <button className="win-back" title="Back" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); nav.back(); }}><Ic n="arrowleft" s={14} c="currentColor" /></button>}
          <span className="win-title"><i className="win-dot" style={{ background: meta.accent || 'var(--ink)' }}></i>{meta.title}</span>
          <div className="win-rtools">
            <button className="win-tool" title="Open another window of this app (a live mirror)" onClick={(e) => { e.stopPropagation(); onAdd(win.id); }}><Ic n="plus" s={15} c="currentColor" /></button>
            <div className="win-tile-wrap" ref={tileRef}>
              <button className="win-tile" title="Tile window — snap to a corner or half" onClick={openTile}><Ic n="grid4" s={14} c="currentColor" /></button>
            </div>
          </div>
        </div>
        {tileMenu && menuPos && ReactDOM.createPortal(
          <div className="win-tile-menu" ref={menuRef} style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 100000 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="wt-cap">Tile window</div>
            <div className="wt-grid">
              {[['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([r, l]) => (
                <button key={r} className={'wt-cell wt-' + r} title={l} onClick={() => snap(r)}></button>
              ))}
            </div>
            <div className="wt-row">
              <button className="wt-btn" title="Left half" onClick={() => snap('left')}>Left</button>
              <button className="wt-btn" title="Right half" onClick={() => snap('right')}>Right</button>
              <button className="wt-btn" title="Fill desktop" onClick={() => snap('full')}>Full</button>
            </div>
          </div>, document.body)}
        <div className="win-body" data-screen-label={meta.title}>{children}</div>
        {!win.max && <>
          <div className="win-rz win-rz-e" onPointerDown={startResize('e')}></div>
          <div className="win-rz win-rz-w" onPointerDown={startResize('w')}></div>
          <div className="win-rz win-rz-s" onPointerDown={startResize('s')}></div>
          <div className="win-rz win-rz-sw" onPointerDown={startResize('sw')}></div>
          <div className="win-resize" onPointerDown={startResize('se')}></div>
        </>}
      </div>
    );
  }

  /* ====================== LOCK + 2FA ======================
     One door for the whole business (§04 of the Branch & Access Model spec):
     the staff ID resolves a real employee record, and role + assignments —
     not the person — decide where they land after 2FA. */
  function Lock({ employees, onNext, onSignup }) {
    const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState('');
    const dir = (employees || []).filter(e => e.active !== false);
    const resolve = (raw) => { const q = raw.trim().toLowerCase(); return dir.find(e => (e.code || '').toLowerCase() === q) || dir.find(e => e.name.toLowerCase() === q) || null; };
    const submit = async (e) => {
      e.preventDefault(); if (!u.trim()) { setErr('Enter your staff ID.'); return; }
      let rec = resolve(u);
      if (!p) { setErr('Enter your password.'); return; }
      // backend auth: when the API is reachable it is the door — each person
      // signs in with their OWN password (set by a manager in Settings →
      // Employees). Standalone (no backend at all) keeps the offline demo
      // flow so the prototype still works from a static server.
      setErr('Checking\u2026 (first sign-in of the day can take ~30s while the server wakes)');
      let mustChange = false;
      let srvPlan = null;   // the tenant's purchased tier, from the server
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId: rec ? (rec.code || rec.name) : u.trim().toLowerCase(), password: p }),
        });
        if (res && res.status === 401) { setErr('Wrong staff ID or password' + (rec ? ' for ' + (rec.code || rec.name) : '') + '. Check both and try again \u2014 or ask a manager to reset your password.'); return; }
        if (res && !res.ok) { setErr('Sign-in service error (' + res.status + ') \u2014 try again in a moment.'); return; }
        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          mustChange = !!(data && data.user && data.user.mustChangePassword);
          srvPlan = (data && data.user && data.user.plan) || null;
          // the server vouches for this person even when this device's local
          // directory doesn't know them yet (account created on another
          // terminal) — adopt a local record so the OS can route them
          if (!rec && data && data.user) {
            const SRV2OS = { administrator: 'Owner', branch_manager: 'Manager', supervisor: 'Senior teller', compliance_officer: 'Manager', teller: 'Cashier', auditor: 'Trainee' };
            rec = { id: 'e_' + Date.now(), code: data.user.id, name: data.user.name || data.user.id, role: SRV2OS[data.user.role] || 'Cashier', active: true, branches: [], home: null, _adopted: true };
          }
        }
      } catch (_) { /* no backend at all — standalone demo continues */ }
      if (!rec) { setErr('No staff record for that ID — pick one from the directory below.'); return; }
      setErr('');
      // a manager-issued temporary password must be replaced before the desk opens
      onNext(rec, mustChange ? { current: p } : null, srvPlan);
    };
    return (<div id="lock"><div className="lock-card">
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Operating System</span></div>
      <h1>Staff sign-in</h1>
      <div className="station">One door for everyone — who you are decides where you land</div>
      <form onSubmit={submit}>
        <div><div className="lbl">Staff ID</div><input value={u} onChange={e => setU(e.target.value)} placeholder="e.g. a.singh" autoComplete="username" /></div>
        <div><div className="lbl">Password</div><input type="password" value={p} onChange={e => setP(e.target.value)} placeholder="••••••••" autoComplete="current-password" /></div>
        <div className="lock-err">{err}</div>
        <button className="go" type="submit">Continue →</button>
      </form>
      {onSignup && <div style={{ textAlign: 'center', marginTop: 4, marginBottom: 14, fontSize: 12.5, color: 'var(--soft)' }}>New to CurrencyDesk? <button type="button" onClick={onSignup} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Create your desk →</button></div>}
      <div className="lock-hint" style={{ textAlign: 'left' }}>
        <div style={{ marginBottom: 7 }}>Staff directory — each ID routes to its own workspace:</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {dir.map(e => (
            <button key={e.code || e.name} type="button" onClick={() => { setU(e.code || e.name); setErr(''); }}
              style={{ fontFamily: 'var(--f-mono)', fontSize: 10, padding: '4px 8px', border: `1px solid var(--hair)`, borderRadius: 6, background: 'rgba(255,255,255,0.55)', color: 'var(--soft)', cursor: 'pointer' }}>
              <b style={{ color: 'var(--ink)' }}>{e.code}</b> · {e.role.toLowerCase()}
            </button>))}
        </div>
      </div>
    </div></div>);
  }

  /* ====================== FIRST-SIGN-IN PASSWORD ======================
     A manager-issued password is temporary: the server flags it
     (mustChangePassword) and the desk won't open until the person picks
     their own. The change also signs out every other device. */
  function SetPassword({ staffId, current, onDone, onBack }) {
    const [a, setA] = useState(''); const [b, setB] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
    const submit = async (e) => {
      e.preventDefault();
      if (a.length < 8) { setErr('Pick at least 8 characters.'); return; }
      if (a !== b) { setErr('The two entries don\u2019t match \u2014 type the same password twice.'); return; }
      setBusy(true); setErr('Saving\u2026');
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ currentPassword: current, newPassword: a }),
        });
        if (!res.ok) { setErr('Couldn\u2019t save the new password (' + res.status + ') \u2014 try again.'); setBusy(false); return; }
      } catch (_) { setErr('Network error \u2014 try again in a moment.'); setBusy(false); return; }
      setErr(''); onDone();
    };
    return (<div id="lock"><div className="lock-card">
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">First sign-in</span></div>
      <h1>Set your own password</h1>
      <div className="station">The password you signed in with was temporary — pick your own to continue. Only you will know it.</div>
      <form onSubmit={submit}>
        <div><div className="lbl">New password</div><input type="password" value={a} onChange={e => setA(e.target.value)} placeholder="at least 8 characters" autoComplete="new-password" autoFocus /></div>
        <div><div className="lbl">Repeat it</div><input type="password" value={b} onChange={e => setB(e.target.value)} placeholder="••••••••" autoComplete="new-password" /></div>
        <div className="lock-err">{err}</div>
        <button className="go" type="submit" disabled={busy} style={{ opacity: busy ? 0.5 : 1 }}>Save &amp; continue →</button>
      </form>
      <div className="lock-hint">Signed in as <b>{staffId}</b>. Changing the password signs out every other device on this account.</div>
      <button className="lock-back" onClick={onBack}><Ic n="arrowleft" s={13} c="currentColor" /> Back</button>
    </div></div>);
  }

  /* ====================== GUIDED ONBOARDING ======================
     The official 4-phase setup: Business -> Money -> Rules -> Launch.
     Collects the desk's regulator, identity, plan and compliance rules,
     then creates the tenant (POST /api/signup) and emails a code. */
  function OnboardWizard({ onBack, onSent }) {
    const ACC = '#1D6B45';
    const REG = [
      { c: 'Canada', flag: '🇨🇦', reg: 'FINTRAC', cur: 'CAD', th: 10000 },
      { c: 'United States', flag: '🇺🇸', reg: 'FinCEN', cur: 'USD', th: 10000 },
      { c: 'United Kingdom', flag: '🇬🇧', reg: 'HMRC', cur: 'GBP', th: 0 },
      { c: 'Australia', flag: '🇦🇺', reg: 'AUSTRAC', cur: 'AUD', th: 10000 },
      { c: 'United Arab Emirates', flag: '🇦🇪', reg: 'CBUAE', cur: 'AED', th: 0 },
      { c: 'European Union', flag: '🇪🇺', reg: 'National FIU', cur: 'EUR', th: 0 },
      { c: 'Somewhere else', flag: '🌐', reg: 'your regulator', cur: 'USD', th: 10000 },
    ];
    const PLANS = [
      { id: 'basic', name: 'Basic', price: 199, tag: 'Live rate board + customer Texts' },
      { id: 'pro', name: 'Pro', price: 499, tag: 'The full platform — ledger, transfers, compliance' },
      { id: 'premium', name: 'Premium', price: 749, tag: 'Everything, plus the AI desk assistant' },
    ];
    const THRESH = [
      { v: 10000, t: 'Only at 10,000', d: 'The legal minimum — nothing extra.' },
      { v: 5000, t: 'At 5,000', d: 'A cautious middle ground.' },
      { v: 3000, t: 'At 3,000', d: 'Careful — ID on most larger deals.' },
      { v: 1000, t: 'At 1,000', d: 'Strictest — ID on almost every deal.' },
    ];
    const PHASES = ['Business', 'Money', 'Rules', 'Launch'];
    const STEP_PHASE = [0, 0, 0, 1, 2, 3];
    const [step, setStep] = useState(0);
    const [d, setD] = useState({ country: '', businessName: '', ownerName: '', email: '', password: '', slug: '', msbNumber: '', plan: 'pro', idThreshold: 10000 });
    const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
    const set = (k, v) => setD(s => ({ ...s, [k]: k === 'slug' ? v.toLowerCase().replace(/[^a-z0-9-]/g, '') : v }));
    const reg = REG.find(r => r.c === d.country) || {};
    const canNext = () => {
      if (step === 0) return !!d.country;
      if (step === 1) return d.businessName.trim().length > 0;
      if (step === 2) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email) && d.password.length >= 8 && d.slug.length >= 2 && !!d.ownerName.trim();
      if (step === 3) return !!d.plan;
      if (step === 4) return d.idThreshold > 0;
      return true;
    };
    const back = () => { setErr(''); step === 0 ? onBack() : setStep(s => s - 1); };
    const advance = () => {
      if (!canNext()) { setErr(step === 2 ? 'Fill in your name, a valid email, an 8+ character password and a desk address.' : 'Pick an option to continue.'); return; }
      setErr('');
      if (step === 0 && reg.th) set('idThreshold', reg.th);
      if (step < 5) setStep(s => s + 1); else create();
    };
    const create = async () => {
      setBusy(true); setErr('Creating your desk…');
      const body = { businessName: d.businessName, ownerName: d.ownerName, email: d.email, password: d.password, slug: d.slug,
        onboarding: { country: d.country, regulator: reg.reg, homeCurrency: reg.cur, msbNumber: d.msbNumber, plan: d.plan, idThreshold: d.idThreshold } };
      try {
        const res = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
        const j = await res.json().catch(() => null);
        if (!res.ok) { setErr((j && j.detail) || ('Couldn’t create your desk (' + res.status + ').')); setBusy(false); return; }
        setErr(''); onSent(d.email);
      } catch (_) { setErr('Network error — try again.'); setBusy(false); }
    };
    const inSty = { border: `1px solid var(--hair)`, borderRadius: 9, background: 'var(--cd-panel, #fff)' };
    const optRow = (on, main, sub, onClick, left) => (
      <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '13px 15px', marginBottom: 8, borderRadius: 12, cursor: 'pointer', background: on ? 'var(--green-soft, #dcefe4)' : 'var(--cd-panel, #fff)', border: `1.5px solid ${on ? ACC : 'var(--hair)'}` }}>
        {left != null && <span style={{ fontSize: 20, flex: 'none', width: 26, textAlign: 'center' }}>{left}</span>}
        <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{main}</span>{sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--mute)', marginTop: 1 }}>{sub}</span>}</span>
        {on ? <Ic n="check" s={17} c={ACC} /> : <span style={{ width: 17, height: 17, borderRadius: '50%', border: `1.5px solid var(--hair)`, flex: 'none' }} />}
      </button>
    );
    const field = (label, k, ph, type) => (
      <div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>{label}</div>
        <input type={type || 'text'} value={d[k]} onChange={e => set(k, e.target.value)} placeholder={ph} style={{ ...inSty, width: '100%', padding: '9px 11px', fontSize: 14, outline: 'none', fontFamily: k === 'slug' || k === 'msbNumber' ? 'var(--f-mono)' : 'inherit' }} /></div>
    );
    return (<div id="lock"><div className="lock-card" style={{ width: 460, maxWidth: 'calc(100vw - 40px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontFamily: 'var(--f-mono)', fontWeight: 800, fontSize: 15, color: 'var(--ink)' }}>CurrencyDesk</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--f-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'var(--faint)', border: `1px solid var(--hair)`, borderRadius: 6, padding: '3px 8px' }}>SETUP</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <button type="button" onClick={back} title="Back" style={{ background: 'none', border: `1px solid var(--hair)`, borderRadius: 8, width: 28, height: 28, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--mute)', flex: 'none' }}><Ic n="arrowleft" s={13} c="currentColor" /></button>
        {PHASES.map((ph, i) => { const done = i < STEP_PHASE[step]; const cur = i === STEP_PHASE[step]; return (
          <span key={ph} style={{ flex: 1 }}><span style={{ display: 'block', fontFamily: 'var(--f-mono)', fontSize: 8.5, letterSpacing: '0.1em', color: (done || cur) ? ACC : 'var(--faint)', marginBottom: 4 }}>{ph.toUpperCase()}</span><span style={{ display: 'block', height: 3, borderRadius: 3, background: done ? ACC : cur ? ACC : 'var(--hair)', opacity: cur ? 0.5 : 1 }} /></span>); })}
      </div>

      {step === 0 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>WHERE YOU OPERATE</div>
        <h1 style={{ marginBottom: 6 }}>Which country are you licensed in?</h1>
        <div className="station" style={{ marginBottom: 14 }}>This sets your regulator, home currency and reporting thresholds — so the desk fits your rules.</div>
        {REG.map(r => optRow(d.country === r.c, r.c, r.reg + ' · home currency ' + r.cur, () => set('country', r.c), r.flag))}
      </div>)}

      {step === 1 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>YOUR BUSINESS</div>
        <h1 style={{ marginBottom: 6 }}>Tell us about your desk</h1>
        <div className="station" style={{ marginBottom: 14 }}>Your legal name and registration go on receipts and reports.</div>
        {field('Business name', 'businessName', 'Maple Currency Exchange')}
        {field(reg.reg ? (reg.reg + ' registration number') : 'MSB registration number', 'msbNumber', 'M21-0000000')}
      </div>)}

      {step === 2 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>YOUR ACCOUNT</div>
        <h1 style={{ marginBottom: 6 }}>Create your owner login</h1>
        <div className="station" style={{ marginBottom: 14 }}>You’ll verify this email with a code, then it’s your sign-in.</div>
        {field('Your name', 'ownerName', 'Dana Kim')}
        {field('Work email', 'email', 'you@business.com', 'email')}
        {field('Password', 'password', 'at least 8 characters', 'password')}
        {field('Desk address', 'slug', 'maplefx')}
        <div style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: -6 }}>{(d.slug || 'yourshop')}.currencydesk — where your desk lives</div>
      </div>)}

      {step === 3 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>YOUR PLAN</div>
        <h1 style={{ marginBottom: 6 }}>Pick a plan</h1>
        <div className="station" style={{ marginBottom: 14 }}>Start free — no card today. You won’t be charged during your trial.</div>
        {PLANS.map(pl => optRow(d.plan === pl.id, pl.name + ' · $' + pl.price + '/mo', pl.tag, () => set('plan', pl.id)))}
      </div>)}

      {step === 4 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>YOUR RULES</div>
        <h1 style={{ marginBottom: 6 }}>When should the desk ask for ID?</h1>
        <div className="station" style={{ marginBottom: 14 }}>{reg.reg || 'Your regulator'} sets the legal minimum. Many shops ask earlier, to be safe — you can change this later.</div>
        {THRESH.map(x => optRow(d.idThreshold === x.v, x.t + ' ' + (reg.cur || 'CAD'), x.d, () => set('idThreshold', x.v)))}
      </div>)}

      {step === 5 && (<div>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 10, letterSpacing: '0.12em', color: ACC, marginBottom: 6 }}>LAUNCH</div>
        <h1 style={{ marginBottom: 6 }}>Ready to open {d.businessName || 'your desk'}?</h1>
        <div className="station" style={{ marginBottom: 14 }}>We’ll email a code to <b style={{ color: 'var(--ink)' }}>{d.email}</b> to verify it, then your desk is live.</div>
        <div style={{ ...inSty, padding: '12px 14px', fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.7 }}>
          <div><b style={{ color: 'var(--ink)' }}>{d.country}</b> · {reg.reg} · {reg.cur}</div>
          <div>{d.plan.charAt(0).toUpperCase() + d.plan.slice(1)} plan · free trial · ID at {Number(d.idThreshold).toLocaleString()} {reg.cur}</div>
          <div>{(d.slug || 'yourshop')}.currencydesk</div>
        </div>
      </div>)}

      {err && <div className="lock-err" style={{ marginTop: 12 }}>{err}</div>}
      <button className="go" onClick={advance} disabled={busy} style={{ width: '100%', marginTop: 16, background: ACC, opacity: busy ? 0.5 : 1 }}>{step < 5 ? 'Continue →' : 'Create my desk →'}</button>
    </div></div>);
  }

  function VerifySignup({ email, onVerified, onBack }) {
    const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
    const submit = async (e) => {
      e.preventDefault();
      if (code.trim().length < 4) { setErr('Enter the code from your email.'); return; }
      setBusy(true); setErr('Checking\u2026');
      try {
        const res = await fetch('/api/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email, code: code.trim() }) });
        const d = await res.json().catch(() => null);
        if (!res.ok) { setErr((d && d.detail) || ('That code didn\u2019t work (' + res.status + ').')); setBusy(false); return; }
        setErr(''); onVerified(d);
      } catch (_) { setErr('Network error \u2014 try again.'); setBusy(false); }
    };
    const resend = async () => { setNote('Sending\u2026'); try { await fetch('/api/signup/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email }) }); setNote('A new code is on its way.'); } catch (_) { setNote('Couldn\u2019t resend \u2014 try again.'); } };
    return (<div id="lock"><div className="lock-card">
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Verify your email</span></div>
      <h1>Enter your code</h1>
      <div className="station">We emailed a 6-digit code to <b style={{ color: 'var(--ink)' }}>{email}</b>. It expires in 10 minutes.</div>
      <form onSubmit={submit}>
        <div><input value={code} onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} inputMode="numeric" placeholder="000000" autoFocus style={{ textAlign: 'center', letterSpacing: '0.4em', fontFamily: 'var(--f-mono)', fontSize: 22 }} /></div>
        <div className="lock-err">{err}</div>
        <button className="go" type="submit" disabled={busy} style={{ opacity: busy ? 0.5 : 1 }}>Verify &amp; open my desk →</button>
      </form>
      <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: 'var(--soft)' }}>Didn’t get it? <button type="button" onClick={resend} style={{ background: 'none', border: 'none', color: 'var(--ink)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>Resend code</button>{note && <span style={{ marginLeft: 6, color: 'var(--faint)' }}>{note}</span>}</div>
      <button className="lock-back" onClick={onBack}><Ic n="arrowleft" s={13} c="currentColor" /> Back</button>
    </div></div>);
  }

  function DeskCreated({ desk, onEnter }) {
    const t = (desk && desk.tenant) || {};
    return (<div id="lock"><div className="lock-card" style={{ textAlign: 'center' }}>
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Welcome aboard</span></div>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--green-soft, #dcefe4)', display: 'grid', placeItems: 'center', margin: '6px auto 14px' }}><Ic n="check" s={26} c="var(--green, #1f8a4c)" /></div>
      <h1 style={{ textAlign: 'center' }}>Your desk is ready</h1>
      <div className="station" style={{ textAlign: 'center' }}><b style={{ color: 'var(--ink)' }}>{t.name || 'Your desk'}</b> is created and you’re signed in as the owner. Your address is <b style={{ color: 'var(--ink)', fontFamily: 'var(--f-mono)' }}>{t.slug}</b>.</div>
      <button className="go" onClick={onEnter} style={{ width: '100%' }}>Enter CurrencyDesk →</button>
    </div></div>);
  }

  function Otp({ user, onBack, onVerify }) {
    const DEMO = '000000'; const [d, setD] = useState(DEMO.split('')); const refs = useRef([]);
    const set = (i, v) => { if (!/^\d?$/.test(v)) return; const n = [...d]; n[i] = v; setD(n); if (v && i < 5) refs.current[i + 1]?.focus(); };
    const ok = d.join('') === DEMO;
    return (<div id="lock"><div className="lock-card">
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Two-step verification</span></div>
      <h1>Enter your code</h1>
      <div className="station">Texted to •••• ••• 4821 · changeable once you're in</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '4px 0 14px' }}>
        {d.map((v, i) => <input key={i} ref={el => refs.current[i] = el} value={v} onChange={e => set(i, e.target.value)} inputMode="numeric" maxLength={1}
          style={{ width: 44, height: 52, textAlign: 'center', fontSize: 20, border: `1px solid ${ok ? CD.ink : CD.line}`, background: '#fafafa', outline: 'none', fontFamily: 'Space Mono, monospace' }} />)}
      </div>
      <div style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace', fontSize: 11, padding: '8px 10px', marginBottom: 14, letterSpacing: '0.02em' }}>Simulated: demo code is <b style={{ letterSpacing: '0.2em' }}>{DEMO}</b>. Real SMS needs a backend + provider.</div>
      <button className="go" disabled={!ok} style={{ width: '100%', opacity: ok ? 1 : 0.4, cursor: ok ? 'pointer' : 'not-allowed' }} onClick={onVerify}>Verify &amp; open workspace</button>
      <button className="lock-back" onClick={onBack}><Ic n="arrowleft" s={13} c="currentColor" /> Back</button>
    </div></div>);
  }

  /* ====================== STATION PICKER (sign-in) ======================
     Scoped per the spec's routing table (§04): owners see every branch;
     everyone else sees only their assigned branches. Selecting a branch
     expands its open tills — the employee's default till (the one they're
     posted to) is pre-selected. Single-destination cases never reach this
     screen at all (routeAfterAuth skips it). */
  function StationPicker({ branches, station, rec, onBack, onPick }) {
    const isOwner = !rec || rec.role === 'Owner' || rec.branches === '*';
    const allowedIds = isOwner ? branches.map(b => b.id) : (Array.isArray(rec.branches) ? rec.branches : []);
    const list = branches.filter(b => allowedIds.includes(b.id));
    const defTill = (b) => {
      if (!b) return null;
      const mine = rec && (b.tills || []).find(t => t.teller === rec.name && t.status !== 'closed');
      const t = mine || (b.tills || []).find(x => x.status !== 'closed') || (b.tills || [])[0];
      return t ? t.id : null;
    };
    const [selId, setSelId] = useState(() => {
      const home = rec && rec.home && list.find(b => b.id === rec.home && b.status === 'open');
      if (home) return home.id;
      const prev = list.find(b => b.id === station.branchId && b.status === 'open');
      const open = prev || list.find(b => b.status === 'open') || list[0];
      return open ? open.id : null;
    });
    const [tillSel, setTillSel] = useState({});   // branchId -> tillId (explicit picks)
    const selB = list.find(b => b.id === selId);
    const effTill = selB ? (tillSel[selId] || defTill(selB)) : null;
    const confirm = () => { if (selB && effTill) onPick({ branchId: selB.id, tillId: effTill }); };
    return (<div id="lock"><div className="lock-card" style={{ maxWidth: 444 }}>
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Choose your station</span></div>
      <h1>Where are you working?</h1>
      <div className="station">{isOwner ? 'Owner access — every branch, any till' : (list.length > 1 ? 'Your assigned branches — pick one, then your till' : 'Your branch — pick a till')}</div>
      <div className="sp-list">
        {list.map(b => {
          const closed = b.status === 'closed';
          const openTills = (b.tills || []).filter(t => t.status !== 'closed');
          const sel = selId === b.id;
          return (
            <div key={b.id}>
              <button disabled={closed} onClick={() => setSelId(b.id)} className={'sp-branch' + (sel ? ' sel' : '')} style={{ width: '100%' }}>
                <span className="sp-ico"><Ic n="building" s={19} c="var(--cd-on-ink)" /></span>
                <span className="sp-info">
                  <span className="sp-name">{b.name} <i>{b.code}</i>{rec && rec.home === b.id && !isOwner ? <i style={{ color: 'var(--faint)' }}>· home</i> : null}</span>
                  <span className="sp-city">{b.city}</span>
                  <span className="sp-meta">{closed ? 'Closed today' : openTills.length + (openTills.length === 1 ? ' till open' : ' tills open')}</span>
                </span>
                {closed ? <span className="sp-tag">Closed</span> : <span className="sp-radio">{sel && <Ic n="check" s={14} c="var(--cd-on-ink)" />}</span>}
              </button>
              {sel && !closed && openTills.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px 10px 56px' }}>
                  {openTills.map(t => { const on = effTill === t.id; return (
                    <button key={t.id} type="button" onClick={() => setTillSel(m => ({ ...m, [b.id]: t.id }))}
                      style={{ fontFamily: 'var(--f-mono)', fontSize: 10, padding: '5px 9px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${on ? 'var(--ink)' : 'var(--hair)'}`, background: on ? 'var(--ink)' : 'rgba(255,255,255,0.55)', color: on ? '#fff' : 'var(--soft)' }}>
                      {t.name.replace(/\s+—.*/, '')}{rec && t.teller === rec.name ? ' · yours' : (t.operator ? ' · ' + t.operator + ' on now' : (t.teller ? ' · ' + t.teller : ' · free'))}
                    </button>); })}
                </div>)}
            </div>);
        })}
      </div>
      <button className="go" disabled={!effTill} style={{ width: '100%', opacity: effTill ? 1 : 0.4, cursor: effTill ? 'pointer' : 'not-allowed' }} onClick={confirm}>Open workspace</button>
      <button className="lock-back" onClick={onBack}><Ic n="arrowleft" s={13} c="currentColor" /> Back</button>
    </div></div>);
  }

  /* ====================== NO-ASSIGNMENT STOP SCREEN (rule R1) ====================== */
  function NoAssign({ rec, manager, onBack }) {
    return (<div id="lock"><div className="lock-card">
      <div className="lock-mark"><span className="yk">CurrencyDesk</span><span className="sub">Signed in · no station</span></div>
      <h1>You're not assigned to a branch yet</h1>
      <div className="station">Hi {rec ? rec.name : 'there'} — your account works, but it isn't posted anywhere</div>
      <div style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid var(--hair)', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--soft)', textAlign: 'left', marginBottom: 14 }}>
        Every employee works out of at least one branch. Ask <b style={{ color: 'var(--ink)' }}>{manager || 'your manager'}</b> to add you to a location in <b style={{ color: 'var(--ink)' }}>Branch Network → Team</b>, then sign in again.
      </div>
      <button className="lock-back" onClick={onBack} style={{ marginTop: 0 }}><Ic n="arrowleft" s={13} c="currentColor" /> Back to sign-in</button>
    </div></div>);
  }

  /* ====================== STATION SWITCHER (header) ======================
     You sign in to ONE store, so the header shows that branch and lets you
     hop between the TILLS at THIS location only. Changing store means signing
     out and back in — there is deliberately no cross-store switch here.
     lockTill (rule R5): till-scope roles (cashier/trainee) can't self-serve
     a till switch — their drawer is their assignment. */
  function StationSwitcher({ branches, station, setStation, log, lockTill, me, gate }) {
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(null);   // till id awaiting confirmation
    const ref = useRef(null);
    useEffect(() => { if (!open) return; const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [open]);
    const ab = branches.find(b => b.id === station.branchId) || branches[0];
    const tills = ((ab && ab.tills) || []).filter(t => t.status !== 'closed');
    const at = ab && (ab.tills || []).find(t => t.id === station.tillId);
    const canSwitch = !lockTill && tills.length >= 1;
    const pick = (tId) => { if (tId === station.tillId) { setOpen(false); return; } setPending(tId); setOpen(false); };
    const confirmPick = () => { const tId = pending; setPending(null); if (!tId) return; (gate || ((fn) => fn()))(() => { setStation({ branchId: ab.id, tillId: tId }); const t = (ab.tills || []).find(x => x.id === tId) || {}; if (t.operator) log && log('Till handover', `${t.operator} → you · ${ab.code} ${t.name}`); log && log('Till switched', (ab.name || '') + ' · ' + (t.name || '')); }); };
    return (<div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => canSwitch && setOpen(o => !o)} title={canSwitch ? 'Switch till at this location' : (lockTill ? 'Your assigned till — ask a manager to move you' : 'Your station')} style={{ display: 'flex', alignItems: 'center', gap: 6, background: open ? 'var(--cd-hover)' : 'transparent', border: 0, padding: '2px 6px', margin: '0 -6px', borderRadius: 7, cursor: canSwitch ? 'pointer' : 'default', color: 'inherit' }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: ab && ab.status === 'open' ? CD.green : CD.faint, flex: 'none' }}></span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'inherit', whiteSpace: 'nowrap' }}>{ab ? ab.name : 'Station'}</span>
        {at && <span style={{ fontSize: 11, color: CD.faint, whiteSpace: 'nowrap' }}>· {at.name.replace(/\s+—.*/, '')}</span>}
        {canSwitch && <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><Ic n="chev" s={11} c={CD.faint} /></span>}
      </button>
      {open && canSwitch && (<div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 7, width: 250, background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 12, boxShadow: '0 16px 44px var(--cd-shade)', zIndex: 9999, overflow: 'hidden' }}>
        <div style={{ padding: '9px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: CD.faint, fontFamily: 'Space Mono, monospace', borderBottom: `1px solid ${CD.lineSoft}` }}>{ab ? ab.name : ''} · switch till</div>
        {tills.map(t => { const on = station.tillId === t.id; return (
          <button key={t.id} onClick={() => pick(t.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: on ? CD.brassSoft : 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }}>
            <Ic n="wallet" s={13} c={on ? CD.ink : CD.mute} />
            <span style={{ flex: 1, fontSize: 12, color: CD.ink }}>{t.name}<span style={{ color: CD.faint }}>{on ? ' · you' : (t.operator ? ' · ' + t.operator + ' on now' : ' · free')}</span></span>
            {on && <Ic n="check" s={13} c={CD.ink} />}
          </button>); })}
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${CD.lineSoft}`, fontSize: 10.5, color: CD.faint, display: 'flex', alignItems: 'center', gap: 6 }}><Ic n="logout" s={11} c={CD.faint} /> To change store, sign out &amp; back in.</div>
      </div>)}
      {pending && window.CDOS._stations && window.CDOS._stations.ConfirmStationModal && React.createElement(window.CDOS._stations.ConfirmStationModal, { branch: ab, till: (ab.tills || []).find(x => x.id === pending), me, onClose: () => setPending(null), onConfirm: confirmPick })}
    </div>);
  }

  /* ====================== LIVE RATE TICKER ====================== */
  // Reads the staff-published rate board (localStorage) so the ticker always
  // shows the owner's current mid rates (CAD per unit), and reflows when they republish.
  function readBoard() {
    let cfg = null;
    try { const raw = localStorage.getItem('yorkfx_rates_v1'); cfg = raw ? JSON.parse(raw) : null; } catch (e) {}
    const list = (typeof CUR !== 'undefined' ? CUR : []).filter(c => c.code !== 'CAD');
    return list.map(c => {
      const r = cfg && cfg.rows && cfg.rows[c.code];
      const mid = r && typeof r.mid === 'number' && r.mid > 0 ? r.mid : (1 / c.perCadDefault);
      const show = r ? r.show !== false : true;
      return { code: c.code, name: c.name, flag: c.flag, mid, show, chg: c.chg };
    }).filter(x => x.show);
  }
  function tkMid(v) { const dp = v >= 100 ? 2 : v >= 1 ? 4 : 5; return v.toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function boardSig(items) { return items.map(i => i.code + ':' + i.mid).join('|'); }

  // when locked, render the frozen snapshot instead of the live published board
  function readFrozen(book) {
    const list = (typeof CUR !== 'undefined' ? CUR : []).filter(c => c.code !== 'CAD');
    return list.map(c => ({ code: c.code, name: c.name, flag: c.flag, mid: book[c.code] ? 1 / book[c.code] : 1 / c.perCadDefault, show: true, chg: c.chg }));
  }
  function Ticker({ locked, cfg, book }) {
    const c0 = cfg || { speed: 'medium', direction: 'left', metric: 'cadPerUnit', showFlags: true, showChange: true, hidden: [] };
    const hidden = c0.hidden || [];
    const frozen = locked && book;
    const frozenSig = frozen ? bookSig(book) : '';
    const [items, setItems] = useState(() => frozen ? readFrozen(book) : readBoard());
    useEffect(() => {
      if (frozen) { setItems(readFrozen(book)); return; }   // held at last pull — no polling
      let next0 = readBoard(); setItems(next0);
      let last = boardSig(next0);
      const t = setInterval(() => { const next = readBoard(); const s = boardSig(next); if (s !== last) { last = s; setItems(next); } }, 4000);
      return () => clearInterval(t);
    }, [frozen, frozenSig]);
    const shown = items.filter(it => !hidden.includes(it.code));
    if (!shown.length) return <div className="mb-ticker-wrap" />;
    const SPEED = { slow: 5.2, medium: 3.4, fast: 2.0 };
    const dur = Math.max(20, shown.length * (SPEED[c0.speed] || 3.4));
    const price = (it) => c0.metric === 'perCad' ? tkMid(1 / it.mid) : tkMid(it.mid);
    const cell = (it, i, k) => (
      <span className="tk-item" key={k + it.code + i}>
        {c0.showFlags && <span className="tk-flag">{it.flag}</span>}
        <span className="tk-code">{it.code}</span>
        <span className="tk-price">{price(it)}</span>
        {c0.showChange && <span className={'tk-chg ' + (it.chg >= 0 ? 'up' : 'down')}>{it.chg >= 0 ? '▲' : '▼'}{Math.abs(it.chg).toFixed(2)}%</span>}
      </span>
    );
    return (
      <div className={'mb-ticker-wrap' + (locked ? ' locked' : '')} title={locked ? 'Rates locked — held at last pull' : 'Spot rates from the Rate Board — updated hourly'}>
        <span className={'tk-badge' + (locked ? ' locked' : '')}>
          {locked ? <Ic n="lock" s={10} /> : <span className="tk-pulse"></span>}
          {locked ? 'LOCKED' : 'HOURLY'}
        </span>
        <div className="mb-ticker">
          <div className="mb-ticker-track" style={{ animationDuration: dur + 's', animationDirection: c0.direction === 'right' ? 'reverse' : 'normal' }}>
            {shown.map((it, i) => cell(it, i, 'a'))}
            {shown.map((it, i) => cell(it, i, 'b'))}
          </div>
        </div>
      </div>
    );
  }

  /* ====================== ROOT ====================== */
  function App() {
    const [stage, setStage] = useState('lock');
    const [user, setUser] = useState('');
    const [authRec, setAuthRec] = useState(null);   // employee record resolved at the lock screen
    const [pwTemp, setPwTemp] = useState(null);     // {current} while a temporary password must be replaced
    const [signup, setSignup] = useState(null);     // { email } while verifying a new-desk signup
    const [newDesk, setNewDesk] = useState(null);   // { user, tenant } after a signup verifies
    const [me, setMe] = useState(STAFF[0]);

    // №02 (Roadmap v2): the book + client roster persist like every other store.
    // The seed is a first-run fallback only — refresh no longer resets the desk;
    // wiping is the explicit "Reset demo data" control in Settings → Business.
    const [rows, setRows] = useState(() => { try { const r = JSON.parse(localStorage.getItem('cdos_rows_v1') || 'null'); return Array.isArray(r) && r.length ? r : seedRows(); } catch (e) { return seedRows(); } });
    const [clients, setClients] = useState(() => { try { const r = JSON.parse(localStorage.getItem('cdos_clients_v1') || 'null'); return r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length ? r : seedClients(); } catch (e) { return seedClients(); } });
    useEffect(() => { try { localStorage.setItem('cdos_rows_v1', JSON.stringify(rows)); } catch (e) {} }, [rows]);
    useEffect(() => { try { localStorage.setItem('cdos_clients_v1', JSON.stringify(clients)); } catch (e) {} }, [clients]);
    // backfill contacts from completed Persona verifications, app-wide (even when no profile is open)
    useEffect(() => {
      if (window.CDOS.KYC && window.CDOS.KYC.setProvider && settings.kycProvider) window.CDOS.KYC.setProvider(settings.kycProvider);
      if (!(window.CDOS.KYC && window.CDOS.KYC.setContactSink)) return;
      window.CDOS.KYC.setContactSink((name, ex, at) => setClients(c => {
        const cur = c[name] || {}; const next = { ...cur };
        ['email', 'dob', 'address', 'city', 'province', 'postal', 'country', 'idType', 'idNum', 'idIssued', 'idExpiry'].forEach(k => { if (ex[k] && !String(next[k] || '').trim()) next[k] = ex[k]; });
        next.idVerifiedAt = at || next.idVerifiedAt;
        return { ...c, [name]: next };
      }));
    }, []);
    const [settings, setSettings] = useState(() => {
      const def = {
        // compliance
        requireIdPhoto: false, idExpiryWarnDays: 30, largeTxCheck: 'off', structuringDays: 7, threshold: 10000, idRequiredOver: 3000, retentionYears: 5, screenSanctions: true, aggWindowStart: '00:00',
        // identity verification cadence — house parameters for the VerificationNudge engine (cdos-kyc.jsx)
        recheckDays: 180, reverifyDays: 365, escalateHighRisk: true,
        // business profile
        bizName: 'York Foreign Exchange Inc.', operatingName: 'York Currency Exchange', msbNumber: 'M21-0098765',
        deskName: 'Desk 1', bizPhone: '(416) 555-0100', bizEmail: 'desk@yorkfx.ca',
        bizAddress: '120 Adelaide St W', bizCity: 'Toronto', bizRegion: 'ON', bizPostal: 'M5H 1T1', bizCountry: 'Canada', logo: null,
        // FINTRAC reporting identity (set once on FWR enrolment)
        reportingEntityNumber: '8847213', locationNumber: '00001', activitySector: 'Foreign exchange dealer', fintracContactName: 'J. Masri',
        // localization
        baseCurrency: 'CAD', timezone: 'America/Toronto', dateFormat: 'YYYY-MM-DD', timeFormat: '12h',
        // rates & fees
        defaultSpread: 1.5, defaultFee: 0, rateRounding: '4dp',
        // receipts
        receiptHeader: 'York Currency Exchange', receiptFooter: 'Thank you — keep for your records',
        receiptDisclaimer: 'All sales final. Rates as quoted at time of transaction.', showLogoOnReceipt: true, showMsbOnReceipt: true,
      };
      try { const raw = localStorage.getItem('cdos_settings'); const merged = raw ? { ...def, ...JSON.parse(raw) } : def; if (merged.deskName === 'Front Desk 01') merged.deskName = 'Desk 1'; if (!merged.employees || !merged.employees.length) merged.employees = STAFF.map(s => ({ id: 'e_' + s.name.replace(/[^A-Za-z]/g, ''), name: s.name, role: s.role, email: '', phone: '', code: s.staffId || s.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, ''), active: true, pin: '0000', requirePin: true, caps: { ...(ROLE_CAPS[s.role] || {}) }, apps: null, branches: s.branches, home: s.home }));
      // migration: employees saved before the Branch & Access Model gain assignments (spec §06)
      merged.employees = merged.employees.map(e => { if (e.branches !== undefined) { if (Array.isArray(e.branches)) { const fb = e.branches.filter(id => id !== 'b03' && id !== 'b04'); if (fb.length !== e.branches.length) return { ...e, branches: fb, home: (e.home === 'b03' || e.home === 'b04') ? (fb[0] || null) : e.home }; } return e; } const seed = STAFF.find(s => s.name === e.name); if (e.role === 'Owner') return { ...e, branches: '*', home: null }; return { ...e, branches: seed ? seed.branches : ['b01'], home: seed ? seed.home : 'b01' }; });
      // every account carries a 4-digit transaction PIN (defaults to 0000) and a require-PIN flag
      merged.employees = merged.employees.map(e => ({ ...e, pin: e.pin || '0000', requirePin: e.requirePin !== false }));
      return merged; } catch (e) { return def; }
    });
    const [perms, setPerms] = useState(() => {
      const def = { Teller: { canDelete: true, canExport: true, canViewReports: true, canEditKYC: true, canSettings: false, canCloseDay: false } };
      try { const raw = localStorage.getItem('cdos_perms'); const p = raw ? JSON.parse(raw) : null; return p && p.Teller ? { Teller: { ...def.Teller, ...p.Teller } } : def; } catch (e) { return def; }
    });
    // ---- ONE shared opening baseline + ONE shared wholesale-receipts store ----
    // both the Vault (position) and the Till (expected) derive from these via
    // window.CDOS.position(); receipts are kept OUT of the customer ledger so a
    // wholesale purchase never trips a compliance flag, yet the till still
    // counts against them. Edited in the Till's reconcile, read by the Vault.
    const [baseline, setBaseline] = useState(() => { try { const r = localStorage.getItem('cdos_baseline_v1'); return r ? JSON.parse(r) : window.CDOS.defaultBaseline(); } catch (e) { return window.CDOS.defaultBaseline(); } });
    const [receipts, setReceipts] = useState(() => { try { const r = localStorage.getItem('cdos_receipts_v1'); return r ? JSON.parse(r) : window.CDOS.defaultReceipts(); } catch (e) { return window.CDOS.defaultReceipts(); } });
    useEffect(() => { try { localStorage.setItem('cdos_baseline_v1', JSON.stringify(baseline)); } catch (e) {} }, [baseline]);
    useEffect(() => { try { localStorage.setItem('cdos_receipts_v1', JSON.stringify(receipts)); } catch (e) {} }, [receipts]);
    // ---- multi-branch / multi-till: the STATION model is the OS backbone.
    // Branches (each holding tills), inter-branch/till movements, and the
    // active station (branch + till) all live here so the shell chrome, the
    // Till drawer, and the Branch Network module read one source of truth. ----
    const _ST = window.CDOS._stations;
    const [branches, setBranches] = useState(() => { try { const r = JSON.parse(localStorage.getItem(_ST.SKEY) || 'null'); let base = (Array.isArray(r) && r.length && r[0].tills) ? r : _ST.defaultBranches(); base = base.filter(b => b.id !== 'b03' && b.id !== 'b04'); /* network trimmed to the two real locations */ const DEFV = _ST.defaultBranches(); const migrated = base.map(b => { const dv = DEFV.find(d => d.id === b.id); return { ...b, main: b.main !== undefined ? b.main : !!(dv && dv.main), vault: b.vault || (dv ? dv.vault : { CAD: 0 }), tills: (b.tills || []).map(t => t.operator !== undefined ? t : { ...t, operator: t.teller || '' }) }; }); if (!migrated.some(b => b.main)) migrated[0] = { ...migrated[0], main: true }; return migrated; } catch (e) { return _ST.defaultBranches(); } });
    const [branchMoves, setBranchMoves] = useState(() => { try { const r = JSON.parse(localStorage.getItem(_ST.MKEY) || 'null'); return Array.isArray(r) ? r : []; } catch (e) { return []; } });
    const [station, setStation] = useState(() => { try { const r = JSON.parse(localStorage.getItem('cdos_station_v1') || 'null'); return r && r.branchId ? r : _ST.defaultStation(_ST.defaultBranches()); } catch (e) { return _ST.defaultStation(_ST.defaultBranches()); } });
    useEffect(() => { try { localStorage.setItem(_ST.SKEY, JSON.stringify(branches)); } catch (e) {} }, [branches]);
    // if the station points at a branch/till that no longer exists, snap to a live one
    useEffect(() => {
      const b = branches.find(x => x.id === station.branchId);
      if (b && (b.tills || []).some(t => t.id === station.tillId)) return;
      const nb = branches.find(x => x.status === 'open') || branches[0];
      const nt = nb && ((nb.tills || []).find(t => t.status !== 'closed') || (nb.tills || [])[0]);
      if (nb && nt) setStation({ branchId: nb.id, tillId: nt.id });
    }, [branches]);
    // live operator sessions: whoever is signed in at a station OWNS that till
    // until they sign out or move — one operator per till. Claims the active
    // till for `me` and releases any other till `me` was on. Covers sign-in
    // routing, header till switches, Operate/Take over, and account switching.
    useEffect(() => {
      if (stage !== 'desktop' || !station || !station.tillId) return;
      setBranches(list => {
        let changed = false;
        const next = list.map(b => ({ ...b, tills: (b.tills || []).map(t => {
          const mine = b.id === station.branchId && t.id === station.tillId;
          const want = mine ? me.name : ((t.operator || '') === me.name ? '' : (t.operator || ''));
          if ((t.operator || '') === want) return t;
          changed = true; return { ...t, operator: want };
        }) }));
        return changed ? next : list;
      });
    }, [stage, station, me.name]);
    useEffect(() => { try { localStorage.setItem(_ST.MKEY, JSON.stringify(branchMoves)); } catch (e) {} }, [branchMoves]);
    // OS-level Move cash: one modal, one rail — openable from the Vault, the
    // Cash Drawer, or the Branch Network with a preset (kind/branch/till).
    const [moveCash, setMoveCash] = useState(null);
    // vault → till: issue a multi-currency float directly on the rail (from the
    // Vault's Assign flow — owner/manager hands money to a drawer, all recorded)
    const issueToTill = (tId, amounts) => {
      const b = branches.find(x => x.id === station.branchId); if (!b) return;
      const t = (b.tills || []).find(x => x.id === tId); if (!t) return;
      let list = branches, mv = branchMoves; const parts = [];
      Object.keys(amounts || {}).forEach(ccy2 => {
        const amt = +amounts[ccy2] || 0; if (amt <= 0) return;
        const r = _ST.applyMove(list, mv, { kind: 'issue', fromB: b.id, tId, ccy: ccy2, amt, fromLabel: b.code + ' · Vault', toLabel: b.code + ' · ' + t.name.replace(/\s+—.*/, '') }, me.name);
        list = r.branches; mv = r.moves; parts.push(`${amt.toLocaleString()} ${ccy2}`);
      });
      if (!parts.length) return;
      setBranches(list); setBranchMoves(mv);
      log('Float issued', `${parts.join(' + ')} · ${b.code} Vault → ${t.name.replace(/\s+—.*/, '')}`);
    };
    // wholesale orders land in THIS branch's vault — other locations fill their
    // own sub-vaults by ordering; the main vault stays the network's cash root
    const creditVault = (ccy2, units, supplier) => {
      const b = branches.find(x => x.id === station.branchId); if (!b || !units) return;
      setBranches(list => list.map(x => x.id === b.id ? { ...x, vault: { ...(x.vault || {}), [ccy2]: (((x.vault || {})[ccy2]) || 0) + units } } : x));
      setBranchMoves(list => [{ id: 'm' + Date.now(), ref: 'RC-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + (list.filter(m => m.date === TODAY).length + 1).toString().padStart(2, '0'), kind: 'order', from: supplier || 'Wholesale order', to: b.code + ' · Vault', ccy: ccy2, amount: units, cadVal: +((ccy2 === 'CAD' ? units : units * (crossRate(ccy2, 'CAD') || 0))).toFixed(2), date: TODAY, by: me.name }, ...list]);
    };
    const doOsMove = (payload) => {
      const r = _ST.applyMove(branches, branchMoves, payload, me.name);
      setBranches(r.branches); setBranchMoves(r.moves);
      log(r.verb, r.detail);
      setMoveCash(null);
    };
    useEffect(() => { try { localStorage.setItem('cdos_station_v1', JSON.stringify(station)); } catch (e) {} }, [station]);
    // ---- beneficiaries + corridors: shared so Clients nests beneficiaries under
    // each contact AND Transfers reads the same store (one source of truth) ----
    const _T = window.CDOS._transfers;
    const [beneficiaries, setBeneficiaries] = useState(() => { try { const r = localStorage.getItem(_T.BKEY); return r ? JSON.parse(r) : _T.defaultBeneficiaries(); } catch (e) { return _T.defaultBeneficiaries(); } });
    const [corridors, setCorridors] = useState(() => { try { const r = localStorage.getItem(_T.CKEY); return r ? JSON.parse(r) : _T.defaultCorridors(); } catch (e) { return _T.defaultCorridors(); } });
    useEffect(() => { try { localStorage.setItem(_T.BKEY, JSON.stringify(beneficiaries)); } catch (e) {} }, [beneficiaries]);
    useEffect(() => { try { localStorage.setItem(_T.CKEY, JSON.stringify(corridors)); } catch (e) {} }, [corridors]);
    // ---- cheques + fee schedule: shared so the Ledger's "Cheque Cashing" opens
    // the SAME capture/clearance system the Cheques desk uses (one source of truth) ----
    const _K = window.CDOS._cheques;
    const [cheques, setCheques] = useState(() => { try { const r = localStorage.getItem(_K.KKEY); return r ? JSON.parse(r) : _K.defaultCheques(); } catch (e) { return _K.defaultCheques(); } });
    const [chequeSchedule, setChequeSchedule] = useState(() => { try { const r = localStorage.getItem(_K.SKEY); return r ? JSON.parse(r) : _K.defaultSchedule(); } catch (e) { return _K.defaultSchedule(); } });
    const [chequeCaptureSig, setChequeCaptureSig] = useState(0);
    useEffect(() => { try { localStorage.setItem(_K.KKEY, JSON.stringify(cheques)); } catch (e) {} }, [cheques]);
    useEffect(() => { try { localStorage.setItem(_K.SKEY, JSON.stringify(chequeSchedule)); } catch (e) {} }, [chequeSchedule]);
    useEffect(() => { try { localStorage.setItem('cdos_settings', JSON.stringify(settings)); } catch (e) {} }, [settings]);
    useEffect(() => { try { localStorage.setItem('cdos_perms', JSON.stringify(perms)); } catch (e) {} }, [perms]);
    const [tickerCfg, setTicker] = useState(() => {
      const def = { speed: 'medium', direction: 'left', metric: 'cadPerUnit', showFlags: true, showChange: true, hidden: [] };
      try { const raw = localStorage.getItem('cdos_ticker'); return raw ? { ...def, ...JSON.parse(raw) } : def; } catch (e) { return def; }
    });
    useEffect(() => { try { localStorage.setItem('cdos_ticker', JSON.stringify(tickerCfg)); } catch (e) {} }, [tickerCfg]);
    const [audit, setAudit] = useState([
      { ts: '2026-06-18 15:02', user: 'A. Singh', action: 'Transaction posted', detail: 'LT-260618-010 · Remittance — $4,100.00' },
      { ts: '2026-06-18 13:25', user: 'A. Singh', action: 'Transaction tagged', detail: 'LT-260618-006 · flagged for follow-up' },
      { ts: '2026-06-18 13:20', user: 'M. Costa', action: 'Transaction posted', detail: 'LT-260618-006 · Currency Exchange — $9,200.00' },
      { ts: '2026-06-18 12:48', user: 'M. Costa', action: 'Transaction posted', detail: 'LT-260618-009 · Remittance — $4,300.00' },
      { ts: '2026-06-18 11:14', user: 'A. Singh', action: 'Transaction posted', detail: 'LT-260618-008 · Remittance — $4,200.00' },
      { ts: '2026-06-18 10:36', user: 'A. Singh', action: 'Transaction posted', detail: 'LT-260618-011 · Currency Exchange — $4,300.00' },
      { ts: '2026-06-18 10:12', user: 'M. Costa', action: 'Transaction posted', detail: 'LT-260618-002 · Remittance — $600.00' },
      { ts: '2026-06-18 09:48', user: 'R. Haddad', action: 'KYC updated', detail: 'Northbridge Imports · source of funds verified' },
      { ts: '2026-06-18 09:41', user: 'A. Singh', action: 'Transaction posted', detail: 'LT-260618-001 · Currency Exchange — $2,400.00' },
      { ts: '2026-06-18 09:12', user: 'J. Masri', action: 'Rates published', detail: 'Rate board pushed live to all branches' },
      { ts: '2026-06-18 09:05', user: 'J. Masri', action: 'Signed in', detail: 'J. Masri · Owner' },
      { ts: '2026-06-18 09:02', user: 'System', action: 'Day opened', detail: 'Drawer floats loaded' },
    ]);
    const [receipt, setReceipt] = useState(null);
    const [addContactOpen, setAddContactOpen] = useState(false);   // quick "add a verified contact" flow, launched from the edge-rail
    const [ledgerClient, setLedgerClient] = useState(null);
    const [newDealSignal, setNewDealSignal] = useState(null);   // {n} — request the Ledger to open a fresh New-Transaction modal
    const [reportOpen, setReportOpen] = useState(null);   // {id, n} — open the Reports app focused on a specific report
    const openReport = (id) => { openApp('reports'); setReportOpen({ id, n: Date.now() }); };
    const [txToOpen, setTxToOpen] = useState(null);   // {id, n} — opens a record's detail in the Ledger
    const [ledgerView, setLedgerView] = useState(null);   // {view, n} — opens the Ledger pre-filtered (alerts jump)
    const [clientToOpen, setClientToOpen] = useState(null);   // {name, n} — opens the Clients app to a profile
    const [settingsJump, setSettingsJump] = useState(null);   // {t, n} — opens Settings to a specific section
    const [ledgerFocus, setLedgerFocus] = useState(null);   // {refs, label, n} — focus the Ledger on a specific set of records
    const [ledgerParams, setLedgerParams] = useState({});   // per-instance ledger window params: { [winId]: { client } }
    const [complianceFiling, setComplianceFiling] = useState(null);   // {report, n} — open the LCTR worksheet for a specific report

    // ---- live rate book (Rate Board → Ledger) + lock-to-freeze ----
    const [liveBook, setLiveBook] = useState(publishedBook);
    const [lockedBook, setLockedBook] = useState(() => { try { const r = localStorage.getItem('cdos_locked_book'); return r ? JSON.parse(r) : null; } catch (e) { return null; } });
    const [rateVersion, setRateVersion] = useState(0);
    const lockedBookRef = useRef(lockedBook);
    useEffect(() => { lockedBookRef.current = lockedBook; }, [lockedBook]);

    // ---- day state (Day Close finalises the book) ----
    const [day, setDay] = useState(() => { try { const r = localStorage.getItem('cdos_day'); return r ? JSON.parse(r) : { closed: false, closedAt: null, closedBy: null, summary: null, num: 1 }; } catch (e) { return { closed: false, closedAt: null, closedBy: null, summary: null, num: 1 }; } });
    useEffect(() => { try { localStorage.setItem('cdos_day', JSON.stringify(day)); } catch (e) {} }, [day]);

    // customizable dock: order + hidden + edit (jiggle) mode
    const [appOrder, setAppOrder] = useState(() => { try { const s = JSON.parse(localStorage.getItem('cdos_app_order')); if (Array.isArray(s)) return s; } catch (e) {} return APP_ORDER.slice(); });
    const [hiddenApps, setHiddenApps] = useState(() => { try { const s = JSON.parse(localStorage.getItem('cdos_app_hidden')); if (Array.isArray(s)) return s; } catch (e) {} return []; });
    const [removingApps, setRemovingApps] = useState([]);
    const [editApps, setEditApps] = useState(false);
    const [chromeCollapsed, setChromeCollapsed] = useState(false);   // click the CurrencyDesk logo to hide the tenant + app rows for more desktop room
    const [dragApp, setDragApp] = useState(null);
    const appbarRef = useRef(null);
    const orderedRef = useRef([]);
    const dragRef = useRef(null);
    const autoScroll = useRef(0);
    const autoRunning = useRef(false);
    const pointerX = useRef(0);
    useEffect(() => { try { localStorage.setItem('cdos_app_order', JSON.stringify(appOrder)); } catch (e) {} }, [appOrder]);
    useEffect(() => { try { localStorage.setItem('cdos_app_hidden', JSON.stringify(hiddenApps)); } catch (e) {} }, [hiddenApps]);

    const [wins, setWins] = useState([]);
    // per-window navigation registry: winId -> { canBack, back } so the window
    // title bar can render a Back control next to the traffic lights.
    const [winNav, setWinNav] = useState({});
    const registerWinNav = useCallback((winId, state) => {
      setWinNav(n => {
        if (state === null) { if (!(winId in n)) return n; const c = { ...n }; delete c[winId]; return c; }
        const cur = n[winId];
        if (cur && cur.canBack === state.canBack && cur.back === state.back) return n;
        return { ...n, [winId]: state };
      });
    }, []);
    // keep every open window inside the visible desktop when the viewport changes
    useEffect(() => {
      const onResize = () => {
        const deskEl = document.getElementById('desktop');
        const dw = deskEl ? deskEl.clientWidth : window.innerWidth;
        const dh = deskEl ? deskEl.clientHeight : (window.innerHeight - 96);
        setWins(ws => ws.map(w => {
          if (w.max) return (w.w === dw && w.h === dh && w.x === 0 && w.y === 0) ? w : { ...w, w: dw, h: dh, x: 0, y: 0 };
          const W = Math.max(320, Math.min(w.w, dw - 16));
          const H = Math.max(240, Math.min(w.h, dh - 16));
          const X = Math.max(8, Math.min(w.x, dw - W - 8));
          const Y = Math.max(8, Math.min(w.y, dh - H - 8));
          return (W === w.w && H === w.h && X === w.x && Y === w.y) ? w : { ...w, w: W, h: H, x: X, y: Y };
        }));
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);
    const zTop = useRef(10);
    const [clock, setClock] = useState(() => new Date());
    const [locked, setLocked] = useState(() => { try { return localStorage.getItem('yorkfx_rates_locked') === '1'; } catch (e) { return false; } });
    const [opMenu, setOpMenu] = useState(false);
    const opMenuRef = useRef(null);
    useEffect(() => {
      if (!opMenu) return;
      const h = (e) => { if (opMenuRef.current && !opMenuRef.current.contains(e.target)) setOpMenu(false); };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, [opMenu]);
    const [bellMenu, setBellMenu] = useState(false);
    const bellRef = useRef(null);
    useEffect(() => {
      if (!bellMenu) return;
      const h = (e) => { if (bellRef.current && !bellRef.current.contains(e.target)) setBellMenu(false); };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, [bellMenu]);
    const [acctMenu, setAcctMenu] = useState(false);
    const acctRef = useRef(null);
    useEffect(() => {
      if (!acctMenu) return;
      const h = (e) => { if (acctRef.current && !acctRef.current.contains(e.target)) setAcctMenu(false); };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, [acctMenu]);
    const inits = (nm) => nm.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();

    const log = (action, detail) => { setAudit(a => [{ ts: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), user: me.name, action, detail }, ...a].slice(0, 300)); try { window.CDOS.auditFx && window.CDOS.auditFx.fire(); } catch (e) {} };
    const can = (k) => me.role === 'Owner' ? true : !!perms.Teller[k];
    // switching account previews a role: it sets that person AND applies their
    // role preset to the shared (all-tellers) permission set, so the whole UI
    // reflects exactly what that role is allowed to do. Owner = all access.
    const [meApps, setMeApps] = useState(null);   // null = all apps; array = allowlist for the signed-in employee
    const [pinGate, setPinGate] = useState(null);   // { title, sub, name, expected, onOk } when a PIN is being asked
    const applyRole = (s) => {
      setMe({ name: s.name, role: s.role });
      if (s.role === 'Owner') { setMeApps(null); }
      else { const caps = s.caps || ROLE_CAPS[s.role] || {}; setPerms(p => ({ ...p, Teller: { ...caps } })); setMeApps(Array.isArray(s.apps) ? s.apps : null); }
      // scope guard: switching to a non-owner whose assignments don't include the
      // current station snaps the station to their home branch / default till (R2/R3)
      if (s.role !== 'Owner' && Array.isArray(s.branches)) {
        setStation(st => {
          if (s.branches.includes(st.branchId)) return st;
          const b = branches.find(x => s.branches.includes(x.id) && x.status === 'open') || branches.find(x => s.branches.includes(x.id));
          if (!b) return st;
          const t = (b.tills || []).find(x => x.teller === s.name && x.status !== 'closed') || (b.tills || []).find(x => x.status !== 'closed') || (b.tills || [])[0];
          return { branchId: b.id, tillId: t && t.id };
        });
      }
      log('Signed in as', `${s.name} · ${s.role}`);
    };
    /* ---- transaction PIN gates (rules set in Settings › Employees) ---- */
    const pinOf = (nm) => { const e = (settings.employees || []).find(x => x.name === nm); return (e && e.pin) || '0000'; };
    const reqPin = (nm) => { const e = (settings.employees || []).find(x => x.name === nm); return e ? e.requirePin !== false : true; };
    const askPin = (opts) => setPinGate(opts);
    const switchTo = (s) => { setAcctMenu(false); if (s.name === me.name) return; const need = settings.pinOnSwitch !== false && s.requirePin !== false; if (need) askPin({ title: 'Switch account', sub: 'Enter ' + s.name + '’s PIN to continue', name: s.name, expected: s.pin || '0000', onOk: () => applyRole(s) }); else applyRole(s); };
    const tillGate = (fn) => { const need = settings.pinOnTill !== false && reqPin(me.name); if (need) askPin({ title: 'Confirm it’s you', sub: 'Enter your PIN to take this drawer', name: me.name, expected: pinOf(me.name), onOk: fn }); else fn(); };

    /* Routing per §04 of the Branch & Access Model spec — a pure function of
       role + assignments. Owner → full picker. One branch + a posted till →
       straight to the desktop (the single-shop base case, rule R10). One
       branch, no till → till pick. Multiple → filtered picker. None → stop. */
    const routeAfterAuth = (rec) => {
      if (!rec) { setStage('lock'); return; }
      applyRole(rec);
      const isOwner = rec.role === 'Owner' || rec.branches === '*';
      const allowed = isOwner ? branches : branches.filter(b => Array.isArray(rec.branches) && rec.branches.includes(b.id));
      if (!allowed.length) { setStage('noassign'); return; }
      if (!isOwner && allowed.length === 1) {
        const b = allowed[0];
        const mine = b.status === 'open' && (b.tills || []).find(t => t.teller === rec.name && t.status !== 'closed');
        if (mine) { setStation({ branchId: b.id, tillId: mine.id }); enterDesktop(); return; }
      }
      setStage('station');
    };

    useEffect(() => { const t = setInterval(() => { setClock(new Date()); }, 1000); return () => clearInterval(t); }, []);

    // react to the staff Rate Board republishing (storage events fire from the
    // embedded board iframe) and to an external lock toggle
    useEffect(() => {
      const sync = () => {
        const nb = publishedBook();
        setLiveBook(prev => bookSig(prev) === bookSig(nb) ? prev : nb);
        try {
          const ext = localStorage.getItem('yorkfx_rates_locked') === '1';
          setLocked(cur => {
            if (ext && !cur && !lockedBookRef.current) { const s = publishedBook(); setLockedBook(s); try { localStorage.setItem('cdos_locked_book', JSON.stringify(s)); } catch (e) {} }
            return ext;
          });
        } catch (e) {}
      };
      const onStorage = (e) => { if (!e || !e.key || /yorkfx_rates/.test(e.key)) sync(); };
      window.addEventListener('storage', onStorage);
      const t = setInterval(sync, 3000);
      return () => { window.removeEventListener('storage', onStorage); clearInterval(t); };
    }, []);

    // the active book is the live board, or the frozen snapshot while locked.
    // Push it into the rate engine so crossRate()/perCadLive() reflect it, and
    // bump rateVersion so any open New-Transaction modal re-prices.
    const activeBook = (locked && lockedBook) ? lockedBook : liveBook;
    const activeSig = bookSig(activeBook);
    useEffect(() => { applyBook(activeBook); setRateVersion(v => v + 1); }, [activeSig]);

    // Sealed compliance filings — owned here so the menu-bar badge reflects a seal
    // the instant it happens (Compliance seals through setSubs; both persist the key).
    const [subs, setSubs] = useState(() => { try { return JSON.parse(localStorage.getItem('cdos_submissions_v1') || '{}') || {}; } catch (e) { return {}; } });
    useEffect(() => { try { localStorage.setItem('cdos_submissions_v1', JSON.stringify(subs)); } catch (e) {} }, [subs]);

    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    // A sealed cash filing is "welded to the records that triggered it" — mirror that
    // onto the ledger rows so the ledger flags, dashboard and this badge all agree on
    // what's filed. Wire/EFT filings reference transfers, not ledger rows, so are skipped.
    useEffect(() => {
      const _c = window.CDOS._compliance; if (!_c) return;
      const sealed = new Set(Object.keys(subs).filter(id => subs[id] && subs[id].status === 'submitted'));
      if (!sealed.size) return;
      const reg = window.CDOS.getRegime(settings);
      const filedRefs = new Set();
      rows.forEach(r => { if (sealed.has('L-' + r.ref)) filedRefs.add(r.ref); });
      (_c.aggClusters(rows, reg, settings) || []).forEach(c => { if (sealed.has(c.id)) (c.txs || []).forEach(t => filedRefs.add(t.ref)); });
      if (!rows.some(r => filedRefs.has(r.ref) && !r.filed && r.status !== 'void')) return;
      const at = new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
      setRows(rs => rs.map(r => (filedRefs.has(r.ref) && !r.filed && r.status !== 'void')
        ? { ...r, filed: true, filedInfo: r.filedInfo || { ref: (subs['L-' + r.ref] && subs['L-' + r.ref].ackNo) ? ('FWR ' + subs['L-' + r.ref].ackNo) : 'Filed · Compliance', by: me.name, at } }
        : r));
    }, [subs, rows, settings]);
    // Open reportable OBLIGATIONS not yet sealed — the identical canonical list the
    // Compliance ▸ Filings page shows, so the badge and that page can never disagree.
    const openObligations = useMemo(() => {
      const fn = window.CDOS.openReportables;
      return fn ? fn(rows, clients, settings, beneficiaries, subs) : [];
    }, [rows, clients, settings, beneficiaries, subs]);
    // computeAlerts still supplies the (row-based) structuring + KYC tallies; the
    // reportable count comes from the obligation list above.
    const alerts = useMemo(() => ({ ...computeAlerts(rows, flags), rpt: openObligations.length }), [rows, flags, openObligations]);
    // house settings that break the active regulator's hard rules — persistent until fixed
    const jViol = useMemo(() => (window.CDOS.jurisdictionViolations ? window.CDOS.jurisdictionViolations(settings) : []), [settings]);
    // per-item breakdown for the bell preview dropdown
    const alertList = useMemo(() => {
      const strM = new Map(), kycM = new Map();
      rows.forEach(r => {
        const f = flags[r.id]; if (!f || f.void) return;
        if (f.str && !r.ackStr) {
          const e = strM.get(r.customer) || { customer: r.customer, id: r.id, count: 0, agg: 0 };
          e.count += 1; e.agg = Math.max(e.agg, f.agg || 0);
          strM.set(r.customer, e);
        }
        if (f.kyc !== 'ok' && f.idNeeded && !kycM.has(r.customer)) kycM.set(r.customer, { customer: r.customer, reason: f.kyc });
      });
      const rpt = openObligations.map(o => ({ id: o.id, ref: (o.refs && o.refs[0]) || o.reportRef || o.id, customer: o.subject, agg: /^AGG/.test(String(o.id)), kind: o.kind, obligation: o }));
      return { rpt, str: [...strM.values()], kyc: [...kycM.values()] };
    }, [rows, flags, openObligations]);

    const baseApp = (id) => String(id).split('~')[0];
    const ledgerSeq = useRef(0);
    const winSeq = useRef(0);
    // clamp a new window box to the visible desktop so no window (and none of its
    // content — e.g. right-aligned action buttons) ever spills past the viewport.
    const fitBox = (x, y, w, h) => {
      const deskEl = document.getElementById('desktop');
      const dw = deskEl ? deskEl.clientWidth : window.innerWidth;
      const dh = deskEl ? deskEl.clientHeight : (window.innerHeight - 96);
      const W = Math.max(320, Math.min(w, dw - 16));
      const H = Math.max(240, Math.min(h, dh - 16));
      const X = Math.max(8, Math.min(x, dw - W - 8));
      const Y = Math.max(8, Math.min(y, dh - H - 8));
      return { x: X, y: Y, w: W, h: H };
    };
    function focusWin(id) { setWins(ws => ws.map(w => w.id === id ? { ...w, z: ++zTop.current, min: false } : w)); }
    function openApp(id) {
      if (id !== 'settings' && id !== 'store' && !planAllows(id)) { openSettingsTab('billing'); return; }
      setWins(ws => {
        const ex = ws.find(w => w.id === id);
        if (ex) return ws.map(w => w.id === id ? { ...w, z: ++zTop.current, min: false } : w);
        const meta = APPMETA[baseApp(id)]; const n = ws.length;
        const box = fitBox(80 + (n % 6) * 30, 64 + (n % 6) * 26, meta.w, meta.h);
        return [...ws, { id, ...box, z: ++zTop.current, min: false }];
      });
    }
    const closeWin = (id) => { if (id === 'store') setEditApps(false); setWins(ws => ws.filter(w => w.id !== id)); };
    const minWin = (id) => setWins(ws => ws.map(w => w.id === id ? { ...w, min: true } : w));
    const zoomWin = (id) => {
      const deskEl = document.getElementById('desktop');
      const dw = deskEl ? deskEl.clientWidth : window.innerWidth;
      const dh = deskEl ? deskEl.clientHeight : window.innerHeight - 96;
      setWins(ws => ws.map(w => {
        if (w.id !== id) return w;
        if (w.max) { const p = w.prev || { x: 80, y: 64, w: APPMETA[baseApp(id)].w, h: APPMETA[baseApp(id)].h }; return { ...w, x: p.x, y: p.y, w: p.w, h: p.h, max: false, z: ++zTop.current }; }
        return { ...w, prev: { x: w.x, y: w.y, w: w.w, h: w.h }, x: 0, y: 0, w: dw, h: dh, max: true, z: ++zTop.current };
      }));
    };
    const moveWin = (id, x, y) => setWins(ws => ws.map(w => w.id === id ? { ...w, x, y } : w));
    const sizeWin = (id, box) => setWins(ws => ws.map(x => x.id === id ? { ...x, ...box } : x));
    // open ANOTHER window of the same app — a live mirror. Every instance reads
    // the one shared data model, so a change made in any copy shows in them all.
    const duplicateWin = (id) => {
      const base = baseApp(id);
      const nid = base + '~' + (++winSeq.current);
      const meta = APPMETA[base] || APPMETA.ledger;
      setWins(ws => { const n = ws.length; const box = fitBox(80 + (n % 6) * 30, 64 + (n % 6) * 26, meta.w, meta.h); return [...ws, { id: nid, ...box, z: ++zTop.current, min: false }]; });
    };
    // snap a window to a quadrant / half / full of the desktop so several apps
    // can be arranged side-by-side (top-left, top-right, bottom-left, …).
    const snapWin = (id, region) => {
      const deskEl = document.getElementById('desktop');
      const dw = deskEl ? deskEl.clientWidth : window.innerWidth;
      const dh = deskEl ? deskEl.clientHeight : (window.innerHeight - 96);
      const hw = Math.floor(dw / 2), hh = Math.floor(dh / 2);
      const R = {
        tl: { x: 0, y: 0, w: hw, h: hh }, tr: { x: dw - hw, y: 0, w: hw, h: hh },
        bl: { x: 0, y: dh - hh, w: hw, h: hh }, br: { x: dw - hw, y: dh - hh, w: hw, h: hh },
        left: { x: 0, y: 0, w: hw, h: dh }, right: { x: dw - hw, y: 0, w: hw, h: dh },
        top: { x: 0, y: 0, w: dw, h: hh }, bottom: { x: 0, y: dh - hh, w: dw, h: hh },
        full: { x: 0, y: 0, w: dw, h: dh },
      }[region];
      if (!R) return;
      setWins(ws => ws.map(w => w.id === id ? { ...w, ...R, max: false, min: false, z: ++zTop.current } : w));
    };
    const openLedgerForClient = (name) => {
      if (!name) { openApp('ledger'); return; }
      // one ledger window per account — open a new numbered window, or focus its existing one
      const ex = wins.find(w => baseApp(w.id) === 'ledger' && ledgerParams[w.id] && ledgerParams[w.id].client === name);
      if (ex) { focusWin(ex.id); return; }
      const id = 'ledger~' + (++ledgerSeq.current);
      setLedgerParams(p => ({ ...p, [id]: { client: name } }));
      setWins(ws => { const meta = APPMETA.ledger; const n = ws.length; const box = fitBox(80 + (n % 6) * 30, 64 + (n % 6) * 26, meta.w, meta.h); return [...ws, { id, ...box, z: ++zTop.current, min: false }]; });
    };
    // open a NEW numbered ledger window focused on a specific set of records (an aggregate, a flag set, etc.)
    const openLedgerForRefs = (refs, label) => {
      if (!refs || !refs.length) return;
      const id = 'ledger~' + (++ledgerSeq.current);
      setLedgerParams(p => ({ ...p, [id]: { focusRefs: refs, focusLabel: label || 'Records' } }));
      setWins(ws => { const meta = APPMETA.ledger; const n = ws.length; const box = fitBox(80 + (n % 6) * 30, 64 + (n % 6) * 26, meta.w, meta.h); return [...ws, { id, ...box, z: ++zTop.current, min: false }]; });
    };
    // open the Clients/KYC app straight to a client's full profile
    const openClientProfile = (name, txRef) => { setClientToOpen({ name, txRef: txRef || null, n: Date.now() }); openApp('clients'); };
    const openTransaction = (id) => { setTxToOpen({ id, n: Date.now() }); openApp('ledger'); };
    const openSettingsTab = (t) => { setSettingsJump({ t, n: Date.now() }); openApp('settings'); };
    const openLedgerRefs = (refs, label) => { setLedgerFocus({ refs, label, n: Date.now() }); openApp('ledger'); };
    // open the Compliance app straight into the LCTR/EFTR filing worksheet for one report
    const openComplianceFiling = (report) => { setComplianceFiling({ report, n: Date.now() }); openApp('compliance'); };
    // quick actions executed straight from the compliance bell
    const ackStructuringFor = (customer) => {
      const at = new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
      setRows(rs => rs.map(r => (r.customer === customer && (flags[r.id] || {}).str && !r.ackStr) ? { ...r, ackStr: true, ackStrInfo: { by: me.name, at } } : r));
      log && log('Structuring acknowledged', `${customer} reviewed from alerts`);
    };
    const fileReportableRow = (id) => {
      const r = rows.find(x => x.id === id); if (!r) { openApp('compliance'); return; }
      const reg = window.CDOS.getRegime(settings);
      openComplianceFiling({ id: 'L-' + r.ref, kind: reg.largeCode, subject: r.customer, beneficiary: r.beneficiary, amount: (r.inCcy === 'CAD' ? (+r.inAmt || 0) : (+r.inAmt || 0) / (crossRate('CAD', r.inCcy) || 1)), refs: [r.ref], basis: null });
    };

    // ---- customizable dock helpers ----
    const moveApp = (drag, over) => {
      if (drag === over) return;
      setAppOrder(() => {
        const cur = orderedRef.current.slice();
        const from = cur.indexOf(drag), to = cur.indexOf(over);
        if (from < 0 || to < 0) return cur;
        cur.splice(to, 0, cur.splice(from, 1)[0]);
        return cur;
      });
    };
    const removeApp = (id) => { setHiddenApps(h => h.includes(id) ? h : [...h, id]); };
    const restoreApp = (id) => { setHiddenApps(h => h.filter(x => x !== id)); };
    // animate the icon out of the dock, then drop it (so it visibly returns to the store)
    const animateRemove = (id) => {
      setRemovingApps(r => r.includes(id) ? r : [...r, id]);
      setTimeout(() => { removeApp(id); setRemovingApps(r => r.filter(x => x !== id)); }, 300);
    };
    // open the storefront and put the dock into arrange (jiggle) mode
    const toggleStore = () => {
      const open = wins.some(w => w.id === 'store');
      // the check button always tears down: close the store AND stop the jiggle
      if (open || editApps) { if (open) closeWin('store'); setEditApps(false); }
      else { openApp('store'); setEditApps(true); }
    };
    // reorder the icon currently under the pointer past its neighbour
    const swapAtPointer = () => {
      const el = appbarRef.current; if (!el) return;
      const x = pointerX.current;
      const btns = [...el.querySelectorAll('.app-btn[data-app]')];
      for (const b of btns) {
        const id2 = b.getAttribute('data-app'); if (id2 === dragRef.current) continue;
        const br = b.getBoundingClientRect();
        const mid = br.left + br.width / 2;
        // only swap once the pointer has crossed the neighbour's midpoint
        if (x >= br.left && x <= br.right && ((x < mid) || (x >= mid))) { moveApp(dragRef.current, id2); break; }
      }
    };
    // keep nudging scrollLeft while the pointer rests against an edge
    const autoLoop = () => {
      const el = appbarRef.current;
      if (!el || !autoScroll.current) { autoRunning.current = false; return; }
      el.scrollLeft += autoScroll.current;
      swapAtPointer();
      requestAnimationFrame(autoLoop);
    };
    const startAppDrag = (e, id) => {
      if (!editApps) return;
      e.preventDefault(); e.stopPropagation();
      setDragApp(id); dragRef.current = id;
      try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (er) {}
      const move = (ev) => {
        pointerX.current = ev.clientX;
        const el = appbarRef.current; if (!el) return;
        const r = el.getBoundingClientRect();
        autoScroll.current = ev.clientX > r.right - 70 ? 16 : ev.clientX < r.left + 70 ? -16 : 0;
        if (autoScroll.current && !autoRunning.current) { autoRunning.current = true; requestAnimationFrame(autoLoop); }
        swapAtPointer();
      };
      const up = () => {
        setDragApp(null); dragRef.current = null; autoScroll.current = 0; autoRunning.current = false;
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    // wheel over the dock scrolls horizontally through the apps (ticker feel).
    // A regular mouse only sends deltaY, so map whichever axis is larger onto
    // scrollLeft; a Mac trackpad's native deltaX still scrolls on its own. We
    // only intercept when there is actually overflow to scroll.
    useEffect(() => {
      const el = appbarRef.current; if (!el) return;
      const onWheel = (ev) => {
        if (el.scrollWidth <= el.clientWidth + 1) return;       // truly nothing to scroll
        const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
        if (!delta) return;
        const before = el.scrollLeft;
        el.scrollLeft += delta;
        if (el.scrollLeft !== before) ev.preventDefault();       // only eat the page-scroll when the row actually moved
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [stage]);

    // folder-tab bars auto-hide as you read down a report and slide back on scroll-up /
    // cursor-near-top. Ledger's bar is .fld-pinned so it never hides. One shell-level
    // listener covers every app window (scroll doesn't bubble, so capture phase).
    useEffect(() => {
      if (stage !== 'desktop') return;
      const lastY = new WeakMap();
      const onScroll = (e) => {
        const sc = e.target;
        if (!(sc instanceof HTMLElement) || !sc.classList || !sc.classList.contains('overflow-auto')) return;
        const body = sc.closest('.win-body'); if (!body) return;
        const bar = body.querySelector('.fld-bar'); if (!bar || bar.classList.contains('fld-pinned')) return;
        const y = sc.scrollTop, prev = lastY.get(sc) || 0;
        if (y <= 4 || y < prev - 4) bar.classList.remove('fld-hidden');
        else if (y > prev + 4 && y > 44) bar.classList.add('fld-hidden');
        lastY.set(sc, y);
      };
      const onMove = (e) => {
        const t = e.target; if (!(t instanceof Element)) return;
        const body = t.closest('.win-body'); if (!body) return;
        const bar = body.querySelector('.fld-bar'); if (!bar || !bar.classList.contains('fld-hidden')) return;
        const r = body.getBoundingClientRect();
        if (e.clientY - r.top < 62) bar.classList.remove('fld-hidden');
      };
      document.addEventListener('scroll', onScroll, true);
      document.addEventListener('pointermove', onMove, true);
      return () => { document.removeEventListener('scroll', onScroll, true); document.removeEventListener('pointermove', onMove, true); };
    }, [stage]);

    // quick-access operations (top-right cohesive section)
    const quickNewDeal = () => {
      if (day.closed) { openApp('till'); log('New transaction blocked', 'Day is closed — reopen to post'); return; }
      setLedgerClient(null);
      openApp('ledger');
      // timestamped intent so a freshly-mounted Ledger also opens the modal
      setNewDealSignal({ n: Date.now() });
    };
    const toggleLock = () => {
      const next = !locked;
      try { localStorage.setItem('yorkfx_rates_locked', next ? '1' : '0'); } catch (e) {}
      if (next) {
        const snap = publishedBook();
        setLockedBook(snap);
        try { localStorage.setItem('cdos_locked_book', JSON.stringify(snap)); } catch (e) {}
      } else {
        setLockedBook(null);
        try { localStorage.removeItem('cdos_locked_book'); } catch (e) {}
      }
      setLocked(next);
      log(next ? 'Rates locked' : 'Rates unlocked', next ? 'Held at last published pull' : 'Following the live board');
    };
    // alerts → open the Ledger pre-filtered to the most urgent flag bucket
    const openLedgerFiltered = (view) => { setLedgerView({ view, n: Date.now() }); openApp('ledger'); };
    const jumpAlerts = () => {
      const v = alerts.rpt > 0 ? 'RPT' : alerts.str > 0 ? 'STR' : alerts.id > 0 ? 'ID' : 'open';
      openLedgerFiltered(v);
    };
    // Day Close finalises the book; reopening starts the next day
    const closeDay = (summary) => {
      setDay(d => ({ ...d, closed: true, closedAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), closedBy: me.name, summary }));
      log('Day closed', summary && summary.note ? summary.note : 'Drawer reconciled — book locked');
    };
    const openNextDay = () => {
      setDay(d => ({ closed: false, closedAt: null, closedBy: null, summary: null, num: (d.num || 1) + 1 }));
      log('Day opened', 'New trading day — book unlocked');
    };

    function enterDesktop() {
      try { sessionStorage.setItem(AUTH_KEY, '1'); sessionStorage.setItem('yorkfx_staff_user', user || 'staff'); } catch (e) {}
      setStage('desktop');
      setTimeout(() => { openApp(planAllows('ledger') ? 'ledger' : 'rates'); }, 60);
    }
    function logout() {
      try { sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
      // sign-out frees the till — the operator session ends with the person
      setBranches(list => list.map(b => ({ ...b, tills: (b.tills || []).map(t => t.operator === me.name ? { ...t, operator: '' } : t) })));
      setWins([]); setStage('lock');
    }

    // plan gating: which apps the active subscription unlocks. Defined BEFORE the
    // stage early-returns so closures created on the lock/otp/station screens
    // (e.g. enterDesktop's deferred openApp) capture an initialized binding
    // rather than hitting the temporal dead zone.
    const activePlan = (settings && settings.billingPlan) || 'premium';
    const planAllows = (id) => {
      if (id === 'settings' || id === 'store') return true;
      if (activePlan === 'premium') return true;
      if (activePlan === 'pro') return id !== 'assistant';
      return id === 'rates' || id === 'telegraph'; // basic — rate board + Texts
    };

    if (stage === 'lock') return <Lock employees={settings.employees || []} onSignup={() => setStage('signup')} onNext={(rec, temp, srvPlan) => { if (rec._adopted) setSettings(s => ({ ...s, employees: [...(s.employees || []), { ...rec, _adopted: undefined }] })); if (srvPlan) setSettings(s => ({ ...s, billingPlan: srvPlan })); setUser(rec.code || rec.name); setAuthRec(rec); setPwTemp(temp || null); setStage(temp ? 'setpass' : 'otp'); }} />;
    if (stage === 'signup') return <OnboardWizard onBack={() => setStage('lock')} onSent={(email) => { setSignup({ email }); setStage('verify'); }} />;
    if (stage === 'verify') return <VerifySignup email={signup && signup.email} onBack={() => setStage('signup')} onVerified={(d) => { setNewDesk(d); setStage('created'); }} />;
    if (stage === 'created') return <DeskCreated desk={newDesk} onEnter={() => {
      // adopt the new owner into the local directory and route in (per-tenant
      // data lands with Phase B; today this opens the OS as the owner)
      const u = (newDesk && newDesk.user) || {};
      const rec = { id: 'e_owner_' + Date.now(), code: u.id, name: u.name || 'Owner', role: 'Owner', active: true, branches: '*', home: null };
      setSettings(s => ({ ...s, employees: [...(s.employees || []).filter(e => e.code !== rec.code), rec] }));
      setUser(rec.code); setAuthRec(rec); routeAfterAuth(rec);
    }} />;
    if (stage === 'setpass') return <SetPassword staffId={user} current={pwTemp && pwTemp.current} onDone={() => { setPwTemp(null); setStage('otp'); }} onBack={() => { setPwTemp(null); setStage('lock'); }} />;
    if (stage === 'otp') return <Otp user={user} onBack={() => setStage('lock')} onVerify={() => routeAfterAuth(authRec)} />;
    if (stage === 'noassign') { const mgr = (settings.employees || []).find(e => e.role === 'Manager' && e.active !== false) || (settings.employees || []).find(e => e.role === 'Owner'); return <NoAssign rec={authRec} manager={mgr && mgr.name} onBack={() => setStage('lock')} />; }
    if (stage === 'station') return <StationPicker branches={branches} station={station} rec={authRec} onBack={() => setStage('otp')} onPick={(st) => { setStation(st); enterDesktop(); }} />;

    const topWin = wins.filter(w => !w.min).sort((a, b) => b.z - a.z)[0];
    const activeId = topWin ? topWin.id : null;
    const activeBase = topWin ? baseApp(topWin.id) : null;   // focused app — the one nav item allowed to show its identity colour
    const ledgerOrder = wins.filter(w => baseApp(w.id) === 'ledger');
    const metaFor = (w) => {
      const baseId = baseApp(w.id);
      const base = APPMETA[baseId] || APPMETA.ledger;
      const accent = APP_ACCENT[baseId] || CD.ink;
      const group = wins.filter(x => baseApp(x.id) === baseId);
      if (group.length > 1) {
        const idx = group.findIndex(x => x.id === w.id) + 1;
        const lp = ledgerParams[w.id];
        const extra = (baseId === 'ledger' && lp && (lp.client || lp.focusLabel)) ? ' · ' + (lp.client || lp.focusLabel) : '';
        return { ...base, accent, title: base.title + ' ' + idx + extra };
      }
      return { ...base, accent };
    };
    const canSettings = me.role === 'Owner' || perms.Teller.canSettings;
    const alertCount = alerts.str + alerts.id + alerts.rpt + jViol.length;
    const initials = me.name.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    const _activeBranch = branches.find(b => b.id === station.branchId) || branches[0];
    const _activeTill = _activeBranch && (_activeBranch.tills || []).find(t => t.id === station.tillId);
    const stationName = _activeBranch ? _activeBranch.name : 'Front Desk 01';
    const stationTill = _activeTill ? _activeTill.name : '';
    const permsOk = (id) => {
      if (meApps && id !== 'settings' && !meApps.includes(id)) return false;
      if (id === 'dashboard' || id === 'reports' || id === 'vault' || id === 'branches') return can('canViewReports');
      if (id === 'till') return can('canViewReports') || can('canCloseDay');
      if (id === 'settings') return me.role === 'Owner' || perms.Teller.canSettings;
      return true;
    };
    // plan gating: which apps the active subscription unlocks. Locked apps drop
    // off the dock and sit in the Store behind an upgrade paywall — the OS shell
    // is identical regardless of plan. settings/store are always reachable.
    // (activePlan / planAllows are defined above the stage early-returns.)
    // merge saved order with any apps added in code; keep only valid + permitted
    const orderedApps = (() => {
      const out = appOrder.filter((id, i) => APP_ORDER.includes(id) && appOrder.indexOf(id) === i);
      APP_ORDER.forEach(id => { if (!out.includes(id)) out.push(id); });
      return out.filter(permsOk);
    })();
    orderedRef.current = orderedApps;
    // the dock only ever shows installed apps; removed ones live in the store now
    const visibleApps = orderedApps.filter(id => (!hiddenApps.includes(id) || removingApps.includes(id)) && planAllows(id));

    // ---- Store sections ----
    const mkApp = (id) => ({ id, title: APPMETA[id].title, icon: APPMETA[id].icon, desc: (STORE_DESC && STORE_DESC[id]) || '' });
    const storeInstalled = orderedApps.filter(id => !hiddenApps.includes(id) && planAllows(id)).map(mkApp);
    const storeAvailable = orderedApps.filter(id => hiddenApps.includes(id) && planAllows(id)).map(mkApp);
    const storeLocked = orderedApps.filter(id => !planAllows(id)).map(mkApp);

    function renderApp(id) {
      switch (baseApp(id)) {
        case 'rates': return <iframe src={(window.__resources && window.__resources.rateBoard) ? window.__resources.rateBoard + '#embed' : 'YorkFX/YorkFX Rate Board.html?embed=1'} title="Rate Board"></iframe>;
        case 'telegraph': return <Telegraph settings={settings} me={me} log={log} openSettings={() => openSettingsTab('texts')} onStartTx={planAllows('ledger') ? ((tref) => { window.__cdosTqPrefill = tref; openApp('ledger'); setNewDealSignal({ n: Date.now() }); }) : null} />;
        case 'ledger': return id !== 'ledger'
          ? <Ledger {...{ rows, setRows, clients, setClients, settings, me, perms, log, setReceipt, client: (ledgerParams[id] || {}).client || null, setClient: () => {}, openLedgerForClient, openLedgerForRefs, openClientProfile, focusSignal: ((ledgerParams[id] || {}).focusRefs) ? { refs: ledgerParams[id].focusRefs, label: ledgerParams[id].focusLabel, n: id } : undefined, rateVersion, dayClosed: day.closed, onOpenDayClose: () => openApp('till'), cheques, setCheques, chequeSchedule, onOpenCheques: () => { setChequeCaptureSig(Date.now()); openApp('cheques'); }, onOpenCompliance: () => openApp('compliance'), registerNav: registerWinNav, winId: id, onFileLCTR: openComplianceFiling }} />
          : <Ledger {...{ rows, setRows, clients, setClients, settings, me, perms, log, setReceipt, client: ledgerClient, setClient: setLedgerClient, newSignal: newDealSignal, onNewConsumed: () => setNewDealSignal(null), openLedgerForClient, openLedgerForRefs, openClientProfile, txToOpen, viewSignal: ledgerView, focusSignal: ledgerFocus, rateVersion, dayClosed: day.closed, onOpenDayClose: () => openApp('till'), cheques, setCheques, chequeSchedule, onOpenCheques: () => { setChequeCaptureSig(Date.now()); openApp('cheques'); }, onOpenCompliance: () => openApp('compliance'), registerNav: registerWinNav, winId: id, onFileLCTR: openComplianceFiling }} />;
        case 'transfers': return <Transfers {...{ rows, setRows, clients, setClients, settings, me, log, beneficiaries, setBeneficiaries, corridors, setCorridors }} />;
        case 'cheques': return <Cheques {...{ rows, setRows, clients, settings, me, log, cheques, setCheques, schedule: chequeSchedule, setSchedule: setChequeSchedule, captureSignal: chequeCaptureSig }} />;
        case 'compliance': return <Compliance {...{ rows, setRows, clients, setClients, beneficiaries, settings, setSettings, me, log, baseline, receipts, day, station, branches, subs, setSubs, onOpenSettings: () => openSettingsTab('compliance'), onOpenTransaction: openTransaction, onOpenClient: openClientProfile, onOpenRefs: openLedgerRefs, onOpenTransfers: () => openApp('transfers'), fileSignal: complianceFiling }} />;
        case 'clients': return <Clients {...{ rows, clients, setClients, settings, me, perms, log, openLedgerForClient, openProfileSignal: clientToOpen, beneficiaries, setBeneficiaries, corridors }} />;
        case 'dashboard': return <Dashboard rows={rows} clients={clients} settings={settings} me={me} onOpenLedger={() => openApp('ledger')} onOpenClient={openClientProfile} openFiltered={openLedgerFiltered} onOpenApp={openApp} />;
        case 'till': return <TillDrawer rows={rows} log={log} day={day} onCloseDay={closeDay} onOpenNextDay={openNextDay} me={me} canCloseDay={can('canCloseDay')} baseline={baseline} setBaseline={setBaseline} receipts={receipts} stationName={stationName} stationTill={stationTill} branches={branches} station={station} setStation={setStation} onOpenReport={openReport} settings={settings} onMoveCash={setMoveCash} onOpenVault={() => openApp('vault')} moves={branchMoves} />;
        case 'vault': return <Vault rows={rows} me={me} log={log} baseline={baseline} receipts={receipts} setReceipts={setReceipts} settings={settings} setSettings={setSettings} branches={branches} station={station} onMoveCash={setMoveCash} onOpenBranches={() => openApp('branches')} moves={branchMoves} onOrderReceived={creditVault} onIssueTill={issueToTill} />;
        case 'branches': return <Branches me={me} log={log} branches={branches} setBranches={setBranches} moves={branchMoves} setMoves={setBranchMoves} station={station} setStation={setStation} gate={tillGate} settings={settings} setSettings={setSettings} onOpenTill={() => openApp('till')} />;
        case 'audit': return <Audit audit={audit} settings={settings} />;
        case 'settings': return <SettingsView {...{ perms, setPerms, settings, setSettings, me, log, tickerCfg, setTicker, branches, setBranches, branchMoves, setBranchMoves, jump: settingsJump, rows, setRows, clients, setClients, onOpenLedger: () => openApp('ledger'), askPin, reqPin, pinOf }} />;
        case 'calc': return <Calc settings={settings} />;
        case 'loan': return <LoanCalc />;
        case 'assistant': return <Assistant rows={rows} clients={clients} alerts={alerts} me={me} />;
        case 'reports': return <Reports rows={rows} clients={clients} settings={settings} me={me} baseline={baseline} receipts={receipts} day={day} station={station} branches={branches} openSignal={reportOpen} />;
        case 'pricing': return <Pricing settings={settings} setSettings={setSettings} me={me} log={log} />;
        case 'store': return <AppStore installed={storeInstalled} available={storeAvailable} locked={storeLocked} plan={activePlan} coming={COMING || []} onAdd={restoreApp} onRemove={removeApp} onOpen={openApp} onUpgrade={() => openSettingsTab('billing')} />;
        case 'tagged': return <Tagged {...{ rows, clients, settings, onOpen: openTransaction }} />;
        default: return null;
      }
    }

    return (<div id="os">
      {/* MENU BAR */}
      <div id="menubar">
        <div className="mb-brand" title={chromeCollapsed ? 'Show the app row' : 'Hide the bars for more room'} style={{ cursor: 'pointer' }} onClick={() => setChromeCollapsed(c => !c)}>
          <svg viewBox="12 22 172 96" style={{ height: 24, width: 'auto', display: 'block' }} aria-hidden="true">
            <mask id="mbLogoSlot"><rect x="12" y="22" width="172" height="96" fill="#fff"></rect><rect x="60" y="64.5" width="92" height="11" fill="#000"></rect></mask>
            <g mask="url(#mbLogoSlot)" fill="currentColor"><circle cx="60" cy="70" r="48"></circle><path d="M116,22 H136 A48,48 0 0 1 136,118 H116 Z"></path></g>
            <circle cx="112" cy="70" r="6.5" fill="var(--cd-green)"></circle>
          </svg>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }} aria-label="CurrencyDesk OS">
            <span style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '0.02em' }}>CURRENCYDESK</span>
            <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 9.5, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--cd-green)', transform: 'translateY(-4px)', display: 'inline-block' }}>OS</span>
          </span>
        </div>
        <span className="mb-sep"></span>
        <span className="mb-active">{topWin ? metaFor(topWin).title : 'Desktop'}</span>
        <div className="mb-right" style={{ marginLeft: 'auto' }}>
          <div className="mb-ops">
            <div className="mb-bell-wrap" ref={bellRef}>
              <button className={'mb-op mb-bell' + (alertCount > 0 ? ' has' : '') + (bellMenu ? ' on-bell' : '')} aria-expanded={bellMenu} title={alertCount > 0 ? `${alertCount} compliance item${alertCount === 1 ? '' : 's'} flagged` : 'No open compliance flags'} onClick={() => setBellMenu(o => !o)}>
                <Ic n="alert" s={17} />
                {alertCount > 0 && <span className="mb-bell-count">{alertCount}</span>}
              </button>
              {bellMenu && (
                <div className="mb-menu bell-menu mb-menu-solid" role="menu">
                  <div className="bell-head">
                    <div className="bell-head-l">
                      <span className="bell-head-ic"><Ic n={alertCount > 0 ? 'alert' : 'shield'} s={16} c={alertCount > 0 ? CD.flag : CD.ink} /></span>
                      <span><b>Compliance</b><i>{alertCount > 0 ? `${alertCount} item${alertCount === 1 ? '' : 's'} need attention` : 'All clear'}</i></span>
                    </div>
                    {alertCount > 0 && <button className="bell-head-all" onClick={() => { setBellMenu(false); openApp('compliance'); }}>View all</button>}
                  </div>
                  {alertCount === 0 ? (
                    <div className="bell-empty"><Ic n="check" s={22} c={CD.green} /><span>No open flags. Reportables filed, IDs current, no structuring watch.</span></div>
                  ) : (
                    <div className="bell-body">
                      {jViol.length > 0 && (
                        <div className="bell-sec">
                          <div className="bell-cap"><span className="bell-dot sig-hi"></span>{jViol[0].authority} rules violated<i>{jViol.length}</i></div>
                          {jViol.map(v => (
                            <div key={v.id} className="bell-row tall" onClick={() => { setBellMenu(false); openSettingsTab('compliance'); }}>
                              <div className="bell-row-main">
                                <span className="bell-row-name" style={{ color: CD.flag }}>{v.label}</span>
                                <span className="bell-row-sub">{v.detail}</span>
                              </div>
                              <button className="bell-act" title="Open Compliance settings to fix this" onClick={(e) => { e.stopPropagation(); setBellMenu(false); openSettingsTab('compliance'); }}>Fix →</button>
                            </div>
                          ))}
                        </div>
                      )}
                      {alertList.rpt.length > 0 && (
                        <div className="bell-sec">
                          <div className="bell-cap"><span className="bell-dot sig-hi"></span>Unfiled reportables<i>{alertList.rpt.length}</i></div>
                          {alertList.rpt.slice(0, 4).map(it => (
                            <div key={it.id} className="bell-row" onClick={() => { setBellMenu(false); openApp('compliance'); }}>
                              <span className="bell-row-ref">{it.ref}</span>
                              <span className="bell-row-name">{it.customer}</span>
                              <span className="bell-row-tag">{it.agg ? '24h agg' : (it.kind === window.CDOS.getRegime(settings).wireCode ? 'wire' : 'over threshold')}</span>
                              <button className="bell-act" title="Open the filing worksheet" onClick={(e) => { e.stopPropagation(); setBellMenu(false); openComplianceFiling(it.obligation); }}>File {it.kind || window.CDOS.getRegime(settings).largeCode} →</button>
                            </div>
                          ))}
                          {alertList.rpt.length > 4 && <button className="bell-more" onClick={() => { setBellMenu(false); openApp('compliance'); }}>+{alertList.rpt.length - 4} more reportable{alertList.rpt.length - 4 === 1 ? '' : 's'} →</button>}
                        </div>
                      )}
                      {alertList.str.length > 0 && (
                        <div className="bell-sec">
                          <div className="bell-cap"><span className="bell-dot sig-mid"></span>Structuring watch<i>{alertList.str.length}</i></div>
                          {alertList.str.slice(0, 3).map(it => (
                            <div key={it.customer} className="bell-row tall" onClick={() => { setBellMenu(false); openApp('compliance'); }}>
                              <div className="bell-row-main">
                                <span className="bell-row-name">{it.customer}</span>
                                <span className="bell-row-sub">{it.count} just-under deal{it.count === 1 ? '' : 's'} · {fmt(it.agg, 'CAD')} over {settings.structuringDays}d</span>
                              </div>
                              <button className="bell-act ghost lg" title="Mark this watch reviewed — the menu stays open so you can clear several in a row" onClick={(e) => { e.stopPropagation(); ackStructuringFor(it.customer); }}>Acknowledge</button>
                            </div>
                          ))}
                          {alertList.str.length > 3 && <button className="bell-more" onClick={() => { setBellMenu(false); openApp('compliance'); }}>+{alertList.str.length - 3} more →</button>}
                        </div>
                      )}
                      {alertList.kyc.length > 0 && (
                        <div className="bell-sec">
                          <div className="bell-cap"><span className="bell-dot sig-lo"></span>KYC / ID gaps<i>{alertList.kyc.length}</i></div>
                          {alertList.kyc.slice(0, 3).map(it => (
                            <div key={it.customer} className="bell-row" onClick={() => { setBellMenu(false); openApp('compliance'); }}>
                              <span className="bell-row-name">{it.customer}</span>
                              <span className="bell-row-tag">{it.reason}</span>
                              <button className="bell-act ghost" title="Open this client to fix the ID" onClick={(e) => { e.stopPropagation(); setBellMenu(false); openClientProfile(it.customer); }}>Open client →</button>
                            </div>
                          ))}
                          {alertList.kyc.length > 3 && <button className="bell-more" onClick={() => { setBellMenu(false); openApp('compliance'); }}>+{alertList.kyc.length - 3} more →</button>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <button className={'mb-op' + (day.closed ? ' mb-op-off' : '')} title={day.closed ? 'Day is closed — reopen to post' : 'New transaction'} onClick={quickNewDeal}><Ic n="plus" s={17} /></button>
            <button className="mb-op" title="Calculator" onClick={() => openApp('calc')}><Ic n="calcmono" s={17} /></button>
            <button className={'mb-op' + (locked ? ' on' : '')} title={locked ? 'Unlock rates — follow the live board' : 'Lock rates — hold at last pull'} onClick={toggleLock}><Ic n="lock" s={17} /></button>
            <button className="mb-op" title="Settings" onClick={() => openApp('settings')}><Ic n="gear" s={17} /></button>
            <span className="mb-op-div"></span>
            <span className="mb-clock"><Ic n="clock" s={12} /> <b>{clock.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })}</b></span>
            <span className="mb-op-div"></span>
            <div className="mb-acct-wrap" ref={acctRef}>
              <button className={'mb-acct' + (acctMenu ? ' on' : '')} aria-expanded={acctMenu} title="Account & profile" onClick={() => setAcctMenu(o => !o)}>
                <span className="mb-acct-av">{inits(me.name)}</span>
                <span className="mb-acct-id"><b>{me.name}</b><i>{me.role}</i></span>
                <Ic n="chev" s={13} />
              </button>
              {acctMenu && (
                <div className="mb-menu acct-menu mb-menu-solid" role="menu">
                  <div className="mb-menu-head">
                    <span className="mb-menu-av">{inits(me.name)}</span>
                    <span className="mb-menu-id"><b>{me.name}</b><span>{me.role} · {stationName}{stationTill ? ' · ' + stationTill.replace(/\s+—.*/, '') : ''}</span></span>
                  </div>
                  <button className="mb-menu-row" onClick={() => { openSettingsTab('account'); setAcctMenu(false); }}><Ic n="id" s={16} /> <span className="mb-menu-lbl">View profile</span></button>
                  {canSettings && <button className="mb-menu-row" onClick={() => { openApp('settings'); setAcctMenu(false); }}><Ic n="gear" s={16} /> <span className="mb-menu-lbl">Account settings</span></button>}
                  <div className="mb-menu-div"></div>
                  <div className="mb-menu-cap">Switch account</div>
                  {(settings.employees && settings.employees.length ? settings.employees : STAFF).filter(s => s.active !== false).map(s => (
                    <button key={s.name} className={'mb-menu-row' + (s.name === me.name ? ' active' : '')} onClick={() => switchTo(s)}>
                      <span className="mb-menu-dot">{inits(s.name)}</span>
                      <span className="mb-menu-lbl">{s.name} <i>· {s.role}</i></span>
                      {s.name === me.name && <Ic n="chev" s={13} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mb-power-wrap" ref={opMenuRef}>
              <button className={'mb-op mb-op-power' + (opMenu ? ' on' : '')} aria-expanded={opMenu} title="Session menu" onClick={() => setOpMenu(o => !o)}><Ic n="power" s={16} /></button>
              {opMenu && (
                <div className="mb-menu mb-menu-solid" role="menu">
                  {canSettings && <button className="mb-menu-row" onClick={() => { openApp('settings'); setOpMenu(false); }}><Ic n="gear" s={16} /> <span className="mb-menu-lbl">Settings</span> <span className="mb-menu-k">⌘,</span></button>}
                  {can('canCloseDay') && <button className="mb-menu-row" onClick={() => { openApp('till'); setOpMenu(false); }}><Ic n="coins" s={16} /> <span className="mb-menu-lbl">Close out the day</span></button>}
                  <button className="mb-menu-row" onClick={() => { openApp('audit'); setOpMenu(false); }}><Ic n="shield" s={16} /> <span className="mb-menu-lbl">Audit trail</span></button>
                  <button className="mb-menu-row" onClick={() => { toggleLock(); setOpMenu(false); }}><Ic n="lock" s={16} /> <span className="mb-menu-lbl">{locked ? 'Unlock rates' : 'Lock rates'}</span></button>
                  <div className="mb-menu-div"></div>
                  <button className="mb-menu-row danger" onClick={() => { setOpMenu(false); logout(); }}><Ic n="logout" s={16} /> <span className="mb-menu-lbl">Sign out</span></button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* TENANT BAR — the exchange house using the software */}
      <div id="tenantbar" className={chromeCollapsed ? 'collapsed' : ''}>
        <div className="tenant-brand">
          <div className="tenant-logo" title="Business logo — set in Settings → Business profile">
            {settings.logo ? <img src={settings.logo} alt="logo" style={{ maxWidth: 40, maxHeight: 26, objectFit: 'contain' }} /> : <><Ic n="building" s={17} c={CD.faint} /><span className="tenant-logo-hint">Your logo</span></>}
          </div>
          <div className="tenant-meta">
            <span className="tenant-name">{settings.operatingName || settings.bizName || 'Exchange house'}</span>
            <StationSwitcher branches={branches} station={station} setStation={setStation} log={log} me={me} gate={tillGate} lockTill={(ROLE_SCOPE[me.role] || 'till') === 'till' && me.role !== 'Owner'} />
          </div>
        </div>
        <div className="tenant-right">
          <Ticker locked={locked} cfg={tickerCfg} book={lockedBook} />
        </div>
      </div>

      {/* APP SUB-BAR */}
      <div id="appbar" ref={appbarRef} className={(editApps ? 'editing' : '') + (chromeCollapsed ? ' collapsed' : '')}>
        {visibleApps.map(id => {
          const w = wins.find(x => x.id === id);
          const removing = removingApps.includes(id);
          const alertN = alerts.str + alerts.id + alerts.rpt + jViol.length;
          const cls = 'app-btn' + (w ? ' open' : '') + (w && w.min ? ' min' : '')
            + (editApps && !removing ? ' jiggle' : '') + (removing ? ' removing' : '') + (dragApp === id ? ' dragging' : '') + (activeBase === id ? ' is-active' : '');
          return (<div key={id} data-app={id} className={cls}
            style={{ '--c': APP_ACCENT[id] || CD.ink, ...(editApps ? { animationDelay: (APP_ORDER.indexOf(id) % 5) * -0.11 + 's' } : {}) }}
            onClick={() => { if (!editApps) openApp(id); }}>
            {editApps && <button className="app-badge remove" title="Remove from dock — moves to the Store" onClick={(e) => { e.stopPropagation(); animateRemove(id); }}><Ic n="minus" s={13} c="var(--cd-on-ink)" /></button>}
            <span className="ai"><Ic n={APPMETA[id].icon} s={22} c={APP_ACCENT[id] || CD.ink} />{id === 'ledger' && alertN > 0 ? <span className="dock-badge" title={`${alertN} flagged — click to view`} onClick={(e) => { if (!editApps) { e.stopPropagation(); jumpAlerts(); } }}>{alertN}</span> : null}</span>
            <span className="al">{APPMETA[id].title}</span>
            {editApps && <span className="app-grip" title="Drag to reorder" onPointerDown={(e) => startAppDrag(e, id)}><Ic n="grip" s={16} c={CD.mute} /></span>}
          </div>);
        })}
        <div className="appbar-spacer"></div>
      </div>

      {/* RIGHT EDGE — store + ID on the app row */}
      <div className={'edge-rail' + (chromeCollapsed ? ' collapsed' : '')}>
        <div className="rail-cell rail-menu"></div>
        <div className="rail-cell rail-tenant"></div>
        <div className="rail-cell rail-app">
          <div className="rail-trio">
            <button className={'mb-op rail-store' + ((editApps || wins.some(w => w.id === 'store')) ? ' on' : '')} title={(editApps || wins.some(w => w.id === 'store')) ? 'Done — close store & finish editing' : 'App Store — add, remove & upgrade apps'} onClick={toggleStore}><Ic n={(editApps || wins.some(w => w.id === 'store')) ? 'check' : 'storefront'} s={17} /></button>
            <button className="mb-op" title="Add a verified contact" onClick={() => setAddContactOpen(true)}><Ic n="id" s={17} /></button>
          </div>
        </div>
      </div>

      {/* DESKTOP */}
      <div id="desktop">
        <div className="desk-watermark"><div className="big">CD·OS</div>the operating system for exchange houses</div>
        {wins.map(w => w.min ? null : (
          <Win key={w.id} win={w} meta={metaFor(w)} active={w.id === activeId} nav={winNav[w.id]}
            onFocus={focusWin} onClose={closeWin} onMin={minWin} onZoom={zoomWin} onDrag={moveWin} onResize={sizeWin} onSnap={snapWin} onAdd={duplicateWin}>
            {renderApp(w.id)}
          </Win>
        ))}
      </div>

      {receipt && <ReceiptModal row={receipt} settings={settings} onClose={() => setReceipt(null)} />}
      {pinGate && window.CDOS.PinPrompt && <window.CDOS.PinPrompt {...pinGate} onOk={() => { const f = pinGate.onOk; setPinGate(null); f && f(); }} onCancel={() => setPinGate(null)} />}
      {moveCash && _ST.MoveModal && React.createElement(_ST.MoveModal, { branches, station, preset: moveCash, onClose: () => setMoveCash(null), onMove: doOsMove })}
      {addContactOpen && window.CDOS.KYC && window.CDOS.KYC.NewContactFlow &&
        <window.CDOS.KYC.NewContactFlow by={me.name} setClients={setClients} onClose={() => setAddContactOpen(false)} onDone={() => setAddContactOpen(false)} />}
    </div>);
  }

  window.CDOS_App = App;
})();
