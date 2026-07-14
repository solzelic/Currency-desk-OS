/* ============================================================
   CurrencyDesk OS — Settings
   The full configuration surface for an exchange house: business
   identity, localization, compliance thresholds, rate/fee defaults,
   receipt content, staff permissions and the ticker tape. Everything
   reads/writes the shared `settings` object (persisted by the shell)
   except permissions (perms) and the ticker (tickerCfg).
   ============================================================ */
(function () {
  const { useState, useEffect } = React;
  const { CD, Ic, fmt, CCY, crossRate, spreadOf, buyUnitCad, sellUnitCad, STAFF, ROLE_CAPS } = window.CDOS;
  const CURX = (typeof CUR !== 'undefined' ? CUR : []).map(c => c.code);
  const BASE_OPTS = ['CAD', 'USD', 'EUR', 'GBP', 'AUD'].filter(c => CURX.includes(c) || ['CAD', 'USD', 'EUR', 'GBP', 'AUD'].includes(c));
  const COUNTRIES = ['Canada', 'United States', 'European Union', 'United Kingdom', 'Australia', 'Other'];
  // country → sub-jurisdiction (state / province / member state) when one applies
  const JURIS_REGIONS = {
    'Canada': { label: 'Province / territory', opts: ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Northwest Territories', 'Nova Scotia', 'Nunavut', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Yukon'] },
    'United States': { label: 'State', opts: ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia'] },
    'European Union': { label: 'Member state', opts: ['Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden'] },
  };
  const TIMEZONES = ['America/Toronto', 'America/Vancouver', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney'];
  // apps an employee can be granted access to (id must match the OS dock app ids)
  const APPS = [['rates', 'Rate Board'], ['ledger', 'Ledger'], ['transfers', 'Transfers'], ['cheques', 'Cheques'], ['clients', 'Clients · KYC'], ['compliance', 'Compliance'], ['dashboard', 'Dashboard'], ['till', 'Till & Drawer'], ['vault', 'Vault'], ['branches', 'Branches'], ['tagged', 'Tagged'], ['audit', 'Audit Trail']];
  const DEF_APPS = ['rates', 'ledger', 'clients', 'till'];
  const EMP_ROLES = ['Owner', 'Manager', 'Senior teller', 'Cashier', 'Trainee'];

  const inSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };

  // default cards on the account (until the owner edits them); helpers for card display
  const seedCards = (settings) => (settings.cards) || [
    { id: 'card_visa', num: '4242 4242 4242 4242', exp: '04/27', name: (settings.billingName || 'Jordan Masri'), postal: 'M5V 2T6', role: 'primary' },
    { id: 'card_mc', num: '5555 5555 5555 4444', exp: '09/26', name: 'York FX Holdings Inc.', postal: 'M5V 2T6', role: 'backup' },
  ];
  const cardBrand = (num) => { const r = String(num || '').replace(/\D/g, ''); return r[0] === '4' ? 'VISA' : r[0] === '5' ? 'MASTERCARD' : r[0] === '3' ? 'AMEX' : r[0] === '6' ? 'DISCOVER' : 'CARD'; };
  const cardLast4 = (num) => String(num || '').replace(/\D/g, '').slice(-4);
  const CARD_GRAD = { VISA: 'linear-gradient(135deg,#1a3a6b 0%,#264f8f 60%,#3a6fb0 100%)', MASTERCARD: 'linear-gradient(135deg,#3a2a1a 0%,#5c4326 55%,#8a5a1f 100%)', AMEX: 'linear-gradient(135deg,#16505a 0%,#1f7a86 100%)', DISCOVER: 'linear-gradient(135deg,#5a3a16 0%,var(--cd-amber) 100%)', CARD: 'linear-gradient(135deg,#34302a 0%,#4a4034 60%,#5c4a2e 100%)' };

  // ---- identity verification cadence — a compact, always-live picture of the
  // recheck / reverify line the VerificationNudge engine runs on (cdos-kyc.jsx).
  // Built from flex + dashed rules so it can never fall out of sync with the
  // numbers below it — not a static diagram. #2B50E2 is the one sanctioned literal
  // (BRAND.md) for the KYC recommendation accent.
  const KYC_BLUE = '#2B50E2';
  function CadenceLadder({ recheckDays, reverifyDays, escalate }) {
    const Stop = ({ tone, bg, icon, label }) => (
      <div className="flex flex-col items-center gap-1.5 flex-none" style={{ width: 104 }}>
        <span className="grid place-items-center" style={{ width: 32, height: 32, borderRadius: '50%', background: bg }}><Ic n={icon} s={15} c={tone} /></span>
        <span className="text-[10.5px] font-semibold text-center leading-tight" style={{ color: tone }}>{label}</span>
      </div>
    );
    const Link = ({ label }) => (
      <div className="flex-1 flex flex-col items-center gap-1" style={{ minWidth: 36, paddingBottom: 17 }}>
        <span className="text-[9px] font-semibold px-1.5 whitespace-nowrap" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</span>
        <span style={{ width: '100%', borderTop: `1.5px dashed ${CD.line}` }} />
      </div>
    );
    return (
      <div>
        <div className="flex items-start px-1">
          <Stop tone={CD.green} bg={CD.greenSoft} icon="checkcircle" label="Verified" />
          <Link label={`${recheckDays}d \u2192`} />
          <Stop tone={KYC_BLUE} bg="rgba(43,80,226,.12)" icon="search" label="Quick check suggested" />
          <Link label={`${reverifyDays}d total \u2192`} />
          <Stop tone={CD.flag} bg={CD.flagSoft} icon="alert" label="Re-verify required" />
        </div>
        <div className="flex items-center gap-1.5 mt-1 px-1 text-[10.5px]" style={{ color: escalate ? KYC_BLUE : CD.faint }}>
          <Ic n="shield" s={11} c={escalate ? KYC_BLUE : CD.faint} />
          {escalate ? 'High-risk clients skip straight to Verified Plus at any point on this line.' : 'High-risk escalation is off \u2014 high-risk clients follow this same line.'}
        </div>
      </div>
    );
  }

  // 4-digit transaction PIN. Changing it verifies the current PIN first, then
  // takes the new PIN twice — the standard change-PIN flow.
  function PinSetter({ hasPin, current, onSave }) {
    const [open, setOpen] = useState(false);
    const [cur, setCur] = useState('');
    const [a, setA] = useState('');
    const [b, setB] = useState('');
    const [err, setErr] = useState('');
    const [done, setDone] = useState(false);
    const clean = (v) => (v || '').replace(/\D/g, '').slice(0, 4);
    const close = () => { setOpen(false); setCur(''); setA(''); setB(''); setErr(''); };
    const save = () => {
      if (hasPin && cur !== String(current == null ? '0000' : current)) { setErr('Your current PIN isn’t right.'); return; }
      if (a.length !== 4) { setErr('New PIN must be 4 digits.'); return; }
      if (a !== b) { setErr('The two new PINs don’t match.'); return; }
      onSave(a); setOpen(false); setCur(''); setA(''); setB(''); setErr('');
      setDone(true); setTimeout(() => setDone(false), 1800);
    };
    const fld = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8, width: 128, letterSpacing: '0.4em', textAlign: 'center', fontFamily: 'Space Mono, monospace', fontSize: 15, padding: '8px 10px', outline: 'none' };
    if (!open) return (
      <div className="flex items-center gap-2">
        <span className="text-[12px] flex items-center gap-1.5" style={{ color: done ? CD.green : (hasPin ? CD.green : CD.mute) }}><Ic n={(done || hasPin) ? 'checkcircle' : 'lock'} s={13} c={done ? CD.green : (hasPin ? CD.green : CD.faint)} />{done ? 'PIN updated' : (hasPin ? 'PIN set' : 'No PIN yet')}</span>
        <button onClick={() => { setDone(false); setOpen(true); }} className="text-[12px] px-2.5 py-1.5 font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>{hasPin ? 'Change PIN' : 'Set PIN'}</button>
      </div>
    );
    return (
      <div className="p-3.5" style={{ border: `1px solid ${CD.ink}`, borderRadius: 12, background: 'var(--cd-panel)', width: 300 }}>
        <div className="text-[10px] uppercase tracking-widest mb-2.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{hasPin ? 'Change your PIN' : 'Set your PIN'}</div>
        <div className="flex flex-col gap-2">
          {hasPin && <label className="flex items-center justify-between gap-3"><span className="text-[12px]" style={{ color: CD.mute }}>Current PIN</span><input value={cur} onChange={e => { setCur(clean(e.target.value)); setErr(''); }} onKeyDown={e => e.key === 'Enter' && save()} inputMode="numeric" type="password" placeholder="••••" autoFocus style={fld} /></label>}
          <label className="flex items-center justify-between gap-3"><span className="text-[12px]" style={{ color: CD.mute }}>New PIN</span><input value={a} onChange={e => { setA(clean(e.target.value)); setErr(''); }} onKeyDown={e => e.key === 'Enter' && save()} inputMode="numeric" type="password" placeholder="••••" autoFocus={!hasPin} style={fld} /></label>
          <label className="flex items-center justify-between gap-3"><span className="text-[12px]" style={{ color: CD.mute }}>Confirm new PIN</span><input value={b} onChange={e => { setB(clean(e.target.value)); setErr(''); }} onKeyDown={e => e.key === 'Enter' && save()} inputMode="numeric" type="password" placeholder="••••" style={fld} /></label>
        </div>
        {err && <div className="text-[11px] mt-2 flex items-center gap-1.5" style={{ color: CD.flag }}><Ic n="alert" s={12} c={CD.flag} /> {err}</div>}
        <div className="flex items-center justify-end gap-2 mt-3">
          <button onClick={close} className="text-[12px] px-3 py-2" style={{ color: CD.mute }}>Cancel</button>
          <button onClick={save} className="text-[12px] px-3.5 py-2 font-semibold text-white flex items-center gap-1.5" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="check" s={13} c="var(--cd-on-ink)" /> Save PIN</button>
        </div>
      </div>
    );
  }

  function SettingsView({ perms, setPerms, settings, setSettings, me, log, tickerCfg, setTicker, branches, setBranches, branchMoves, setBranchMoves, jump, rows, setRows, clients, setClients, onOpenLedger, askPin, reqPin, pinOf }) {
    const canSys = me.role === 'Owner' || perms.Teller.canSettings;
    const [tab, setTab] = useState(canSys ? 'business' : 'account');
    const [addingLoc, setAddingLoc] = useState(false);   // enterprise Add-location modal (shared with Branch Network's rail)
    const [importing, setImporting] = useState(false);
    const [expOpts, setExpOpts] = useState({ range: 'all', includeVoid: false, cols: 'all' });
    const [exported, setExported] = useState(false);
    // nav search — filters the settings rail by label + per-tab keywords
    const [navQ, setNavQ] = useState('');
    const [empSel, setEmpSel] = useState(null);   // selected employee id — master/detail view
    const [revealPin, setRevealPin] = useState({});   // owner-revealed PINs by employee id
    // ---- server sign-in accounts (per-employee credentials) ----
    const [srvStaff, setSrvStaff] = useState(null);       // staffId → server account
    const [srvState, setSrvState] = useState('loading');  // loading | ok | offline | forbidden
    const [srvPw, setSrvPw] = useState('');               // temp-password draft in the open profile
    const [srvMsg, setSrvMsg] = useState('');
    const [srvBusy, setSrvBusy] = useState(false);
    const [pwForm, setPwForm] = useState(null);           // my own password change {cur,a,b,msg,busy}
    const SRV_ROLE = { 'Owner': 'administrator', 'Manager': 'branch_manager', 'Senior teller': 'supervisor', 'Cashier': 'teller', 'Trainee': 'teller' };
    const srvReload = () => {
      if (typeof fetch !== 'function' || window.location.protocol === 'file:') { setSrvState('offline'); return; }
      fetch('/api/staff', { credentials: 'same-origin' })
        .then(r => { if (r.status === 401 || r.status === 403) { setSrvState('forbidden'); return null; } if (!r.ok) { setSrvState('offline'); return null; } return r.json(); })
        .then(d => { if (!d) return; const m = {}; (d.staff || []).forEach(a => { m[a.staffId] = a; }); setSrvStaff(m); setSrvState('ok'); })
        .catch(() => setSrvState('offline'));
    };
    useEffect(() => { srvReload(); }, []);
    useEffect(() => { setSrvPw(''); setSrvMsg(''); setSrvBusy(false); }, [empSel]);
    const srvCall = async (method, url, body) => {
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && (d.detail || d.error)) || ('HTTP ' + res.status));
      return d;
    };
    // blocking or removing a person locally also shuts their server sign-in
    const srvSetActive = (code, active) => {
      const sid = (code || '').trim(); if (!sid || !srvStaff || !srvStaff[sid]) return;
      srvCall('PATCH', '/api/staff/' + encodeURIComponent(sid), { active }).then(srvReload).catch(() => {});
    };
    const [planMsg, setPlanMsg] = useState('');
    // the purchased tier lives on the TENANT — switching plans writes to the
    // server (administrator only) so every device and sign-in agrees
    const pickPlan = (id) => {
      const prev = settings.billingPlan || 'premium';
      if (prev === id) return;
      set('billingPlan', id, `plan ${id}`);
      setPlanMsg('');
      if (typeof fetch !== 'function' || window.location.protocol === 'file:') return;
      fetch('/api/tenant', { method: 'PATCH', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ plan: id }) })
        .then(r => {
          if (r.ok) return;
          set('billingPlan', prev, 'plan change reverted');
          setPlanMsg(r.status === 401 || r.status === 403
            ? 'Only the owner account can change the plan \u2014 ask them to switch it.'
            : 'The plan change didn\u2019t reach the server (' + r.status + ') \u2014 try again.');
        })
        .catch(() => { /* no backend \u2014 offline demo keeps the local switch */ });
    };
    // ---- hosted public site (server-side tenant: slug + custom domain) ----
    const [siteInfo, setSiteInfo] = useState(null);    // { siteSlug, siteDomain } | null = unavailable
    const [siteDraft, setSiteDraft] = useState('');
    const [siteMsg, setSiteMsg] = useState('');
    const [siteBusy, setSiteBusy] = useState(false);
    useEffect(() => {
      if (typeof fetch !== 'function' || window.location.protocol === 'file:') return;
      fetch('/api/tenant', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && d.tenant) { setSiteInfo(d.tenant); setSiteDraft(d.tenant.siteDomain || ''); } })
        .catch(() => {});
    }, []);
    const saveSiteDomain = () => {
      const domain = siteDraft.trim().toLowerCase() || null;
      setSiteBusy(true); setSiteMsg('');
      fetch('/api/tenant', { method: 'PATCH', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ siteDomain: domain }) })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (r.ok) { setSiteInfo(d.tenant); setSiteDraft(d.tenant.siteDomain || ''); setSiteMsg(d.tenant.siteDomain ? 'Saved — point your DNS and the site answers on it.' : 'Domain disconnected.'); log('Public site', d.tenant.siteDomain ? 'domain ' + d.tenant.siteDomain : 'domain disconnected'); }
          else if (r.status === 401 || r.status === 403) setSiteMsg('Only the owner account can change the site domain.');
          else setSiteMsg((d && d.detail) || 'Couldn\u2019t save (' + r.status + ').');
        })
        .catch(() => setSiteMsg('Server unreachable \u2014 try again on the live desk.'))
        .then(() => setSiteBusy(false));
    };
    const changeMyPassword = async () => {
      if (!pwForm) return;
      if (pwForm.a.length < 8) { setPwForm(f => ({ ...f, msg: 'New password needs at least 8 characters.' })); return; }
      if (pwForm.a !== pwForm.b) { setPwForm(f => ({ ...f, msg: 'The two new entries don\u2019t match.' })); return; }
      setPwForm(f => ({ ...f, busy: true, msg: 'Saving\u2026' }));
      try {
        const res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ currentPassword: pwForm.cur, newPassword: pwForm.a }) });
        if (res.status === 401) { setPwForm(f => ({ ...f, busy: false, msg: 'Current password is wrong.' })); return; }
        if (!res.ok) { setPwForm(f => ({ ...f, busy: false, msg: 'Couldn\u2019t save (' + res.status + ') \u2014 try again.' })); return; }
      } catch (e2) { setPwForm(f => ({ ...f, busy: false, msg: 'Server unreachable \u2014 password changes need the live desk.' })); return; }
      log('Password changed', 'sign-in password');
      setPwForm({ cur: '', a: '', b: '', msg: 'Password changed.', busy: false });
      setTimeout(() => setPwForm(null), 1600);
    };
    const NAV_KEYWORDS = { business: 'logo msb fintrac reporting entity reset demo name address', locations: 'branch till teller station', localization: 'currency timezone date time format region', compliance: 'kyc verification threshold lctr aggregation structuring sanctions retention nudge quick check reverify escalate jurisdiction fintrac fincen partner code', billing: 'plan subscription invoice provider kyc partner code seats', payment: 'card visa mastercard billing email', ledger: 'import csv excel duplicate', till: 'cash drawer count denomination variance tolerance reconcile blind handoff close day float', transfers: 'remittance corridor beneficiary eft eftr threshold cross-border reporting settlement purpose', cheques: 'cheque check clearing hold fee schedule nsf risk minimum days', clients: 'kyc risk id expiry email phone contact', rates: 'spread margin fee floor rounding rate lock provider commission', vault: 'cash floor reserve stock low valuation cost', receipts: 'print header footer disclaimer logo', tagged: 'auto tag follow-up review', ticker: 'tape scroll speed flags', employees: 'staff team seats accounts apps roles', permissions: 'roles presets teller handoff drawer count' };
    const navMatch = (id, label) => { const q = navQ.trim().toLowerCase(); if (!q) return true; return (label + ' ' + (NAV_KEYWORDS[id] || '')).toLowerCase().includes(q); };
    // №02: the explicit, deliberate demo wipe — replaces "refresh" as the reset.
    const [resetArm, setResetArm] = useState(false);
    const resetDemo = () => {
      try {
        Object.keys(localStorage).forEach(k => { if (k.indexOf('cdos_') === 0 && k !== 'cdos_theme') localStorage.removeItem(k); });
        localStorage.removeItem('yorkfx_rates_locked');
      } catch (e) {}
      location.reload();
    };
    // appearance (light / dark / auto) — persisted per device by the theme controller
    const [appearance, setAppearance] = useState(() => (window.CDOS.theme ? window.CDOS.theme.get() : 'light'));
    const pickAppearance = (v) => { if (window.CDOS.theme) window.CDOS.theme.set(v); setAppearance(v); log('Appearance changed', v === 'auto' ? 'auto (follow system)' : v + ' mode'); };
    const [addingCard, setAddingCard] = useState(false);
    const [cardDraft, setCardDraft] = useState({ num: '', exp: '', cvc: '', name: '', postal: '' });
    const [icfg, setIcfg] = useState(() => (window.CDOS.importCfg ? window.CDOS.importCfg.load() : {}));
    const setIc = (patch, note) => { const next = window.CDOS.importCfg ? window.CDOS.importCfg.save(patch) : Object.assign({}, icfg, patch); setIcfg(next); if (note) log('Import setting changed', note); };
    useEffect(() => { if (jump && jump.t) setTab(jump.t); }, [jump && jump.n]);
    // jurisdiction follows Localization: when the operating country resolves to exactly
    // one regulator pack, apply it automatically so the picker, threshold and codes agree.
    useEffect(() => {
      const REG = ((window.CDOS._compliance || {}).REGIMES) || {};
      const mc = settings.bizCountry || 'Canada';
      const match = Object.values(REG).filter(r => r.country === mc);
      if (match.length === 1 && settings.regime !== match[0].id) {
        const r = match[0];
        setSettings(s => ({ ...s, regime: r.id, threshold: r.threshold, baseCurrency: r.currency, idRequiredOver: r.idAt, aggHours: r.aggHours }));
      }
    }, [settings.bizCountry]);
    // ---- ledger export (moved out of the Ledger toolbar; full-book download with options) ----
    const cadOfX = (a, c) => c === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', c) || 1);
    const expList = (() => { const list = rows || []; const today = new Date().toISOString().slice(0, 10); const ym = today.slice(0, 7), yy = today.slice(0, 4); let l = expOpts.range === 'month' ? list.filter(r => String(r.date || '').slice(0, 7) === ym) : expOpts.range === 'year' ? list.filter(r => String(r.date || '').slice(0, 4) === yy) : list.slice(); if (!expOpts.includeVoid) l = l.filter(r => r.status !== 'void'); return l; })();
    const exportLedger = () => {
      const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const full = expOpts.cols === 'all';
      const head = full ? ['Ref', 'Date', 'Time', 'Customer', 'Type', 'InCcy', 'InAmt', 'Rate', 'OutCcy', 'OutAmt', 'Fee', 'CAD value', 'Teller', 'Status', 'Filed', 'Notes'] : ['Ref', 'Date', 'Customer', 'Type', 'Pay-in', 'Pay-out', 'Fee', 'CAD value'];
      const lines = expList.map(x => { const cad = cadOfX(x.inAmt, x.inCcy).toFixed(2); return (full
        ? [x.ref, x.date, x.time, x.customer, x.type, x.inCcy, x.inAmt, x.rate, x.outCcy, x.outAmt, x.fee, cad, x.teller, x.status, x.filed ? (x.filedInfo && x.filedInfo.ref || 'yes') : '', x.notes]
        : [x.ref, x.date, x.customer, x.type, (x.inAmt + ' ' + x.inCcy), (x.outAmt + ' ' + x.outCcy), x.fee, cad]).map(esc).join(','); });
      const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ledger-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
      log && log('Ledger exported', expList.length + ' rows · ' + expOpts.range + (expOpts.includeVoid ? ' · incl. voided' : ''));
      setExported(true); setTimeout(() => setExported(false), 1800);
    };
    // exporting the whole book is a sensitive action — gate it behind the operator's PIN
    const exportLedgerGated = () => {
      const need = askPin && (!reqPin || reqPin(me.name));
      if (need) askPin({ title: 'Confirm export', sub: 'Enter your PIN to download the ledger', name: me.name, expected: pinOf ? pinOf(me.name) : '0000', onOk: exportLedger });
      else exportLedger();
    };
    const inits = (n) => (n || '?').split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    // a staff member can ALWAYS manage their own profile; system + app settings need canSettings
    const myProf = (settings.staff && settings.staff[me.name]) || {};
    const setProf = (k, v) => setSettings(s => ({ ...s, staff: { ...(s.staff || {}), [me.name]: { ...((s.staff || {})[me.name] || {}), [k]: v } } }));
    // the signed-in user's own account record — holds their transaction PIN
    const myEmp = (settings.employees || []).find(e => e.name === me.name) || null;
    const setMyPin = (pin) => { setSettings(s => ({ ...s, employees: (s.employees || []).map(e => e.name === me.name ? { ...e, pin } : e) })); log('Transaction PIN', pin ? 'PIN set' : 'PIN cleared'); };

    const set = (k, v, note) => { setSettings(s => ({ ...s, [k]: v })); if (note) log('Setting changed', note); };
    const toggleSet = (k, label) => { setSettings(s => ({ ...s, [k]: !s[k] })); log('Setting changed', `${label} · ${!settings[k] ? 'on' : 'off'}`); };
    const togglePerm = (k) => { setPerms(p => ({ ...p, Teller: { ...p.Teller, [k]: !p.Teller[k] } })); log('Permission changed', `Teller · ${k}`); };
    const base = settings.baseCurrency || 'CAD';
    const uploadLogo = (file) => { const r = new FileReader(); r.onload = () => set('logo', r.result, 'business logo'); r.readAsDataURL(file); };
    // ---- locations / tills / people setup (single source: branches) ----
    const setBranchF = (id, patch) => setBranches && setBranches(list => list.map(b => b.id === id ? { ...b, ...patch } : b));
    const removeBranchF = (id) => setBranches && setBranches(list => list.length > 1 ? list.filter(b => b.id !== id) : list);
    const addBranchF = () => setBranches && setBranches(list => [...list, { id: 'b' + Date.now(), name: 'New location', code: 'LOC-' + ((list ? list.length : 0) + 1), city: '', status: 'open', dealsToday: 0, volToday: 0, tills: [{ id: 't' + Date.now(), name: 'Till 1', teller: '', status: 'open', cash: { CAD: 0 } }] }]);
    const setTillF = (bId, tId, patch) => setBranches && setBranches(list => list.map(b => b.id === bId ? { ...b, tills: (b.tills || []).map(t => t.id === tId ? { ...t, ...patch } : t) } : b));
    const removeTillF = (bId, tId) => setBranches && setBranches(list => list.map(b => b.id === bId ? { ...b, tills: (b.tills || []).length > 1 ? b.tills.filter(t => t.id !== tId) : b.tills } : b));
    const addTillF = (bId) => setBranches && setBranches(list => list.map(b => { if (b.id !== bId) return b; const n = (b.tills || []).length + 1; return { ...b, tills: [...(b.tills || []), { id: 't' + Date.now(), name: 'Till ' + n, teller: '', status: 'open', cash: { CAD: 0 } }] }; }));

    /* ---------- shared controls ---------- */
    const Sw = ({ on, click }) => (<button type="button" onClick={click} className="w-11 h-6 relative flex-none" style={{ background: on ? CD.ink : 'var(--cd-disabled)', borderRadius: 999, transition: 'background .15s', cursor: 'pointer' }}><span className="absolute top-0.5 w-5 h-5" style={{ left: on ? 22 : 2, background: 'var(--cd-panel)', borderRadius: 999, transition: 'left .15s' }} /></button>);
    const Seg = ({ value, onPick, opts }) => (
      <div className="inline-flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
        {opts.map(([v, label], i) => { const on = value === v; return (<button key={v} type="button" onClick={() => onPick(v)} onMouseEnter={e => { if (!on) e.currentTarget.style.background = CD.lineSoft; }} onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }} className="text-xs px-3 py-1.5" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none', fontFamily: 'Space Mono, monospace', letterSpacing: '0.02em', cursor: 'pointer', transition: 'background .12s' }}>{label}</button>); })}
      </div>
    );
    const Row = ({ title, desc, children }) => (
      <div className="flex items-center justify-between gap-4 py-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
        <div className="min-w-0"><div className="text-sm" style={{ color: CD.ink }}>{title}</div>{desc && <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{desc}</div>}</div>
        <div className="flex-none">{children}</div>
      </div>
    );
    const Txt = ({ k, placeholder, w = 220 }) => <input value={settings[k] || ''} onChange={e => set(k, e.target.value)} placeholder={placeholder} className="text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, width: w }} />;
    const Money = ({ k }) => (<div className="flex items-center" style={inSty}><span className="px-2 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{base}</span><input type="number" value={settings[k] ?? ''} onChange={e => set(k, +e.target.value)} className="text-sm px-2 py-2 outline-none text-right bg-transparent" style={{ width: 110, fontVariantNumeric: 'tabular-nums', borderLeft: `1px solid ${CD.line}` }} /></div>);
    const Field = ({ label, desc, children }) => (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span></div>{children}{desc && <div className="text-[10.5px] mt-1" style={{ color: CD.faint }}>{desc}</div>}</label>);
    const Inp = ({ k, placeholder, type }) => <input type={type || 'text'} value={settings[k] || ''} onChange={e => set(k, e.target.value)} placeholder={placeholder} className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} />;
    const SectionTitle = ({ icon, title, sub }) => (
      <div className="flex items-start gap-3 mb-5 pb-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
        {icon && <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 11 }}><Ic n={icon} s={18} c="var(--cd-on-ink)" /></span>}
        <div className="min-w-0"><div className="text-[17px] font-bold leading-tight" style={{ color: CD.ink, letterSpacing: '-0.01em' }}>{title}</div>{sub && <div className="text-[11.5px] mt-1" style={{ color: CD.mute, maxWidth: 520 }}>{sub}</div>}</div>
      </div>);

    const CAPS = [['canDelete', 'Void transactions', 'Reverse a posted record (with a reason).'], ['canExport', 'Export & generate reports', 'CSV export and printable reports.'], ['canViewReports', 'View Dashboard, Reports & Vault', 'Access aggregated figures.'], ['canCloseDay', 'Close out the day', 'Reconcile the drawers and lock / open the trading day.'], ['canEditKYC', 'Edit clients & KYC', 'Create contacts and edit ID details.'], ['canSettings', 'Open Settings', 'Change this configuration.']];
    const FXC = (typeof CUR !== 'undefined' ? CUR : []).filter(c => c.code !== 'CAD');
    const hidden = tickerCfg.hidden || [];
    const setT = (patch, note) => { setTicker(t => ({ ...t, ...patch })); if (note) log('Ticker updated', note); };
    const toggleCcy = (code) => setT({ hidden: hidden.includes(code) ? hidden.filter(c => c !== code) : [...hidden, code] }, code);

    const NAV_GROUPS = canSys ? [
      ['Business', [
        ['business', 'Business profile', 'building'],
        ['locations', 'Locations & tills', 'wallet'],
        ['employees', 'Employees', 'users'],
        ['localization', 'Localization', 'globe'],
        ['compliance', 'Compliance & jurisdiction', 'shield'],
        ['billing', 'Billing & plan', 'coins'],
        ['payment', 'Payment methods', 'card'],
      ]],
      ['App settings', [
        ['ledger', 'Ledger', 'scroll'],
        ['clients', 'Clients · KYC', 'users'],
        ['till', 'Cash drawer', 'wallet'],
        ['vault', 'Cash on hand · Vault', 'building'],
        ['transfers', 'Transfers', 'globe'],
        ['cheques', 'Cheques', 'receipt'],
        ['rates', 'Rates & fees', 'percent'],
        ['receipts', 'Receipts', 'receipt'],
        ['tagged', 'Tagged', 'bookmark'],
        ['ticker', 'Ticker tape', 'bars'],
      ]],
      ['Access', [
        ['permissions', 'Role presets', 'id'],
      ]],
    ] : [];

    return (<div className="flex" style={{ height: '100%' }}>
      {/* nav rail */}
      <div className="flex-none p-3 overflow-auto" style={{ width: 212, borderRight: `1px solid ${CD.line}`, background: 'var(--cd-paper-soft)' }}>
        <button onClick={() => setTab('account')} className="w-full flex items-center gap-2.5 p-2 mb-3" style={{ borderRadius: 11, background: tab === 'account' ? CD.ink : CD.panel, border: `1px solid ${tab === 'account' ? CD.ink : CD.line}`, textAlign: 'left' }}>
          <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: tab === 'account' ? 'var(--cd-panel)' : CD.ink, color: tab === 'account' ? CD.ink : 'var(--cd-on-ink)', fontSize: 12, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{inits(me.name)}</span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold truncate" style={{ color: tab === 'account' ? 'var(--cd-on-ink)' : CD.ink }}>{me.name}</span>
            <span className="block text-[10.5px] truncate" style={{ color: tab === 'account' ? 'var(--cd-on-ink-soft)' : CD.faint }}>{me.role} · My account</span>
          </span>
        </button>
        {canSys && <div className="flex items-center gap-2 px-2.5 py-2 mb-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 9 }}>
          <Ic n="search" s={14} c={CD.faint} />
          <input value={navQ} onChange={e => setNavQ(e.target.value)} placeholder="Search settings…" className="outline-none text-[12.5px] bg-transparent w-full" />
          {navQ && <button onClick={() => setNavQ('')} className="grid place-items-center flex-none" style={{ color: CD.faint }}><Ic n="x" s={13} c={CD.faint} /></button>}
        </div>}
        {NAV_GROUPS.map(([group, items]) => {
          const shownItems = items.filter(([id, label]) => navMatch(id, label));
          if (!shownItems.length) return null;
          return (
          <div key={group} className="mb-1.5">
            <div className="text-[9px] uppercase tracking-widest px-2 mb-1 mt-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', opacity: 0.7 }}>{group}</div>
            {shownItems.map(([id, label, icon]) => (
              <button key={id} onClick={() => setTab(id)} className="w-full flex items-center gap-2.5 px-2.5 py-2 mb-0.5 text-left text-sm" style={{ borderRadius: 8, background: tab === id ? CD.ink : 'transparent', color: tab === id ? 'var(--cd-on-ink)' : CD.text }}>
                <Ic n={icon} s={15} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              </button>
            ))}
          </div>
        ); })}
        {canSys && navQ.trim() && !NAV_GROUPS.some(([, items]) => items.some(([id, label]) => navMatch(id, label))) && <div className="text-[11px] px-2 py-3 text-center" style={{ color: CD.faint }}>Nothing matches “{navQ.trim()}”.</div>}
      </div>

      {/* panels */}
      <div className="flex-1 overflow-auto p-5" style={{ maxWidth: 700 }}>

        {tab === 'account' && (<div>
          <SectionTitle icon="id" title="My account" sub="Your personal details and preferences. Every staff member manages their own here — no system access needed." />
          <div className="flex items-center gap-4 mb-5 p-4" style={{ border: `1px solid ${CD.line}`, borderRadius: 14, background: CD.panel }}>
            <span className="grid place-items-center flex-none" style={{ width: 58, height: 58, borderRadius: '50%', background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 19, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{inits(me.name)}</span>
            <div className="min-w-0"><div className="text-lg font-bold" style={{ color: CD.ink }}>{me.name}</div><div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>{me.role} · {settings.operatingName || 'CurrencyDesk'}</div></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name" desc="Your sign-in identity — set by the owner."><input value={me.name} disabled className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, background: CD.lineSoft, color: CD.mute }} /></Field>
            <Field label="Role" desc="Set by the owner."><input value={me.role} disabled className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, background: CD.lineSoft, color: CD.mute }} /></Field>
            <Field label="Work email"><input value={myProf.email || ''} onChange={e => setProf('email', e.target.value)} placeholder="you@business.com" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></Field>
            <Field label="Mobile phone"><input value={myProf.phone || ''} onChange={e => setProf('phone', e.target.value)} placeholder="(416) 555-0000" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></Field>
          </div>
          <div className="mt-5 pt-3" style={{ borderTop: `1px solid ${CD.line}` }}>
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Appearance</div>
            <div className="text-sm" style={{ color: CD.ink }}>Theme</div>
            <div className="text-[11px] mt-0.5 mb-3" style={{ color: CD.mute }}>How CurrencyDesk looks on this workstation. Applies to the whole desk, including the lock screen — receipts and filed reports always print on paper white. Auto follows your system setting.</div>
            <div className="flex gap-2.5">
              {[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']].map(([v, label]) => {
                const on = appearance === v;
                const deskBg = v === 'dark' ? '#131210' : '#e6e4de';
                return (
                  <button key={v} onClick={() => pickAppearance(v)} className="flex-1 p-1.5 text-left" style={{ border: `1.5px solid ${on ? CD.ink : CD.line}`, borderRadius: 12, background: on ? CD.panel : 'transparent', cursor: 'pointer', maxWidth: 150, boxShadow: on ? `0 0 0 3px ${CD.hover}` : 'none', transition: 'border-color .13s, box-shadow .13s' }}>
                    <span className="block overflow-hidden relative" style={{ borderRadius: 7, border: `1px solid ${CD.line}`, height: 54, background: deskBg }}>
                      {v === 'auto' && <span className="absolute inset-0" style={{ background: 'linear-gradient(115deg, #e6e4de 0 50%, #131210 50% 100%)' }}></span>}
                      <span className="absolute" style={{ top: 0, left: 0, right: 0, height: 9, background: v === 'dark' ? 'rgba(32,31,27,0.92)' : 'rgba(255,255,255,0.88)', borderBottom: '1px solid rgba(127,127,127,0.28)' }}></span>
                      <span className="absolute" style={{ left: 9, top: 16, width: 38, height: 28, borderRadius: 3.5, background: v === 'dark' ? '#1e1d1a' : '#ffffff', border: '1px solid rgba(127,127,127,0.32)', boxShadow: '0 3px 8px rgba(0,0,0,0.2)' }}></span>
                      <span className="absolute" style={{ left: 54, top: 23, width: 28, height: 21, borderRadius: 3.5, background: v === 'dark' ? '#262521' : '#f4f3f0', border: '1px solid rgba(127,127,127,0.26)' }}></span>
                    </span>
                    <span className="flex items-center justify-between mt-1.5 px-0.5">
                      <span className="text-[11.5px] font-semibold" style={{ color: CD.ink }}>{label}</span>
                      {on && <Ic n="checkcircle" s={14} c={CD.green} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-5 pt-3" style={{ borderTop: `1px solid ${CD.line}` }}>
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Security</div>
            <div className="flex items-start justify-between gap-4 py-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <div className="min-w-0 flex-none" style={{ maxWidth: 230 }}><div className="text-sm" style={{ color: CD.ink }}>Transaction PIN</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>A 4-digit PIN for quick in-app checks (switching accounts, taking a till, voiding). Separate from your sign-in password. Everyone starts at 0000.</div></div>
              <div className="flex-1 flex justify-end">{myEmp ? <PinSetter hasPin={!!myEmp.pin} current={myEmp.pin} onSave={setMyPin} /> : <span className="text-[11px]" style={{ color: CD.faint }}>Available once your account is set up</span>}</div>
            </div>
            <div className="flex items-start justify-between gap-4 py-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <div className="min-w-0 flex-none" style={{ maxWidth: 230 }}><div className="text-sm" style={{ color: CD.ink }}>Sign-in password</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>What you type at the staff sign-in. Only you know it — changing it signs out your other devices.</div></div>
              <div className="flex-1 flex justify-end">
                {!pwForm ? (
                  <button onClick={() => setPwForm({ cur: '', a: '', b: '', msg: '', busy: false })} className="text-xs px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Change password…</button>
                ) : (
                  <div className="w-full" style={{ maxWidth: 300 }}>
                    <input type="password" autoComplete="current-password" value={pwForm.cur} onChange={ev => setPwForm(f => ({ ...f, cur: ev.target.value }))} placeholder="Current password" className="w-full text-[12px] px-2.5 py-1.5 outline-none mb-1.5" style={inSty} />
                    <input type="password" autoComplete="new-password" value={pwForm.a} onChange={ev => setPwForm(f => ({ ...f, a: ev.target.value }))} placeholder="New password · min 8 chars" className="w-full text-[12px] px-2.5 py-1.5 outline-none mb-1.5" style={inSty} />
                    <input type="password" autoComplete="new-password" value={pwForm.b} onChange={ev => setPwForm(f => ({ ...f, b: ev.target.value }))} placeholder="Repeat new password" className="w-full text-[12px] px-2.5 py-1.5 outline-none mb-1.5" style={inSty} />
                    {pwForm.msg && <div className="text-[11px] mb-1.5" style={{ color: pwForm.msg === 'Password changed.' ? CD.green : CD.flag }}>{pwForm.msg}</div>}
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setPwForm(null)} className="text-xs px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.mute }}>Cancel</button>
                      <button disabled={pwForm.busy} onClick={changeMyPassword} className="text-xs px-2.5 py-1.5 font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 7, opacity: pwForm.busy ? 0.5 : 1 }}>Save</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <Row title="Two-step verification" desc="Require an SMS code when you sign in."><Sw on={myProf.twoFA !== false} click={() => setProf('twoFA', !(myProf.twoFA !== false))} /></Row>
            <Row title="Ask for my PIN before a void" desc="Extra confirmation before reversing a record."><Sw on={!!myProf.pinOnVoid} click={() => setProf('pinOnVoid', !myProf.pinOnVoid)} /></Row>
          </div>
          <div className="mt-5 pt-3" style={{ borderTop: `1px solid ${CD.line}` }}>
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Notifications</div>
            <Row title="Compliance alerts" desc="Flagged deals, screening hits and filings."><Sw on={myProf.notifyCompliance !== false} click={() => setProf('notifyCompliance', !(myProf.notifyCompliance !== false))} /></Row>
            <Row title="Daily summary" desc="End-of-day volume & earnings recap."><Sw on={!!myProf.notifyDaily} click={() => setProf('notifyDaily', !myProf.notifyDaily)} /></Row>
          </div>
          <p className="mt-4 text-[11px]" style={{ color: CD.faint }}>To sign in as a different staff member, use the avatar menu in the top bar.{!canSys && ' System & app settings are managed by an owner.'}</p>
        </div>)}

        {tab === 'billing' && (() => {
          const PLANS = [
            { id: 'basic', name: 'Basic', price: 199, freeMonths: 1, tag: 'Rate board only', feat: ['Live buy/sell Rate Board', 'Published customer storefront', 'Scrolling ticker tape', 'Single location', 'Email support'], excl: ['Ledger, Transfers & Cheques', 'Compliance & KYC', 'AI Assistant'] },
            { id: 'pro', name: 'Pro', price: 499, freeMonths: 2, tag: 'The full platform', feat: ['Everything in Basic', 'Ledger, Transfers, Cheques & bill pay', 'Clients · KYC + Compliance filings', 'Dashboard, Reports & Vault', 'Till, Branch network & multi-location', 'Unlimited staff seats'], excl: ['AI Assistant'] },
            { id: 'premium', name: 'Premium', price: 749, freeMonths: 2, tag: 'Everything, incl. AI', best: true, feat: ['Everything in Pro', 'AI desk Assistant on your live numbers', 'Priority phone & email support', 'Early access to new tools'], excl: [] },
          ];
          const plan = settings.billingPlan || 'premium';
          const cycle = settings.billingCycle || 'monthly';
          const price = (pl) => pl == null ? null : (cycle === 'annual' ? pl.price * (12 - pl.freeMonths) : pl.price);
          const cur = PLANS.find(p => p.id === plan) || PLANS[2];
          const cards = seedCards(settings); const primaryCard = cards.find(c => c.role === 'primary') || cards[0];
          const seats = (window.CDOS.STAFF || []).length;
          const locs = (branches || []).length;
          const tills = (branches || []).reduce((s, b) => s + ((b.tills || []).length), 0);
          const INV = [['INV-2026-06', '2026-06-01'], ['INV-2026-05', '2026-05-01'], ['INV-2026-04', '2026-04-01']];
          const invPDF = (ref, date) => {
            const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
            const biz = settings.operatingName || settings.bizName || 'CurrencyDesk';
            const amt = price(cur) || 0; const tax = +(amt * 0.13).toFixed(2); const total = +(amt + tax).toFixed(2);
            const addr = [settings.bizAddress, [settings.bizCity, settings.bizRegion, settings.bizPostal].filter(Boolean).join(' '), settings.bizCountry].filter(Boolean).join('<br/>');
            const w = window.open('', '_blank', 'width=720,height=900'); if (!w) { log('Invoice blocked', 'Allow pop-ups to download the invoice'); return; }
            w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(ref)}</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;margin:0;padding:48px}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0a0a0a;padding-bottom:18px;margin-bottom:24px}
.h1{font-size:26px;font-weight:800;margin:0}.mut{color:#777;font-size:12px;line-height:1.7}
.mono{font-family:'Space Mono',ui-monospace,monospace}.lbl{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin:8px 0 4px}th,td{text-align:left;padding:10px 8px;font-size:13px}thead th{border-bottom:1px solid #ddd;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#999}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}tbody tr{border-bottom:1px solid #f0f0f0}
.tot{display:flex;justify-content:flex-end;margin-top:10px}.tot table{width:auto;min-width:240px}.tot td{padding:5px 8px}.grand td{border-top:2px solid #0a0a0a;font-weight:800;font-size:15px}
.paid{display:inline-flex;align-items:center;gap:6px;background:#e7f3ec;color:#1f8a5b;font-weight:700;font-size:11px;padding:4px 10px;border-radius:999px;font-family:'Space Mono',monospace}
.ft{margin-top:30px;border-top:1px solid #eee;padding-top:12px;font-size:10.5px;color:#999}@page{margin:14mm}</style></head><body>
<div class="hd"><div><div class="h1">Invoice</div><div class="mut mono">${esc(ref)}</div></div>
<div style="text-align:right"><div style="font-weight:800;font-size:15px">${esc(biz)}</div><div class="mut">${addr || ''}</div></div></div>
<div style="display:flex;justify-content:space-between;margin-bottom:22px">
<div><div class="lbl">Billed to</div><div style="font-size:13px">${esc(settings.billingName || biz)}<br/><span class="mut">${esc(settings.billingEmail || settings.bizEmail || '')}</span></div></div>
<div style="text-align:right"><div class="lbl">Issued</div><div class="mono" style="font-size:13px">${esc(date)}</div><div class="paid" style="margin-top:8px">● PAID</div></div></div>
<table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>
<tr><td>CurrencyDesk OS — ${esc(cur.name)} plan<br/><span class="mut">${cycle === 'annual' ? 'Annual' : 'Monthly'} subscription</span></td><td class="r">1</td><td class="r">${fmt(amt, 'CAD')}</td></tr>
</tbody></table>
<div class="tot"><table><tr><td class="mut">Subtotal</td><td class="r">${fmt(amt, 'CAD')}</td></tr>
<tr><td class="mut">Tax (13%)</td><td class="r">${fmt(tax, 'CAD')}</td></tr>
<tr class="grand"><td>Total</td><td class="r">${fmt(total, 'CAD')}</td></tr></table></div>
<div class="ft">Paid via card on file · ${esc(biz)} · ${esc(settings.msbNumber || '')}<br/>Thank you for your business.</div>
<script>setTimeout(function(){window.focus();window.print();},350)<\/script></body></html>`);
            w.document.close(); log && log('Invoice downloaded', ref);
          };
          return (<div>
            <SectionTitle icon="coins" title="Billing & plan" sub="Your CurrencyDesk OS subscription, usage and payment method." />
            <details style={{ margin: '4px 0 8px' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: CD.mute, listStyle: 'none', userSelect: 'none' }}>Have a partner authorization code?</summary>
            <div className="flex items-center gap-2 mt-2 p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: 'var(--cd-panel)' }}>
              <input defaultValue="" placeholder="e.g. YFX-XXXXXX" onKeyDown={e => { if (e.key === 'Enter') { const r = window.CDOS.KYC.applyPartnerCode(e.target.value); log(r.ok ? 'Partner rate activated' : 'Partner code rejected', r.ok ? (r.pct + '% applied to all checks') : e.target.value); } }} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 180, fontFamily: 'Space Mono, monospace' }} />
              {(() => { const rate = (window.CDOS.KYC && window.CDOS.KYC.getPartnerRate && window.CDOS.KYC.getPartnerRate()) || 0; return rate > 0 ? <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: CD.green }}><Ic n="checkcircle" s={13} c={CD.green} /> {Math.round(rate * 100)}% partner rate active</span> : null; })()}
            </div>
          </details>
          
            <div className="flex items-center justify-between p-4 mb-4" style={{ border: `1.5px solid ${CD.ink}`, borderRadius: 14, background: 'var(--cd-chip)' }}>
              <div><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Current plan</div><div className="text-xl font-bold" style={{ color: CD.ink }}>{cur.name}</div><div className="text-[12px]" style={{ color: CD.mute }}>{cur.tag} · renews {cycle === 'annual' ? 'annually' : 'monthly'}{cycle === 'annual' ? ` · ${cur.freeMonths} month${cur.freeMonths === 1 ? '' : 's'} free` : ''} · next invoice 2026-07-01</div></div>
              <div className="text-right"><div className="text-2xl font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{fmt(price(cur), 'CAD')}</div><div className="text-[11px]" style={{ color: CD.mute }}>per {cycle === 'annual' ? 'year' : 'month'}</div></div>
            </div>
            <Row title="Billing cycle" desc="Pay yearly and skip a couple of months — Pro & Premium get 2 months free, Basic 1."><Seg value={cycle} onPick={v => set('billingCycle', v, `cycle ${v}`)} opts={[['monthly', 'Monthly'], ['annual', 'Annual']]} /></Row>
            <div className="grid grid-cols-3 gap-2.5 my-4">
              {PLANS.map(pl => { const on = plan === pl.id; return (
                <button key={pl.id} onClick={() => pickPlan(pl.id)} className="text-left p-3.5 relative flex flex-col" style={{ border: `1.5px solid ${on ? CD.ink : (pl.best ? CD.brass : CD.line)}`, borderRadius: 13, background: on ? 'var(--cd-chip)' : CD.panel }}>
                  {pl.best && <span className="absolute" style={{ top: -9, right: 12, background: CD.brass, color: 'var(--cd-on-ink)', fontSize: 9, fontWeight: 700, letterSpacing: '.05em', padding: '2px 7px', borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>BEST VALUE</span>}
                  <div className="flex items-center justify-between"><span className="text-[14px] font-bold" style={{ color: CD.ink }}>{pl.name}</span>{on ? <span className="text-[9px] px-1.5 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999 }}><Ic n="check" s={10} c="var(--cd-on-ink)" /> CURRENT</span> : null}</div>
                  <div className="mt-1"><span className="text-xl font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{fmt(price(pl), 'CAD')}</span><span className="text-[11px]" style={{ color: CD.mute }}>/{cycle === 'annual' ? 'yr' : 'mo'}</span></div>
                  <div className="text-[10.5px] mb-2" style={{ color: cycle === 'annual' ? CD.green : CD.mute }}>{cycle === 'annual' ? `${fmt(pl.price, 'CAD')}/mo · ${pl.freeMonths} month${pl.freeMonths === 1 ? '' : 's'} free` : pl.tag}</div>
                  <div className="space-y-1 flex-1">
                    {pl.feat.map((f, i) => <div key={i} className="flex items-start gap-1.5 text-[11px]" style={{ color: CD.text }}><Ic n="check" s={12} c={CD.green} /><span>{f}</span></div>)}
                    {pl.excl.map((f, i) => <div key={'x' + i} className="flex items-start gap-1.5 text-[11px]" style={{ color: CD.faint }}><Ic n="x" s={12} c={CD.faint} /><span style={{ textDecoration: 'line-through' }}>{f}</span></div>)}
                  </div>
                  <div className="mt-2.5 text-center text-[11px] font-semibold py-1.5" style={on ? { color: CD.mute } : { background: pl.best ? CD.ink : 'transparent', color: pl.best ? 'var(--cd-on-ink)' : CD.ink, border: pl.best ? 'none' : `1px solid ${CD.line}`, borderRadius: 8 }}>{on ? 'Your plan' : 'Switch to ' + pl.name}</div>
                </button>); })}
            </div>
            {planMsg && <div className="text-[11.5px] mb-3 px-3 py-2" style={{ color: CD.flag, background: CD.flagSoft, borderRadius: 8 }}>{planMsg}</div>}
            <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Usage this period</div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[['Locations', locs], ['Tills', tills], ['Staff seats', seats]].map(([l, v], i) => (<div key={i} className="p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.panel }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-xl font-bold mt-0.5" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
            </div>
            <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Verification & add-ons · pay-as-you-go</div>
            {(() => {
              const PROVIDERS = ['Persona', 'Onfido', 'Sumsub', 'Trulioo', 'Veriff'];
              const cur = settings.kycProvider || (window.CDOS.KYC && window.CDOS.KYC.getProvider ? window.CDOS.KYC.getProvider() : 'Persona');
              const setProv = (v) => { set('kycProvider', v); if (window.CDOS.KYC && window.CDOS.KYC.setProvider) window.CDOS.KYC.setProvider(v); };
              return (<div className="flex items-center justify-between p-3 mb-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: CD.panel }}>
                <div className="flex items-center gap-2.5">
                  <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 9, background: CD.lineSoft }}><Ic n="shield" s={16} c={CD.mute} /></span>
                  <div><div className="text-[13px] font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>Verification provider <window.CDOS.InfoTip title="Verification provider" body="The partner that runs ID, biometric and database checks. Swap it anytime — all verifications route through whichever provider is selected here." /></div><div className="text-[11px]" style={{ color: CD.mute }}>Routes every KYC check through this partner</div></div>
                </div>
                <div className="relative flex items-center">
                  <select value={cur} onChange={e => setProv(e.target.value)} className="text-[13px] font-semibold outline-none appearance-none cursor-pointer" style={{ background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, padding: '8px 30px 8px 12px' }}>
                    {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <span className="absolute pointer-events-none" style={{ right: 10, display: 'inline-flex' }}><Ic n="chev" s={13} c={CD.mute} /></span>
                </div>
              </div>); })()}
            {(() => { const k = (window.CDOS.KYC && window.CDOS.KYC.summary) ? window.CDOS.KYC.summary() : { monthCount: 0, monthSpend: 0 }; const prov = settings.kycProvider || (window.CDOS.KYC && window.CDOS.KYC.getProvider ? window.CDOS.KYC.getProvider() : 'Persona'); return (
              <div className="flex items-center justify-between p-3 mb-4" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: CD.panel }}>
                <div className="flex items-center gap-2.5">
                  <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 9, background: CD.lineSoft }}><Ic n="id" s={16} c={CD.mute} /></span>
                  <div><div className="text-[13px] font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>Identity verifications · {prov} <window.CDOS.InfoTip title="Pay-as-you-go" body="KYC background checks and ID verifications are billed per check to the card on file and added to your next invoice — on top of your subscription." /></div><div className="text-[11px]" style={{ color: CD.mute }}>{k.monthCount} this month · charged per check</div></div>
                </div>
                <div className="text-right"><div className="text-xl font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{fmt(k.monthSpend, 'CAD')}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>this period</div></div>
              </div>); })()}

            <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Payment</div>
            <button onClick={() => setTab('payment')} className="w-full flex items-center gap-3 p-3 mb-4 text-left" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: CD.panel }}>
              <span className="grid place-items-center flex-none" style={{ width: 40, height: 27, borderRadius: 5, background: CARD_GRAD[cardBrand(primaryCard.num)] }}><Ic n="card" s={14} c="var(--cd-on-ink)" /></span>
              <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>{cardBrand(primaryCard.num)} ···· {cardLast4(primaryCard.num)} <span className="text-[9px] px-1.5 py-0.5" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>PRIMARY</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{cards.length} card{cards.length === 1 ? '' : 's'} on file{cards.find(c => c.role === 'backup') ? ' · backup set' : ''}</div></div>
              <span className="flex items-center gap-1 text-[12px] font-medium flex-none" style={{ color: CD.ink }}>Manage <Ic n="chev" s={13} c={CD.mute} /></span>
            </button>
            <div className="text-[10px] uppercase tracking-widest mb-1 mt-4" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Recent invoices</div>
            <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 10 }}>
              {INV.map(([ref, date], i) => (<div key={ref} className="flex items-center justify-between px-3 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}><div><div className="text-[12.5px] font-medium" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{ref}</div><div className="text-[11px]" style={{ color: CD.mute }}>{date} · {fmt(cur.price, 'CAD')}</div></div><button onClick={() => invPDF(ref, date)} className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="download" s={13} /> PDF</button></div>))}
            </div>
          </div>); })()}

        {tab === 'payment' && (() => {
          const cards = seedCards(settings);
          const setCards = (fn) => setSettings(s => ({ ...s, cards: fn(s.cards || seedCards(s)) }));
          const setRole = (id, role) => { setCards(list => list.map(c => c.id === id ? { ...c, role } : (c.role === role ? { ...c, role: undefined } : c))); log('Card updated', role + ' card set'); };
          const removeCard = (id) => { const c = cards.find(x => x.id === id) || {}; setCards(list => list.filter(x => x.id !== id)); log('Card removed', cardBrand(c.num) + ' ··' + cardLast4(c.num)); };
          const submitCard = () => {
            const digits = cardDraft.num.replace(/\D/g, ''); if (digits.length < 12) return;
            setCards(list => [...list, { id: 'card_' + Date.now(), num: cardDraft.num, exp: cardDraft.exp, name: cardDraft.name || (settings.billingName || ''), postal: cardDraft.postal, role: list.some(c => c.role === 'primary') ? undefined : 'primary' }]);
            log('Card added', cardBrand(cardDraft.num) + ' ··' + cardLast4(cardDraft.num));
            setCardDraft({ num: '', exp: '', cvc: '', name: '', postal: '' }); setAddingCard(false);
          };
          return (<div>
            <SectionTitle icon="card" title="Payment methods" sub="Cards we charge for your subscription and per-use verification checks. The primary card is charged first; the backup is used automatically if it declines." />
            <div className="space-y-3 mb-5">
              {cards.map(c => { const brand = cardBrand(c.num); return (
                <div key={c.id} style={{ border: `1px solid ${c.role === 'primary' ? CD.ink : CD.line}`, borderRadius: 14, overflow: 'hidden', background: CD.panel }}>
                  <div className="flex items-stretch flex-wrap">
                    <div className="p-4 flex flex-col justify-between" style={{ width: 270, background: CARD_GRAD[brand], color: 'var(--cd-on-ink)' }}>
                      <div className="flex items-center justify-between"><span style={{ fontFamily: 'Space Mono, monospace', fontWeight: 700, letterSpacing: '.06em', fontSize: 11 }}>{brand}</span><span style={{ width: 30, height: 22, borderRadius: 4, background: 'linear-gradient(135deg,#e8c87a,#b8923f)', opacity: 0.9 }} /></div>
                      <div style={{ fontFamily: 'Space Mono, monospace', fontSize: 15, letterSpacing: '.16em', margin: '14px 0 10px' }}>···· ···· ···· {cardLast4(c.num)}</div>
                      <div className="flex items-center justify-between" style={{ fontSize: 10.5, opacity: 0.85, fontFamily: 'Space Mono, monospace' }}><span style={{ textTransform: 'uppercase' }}>{c.name || 'CARDHOLDER'}</span><span>{c.exp || 'MM/YY'}</span></div>
                    </div>
                    <div className="flex-1 p-3 flex flex-col justify-between" style={{ minWidth: 200 }}>
                      <div className="flex items-center gap-1.5">{c.role === 'primary' ? <span className="text-[9px] px-2 py-0.5 font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>PRIMARY · CHARGED FIRST</span> : c.role === 'backup' ? <span className="text-[9px] px-2 py-0.5 font-semibold" style={{ background: CD.brass, color: 'var(--cd-on-ink)', borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>BACKUP</span> : <span className="text-[10.5px]" style={{ color: CD.faint }}>Not in rotation</span>}</div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {c.role !== 'primary' && <button onClick={() => setRole(c.id, 'primary')} className="text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-on-ink)' }}>Make primary</button>}
                        {c.role !== 'backup' && <button onClick={() => setRole(c.id, 'backup')} className="text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-on-ink)' }}>Set as backup</button>}
                        <button onClick={() => removeCard(c.id)} disabled={cards.length <= 1} className="text-[11px] px-2.5 py-1.5 font-medium flex items-center gap-1" style={{ border: `1px solid ${CD.flagSoft}`, borderRadius: 7, color: CD.flag, background: CD.flagSoft, opacity: cards.length <= 1 ? 0.45 : 1, cursor: cards.length <= 1 ? 'not-allowed' : 'pointer' }}><Ic n="trash" s={12} c={CD.flag} /> Remove</button>
                      </div>
                    </div>
                  </div>
                </div>); })}
            </div>
            {addingCard ? (
              <div className="p-4 mb-5" style={{ border: `1px solid ${CD.ink}`, borderRadius: 14, background: CD.panel }}>
                <div className="text-[13px] font-semibold mb-3" style={{ color: CD.ink }}>Add a card</div>
                <div className="grid grid-cols-2 gap-2.5" style={{ maxWidth: 480 }}>
                  <label className="block col-span-2"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Card number</div><input value={cardDraft.num} onChange={e => setCardDraft(d => ({ ...d, num: e.target.value }))} placeholder="4242 4242 4242 4242" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} /></label>
                  <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Expiry</div><input value={cardDraft.exp} onChange={e => setCardDraft(d => ({ ...d, exp: e.target.value }))} placeholder="04/27" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} /></label>
                  <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>CVC</div><input value={cardDraft.cvc} onChange={e => setCardDraft(d => ({ ...d, cvc: e.target.value }))} placeholder="•••" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} /></label>
                  <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Name on card</div><input value={cardDraft.name} onChange={e => setCardDraft(d => ({ ...d, name: e.target.value }))} placeholder="Jordan Masri" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></label>
                  <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Billing postal</div><input value={cardDraft.postal} onChange={e => setCardDraft(d => ({ ...d, postal: e.target.value }))} placeholder="M5V 2T6" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></label>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={submitCard} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Add card</button>
                  <button onClick={() => { setAddingCard(false); setCardDraft({ num: '', exp: '', cvc: '', name: '', postal: '' }); }} className="px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute, background: 'var(--cd-on-ink)' }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingCard(true)} className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold mb-5" style={{ border: `1px dashed ${CD.line}`, borderRadius: 9, color: CD.ink, background: CD.panel }}><Ic n="plus" s={15} c={CD.ink} /> Add a card</button>
            )}
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Billing contact</div>
            <Row title="Billing email" desc="Invoices and receipts are sent here."><input value={settings.billingEmail || ''} onChange={e => set('billingEmail', e.target.value)} placeholder={settings.bizEmail || 'billing@business.com'} className="text-sm px-2.5 py-2 outline-none text-right" style={{ ...inSty, width: 220 }} /></Row>
            <div className="flex items-center gap-1.5 text-[11px] mt-3" style={{ color: CD.faint }}><Ic n="lock" s={12} c={CD.faint} /> Card details are stored securely with our payments provider — we only keep the brand and last four digits.</div>
          </div>);
        })()}

        {tab === 'ledger' && (<div>
          <SectionTitle icon="scroll" title="Ledger" sub="Defaults for the deal ledger, and bulk-import historical or external transactions from a spreadsheet." />

          {/* bulk import launcher */}
          <div className="flex items-center gap-3 p-4 mb-5" style={{ border: `1px solid ${CD.line}`, borderRadius: 14, background: CD.panel }}>
            <span className="grid place-items-center flex-none" style={{ width: 44, height: 44, borderRadius: 12, background: CD.lineSoft }}><Ic n="download" s={22} c={CD.ink} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: CD.ink }}>Import transactions</div>
              <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>Bring deals in from a CSV or Excel export — we map the columns, validate every row, then post them into the ledger.</div>
            </div>
            <button onClick={() => setImporting(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="upload" s={15} c="var(--cd-on-ink)" /> Import from file →</button>
          </div>

          {/* import defaults — these drive the importer's column reading + posting */}
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Import defaults</div>
          <Row title="Date format in your files" desc="How dates are written in the file you upload. Auto handles most exports."><Seg value={icfg.dateFormat || 'auto'} onPick={v => setIc({ dateFormat: v }, `import date ${v}`)} opts={[['auto', 'Auto'], ['YYYY-MM-DD', 'Y-M-D'], ['DD/MM/YYYY', 'D/M/Y'], ['MM/DD/YYYY', 'M/D/Y']]} /></Row>
          <Row title="Default pay-in currency" desc="Used when a row doesn't name a currency."><select value={icfg.defaultInCcy || 'CAD'} onChange={e => setIc({ defaultInCcy: e.target.value }, `import ccy ${e.target.value}`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 120 }}>{CCY.map(c => <option key={c}>{c}</option>)}</select></Row>
          <Row title="Default transaction type" desc="Used when a row's type is blank or unrecognised."><select value={icfg.defaultType || 'Currency Exchange'} onChange={e => setIc({ defaultType: e.target.value }, `import type ${e.target.value}`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 200 }}>{(window.CDOS.TYPES || []).map(t => <option key={t}>{t}</option>)}</select></Row>
          <Row title="Auto-create unknown customers" desc="New names become client records (flagged for KYC follow-up)."><Sw on={icfg.autoCreateClients !== false} click={() => setIc({ autoCreateClients: !(icfg.autoCreateClients !== false) }, 'import auto-create clients')} /></Row>
          <Row title="Skip rows whose reference already exists" desc="Avoids importing the same deal twice."><Sw on={icfg.skipDuplicateRefs !== false} click={() => setIc({ skipDuplicateRefs: !(icfg.skipDuplicateRefs !== false) }, 'import skip duplicates')} /></Row>

          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="scroll" s={13} c={CD.mute} /><span>Imported deals are permanent ledger records — they run through the same compliance flags (reportable, structuring, KYC) as anything booked at the counter. Missing rate or pay-out is computed at the live mid.</span></div>

          {/* export the whole book — lives here now, not in the Ledger toolbar */}
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-6" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Export</div>
          <div className="p-4" style={{ border: `1px solid ${CD.line}`, borderRadius: 14, background: CD.panel }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="grid place-items-center flex-none" style={{ width: 44, height: 44, borderRadius: 12, background: CD.lineSoft }}><Ic n="download" s={22} c={CD.ink} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: CD.ink }}>Export the ledger</div>
                <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>Download your transactions as a CSV — opens in Excel, Google Sheets or Numbers.</div>
              </div>
            </div>
            <Row title="Date range" desc="Which transactions to include in the file."><Seg value={expOpts.range} onPick={v => setExpOpts(o => ({ ...o, range: v }))} opts={[['all', 'All time'], ['month', 'This month'], ['year', 'This year']]} /></Row>
            <Row title="Columns" desc="Full detail, or a compact summary of the essentials."><Seg value={expOpts.cols} onPick={v => setExpOpts(o => ({ ...o, cols: v }))} opts={[['all', 'Full detail'], ['compact', 'Summary']]} /></Row>
            <Row title="Include voided transactions" desc="Reversed records are left out unless you switch this on."><Sw on={expOpts.includeVoid} click={() => setExpOpts(o => ({ ...o, includeVoid: !o.includeVoid }))} /></Row>
            <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <span className="text-[11.5px]" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}><b style={{ color: CD.ink }}>{expList.length}</b> transaction{expList.length === 1 ? '' : 's'} ready</span>
              <button onClick={exportLedgerGated} disabled={!expList.length} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: !expList.length ? 'var(--cd-disabled)' : exported ? CD.green : CD.ink, borderRadius: 9, cursor: expList.length ? 'pointer' : 'not-allowed' }}><Ic n={exported ? 'check' : 'lock'} s={15} c="var(--cd-on-ink)" /> {exported ? 'Downloaded' : 'Export CSV'}</button>
            </div>
          </div>
        </div>)}

        {tab === 'clients' && (<div>
          <SectionTitle icon="users" title="Clients · KYC" sub="Defaults and identity checks for the Clients app — these drive the KYC status badges on every contact." />
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>New contacts</div>
          <Row title="Default risk for new contacts" desc="Pre-set on contacts created at the desk or through a KYC flow."><select value={(window.CDOS.normalizeRisk ? window.CDOS.normalizeRisk(settings.defaultClientRisk) : (settings.defaultClientRisk || 'Normal'))} onChange={e => set('defaultClientRisk', e.target.value, `default risk ${e.target.value}`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 150 }}>{(window.CDOS.RISK_TIERS || ['Normal', 'Low', 'Medium', 'High']).map(r => <option key={r}>{r}</option>)}</select></Row>
          <Row title="Warn when ID expires within" desc="Contacts get an amber 'ID expiring' badge inside this window."><select value={settings.idExpiryWarnDays ?? 30} onChange={e => set('idExpiryWarnDays', +e.target.value, `id expiry warn ${e.target.value}d`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 150 }}>{[[0, 'Off'], [30, '30 days'], [60, '60 days'], [90, '90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Risk tiers</div>
          <div className="text-[11px] mb-2" style={{ color: CD.mute, maxWidth: 620 }}>Your own client risk ratings — staff set a tier on each contact's profile, so you can show regulators you run your own risk model. Add a short note describing what each tier means at your desk. High-risk automatically deepens the recommended ID check.</div>
          <div className="space-y-2">
            {(window.CDOS.RISK_TIERS || ['Normal', 'Low', 'Medium', 'High']).map(r => { const tn = window.CDOS.riskTone(r); const notes = settings.riskTierNotes || {}; const esc = r === 'High' || (r === 'Medium' && !!settings.escalateMediumRisk); return (
              <div key={r} className="flex items-center gap-3 p-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.panel }}>
                <span className="grid place-items-center flex-none text-[11px] font-semibold" style={{ minWidth: 72, padding: '4px 10px', borderRadius: 999, background: tn.bg, color: tn.c }}>{r}</span>
                <input value={notes[r] || ''} onChange={e => set('riskTierNotes', { ...notes, [r]: e.target.value }, `risk tier note ${r}`)} placeholder={({ Normal: 'Standard walk-in activity', Low: 'Known, established, low-risk', Medium: 'Elevated — enhanced due diligence', High: 'High-risk — deepest checks & monitoring' })[r]} className="flex-1 text-[12.5px] px-2.5 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-panel)', color: CD.ink }} />
                <span className="text-[10px] flex-none uppercase tracking-widest" style={{ color: esc ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>{esc ? 'escalates' : '—'}</span>
              </div>); })}
          </div>
          <div className="mt-2"><Row title="Also escalate Medium-risk to a full check" desc="Off by default — Medium stays a lighter, recommended check; High always escalates."><Sw on={!!settings.escalateMediumRisk} click={() => toggleSet('escalateMediumRisk', 'Escalate medium-risk')} /></Row></div>

          <div className="text-[10px] uppercase tracking-widest mb-1 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>File completeness</div>
          <Row title="Require ID scan on file" desc="Moved to Compliance & jurisdiction, alongside the rest of the verification policy."><button onClick={() => setTab('compliance')} className="flex items-center gap-1 text-[12.5px] font-semibold" style={{ color: CD.ink }}>Open <Ic n="chev" s={13} c={CD.mute} /></button></Row>
          <Row title="Require email on file" desc="Contacts missing an email get an amber 'email required' chip on their profile."><Sw on={!!settings.requireClientEmail} click={() => toggleSet('requireClientEmail', 'Require client email')} /></Row>
          <Row title="Require phone on file" desc="Contacts missing a phone number get an amber 'phone required' chip on their profile."><Sw on={!!settings.requireClientPhone} click={() => toggleSet('requireClientPhone', 'Require client phone')} /></Row>
          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="users" s={13} c={CD.mute} /><span>These feed the KYC status on every profile and the <b style={{ color: CD.ink }}>ID / KYC issues</b> queue in the Ledger's Compliance workspace.</span></div>
        </div>)}

        {tab === 'vault' && (<div>
          <SectionTitle icon="building" title="Cash on hand · Vault" sub="Stock floors and reserves the Vault and Till watch for." />
          <Row title="Low-stock alerts" desc="Raise a Vault notification when a currency drops below its floor."><Sw on={settings.vaultLowAlert !== false} click={() => set('vaultLowAlert', !(settings.vaultLowAlert !== false), 'Vault low-stock alert')} /></Row>
          <Row title={`${base} reserve floor`} desc="Keep at least this much base currency on hand at all times."><Money k="vaultReserveCad" /></Row>
          <Row title="Valuation basis" desc="How the Vault values its holdings."><Seg value={settings.vaultBasis || 'cost'} onPick={v => set('vaultBasis', v, `vault basis ${v}`)} opts={[['cost', 'At cost'], ['mid', 'At mid']]} /></Row>
          <div className="mt-4">
            <div className="text-sm font-medium mb-1" style={{ color: CD.ink }}>Per-currency low-stock floor</div>
            <div className="text-[11px] mb-2" style={{ color: CD.mute }}>Units of each currency to keep on hand. Blank = the built-in reorder band.</div>
            <div className="grid grid-cols-3 gap-2">
              {(CCY || []).filter(c => c !== base).map(c => { const floors = settings.vaultFloors || {}; return (
                <div key={c} className="flex items-center gap-2 px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, background: CD.panel }}>
                  <span className="text-[12px] font-medium flex-none" style={{ color: CD.ink, width: 34, fontFamily: 'Space Mono, monospace' }}>{c}</span>
                  <input type="number" value={floors[c] ?? ''} onChange={e => { const v = e.target.value; setSettings(s => ({ ...s, vaultFloors: { ...(s.vaultFloors || {}), [c]: v === '' ? '' : +v } })); }} placeholder="—" className="text-sm px-1.5 py-1 outline-none text-right w-full bg-transparent" style={{ fontVariantNumeric: 'tabular-nums' }} />
                </div>); })}
            </div>
          </div>
          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="building" s={13} c={CD.mute} /><span>The <b style={{ color: CD.ink }}>Cash on Hand · Vault</b> app derives live positions from posted records; these floors decide when it warns you to reorder.</span></div>
        </div>)}

        {tab === 'till' && (<div>
          <SectionTitle icon="wallet" title="Cash drawer" sub="How tellers count, reconcile and hand off the drawer. Every control here changes the Till app directly." />
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Counting</div>
          <Row title="Default count method" desc="How a drawer opens for counting — by denomination, or one quick total. Tellers can still switch per currency.">
            <Seg value={settings.tillCountMode || 'denom'} onPick={v => set('tillCountMode', v, `count method · ${v}`)} opts={[['denom', 'Denominations'], ['total', 'Quick total']]} />
          </Row>
          <Row title="Blind count" desc="Hide the expected float until the teller reveals it, so a count isn't anchored to what the drawer 'should' hold.">
            <Sw on={settings.tillBlindCount !== false} click={() => toggleSet('tillBlindCount', 'Blind count')} />
          </Row>
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-6" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Reconcile & close</div>
          <Row title="Variance tolerance" desc="A drawer counted within this of expected reads as balanced; beyond it, it's flagged off on the reconcile and at close.">
            <div className="flex items-center" style={inSty}><span className="px-2 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{base}</span><input type="number" min="0" step="1" value={settings.tillVarianceTol ?? 0} onChange={e => set('tillVarianceTol', Math.max(0, +e.target.value), `variance tolerance ${e.target.value}`)} className="text-sm px-2 py-2 outline-none text-right bg-transparent" style={{ width: 90, fontVariantNumeric: 'tabular-nums', borderLeft: `1px solid ${CD.line}` }} /></div>
          </Row>
          <Row title="Require a count before closing the day" desc="Every currency drawer must be counted before the trading day can be locked.">
            <Sw on={!!settings.requireCountOnClose} click={() => toggleSet('requireCountOnClose', 'Require count on close')} />
          </Row>
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-6" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Handoffs</div>
          <Row title="Require a count when the drawer changes hands" desc="When one teller hands the drawer to another, count it first and record any variance against the outgoing operator.">
            <Sw on={!!settings.requireCountOnHandoff} click={() => toggleSet('requireCountOnHandoff', 'Require count on handoff')} />
          </Row>
          <p className="mt-6 text-[11px]" style={{ color: CD.faint }}>The opening float is issued by the vault and is never editable in the Till — these settings govern only how the physical count is taken and checked against it.</p>
        </div>)}

        {tab === 'transfers' && (<div>
          <SectionTitle icon="globe" title="Transfers" sub="Cross-border money movement — the reporting line and desk defaults for the Transfers app." />
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Regulatory reporting</div>
          <Row title="Cross-border reporting threshold" desc={`International transfers at or above this are flagged in the pipeline and listed in the EFT report. Follows your jurisdiction (${settings.regime || 'FINTRAC'}).`}><Money k="threshold" /></Row>
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5" style={{ background: 'var(--cd-chip)', borderRadius: 10 }}>
            <Ic n="shield" s={14} c={CD.mute} /><span className="text-[11px]" style={{ color: CD.mute }}>One threshold drives both the pipeline flag and the qualifying list in Settlement → EFT report. Change the jurisdiction it follows under <b>Compliance & jurisdiction</b>.</span>
          </div>
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-6" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Desk defaults</div>
          <Row title="Require a purpose on every transfer" desc="Ask the teller to record why funds are moving — the backbone of a defensible audit trail on high-risk corridors.">
            <Sw on={settings.transferRequirePurpose !== false} click={() => toggleSet('transferRequirePurpose', 'Require transfer purpose')} />
          </Row>
          <p className="mt-6 text-[11px]" style={{ color: CD.faint }}>Corridors, partners and beneficiaries are operational records — set them up in the Transfers app under <b>Corridors</b> and <b>Beneficiaries</b>.</p>
        </div>)}

        {tab === 'cheques' && (<div>
          <SectionTitle icon="receipt" title="Cheques" sub="Risk controls for cheque cashing — these govern how long fronted cash stays at risk in the Cheques app." />
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Holds</div>
          <Row title="Minimum hold on every cheque" desc="A floor applied on top of each cheque type's own hold — raise it in stricter jurisdictions or after a loss.">
            <div className="flex items-center" style={inSty}><input type="number" min="0" step="1" value={settings.chequeMinHoldDays ?? 0} onChange={e => set('chequeMinHoldDays', Math.max(0, +e.target.value), `min cheque hold ${e.target.value}d`)} className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: 70, fontVariantNumeric: 'tabular-nums' }} /><span className="px-2 text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace', borderLeft: `1px solid ${CD.line}` }}>days</span></div>
          </Row>
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5" style={{ background: 'var(--cd-chip)', borderRadius: 10 }}>
            <Ic n="clock" s={14} c={CD.mute} /><span className="text-[11px]" style={{ color: CD.mute }}>Applied at capture: a cheque's hold becomes the greater of this floor and its type's scheduled hold — so government and certified cheques still clear on their faster schedule unless you raise the floor.</span>
          </div>
          <p className="mt-6 text-[11px]" style={{ color: CD.faint }}>Per-type fees and standard hold days are an operational table — edit them in the Cheques app under <b>Fee schedule</b>.</p>
        </div>)}

        {tab === 'tagged' && (<div>
          <SectionTitle icon="bookmark" title="Tagged" sub="Rules that auto-tag transactions for a second look — they show up in the Tagged app and as a badge in the Ledger." />
          <Row title="Auto-tag deals at or over" desc="Large single deals are tagged for owner review."><Money k="autoTagOver" /></Row>
          <Row title="Auto-tag Medium / High-risk clients" desc="Any deal by a client rated Medium or High risk."><Sw on={!!settings.autoTagRisk} click={() => toggleSet('autoTagRisk', 'Auto-tag risk clients')} /></Row>
          <Row title="Auto-tag a new client's first deal" desc="The first transaction for a brand-new contact."><Sw on={!!settings.autoTagNew} click={() => toggleSet('autoTagNew', 'Auto-tag new client')} /></Row>
          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="bookmark" s={13} c={CD.mute} /><span>Rules run as each new deal is posted — existing records aren't retagged. Tagging never blocks a deal; it just routes it to the <b style={{ color: CD.ink }}>Tagged</b> review queue so nothing important slips by.</span></div>
        </div>)}

        {tab === 'employees' && (() => {
          const emps = settings.employees || [];
          const ROLE_APPS = { 'Manager': ['rates', 'ledger', 'transfers', 'cheques', 'clients', 'compliance', 'dashboard', 'till', 'vault', 'branches', 'tagged', 'audit'], 'Senior teller': ['rates', 'ledger', 'transfers', 'cheques', 'clients', 'till', 'vault', 'dashboard'], 'Cashier': ['rates', 'ledger', 'clients', 'till'], 'Trainee': ['rates', 'ledger', 'clients'] };
          const setEmps = (fn) => setSettings(s => ({ ...s, employees: fn(s.employees || []) }));
          const setEmp = (id, patch, note) => { setEmps(list => list.map(e => e.id === id ? { ...e, ...patch } : e)); if (note) log('Employee updated', note); };
          const addEmp = () => { const id = 'e_' + Date.now(); setEmps(list => [...list, { id, name: 'New employee', role: 'Cashier', email: '', phone: '', code: '', active: true, caps: { ...(ROLE_CAPS.Cashier || {}) }, apps: DEF_APPS.slice(), branches: [], home: null }]); log('Employee added', 'New account'); return id; };
          const removeEmp = (id, name) => { setEmps(list => list.filter(e => e.id !== id)); setBranches && setBranches(list => list.map(b => ({ ...b, tills: (b.tills || []).map(t => (t.teller === name || t.operator === name) ? { ...t, teller: t.teller === name ? '' : t.teller, operator: t.operator === name ? '' : t.operator } : t) }))); log('Employee removed', name); };
          const toggleCap = (e, k) => setEmp(e.id, { caps: { ...(e.caps || {}), [k]: !(e.caps || {})[k] } });
          const toggleApp = (e, id) => { const cur = Array.isArray(e.apps) ? e.apps : DEF_APPS.slice(); setEmp(e.id, { apps: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }); };
          const assignmentOf = (name) => { for (const b of (branches || [])) for (const t of (b.tills || [])) if (t.teller === name) return { bId: b.id, tId: t.id, b, t }; return null; };
          const assignEmp = (name, bId, tId) => setBranches && setBranches(list => list.map(b => ({ ...b, tills: (b.tills || []).map(t => { let teller = t.teller === name ? '' : t.teller; if (b.id === bId && t.id === tId) teller = name; return { ...t, teller }; }) })));
          // apply a role preset in one move: role + capability defaults + a sensible app set
          const applyPreset = (e, role) => setEmp(e.id, { role, caps: { ...(ROLE_CAPS[role] || {}) }, apps: (ROLE_APPS[role] || DEF_APPS).slice() }, `${e.name} → ${role}`);
          // assign the person to branches (★ home) directly from their profile
          const toggleBranch = (e, bId) => { const cur = Array.isArray(e.branches) ? e.branches : []; const next = cur.includes(bId) ? cur.filter(x => x !== bId) : [...cur, bId]; const home = next.includes(e.home) ? e.home : (next[0] || null); setEmp(e.id, { branches: next, home }, `${e.name} · ${next.length} branch(es)`); const a = assignmentOf(e.name); if (a && !next.includes(a.bId)) assignEmp(e.name, null, null); };
          const isCustom = (e) => { const rc = ROLE_CAPS[e.role] || {}; const capsMatch = CAPS.every(([k]) => !!(e.caps || {})[k] === !!rc[k]); const ra = ROLE_APPS[e.role] || DEF_APPS; const apps = Array.isArray(e.apps) ? e.apps : DEF_APPS; const appsMatch = apps.length === ra.length && ra.every(a => apps.includes(a)); return !(capsMatch && appsMatch); };

          // ---- roster row: click to open the account ----
          const empRow = (e) => {
            const asg = assignmentOf(e.name); const blocked = e.active === false;
            return (<button key={e.id} onClick={() => setEmpSel(e.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" style={{ border: `1px solid ${CD.line}`, borderRadius: 11, background: CD.panel, marginBottom: 8, opacity: blocked ? 0.62 : 1 }}>
              <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: blocked ? CD.lineSoft : CD.ink, color: blocked ? CD.mute : 'var(--cd-on-ink)', fontSize: 11.5, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{inits(e.name)}</span>
              <span className="flex-1 min-w-0"><span className="block text-[13.5px] font-semibold truncate" style={{ color: CD.ink }}>{e.name}</span><span className="block text-[11px] truncate" style={{ color: CD.faint }}>{e.role}{e.email ? ' · ' + e.email : ''}</span></span>
              {blocked ? <span className="text-[9px] px-1.5 py-0.5 font-semibold flex-none" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>BLOCKED</span> : asg ? <span className="text-[10px] px-1.5 py-0.5 flex-none" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 6 }}>{asg.t.name.replace(/\s+—.*/, '')}</span> : <span className="text-[10px] px-1.5 py-0.5 flex-none" style={{ color: CD.faint }}>unposted</span>}
              <Ic n="chev" s={15} c={CD.faint} />
            </button>);
          };

          // ---- full account / profile editor ----
          const empDetail = (e) => {
            const asg = assignmentOf(e.name); const apps = Array.isArray(e.apps) ? e.apps : null; const isOwner = e.role === 'Owner'; const blocked = e.active === false;
            const worksAt = e.branches === '*' || isOwner ? 'Whole network' : (Array.isArray(e.branches) && e.branches.length ? e.branches.map(id => { const b = (branches || []).find(x => x.id === id); return (b ? b.code : id) + (e.home === id ? ' ★' : ''); }).join(' · ') : 'Not assigned yet');
            return (<div>
              <button onClick={() => setEmpSel(null)} className="flex items-center gap-1.5 text-[12px] mb-3" style={{ color: CD.mute }}><span style={{ transform: 'rotate(180deg)', display: 'inline-flex' }}><Ic n="chev" s={14} c={CD.mute} /></span> All employees</button>
              <div className="flex items-center gap-3.5 mb-4 p-4" style={{ border: `1px solid ${CD.line}`, borderRadius: 14, background: CD.panel }}>
                <span className="grid place-items-center flex-none" style={{ width: 52, height: 52, borderRadius: '50%', background: blocked ? CD.lineSoft : CD.ink, color: blocked ? CD.mute : 'var(--cd-on-ink)', fontSize: 17, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{inits(e.name)}</span>
                <div className="flex-1 min-w-0"><div className="text-[17px] font-bold leading-tight" style={{ color: CD.ink }}>{e.name || 'New employee'}</div><div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>{e.role}{asg ? ' · posted → ' + asg.t.name.replace(/\s+—.*/, '') : ''}</div></div>
                {blocked ? <span className="text-[10px] px-2 py-1 font-semibold flex-none" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>BLOCKED</span> : <span className="text-[10px] px-2 py-1 font-semibold flex-none" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>ACTIVE</span>}
              </div>

              <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Profile</div>
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Full name"><input value={e.name} onChange={ev => setEmp(e.id, { name: ev.target.value })} className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></Field>
                <Field label="Role"><select value={e.role} onChange={ev => applyPreset(e, ev.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inSty}>{EMP_ROLES.map(r => <option key={r}>{r}</option>)}</select></Field>
                <Field label="Work email"><input value={e.email || ''} onChange={ev => setEmp(e.id, { email: ev.target.value })} placeholder="name@business.com" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></Field>
                <Field label="Mobile phone"><input value={e.phone || ''} onChange={ev => setEmp(e.id, { phone: ev.target.value })} placeholder="(416) 555-0000" className="w-full text-sm px-2.5 py-2 outline-none" style={inSty} /></Field>
                <Field label="Staff ID / sign-in" desc="What they type to sign in."><input value={e.code || ''} onChange={ev => setEmp(e.id, { code: ev.target.value })} placeholder="e.g. a.singh" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} /></Field>
                <div className="col-span-2"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Works at</div>
                  {isOwner ? <div className="text-sm px-2.5 py-2" style={{ ...inSty, color: CD.mute }}>Whole network — every branch &amp; till</div> : (
                  <div className="p-2.5" style={{ ...inSty }}>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {(branches || []).map(b => { const on = Array.isArray(e.branches) && e.branches.includes(b.id); const home = e.home === b.id; return (
                        <span key={b.id} className="flex items-center" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
                          <button type="button" onClick={() => toggleBranch(e, b.id)} className="text-[11.5px] px-2 py-1 font-medium" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute }}>{b.code}</button>
                          {on && <button type="button" onClick={() => setEmp(e.id, { home: b.id }, `${e.name} · home ${b.code}`)} title="Set as home branch" className="px-1.5 py-1" style={{ background: CD.ink, color: home ? '#f5c451' : 'var(--cd-on-ink-soft)' }}>★</button>}
                        </span>); })}
                      {!(Array.isArray(e.branches) && e.branches.length) && <span className="text-[11px]" style={{ color: CD.faint }}>Pick a branch — ★ marks their home</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-2.5">
                      <span className="text-[11px] flex-none" style={{ color: CD.mute }}>Posted to</span>
                      <select value={asg ? asg.b.id + '|' + asg.t.id : ''} onChange={ev => { if (!ev.target.value) { assignEmp(e.name, null, null); log(`${e.name} · unposted`, ''); return; } const parts = ev.target.value.split('|'); assignEmp(e.name, parts[0], parts[1]); log(`${e.name} · posted`, ev.target.options[ev.target.selectedIndex].text); }} className="flex-1 text-sm px-2.5 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)' }}>
                        <option value="">Not posted to a till</option>
                        {(branches || []).filter(b => Array.isArray(e.branches) && e.branches.includes(b.id)).map(b => (b.tills || []).map(t => <option key={b.id + t.id} value={b.id + '|' + t.id}>{b.code} · {t.name.replace(/\s+—.*/, '')}</option>))}
                      </select>
                    </div>
                    <div className="text-[10.5px] mt-1.5" style={{ color: CD.faint }}>Posting sets their default drawer — the same as dragging them on the team board.</div>
                  </div>)}
                </div>
              </div>

              {isOwner ? (
                <div className="mt-4 text-[12px] px-3 py-3 flex items-start gap-2" style={{ color: CD.mute, background: CD.lineSoft, borderRadius: 10 }}><Ic n="shield" s={14} c={CD.mute} /><span><b style={{ color: CD.ink }}>Owner</b> — full access to every app and function across the whole network. This can't be reduced.</span></div>
              ) : (<>
                <div className="flex items-center justify-between mt-5 mb-2">
                  <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Role preset</div>
                  {isCustom(e) && <span className="text-[9.5px] px-1.5 py-0.5 font-semibold" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 999 }}>CUSTOMIZED</span>}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {['Manager', 'Senior teller', 'Cashier', 'Trainee'].map(r => { const on = e.role === r && !isCustom(e); return (<button key={r} onClick={() => applyPreset(e, r)} className="px-2 py-2 text-[11.5px] font-semibold text-center" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : CD.panel, color: on ? 'var(--cd-on-ink)' : CD.ink, borderRadius: 9 }}>{r}</button>); })}
                </div>
                <div className="text-[10.5px] mt-1.5" style={{ color: CD.faint }}>A preset sets the functions and apps below in one move — tweak anything after and it reads “customized”.</div>

                <div className="text-[10px] uppercase tracking-widest mb-1.5 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Functions they can perform</div>
                <div className="grid grid-cols-2 gap-x-4">{CAPS.map(([k, label, desc]) => <label key={k} className="flex items-center justify-between gap-2 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }} title={desc}><span className="text-[12px]" style={{ color: CD.ink }}>{label}</span><Sw on={!!(e.caps || {})[k]} click={() => toggleCap(e, k)} /></label>)}</div>

                <div className="text-[10px] uppercase tracking-widest mb-1.5 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Apps in their dock</div>
                <div className="flex flex-wrap gap-1.5">{APPS.map(([id, label]) => { const on = apps ? apps.includes(id) : true; return <button key={id} onClick={() => toggleApp(e, id)} className="text-[11px] px-2 py-1" style={{ borderRadius: 7, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.faint }}>{label}</button>; })}</div>
                <div className="text-[10.5px] mt-1.5" style={{ color: CD.faint }}>Only the highlighted apps appear in their dock.</div>
              </>)}

              <div className="text-[10px] uppercase tracking-widest mb-1.5 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Security</div>
              {(() => {
                const sid = (e.code || '').trim();
                const acct = sid && srvStaff ? srvStaff[sid] : null;
                const doCreate = () => {
                  if (srvPw.length < 8) { setSrvMsg('Temporary password needs at least 8 characters.'); return; }
                  setSrvBusy(true); setSrvMsg('');
                  srvCall('POST', '/api/staff', { staffId: sid, name: e.name, role: SRV_ROLE[e.role] || 'teller', password: srvPw })
                    .then(() => { log('Sign-in created', e.name + ' \u00b7 ' + sid); setSrvPw(''); srvReload(); })
                    .catch(err => setSrvMsg(String(err.message || err)))
                    .then(() => setSrvBusy(false));
                };
                const doReset = () => {
                  if (srvPw.length < 8) { setSrvMsg('Temporary password needs at least 8 characters.'); return; }
                  setSrvBusy(true); setSrvMsg('');
                  srvCall('POST', '/api/staff/' + encodeURIComponent(sid) + '/password', { password: srvPw })
                    .then(() => { log('Password reset', e.name + ' \u00b7 temporary issued'); setSrvPw(''); srvReload(); })
                    .catch(err => setSrvMsg(String(err.message || err)))
                    .then(() => setSrvBusy(false));
                };
                const doToggle = () => {
                  setSrvBusy(true); setSrvMsg('');
                  srvCall('PATCH', '/api/staff/' + encodeURIComponent(sid), { active: !acct.active })
                    .then(() => { log(acct.active ? 'Sign-in disabled' : 'Sign-in enabled', e.name + ' \u00b7 ' + sid); srvReload(); })
                    .catch(err => setSrvMsg(String(err.message || err)))
                    .then(() => setSrvBusy(false));
                };
                return (
                  <div className="p-3 mb-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 11, background: CD.panel }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium" style={{ color: CD.ink }}>Sign-in password</div>
                        <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>
                          {srvState === 'offline' ? 'Server unavailable — passwords are managed on the live desk.' :
                            srvState === 'forbidden' ? 'Only a manager or the owner can manage sign-ins.' :
                            srvState === 'loading' ? 'Checking the server…' :
                            !sid ? 'Give them a Staff ID above first — that’s their username.' :
                            !acct ? 'No server account yet — issue a temporary password and hand it to them privately.' :
                            !acct.active ? 'Sign-in disabled — they can’t get in until it’s re-enabled.' :
                            acct.mustChangePassword ? 'Temporary password issued — they’ll set their own at first sign-in.' :
                            'Password set by the employee — only they know it. Reset issues a new temporary one.'}
                        </div>
                      </div>
                      {acct && <span className="text-[9px] px-1.5 py-0.5 font-semibold flex-none" style={{ background: acct.active ? CD.greenSoft : CD.flagSoft, color: acct.active ? CD.green : CD.flag, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{acct.active ? (acct.mustChangePassword ? 'TEMP ISSUED' : 'ACTIVE') : 'DISABLED'}</span>}
                    </div>
                    {srvState === 'ok' && sid && (
                      <div className="flex items-center gap-2 mt-2.5" style={{ opacity: srvBusy ? 0.5 : 1, pointerEvents: srvBusy ? 'none' : 'auto' }}>
                        <input type="text" value={srvPw} onChange={ev => setSrvPw(ev.target.value)} placeholder="temporary password · min 8 chars" className="flex-1 text-[12px] px-2.5 py-1.5 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} />
                        {!acct
                          ? <button onClick={doCreate} className="text-[11.5px] px-2.5 py-1.5 font-semibold flex-none" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}>Create sign-in</button>
                          : (<React.Fragment>
                              <button onClick={doReset} className="text-[11.5px] px-2.5 py-1.5 font-semibold flex-none" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}>Reset password</button>
                              <button onClick={doToggle} className="text-[11.5px] px-2.5 py-1.5 flex-none" style={{ border: `1px solid ${acct.active ? CD.flagSoft : CD.line}`, background: acct.active ? CD.flagSoft : 'transparent', color: acct.active ? CD.flag : CD.ink, borderRadius: 8 }}>{acct.active ? 'Disable' : 'Enable'}</button>
                            </React.Fragment>)}
                      </div>
                    )}
                    {srvMsg && <div className="text-[11px] mt-1.5" style={{ color: CD.flag }}>{srvMsg}</div>}
                  </div>
                );
              })()}
            <Row title="Transaction PIN" desc="The 4-digit PIN this person enters to sign in and confirm sensitive actions. Everyone starts at 0000."><span className="flex items-center gap-2.5">
                <span className="text-[13px] font-bold tracking-[0.3em]" style={{ fontFamily: 'Space Mono, monospace', color: CD.ink }}>{revealPin[e.id] ? (e.pin || '0000') : '••••'}</span>
                <button onClick={() => setRevealPin(m => ({ ...m, [e.id]: !m[e.id] }))} className="text-[11px] px-2 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.mute }}>{revealPin[e.id] ? 'Hide' : 'Reveal'}</button>
                <button onClick={() => setEmp(e.id, { pin: '0000' }, `${e.name} · PIN reset to 0000`)} className="text-[11px] px-2 py-1" style={{ color: CD.flag }}>Reset</button>
              </span></Row>
              <Row title="Require PIN" desc="When on, this person enters their PIN to switch to their account, take a till, and void a deal."><Sw on={e.requirePin !== false} click={() => setEmp(e.id, { requirePin: e.requirePin === false }, `${e.name} · PIN ${e.requirePin === false ? 'required' : 'optional'}`)} /></Row>

              <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: `1px solid ${CD.line}` }}>
                {isOwner ? <span className="text-[11px]" style={{ color: CD.faint }}>The owner account can’t be blocked or removed here.</span> : (<>
                  <label className="flex items-center gap-2 text-[12px]" style={{ color: CD.ink }}><Sw on={blocked} click={() => { setEmp(e.id, { active: blocked }, `${e.name} · ${blocked ? 'unblocked' : 'blocked'}`); srvSetActive(e.code, blocked); }} /> Block this account</label>
                  <button onClick={() => { srvSetActive(e.code, false); removeEmp(e.id, e.name); setEmpSel(null); }} className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.flagSoft}`, background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="trash" s={13} c={CD.flag} /> Remove</button>
                </>)}
              </div>
            </div>);
          };
          const sel = empSel && emps.find(e => e.id === empSel);
          if (sel) return empDetail(sel);
          return (<div>
            <SectionTitle icon="users" title="Employees" sub="Everyone with an account. Click a person to open their profile, set what they can do, and manage access." />
            <div className="mb-4 p-3.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: 'var(--cd-chip)' }}>
              <div className="text-[10px] uppercase tracking-widest mb-1.5 flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="lock" s={11} c={CD.faint} /> PIN security</div>
              <div className="text-[10.5px] mb-1" style={{ color: CD.mute }}>The PIN is a quick in-app check — sign-in still uses each person’s password. Everyone’s PIN starts at <b>0000</b>.</div>
              <label className="flex items-center justify-between gap-3 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="min-w-0"><span className="block text-[12.5px]" style={{ color: CD.ink }}>Require PIN to switch account</span><span className="block text-[10.5px]" style={{ color: CD.mute }}>Prove it’s them before loading another person’s desk.</span></span><Sw on={settings.pinOnSwitch !== false} click={() => toggleSet('pinOnSwitch', 'PIN on account switch')} /></label>
              <label className="flex items-center justify-between gap-3 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="min-w-0"><span className="block text-[12.5px]" style={{ color: CD.ink }}>Require PIN to take a till</span><span className="block text-[10.5px]" style={{ color: CD.mute }}>Entering or taking over a drawer asks for the operator’s PIN.</span></span><Sw on={settings.pinOnTill !== false} click={() => toggleSet('pinOnTill', 'PIN on till switch')} /></label>
              <label className="flex items-center justify-between gap-3 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="min-w-0"><span className="block text-[12.5px]" style={{ color: CD.ink }}>Require PIN to void a transaction</span><span className="block text-[10.5px]" style={{ color: CD.mute }}>Reversing a posted deal asks the operator to confirm with their PIN.</span></span><Sw on={settings.pinOnVoid !== false} click={() => toggleSet('pinOnVoid', 'PIN on void')} /></label>
              <div className="text-[10.5px] mt-1.5" style={{ color: CD.faint }}>Exempt one person from these prompts with <b>Require PIN</b> in their profile.</div>
            </div>
            {window.CDOS.TeamBoard && (branches || []).length > 0 && (<div className="mb-5">
              <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Who works where</div>
              {React.createElement(window.CDOS.TeamBoard, { me, log, branches, setBranches, settings, setSettings })}
            </div>)}
            <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Accounts · {emps.length}</div>
            {emps.map(empRow)}
            <button onClick={() => setEmpSel(addEmp())} className="flex items-center gap-1.5 px-3 py-2 mt-1 text-[13px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Add employee</button>
          </div>);
        })()}

        {tab === 'business' && (<div>
          <SectionTitle icon="building" title="Business profile" sub="Identity for receipts, reports and the desk header." />
          <div className="flex items-center gap-4 mb-4 p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: CD.panel }}>
            <div className="grid place-items-center flex-none" style={{ width: 60, height: 60, borderRadius: 12, background: settings.logo ? 'transparent' : CD.lineSoft, overflow: 'hidden' }}>
              {settings.logo ? <img src={settings.logo} alt="logo" style={{ width: 60, height: 60, objectFit: 'contain' }} /> : <Ic n="building" s={24} c={CD.faint} />}
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium" style={{ color: CD.ink }}>Business logo</div>
              <div className="text-[11px] mb-2" style={{ color: CD.mute }}>Shown in the desk header and on receipts.</div>
              <div className="flex gap-2">
                <label className="text-xs px-2.5 py-1.5 cursor-pointer flex items-center gap-1.5" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 7 }}><Ic n="upload" s={12} c="var(--cd-on-ink)" /> Upload<input type="file" accept="image/*" className="hidden" onChange={e => e.target.files[0] && uploadLogo(e.target.files[0])} /></label>
                {settings.logo && <button onClick={() => set('logo', null, 'logo removed')} className="text-xs px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.mute }}>Remove</button>}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Legal business name"><Inp k="bizName" placeholder="York Foreign Exchange Inc." /></Field>
            <Field label="Operating / trade name"><Inp k="operatingName" placeholder="York Currency Exchange" /></Field>
            <Field label="FINTRAC MSB registration #" desc="Your money-services-business registration number."><Inp k="msbNumber" placeholder="M21-0000000" /></Field>
            <Field label="Desk name" desc="The desk shown under your branch in the header — e.g. Desk 1."><Inp k="deskName" placeholder="Desk 1" /></Field>
            <Field label="Phone"><Inp k="bizPhone" placeholder="(416) 555-0100" /></Field>
            <Field label="Email"><Inp k="bizEmail" placeholder="desk@business.com" /></Field>
            <Field label="Street address"><Inp k="bizAddress" placeholder="120 Adelaide St W" /></Field>
            <Field label="City"><Inp k="bizCity" placeholder="Toronto" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Region"><Inp k="bizRegion" placeholder="ON" /></Field>
              <Field label="Postal / ZIP"><Inp k="bizPostal" placeholder="M5H 1T1" /></Field>
            </div>
            <Field label="Country"><select value={settings.bizCountry || 'Canada'} onChange={e => set('bizCountry', e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inSty}>{COUNTRIES.map(c => <option key={c}>{c}</option>)}</select></Field>
          </div>
          {siteInfo && siteInfo.siteSlug && (() => {
            const siteUrl = window.location.origin + '/sites/' + siteInfo.siteSlug + '/';
            return (
              <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${CD.line}` }}>
                <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Your public site</div>
                <div className="text-[11px] mb-3" style={{ color: CD.mute, maxWidth: 560 }}>CurrencyDesk hosts your customer-facing website — rate board, converter and all — and it always shows whatever you publish from the desk.</div>
                <div className="flex items-center gap-2 mb-3 p-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.panel }}>
                  <span className="text-[11px] flex-none" style={{ color: CD.faint }}>Hosted at</span>
                  <a href={siteUrl} target="_blank" rel="noreferrer" className="text-[12.5px] font-semibold truncate" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{siteUrl.replace(/^https?:\/\//, '')}</a>
                  <span className="text-[10px] px-1.5 py-0.5 font-semibold flex-none ml-auto" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>LIVE</span>
                </div>
                <Field label="Your own domain" desc="When you're ready, point your domain's DNS (CNAME or ALIAS) at this server and add it in the hosting dashboard for HTTPS — the same site answers on it automatically. Clear the field to disconnect.">
                  <div className="flex items-center gap-2">
                    <input value={siteDraft} onChange={ev => setSiteDraft(ev.target.value)} placeholder="e.g. yorkfx.ca" className="flex-1 text-sm px-2.5 py-2 outline-none" style={{ ...inSty, fontFamily: 'Space Mono, monospace' }} />
                    <button onClick={saveSiteDomain} disabled={siteBusy} className="text-[12px] px-3 py-2 font-semibold flex-none" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8, opacity: siteBusy ? 0.5 : 1 }}>{(siteInfo.siteDomain || '') === siteDraft.trim().toLowerCase() ? 'Saved' : 'Save'}</button>
                  </div>
                </Field>
                {siteInfo.siteDomain && <div className="text-[11px] mt-1.5" style={{ color: CD.green }}>Connected: <b style={{ fontFamily: 'Space Mono, monospace' }}>{siteInfo.siteDomain}</b> serves your site the moment DNS points here.</div>}
                {siteMsg && <div className="text-[11px] mt-1.5" style={{ color: siteMsg.startsWith('Saved') || siteMsg.startsWith('Domain') ? CD.green : CD.flag }}>{siteMsg}</div>}
              </div>
            );
          })()}
          <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${CD.line}` }}>
            <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>FINTRAC reporting identity</div>
            <div className="text-[11px] mb-3" style={{ color: CD.mute }}>Set once per business when you enrol in the FINTRAC Web Reporting System (FWR). These pre-fill Section 1 of every LCTR / EFTR — the desk never asks for them again.</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Reporting entity number" desc="7-digit ID FINTRAC assigns on enrolment."><Inp k="reportingEntityNumber" placeholder="1234567" /></Field>
              <Field label="Reporting entity location #" desc="Branch / location ID from FWR."><Inp k="locationNumber" placeholder="00001" /></Field>
              <Field label="Activity sector"><select value={settings.activitySector || 'Money services business'} onChange={e => set('activitySector', e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inSty}>{['Money services business', 'Foreign exchange dealer', 'Remittance / funds transfer', 'Dealer in precious metals'].map(c => <option key={c}>{c}</option>)}</select></Field>
              <Field label="FINTRAC contact name" desc="Compliance contact; must match FWR."><Inp k="fintracContactName" placeholder="Compliance officer name" /></Field>
            </div>
          </div>
          <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${CD.line}` }}>
            <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Demo data</div>
            <div className="text-[11px] mb-3" style={{ color: CD.mute, maxWidth: 560 }}>The book, clients, cheques, transfers, till counts and settings all persist on this device — refreshing never resets them. Wiping back to the seeded demo book is a deliberate act, done here.</div>
            {!resetArm ? (
              <button onClick={() => setResetArm(true)} className="text-xs px-3 py-2" style={{ border: `1px solid ${CD.flag}`, borderRadius: 8, color: CD.flag, background: CD.panel, fontWeight: 600 }}>Reset demo data…</button>
            ) : (
              <div className="p-3.5" style={{ border: `1.5px solid ${CD.flag}`, borderRadius: 12, background: CD.flagSoft }}>
                <div className="text-[13px] font-semibold mb-1" style={{ color: CD.ink }}>Wipe this device and restore the demo book?</div>
                <div className="text-[11px] mb-3" style={{ color: CD.mute }}>Every transaction, client, cheque, transfer, till count, filing and setting stored on this device is erased and the seeded demo returns. This cannot be undone.</div>
                <div className="flex gap-2">
                  <button onClick={resetDemo} className="text-xs px-3 py-2" style={{ background: CD.flag, color: '#fff', borderRadius: 8, fontWeight: 700 }}>Erase &amp; reset</button>
                  <button onClick={() => setResetArm(false)} className="text-xs px-3 py-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute, background: CD.panel }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>)}

        {tab === 'locations' && (<div>
          <SectionTitle icon="wallet" title="Locations, tills & people" sub="Set up each branch, add its tills, then assign a staff member to each till. The header station switcher, the Till and the Branch Network all read this one list." />
          <div className="flex justify-end mb-2">
            <button onClick={() => setAddingLoc(true)} className="text-xs px-2.5 py-1.5 flex items-center gap-1.5" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 7 }} title="Enterprise · $699/mo per location"><Ic n="plus" s={12} c="var(--cd-on-ink)" /> Add location</button>
          </div>
          <div className="space-y-3">
            {(branches || []).map(b => (
              <div key={b.id} style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: CD.panel, overflow: 'hidden' }}>
                <div className="flex items-center gap-2 p-2.5" style={{ borderBottom: `1px solid ${CD.lineSoft}`, background: 'var(--cd-paper-soft)' }}>
                  <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, background: CD.lineSoft }}><Ic n="building" s={14} c={CD.ink} /></span>
                  <input value={b.name} onChange={e => setBranchF(b.id, { name: e.target.value })} className="text-sm font-medium px-2 py-1 outline-none" style={{ ...inSty, width: 168 }} />
                  <input value={b.code} onChange={e => setBranchF(b.id, { code: e.target.value })} className="text-[11px] px-2 py-1 outline-none" style={{ ...inSty, width: 84, fontFamily: 'Space Mono, monospace' }} />
                  <input value={b.city || ''} placeholder="City / address" onChange={e => setBranchF(b.id, { city: e.target.value })} className="text-[11px] px-2 py-1 outline-none flex-1 min-w-0" style={inSty} />
                  <button onClick={() => setBranchF(b.id, { status: b.status === 'open' ? 'closed' : 'open' })} className="text-[10.5px] px-2 py-1 flex-none" style={{ borderRadius: 6, border: `1px solid ${CD.line}`, color: b.status === 'open' ? CD.green : CD.faint }}>{b.status}</button>
                  <button onClick={() => removeBranchF(b.id)} title="Remove location" className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 6, color: CD.faint }}><Ic n="trash" s={14} /></button>
                </div>
                <div className="p-2.5 space-y-1.5">
                  {(b.tills || []).map(t => (
                    <div key={t.id} className="flex items-center gap-2 flex-wrap">
                      <Ic n="wallet" s={13} c={CD.mute} />
                      <input value={t.name} onChange={e => setTillF(b.id, t.id, { name: e.target.value })} className="text-[12px] px-2 py-1 outline-none" style={{ ...inSty, width: 150 }} />
                      <span className="text-[10.5px]" style={{ color: CD.faint }}>assigned to</span>
                      <select value={t.teller || ''} onChange={e => setTillF(b.id, t.id, { teller: e.target.value })} className="text-[12px] px-1.5 py-1 outline-none" style={inSty}>
                        <option value="">unassigned</option>
                        {STAFF.map(s => <option key={s.name} value={s.name}>{s.name} · {s.role}</option>)}
                      </select>
                      <button onClick={() => setTillF(b.id, t.id, { status: t.status === 'open' ? 'closed' : 'open' })} className="text-[10.5px] px-2 py-1" style={{ borderRadius: 6, border: `1px solid ${CD.line}`, color: t.status === 'open' ? CD.green : CD.faint }}>{t.status}</button>
                      <button onClick={() => removeTillF(b.id, t.id)} title="Remove till" className="grid place-items-center ml-auto" style={{ width: 26, height: 26, borderRadius: 6, color: CD.faint }}><Ic n="trash" s={13} /></button>
                    </div>
                  ))}
                  <button onClick={() => addTillF(b.id)} className="text-[11px] px-2.5 py-1.5 flex items-center gap-1.5 mt-1" style={{ border: `1px dashed ${CD.line}`, borderRadius: 7, color: CD.mute }}><Ic n="plus" s={12} /> Add till</button>
                </div>
              </div>
            ))}
            {!(branches && branches.length) && <div className="text-[12px] text-center py-8" style={{ color: CD.faint, border: `1px dashed ${CD.line}`, borderRadius: 12 }}>No locations yet — add your first.</div>}
          </div>
          <p className="mt-3 text-[11px]" style={{ color: CD.faint }}>One source of truth for your network. The <b>Branch Network</b> app uses this for daily cash movements; here is where you set it up — adding a location updates the plan ($699/mo each) and can fund the new sub-vault from the main vault.</p>
          {addingLoc && window.CDOS._stations && window.CDOS._stations.AddBranchModal && React.createElement(window.CDOS._stations.AddBranchModal, {
            branches: branches || [], employees: settings.employees || [], mainB: (branches || []).find(b => b.main) || (branches || [])[0],
            onClose: () => setAddingLoc(false),
            onCreate: ({ name, code, city, managerId, fund }) => {
              const id = 'b' + Date.now();
              const nb = { id, name, code, city, status: 'open', main: false, dealsToday: 0, volToday: 0, vault: { CAD: 0 }, tills: [{ id: id + 't1', name: 'Till 1', teller: '', operator: '', status: 'open', cash: { CAD: 0 } }] };
              let list = [...(branches || []), nb];
              const mainB = list.find(b => b.main);
              if (fund > 0 && mainB && setBranchMoves && window.CDOS._stations.applyMove) {
                const r = window.CDOS._stations.applyMove(list, branchMoves || [], { kind: 'vault', fromB: mainB.id, toB: id, ccy: 'CAD', amt: fund, fromLabel: mainB.code + ' · Vault', toLabel: code + ' · Vault' }, me.name);
                list = r.branches; setBranchMoves(r.moves); log(r.verb, r.detail);
              }
              setBranches(list);
              if (managerId) setSettings(s => ({ ...s, employees: (s.employees || []).map(e => e.id === managerId ? { ...e, branches: e.branches === '*' ? '*' : [...(Array.isArray(e.branches) ? e.branches : []), id], home: e.home || id } : e) }));
              log('Location added', `${name} · ${code} — plan now ${list.length} × $699/mo`);
              setAddingLoc(false);
            }
          })}
        </div>)}

        {tab === 'localization' && (<div>
          <SectionTitle icon="globe" title="Localization" sub="Make the desk work for your region — not just Canada." />
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Region</div>
          <Row title="Base currency" desc="Thresholds, drawer totals and reports are expressed in this currency. Changing it converts your thresholds at the live rate."><select value={base} onChange={e => { const nb = e.target.value; const ob = base; if (nb === ob) return; const conv = (v) => { const n = +v || 0; if (!n) return v; const cad = ob === 'CAD' ? n : n / (crossRate('CAD', ob) || 1); const out = nb === 'CAD' ? cad : cad * (crossRate('CAD', nb) || 1); return Math.round(out); }; setSettings(s => ({ ...s, baseCurrency: nb, threshold: conv(s.threshold), idRequiredOver: conv(s.idRequiredOver) })); log('Base currency changed', `${ob} → ${nb} · thresholds converted`); }} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 120 }}>{[...new Set(['CAD', 'USD', 'EUR', 'GBP', 'AUD', ...CURX])].map(c => <option key={c}>{c}</option>)}</select></Row>
          <Row title="Operating country / jurisdiction" desc="Where this desk operates — pick the country, then the state or province when one applies."><select value={settings.bizCountry || 'Canada'} onChange={e => setSettings(s => ({ ...s, bizCountry: e.target.value, bizRegion: '' }))} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 200 }}>{COUNTRIES.map(c => <option key={c}>{c}</option>)}</select></Row>
          {JURIS_REGIONS[settings.bizCountry || 'Canada'] && (() => { const jr = JURIS_REGIONS[settings.bizCountry || 'Canada']; return (
            <Row title={jr.label} desc={`The ${jr.label.toLowerCase()} your licence is held in — shown on reports and used for jurisdiction rules.`}><select value={settings.bizRegion || ''} onChange={e => set('bizRegion', e.target.value, `${jr.label} ${e.target.value}`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 240 }}><option value="">Select {jr.label.toLowerCase()}…</option>{jr.opts.map(o => <option key={o}>{o}</option>)}</select></Row>); })()}
          <Row title="Timezone"><select value={settings.timezone || 'America/Toronto'} onChange={e => set('timezone', e.target.value)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 220 }}>{TIMEZONES.map(t => <option key={t}>{t}</option>)}</select></Row>
          <div className="text-[10px] uppercase tracking-widest mb-1 mt-5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Formats</div>
          <Row title="Date format"><Seg value={settings.dateFormat || 'YYYY-MM-DD'} onPick={v => set('dateFormat', v, `date ${v}`)} opts={[['YYYY-MM-DD', 'YYYY-MM-DD'], ['DD/MM/YYYY', 'DD/MM/YYYY'], ['MM/DD/YYYY', 'MM/DD/YYYY']]} /></Row>
          <Row title="Time format" desc="How times read across the desk — e.g. the Audit Trail."><Seg value={settings.timeFormat || '12h'} onPick={v => set('timeFormat', v, `time ${v}`)} opts={[['12h', '12-hour'], ['24h', '24-hour']]} /></Row>
          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 9 }}><Ic n="alert" s={13} c="var(--cd-brass-text)" /><span>The live rate engine settles cash in CAD. Switching the base currency converts and relabels your thresholds and reported totals at the current mid-rate; live drawer counts stay in the currency held.</span></div>
        </div>)}

        {tab === 'compliance' && (() => {
          const REGIMES = (window.CDOS._compliance || {}).REGIMES || {};
          const activeRid = settings.regime || 'FINTRAC';
          const applyRegime = (id) => { const r = REGIMES[id]; if (!r) return; setSettings(s => ({ ...s, regime: id, threshold: r.threshold, baseCurrency: r.currency, idRequiredOver: r.idAt, aggHours: r.aggHours })); log('Jurisdiction pack applied', `${r.authority} · ${r.country}`); };
          const aggH = +settings.aggHours || (REGIMES[activeRid] ? REGIMES[activeRid].aggHours : 24);
          const isOwner = me.role === 'Owner';
          const recheckDays = +settings.recheckDays || 180;
          const reverifyDays = +settings.reverifyDays || 365;
          const escalateHighRisk = settings.escalateHighRisk !== false;
          // jurisdiction follows the operating country set in Localization (same logic).
          // Canada → FINTRAC only; US → FinCEN only; anything else falls back to all packs.
          const myCountry = settings.bizCountry || 'Canada';
          const matched = Object.values(REGIMES).filter(r => r.country === myCountry);
          const shownRegimes = matched.length ? matched : Object.values(REGIMES);
          const jv = window.CDOS.jurisdictionViolations ? window.CDOS.jurisdictionViolations(settings) : [];
          const jvF = (f) => jv.find(v => v.field === f);
          const jvNote = (f) => { const v = jvF(f); return v ? <div className="text-[11px] mb-2 flex items-center gap-1.5" style={{ color: CD.flag, marginTop: -2 }}><Ic n="alert" s={11} c={CD.flag} /> {v.detail}</div> : null; };
          return (<div>
          <SectionTitle icon="shield" title="Compliance & jurisdiction" sub="Set your regulator once — the whole rulebook auto-fills. Changing the pack is owner-only; the Compliance desk only reads it." />

          {/* one-click jurisdiction packs */}
          <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Your jurisdiction</div>
          <div className="grid gap-2.5 mb-2" style={{ gridTemplateColumns: shownRegimes.length > 1 ? 'repeat(2, 1fr)' : '1fr' }}>
            {shownRegimes.map(r => { const on = activeRid === r.id; return (
              <button key={r.id} onClick={() => isOwner && applyRegime(r.id)} className="text-left p-3" style={{ background: on ? 'var(--cd-chip)' : CD.panel, border: `1.5px solid ${on ? CD.ink : CD.line}`, borderRadius: 12, cursor: isOwner ? 'pointer' : 'default' }}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2"><span style={{ fontSize: 22 }}>{r.flag}</span><div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{r.authority}</div><div className="text-[11px]" style={{ color: CD.mute }}>{r.country}</div></div></div>
                  {on ? <span className="text-[9px] px-2 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999 }}><Ic n="check" s={10} c="var(--cd-on-ink)" /> ACTIVE</span> : <span className="text-[11px] px-2 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink }}>Use this</span>}
                </div>
                <div className="text-[11px]" style={{ color: CD.mute }}>{fmt(r.threshold, r.currency)} · {r.aggHours}h rule · {r.largeCode}/{r.wireCode}/{r.strCode} · {r.watchlists.join('/')}</div>
              </button>); })}
          </div>
          {!isOwner && <div className="text-[11px] mb-2 flex items-center gap-1.5 px-3 py-2" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 8 }}><Ic n="lock" s={12} c="var(--cd-brass-text)" /> Only the owner can change the jurisdiction pack — you can view it here.</div>}
          <div className="text-[11px] mb-5 flex items-start gap-1.5" style={{ color: CD.faint }}><Ic n="info" s={12} c={CD.faint} /><span>Your jurisdiction follows the operating country set in <b>Localization</b> — switching a pack rewrites the threshold, base currency, aggregation window and report codes below, which you can then tune by hand.</span></div>
          {jv.length > 0 && <div className="mb-5 flex items-start gap-2.5 px-3.5 py-3" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 11 }}><Ic n="alert" s={16} c={CD.flag} /><div className="min-w-0"><div className="text-[12.5px] font-semibold" style={{ color: CD.flag }}>{jv[0].authority} rules violated · {jv.length}</div><div className="text-[11px] mt-0.5" style={{ color: CD.flag }}>{jv.map(v => v.detail).join(' ')}</div><div className="text-[10.5px] mt-1.5" style={{ color: CD.mute }}>This stays flagged in the notification bell at the top of the app until every value is back within {jv[0].authority} limits.</div></div></div>}

          {/* ---- reporting & thresholds ---- */}
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Reporting & thresholds</div>
          <Row title="Large cash / reportable threshold" desc={`Deals at or above this (in ${base}) are reportable.`}><Money k="threshold" /></Row>
          {jvNote('threshold')}
          <Row title="Require ID over" desc="Your own ID policy — collect identification at or above this amount, ahead of the mandatory reportable line. Below it, a missing ID is just an amber note the teller acknowledges, not a compliance warning."><Money k="idRequiredOver" /></Row>
          <Row title="Aggregation window" desc="Same person, cash-in within this window is summed against the threshold — automatically."><Seg value={String(aggH)} onPick={v => set('aggHours', +v, `aggregation ${v}h`)} opts={[['24', '24h'], ['48', '48h'], ['72', '72h']]} /></Row>
          {jvNote('aggHours')}
          <Row title="24-hour window starts at" desc="The static daily cut the window is anchored to — aggregation runs start-to-start and this exact window is declared on every report.">{isOwner ? <input type="time" value={settings.aggWindowStart || '00:00'} onChange={e => set('aggWindowStart', e.target.value, `agg window ${e.target.value}`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 130 }} /> : <span className="text-[12px] px-2.5 py-1.5" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{settings.aggWindowStart || '00:00'}</span>}</Row>
          <Row title="Structuring watch window" desc="Longer window scanned for patterns of just-under-threshold deals."><select value={settings.structuringDays} onChange={e => set('structuringDays', +e.target.value, `structuring ${e.target.value}d`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 120 }}>{[1, 7, 14, 30].map(d => <option key={d} value={d}>{d} days</option>)}</select></Row>
          <Row title="Sanctions / watchlist screening" desc="Match every client & beneficiary against OFAC / UN / OSFI in the Compliance desk. Turning this off empties the Screening queue — most regulators expect it on."><Sw on={settings.screenSanctions !== false} click={() => set('screenSanctions', !(settings.screenSanctions !== false), `Sanctions screening · ${settings.screenSanctions !== false ? 'off' : 'on'}`)} /></Row>
          <Row title="Record retention"><select value={settings.retentionYears || 5} onChange={e => set('retentionYears', +e.target.value)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 120 }}>{[5, 7, 10].map(y => <option key={y} value={y}>{y} years</option>)}</select></Row>
          {jvNote('retentionYears')}

          {/* ---- identity verification policy — one engine, everywhere the nudge appears ---- */}
          <div className="mt-6 mb-5" style={{ border: `1.5px solid ${CD.ink}`, borderRadius: 14, background: 'var(--cd-chip)', padding: '16px 18px' }}>
            <div className="flex items-center gap-2 font-semibold mb-0.5" style={{ color: CD.ink }}><Ic n="id" s={16} /> Identity verification policy</div>
            <div className="text-[11px] mb-3" style={{ color: CD.mute, maxWidth: 520 }}>Drives the recommendation nudge on every client's file and inside New Transaction — the same engine, everywhere it appears.</div>

            <div className="p-3 mb-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11 }}>
              <CadenceLadder recheckDays={recheckDays} reverifyDays={reverifyDays} escalate={escalateHighRisk} />
            </div>

            <Row title="Suggest a quick re-screen after" desc="A dismissible Quick-check nudge appears once this many days have passed since the last screening."><select value={recheckDays} onChange={e => set('recheckDays', +e.target.value, `re-screen nudge ${e.target.value}d`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 140 }}>{[90, 180, 270, 365].map(d => <option key={d} value={d}>{d} days</option>)}</select></Row>
            <Row title="Require full re-verification after" desc="Past this many days — or sooner if the ID on file expires — the nudge becomes a hard stop until a full Verified check runs."><select value={reverifyDays} onChange={e => set('reverifyDays', +e.target.value, `re-verify required ${e.target.value}d`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 140 }}>{[180, 365, 545, 730].map(d => <option key={d} value={d}>{d} days</option>)}</select></Row>
            <Row title="Escalate high-risk clients to Verified Plus" desc="When a client is flagged high-risk, upgrade any recommended check to the deepest tier automatically."><Sw on={escalateHighRisk} click={() => toggleSet('escalateHighRisk', 'Escalate high-risk to Plus')} /></Row>
            <Row title="Mandatory check on large deals" desc={`Every deal at or above your reportable threshold (${fmt(+settings.threshold || 10000, base)}) requires this check before committing — even on a verified profile.`}><Seg value={settings.largeTxCheck || 'off'} onPick={v => set('largeTxCheck', v, `large-deal check ${v}`)} opts={[['off', 'Off'], ['quick', 'Quick · $3.99'], ['verify', 'Verified · $6.99'], ['plus', 'Verified Plus · $14.99']]} /></Row>
            <Row title="Require ID photo on file" desc="Contacts without a stored ID scan are flagged — in Clients · KYC and here."><Sw on={settings.requireIdPhoto} click={() => toggleSet('requireIdPhoto', 'Require ID photo')} /></Row>

            <details style={{ margin: '10px 0 0' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, color: CD.mute, listStyle: 'none', userSelect: 'none' }}>Have a partner authorization code?</summary>
              <div className="flex items-center gap-2 mt-2 p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: 'var(--cd-panel)' }}>
                <input defaultValue="" placeholder="e.g. YFX-XXXXXX" onKeyDown={e => { if (e.key === 'Enter') { const r = window.CDOS.KYC.applyPartnerCode(e.target.value); log(r.ok ? 'Partner rate activated' : 'Partner code rejected', r.ok ? (r.pct + '% applied to all checks') : e.target.value); } }} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 180, fontFamily: 'Space Mono, monospace' }} />
                {(() => { const rate = (window.CDOS.KYC && window.CDOS.KYC.getPartnerRate && window.CDOS.KYC.getPartnerRate()) || 0; return rate > 0 ? <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: CD.green }}><Ic n="checkcircle" s={13} c={CD.green} /> {Math.round(rate * 100)}% partner rate active</span> : null; })()}
              </div>
            </details>
          </div>

          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="shield" s={13} c={CD.mute} /><span>These rules drive the live flags in the Ledger, the verification nudge on every client &amp; counter, and the <b style={{ color: CD.ink }}>Compliance</b> desk — screening, 24-hour aggregation and fileable submissions all follow the active pack.</span></div>
        </div>); })()}

        {tab === 'rates' && (<div>
          <SectionTitle icon="coins" title="Rates & fees" sub="Two-sided pricing — the desk buys under mid and sells over mid. The gap is your margin." />

          <Row title="Rate feed provider" desc="Where the desk's live spot prices stream from. Shown on the Rate Board; your spreads & margins are applied on top."><div className="fp-set" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}><select value={settings.rateProvider || 'OANDA · fxTrade rates'} onChange={e => { set('rateProvider', e.target.value, `rate provider ${e.target.value}`); try { localStorage.setItem('yorkfx_rate_provider', e.target.value); } catch (_) {} }} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 230, appearance: 'none', WebkitAppearance: 'none', paddingRight: 28 }}>{['OANDA · fxTrade rates', 'XE Currency Data', 'Refinitiv (Reuters) FX', 'European Central Bank', 'Wise rates'].map(p => <option key={p} value={p}>{p}</option>)}</select><span style={{ position: 'absolute', right: 10, pointerEvents: 'none', color: CD.faint }}><Ic n="chev" s={13} c={CD.faint} /></span></div></Row>

          <Row title="Default spread" desc="Buy/sell margin over the spot rate, applied to any currency without its own spread below."><div className="flex items-center" style={inSty}><input type="number" step="0.1" value={settings.defaultSpread ?? ''} onChange={e => set('defaultSpread', +e.target.value)} className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: 90, fontVariantNumeric: 'tabular-nums' }} /><span className="px-2 text-[11px]" style={{ color: CD.mute }}>%</span></div></Row>
          <Row title="Default commission" desc="Suggested flat fee pre-filled on a new deal."><Money k="defaultFee" /></Row>

          {/* margin floor — protects the spread at the counter */}
          <div className="mt-5 mb-1 text-sm font-medium flex items-center gap-1.5" style={{ color: CD.ink }}><Ic n="activity" s={15} c={CD.ink} /> Margin floor</div>
          <div className="text-[11px] mb-1" style={{ color: CD.mute }}>The New Transaction screen shows a live margin meter (FX spread + fee as a % of pay-in). Set the healthy target and the floor below which a teller must override.</div>
          <Row title="Target margin" desc="At or above this, the meter reads green."><div className="flex items-center" style={inSty}><input type="number" step="0.1" value={settings.marginTargetPct ?? 1.0} onChange={e => set('marginTargetPct', +e.target.value, `margin target ${e.target.value}%`)} className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: 90, fontVariantNumeric: 'tabular-nums' }} /><span className="px-2 text-[11px]" style={{ color: CD.mute }}>%</span></div></Row>
          <Row title="Minimum floor" desc="Below this, the deal is flagged red."><div className="flex items-center" style={inSty}><input type="number" step="0.1" value={settings.marginFloorPct ?? 0.5} onChange={e => set('marginFloorPct', +e.target.value, `margin floor ${e.target.value}%`)} className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: 90, fontVariantNumeric: 'tabular-nums' }} /><span className="px-2 text-[11px]" style={{ color: CD.mute }}>%</span></div></Row>
          <Row title="Below the floor" desc="Warn lets the teller post anyway (logged); Require override blocks the post until they confirm with a reason."><Seg value={settings.marginEnforce || 'block'} onPick={v => set('marginEnforce', v, `margin enforce ${v}`)} opts={[['warn', 'Warn only'], ['block', 'Require override']]} /></Row>

          {/* per-currency spread — the heart of two-sided pricing */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <div><div className="text-sm font-medium" style={{ color: CD.ink }}>Spread by currency</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>Tight on liquid pairs, wider on exotics. Blank = use the default. We buy and sell are previewed live.</div></div>
            </div>
            <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, borderRadius: 10 }}>
              <table className="w-full text-sm border-collapse">
                <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
                  <th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">Spot · CAD</th><th className="px-3 py-2 text-right">Spread %</th><th className="px-3 py-2 text-right">We buy</th><th className="px-3 py-2 text-right">We sell</th>
                </tr></thead>
                <tbody>{(CCY || []).filter(c => c !== 'CAD').map(c => {
                  const spreads = settings.spreads || {};
                  const mid = crossRate(c, 'CAD');
                  const eff = (spreadOf(c, settings) * 100);
                  const custom = spreads[c] != null && spreads[c] !== '';
                  return (<tr key={c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                    <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}>{c}</td>
                    <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{mid.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center" style={{ border: `1px solid ${custom ? CD.ink : CD.line}`, borderRadius: 7, overflow: 'hidden' }}>
                        <input type="number" step="0.1" value={spreads[c] ?? ''} onChange={e => { const v = e.target.value; setSettings(s => ({ ...s, spreads: { ...(s.spreads || {}), [c]: v === '' ? '' : +v } })); }} placeholder={(+settings.defaultSpread || 1.5).toString()} className="text-sm px-2 py-1.5 outline-none text-right bg-transparent" style={{ width: 64, fontVariantNumeric: 'tabular-nums' }} />
                        <span className="px-1.5 text-[11px]" style={{ color: CD.faint }}>%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.flag }}>{buyUnitCad(c, settings).toFixed(4)}</td>
                    <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.green }}>{sellUnitCad(c, settings).toFixed(4)}</td>
                  </tr>); })}</tbody>
              </table>
            </div>
            <div className="text-[11px] mt-1.5 flex items-center gap-3" style={{ color: CD.faint }}>
              <span className="flex items-center gap-1"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.flag, display: 'inline-block' }}></span> We buy = what we pay the customer</span>
              <span className="flex items-center gap-1"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.green, display: 'inline-block' }}></span> We sell = what we charge</span>
            </div>
          </div>

          <div className="mt-5 mb-2 text-sm font-medium" style={{ color: CD.ink }}>Pay-out rounding</div>
          <Row title="Round the customer pay-out" desc="Cash desks rarely hand out odd cents. Applied to the amount the customer receives."><div className="flex items-center gap-2">
            <Seg value={settings.payoutRoundMode || 'nearest'} onPick={v => set('payoutRoundMode', v, `rounding ${v}`)} opts={[['down', 'Down'], ['nearest', 'Nearest'], ['up', 'Up']]} />
            <select value={settings.payoutRoundTo ?? 0.01} onChange={e => set('payoutRoundTo', +e.target.value)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 116 }}>
              {[['0.01', '0.01'], ['0.05', '0.05'], ['0.25', '0.25'], ['1', '1'], ['5', '5'], ['10', '10']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div></Row>
          <Row title="Rate-lock duration" desc="How long a customer quote holds the quoted rate before it must be re-priced."><select value={settings.rateLockMins || 15} onChange={e => set('rateLockMins', +e.target.value, `rate lock ${e.target.value}m`)} className="text-sm px-2.5 py-2 outline-none" style={{ ...inSty, width: 130 }}>{[5, 10, 15, 30, 60].map(m => <option key={m} value={m}>{m} minutes</option>)}</select></Row>

          <div className="mt-4 p-3 text-[11px] leading-relaxed flex items-start gap-2" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 9 }}><Ic n="coins" s={13} c={CD.mute} /><span>These prices drive every new deal in the Ledger — the spread booked at the counter is the spread that lands in <b style={{ color: CD.ink }}>Revenue &amp; Earnings</b>. Mid rates come from the <b style={{ color: CD.ink }}>Rate Board</b>.</span></div>
        </div>)}

        {tab === 'receipts' && (<div>
          <SectionTitle icon="receipt" title="Receipts" sub="What prints on the customer's exchange receipt." />
          <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Content</div>
          <div className="grid grid-cols-1 gap-3 mb-4">
            <Field label="Receipt header"><Inp k="receiptHeader" placeholder="York Currency Exchange" /></Field>
            <Field label="Footer line"><Inp k="receiptFooter" placeholder="Thank you — keep for your records" /></Field>
            <Field label="Disclaimer" desc="Small print at the bottom of every receipt."><textarea value={settings.receiptDisclaimer || ''} onChange={e => set('receiptDisclaimer', e.target.value)} rows={2} className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inSty, resize: 'vertical' }} placeholder="All sales final. Rates as quoted at time of transaction." /></Field>
          </div>
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Print</div>
          <Row title="Show logo on receipt"><Sw on={settings.showLogoOnReceipt} click={() => toggleSet('showLogoOnReceipt', 'Receipt logo')} /></Row>
          <Row title="Show MSB registration #"><Sw on={settings.showMsbOnReceipt} click={() => toggleSet('showMsbOnReceipt', 'Receipt MSB #')} /></Row>
        </div>)}

        {tab === 'permissions' && (() => {
          const PRESETS = {
            manager:  { canDelete: true,  canExport: true,  canViewReports: true,  canEditKYC: true,  canSettings: true,  canCloseDay: true },
            full:     { canDelete: true,  canExport: true,  canViewReports: true,  canEditKYC: true,  canSettings: false, canCloseDay: true },
            cashier:  { canDelete: false, canExport: false, canViewReports: false, canEditKYC: true,  canSettings: false, canCloseDay: false },
            trainee:  { canDelete: false, canExport: false, canViewReports: false, canEditKYC: false, canSettings: false, canCloseDay: false },
          };
          const matches = (p) => Object.keys(PRESETS[p]).every(k => !!perms.Teller[k] === PRESETS[p][k]);
          const activePreset = ['manager', 'full', 'cashier', 'trainee'].find(matches);
          const applyPreset = (p) => { setPerms(prev => ({ ...prev, Teller: { ...PRESETS[p] } })); log('Permission preset', `Teller · ${p}`); };
          const PMETA = [['cashier', 'Cashier', 'Process deals & KYC. No voids, reports or settings.'], ['full', 'Senior teller', 'Everything except settings.'], ['manager', 'Manager', 'Full access including settings.'], ['trainee', 'Trainee', 'Process deals only — locked down.']];
          return (<div>
          <SectionTitle icon="shield" title="Staff roles & permissions" sub="These apply to everyone who isn’t the Owner. Pick a role preset or fine-tune a capability — a change here applies to all tellers at once. Owner always has everything." />
          <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Quick presets</div>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {PMETA.map(([id, label, desc]) => { const on = activePreset === id; return (
              <button key={id} onClick={() => applyPreset(id)} className="text-left p-3" style={{ background: on ? 'var(--cd-chip)' : CD.panel, border: `1.5px solid ${on ? CD.ink : CD.line}`, borderRadius: 11 }}>
                <div className="flex items-center justify-between"><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{label}</span>{on && <span className="text-[9px] px-1.5 py-0.5 font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999 }}>SET</span>}</div>
                <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{desc}</div>
              </button>); })}
          </div>
          <div className="text-sm font-medium mb-1" style={{ color: CD.ink }}>Individual permissions</div>
          {CAPS.map(([k, label, desc]) => <Row key={k} title={label} desc={desc}><Sw on={perms.Teller[k]} click={() => togglePerm(k)} /></Row>)}
          <div className="text-sm font-medium mb-1 mt-5" style={{ color: CD.ink }}>Shift &amp; drawer handoff</div>
          <Row title="Require a drawer count at handoff" desc="When the till changes hands, force a count before the new person takes over. Off (typical for a single-operator shop) lets them hand off as-is with one tap — the handoff is still recorded either way."><Sw on={!!settings.requireCountOnHandoff} click={() => toggleSet('requireCountOnHandoff', 'Require count at handoff')} /></Row>
        </div>); })()}

        {tab === 'ticker' && (<div>
          <SectionTitle icon="bars" title="Ticker tape" sub="The scrolling rate strip in the desk header. Rates come from the Rate Board — these control how it looks." />
          <Row title="Scroll speed"><Seg value={tickerCfg.speed} onPick={v => setT({ speed: v }, `speed ${v}`)} opts={[['slow', 'Slow'], ['medium', 'Medium'], ['fast', 'Fast']]} /></Row>
          <Row title="Direction"><Seg value={tickerCfg.direction} onPick={v => setT({ direction: v }, `direction ${v}`)} opts={[['left', '← Left'], ['right', 'Right →']]} /></Row>
          <Row title="Price shown" desc="How each rate is quoted."><Seg value={tickerCfg.metric} onPick={v => setT({ metric: v }, `metric ${v}`)} opts={[['cadPerUnit', 'CAD / unit'], ['perCad', 'Per CAD']]} /></Row>
          <Row title="Show flags"><Sw on={tickerCfg.showFlags} click={() => setT({ showFlags: !tickerCfg.showFlags })} /></Row>
          <Row title="Show % change"><Sw on={tickerCfg.showChange} click={() => setT({ showChange: !tickerCfg.showChange })} /></Row>
          <div className="pt-4">
            <div className="flex items-center justify-between mb-2">
              <div><div className="text-sm" style={{ color: CD.ink }}>Currencies in ticker</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{FXC.length - hidden.length} of {FXC.length} shown.</div></div>
              <div className="flex gap-2">
                <button onClick={() => setT({ hidden: [] }, 'all currencies')} className="text-[11px] px-2 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, color: CD.mute }}>All</button>
                <button onClick={() => setT({ hidden: FXC.map(c => c.code) }, 'no currencies')} className="text-[11px] px-2 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, color: CD.mute }}>None</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FXC.map(c => { const on = !hidden.includes(c.code); return (
                <button key={c.code} onClick={() => toggleCcy(c.code)} className="flex items-center gap-1.5 px-2 py-1.5 text-xs" style={{ borderRadius: 7, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.faint, fontFamily: 'Space Mono, monospace', opacity: on ? 1 : 0.6 }}>
                  <span style={{ fontFamily: 'system-ui' }}>{c.flag}</span>{c.code}
                </button>); })}
            </div>
          </div>
        </div>)}

      </div>

      {importing && window.CDOS.LedgerImport && (
        <div className="fixed inset-0" style={{ zIndex: 70, background: 'var(--cd-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onMouseDown={() => setImporting(false)}>
          <div onMouseDown={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 880, height: '88%', background: CD.paper, borderRadius: 16, overflow: 'hidden', position: 'relative', boxShadow: '0 30px 80px -20px var(--cd-scrim)' }}>
            <button onClick={() => setImporting(false)} title="Close" className="grid place-items-center" style={{ position: 'absolute', top: 12, right: 12, zIndex: 3, width: 30, height: 30, borderRadius: 8, background: 'var(--cd-on-ink-soft)' }}><Ic n="x" s={18} c={CD.mute} /></button>
            <window.CDOS.LedgerImport rows={rows} setRows={setRows} clients={clients} setClients={setClients} settings={settings} me={me} log={log} onOpenLedger={() => { setImporting(false); onOpenLedger && onOpenLedger(); }} />
          </div>
        </div>
      )}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { SettingsView });
})();
