/* ============================================================
   CurrencyDesk OS — Texts (SMS & messaging)
   Website quote requests + currency orders, the automated SMS
   journey (quote → hold → verify → ready), broadcasts, contacts
   and a full message history. Desk-side redemption: the customer
   reads their ref at the counter and the teller pulls up the held
   rate. Config (number, websites, defaults) lives in Settings ›
   Texts · SMS — registered here as TextsSettings.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, crossRate } = window.CDOS;
  const ACC = '#8A4B2F', ACCSOFT = '#F2E6DD';
  const TGKEY = 'cdos_tg_settings_v1', RKEY = 'cdos_tg_requests_v2', CKEY2 = 'cdos_tg_contacts_v2', BKEY2 = 'cdos_tg_broadcasts_v1', SKEY2 = 'cdos_tg_sites_v2', LKEY = 'cdos_tg_log_v2';
  const load = (k, d) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const announce = () => setTimeout(() => { try { window.dispatchEvent(new Event('cdos_tg_sync')); } catch (e) {} }, 60);
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const mdhm = (ts) => new Date(ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' ' + hhmm(ts);
  const render = (tpl, ctx) => (tpl || '').replace(/\{(\w+)\}/g, (m, k) => (ctx[k] != null && ctx[k] !== '' ? ctx[k] : m));
  const segsOf = (t) => Math.max(1, Math.ceil((t || '').length / 153));
  const onBoard = (ccy) => { try { const r = crossRate(ccy, 'CAD'); return r && isFinite(r) && r > 0 && Math.abs(r - 1) > 1e-9; } catch (e) { return false; } };
  const boardRate = (ccy) => { try { const r = crossRate(ccy, 'CAD'); return r && isFinite(r) && r > 0 ? r : 1; } catch (e) { return 1; } };
  const sellRate = (ccy) => +(boardRate(ccy) * 1.0175).toFixed(4);
  const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); if (m < 1) return 'now'; if (m < 60) return m + 'm ago'; const h = Math.round(m / 60); return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago'; };

  const phDigits = (p) => (p || '').replace(/\D/g, '').slice(-10);
  const DEF_TG = {
    desk: 'YORK FX', from: 'YORKFX', number: '+1 (647) 555-0142', autoQuote: false, holdMins: 30,
    verifyStep: true, nudge: true, pickup: true, aftersale: true, orders: true, quietFrom: '21:00', quietTo: '08:00',
    audience: 212, monthSent: 642, monthIncl: 2500,
    tpl: {
      quote: '{desk}: {amount} {ccy} = ${total} CAD at {rate}. This is our live counter rate. Reply Y and we’ll hold it for {mins} min — N to pass.',
      hold: 'Done — {rate} is held for you until {time}. Your ref is {ref} — give it at the counter. Bring one piece of government photo ID.',
      verify: 'Want to skip the wait? Verify your ID before you arrive: {link}',
      ready: 'You’re verified. Give ref {ref} at the counter — your rate stays locked until {time}.',
      nudge: 'Heads up — your held rate (ref {ref}) expires in 10 minutes.',
      closed: 'No problem. Today’s rates are always live at {site} — text back any time.',
      pickup: '{desk}: your order {ref} is ready for pickup at 128 Yonge St. We’re open until 6 pm today.',
      aftersale: 'Thanks for exchanging with {desk} today. Save this number — text us for a live quote any time, or watch rates at {site}.',
      orderq: '{desk}: we can order {amount} {ccy} for you — usually {days} business days. We’ll text you the moment it arrives. Your ref is {ref}.',
      orderready: '{desk}: your {ccy} is in! Give ref {ref} at the counter — {rate} applies at pickup. We’re open until 6 pm.'
    }
  };
  const out = (t) => ({ d: 'out', t }), inn = (t) => ({ d: 'in', t }), sys = (t) => ({ d: 'sys', t });
  function seedReqs() {
    const n = Date.now();
    const q = (amount, ccy, total, rate, mins) => `YORK FX: ${num(amount)} ${ccy} = $${num(total)} CAD at ${rate.toFixed(4)}. This is our live counter rate. Reply Y and we’ll hold it for ${mins} min — N to pass.`;
    return [
      { id: 'r1', ref: 'TQ-1046', kind: 'quote', phone: '+1 647 555 0139', name: '', site: 'yorkfx.ca', br: 'Yonge St', ccy: 'USD', amount: 1000, at: n - 2 * 60000, status: 'new', thread: [sys('Quote requested on yorkfx.ca — 1,000 USD')] },
      { id: 'r2', ref: 'TQ-1045', kind: 'quote', phone: '+1 416 555 0187', name: 'M. Chen', site: 'yorkfx.ca', br: 'Yonge St', ccy: 'EUR', amount: 500, at: n - 9 * 60000, status: 'new', thread: [sys('Quote requested on yorkfx.ca — 500 EUR')] },
      { id: 'r8', ref: 'TO-2012', kind: 'order', phone: '+1 416 555 0129', name: 'T. Moyo', site: 'yorkfx.ca', br: 'Scarborough', ccy: 'ZWG', amount: 30000, at: n - 18 * 60000, status: 'order_new', thread: [sys('Currency order on yorkfx.ca — 30,000 ZWG (Zimbabwe)')] },
      { id: 'r3', ref: 'TQ-1044', kind: 'quote', phone: '+1 905 555 0121', name: 'P. Osei', site: 'yorkfx.ca', br: 'Yonge St', ccy: 'USD', amount: 2500, at: n - 26 * 60000, status: 'held', rate: 1.3958, total: 3489.5, holdUntil: n + 14 * 60000, thread: [sys('Quote requested on yorkfx.ca — 2,500 USD'), out(q(2500, 'USD', 3489.5, 1.3958, 30)), inn('Y'), out(`Done — 1.3958 is held for you until ${hhmm(n + 14 * 60000)}. Your ref is TQ-1044 — give it at the counter. Bring one piece of government photo ID.`), out('Want to skip the wait? Verify your ID before you arrive: desk.cd/v/tq-1044')] },
      { id: 'r9', ref: 'TO-2011', kind: 'order', phone: '+1 905 555 0177', name: '', site: 'yorkfx.ca', br: 'Scarborough', ccy: 'ZAR', amount: 20000, at: n - 22 * 3600000, status: 'order_placed', etaDays: 2, thread: [sys('Currency order on yorkfx.ca — 20,000 ZAR · pickup Scarborough'), out('YORK FX: we can order 20,000 ZAR for you — usually 2 business days. We’ll text you the moment it arrives. Your ref is TO-2011.')] },
      { id: 'r4', ref: 'TQ-1043', kind: 'quote', phone: '+1 437 555 0163', name: '', site: 'yorkfx.ca', br: 'Scarborough', ccy: 'INR', amount: 150000, at: n - 38 * 60000, status: 'quoted', rate: 0.0167, total: 2505, thread: [sys('Quote requested on yorkfx.ca — 150,000 INR · pickup Scarborough'), out(q(150000, 'INR', 2505, 0.0167, 30))] },
      { id: 'r5', ref: 'TQ-1042', kind: 'quote', phone: '+1 416 555 0158', name: 'A. Reyes', site: 'yorkfx.ca', br: 'Yonge St', ccy: 'PHP', amount: 80000, at: n - 71 * 60000, status: 'verified', rate: 0.0248, total: 1984, holdUntil: n + 6 * 60000, thread: [sys('Quote requested on yorkfx.ca — 80,000 PHP'), out(q(80000, 'PHP', 1984, 0.0248, 30)), inn('Y'), out(`Done — 0.0248 is held for you until ${hhmm(n + 6 * 60000)}. Your ref is TQ-1042 — give it at the counter. Bring one piece of government photo ID.`), out('Want to skip the wait? Verify your ID before you arrive: desk.cd/v/tq-1042'), sys('ID verified via secure link · Persona'), out(`You’re verified. Give ref TQ-1042 at the counter — your rate stays locked until ${hhmm(n + 6 * 60000)}.`)] },
      { id: 'r6', ref: 'TQ-1041', kind: 'quote', phone: '+1 289 555 0102', name: '', site: 'yorkfx.ca', br: 'Yonge St', ccy: 'USD', amount: 800, at: n - 3.2 * 3600000, status: 'collected', rate: 1.3952, total: 1116.16, thread: [sys('Quote requested on yorkfx.ca — 800 USD'), out(q(800, 'USD', 1116.16, 1.3952, 30)), inn('Y'), out(`Done — 1.3952 is held for you until ${hhmm(n - 2.7 * 3600000)}. Your ref is TQ-1041 — give it at the counter. Bring one piece of government photo ID.`), sys('Collected at the counter · till 2')] },
      { id: 'r7', ref: 'TQ-1039', kind: 'quote', phone: '+1 647 555 0114', name: '', site: 'yorkfx.ca', br: 'Scarborough', ccy: 'GBP', amount: 400, at: n - 26 * 3600000, status: 'expired', rate: 1.744, total: 697.6, thread: [sys('Quote requested on yorkfx.ca — 400 GBP · pickup Scarborough'), out(q(400, 'GBP', 697.6, 1.744, 30)), inn('Y'), sys('Hold expired — no visit')] }
    ];
  }
  function seedLog() {
    const n = Date.now(), h = 3600000, m = 60000;
    return [
      { t: n - 2 * m, kind: 'Request', dir: 'in', to: '+1 647 555 0139', detail: 'Quote request — 1,000 USD · yorkfx.ca' },
      { t: n - 9 * m, kind: 'Request', dir: 'in', to: '+1 416 555 0187', detail: 'Quote request — 500 EUR · yorkfx.ca' },
      { t: n - 18 * m, kind: 'Request', dir: 'in', to: '+1 416 555 0129', detail: 'Currency order — 30,000 ZWG · yorkfx.ca' },
      { t: n - 24 * m, kind: 'Hold', dir: 'out', to: '+1 905 555 0121', detail: 'TQ-1044 — 1.3958 held 30 min + verify link' },
      { t: n - 24 * m, kind: 'Reply', dir: 'in', to: '+1 905 555 0121', detail: 'Y — hold the rate' },
      { t: n - 25 * m, kind: 'Quote', dir: 'out', to: '+1 905 555 0121', detail: 'TQ-1044 — 2,500 USD = $3,489.50 at 1.3958' },
      { t: n - 26 * m, kind: 'Request', dir: 'in', to: '+1 905 555 0121', detail: 'Quote request — 2,500 USD · yorkfx.ca' },
      { t: n - 37 * m, kind: 'Quote', dir: 'out', to: '+1 437 555 0163', detail: 'TQ-1043 — 150,000 INR = $2,505.00 at 0.0167' },
      { t: n - 55 * m, kind: 'Ready', dir: 'out', to: '+1 416 555 0158', detail: 'TQ-1042 — verified, locked until pickup' },
      { t: n - 55 * m, kind: 'System', dir: 'sys', to: '+1 416 555 0158', detail: 'ID verified via secure link · Persona' },
      { t: n - 69 * m, kind: 'Hold', dir: 'out', to: '+1 416 555 0158', detail: 'TQ-1042 — 0.0248 held 30 min + verify link' },
      { t: n - 70 * m, kind: 'Quote', dir: 'out', to: '+1 416 555 0158', detail: 'TQ-1042 — 80,000 PHP = $1,984.00 at 0.0248' },
      { t: n - 2.9 * h, kind: 'System', dir: 'sys', to: '+1 289 555 0102', detail: 'TQ-1041 collected at the counter · till 2' },
      { t: n - 3.1 * h, kind: 'Hold', dir: 'out', to: '+1 289 555 0102', detail: 'TQ-1041 — 1.3952 held 30 min' },
      { t: n - 22 * h, kind: 'Order', dir: 'out', to: '+1 905 555 0177', detail: 'TO-2011 — 20,000 ZAR, ~2 business days' },
      { t: n - 26 * h, kind: 'System', dir: 'sys', to: '+1 647 555 0114', detail: 'TQ-1039 hold expired — no visit' },
      { t: n - 4 * 24 * h, kind: 'Broadcast', dir: 'out', to: '206 subscribers', detail: 'USD dipped overnight — 1.3890 at our counter this morning…' },
      { t: n - 13 * 24 * h, kind: 'Opt-out', dir: 'in', to: '+1 289 555 0144', detail: 'Replied STOP — removed from broadcasts (CASL)' }
    ];
  }
  const DEF_CONTACTS = [
    { id: 'c1', phone: '+1 905 555 0121', name: 'P. Osei', consent: 'express', src: 'Website · quote', since: 'Jun 12' },
    { id: 'c2', phone: '+1 416 555 0158', name: 'A. Reyes', consent: 'express', src: 'Website · quote', since: 'Jun 28' },
    { id: 'c3', phone: '+1 416 555 0177', name: 'D. Whitfield', consent: 'express', src: 'In-store', since: 'Jul 2' },
    { id: 'c4', phone: '+1 647 555 0139', name: '', consent: 'implied', src: 'Website · quote', since: 'Today' },
    { id: 'c5', phone: '+1 905 555 0186', name: 'R. Haddad', consent: 'express', src: 'In-store', since: 'May 30' },
    { id: 'c6', phone: '+1 437 555 0163', name: 'N. Kaur', consent: 'implied', src: 'Website · quote', since: 'Jul 11' },
    { id: 'c7', phone: '+1 416 555 0121', name: 'S. Grewal', consent: 'express', src: 'In-store', since: 'Apr 18' },
    { id: 'c8', phone: '+1 289 555 0144', name: 'J. Tam', consent: 'express', src: 'In-store', since: 'Mar 9', stopped: 'Jul 6' }
  ];
  const DEF_BCASTS = [
    { id: 'b1', at: 'Jul 15 · 8:04 am', body: 'YORK FX: USD dipped overnight — 1.3890 at our counter this morning. First 20 walk-ins keep it. 128 Yonge St, open 9–6. Reply STOP to opt out.', n: 206, cost: 3.09 },
    { id: 'b2', at: 'Jun 27 · 4:31 pm', body: 'YORK FX: long-weekend hours — open Sat 10–4, closed Monday. Rates hold steady all weekend on yorkfx.ca. Reply STOP to opt out.', n: 198, cost: 1.49 }
  ];
  const DEF_SITES = [
    { id: 's1', domain: 'yorkfx.ca', since: 'Apr 2026', req7: 40, widget: true }
  ];
  const deskBranches = () => { try { const st = window.CDOS._stations; const r = JSON.parse(localStorage.getItem(st.SKEY) || 'null'); const list = Array.isArray(r) && r.length ? r : (st && st.defaultBranches ? st.defaultBranches() : null); const names = (list || []).map(b => b && b.name).filter(Boolean); return names.length ? names.slice(0, 6) : ['Yonge St', 'Scarborough']; } catch (e) { return ['Yonge St', 'Scarborough']; } };
  const STATUS_META = {
    new: { l: 'Needs reply', c: '#8F6410', s: '#F5ECD7' },
    quoted: { l: 'Quoted', c: '#274B8E', s: '#E6EBF5' },
    held: { l: 'Rate held', c: '#1D6B45', s: '#E2EFE7' },
    verified: { l: 'Verified', c: '#1F7269', s: '#DFEEEC' },
    order_new: { l: 'Order — new', c: '#8F6410', s: '#F5ECD7' },
    order_placed: { l: 'On order', c: '#274B8E', s: '#E6EBF5' },
    order_arrived: { l: 'In stock', c: '#1D6B45', s: '#E2EFE7' },
    collected: { l: 'Collected', c: '#5C5647', s: '#EFEBE3' },
    closed: { l: 'Closed', c: '#5C5647', s: '#EFEBE3' },
    expired: { l: 'Expired', c: '#9A8F7C', s: '#F1EEE8' }
  };
  const ACTIVE_ST = ['quoted', 'held', 'verified', 'order_placed', 'order_arrived'];
  function Pill({ s }) { const m = STATUS_META[s] || STATUS_META.closed; return <span className="text-[10px] font-semibold px-2 py-0.5 flex-none" style={{ background: m.s, color: m.c, borderRadius: 999, fontFamily: 'Space Mono, monospace', letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>{m.l}</span>; }
  function Toggle({ on, click, small }) { const w = small ? 30 : 36, h = small ? 18 : 21, d = h - 6; return <button onClick={click} aria-pressed={!!on} className="flex-none" style={{ width: w, height: h, borderRadius: 999, border: '1px solid ' + (on ? CD.ink : CD.line), background: on ? CD.ink : CD.lineSoft, position: 'relative', transition: 'background .15s' }}><span style={{ position: 'absolute', top: 2, left: on ? w - d - 4 : 2, width: d, height: d, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)', transition: 'left .15s' }}></span></button>; }
  function HoldClock({ until }) {
    const [, setT] = useState(0);
    useEffect(() => { const t = setInterval(() => setT(x => x + 1), 1000); return () => clearInterval(t); }, []);
    const left = Math.max(0, (until || 0) - Date.now());
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    const hot = left < 5 * 60000;
    return <span className="text-[11px] font-bold px-2 py-1 flex-none" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: hot ? CD.flag : '#1D6B45', background: hot ? CD.flagSoft : '#E2EFE7', borderRadius: 7 }} title="Time left on the held rate">{mm}:{String(ss).padStart(2, '0')}</span>;
  }
  function Bubble({ m, pov, i }) {
    const dl = { animationDelay: Math.min((i || 0) * 35, 320) + 'ms' };
    if (m.d === 'sys') return <div className="text-center my-2 tg-bub" style={dl}><span className="text-[10px] px-2 py-1" style={{ color: CD.faint, background: CD.lineSoft, borderRadius: 999, fontFamily: 'Space Mono, monospace' }}>{m.t}</span></div>;
    const cust = pov === 'customer';
    const right = cust ? m.d === 'in' : m.d === 'out';
    const bg = right ? (cust ? '#2E7D46' : CD.ink) : (cust ? '#ECE9E2' : 'var(--cd-panel)');
    const col = right ? 'var(--cd-on-ink, #fff)' : CD.ink;
    return (<div className="tg-bub" style={{ display: 'flex', justifyContent: right ? 'flex-end' : 'flex-start', marginBottom: 7, ...dl }}>
      <div style={{ maxWidth: '82%', padding: '7px 11px', fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: bg, color: col, border: right || cust ? 'none' : `1px solid ${CD.line}`, borderRadius: right ? '13px 13px 4px 13px' : '13px 13px 13px 4px' }}>{m.t}</div>
    </div>);
  }
  const dashBtn = { border: `1px dashed ${CD.line}`, color: CD.mute, borderRadius: 8, background: 'transparent' };
  const cardSty = { background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11 };

  /* ===================== REQUESTS ===================== */
  function RedeemBar({ reqs, onFound }) {
    const [v, setV] = useState(''); const [err, setErr] = useState(false);
    const go = () => { const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const q = norm(v); if (!q) return; const digits = q.replace(/[^0-9]/g, ''); let r = reqs.find(x => norm(x.ref) === q); if (!r && digits.length >= 2) r = reqs.find(x => norm(x.ref).endsWith(digits)); if (r) { setErr(false); setV(''); onFound(r.id); } else setErr(true); };
    return (<div className="flex items-center gap-3 p-3 mb-3" style={{ background: ACCSOFT, border: `1px solid #E0CCBE`, borderRadius: 11 }}>
      <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: '#fff' }}><Ic n="search" s={16} c={ACC} /></span>
      <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>Customer at the counter?</div><div className="text-[11px]" style={{ color: CD.mute }}>Ask for the ref in their text — it pulls up their held rate, even if the board has moved.</div></div>
      {err && <span className="text-[11px] flex-none" style={{ color: CD.flag }}>No request with that ref</span>}
      <input value={v} onChange={e => { setV(e.target.value); setErr(false); }} onKeyDown={e => { if (e.key === 'Enter') go(); }} placeholder="TQ-1044" className="outline-none text-[13px] px-3 py-2 flex-none" style={{ border: `1px solid ${err ? CD.flag : '#E0CCBE'}`, borderRadius: 8, fontFamily: 'Space Mono, monospace', width: 120, background: '#fff', letterSpacing: '0.03em' }} />
      <button onClick={go} className="px-3.5 py-2 text-[12px] font-semibold text-white flex-none tg-send" style={{ background: CD.ink, borderRadius: 8 }}>Open</button>
    </div>);
  }
  function Requests({ reqs, tg, setTg, acts, openId, setOpenId, onStartTx, contacts }) {
    const [filter, setFilter] = useState('waiting');
    const counts = useMemo(() => { const c = { waiting: 0, active: 0, done: 0, all: reqs.length }; reqs.forEach(r => { if (r.status === 'new' || r.status === 'order_new') c.waiting++; else if (ACTIVE_ST.includes(r.status)) c.active++; else c.done++; }); return c; }, [reqs]);
    const list = reqs.filter(r => filter === 'all' ? true : filter === 'waiting' ? (r.status === 'new' || r.status === 'order_new') : filter === 'active' ? ACTIVE_ST.includes(r.status) : ['collected', 'closed', 'expired'].includes(r.status));
    const FILTERS = [['waiting', 'Needs reply', counts.waiting], ['active', 'Active', counts.active], ['done', 'Done', counts.done], ['all', 'All', counts.all]];
    const openReq = openId ? reqs.find(r => r.id === openId) : null;
    return (<div className="p-4">
      <RedeemBar reqs={reqs} onFound={setOpenId} />
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(([id, label, n]) => <button key={id} onClick={() => setFilter(id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${filter === id ? 'transparent' : CD.line}`, background: filter === id ? CD.ink : 'transparent', color: filter === id ? 'var(--cd-on-ink)' : CD.mute }}>{label}{n > 0 && <span className="text-[10px] px-1 py-0.5" style={{ background: filter === id ? 'var(--cd-on-ink-faint)' : CD.lineSoft, borderRadius: 4, fontFamily: 'Space Mono' }}>{n}</span>}</button>)}
        </div>
        <div className="flex items-center gap-2.5">
          <label className="flex items-center gap-2 text-[12px]" style={{ color: CD.mute }} title="New website quote requests are answered instantly at the live board rate — no teller tap needed."><Toggle small on={tg.autoQuote} click={() => setTg({ autoQuote: !tg.autoQuote })} />Auto-quote</label>
          <button onClick={() => acts.simulate('quote')} className="text-[11px] px-2.5 py-1.5" style={dashBtn} title="Prototype only — injects a request as if a customer used the website widget">▸ Simulate: quote</button>
          <button onClick={() => acts.simulate('order')} className="text-[11px] px-2.5 py-1.5" style={dashBtn} title="Prototype only — injects a currency order from the website">▸ order</button>
        </div>
      </div>
      <div className="space-y-2">
        {list.map(r => { const m = STATUS_META[r.status]; const isOrder = r.kind === 'order'; const nm = r.name || (((contacts || []).find(c => c.name && phDigits(c.phone) === phDigits(r.phone)) || {}).name || ''); return (
          <button key={r.id} onClick={() => setOpenId(r.id)} className="w-full text-left p-3 flex items-center gap-3" style={cardSty}>
            <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, borderRadius: '50%', background: m.s }}><Ic n={isOrder ? 'globe' : 'smartphone'} s={17} c={m.c} /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{r.phone}</span>
                {nm && <span className="text-[12px]" style={{ color: CD.mute }}>{nm}</span>}
                <span className="text-[10px] px-1.5 py-0.5" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 4, fontFamily: 'Space Mono' }} title="Pickup branch">{r.br || r.site}</span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{r.ref} · {num(r.amount)} {r.ccy}{isOrder ? (r.status === 'order_placed' ? ` · arriving ~${r.etaDays || 2} business days` : ' · currency order') : (r.rate ? ` → $${num(r.total)} CAD @ ${r.rate.toFixed(4)}` : ' · awaiting quote')}</div>
            </div>
            <div className="flex items-center gap-2 flex-none">
              {r.status === 'held' && r.holdUntil && <HoldClock until={r.holdUntil} />}
              <Pill s={r.status} />
              <span className="text-[10px] w-12 text-right" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>{ago(r.at)}</span>
            </div>
          </button>); })}
        {!list.length && <div className="text-center py-14" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="smartphone" s={26} c={CD.faint} /><div className="mt-2 text-sm font-medium" style={{ color: CD.ink }}>Nothing here</div><div className="text-[12px] mt-0.5">Quote requests and currency orders from your websites land in this inbox.</div></div>}
      </div>
      {openReq && <RequestModal r={openReq} tg={tg} acts={acts} onStartTx={onStartTx} contacts={contacts} onClose={() => setOpenId(null)} />}
    </div>);
  }
  function RequestModal({ r, tg, acts, onStartTx, contacts, onClose }) {
    const scroller = useRef(null);
    const [sending, setSending] = useState(false);
    const [etaD, setEtaD] = useState(r.etaDays || 2);
    const [rateEdit, setRateEdit] = useState(false);
    const [manRate, setManRate] = useState('');
    useEffect(() => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [r.thread.length]);
    const liveRate = sellRate(r.ccy), liveTotal = Math.round(r.amount * liveRate * 100) / 100;
    const press = (fn) => { if (sending) return; setSending(true); setTimeout(() => { fn(); setSending(false); }, 650); };
    const m = STATUS_META[r.status];
    const isOrder = r.kind === 'order';
    const nm = r.name || (((contacts || []).find(c => c.name && phDigits(c.phone) === phDigits(r.phone)) || {}).name || '');
    return ReactDOM.createPortal(<div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: 'rgba(23,20,15,.45)' }} onClick={onClose}>
      <div className="flex flex-col w-full" style={{ maxWidth: 540, maxHeight: '84vh', background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(23,20,15,.35)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 p-3.5 flex-none" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 36, height: 36, borderRadius: '50%', background: m.s }}><Ic n={isOrder ? 'globe' : 'smartphone'} s={16} c={m.c} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{nm ? <span style={{ fontFamily: 'Archivo' }}>{nm}</span> : r.phone}{nm ? <span className="font-normal" style={{ color: CD.mute }}> · {r.phone}</span> : null}</div>
            <div className="text-[11px]" style={{ color: CD.mute }}>{r.ref} · {r.br ? r.br + ' branch' : r.site} · {num(r.amount)} {r.ccy}{isOrder ? ' · order' : ''}</div>
          </div>
          {r.status === 'held' && r.holdUntil && <HoldClock until={r.holdUntil} />}
          <Pill s={r.status} />
          <button onClick={onClose} className="p-1.5" style={{ borderRadius: 7 }} title="Close"><span style={{ display: 'inline-flex', transform: 'rotate(45deg)' }}><Ic n="plus" s={16} c={CD.mute} /></span></button>
        </div>
        <div ref={scroller} className="flex-1 overflow-auto p-4" style={{ background: CD.paper }}>{r.thread.map((msg, i) => <Bubble key={i} m={msg} pov="desk" i={i} />)}</div>
        <div className="p-3.5 flex-none" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
          {r.status === 'new' && (() => {
            const mid = boardRate(r.ccy);
            const hand = manRate !== '' && +manRate > 0;
            const qRate = hand ? +(+manRate).toFixed(4) : liveRate;
            const qTotal = Math.round(r.amount * qRate * 100) / 100;
            const qMargin = Math.round((qTotal - r.amount * mid) * 100) / 100;
            const pct = mid > 0 ? ((qRate / mid) - 1) * 100 : 0;
            const cell = (l, v, s, vc) => (<div className="px-2.5 py-2" style={{ background: CD.paper, border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
              <div className="text-[9px] uppercase" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>{l}</div>
              <div className="text-[13.5px] font-bold mt-0.5" style={{ color: vc || CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
              <div className="text-[9px] mt-0.5" style={{ color: CD.faint }}>{s}</div>
            </div>);
            return (<div>
            <div className="grid grid-cols-4 gap-2 mb-2.5">
              {cell('They get', num(r.amount) + ' ' + r.ccy, 'cash to have ready')}
              <div className="px-2.5 py-2" style={{ background: CD.paper, border: `1px solid ${hand ? '#E0CCBE' : CD.lineSoft}`, borderRadius: 9, position: 'relative' }}>
                <div className="text-[9px] uppercase" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>Your rate</div>
                <div className="text-[13.5px] font-bold mt-0.5" style={{ color: hand ? ACC : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{qRate.toFixed(4)}</div>
                <div className="text-[9px] mt-0.5" style={{ color: pct < 0 ? CD.flag : CD.faint }}>{hand ? 'hand-priced · ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% vs mid' : 'mid ' + mid.toFixed(4) + ' · +1.75%'}</div>
                <button onClick={() => setRateEdit(e => !e)} title="Adjust the quoted rate" className="grid place-items-center" style={{ position: 'absolute', top: 5, right: 5, width: 18, height: 18, borderRadius: 5, background: rateEdit || hand ? ACCSOFT : 'transparent', border: `1px solid ${rateEdit || hand ? '#E0CCBE' : 'transparent'}` }}><Ic n="pencil" s={10} c={rateEdit || hand ? ACC : CD.faint} /></button>
                {rateEdit && <div className="p-2.5" style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, width: 196, background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 9, boxShadow: '0 12px 28px rgba(23,20,15,.18)', zIndex: 20 }}>
                  <div className="text-[10px] mb-1" style={{ color: CD.mute }}>Quote this deal at</div>
                  <input autoFocus value={manRate} onChange={e => setManRate(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setRateEdit(false); }} inputMode="decimal" placeholder={liveRate.toFixed(4)} className="w-full outline-none text-[13px] px-2 py-1.5 text-right" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums' }} />
                  <div className="flex gap-1 mt-1.5">
                    {[['Board', ''], ['+1%', (mid * 1.01).toFixed(4)], ['+2.5%', (mid * 1.025).toFixed(4)]].map(([l, v]) => <button key={l} onClick={() => setManRate(v)} className="flex-1 px-1 py-1 text-[10px]" style={{ border: `1px dashed ${CD.line}`, borderRadius: 6, color: CD.mute, background: 'transparent' }}>{l}</button>)}
                  </div>
                  <div className="text-[9px] mt-1.5" style={{ color: pct < 0 ? CD.flag : CD.faint }}>{pct < 0 ? 'Below mid — you lose on this deal.' : pct.toFixed(2) + '% over mid · margin $' + num(qMargin)}</div>
                  <button onClick={() => setRateEdit(false)} className="w-full mt-1.5 py-1.5 text-[11px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 7 }}>Done</button>
                </div>}
              </div>
              {cell('They pay', '$' + num(qTotal), 'CAD at the counter')}
              {cell('Your margin', (qMargin >= 0 ? '+$' : '−$') + num(Math.abs(qMargin)), 'if they collect', qMargin >= 0 ? '#1D6B45' : CD.flag)}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => press(() => acts.quote(r.id, hand ? qRate : null))} disabled={sending} className="tg-send flex-1 flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-[13px] font-semibold text-white" style={{ background: sending ? '#1D6B45' : CD.ink, borderRadius: 9 }}>
                {sending
                  ? <span className="flex items-center gap-2"><span className="tg-plane inline-flex"><Ic n="send" s={14} c="var(--cd-on-ink)" /></span>Sending to {r.phone}<span className="inline-flex items-center gap-1 ml-0.5"><i className="tg-dot"></i><i className="tg-dot"></i><i className="tg-dot"></i></span></span>
                  : <span className="flex items-center gap-2"><Ic n="send" s={14} c="var(--cd-on-ink)" />Text this quote — a Y holds it for {tg.holdMins} min</span>}
              </button>
              <button onClick={() => acts.dismiss(r.id)} className="px-3 py-2.5 text-[12px]" style={dashBtn}>Dismiss</button>
            </div>
          </div>); })()}
          {r.status === 'order_new' && (<div>
            <div className="flex items-center gap-2 mb-2.5 px-3 py-2.5" style={{ background: CD.paper, border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
              <Ic n="globe" s={15} c={ACC} />
              <span className="text-[12px] flex-1" style={{ color: CD.mute }}>They want <b style={{ color: CD.ink }}>{num(r.amount)} {r.ccy}</b> — not board stock. Priced on the day it arrives; check your wholesaler before confirming.</span>
              <label className="flex items-center gap-1.5 text-[11px] flex-none" style={{ color: CD.mute }}>ETA<input type="number" min="1" max="10" value={etaD} onChange={e => setEtaD(Math.max(1, Math.min(10, +e.target.value || 2)))} className="w-11 text-center outline-none py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontFamily: 'Space Mono', fontSize: 11 }} />days</label>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => press(() => acts.placeOrder(r.id, etaD))} disabled={sending} className="tg-send flex-1 flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-[13px] font-semibold text-white" style={{ background: sending ? '#1D6B45' : CD.ink, borderRadius: 9 }}>
                {sending ? <span className="flex items-center gap-2"><span className="tg-plane inline-flex"><Ic n="send" s={14} c="var(--cd-on-ink)" /></span>Sending<span className="inline-flex items-center gap-1 ml-0.5"><i className="tg-dot"></i><i className="tg-dot"></i><i className="tg-dot"></i></span></span>
                  : <span className="flex items-center gap-2"><Ic n="send" s={14} c="var(--cd-on-ink)" />Place the order — text them the ETA</span>}
              </button>
              <button onClick={() => acts.dismiss(r.id)} className="px-3 py-2.5 text-[12px]" style={dashBtn}>Can’t source it</button>
            </div>
          </div>)}
          {r.status === 'order_placed' && <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>Arriving in ~{r.etaDays || 2} business days — the pickup text fires the moment you mark it in.</span>
            <button onClick={() => acts.arrived(r.id)} className="px-3 py-1.5 text-[12px]" style={dashBtn}>▸ Simulate: stock arrived</button>
          </div>}
          {r.status === 'order_arrived' && <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>In stock and they’ve been texted — key <b style={{ fontFamily: 'Space Mono' }}>{r.ref}</b> into the transaction when they arrive.</span>
            {onStartTx && <button onClick={() => { onClose(); onStartTx(r.ref); }} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}>Start transaction</button>}
            <button onClick={() => acts.collect(r.id)} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: '#1D6B45', borderRadius: 8 }}>Mark collected</button>
          </div>}
          {r.status === 'quoted' && (() => { const drift = r.rate ? ((liveRate - r.rate) / r.rate) * 100 : 0; return (<div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>Quoted at <b style={{ color: CD.mute, fontFamily: 'Space Mono' }}>{r.rate.toFixed(4)}</b> · board since: <b style={{ color: Math.abs(drift) >= 0.35 ? '#8F6410' : CD.mute, fontFamily: 'Space Mono' }}>{(drift >= 0 ? '+' : '') + drift.toFixed(2)}%</b> · expires end of day</span>
            <span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>simulate reply:</span>
            <button onClick={() => acts.reply(r.id, 'Y')} className="px-3 py-1.5 text-[12px] font-bold" style={dashBtn}>Y — hold it</button>
            <button onClick={() => acts.reply(r.id, 'N')} className="px-3 py-1.5 text-[12px]" style={dashBtn}>N — pass</button>
          </div>); })()}
          {r.status === 'held' && (() => { const lockedMid = r.rate ? r.rate / 1.0175 : 0; const lm = Math.round(((r.total || 0) - r.amount * lockedMid) * 100) / 100; return (<div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>Held until {r.holdUntil ? hhmm(r.holdUntil) : '—'} · margin <b style={{ color: '#1D6B45' }}>+${num(lm)}</b> · when they arrive, key <b style={{ fontFamily: 'Space Mono' }}>{r.ref}</b> into the new transaction — the held rate applies, not the board</span>
            {tg.verifyStep && <button onClick={() => acts.verify(r.id)} className="px-3 py-1.5 text-[12px]" style={dashBtn}>▸ Simulate ID verified</button>}
            {onStartTx && <button onClick={() => { onClose(); onStartTx(r.ref); }} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}>Start transaction</button>}
            <button onClick={() => acts.collect(r.id)} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: '#1D6B45', borderRadius: 8 }}>Mark collected</button>
          </div>); })()}
          {r.status === 'verified' && <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>ID verified — key <b style={{ fontFamily: 'Space Mono' }}>{r.ref}</b> into the transaction at the counter.</span>
            {onStartTx && <button onClick={() => { onClose(); onStartTx(r.ref); }} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}>Start transaction</button>}
            <button onClick={() => acts.collect(r.id)} className="tg-send px-3.5 py-2 text-[12px] font-semibold text-white" style={{ background: '#1D6B45', borderRadius: 8 }}>Mark collected</button>
          </div>}
          {r.status === 'expired' && <div className="flex items-center gap-2">
            <span className="text-[11px] flex-1" style={{ color: CD.faint }}>The hold lapsed without a visit.</span>
            <button onClick={() => acts.quote(r.id)} className="px-3.5 py-2 text-[12px] font-semibold" style={{ background: ACCSOFT, color: ACC, borderRadius: 8 }}>Send a fresh quote at {liveRate.toFixed(4)}</button>
          </div>}
          {(r.status === 'collected' || r.status === 'closed') && <div className="text-[11px]" style={{ color: CD.faint }}>Thread closed. The number stays in Contacts{r.status === 'collected' ? ' with express consent' : ''}.</div>}
        </div>
      </div>
    </div>, document.body);
  }

  /* ===================== JOURNEY ===================== */
  function Trig({ kind }) { const M = { auto: ['AUTO', '#8A4B2F', '#F2E6DD'], teller: ['TELLER TAP', '#274B8E', '#E6EBF5'], reply: ['ON REPLY', '#1D6B45', '#E2EFE7'], timer: ['TIMER', '#8F6410', '#F5ECD7'] }; const [l, c, s] = M[kind] || M.auto; return <span className="text-[8.5px] px-1.5 py-0.5 font-bold flex-none" style={{ background: s, color: c, borderRadius: 4, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>{l}</span>; }
  function Step({ n, title, trig, trigKind, on, toggle, children }) {
    return (<div className="flex gap-3">
      <div className="flex flex-col items-center flex-none">
        <span className="grid place-items-center text-[12px] font-bold" style={{ width: 26, height: 26, borderRadius: '50%', background: on === false ? CD.lineSoft : ACC, color: on === false ? CD.faint : '#fff', fontFamily: 'Space Mono, monospace' }}>{n}</span>
        <span className="flex-1 my-1" style={{ width: 2, background: CD.lineSoft }}></span>
      </div>
      <div className="flex-1 min-w-0 pb-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[13px] font-semibold flex-none" style={{ color: on === false ? CD.faint : CD.ink }}>{title}</span>
          <Trig kind={trigKind} />
          <span className="text-[11px] flex-1 truncate" style={{ color: CD.faint }}>{trig}</span>
          {toggle}
        </div>
        {on !== false && children}
      </div>
    </div>);
  }
  function MsgEditor({ v, onChange, fields, ctx }) {
    const [edit, setEdit] = useState(false);
    return (<div>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0" style={{ background: '#ECE9E2', color: CD.ink, padding: '7px 11px', fontSize: 12, lineHeight: 1.45, borderRadius: '13px 13px 13px 4px', whiteSpace: 'pre-wrap' }}>{render(v, ctx)}</div>
        <button onClick={() => setEdit(e => !e)} className="px-2 py-1 text-[10px] flex-none" style={{ border: `1px dashed ${CD.line}`, color: edit ? CD.ink : CD.mute, borderRadius: 6, background: edit ? CD.lineSoft : 'transparent' }}>{edit ? 'Done' : 'Edit'}</button>
      </div>
      {edit && <div className="mt-1.5"><TplBox v={v} onChange={onChange} fields={fields} /></div>}
    </div>);
  }
  function TplBox({ v, onChange, fields }) {
    return (<div>
      <textarea value={v} onChange={e => onChange(e.target.value)} rows={2} className="w-full outline-none p-2.5 text-[12px]" style={{ fontFamily: 'Space Mono, monospace', lineHeight: 1.5, background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 8, resize: 'vertical', color: CD.ink }} />
      <div className="flex items-center gap-1 flex-wrap mt-1"><span className="text-[10px]" style={{ color: CD.faint }}>Fields:</span>{fields.map(f => <span key={f} className="text-[10px] px-1.5 py-0.5" style={{ background: ACCSOFT, color: ACC, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>{'{' + f + '}'}</span>)}<span className="text-[10px]" style={{ color: CD.faint }}>· {segsOf(v)} segment{segsOf(v) > 1 ? 's' : ''}</span></div>
    </div>);
  }
  function MiniJourney({ on, toggle, title, tag, sub, children }) {
    return (<div className="p-3 mb-3 flex items-start gap-3" style={cardSty}>
      <Toggle small on={on} click={toggle} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2"><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{title}</span>{tag && <span className="text-[9px] px-1.5 py-0.5 font-bold" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 4, fontFamily: 'Space Mono' }}>{tag}</span>}</div>
        <div className="text-[11px] mb-1.5" style={{ color: CD.mute }}>{sub}</div>
        {on && children}
      </div>
    </div>);
  }
  function Journey({ tg, setTg, setTpl }) {
    const ctx = useMemo(() => { const rate = sellRate('USD'); const until = Date.now() + tg.holdMins * 60000; return { desk: tg.desk, amount: '1,000', ccy: 'USD', total: num(Math.round(1000 * rate * 100) / 100), rate: rate.toFixed(4), mins: tg.holdMins, ref: 'TQ-1047', time: hhmm(until), link: 'desk.cd/v/tq-1047', site: 'yorkfx.ca', days: 2 }; }, [tg]);
    const preview = useMemo(() => { const msgs = [out(render(tg.tpl.quote, ctx)), inn('Y'), out(render(tg.tpl.hold, ctx))]; if (tg.verifyStep) { msgs.push(out(render(tg.tpl.verify, ctx)), sys('ID verified via secure link · Persona'), out(render(tg.tpl.ready, ctx))); } if (tg.nudge) msgs.push(out(render(tg.tpl.nudge, ctx))); return msgs; }, [tg, ctx]);
    return (<div className="p-4 grid gap-5" style={{ gridTemplateColumns: 'minmax(0,1fr) 296px' }}>
      <div>
        <div className="mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>The text-a-quote journey</div><div className="text-[11px]" style={{ color: CD.mute }}>What happens after someone requests a quote on your website. Every message is yours to edit.</div></div>
        <Step n="1" title="Quote" trigKind={tg.autoQuote ? 'auto' : 'teller'} trig={tg.autoQuote ? 'sends itself at the live board rate' : 'teller approves each one — flip Auto-quote in Requests'}>
          <MsgEditor v={tg.tpl.quote} onChange={v => setTpl('quote', v)} fields={['desk', 'amount', 'ccy', 'total', 'rate', 'mins']} ctx={ctx} />
        </Step>
        <Step n="2" title="Hold confirmation" trigKind="reply" trig="they replied Y — the ref redeems the rate at the counter" toggle={<label className="flex items-center gap-1.5 text-[11px]" style={{ color: CD.mute }}>Hold for<input type="number" min="5" max="120" value={tg.holdMins} onChange={e => setTg({ holdMins: Math.max(5, Math.min(120, +e.target.value || 30)) })} className="w-12 text-center outline-none py-0.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 6, fontFamily: 'Space Mono', fontSize: 11 }} />min</label>}>
          <MsgEditor v={tg.tpl.hold} onChange={v => setTpl('hold', v)} fields={['rate', 'time', 'ref']} ctx={ctx} />
        </Step>
        <Step n="3" title="ID verify invite" trigKind="auto" trig="rides along with the hold — Persona link, billed per check" on={tg.verifyStep} toggle={<Toggle small on={tg.verifyStep} click={() => setTg({ verifyStep: !tg.verifyStep })} />}>
          <MsgEditor v={tg.tpl.verify} onChange={v => setTpl('verify', v)} fields={['link']} ctx={ctx} />
        </Step>
        <Step n="4" title="Ready confirmation" trigKind="auto" trig="their ID clears" on={tg.verifyStep}>
          <MsgEditor v={tg.tpl.ready} onChange={v => setTpl('ready', v)} fields={['ref', 'time']} ctx={ctx} />
        </Step>
        <Step n="5" title="Expiry reminder" trigKind="timer" trig="10 minutes before the hold lapses" on={tg.nudge} toggle={<Toggle small on={tg.nudge} click={() => setTg({ nudge: !tg.nudge })} />}>
          <MsgEditor v={tg.tpl.nudge} onChange={v => setTpl('nudge', v)} fields={['ref']} ctx={ctx} />
        </Step>
        <div className="p-3 mb-3" style={cardSty}>
          <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: CD.mute }}>
            <span className="font-semibold" style={{ color: CD.ink }}>Replies we handle:</span>
            {[['Y', 'holds the rate'], ['N', 'closes politely'], ['STOP', 'opts out — always on']].map(([k, v]) => <span key={k} className="flex items-center gap-1"><b className="px-1.5 py-0.5 text-[10px]" style={{ background: CD.lineSoft, borderRadius: 4, fontFamily: 'Space Mono', color: CD.ink }}>{k}</b>{v}</span>)}
          </div>
          <div className="text-[10px] mt-1.5" style={{ color: CD.faint }}>STOP is honoured instantly and logged in Contacts — required under CASL. Anything else gets a polite “text Y, N or call us” fallback.</div>
        </div>
        <MiniJourney on={!!tg.orders} toggle={() => setTg({ orders: !tg.orders })} title="Currency orders" sub="For currencies you don’t keep in the till — the widget offers “order ahead”, you confirm sourcing, and these two texts run the flow. Priced on arrival day.">
          <MsgEditor v={tg.tpl.orderq} onChange={v => setTpl('orderq', v)} fields={['desk', 'amount', 'ccy', 'days', 'ref']} ctx={{ ...ctx, ref: 'TO-2013', amount: '20,000', ccy: 'ZAR' }} />
          <div className="mt-2"><MsgEditor v={tg.tpl.orderready} onChange={v => setTpl('orderready', v)} fields={['desk', 'ccy', 'ref', 'rate']} ctx={{ ...ctx, ref: 'TO-2013', ccy: 'ZAR', rate: 'today’s posted rate' }} /></div>
        </MiniJourney>
        <MiniJourney on={!!tg.pickup} toggle={() => setTg({ pickup: !tg.pickup })} title="Pickup alerts" tag="PRO" sub="When a transfer or cheque is marked ready, text the customer. Fires from the Transfers & Cheques apps.">
          <MsgEditor v={tg.tpl.pickup} onChange={v => setTpl('pickup', v)} fields={['desk', 'ref']} ctx={{ ...ctx, ref: 'TR-4402' }} />
        </MiniJourney>
        <MiniJourney on={tg.aftersale !== false} toggle={() => setTg({ aftersale: !(tg.aftersale !== false) })} title="After the sale" tag="PRO" sub="A thank-you text when a deal posts in the Ledger for a customer with a mobile on file — keeps your number in their phone for next time.">
          <MsgEditor v={tg.tpl.aftersale} onChange={v => setTpl('aftersale', v)} fields={['desk', 'site']} ctx={ctx} />
        </MiniJourney>
      </div>
      <div>
        <div style={{ position: 'sticky', top: 12 }}>
          <div className="mx-auto cd-lightsurface" style={{ width: 272, background: '#fff', border: `1px solid ${CD.line}`, borderRadius: 30, boxShadow: '0 14px 34px rgba(23,20,15,.14)', overflow: 'hidden' }}>
            <div className="text-center pt-3 pb-2" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
              <div className="text-[12px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{tg.from}</div>
              <div className="text-[9px]" style={{ color: CD.faint }}>Text message · today {hhmm(Date.now())}</div>
            </div>
            <div className="p-3" style={{ minHeight: 340, background: '#FCFBF8' }}>{preview.map((m, i) => <Bubble key={i} m={m} pov="customer" i={i} />)}</div>
            <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <span className="flex-1 text-[10px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 999, color: CD.faint }}>Text message</span>
              <span className="grid place-items-center" style={{ width: 22, height: 22, borderRadius: '50%', background: CD.lineSoft }}><Ic n="arrowright" s={12} c={CD.faint} /></span>
            </div>
          </div>
          <div className="text-[10px] text-center mt-2" style={{ color: CD.faint }}>Live preview — exactly what your customer receives, at today’s board rate.</div>
        </div>
      </div>
    </div>);
  }

  /* ===================== BROADCASTS ===================== */
  function Broadcasts({ tg, bcasts, contacts, onSend }) {
    const [body, setBody] = useState('');
    const [aud, setAud] = useState('all');
    const [whoId, setWhoId] = useState(null);
    const [q, setQ] = useState('');
    const [flash, setFlash] = useState(false);
    const pool = contacts.filter(c => !c.stopped);
    const who = pool.find(c => c.id === whoId) || null;
    const results = q.trim() && !who ? pool.filter(c => (c.phone + ' ' + (c.name || '')).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5) : [];
    const n = aud === 'all' ? tg.audience : (who ? 1 : 0);
    const segs = segsOf(body + (aud === 'all' ? ' Reply STOP to opt out.' : ''));
    const cost = Math.round(Math.max(1, n) * segs * 0.0075 * 100) / 100;
    const starters = [
      ['Rate move', tg.desk + ': USD just moved — ' + sellRate('USD').toFixed(4) + ' at our counter right now. First come, first served. 128 Yonge St, open 9–6.'],
      ['Today’s board', tg.desk + ': today — USD ' + sellRate('USD').toFixed(4) + ' · EUR ' + sellRate('EUR').toFixed(4) + ' · GBP ' + sellRate('GBP').toFixed(4) + '. Live at yorkfx.ca.'],
      ['Hours', tg.desk + ': a heads-up — special hours this weekend. Sat 10–4, closed Monday. Rates hold on yorkfx.ca.']
    ];
    const toLabel = aud === 'all' ? num(tg.audience) + ' subscribers' : who ? (who.name ? who.name + ' (' + who.phone + ')' : who.phone) : '';
    const send = () => { if (!body.trim() || !n || flash) return; onSend(body.trim(), n, cost, toLabel, aud); setBody(''); setFlash(true); setTimeout(() => setFlash(false), 1800); };
    return (<div className="p-4" style={{ maxWidth: 640 }}>
      <div className="p-3.5 mb-4" style={cardSty}>
        <div className="text-sm font-semibold mb-1" style={{ color: CD.ink }}>New message</div>
        <div className="flex items-center gap-2 mb-2.5">
          <div className="flex flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
            {[['all', 'All subscribers · ' + num(tg.audience)], ['one', 'One person']].map(([id, l]) => <button key={id} onClick={() => { setAud(id); setWhoId(null); setQ(''); }} className="px-3 py-1.5 text-[12px] font-medium" style={{ background: aud === id ? CD.ink : 'transparent', color: aud === id ? 'var(--cd-on-ink)' : CD.mute }}>{l}</button>)}
          </div>
          {aud === 'one' && (who
            ? <span className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5" style={{ background: ACCSOFT, color: ACC, borderRadius: 8, fontFamily: 'Space Mono, monospace' }}>{who.name || who.phone}<button onClick={() => { setWhoId(null); setQ(''); }} title="Change" style={{ display: 'inline-flex', transform: 'rotate(45deg)' }}><Ic n="plus" s={13} c={ACC} /></button></span>
            : <div className="relative flex-1 min-w-0">
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Name or number…" className="w-full outline-none text-[12px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }} />
                {results.length > 0 && <div className="absolute left-0 right-0 mt-1 z-10" style={{ ...cardSty, overflow: 'hidden', boxShadow: '0 10px 26px rgba(23,20,15,.18)' }}>
                  {results.map(c => <button key={c.id} onClick={() => { setWhoId(c.id); setQ(''); }} className="w-full text-left px-3 py-2 flex items-center gap-2" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><span className="text-[12px] font-bold" style={{ fontFamily: 'Space Mono, monospace', color: CD.ink }}>{c.phone}</span><span className="text-[11px]" style={{ color: CD.mute }}>{c.name || '—'}</span></button>)}
                </div>}
              </div>)}
        </div>
        <div className="flex items-center gap-1.5 mb-2 flex-wrap"><span className="text-[10px]" style={{ color: CD.faint }}>Start from:</span>{starters.map(([l, t]) => <button key={l} onClick={() => setBody(t)} className="px-2 py-1 text-[10.5px]" style={dashBtn}>{l}</button>)}</div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder={'e.g. ' + tg.desk + ': USD at 1.3890 this morning — best rate this month. 128 Yonge St, open 9–6.'} className="w-full outline-none p-2.5 text-[12.5px]" style={{ fontFamily: 'Space Mono, monospace', lineHeight: 1.5, background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 8, resize: 'vertical', color: CD.ink }} />
        <div className="text-[10px] mt-1 mb-2" style={{ color: CD.faint }}>{aud === 'all' ? '“Reply STOP to opt out” is appended automatically. Sends wait out your quiet hours (' + tg.quietFrom + '–' + tg.quietTo + ').' : 'One-to-one service text from your desk number — their reply lands in Requests.'}</div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] flex-1" style={{ color: CD.mute }}>To <b style={{ color: CD.ink }}>{toLabel || 'pick a contact'}</b> · {segs} segment{segs > 1 ? 's' : ''} · ~${cost.toFixed(2)}</span>
          <button onClick={send} disabled={!body.trim() || !n || flash} className="tg-send flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-white" style={{ background: flash ? '#1D6B45' : CD.ink, borderRadius: 9, opacity: (body.trim() && n) || flash ? 1 : 0.4 }}><Ic n="send" s={14} c="var(--cd-on-ink)" />{flash ? 'Sent' : aud === 'all' ? 'Send to ' + num(tg.audience) : 'Send'}</button>
        </div>
      </div>
      <div className="text-[11px] font-semibold mb-2" style={{ color: CD.mute, letterSpacing: '0.04em', textTransform: 'uppercase', fontFamily: 'Space Mono, monospace' }}>Sent</div>
      <div className="space-y-2">
        {bcasts.map(b => (<div key={b.id} className="p-3" style={cardSty}>
          <div className="flex items-center gap-2 mb-1"><span className="text-[11px] font-semibold" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{b.at}</span><span className="text-[10px]" style={{ color: CD.faint }}>to {b.to || num(b.n) + ' subscribers'} · ${(+b.cost).toFixed(2)}</span><span className="text-[10px] ml-auto px-1.5 py-0.5" style={{ background: '#E2EFE7', color: '#1D6B45', borderRadius: 4, fontFamily: 'Space Mono' }}>Delivered</span></div>
          <div className="text-[12px]" style={{ color: CD.mute, lineHeight: 1.5 }}>{b.body}</div>
        </div>))}
      </div>
    </div>);
  }

  /* ===================== CONTACTS ===================== */
  function Contacts({ contacts, setContacts, tg, log }) {
    const [q, setQ] = useState('');
    const [adding, setAdding] = useState(false);
    const [np, setNp] = useState(''); const [nn, setNn] = useState(''); const [nc, setNc] = useState('express');
    const shown = contacts.filter(c => !q || (c.phone + ' ' + (c.name || '')).toLowerCase().includes(q.toLowerCase()));
    const stops = contacts.filter(c => c.stopped).length;
    const add = () => { if (!np.trim()) return; setContacts(l => [{ id: 'c' + Date.now(), phone: np.trim(), name: nn.trim(), consent: nc, src: 'In-store', since: 'Today' }, ...l]); setNp(''); setNn(''); setAdding(false); log && log('Contact added', np.trim()); };
    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>{num(tg.audience)} opted in{stops ? ` · ${stops} opted out` : ''}</div><div className="text-[11px]" style={{ color: CD.mute }}>Most recent below. Numbers join from website quotes or at the counter.</div></div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="search" s={14} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="outline-none text-[12px] bg-transparent" style={{ width: 130 }} /></div>
          <button onClick={() => setAdding(a => !a)} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="plus" s={13} c="var(--cd-on-ink)" /> New</button>
        </div>
      </div>
      {adding && <div className="p-3 mb-3 flex items-center gap-2 flex-wrap" style={{ ...cardSty, borderStyle: 'dashed' }}>
        <input value={np} onChange={e => setNp(e.target.value)} placeholder="+1 416 555 0100" className="outline-none text-[12px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono', width: 150 }} />
        <input value={nn} onChange={e => setNn(e.target.value)} placeholder="Name (optional)" className="outline-none text-[12px] px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, width: 140 }} />
        <div className="flex" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, overflow: 'hidden' }}>{[['express', 'Express consent'], ['implied', 'Implied']].map(([id, l]) => <button key={id} onClick={() => setNc(id)} className="px-2.5 py-1.5 text-[11px]" style={{ background: nc === id ? CD.ink : 'transparent', color: nc === id ? 'var(--cd-on-ink)' : CD.mute }}>{l}</button>)}</div>
        <button onClick={add} className="px-3 py-1.5 text-[12px] font-semibold text-white" style={{ background: '#1D6B45', borderRadius: 7 }}>Add</button>
        <span className="text-[10px] w-full" style={{ color: CD.faint }}>Ask before you add — express consent means they said yes to hearing from you (CASL).</span>
      </div>}
      <div style={{ ...cardSty, overflow: 'hidden' }}>
        {shown.map((c, i) => (<div key={c.id} className="flex items-center gap-3 px-3 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none', opacity: c.stopped ? 0.55 : 1 }}>
          <span className="text-[12.5px] font-bold flex-none" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace', width: 150 }}>{c.phone}</span>
          <span className="text-[12px] flex-1 min-w-0" style={{ color: c.name ? CD.ink : CD.faint }}>{c.name || '—'}</span>
          <span className="text-[10px] px-1.5 py-0.5 flex-none" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 4 }}>{c.src}</span>
          {c.stopped
            ? <span className="text-[10px] px-2 py-0.5 flex-none font-semibold" style={{ background: CD.lineSoft, color: CD.faint, borderRadius: 999, fontFamily: 'Space Mono' }}>Opted out {c.stopped}</span>
            : <span className="text-[10px] px-2 py-0.5 flex-none font-semibold" style={{ background: c.consent === 'express' ? '#E2EFE7' : '#F5ECD7', color: c.consent === 'express' ? '#1D6B45' : '#8F6410', borderRadius: 999, fontFamily: 'Space Mono' }} title={c.consent === 'express' ? 'They said yes to hearing from you — broadcasts OK' : 'They contacted you first — quote replies only, no broadcasts'}>{c.consent === 'express' ? 'Express' : 'Implied'}</span>}
          <span className="text-[10px] flex-none w-12 text-right" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>{c.since}</span>
        </div>))}
        {!shown.length && <div className="text-center py-10 text-[12px]" style={{ color: CD.mute }}>No matches.</div>}
      </div>
      <div className="text-[10px] mt-2" style={{ color: CD.faint }}>Consent records are kept 3 years and export with your compliance book. Broadcasts only ever go to express opt-ins; quote replies are transactional and always allowed.</div>
    </div>);
  }

  /* ===================== HISTORY ===================== */
  function History({ logbook, tg }) {
    const [f, setF] = useState('all');
    const shown = logbook.filter(e => f === 'all' ? true : f === 'out' ? e.dir === 'out' : f === 'in' ? e.dir === 'in' : e.dir === 'sys');
    const FILTERS = [['all', 'All'], ['out', 'Sent'], ['in', 'Received'], ['sys', 'System']];
    const dirIc = (d) => d === 'out' ? 'send' : d === 'in' ? 'smartphone' : 'clock';
    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Message history</div><div className="text-[11px]" style={{ color: CD.mute }}>Every text in and out, plus system events — {num(tg.monthSent)} sent this month (~${(tg.monthSent * 0.0075).toFixed(2)}). Kept with your records.</div></div>
        <div className="flex gap-1.5">{FILTERS.map(([id, l]) => <button key={id} onClick={() => setF(id)} className="px-3 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${f === id ? 'transparent' : CD.line}`, background: f === id ? CD.ink : 'transparent', color: f === id ? 'var(--cd-on-ink)' : CD.mute }}>{l}</button>)}</div>
      </div>
      <div style={{ ...cardSty, overflow: 'hidden' }}>
        {shown.map((e, i) => (<div key={i} className="flex items-center gap-3 px-3 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
          <span className="text-[10px] flex-none" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', width: 86, fontVariantNumeric: 'tabular-nums' }}>{mdhm(e.t)}</span>
          <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: '50%', background: e.dir === 'out' ? ACCSOFT : CD.lineSoft }}><Ic n={dirIc(e.dir)} s={12} c={e.dir === 'out' ? ACC : CD.faint} /></span>
          <span className="text-[10px] px-1.5 py-0.5 flex-none font-semibold" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 4, fontFamily: 'Space Mono', width: 74, textAlign: 'center' }}>{e.kind}</span>
          <span className="text-[12px] flex-none" style={{ color: CD.ink, fontFamily: 'Space Mono, monospace', width: 140 }}>{e.to}</span>
          <span className="text-[12px] flex-1 min-w-0 truncate" style={{ color: CD.mute }}>{e.detail}</span>
          {e.dir === 'out' && <span className="text-[10px] flex-none px-1.5 py-0.5" style={{ background: '#E2EFE7', color: '#1D6B45', borderRadius: 4, fontFamily: 'Space Mono' }}>Delivered</span>}
        </div>))}
        {!shown.length && <div className="text-center py-10 text-[12px]" style={{ color: CD.mute }}>Nothing yet.</div>}
      </div>
    </div>);
  }

  /* ===================== WIDGET PREVIEW ===================== */
  function WidgetModal({ tg, onClose, onTry }) {
    const [sent, setSent] = useState(false);
    const rows = ['USD', 'EUR', 'GBP'].map(c => { const r = boardRate(c); return { c, sell: (r * 1.0175).toFixed(4), buy: (r * 0.9825).toFixed(4) }; });
    const tryIt = () => { if (sent) return; setSent(true); onTry && onTry(); };
    return ReactDOM.createPortal(<div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: 'rgba(23,20,15,.45)' }} onClick={onClose}>
      <div className="w-full" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
        <div className="cd-lightsurface" style={{ background: '#fff', border: `1px solid ${CD.line}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 24px 60px rgba(23,20,15,.35)' }}>
          <div className="px-4 py-3" style={{ background: '#17140F' }}>
            <div className="text-[13px] font-bold" style={{ color: '#fff', fontFamily: 'Space Mono, monospace', letterSpacing: '0.04em' }}>{tg.desk}</div>
            <div className="text-[10px]" style={{ color: 'rgba(255,255,255,.55)' }}>Live counter rates · updated with the board</div>
          </div>
          <div className="px-4 py-2">
            <div className="flex text-[9px] py-1" style={{ color: CD.faint, fontFamily: 'Space Mono', letterSpacing: '0.06em' }}><span className="flex-1">CCY</span><span className="w-16 text-right">WE SELL</span><span className="w-16 text-right">WE BUY</span></div>
            {rows.map(r => <div key={r.c} className="flex items-center py-1.5 text-[12px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, fontVariantNumeric: 'tabular-nums' }}><b className="flex-1" style={{ color: CD.ink, fontFamily: 'Space Mono' }}>{r.c}</b><span className="w-16 text-right" style={{ color: CD.ink }}>{r.sell}</span><span className="w-16 text-right" style={{ color: CD.mute }}>{r.buy}</span></div>)}
          </div>
          <div className="px-4 pb-4 pt-1">
            <div className="flex items-center gap-2 mb-2 text-[11px]" style={{ color: CD.mute }}>Pickup at<select className="flex-1 outline-none text-[12px] px-2 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: '#fff', color: CD.ink }}>{deskBranches().map(b => <option key={b}>{b}</option>)}</select></div>
            <div className="text-[11px] font-semibold mb-1.5" style={{ color: CD.ink }}>Get this rate by text</div>
            <div className="flex gap-2">
              <input placeholder="+1 (416) 555-0100" className="flex-1 min-w-0 outline-none text-[12px] px-2.5 py-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, fontFamily: 'Space Mono' }} />
              <button onClick={tryIt} className="tg-send px-3 py-2 text-[12px] font-semibold text-white flex-none" style={{ background: sent ? '#1D6B45' : ACC, borderRadius: 8 }}>{sent ? 'Sent — see Requests' : 'Text me this rate'}</button>
            </div>
            <div className="text-[10px] mt-2 pt-2" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.mute }}>Need a currency we don’t stock? <b>Order ahead</b> — we’ll text you the moment it arrives.</div>
            <div className="text-[9px] mt-2" style={{ color: CD.faint }}>One text with today’s quote. Reply STOP any time. Powered by CurrencyDesk.</div>
          </div>
        </div>
        <div className="text-[10px] text-center mt-2" style={{ color: 'rgba(255,255,255,.8)' }}>The widget, as it sits on a shop’s website — try the button.</div>
      </div>
    </div>, document.body);
  }

  /* ===================== SETTINGS › TEXTS (lives in the Settings app) ===================== */
  function SetRow({ title, desc, children }) { return (<div className="flex items-center gap-3 py-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}><div className="flex-1 min-w-0"><div className="text-[13px] font-medium" style={{ color: CD.ink }}>{title}</div>{desc && <div className="text-[11px]" style={{ color: CD.mute }}>{desc}</div>}</div>{children}</div>); }
  function TextsSettings() {
    const [tg, setTgRaw] = useState(() => { const b = load(TGKEY, null); return b ? { ...DEF_TG, ...b, tpl: { ...DEF_TG.tpl, ...(b.tpl || {}) } } : DEF_TG; });
    const [sites, setSitesRaw] = useState(() => load(SKEY2, DEF_SITES));
    const [preview, setPreview] = useState(false);
    const [dom, setDom] = useState('');
    const [copied, setCopied] = useState(false);
    const setTg = (patch) => setTgRaw(t => { const n = { ...t, ...patch }; save(TGKEY, n); announce(); return n; });
    const setSites = (fn) => setSitesRaw(l => { const n = fn(l); save(SKEY2, n); announce(); return n; });
    const snippet = '<script src="https://desk.cd/texts.js" data-desk="YFX-114"></' + 'script>';
    const copy = () => { try { navigator.clipboard.writeText(snippet); } catch (e) {} setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const pct = Math.min(100, Math.round((tg.monthSent / tg.monthIncl) * 100));
    return (<div>
      <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Your number</div>
      <div className="p-3.5 mb-5" style={cardSty}>
        <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Every desk on CurrencyDesk gets its own dedicated number under our carrier registration — replies, STOP handling and delivery receipts route back automatically. Nothing to set up.</div>
        <SetRow title="Dedicated number" desc="Yours for texting and receiving replies.">
          <span className="flex items-center gap-2 text-[12px]" style={{ fontFamily: 'Space Mono, monospace', color: CD.ink }}>{tg.number}<span className="flex items-center gap-1 text-[10px] px-2 py-0.5 font-semibold" style={{ background: '#E2EFE7', color: '#1D6B45', borderRadius: 999 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1D6B45' }}></span>Active</span></span>
        </SetRow>
        <SetRow title="From name" desc="What customers see instead of a number, where carriers allow it.">
          <input value={tg.from} onChange={e => setTg({ from: e.target.value.toUpperCase().slice(0, 11) })} className="outline-none text-[12px] px-2.5 py-1.5 text-right" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono', width: 110, letterSpacing: '0.04em' }} />
        </SetRow>
        <SetRow title="Desk name in messages" desc="Used by the {desk} field in every template.">
          <input value={tg.desk} onChange={e => setTg({ desk: e.target.value.slice(0, 24) })} className="outline-none text-[12px] px-2.5 py-1.5 text-right" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, width: 140 }} />
        </SetRow>
      </div>
      <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Your website</div>
      <div className="text-[11px] mb-2" style={{ color: CD.mute }}>One website per desk — customers request a text quote (or order a currency) there and pick which branch they’ll collect at. Every request lands in the same inbox, tagged by branch.</div>
      <div className="grid sm:grid-cols-2 gap-2.5 mb-3">
        {sites.slice(0, 1).map(s => (<div key={s.id} className="p-3" style={cardSty}>
          <div className="flex items-center gap-2.5 mb-2">
            <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 9, background: ACCSOFT }}><Ic n="globe" s={16} c={ACC} /></span>
            <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{s.domain}</div><div className="text-[10px]" style={{ color: CD.faint }}>since {s.since}</div></div>
            <span className="flex items-center gap-1.5 text-[10px] px-2 py-1 font-semibold" style={{ background: s.widget ? '#E2EFE7' : CD.lineSoft, color: s.widget ? '#1D6B45' : CD.faint, borderRadius: 999, fontFamily: 'Space Mono' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: s.widget ? '#1D6B45' : CD.faint }}></span>{s.widget ? 'Live' : 'Paused'}</span>
          </div>
          <div className="text-[11px] mb-2" style={{ color: CD.mute }}>{s.req7} request{s.req7 === 1 ? '' : 's'} this week</div>
          <div className="flex gap-2">
            <button onClick={() => setPreview(true)} className="px-2.5 py-1.5 text-[11px]" style={dashBtn}>Preview widget</button>
            <button onClick={() => setSites(l => l.map(x => x.id === s.id ? { ...x, widget: !x.widget } : x))} className="px-2.5 py-1.5 text-[11px]" style={dashBtn}>{s.widget ? 'Pause' : 'Resume'}</button>
          </div>
        </div>))}
        <div className="p-3" style={cardSty}>
          <div className="text-[13px] font-semibold mb-1.5" style={{ color: CD.ink }}>Pickup branches on the widget</div>
          <div className="flex flex-wrap gap-1.5 mb-1.5">{deskBranches().map(b => <span key={b} className="text-[11px] px-2 py-1" style={{ background: CD.lineSoft, color: CD.ink, borderRadius: 6 }}>{b}</span>)}</div>
          <div className="text-[10px]" style={{ color: CD.faint }}>Synced from Locations &amp; tills — the customer picks one when they request, and it tags the inbox.</div>
        </div>
      </div>
      <div className="p-3.5 mb-5" style={{ ...cardSty, borderStyle: 'dashed' }}>
        <div className="text-[13px] font-semibold mb-1" style={{ color: CD.ink }}>Install snippet</div>
        <div className="text-[11px] mb-2" style={{ color: CD.mute }}>Give this to whoever runs the site — paste before <span style={{ fontFamily: 'Space Mono' }}>&lt;/body&gt;</span> and the page gets your live board, the quote button and the branch picker.</div>
        <div className="flex items-center gap-2 p-2.5" style={{ background: '#17140F', borderRadius: 8 }}>
          <code className="flex-1 min-w-0 text-[11px]" style={{ color: '#E8E2D6', fontFamily: 'Space Mono, monospace', overflowWrap: 'anywhere' }}>{snippet}</code>
          <button onClick={copy} className="px-2.5 py-1.5 text-[11px] font-semibold flex-none" style={{ background: copied ? '#1D6B45' : 'rgba(255,255,255,.14)', color: '#fff', borderRadius: 6 }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Defaults</div>
      <div className="p-3.5 mb-5" style={cardSty}>
        <SetRow title="Auto-quote website requests" desc="Reply instantly at the live board rate — no teller tap."><Toggle on={tg.autoQuote} click={() => setTg({ autoQuote: !tg.autoQuote })} /></SetRow>
        <SetRow title="Hold window" desc="How long a Y holds the quoted rate.">
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: CD.mute }}><input type="number" min="5" max="120" value={tg.holdMins} onChange={e => setTg({ holdMins: Math.max(5, Math.min(120, +e.target.value || 30)) })} className="w-14 text-center outline-none py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono' }} />min</label>
        </SetRow>
        <SetRow title="Quiet hours" desc="Broadcasts queue until morning. Quote replies always send.">
          <span className="flex items-center gap-1.5">
            <input type="time" value={tg.quietFrom} onChange={e => setTg({ quietFrom: e.target.value })} className="outline-none text-[11px] px-1.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono' }} />
            <span className="text-[11px]" style={{ color: CD.faint }}>to</span>
            <input type="time" value={tg.quietTo} onChange={e => setTg({ quietTo: e.target.value })} className="outline-none text-[11px] px-1.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, fontFamily: 'Space Mono' }} />
          </span>
        </SetRow>
      </div>
      <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Usage</div>
      <div className="p-3.5 mb-3" style={cardSty}>
        <div className="flex items-center justify-between mb-1"><span className="text-sm font-semibold" style={{ color: CD.ink }}>This month</span><span className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }}>{num(tg.monthSent)} of {num(tg.monthIncl)} texts</span></div>
        <div style={{ height: 8, background: CD.lineSoft, borderRadius: 999, overflow: 'hidden' }}><div style={{ width: pct + '%', height: '100%', background: pct > 90 ? CD.flag : ACC, borderRadius: 999 }}></div></div>
        <div className="text-[10px] mt-1.5" style={{ color: CD.faint }}>Texting is included in every plan — even Basic. Past {num(tg.monthIncl)}, overage is 1.5¢ per text. ID verify checks bill separately (Persona).</div>
      </div>
      <div className="text-[10px] px-1" style={{ color: CD.faint }}>Consent, quiet hours and instant STOP handling follow CASL. Every message is kept in the Texts app’s History.</div>
      {preview && <WidgetModal tg={tg} onClose={() => setPreview(false)} onTry={() => { try { window.dispatchEvent(new Event('cdos_tg_try')); } catch (e) {} }} />}
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Telegraph({ settings, me, log, openSettings, onStartTx }) {
    const [tab, setTab] = useState('requests');
    const loadTg = () => { const b = load(TGKEY, null); return b ? { ...DEF_TG, ...b, tpl: { ...DEF_TG.tpl, ...(b.tpl || {}) } } : DEF_TG; };
    const [tg, setTgRaw] = useState(loadTg);
    const [reqs, setReqs] = useState(() => { const r = load(RKEY, null); if (!r || !r.length || Math.max(...r.map(x => x.at || 0)) < Date.now() - 6 * 3600000) return seedReqs(); return r; });
    const [logbook, setLogbook] = useState(() => { const l = load(LKEY, null); if (!l || !l.length || Math.max(...l.map(x => x.t || 0)) < Date.now() - 6 * 3600000) return seedLog(); return l; });
    const [contacts, setContacts] = useState(() => load(CKEY2, DEF_CONTACTS));
    const [bcasts, setBcasts] = useState(() => load(BKEY2, DEF_BCASTS));
    const [sites, setSites] = useState(() => load(SKEY2, DEF_SITES));
    const [openId, setOpenId] = useState(null);
    useEffect(() => { save(TGKEY, tg); }, [tg]);
    useEffect(() => { save(RKEY, reqs); }, [reqs]);
    useEffect(() => { save(LKEY, logbook); }, [logbook]);
    useEffect(() => { save(CKEY2, contacts); }, [contacts]);
    useEffect(() => { save(BKEY2, bcasts); }, [bcasts]);
    useEffect(() => { const h = () => { setTgRaw(loadTg()); setSites(load(SKEY2, DEF_SITES)); const rr = load(RKEY, null); if (rr && rr.length) setReqs(rr); const ll = load(LKEY, null); if (ll && ll.length) setLogbook(ll); }; window.addEventListener('cdos_tg_sync', h); return () => window.removeEventListener('cdos_tg_sync', h); }, []);
    const setTg = (patch) => setTgRaw(t => ({ ...t, ...patch }));
    const setTpl = (k, v) => setTgRaw(t => ({ ...t, tpl: { ...t.tpl, [k]: v } }));
    const bump = (n) => setTgRaw(t => ({ ...t, monthSent: (t.monthSent || 0) + n }));
    const addLog = (kind, dir, to, detail) => setLogbook(l => [{ t: Date.now(), kind, dir, to, detail }, ...l].slice(0, 400));
    const ctxFor = (r, extra) => ({ desk: tg.desk, amount: num(r.amount), ccy: r.ccy, total: r.total != null ? num(r.total) : '', rate: r.rate ? r.rate.toFixed(4) : '', mins: tg.holdMins, ref: r.ref, time: r.holdUntil ? hhmm(r.holdUntil) : '', link: 'desk.cd/v/' + r.ref.toLowerCase(), site: r.site, days: r.etaDays || 2, ...(extra || {}) });
    const upd = (id, fn) => setReqs(rs => rs.map(r => r.id === id ? fn(r) : r));
    const byId = (id) => reqs.find(x => x.id === id);
    const acts = {
      quote: (id, rateOv) => { const r0 = byId(id); const rateQ = rateOv && +rateOv > 0 ? +(+rateOv).toFixed(4) : sellRate(r0 ? r0.ccy : 'USD'); upd(id, r => { const rate = rateOv && +rateOv > 0 ? rateQ : sellRate(r.ccy); const total = Math.round(r.amount * rate * 100) / 100; const nr = { ...r, rate, total, status: 'quoted', holdUntil: null, nudged: false }; return { ...nr, thread: [...r.thread, out(render(tg.tpl.quote, ctxFor(nr)))] }; }); bump(1); if (r0) { addLog('Quote', 'out', r0.phone, `${r0.ref} — ${num(r0.amount)} ${r0.ccy} at ${rateQ.toFixed(4)}`); log && log('Quote texted', r0.ref + ' · ' + r0.phone); } },
      reply: (id, yn) => { const r0 = byId(id); upd(id, r => { if (yn === 'N') return { ...r, status: 'closed', thread: [...r.thread, inn('N'), out(render(tg.tpl.closed, ctxFor(r)))] }; const holdUntil = Date.now() + tg.holdMins * 60000; const nr = { ...r, status: 'held', holdUntil, nudged: false }; const th = [...r.thread, inn('Y'), out(render(tg.tpl.hold, ctxFor(nr)))]; if (tg.verifyStep) th.push(out(render(tg.tpl.verify, ctxFor(nr)))); return { ...nr, thread: th }; }); bump(yn === 'Y' ? (tg.verifyStep ? 2 : 1) : 1); if (r0) addLog(yn === 'Y' ? 'Hold' : 'Reply', yn === 'Y' ? 'out' : 'in', r0.phone, yn === 'Y' ? `${r0.ref} — held ${tg.holdMins} min${tg.verifyStep ? ' + verify link' : ''}` : 'N — passed on the quote'); if (r0) log && log(yn === 'Y' ? 'Rate held by text' : 'Quote declined by text', r0.ref); },
      verify: (id) => { const r0 = byId(id); upd(id, r => ({ ...r, status: 'verified', thread: [...r.thread, sys('ID verified via secure link · Persona'), out(render(tg.tpl.ready, ctxFor(r)))] })); bump(1); if (r0) { addLog('Ready', 'out', r0.phone, `${r0.ref} — verified, locked until pickup`); log && log('Customer verified ahead of visit', r0.ref); } },
      collect: (id) => { const r0 = byId(id); upd(id, r => ({ ...r, status: 'collected', thread: [...r.thread, sys('Collected at the counter')] })); if (r0) { addLog('System', 'sys', r0.phone, `${r0.ref} collected at the counter`); log && log('Held rate collected', r0.ref); } },
      dismiss: (id) => { const r0 = byId(id); upd(id, r => ({ ...r, status: 'closed', thread: [...r.thread, sys('Dismissed — no reply sent')] })); if (r0) addLog('System', 'sys', r0.phone, `${r0.ref} dismissed — no reply sent`); },
      placeOrder: (id, days) => { const r0 = byId(id); upd(id, r => { const nr = { ...r, status: 'order_placed', etaDays: days }; return { ...nr, thread: [...r.thread, out(render(tg.tpl.orderq, ctxFor(nr)))] }; }); bump(1); if (r0) { addLog('Order', 'out', r0.phone, `${r0.ref} — ${num(r0.amount)} ${r0.ccy}, ~${days} business days`); log && log('Currency order placed', r0.ref + ' · ' + num(r0.amount) + ' ' + r0.ccy); } },
      arrived: (id) => { const r0 = byId(id); upd(id, r => { const known = onBoard(r.ccy); const nr = { ...r, status: 'order_arrived', rate: known ? sellRate(r.ccy) : null }; return { ...nr, thread: [...r.thread, sys('Stock arrived — marked in'), out(render(tg.tpl.orderready, ctxFor(nr, { rate: known ? sellRate(r.ccy).toFixed(4) : 'today’s posted rate' })))] }; }); bump(1); if (r0) { addLog('Pickup', 'out', r0.phone, `${r0.ref} — ${r0.ccy} in stock, pickup text sent`); log && log('Order arrived — customer texted', r0.ref); } },
      simulate: (kind) => {
        const site = (sites[0] && sites[0].domain) || 'yorkfx.ca';
        const brs = deskBranches();
        const br = brs[Math.floor(Math.random() * brs.length)];
        if (kind === 'order') {
          const pool = [['ZWG', 30000], ['ZAR', 20000], ['THB', 45000]];
          const [ccy, amount] = pool[Math.floor(Math.random() * pool.length)];
          const phone = '+1 416 555 01' + (10 + Math.floor(Math.random() * 89));
          const no = 1 + Math.max(2012, ...reqs.map(r => r.ref.indexOf('TO-') === 0 ? +(r.ref.split('-')[1]) || 0 : 0));
          const nr = { id: 'r' + Date.now(), ref: 'TO-' + no, kind: 'order', phone, name: '', site, br, ccy, amount, at: Date.now(), status: 'order_new', thread: [sys('Currency order on ' + site + ' — ' + num(amount) + ' ' + ccy + ' · pickup ' + br)] };
          setReqs(rs => [nr, ...rs]); addLog('Request', 'in', phone, `Currency order — ${num(amount)} ${ccy} · ${br}`); log && log('Website currency order', nr.ref + ' · ' + br);
          return;
        }
        const pool = [['+1 416 555 01' + (10 + Math.floor(Math.random() * 89)), 'USD', [500, 1000, 1500, 2000][Math.floor(Math.random() * 4)]], ['+1 647 555 01' + (10 + Math.floor(Math.random() * 89)), 'EUR', [300, 500, 800][Math.floor(Math.random() * 3)]], ['+1 905 555 01' + (10 + Math.floor(Math.random() * 89)), 'GBP', [250, 400, 600][Math.floor(Math.random() * 3)]]];
        const [phone, ccy, amount] = pool[Math.floor(Math.random() * pool.length)];
        const no = 1 + Math.max(1046, ...reqs.map(r => r.ref.indexOf('TQ-') === 0 ? +(r.ref.split('-')[1]) || 0 : 0));
        const nr = { id: 'r' + Date.now(), ref: 'TQ-' + no, kind: 'quote', phone, name: '', site, br, ccy, amount, at: Date.now(), status: 'new', thread: [sys('Quote requested on ' + site + ' — ' + num(amount) + ' ' + ccy + ' · pickup ' + br)] };
        setReqs(rs => [nr, ...rs]); addLog('Request', 'in', phone, `Quote request — ${num(amount)} ${ccy} · ${br}`); log && log('Website quote request', nr.ref + ' · ' + br);
        if (tg.autoQuote) setTimeout(() => acts.quote(nr.id), 500);
      }
    };
    useEffect(() => { const h = () => { setTab('requests'); acts.simulate('quote'); }; window.addEventListener('cdos_tg_try', h); return () => window.removeEventListener('cdos_tg_try', h); });
    // hold expiry + 10-minute nudge engine
    useEffect(() => {
      const tick = () => setReqs(rs => {
        let changed = false;
        const next = rs.map(r => {
          if ((r.status === 'held' || r.status === 'verified') && r.holdUntil && Date.now() > r.holdUntil) { changed = true; return { ...r, status: 'expired', thread: [...r.thread, sys('Hold expired — no visit')] }; }
          if (r.status === 'held' && tg.nudge && !r.nudged && r.holdUntil && r.holdUntil - Date.now() <= 10 * 60000) { changed = true; return { ...r, nudged: true, thread: [...r.thread, out(render(tg.tpl.nudge, ctxFor(r)))] }; }
          return r;
        });
        return changed ? next : rs;
      });
      const t = setInterval(tick, 15000); tick();
      return () => clearInterval(t);
    }, [tg.nudge, tg.tpl.nudge]);
    const sendBcast = (body, n, cost, toLabel, aud) => { const at = new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' · ' + hhmm(Date.now()); const full = aud === 'all' ? body + ' Reply STOP to opt out.' : body; setBcasts(l => [{ id: 'b' + Date.now(), at, body: full, n, cost, to: toLabel }, ...l]); bump(n); addLog(aud === 'all' ? 'Broadcast' : 'Text', 'out', toLabel, body.slice(0, 80) + (body.length > 80 ? '…' : '')); log && log(aud === 'all' ? 'Broadcast sent' : 'Text sent', toLabel); };
    const waiting = reqs.filter(r => r.status === 'new' || r.status === 'order_new').length;
    const held = reqs.filter(r => r.status === 'held' || r.status === 'verified').length;
    const TABS = [['requests', 'Requests', 'smartphone'], ['journey', 'Journey', 'send'], ['broadcasts', 'Broadcasts', 'mail'], ['contacts', 'Contacts', 'users'], ['history', 'History', 'clock']];
    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: 'var(--cd-panel)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.panel, boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="telegraphbubble" s={17} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Texts</div><div className="text-[11px]" style={{ color: CD.mute }}>{waiting ? waiting + ' waiting' : 'Inbox clear'}{held ? ` · ${held} rate hold${held === 1 ? '' : 's'}` : ''} · {num(tg.audience)} subscribers</div></div>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5" style={{ background: '#E2EFE7', color: '#1D6B45', borderRadius: 999, fontFamily: 'Space Mono, monospace' }} title="Your dedicated sender line — provisioned and managed by CurrencyDesk"><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#1D6B45' }}></span>{tg.from} · {tg.number}</span>
            {openSettings && <button onClick={openSettings} className="p-2" style={{ borderRadius: 8, border: `1px solid ${CD.line}` }} title="Number, websites & defaults — in Settings › Texts"><Ic n="gearsettings" s={14} c={CD.mute} /></button>}
          </div>
        </div>
        <div className="fld-bar" style={{ '--ft': ACC, margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => (<button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
            <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
            {id === 'requests' && waiting > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{waiting}</span>}
          </button>))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'requests' && <Requests reqs={reqs} tg={tg} setTg={setTg} acts={acts} openId={openId} setOpenId={setOpenId} onStartTx={onStartTx} contacts={contacts} />}
        {tab === 'journey' && <Journey tg={tg} setTg={setTg} setTpl={setTpl} />}
        {tab === 'broadcasts' && <Broadcasts tg={tg} bcasts={bcasts} contacts={contacts} onSend={sendBcast} />}
        {tab === 'contacts' && <Contacts contacts={contacts} setContacts={setContacts} tg={tg} log={log} />}
        {tab === 'history' && <History logbook={logbook} tg={tg} />}
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Telegraph, TextsSettings });
})();
