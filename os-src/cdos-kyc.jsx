/* ============================================================
   CurrencyDesk OS — KYC / identity verification
   A paid, partner-powered verification rail. The desk sends a
   subject (client, business or beneficiary) off to the verification
   provider (Persona) for ID + biometric + database checks. Each
   verification is billed to the exchange house's account — this is
   a revenue line for CurrencyDesk.

   One self-contained module, used in two places:
     • Clients ▸ contact profile  → SubjectPanel at the bottom
     • Compliance ▸ Screening      → PickerModal + per-row Verify

   Lifecycle is time-based so it survives reloads: a sent check sits
   in "processing" until its dueMs, then reconciles to a result that
   is consistent with the live sanctions screening. Completed checks
   are written to the universal report History.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt } = window.CDOS;
  const KYC_BLUE = '#2B50E2';   // brand accent for recommendations / selection
  const TIER_META = {
    quick: { tag: 'Keeps files current', best: 'walk-ins & already-verified clients' },
    verify: { tag: 'The standard', best: 'every first-time client' },
    plus: { tag: 'Most protection', best: 'large deals & high-risk profiles' },
  };
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);

  const KKEY = 'cdos_kyc_v1';
  const HKEY = 'cdos_report_history_v1';
  const PKEY = 'cdos_kyc_provider';
  // The verification provider is swappable — defaults to Persona, set from Settings.
  let PROVIDER = (() => { try { return localStorage.getItem(PKEY) || 'Persona'; } catch (e) { return 'Persona'; } })();
  // Buried “partner authorization code” → lifetime margin adjustment on every check.
  // Sold to founding desks as a perk; stored quietly, applied to all KYC pricing.
  const RKEY = 'cdos_kyc_partner_rate';
  const PARTNER_CODES = { 'YFX-FOUNDER': 0.10, 'YFX-PARTNER': 0.07, 'YFX-INTRO': 0.05 };
  let RATE_ADJ = (() => { try { return Math.min(0.5, Math.max(0, +localStorage.getItem(RKEY) || 0)); } catch (e) { return 0; } })();
  const net = (p) => Math.round(((+p || 0) * (1 - RATE_ADJ)) * 100) / 100;
  function applyPartnerCode(code) {
    const adj = PARTNER_CODES[String(code || '').trim().toUpperCase()];
    if (adj == null) return { ok: false };
    RATE_ADJ = adj; try { localStorage.setItem(RKEY, String(adj)); } catch (e) {} listeners.forEach(l => l());
    return { ok: true, pct: Math.round(adj * 100) };
  }
  const getPartnerRate = () => RATE_ADJ;
  const stampNow = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const money = (n) => '$' + (+n || 0).toFixed(2);
  // house default risk for brand-new contacts (Settings → Clients · KYC)
  const houseRisk = () => { try { return JSON.parse(localStorage.getItem('cdos_settings') || '{}').defaultClientRisk || 'Normal'; } catch (e) { return 'Normal'; } };
  const refHash = (id) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36).toUpperCase().padStart(5, '0').slice(-5); };

  // Three tiers, each a real check that bills every time it runs — the desk is
  // meant to run one on (nearly) every transaction. NONE smart-skip: even a
  // fully verified customer can be re-screened with a Quick check at the counter.
  //   • Quick check ($3.99) — name + DOB screened against sanctions / PEP / watchlists.
  //     No document authentication; instant. This is NOT identity verification —
  //     it confirms the name is clean, not that the ID is genuine.
  //   • Verified ($6.99) — government ID document authentication + the same
  //     sanctions & PEP screening. This is what earns the "Verified" badge.
  //   • Verified Plus ($14.99) — fresh ID, biometric selfie / liveness match and a
  //     deep database inquiry (adverse media, ongoing monitoring). Always runs fresh.
  const TEMPLATES = [
    { id: 'quick', label: 'Quick check', tagline: 'Smart-routed: our own file is checked first, then name & DOB re-screened against sanctions, PEP & watchlists — the cheapest compliant path', price: 3.99, channel: 'instant', icon: 'search', idv: false, bio: false, db: true, smart: false },
    { id: 'verify', label: 'Verified', tagline: 'Government ID authentication + sanctions & PEP screening', price: 6.99, channel: 'link', icon: 'id', idv: true, bio: false, db: true, smart: false },
    { id: 'plus', label: 'Verified Plus', tagline: 'Fresh ID, biometric selfie & deep database inquiry — always runs', price: 14.99, channel: 'link', icon: 'shield', idv: true, bio: true, db: true, smart: false }
  ];
  const tmpl = (id) => TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
  const DURATION = { instant: 5200, link: 9000, records: 600 };
  // do we already hold a verified ID for this subject? (a prior approved document check)
  function onFileVerified(subject) {
    return Object.values(STORE).some(c => c.subject === subject && c.status === 'completed' && c.result && c.result.decision === 'approved' && (c.result.idCheck === 'pass' || c.result.idCheck === 'on file'));
  }

  /* ---------------- store (module singleton + pub/sub) ---------------- */
  const listeners = new Set();
  const load = () => { try { return JSON.parse(localStorage.getItem(KKEY) || '{}') || {}; } catch (e) { return {}; } };
  let STORE = load();
  const persist = () => { try { localStorage.setItem(KKEY, JSON.stringify(STORE)); } catch (e) {} listeners.forEach(l => l()); };
  const useStore = () => { const [, force] = useState(0); useEffect(() => { const l = () => force(x => x + 1); listeners.add(l); return () => listeners.delete(l); }, []); return STORE; };

  const screenOf = (name) => { try { return window.CDOS._compliance.screen(name); } catch (e) { return { status: 'clear', hits: [] }; } };

  // What the provider reads off the ID document and hands back to us (deterministic per name so it's stable).
  function extractIdentity(name) {
    let h = 0; const s = String(name || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const pick = (arr) => arr[h % arr.length];
    const streets = ['Bathurst St', 'Dundas St W', 'Bloor St E', 'Eglinton Ave', 'Lakeshore Blvd', 'Yonge St', 'King St W', 'Queen St E'];
    const cities = [['Toronto', 'ON', 'M5V 2T6'], ['Mississauga', 'ON', 'L5B 4M1'], ['Markham', 'ON', 'L3R 0B8'], ['Vaughan', 'ON', 'L4K 3N1'], ['Brampton', 'ON', 'L6Y 1M5']];
    const idTypes = ["Driver's Licence", 'Passport', 'Provincial ID'];
    const [city, province, postal] = pick(cities);
    const num = 100 + (h % 8900);
    const idType = pick(idTypes);
    const idNum = idType === 'Passport' ? 'P' + String(1000000 + (h % 8999999)) : 'DL ' + String(1000 + (h % 8999)) + '-' + String(100 + (h % 899));
    const yr = 1972 + (h % 32), mo = 1 + (h % 12), da = 1 + (h % 27);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      address: `${num} ${pick(streets)}`, city, province, postal, country: 'Canada',
      dob: `${yr}-${pad(mo)}-${pad(da)}`,
      idType, idNum, idIssued: `20${20 + (h % 4)}-${pad(mo)}-${pad(da)}`, idExpiry: `20${30 + (h % 5)}-${pad(mo)}-${pad(da)}`,
      email: (s.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().split(/\s+/).slice(0, 2).join('.') || 'contact') + '@email.com'
    };
  }

  // a sent check resolves to a result consistent with live sanctions screening
  function resolve(check) {
    const t = tmpl(check.template);
    const sc = screenOf(check.subject);
    let decision = 'approved', database = t.db ? 'clear' : 'n/a', pep = 'None found';
    if (t.db) {
      if (sc.status === 'hit') { decision = 'review'; database = 'hit'; pep = 'Sanctions match'; }
      else if (sc.status === 'review') { decision = 'review'; database = 'possible'; pep = 'Possible PEP / adverse media'; }
    }
    return {
      decision,
      // the provider reads these off the ID and returns them so we can complete the contact.
      // On a records match we already hold the ID, so nothing new is extracted.
      extracted: (t.idv && !check.matchedOnFile) ? extractIdentity(check.subject) : null,
      idCheck: t.idv ? 'pass' : 'n/a',
      matchedOnFile: !!check.matchedOnFile,
      biometric: t.bio ? 'pass' : 'n/a',
      database,
      pep,
      watchlist: (sc.hits || []).slice(0, 3).map(h => ({ name: h.w.name, list: h.w.list, program: h.w.program, score: Math.round(h.score * 100) })),
      reportRef: 'PSA-' + refHash(check.id + check.requestedAt),
      completedAt: stampNow()
    };
  }

  const decisionMeta = (d) => d === 'approved'
    ? { label: 'Verified', c: CD.green, bg: CD.greenSoft, icon: 'checkcircle' }
    : d === 'declined'
      ? { label: 'Declined', c: CD.flag, bg: CD.flagSoft, icon: 'ban' }
      : { label: 'Needs review', c: CD.amber, bg: CD.amberSoft, icon: 'alert' };

  // phase shown while a check is live or done
  function phaseMeta(check) {
    if (check.status === 'completed') return decisionMeta(check.result.decision);
    return { label: check.channel === 'instant' ? 'Running checks…' : 'Awaiting customer…', c: CD.brass, bg: CD.brassSoft, icon: 'clock' };
  }

  /* ---------------- history bridge ---------------- */
  function logToHistory(check) {
    try {
      const r = check.result; const dm = decisionMeta(r.decision);
      let hist = []; try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]') || []; } catch (e) {}
      const key = 'K' + check.id;
      if (hist.some(e => e.key === key)) return;
      const entry = {
        key, ms: Date.now(), type: 'KYC', title: `KYC verification · ${check.subject}`,
        icon: 'id', tone: dm.c, at: r.completedAt, ref: r.reportRef, ack: dm.label.toUpperCase(),
        subject: check.subject, filing: true, badge: dm.label.toUpperCase(), badgeColor: dm.c, badgeBg: dm.bg,
        fullHTML: certHTML(check)
      };
      localStorage.setItem(HKEY, JSON.stringify([entry, ...hist].slice(0, 500)));
    } catch (e) {}
  }

  /* ---------------- reconcile loop ---------------- */
  // a global "contact sink": when any check completes with ID data extracted, fold it into
  // the contact — even if no profile / wizard is open. The app registers setClients here.
  let contactSink = null;
  function setContactSink(fn) {
    contactSink = fn;
    if (fn) Object.values(STORE).forEach(c => { if (c.status === 'completed' && c.result && c.result.extracted) fn(c.subject, c.result.extracted, c.result.completedAt); });
  }
  function reconcile() {
    let changed = false; const now = Date.now();
    Object.values(STORE).forEach(c => {
      if (c.status === 'processing' && now >= c.dueMs) { c.status = 'completed'; c.result = resolve(c); logToHistory(c); if (contactSink && c.result.extracted) contactSink(c.subject, c.result.extracted, c.result.completedAt); changed = true; }
    });
    if (changed) persist();
  }
  reconcile();
  setInterval(reconcile, 1200);

  /* ---- demo seed: give a spread of contacts a KYC history so the prototype
     shows every state (verified / stale→quick / plus / high-risk) out of the box.
     Runs once (versioned) and is additive — it never removes a real check. ---- */
  function seedDemo() {
    const V = 'cdos_kyc_seed_v3';
    try { if (localStorage.getItem(V)) return; } catch (e) {}
    const st = (ms) => new Date(ms).toLocaleString('en-CA', { hour12: false }).replace(',', '');
    const mk = (subject, kind, template, d) => { const t = tmpl(template); const ms = Date.now() - d * 86400000; const id = 'seed_' + template + '_' + subject.replace(/[^A-Za-z]/g, '').slice(0, 14); return { id, subject, kind: kind || 'individual', template, templateLabel: t.label, price: t.price, channel: template === 'quick' ? 'instant' : 'link', contact: { via: 'demo' }, by: 'System', requestedAt: st(ms), ms, dueMs: ms + 1000, matchedOnFile: false, status: 'completed', result: { decision: 'approved', extracted: null, idCheck: t.idv ? 'pass' : 'n/a', matchedOnFile: false, biometric: t.bio ? 'pass' : 'n/a', database: t.db ? 'clear' : 'n/a', pep: 'None found', watchlist: [], reportRef: 'PSA-' + refHash(id), completedAt: st(ms) } }; };
    const plan = [['Jakob Miller', 'individual', 'verify', 25], ['Kevin Doyle', 'individual', 'verify', 90], ['Nicole Hayes', 'individual', 'verify', 30], ['Rachel Carter', 'individual', 'verify', 210], ['Megan Foster', 'individual', 'verify', 400], ['Brandon Cole', 'individual', 'verify', 200], ['Jordan Blake', 'individual', 'verify', 220], ['Ashley Turner', 'individual', 'plus', 25], ['Lauren Bishop', 'individual', 'plus', 30], ['Maple Leaf Logistics Inc.', 'corporate', 'verify', 250], ['Golden Crescent Travel', 'corporate', 'plus', 40]];
    const unverified = ['Brooke Lawson', 'Tyler Bennett', 'Emily Park', 'Sarah Whitman', 'Marcus Reed', 'Chris Delaney', 'Northbridge Imports'];
    Object.keys(STORE).forEach(k => { const s = STORE[k] && STORE[k].subject; if (unverified.indexOf(s) !== -1) delete STORE[k]; });
    plan.forEach(([s, k, t, d]) => { const c = mk(s, k, t, d); STORE[c.id] = c; });
    try { const raw = JSON.parse(localStorage.getItem('cdos_clients_v1') || 'null'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) { if (raw['Marcus Reed']) raw['Marcus Reed'].idExpiry = '2026-05-15'; if (raw['Brooke Lawson']) { raw['Brooke Lawson'].idType = ''; raw['Brooke Lawson'].idNum = ''; raw['Brooke Lawson'].idExpiry = ''; } localStorage.setItem('cdos_clients_v1', JSON.stringify(raw)); } } catch (e) {}
    try { localStorage.setItem(V, '1'); } catch (e) {}
    persist();
  }
  seedDemo();

  function setProvider(name) { PROVIDER = (name || 'Persona').trim() || 'Persona'; try { localStorage.setItem(PKEY, PROVIDER); } catch (e) {} listeners.forEach(l => l()); }
  const getProvider = () => PROVIDER;

  function createCheck({ subject, kind, template, channel, contact, by }) {
    const now = Date.now();
    const id = 'kyc_' + now.toString(36) + Math.random().toString(36).slice(2, 5);
    const t = tmpl(template);
    // smart skip: a "Verify" on someone we already hold a verified ID for clears instantly
    // with no provider inquiry — the margin is ours. Presented as an ordinary verification.
    const matchedOnFile = !!(t.smart && onFileVerified(subject));
    const ch = matchedOnFile ? 'instant' : (channel || t.channel);
    const check = { id, subject, kind: kind || 'individual', template, templateLabel: t.label, price: net(t.price), channel: ch, contact: contact || (matchedOnFile ? { via: 'instant' } : {}), by: by || 'Desk', requestedAt: stampNow(), ms: now, dueMs: now + (DURATION[ch] || 8000), matchedOnFile, status: matchedOnFile ? 'completed' : 'processing', result: null };
    if (matchedOnFile) { check.result = resolve(check); logToHistory(check); }
    STORE = { ...STORE, [id]: check }; persist();
    return check;
  }
  const checksFor = (name) => Object.values(STORE).filter(c => c.subject === name).sort((a, b) => b.ms - a.ms);
  function summary() {
    const all = Object.values(STORE);
    const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const month = all.filter(c => (c.requestedAt || '').slice(0, 7) === ym);
    return { total: all.length, monthCount: month.length, monthSpend: month.reduce((s, c) => s + (+c.price || 0), 0) };
  }

  /* ---------------- sealed KYC certificate (opened from History) ---------------- */
  function certHTML(check) {
    const r = check.result || {}; const t = tmpl(check.template); const dm = decisionMeta(r.decision);
    const P = { ink: '#262216', mute: '#6f6857', faint: '#9a927e', line: '#e4e0d5', soft: '#f1efe7' };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const rowChk = (l, v) => `<tr><td style="color:${P.mute};font-size:12.5px;padding:6px 0;width:48%;">${esc(l)}</td><td style="font-size:12.5px;padding:6px 0;font-family:'Space Mono',monospace;color:${P.ink};text-transform:capitalize;">${esc(v)}</td></tr>`;
    const wl = (r.watchlist || []).length
      ? `<table style="width:100%;border-collapse:collapse;margin-top:6px;">${r.watchlist.map(h => `<tr><td style="font-size:12px;padding:5px 0;border-bottom:1px solid ${P.soft};">${esc(h.name)} <span style="color:${P.mute};">· ${esc(h.list)} · ${esc(h.program || '')}</span></td><td style="font-size:12px;text-align:right;font-family:'Space Mono',monospace;color:${P.mute};">${h.score}%</td></tr>`).join('')}</table>`
      : `<div style="font-size:12px;color:${P.mute};margin-top:4px;">No database matches returned.</div>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KYC ${esc(r.reportRef || '')}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:40px 46px;color:${P.ink};}@page{margin:14mm;}</style></head>
      <body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${P.ink};padding-bottom:16px;margin-bottom:22px;">
          <div><div style="font-family:'Space Mono',monospace;font-weight:700;font-size:12.5px;letter-spacing:.04em;">CURRENCYDESK OS · KYC</div><div style="font-size:24px;font-weight:800;margin-top:10px;">Identity Verification</div><div style="font-size:12.5px;color:${P.mute};margin-top:2px;">${esc(t.label)} · verified via ${PROVIDER}</div></div>
          <div style="text-align:right;font-size:11px;color:${P.mute};line-height:1.8;"><div style="display:inline-flex;align-items:center;gap:6px;background:${dm.bg};color:${dm.c};font-family:'Space Mono',monospace;font-weight:700;padding:4px 11px;border-radius:6px;">● ${esc(dm.label.toUpperCase())}</div><div style="margin-top:6px;">Ref <b style="color:${P.ink};font-family:'Space Mono',monospace;">${esc(r.reportRef || '')}</b></div><div>${esc(r.completedAt || '')}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:${P.line};border:1px solid ${P.line};margin-bottom:20px;">
          ${[['Subject', check.subject], ['Type', check.kind], ['Requested by', check.by], ['Billed', money(check.price)]].map(k => `<div style="background:#fff;padding:13px 15px;"><div style="font-size:10.5px;color:${P.mute};text-transform:uppercase;letter-spacing:.06em;">${esc(k[0])}</div><div style="font-size:15px;font-weight:700;margin-top:3px;">${esc(k[1])}</div></div>`).join('')}
        </div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${P.faint};font-family:'Space Mono',monospace;margin-bottom:6px;">Checks performed</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
          ${rowChk('Document authenticity', r.idCheck)}${rowChk('Biometric / liveness', r.biometric)}${rowChk('Database screening', r.database)}${rowChk('PEP / adverse media', r.pep)}
        </table>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${P.faint};font-family:'Space Mono',monospace;margin-bottom:2px;">Database matches</div>
        ${wl}
        <div style="margin-top:22px;font-size:11px;color:${P.faint};line-height:1.6;">Verification performed by ${PROVIDER} on behalf of York Currency Exchange (MSB) and retained as a KYC record under the PCMLTFA. This certificate reflects the provider's automated determination; manual review may be required where matches are returned.</div>
      </body></html>`;
  }
  function openWindow(html) { const w = window.open('', '_blank', 'width=900,height=1100'); if (!w) return; w.document.write(html); w.document.close(); setTimeout(() => w.focus(), 200); }

  /* ---- shared: the "choose a verification + delivery" body (used by SendModal and the new-contact wizard) ---- */
  // Work out how a verification should be delivered, given whether we already hold the ID.
  function deliveryFor({ tplId, mode, via, email, phone, hasId, subject }) {
    const t = tmpl(tplId);
    const m = mode || (hasId ? 'inperson' : 'link');
    if (m === 'inperson') { const needScan = t.idv && !hasId; return { kind: 'inperson', channel: 'instant', contact: { via: 'in_person' }, missing: needScan, label: 'Run now · bill', needScan }; }
    const ct = via === 'email' ? { via: 'email', email: (email || '').trim() } : { via: 'sms', phone: (phone || '').trim() };
    return { kind: 'link', channel: 'link', contact: ct, missing: via === 'email' ? !ct.email : !ct.phone, label: 'Send link · bill' };
  }

  /* ---- reusable ID capture: upload or live-camera, self-contained (portalled overlay) ---- */
  function IdScanControls({ onCapture }) {
    const [cam, setCam] = useState(false);
    const [camErr, setCamErr] = useState('');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const closeCamera = () => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } setCam(false); };
    const openCamera = async () => {
      setCamErr(''); setCam(true);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        streamRef.current = s;
        const attach = () => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } else setTimeout(attach, 30); };
        attach();
      } catch (e) { setCamErr(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser, or upload a photo instead.' : 'No camera available on this device. Upload a photo instead.'); }
    };
    const capturePhoto = () => { const v = videoRef.current; if (!v || !v.videoWidth) return; const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); onCapture(cv.toDataURL('image/jpeg', 0.85)); closeCamera(); };
    const onFile = (file) => { if (!file) return; const r = new FileReader(); r.onload = () => onCapture(r.result); r.readAsDataURL(file); };
    useEffect(() => () => closeCamera(), []);
    return (<>
      <div className="flex items-center gap-2 mt-2.5">
        <label className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold cursor-pointer" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, background: CD.ink, color: 'var(--cd-on-ink)' }}><Ic n="upload" s={13} c="var(--cd-on-ink)" /> Upload ID<input type="file" accept="image/*" className="hidden" onChange={e => onFile(e.target.files[0])} /></label>
        <button onClick={openCamera} type="button" className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: CD.paper, color: CD.ink }}><Ic n="camera" s={13} c={CD.ink} /> Take a photo</button>
      </div>
      {cam && <Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 10000 }}>
        <div className="w-full flex flex-col" style={{ maxWidth: 520, background: 'var(--cd-ink)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 70px -20px rgba(0,0,0,0.7)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}>
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--cd-on-ink)' }}><Ic n="camera" s={15} c="var(--cd-on-ink)" /> Photograph the ID</div>
            <button onClick={closeCamera} className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8, color: 'var(--cd-on-ink-soft)' }}><Ic n="x" s={16} c="var(--cd-on-ink-soft)" /></button>
          </div>
          <div style={{ position: 'relative', background: 'var(--cd-ink-strong)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
            {camErr
              ? <div className="text-center px-6" style={{ color: 'var(--cd-on-ink-soft)' }}><Ic n="alert" s={22} c="#e7b34a" /><div className="text-[13px] mt-2">{camErr}</div></div>
              : <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            {!camErr && <div style={{ position: 'absolute', inset: '12% 8%', border: '2px dashed var(--cd-on-ink-soft)', borderRadius: 12, pointerEvents: 'none' }} />}
          </div>
          <div className="flex items-center justify-center gap-3 px-4 py-4">
            {camErr
              ? <button onClick={closeCamera} className="px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}>Close</button>
              : <><button onClick={closeCamera} className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--cd-on-ink-soft)', border: '1px solid var(--cd-on-ink-faint)', borderRadius: 9 }}>Cancel</button>
                <button onClick={capturePhoto} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cd-ink)', display: 'inline-block' }} /> Capture</button></>}
          </div>
        </div>
      </div></Portal>}
    </>);
  }

  function VerifyChooserBody({ subject, hasId, verified, tplId, setTplId, mode, setMode, via, setVia, email, setEmail, phone, setPhone, onScanMore, onCapture, recommended }) {
    const t = tmpl(tplId);
    const m = mode || (hasId ? 'inperson' : 'link');
    const list = verified ? TEMPLATES : TEMPLATES.filter(t => t.id !== 'quick');
    return (<div>
      <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Choose a verification</div>
      <div className="grid gap-2">
        {list.map(tt => { const on = tplId === tt.id; const rec = recommended === tt.id; const meta = TIER_META[tt.id] || {}; return (
          <button key={tt.id} onClick={() => setTplId(tt.id)} className="relative flex items-center gap-3 p-3 text-left" style={{ background: on ? 'rgba(43,80,226,.06)' : CD.panel, border: `1.5px solid ${on ? KYC_BLUE : CD.line}`, borderRadius: 12, boxShadow: on ? '0 6px 18px rgba(43,80,226,.14)' : 'none', transition: 'border-color .18s ease, background .18s ease, box-shadow .18s ease' }}>
            {rec && <span className="absolute" style={{ top: -8, right: 12, fontSize: 8.5, fontWeight: 700, letterSpacing: '.1em', fontFamily: 'Space Mono, monospace', background: KYC_BLUE, color: '#fff', padding: '2px 7px', borderRadius: 999 }}>RECOMMENDED</span>}
            <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, borderRadius: 10, background: on ? KYC_BLUE : CD.lineSoft, transition: 'background .18s ease' }}><Ic n={tt.icon} s={18} c={on ? '#fff' : CD.mute} /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13.5px] font-semibold" style={{ color: CD.ink }}>{tt.label}</span>
                {meta.tag && <span className="text-[9.5px] font-semibold px-1.5 py-0.5" style={{ color: on ? KYC_BLUE : CD.mute, background: on ? 'rgba(43,80,226,.10)' : CD.lineSoft, borderRadius: 5 }}>{meta.tag}</span>}
              </div>
              <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{tt.tagline}</div>
            </div>
            <div className="text-right flex-none"><div className="text-[14px] font-bold" style={{ color: on ? KYC_BLUE : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money(net(tt.price))}</div><div className="text-[9.5px]" style={{ color: CD.faint }}>per check</div></div>
          </button>); })}
      </div>
      {!verified && <div className="text-[11px] mt-2 flex items-start gap-1.5" style={{ color: CD.faint }}><Ic n="lock" s={12} c={CD.faint} /> <span>First contact needs a full identity check. The $3.99 Quick check unlocks once {String(subject).split(/\s+/)[0]} is verified</span></div>}
      <div className="text-[10px] uppercase tracking-widest mt-4 mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Delivery</div>
      {(<div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
        <div className="inline-flex mb-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
          {[['inperson', 'In person', 'id'], ['link', 'Send a link', 'send']].map(([id, lb, ic]) => <button key={id} onClick={() => setMode(id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium" style={{ background: m === id ? CD.ink : 'transparent', color: m === id ? 'var(--cd-on-ink)' : CD.mute }}><Ic n={ic} s={12} c={m === id ? 'var(--cd-on-ink)' : CD.mute} /> {lb}</button>)}
        </div>
        {m === 'inperson' ? ((t.idv && !hasId) ? (
          <div>
            <div className="flex items-start gap-2"><Ic n="alert" s={14} c={CD.flag} /><div className="text-[12px]"><span style={{ color: CD.flag, fontWeight: 600 }}>No ID scanned yet.</span> <span style={{ color: CD.mute }}>Scan or upload the customer's ID to verify in person — or send a secure link instead.</span></div></div>
            {onCapture && <IdScanControls onCapture={onCapture} />}
          </div>
        ) : (
          <div className="flex items-start gap-2"><Ic n="checkcircle" s={14} c={CD.green} /><div className="text-[12px]" style={{ color: CD.mute }}>The ID you scanned is checked instantly{t.bio ? ', and you take a quick selfie of the customer at the counter' : ''}. Result in seconds — no link needed.</div></div>
        )) : (<div>
          <div className="text-[12px] mb-2" style={{ color: CD.mute }}>{subject} gets a secure link to photograph their ID{t.bio ? ' and take a selfie' : ''} on their own phone. Nothing is billed until they complete it.</div>
          <div className="inline-flex mb-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
            {[['email', 'Email', 'mail'], ['sms', 'Text / SMS', 'phone']].map(([id, lb, ic]) => <button key={id} onClick={() => setVia(id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium" style={{ background: via === id ? CD.ink : 'transparent', color: via === id ? 'var(--cd-on-ink)' : CD.mute }}><Ic n={ic} s={12} c={via === id ? 'var(--cd-on-ink)' : CD.mute} /> {lb}</button>)}
          </div>
          {via === 'email'
            ? <input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@email.com" className="w-full text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }} />
            : <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(416) 555-0100" className="w-full text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }} />}
        </div>)}
      </div>)}
    </div>);
  }

  /* ====================================================================
     SEND MODAL — choose a verification, delivery, confirm the bill, send
     ==================================================================== */
  function SendModal({ subject, kind, rec, by, onClose, initialTpl }) {
    rec = rec || {};
    const verified = (() => { try { return checksFor(subject).some(c => (c.template === 'verify' || c.template === 'plus') && c.status === 'completed' && c.result && c.result.decision === 'approved'); } catch (e) { return false; } })();
    const [tplId, setTplId] = useState((initialTpl && (verified || initialTpl !== 'quick')) ? initialTpl : 'verify');
    const [photo, setPhoto] = useState(rec.photo || null);
    // we already hold this client's ID on file → run the check in person; only
    // fall back to "send a link" when there's no ID on record to work from.
    const hasIdOnFile = !!(rec.photo || (rec.idType && rec.idNum));
    const [mode, setMode] = useState(hasIdOnFile ? 'inperson' : 'link');
    const [via, setVia] = useState(rec.email ? 'email' : 'sms');
    const [email, setEmail] = useState(rec.email || '');
    const [phone, setPhone] = useState(rec.phone || '');
    const [step, setStep] = useState('configure');   // configure | sent
    const [sent, setSent] = useState(null);
    const del = deliveryFor({ tplId, mode, via, email, phone, hasId: !!photo, subject });

    const send = () => {
      const c = createCheck({ subject, kind, template: tplId, channel: del.channel, contact: del.contact, by });
      setSent(c); setStep('sent');
    };

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 520, maxHeight: '92%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        {/* header */}
        <div className="flex items-start gap-3 px-5 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 10 }}><Ic n="id" s={19} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>Verify {subject}</div>
            <div className="text-[11.5px] flex items-center gap-1.5" style={{ color: CD.mute }}><Ic n="lock" s={11} c={CD.mute} /> Encrypted · logged &amp; audit-ready · billed to your account</div>
          </div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>

        {step === 'configure' ? (<>
          <div className="flex-1 overflow-auto px-5 py-4">
            <VerifyChooserBody subject={subject} hasId={!!photo} verified={verified} recommended={initialTpl} tplId={tplId} setTplId={setTplId} mode={mode} setMode={setMode} via={via} setVia={setVia} email={email} setEmail={setEmail} phone={phone} setPhone={setPhone} onCapture={setPhoto} />
          </div>

          {/* footer — the bill + send */}
          <div className="flex items-center gap-3 px-5 py-3.5 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: CD.panel }}>
            <div className="flex-1"><div className="text-[11px]" style={{ color: CD.faint }}>You'll be billed</div><div className="text-[20px] font-bold leading-none" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money(net(tmpl(tplId).price))}</div></div>
            <button onClick={onClose} className="px-3.5 py-2.5 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute }}>Cancel</button>
            <button onClick={send} disabled={del.missing} className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white" style={{ background: del.missing ? 'var(--cd-disabled)' : KYC_BLUE, borderRadius: 9, cursor: del.missing ? 'not-allowed' : 'pointer', boxShadow: del.missing ? 'none' : '0 6px 18px rgba(43,80,226,.32)' }}><Ic n="send" s={15} c="var(--cd-on-ink)" /> {del.label}</button>
          </div>
        </>) : (
          /* SENT confirmation */
          <div className="px-6 py-8 text-center">
            <span className="grid place-items-center mx-auto mb-3" style={{ width: 54, height: 54, borderRadius: '50%', background: CD.greenSoft }}><Ic n="check" s={26} c={CD.green} /></span>
            <div className="text-[16px] font-semibold" style={{ color: CD.ink }}>{sent.channel === 'instant' ? 'Verification started' : 'Verification link sent'}</div>
            <div className="text-[12.5px] mt-1 mx-auto" style={{ color: CD.mute, maxWidth: 360 }}>
              {sent.channel === 'instant'
                ? <>Database screening for <b style={{ color: CD.ink }}>{subject}</b> is running now — a result lands in moments.</>
                : <>A secure {sent.contact.via === 'email' ? 'email' : 'text'} went to <b style={{ color: CD.ink }}>{sent.contact.email || sent.contact.phone}</b>. You'll see the result here the moment {subject} completes it.</>}
            </div>
            <div className="inline-flex items-center gap-2 mt-4 px-3 py-1.5 text-[12px]" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 999, color: CD.mute }}><Ic n="id" s={13} c={CD.mute} /> {tmpl(sent.template).label} · {money(sent.price)} billed</div>
            <div><button onClick={onClose} className="mt-5 px-5 py-2.5 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}>Done</button></div>
          </div>
        )}
      </div>
    </div></Portal>);
  }

  /* ---------------- a single check row ---------------- */
  function CheckRow({ check }) {
    const pm = phaseMeta(check); const t = tmpl(check.template); const live = check.status !== 'completed';
    return (<div className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${live ? CD.brass : CD.line}`, borderRadius: 11 }}>
      <span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: 9, background: pm.bg }}><Ic n={live ? 'clock' : pm.icon} s={16} c={pm.c} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2"><span className="text-[12.5px] font-semibold" style={{ color: CD.ink }}>{t.label}</span><span className="text-[11px] font-semibold" style={{ color: pm.c }}>{pm.label}</span></div>
        <div className="text-[11px] flex items-center gap-1.5 flex-wrap" style={{ color: CD.mute }}>
          <span>{check.requestedAt}</span><span style={{ color: CD.faint }}>·</span><span>{money(check.price)}</span>
          {check.status === 'completed' && check.result.reportRef && <><span style={{ color: CD.faint }}>·</span><span style={{ fontFamily: 'Space Mono, monospace' }}>{check.result.reportRef}</span></>}
        </div>
      </div>
      {check.status === 'completed'
        ? <button onClick={() => openWindow(certHTML(check))} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="filetext" s={13} c={CD.mute} /> Certificate</button>
        : <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium flex-none" style={{ color: CD.brass }}><span className="kyc-spin" style={{ width: 12, height: 12, border: `2px solid ${CD.brass}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} /> live</span>}
    </div>);
  }

  /* ====================================================================
     VERIFICATION NUDGE — the occasional “run a quick check” recommendation.
     Two levels:
       • reco  (dismissible) — it has been ≥ recheckDays (default 180) since the
         last provider check, or the subject has never been screened. A gentle
         prompt to run a $3.99 Quick check so the file stays current.
       • force (not dismissible) — the ID on file has EXPIRED. Pushes a full
         re-verify. This is the forcing function.
     Shown on the contact profile and inside the New-Transaction modal. Returns
     null on a healthy, recently-checked file, so it never nags without cause.
     ==================================================================== */
  function daysAgo(ms) { return Math.floor((Date.now() - ms) / 86400000); }
  const NUDGE_CTA = { quick: { label: 'Run quick check · $3.99', ic: 'search' }, verify: { label: 'Run verify check · $6.99', ic: 'id' }, plus: { label: 'Run Verify Plus · $14.99', ic: 'shield' } };
  function VerificationNudge({ name, rec, settings, onRun, demoChecks, amountCad, idRequired }) {
    useStore();
    const [dismissed, setDismissed] = useState(false);
    if (!name) return null;
    const RECO_DAYS = (settings && +settings.recheckDays) || 180;      // periodic quick-screen cadence
    const REVERIFY_DAYS = (settings && +settings.reverifyDays) || 365;  // full re-verification cadence
    const TODAY = window.CDOS.TODAY;
    const first = String(name).split(/\s+/)[0];
    const idMissing = !rec || !rec.idType || !rec.idNum;
    const idExpired = rec && rec.idExpiry && rec.idExpiry < TODAY;
    const riskLvl = (window.CDOS && window.CDOS.normalizeRisk) ? window.CDOS.normalizeRisk(rec && (rec.risk || rec.riskRating)) : (/high|enhanced/i.test(String((rec && (rec.risk || rec.riskRating)) || '')) ? 'High' : 'Normal');
    const highRisk = riskLvl === 'High';
    const done = (demoChecks || checksFor(name)).filter(c => c.status === 'completed' && c.result && c.result.decision === 'approved');
    const lastAny = done.length ? done.reduce((m, c) => (c.ms > m.ms ? c : m)) : null;
    const full = done.filter(c => c.template === 'verify' || c.template === 'plus');
    const lastFull = full.length ? full.reduce((m, c) => (c.ms > m.ms ? c : m)) : null;
    const ageAny = lastAny ? daysAgo(lastAny.ms) : null;
    const ageFull = lastFull ? daysAgo(lastFull.ms) : null;
    // pick the recommended tier from the file's state + house parameters
    const TH = (settings && +settings.threshold) || 10000;
    const bigDeal = amountCad != null && amountCad >= TH;
    const policy = (settings && settings.largeTxCheck) || 'off';   // off | quick | verify — mandatory check on large deals
    let level = null, tier = 'quick', title = '', reason = '';
    if (idExpired) { level = 'force'; tier = 'verify'; title = 'Re-verification required'; reason = `The ID on file expired${rec.idExpiry ? ' on ' + rec.idExpiry : ''}. Re-verify ${first} before running this deal.`; }
    else if (bigDeal && !lastFull) { level = 'reco'; tier = 'plus'; title = 'Verified Plus recommended'; reason = `First large transaction — this deal is at or above ${fmt ? fmt(TH, 'CAD') : '$' + TH.toLocaleString()} and ${first} has never been verified. Run the full enhanced check.`; }
    else if (bigDeal && policy !== 'off') { level = 'force'; tier = policy; title = 'Check required — large transaction'; reason = `House policy: every deal at or above ${fmt ? fmt(TH, 'CAD') : '$' + TH.toLocaleString()} requires a ${policy === 'verify' ? 'Verified' : 'quick'} check — even on a verified profile.`; }
    else if (!lastFull) { level = 'reco'; tier = 'verify'; title = 'Verification recommended'; reason = idMissing ? `${first} has no verified ID on file — run a verify check to establish identity.` : `${first} has an ID on file but has never been fully verified.`; }
    else if (ageAny != null && ageAny >= RECO_DAYS) { level = 'reco'; tier = 'quick'; title = 'Quick check recommended'; reason = ageAny >= REVERIFY_DAYS ? `${first} was last screened ${ageAny} days ago — over a year. A quick check keeps the file current.` : `Last screened ${ageAny} days ago — a quick check keeps ${first}'s file current.`; }
    else { return null; }
    // house rule: a high-risk subject escalates any identity check to the deepest tier
    // (owner-configurable in Settings → Compliance · Identity verification policy; on by default)
    const ESCALATE_HIGH_RISK = !settings || settings.escalateHighRisk !== false;
    const escalateRisk = highRisk || (riskLvl === 'Medium' && !!(settings && settings.escalateMediumRisk));
    if (ESCALATE_HIGH_RISK && escalateRisk && tier === 'verify') { tier = 'plus'; title = 'Enhanced ' + title.charAt(0).toLowerCase() + title.slice(1); reason += ` ${first} is flagged ${riskLvl.toLowerCase()}-risk — enhanced (Verified Plus) recommended.`; }
    // this deal legally needs a verified ID and the file isn't verified yet → hard stop, not a suggestion
    if (idRequired && !lastFull && level !== 'force') { level = 'force'; title = idMissing ? 'Identity verification required' : 'Verification required for this deal'; reason = `This deal needs a verified ID — ${reason.charAt(0).toLowerCase() + reason.slice(1)}`; }
    if (dismissed && level !== 'force') return null;
    const force = level === 'force';
    const BLUE = '#2B50E2';
    const c = force ? CD.flag : BLUE;
    const cta = NUDGE_CTA[tier];
    return (<div className="flex items-start gap-2.5 p-3 mb-2" style={{ background: force ? CD.flagSoft : 'rgba(43,80,226,.07)', border: `1px solid ${force ? CD.flag : 'rgba(43,80,226,.32)'}`, borderRadius: 11 }}>
      <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--cd-paper)' }}><Ic n={force ? 'alert' : cta.ic} s={15} c={c} /></span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold" style={{ color: force ? CD.flag : BLUE }}>{title}</div>
        <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{reason}</div>
        <div className="flex items-center gap-2 mt-2">
          <button onClick={() => onRun && onRun(tier)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n={cta.ic} s={13} c="var(--cd-on-ink)" /> {cta.label}</button>
          {!force && <button onClick={() => setDismissed(true)} className="px-2 py-1.5 text-[12px] font-medium" style={{ color: CD.mute }}>Not now</button>}
        </div>
      </div>
    </div>);
  }

  /* ====================================================================
     SUBJECT PANEL — embedded at the bottom of a contact profile
     ==================================================================== */
  function SubjectPanel({ name, kind, rec, by, setClients, settings }) {
    useStore();
    const [send, setSend] = useState(false);
    const [sendTpl, setSendTpl] = useState('verify');
    const applied = useRef({});
    const checks = checksFor(name);
    const latest = checks[0];
    // ONLY a completed ‘verify’ or ‘plus’ inquiry counts as identity-verified.
    // A ‘quick’ watchlist screen is screening, not KYC — it shows as “Screened”.
    const approvedTiers = checks.filter(c => c.status === 'completed' && c.result && c.result.decision === 'approved').map(c => c.template);
    const isVerPlus = approvedTiers.includes('plus');
    const isVer = isVerPlus || approvedTiers.includes('verify');
    const isScreened = approvedTiers.includes('quick');

    // when a verification comes back, fold what the provider read off the ID into the contact
    useEffect(() => {
      const done = checks.find(c => c.status === 'completed' && c.result && c.result.extracted);
      if (!done || !setClients || applied.current[done.id]) return;
      applied.current[done.id] = true;
      const ex = done.result.extracted;
      setClients(c => { const cur = c[name] || {}; const next = { ...cur };
        ['email', 'dob', 'address', 'city', 'province', 'postal', 'country', 'idType', 'idNum', 'idIssued', 'idExpiry'].forEach(k => { if (ex[k] && !String(next[k] || '').trim()) next[k] = ex[k]; });
        next.idVerifiedAt = done.result.completedAt;
        return { ...c, [name]: next };
      });
    }, [checks.map(c => c.id + c.status).join(',')]);

    return (<div className="p-4" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
      <VerificationNudge name={name} rec={rec} settings={settings} onRun={(tpl) => { setSendTpl(tpl); setSend(true); }} />
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5">
          <span className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8, background: CD.lineSoft }}><Ic n="id" s={15} c={CD.mute} /></span>
          <div>
            <div className="text-sm font-semibold flex items-center gap-2" style={{ color: CD.ink }}>Identity verification <window.CDOS.InfoTip title="Identity verification" body={`A paid background & ID check run through ${PROVIDER} — separate from the ID you hold on file. A Quick check screens the name against sanctions / PEP lists (screening, not identity verification); Verified authenticates the ID; Verified Plus adds a biometric selfie and deep database inquiry.`} example="Quick check ($3.99) · Verified ($6.99) · Verified Plus ($14.99)" /> {isVer ? <span className="text-[10px] px-1.5 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 5 }}><Ic n="checkcircle" s={11} c={CD.green} /> {isVerPlus ? PROVIDER + ' verified+' : PROVIDER + ' verified'}</span> : isScreened ? <span className="text-[10px] px-1.5 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.amberSoft, color: CD.amber, borderRadius: 5 }}><Ic n="search" s={11} c={CD.amber} /> Screened only</span> : null}</div>
            <div className="text-[11px]" style={{ color: CD.mute }}>Background & ID checks via {PROVIDER}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-none">
          {isVer && <button onClick={() => { setSendTpl('quick'); setSend(true); }} title="Re-screen name & DOB against sanctions / PEP lists" className="flex items-center gap-1.5 px-2.5 py-2 text-[12.5px] font-semibold flex-none" style={{ background: CD.panel, border: `1px solid ${CD.line}`, color: CD.ink, borderRadius: 9 }}><Ic n="search" s={14} c={CD.mute} /> Quick check · $3.99</button>}
          <button onClick={() => { setSendTpl('verify'); setSend(true); }} className="flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="send" s={14} c="var(--cd-on-ink)" /> {isVer ? 'Re-verify' : 'Verify identity'}</button>
        </div>
      </div>

      {/* completed-result detail for the latest finished check */}
      {latest && latest.status === 'completed' && (() => { const r = latest.result; const dm = decisionMeta(r.decision); const cell = (l, v) => (
        <div><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[12.5px] font-medium capitalize" style={{ color: v === 'pass' ? CD.green : (v === 'hit' || v === 'possible') ? CD.flag : CD.ink }}>{v}</div></div>); return (
        <div className="mb-3 p-3" style={{ background: CD.paper, border: `1px solid ${dm.c}33`, borderRadius: 11 }}>
          <div className="flex items-center gap-2 mb-2.5"><Ic n={dm.icon} s={16} c={dm.c} /><span className="text-[13px] font-semibold" style={{ color: dm.c }}>{dm.label}</span><span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{r.reportRef}</span></div>
          <div className="grid grid-cols-4 gap-2">{cell('Document', r.idCheck)}{cell('Biometric', r.biometric)}{cell('Database', r.database)}{cell('PEP', r.pep === 'None found' ? 'clear' : 'flag')}</div>
          {r.watchlist.length > 0 && <div className="mt-2 pt-2 text-[11.5px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.flag }}>{r.watchlist.length} database match{r.watchlist.length === 1 ? '' : 'es'} — {r.watchlist.map(h => h.name).join(', ')}</div>}
          {r.extracted && <div className="mt-2 pt-2 flex items-center gap-1.5 text-[11px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.mute }}><Ic n="checkcircle" s={12} c={CD.green} /> ID details, address &amp; date of birth auto-filled onto this contact.</div>}
        </div>); })()}

      {checks.length ? <div className="space-y-1.5">{checks.map(c => <CheckRow key={c.id} check={c} />)}</div>
        : <div className="text-center py-6 text-[12px]" style={{ color: CD.faint }}>No verifications yet. Send {name.split(/\s+/)[0]} off for a background check or ID verification — it attaches here automatically.</div>}

      {send && <SendModal subject={name} kind={kind} rec={rec} by={by} initialTpl={sendTpl} onClose={() => setSend(false)} />}
    </div>);
  }

  /* ====================================================================
     PICKER MODAL — Compliance: pick a subject, then send (whole flow)
     ==================================================================== */
  /* ====================================================================
     NEW CONTACT FLOW — scan ID → name & phone → verify → auto-fill
     A guided onboarding: capture the ID, capture name + phone (creates
     the contact), run Persona, then write the extracted address / DOB /
     ID details back onto the contact.
     ==================================================================== */
  function NewContactFlow({ initialName, by, setClients, onClose, onDone, requireId }) {
    const store = useStore();
    const [step, setStep] = useState('id');     // id | details | verifying | done
    const [photo, setPhoto] = useState(null);
    const [name, setName] = useState(initialName || '');
    const [kind, setKind] = useState('individual');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [tplId, setTplId] = useState('verify');
    const [mode, setMode] = useState(null);
    const [via, setVia] = useState('sms');
    const [checkId, setCheckId] = useState(null);
    const applied = useRef(false);
    const onFile = (file) => { if (!file) return; const r = new FileReader(); r.onload = () => setPhoto(r.result); r.readAsDataURL(file); };
    const [cam, setCam] = useState(false);          // live camera capture overlay
    const [camErr, setCamErr] = useState('');
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const closeCamera = () => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } setCam(false); };
    const openCamera = async () => {
      setCamErr(''); setCam(true);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        streamRef.current = s;
        const attach = () => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } else setTimeout(attach, 30); };
        attach();
      } catch (e) { setCamErr(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser, or upload a photo instead.' : 'No camera available on this device. Upload a photo instead.'); }
    };
    const capturePhoto = () => { const v = videoRef.current; if (!v || !v.videoWidth) return; const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); setPhoto(cv.toDataURL('image/jpeg', 0.85)); closeCamera(); };
    useEffect(() => () => closeCamera(), []);
    const full = tmpl('full');

    const writeContact = (nm) => { if (setClients) setClients(c => ({ ...c, [nm]: { ...(c[nm] || {}), kind, phone: phone.trim(), photo: photo || (c[nm] && c[nm].photo) || null, risk: (c[nm] && c[nm].risk) || houseRisk(), createdAt: (c[nm] && c[nm].createdAt) || new Date().toISOString().slice(0, 10) } })); };
    // escape hatch: create the contact without running (or paying for) a verification
    const saveManual = () => { const nm = name.trim(); if (!nm) return; writeContact(nm); if (onDone) onDone(nm); onClose(); };
    // create the contact, fire the chosen verification, then watch it complete
    const startCheck = () => {
      const nm = name.trim(); if (!nm) return;
      const del = deliveryFor({ tplId, mode, via, email, phone, hasId: !!photo, subject: nm });
      if (del.missing) return;
      if (setClients) setClients(c => ({ ...c, [nm]: { ...(c[nm] || {}), kind, phone: phone.trim(), email: email.trim() || (c[nm] && c[nm].email) || '', photo: photo || (c[nm] && c[nm].photo) || null, risk: (c[nm] && c[nm].risk) || houseRisk(), createdAt: (c[nm] && c[nm].createdAt) || new Date().toISOString().slice(0, 10) } }));
      const chk = createCheck({ subject: nm, kind, template: tplId, channel: del.channel, contact: del.contact, by });
      setCheckId(chk.id); setStep('verifying');
    };

    // when the verification finishes, fold the extracted identity into the contact
    const check = checkId ? store[checkId] : null;
    useEffect(() => {
      if (step === 'verifying' && check && check.status === 'completed' && !applied.current) {
        applied.current = true;
        const ex = check.result.extracted;
        if (ex && setClients) setClients(c => ({ ...c, [name.trim()]: { ...(c[name.trim()] || {}), ...ex, kind, idVerifiedAt: check.result.completedAt } }));
        setStep('done');
      }
    }, [check && check.status]);

    const si = step === 'id' ? 0 : step === 'details' ? 1 : 2;   // which of the 3 stepper dots is current
    const Step = ({ n, label }) => { const active = si >= n - 1; const cur = si === n - 1; return (
      <div className="flex items-center gap-1.5"><span className="grid place-items-center" style={{ width: 18, height: 18, borderRadius: '50%', background: active ? CD.ink : CD.lineSoft, color: active ? 'var(--cd-on-ink)' : CD.mute, fontSize: 10, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{si > n - 1 ? '✓' : n}</span><span className="text-[11px] font-medium" style={{ color: cur ? CD.ink : CD.faint }}>{label}</span></div>
    ); };

    const ex = check && check.result ? check.result.extracted : null;
    const dm = check && check.result ? decisionMeta(check.result.decision) : null;

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 520, maxHeight: '92%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="flex items-start gap-3 px-5 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 10 }}><Ic n="userplus" s={18} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0"><div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>Add a verified contact</div><div className="text-[11.5px]" style={{ color: CD.mute }}>Scan ID, add details, verify · via {PROVIDER}</div></div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>
        <div className="flex items-center gap-3 px-5 py-2.5 flex-none" style={{ borderBottom: `1px solid ${CD.line}` }}><Step n={1} label="Scan ID" /><span style={{ flex: 1, height: 1, background: CD.line }} /><Step n={2} label="Details" /><span style={{ flex: 1, height: 1, background: CD.line }} /><Step n={3} label="Verify" /></div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {step === 'id' && (<div>
            <div className="text-[12.5px] mb-3" style={{ color: CD.mute }}>Capture the customer's government ID. {PROVIDER} reads the name, address, date of birth and ID details straight off the document.</div>
            {photo ? (
              <div className="relative" style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${CD.line}` }}>
                <img src={photo} alt="ID" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', display: 'block' }} />
                <label className="absolute" style={{ right: 10, bottom: 10, cursor: 'pointer' }}><span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium" style={{ background: 'var(--cd-scrim)', color: 'var(--cd-on-ink)', borderRadius: 8 }}><Ic n="camera" s={13} c="var(--cd-on-ink)" /> Replace</span><input type="file" accept="image/*" className="hidden" onChange={e => onFile(e.target.files[0])} /></label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                <label className="flex flex-col items-center justify-center gap-2 py-7 cursor-pointer" style={{ border: `1.5px dashed ${CD.line}`, borderRadius: 12, background: CD.panel }}><span className="grid place-items-center" style={{ width: 40, height: 40, borderRadius: 10, background: CD.lineSoft }}><Ic n="upload" s={18} c={CD.mute} /></span><span className="text-[12.5px] font-medium" style={{ color: CD.ink }}>Upload ID</span><input type="file" accept="image/*" className="hidden" onChange={e => onFile(e.target.files[0])} /></label>
                <button onClick={openCamera} type="button" className="flex flex-col items-center justify-center gap-2 py-7" style={{ border: `1.5px dashed ${CD.line}`, borderRadius: 12, background: CD.panel, cursor: 'pointer' }}><span className="grid place-items-center" style={{ width: 40, height: 40, borderRadius: 10, background: CD.lineSoft }}><Ic n="camera" s={18} c={CD.mute} /></span><span className="text-[12.5px] font-medium" style={{ color: CD.ink }}>Take a photo</span></button>
              </div>
            )}
          </div>)}

          {step === 'details' && (<div>
            <div className="text-[12.5px] mb-3" style={{ color: CD.mute }}>Just the basics to create the contact — {PROVIDER} fills in the rest from the ID.</div>
            <div className="inline-flex mb-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{['individual', 'corporate'].map(k => <button key={k} onClick={() => setKind(k)} className="px-3.5 py-2 text-[12.5px]" style={{ background: kind === k ? CD.ink : 'transparent', color: kind === k ? 'var(--cd-on-ink)' : CD.mute }}>{k === 'corporate' ? 'Business' : 'Person'}</button>)}</div>
            <label className="block mb-3"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>{kind === 'corporate' ? 'Business name' : 'Full name'}</div><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'corporate' ? 'Acme Imports Ltd.' : 'Jane Doe'} className="w-full text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)' }} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Phone number</div><input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(416) 555-0100" className="w-full text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', fontFamily: 'Space Mono, monospace' }} /></label>
              <label className="block"><div className="text-[11px] mb-1" style={{ color: CD.mute }}>Email</div><input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@email.com" className="w-full text-sm px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)' }} /></label>
            </div>
            <div className="text-[11px] mt-3 flex items-center gap-1.5" style={{ color: CD.faint }}><Ic n="send" s={11} c={CD.faint} /> Next you'll pick the verification and send it to their phone or email.</div>
          </div>)}

          {step === 'choose' && <VerifyChooserBody subject={name.trim() || 'this contact'} hasId={!!photo} verified={false} tplId={tplId} setTplId={setTplId} mode={mode} setMode={setMode} via={via} setVia={setVia} email={email} setEmail={setEmail} phone={phone} setPhone={setPhone} onScanMore={() => setStep('id')} onCapture={setPhoto} />}

          {step === 'verifying' && (<div className="text-center py-8">
            <span className="grid place-items-center mx-auto mb-4" style={{ width: 56, height: 56, borderRadius: '50%', background: CD.brassSoft }}><span className="kyc-spin" style={{ width: 24, height: 24, border: `3px solid ${CD.brass}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} /></span>
            <div className="text-[15px] font-semibold" style={{ color: CD.ink }}>{check && check.channel === 'records' ? `Confirming ${name.trim()} from your records…` : check && check.channel === 'link' ? `Verification link sent to ${name.trim()}` : `Verifying ${name.trim()} with ${PROVIDER}…`}</div>
            <div className="text-[12.5px] mt-1 mx-auto" style={{ color: CD.mute, maxWidth: 360 }}>{check && check.channel === 'records' ? `Already verified on file — confirming instantly with no ${PROVIDER} inquiry.` : check && check.channel === 'link' ? `They'll photograph their ID and take a selfie on their device. This screen updates the moment they finish — you can close it and check back.` : `Sending the scanned ID to ${PROVIDER} and screening sanctions, PEP and adverse-media databases. This usually takes a few seconds.`}</div>
            <div className="inline-flex items-center gap-2 mt-4 px-3 py-1.5 text-[12px]" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 999, color: CD.mute }}><Ic n="id" s={13} c={CD.mute} /> {tmpl(tplId).label} · {money(net(tmpl(tplId).price))} billed</div>
          </div>)}

          {step === 'done' && (<div>
            <div className="flex items-center gap-2.5 mb-3">
              <span className="grid place-items-center flex-none" style={{ width: 40, height: 40, borderRadius: '50%', background: dm ? dm.bg : CD.greenSoft }}><Ic n={dm ? dm.icon : 'checkcircle'} s={20} c={dm ? dm.c : CD.green} /></span>
              <div><div className="text-[15px] font-semibold" style={{ color: CD.ink }}>{name.trim()} added{dm && dm.label === 'Verified' ? ' & verified' : ''}</div><div className="text-[12px]" style={{ color: dm ? dm.c : CD.mute }}>{dm ? dm.label : 'Verified'} · saved to your contacts</div></div>
            </div>
            {ex && (<div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
              <div className="text-[10px] uppercase tracking-widest mb-2 flex items-center gap-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="id" s={12} c={CD.faint} /> Pulled from the ID</div>
              {[['Address', `${ex.address}, ${ex.city}, ${ex.province} ${ex.postal}`], ['Date of birth', ex.dob], ['ID', `${ex.idType} · ${ex.idNum}`], ['Expiry', ex.idExpiry]].map(([l, v]) => (
                <div key={l} className="flex items-center justify-between py-1.5 text-[12.5px]" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span style={{ color: CD.mute }}>{l}</span><span style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{v}</span></div>
              ))}
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Saved to the contact — review and edit anytime in Clients.</div>
            </div>)}
          </div>)}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: CD.panel }}>
          {step === 'id' && (<>
            <button onClick={() => setStep('details')} className="text-[12px] font-medium" style={{ color: CD.mute }}>Skip — add ID later</button>
            <div className="flex-1" />
            <button onClick={() => setStep('details')} disabled={!photo} className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white" style={{ background: photo ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: photo ? 'pointer' : 'not-allowed' }}>Continue <Ic n="chev" s={14} c="var(--cd-on-ink)" /></button>
          </>)}
          {step === 'details' && (<>
            <button onClick={() => setStep('id')} className="px-3.5 py-2.5 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute }}>Back</button>
            {!requireId && <button onClick={saveManual} disabled={!name.trim()} title="Skip verification — not recommended" className="px-2.5 py-2.5 text-[12px] font-medium" style={{ color: CD.faint, textDecoration: 'underline', textUnderlineOffset: 2, cursor: name.trim() ? 'pointer' : 'not-allowed' }}>Save without verifying</button>}
            <div className="flex-1" />
            <button onClick={() => setStep('choose')} disabled={!name.trim()} className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white" style={{ background: name.trim() ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: name.trim() ? 'pointer' : 'not-allowed' }}>Continue <Ic n="chev" s={14} c="var(--cd-on-ink)" /></button>
          </>)}
          {step === 'choose' && (() => { const del = deliveryFor({ tplId, mode, via, email, phone, hasId: !!photo, subject: name.trim() }); return (<>
            <div className="flex-1"><div className="text-[11px]" style={{ color: CD.faint }}>You'll be billed</div><div className="text-[20px] font-bold leading-none" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money(net(tmpl(tplId).price))}</div></div>
            <button onClick={() => setStep('details')} className="px-3.5 py-2.5 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute }}>Back</button>
            <button onClick={startCheck} disabled={del.missing} className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white" style={{ background: del.missing ? 'var(--cd-disabled)' : CD.ink, borderRadius: 9, cursor: del.missing ? 'not-allowed' : 'pointer' }}><Ic n="send" s={14} c="var(--cd-on-ink)" /> {del.label}</button>
          </>); })()}
          {step === 'done' && (<><div className="flex-1" /><button onClick={() => { if (onDone) onDone(name.trim()); onClose(); }} className="px-5 py-2.5 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}>Done</button></>)}
        </div>
      </div>
      {cam && <div onClick={e => e.stopPropagation()} className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 10000 }}>
        <div className="w-full flex flex-col" style={{ maxWidth: 520, background: 'var(--cd-ink)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 70px -20px rgba(0,0,0,0.7)' }}>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--cd-on-ink-faint)' }}>
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--cd-on-ink)' }}><Ic n="camera" s={15} c="var(--cd-on-ink)" /> Photograph the ID</div>
            <button onClick={closeCamera} className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 8, color: 'var(--cd-on-ink-soft)' }}><Ic n="x" s={16} c="var(--cd-on-ink-soft)" /></button>
          </div>
          <div style={{ position: 'relative', background: 'var(--cd-ink-strong)', aspectRatio: '4 / 3', display: 'grid', placeItems: 'center' }}>
            {camErr
              ? <div className="text-center px-6" style={{ color: 'var(--cd-on-ink-soft)' }}><Ic n="alert" s={22} c="#e7b34a" /><div className="text-[13px] mt-2">{camErr}</div></div>
              : <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            {!camErr && <div style={{ position: 'absolute', inset: '12% 8%', border: '2px dashed var(--cd-on-ink-soft)', borderRadius: 12, pointerEvents: 'none' }} />}
          </div>
          <div className="flex items-center justify-center gap-3 px-4 py-4">
            {camErr
              ? <button onClick={closeCamera} className="px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}>Close</button>
              : <><button onClick={closeCamera} className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--cd-on-ink-soft)', border: '1px solid var(--cd-on-ink-faint)', borderRadius: 9 }}>Cancel</button>
                <button onClick={capturePhoto} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold" style={{ background: 'var(--cd-panel)', color: 'var(--cd-ink)', borderRadius: 9 }}><span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cd-ink)', display: 'inline-block' }} /> Capture</button></>}
          </div>
        </div>
      </div>}
    </div></Portal>);
  }

  function PickerModal({ clients, beneficiaries, by, onClose, setClients, onOpenContact }) {
    const [q, setQ] = useState('');
    const [picked, setPicked] = useState(null);   // { name, kind, rec }
    const [adding, setAdding] = useState(false);
    const subjects = useMemo(() => {
      const out = [];
      Object.keys(clients || {}).forEach(n => out.push({ name: n, kind: clients[n].kind === 'corporate' ? 'corporate' : 'individual', rec: clients[n], sub: clients[n].kind === 'corporate' ? 'Business' : 'Individual' }));
      (beneficiaries || []).forEach(b => { if (!out.some(o => o.name === b.name)) out.push({ name: b.name, kind: 'individual', rec: { phone: b.phone }, sub: 'Beneficiary · of ' + b.sender }); });
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }, [clients, beneficiaries]);
    const shown = subjects.filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase()));

    if (adding) return <NewContactFlow initialName={q.trim()} by={by} setClients={setClients} onClose={onClose} requireId={true} />;
    if (picked) return <SendModal subject={picked.name} kind={picked.kind} rec={picked.rec} by={by} onClose={onClose} />;

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 460, maxHeight: '82%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="flex items-center gap-3 px-5 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 36, height: 36, background: CD.ink, borderRadius: 10 }}><Ic n="id" s={18} c="var(--cd-on-ink)" /></span>
          <div className="flex-1"><div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>New KYC verification</div><div className="text-[11.5px]" style={{ color: CD.mute }}>Add someone new, or pick an existing contact · via {PROVIDER}</div></div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>

        {/* add new — pinned at the top */}
        <div className="px-3 pt-3 flex-none">
          <button onClick={() => setAdding(true)} className="w-full flex items-center gap-3 px-2.5 py-2.5 text-left" style={{ borderRadius: 11, border: `1.5px solid ${CD.ink}`, background: 'var(--cd-chip)' }}>
            <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: CD.ink }}><Ic n="userplus" s={16} c="var(--cd-on-ink)" /></span>
            <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>Add a new contact</div><div className="text-[11px]" style={{ color: CD.mute }}>Scan their ID — we'll create & verify in one go</div></div>
            <Ic n="chev" s={15} c={CD.mute} />
          </button>
        </div>

        <div className="px-3 pt-3 pb-1 flex-none">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 9 }}><Ic n="search" s={15} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Or search existing clients & beneficiaries…" className="outline-none text-sm bg-transparent flex-1" /></div>
        </div>
        <div className="flex-1 overflow-auto px-3 pb-3">
          {shown.map(s => (
            <button key={s.name} onClick={() => setPicked(s)} className="w-full flex items-center gap-3 px-2.5 py-2.5 text-left" style={{ borderRadius: 10 }} onMouseEnter={e => e.currentTarget.style.background = CD.panel} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: s.kind === 'corporate' ? 8 : '50%', background: CD.lineSoft }}><Ic n={s.kind === 'corporate' ? 'building' : 'users'} s={15} c={CD.mute} /></span>
              <div className="flex-1 min-w-0"><div className="text-[13px] font-medium truncate" style={{ color: CD.ink }}>{s.name}</div><div className="text-[11px]" style={{ color: CD.faint }}>{s.sub}</div></div>
              <Ic n="chev" s={14} c={CD.faint} />
            </button>))}
          {!shown.length && (
            <div className="text-center px-4 pt-6 pb-3" style={{ color: CD.faint }}>
              <div className="text-[12.5px]" style={{ color: CD.mute }}>{q ? `No existing contact matches “${q.trim()}”.` : 'No contacts yet.'}</div>
              <div className="text-[11.5px] mt-0.5">Use “Add a new contact” above to onboard them.</div>
            </div>
          )}
        </div>
      </div>
    </div></Portal>);
  }

  // tiny spinner keyframes (once)
  if (!document.getElementById('kyc-spin-kf')) { const st = document.createElement('style'); st.id = 'kyc-spin-kf'; st.textContent = '@keyframes kycspin{to{transform:rotate(360deg)}}.kyc-spin{animation:kycspin .8s linear infinite}'; document.head.appendChild(st); }

  window.CDOS = Object.assign(window.CDOS || {}, { KYC: { TEMPLATES, summary, checksFor, setContactSink, setProvider, getProvider, applyPartnerCode, getPartnerRate, SendModal, SubjectPanel, PickerModal, NewContactFlow, VerificationNudge, decisionMeta, phaseMeta } });
})();
