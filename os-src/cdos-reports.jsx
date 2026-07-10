/* ============================================================
   CurrencyDesk OS — Reports
   One-touch report generation off the live ledger. Pick a period,
   tap a report, and a formatted, print-ready document is built
   instantly: Period Summary, FINTRAC / LCTR compliance pack,
   Revenue & Earnings, Transaction Register, Client & KYC Register.
   Print / Save-PDF and CSV export on every report.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const HKEY = 'cdos_report_history_v1';
  const AKEY = 'cdos_report_access_v1';
  const { CD, Ic, TYPES, THRESHOLD, TODAY, crossRate, perCadLive, fmt, num, dDiff, dealMargin, CCY } = window.CDOS;
  const holdingsOf = (c, rows, baseline, receipts) => (window.CDOS.holdings ? window.CDOS.holdings(c, rows, baseline, receipts) : 0);

  // ---- role-based report access ----
  const ROLES = ['Owner', 'Manager', 'Compliance', 'Senior teller', 'Cashier'];
  const DEFAULT_ACCESS = {
    'Owner':         ['endofday', 'summary', 'pnl', 'revenue', 'fintrac', 'register', 'kyc'],
    'Manager':       ['endofday', 'summary', 'pnl', 'revenue', 'fintrac', 'register', 'kyc'],
    'Compliance':    ['endofday', 'fintrac', 'register', 'kyc'],
    'Senior teller': ['endofday', 'summary', 'register'],
    'Cashier':       ['endofday', 'register']
  };
  const roleOf = (me) => (me && me.role) || 'Cashier';
  function loadAccess() {
    try { const saved = JSON.parse(localStorage.getItem(AKEY) || 'null'); return saved && typeof saved === 'object' ? { ...DEFAULT_ACCESS, ...saved } : { ...DEFAULT_ACCESS }; }
    catch (e) { return { ...DEFAULT_ACCESS }; }
  }
  const allowedFor = (me, access) => (access[roleOf(me)] || DEFAULT_ACCESS[roleOf(me)] || []);

  const cadOf = (amt, ccy) => ccy === 'CAD' ? (+amt || 0) : (+amt || 0) / (crossRate('CAD', ccy) || 1);
  // booked spread per deal — exact when two-side priced, else the live-mid estimate
  const spreadOf = (r) => dealMargin(r);
  const stampNow = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');

  const RANGES = [
    ['today', 'Today', 0],
    ['7d', 'Past 7 days', 7],
    ['30d', 'Past 30 days', 30],
    ['90d', 'This quarter', 90],
    ['365d', 'This year', 365],
    ['all', 'All time', null]
  ];

  const REPORTS = [
    { id: 'endofday', title: 'End-of-Day Sign-Off',   icon: 'receipt',  desc: 'Signed close-out: day totals, cash on hand and compliance — the artifact to file.', tone: CD.green, signed: true },
    { id: 'summary',  title: 'Period Summary',        icon: 'bars',     desc: 'Volume, fees, earnings and cash movement at a glance.', tone: CD.ink },
    { id: 'pnl',      title: 'Profit & Loss',         icon: 'coins',    desc: 'Revenue, estimated GST/HST on commission and net profit.', tone: CD.green },
    { id: 'fintrac',  title: 'FINTRAC / LCTR Pack',   icon: 'shield',   desc: 'Reportable deals, structuring watches and KYC gaps.',   tone: CD.flag },
    { id: 'revenue',  title: 'Revenue & Earnings',    icon: 'coins',    desc: 'Fees plus FX spread, broken down by teller and type.',  tone: CD.green },
    { id: 'register', title: 'Transaction Register',  icon: 'scroll',   desc: 'The full book for the period — every posted record.',   tone: CD.ink },
    { id: 'kyc',      title: 'Client & KYC Register', icon: 'id',       desc: 'Every client, ID status and period activity.',          tone: CD.ink }
  ];

  /* ---------- print: clone the report node into a clean window ---------- */
  function printReport(title) {
    const node = document.getElementById('cdos-report-doc');
    if (!node) return;
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
      <style>
        *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:38px 44px;color:#0a0a0a;}
        table{border-collapse:collapse;width:100%;}
        @page{margin:14mm;}
      </style></head><body>${node.outerHTML}</body></html>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 350);
  }

  function downloadCsv(name, rows) {
    const csv = rows.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name; a.click();
  }

  /* ---------- shared document atoms (inline-styled so they print) ----------
     Reports are branded as the EXCHANGE HOUSE's own document. CurrencyDesk is a
     small credit in the footer only. DOC_BIZ is set by <Reports> each render. */
  let DOC_BIZ = { name: 'York Currency Exchange', logo: null, line2: 'Registered Money Services Business' };
  let DOC_SCOPE = '';
  function DocHead({ title, subtitle, rangeLabel }) {
    const biz = DOC_BIZ;
    return (<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 16, borderBottom: `2px solid ${CD.ink}`, marginBottom: 22 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {biz.logo
            ? <img src={biz.logo} alt="" style={{ maxHeight: 34, maxWidth: 150, objectFit: 'contain', display: 'block' }} />
            : <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 800, fontSize: 19, letterSpacing: '-0.01em', color: CD.ink }}>{biz.name}</div>}
        </div>
        {biz.logo && <div style={{ fontFamily: 'Archivo, sans-serif', fontWeight: 700, fontSize: 14, color: CD.ink, marginTop: 6 }}>{biz.name}</div>}
        <div style={{ fontSize: 23, fontWeight: 800, color: CD.ink, marginTop: 14, letterSpacing: '-0.01em' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12.5, color: CD.mute, marginTop: 2 }}>{subtitle}</div>}
        {DOC_SCOPE && <div style={{ fontSize: 11.5, color: CD.ink, marginTop: 5, display: 'inline-block', background: 'var(--cd-chip)', borderRadius: 5, padding: '3px 9px' }}>Filtered — {DOC_SCOPE}</div>}
      </div>
      <div style={{ textAlign: 'right', fontSize: 11, color: CD.mute, lineHeight: 1.7 }}>
        <div style={{ fontFamily: 'Space Mono, monospace', fontWeight: 700, color: CD.ink, fontSize: 12 }}>{rangeLabel}</div>
        <div>Generated {stampNow()}</div>
        <div>{biz.line2}</div>
      </div>
    </div>);
  }
  function DocFoot() {
    return (<div style={{ marginTop: 26, paddingTop: 11, borderTop: `1px solid ${CD.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      <span style={{ width: 15, height: 15, background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 3.5, display: 'grid', placeItems: 'center', fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: 8 }}>CD</span>
      <span style={{ fontSize: 9.5, color: CD.faint, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>Generated by CurrencyDesk OS</span>
    </div>);
  }
  function KpiRow({ items }) {
    return (<div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 1, background: CD.line, border: `1px solid ${CD.line}`, marginBottom: 22 }}>
      {items.map((k, i) => (<div key={i} style={{ background: 'var(--cd-panel)', padding: '13px 15px' }}>
        <div style={{ fontSize: 10.5, color: CD.mute, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k.label}</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: k.accent || CD.ink, fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>{k.value}</div>
        {k.sub && <div style={{ fontSize: 10, color: CD.faint, marginTop: 1 }}>{k.sub}</div>}
      </div>))}
    </div>);
  }
  function SecTitle({ children, n }) {
    return (<div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '6px 0 9px' }}>
      <div style={{ fontSize: 11, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: CD.faint }}>{children}</div>
      {n != null && <div style={{ fontSize: 11, color: CD.faint }}>{n}</div>}
    </div>);
  }
  function Bars({ data, fmtV, accent }) {
    if (!data.length) return <div style={{ fontSize: 12, color: CD.faint, padding: '4px 0' }}>No data in this period.</div>;
    const max = Math.max(1, ...data.map(d => d[1]));
    return (<div>{data.map(([k, v]) => (<div key={k} style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}><span style={{ color: CD.text }}>{k}</span><span style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{fmtV(v)}</span></div>
      <div style={{ height: 7, background: CD.lineSoft, borderRadius: 3 }}><div style={{ height: 7, width: `${(v / max) * 100}%`, background: accent || CD.ink, borderRadius: 3, minWidth: v > 0 ? 3 : 0 }} /></div>
    </div>))}</div>);
  }
  const thS = { textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: CD.mute, padding: '8px 10px', background: 'var(--cd-chip)', borderBottom: `1px solid ${CD.line}`, fontWeight: 600 };
  const tdS = { fontSize: 12, padding: '7px 10px', borderBottom: `1px solid ${CD.lineSoft}`, color: CD.ink };
  function Card({ children, pad }) { return <div style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 10, padding: pad == null ? 16 : pad, marginBottom: 16 }}>{children}</div>; }
  function Cols({ children }) { return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>{children}</div>; }

  /* ============================================================
     The report builder
     ============================================================ */
  function Reports({ rows, clients, settings, me, baseline, receipts, day, station, branches, openSignal }) {
    const [range, setRange] = useState('today');
    const [active, setActive] = useState(null);
    const [menu, setMenu] = useState(false);
    const [access, setAccess] = useState(loadAccess);
    const [manageAccess, setManageAccess] = useState(false);
    const [scope, setScope] = useState({ customers: [], tellers: [], types: [], from: '', to: '' });
    const [filterOpen, setFilterOpen] = useState(false);
    const myRole = roleOf(me);
    const canManage = myRole === 'Owner' || myRole === 'Manager';
    const allowed = allowedFor(me, access);
    const canGen = (id) => allowed.includes(id);
    // open a specific report on request (e.g. the Till's End-of-Day Sign-Off button)
    useEffect(() => {
      if (openSignal && openSignal.id && canGen(openSignal.id)) { if (openSignal.id === 'endofday') { setRange('today'); setScope({ customers: [], tellers: [], types: [], from: '', to: '' }); } setActive(openSignal.id); }
    }, [openSignal && openSignal.n]);
    // brand every report as the exchange house's own document
    DOC_BIZ = {
      name: (settings && (settings.operatingName || settings.bizName)) || 'York Currency Exchange',
      logo: (settings && settings.logo) || null,
      line2: (settings && settings.reportFootLine) || 'Registered Money Services Business'
    };
    const rangeLabel = (RANGES.find(r => r[0] === range) || [, 'All time'])[1];

    const inRange = (date) => {
      const days = (RANGES.find(r => r[0] === range) || [])[2];
      if (days == null) return range === 'all';
      const ago = dDiff(date, TODAY);
      return ago >= -0.0001 && ago <= days + 0.0001;
    };
    const allRange = range === 'all';
    const within = (d) => allRange ? true : inRange(d);

    // ---- report scope (the “select a person / teller / type / custom dates” filters) ----
    const customersList = useMemo(() => Array.from(new Set(rows.map(r => r.customer).filter(Boolean))).sort(), [rows]);
    const tellersList = useMemo(() => Array.from(new Set(rows.map(r => r.teller).filter(Boolean))).sort(), [rows]);
    const useCustomDates = !!(scope.from || scope.to);
    const inWindow = (d) => {
      if (useCustomDates) { if (scope.from && d < scope.from) return false; if (scope.to && d > scope.to) return false; return true; }
      return within(d);
    };
    const matchesScope = (r) => (!scope.customers.length || scope.customers.includes(r.customer)) && (!scope.tellers.length || scope.tellers.includes(r.teller)) && (!scope.types.length || scope.types.includes(r.type));
    const summarize = (arr, noun) => !arr.length ? null : (arr.length <= 2 ? arr.join(', ') : `${arr.length} ${noun}`);
    const activeFilters = [
      summarize(scope.customers, 'clients') && `Clients: ${summarize(scope.customers, 'clients')}`,
      summarize(scope.tellers, 'tellers') && `Tellers: ${summarize(scope.tellers, 'tellers')}`,
      summarize(scope.types, 'types') && summarize(scope.types, 'types'),
      useCustomDates && `${scope.from || '…'} → ${scope.to || '…'}`
    ].filter(Boolean);
    DOC_SCOPE = activeFilters.join(' · ');
    const effRangeLabel = useCustomDates ? `${scope.from || 'start'} → ${scope.to || TODAY}` : rangeLabel;

    const flags = useMemo(() => window.CDOS.computeFlags(rows, clients, settings), [rows, clients, settings]);

    const data = useMemo(() => {
      const inP = rows.filter(r => inWindow(r.date) && matchesScope(r));
      const live = inP.filter(r => r.status !== 'void');
      let vol = 0, fees = 0, spread = 0;
      const byCcy = {}, byType = {}, feeTeller = {}, feeType = {}, drawerIn = {}, drawerOut = {};
      live.forEach(r => {
        const v = cadOf(r.inAmt, r.inCcy), fee = +r.fee || 0, sp = spreadOf(r);
        vol += v; fees += fee; spread += sp;
        byCcy[r.inCcy] = (byCcy[r.inCcy] || 0) + v;
        byType[r.type] = (byType[r.type] || 0) + v;
        feeTeller[r.teller] = (feeTeller[r.teller] || 0) + fee + sp;
        feeType[r.type] = (feeType[r.type] || 0) + fee + sp;
        drawerIn[r.inCcy] = (drawerIn[r.inCcy] || 0) + (+r.inAmt || 0);
        drawerOut[r.outCcy] = (drawerOut[r.outCcy] || 0) + (+r.outAmt || 0);
      });
      const reportable = live.filter(r => (flags[r.id] || {}).single);
      const stru = []; const seen = new Set();
      live.forEach(r => { const f = flags[r.id] || {}; if (f.str && !seen.has(r.customer)) { seen.add(r.customer); stru.push({ customer: r.customer, agg: f.agg, ack: r.ackStr }); } });
      const kycGaps = []; const seenK = new Set();
      live.forEach(r => { const f = flags[r.id] || {}; if (f.kyc && f.kyc !== 'ok' && f.idNeeded && !seenK.has(r.customer)) { seenK.add(r.customer); kycGaps.push({ customer: r.customer, issue: f.kyc }); } });
      const sortE = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
      const ccySet = Array.from(new Set([...Object.keys(drawerIn), ...Object.keys(drawerOut)]));
      const drawer = ccySet.map(c => ({ ccy: c, inA: drawerIn[c] || 0, outA: drawerOut[c] || 0, net: (drawerIn[c] || 0) - (drawerOut[c] || 0) }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      const perTx = live.map(r => ({ r, fee: +r.fee || 0, sp: spreadOf(r), vol: cadOf(r.inAmt, r.inCcy) }))
        .map(o => ({ ...o, earned: o.fee + o.sp })).sort((a, b) => b.earned - a.earned);
      return {
        inP, live, vol, fees, spread, rev: fees + spread, n: live.length,
        byCcy: sortE(byCcy), byType: sortE(byType), feeTeller: sortE(feeTeller), feeType: sortE(feeType),
        reportable, stru, kycGaps, drawer, perTx,
        filed: reportable.filter(r => r.filed).length,
        // cash position at close — expected on-hand per currency (shared source of truth),
        // auto-matched against the till's actual physical count snapshot for TODAY.
        cash: (() => {
          let counted = {};
          try { counted = ((JSON.parse(localStorage.getItem('cdos_till_history_v2') || '{}') || {})[TODAY] || {}).byCcy || {}; } catch (e) {}
          return (CCY || []).map(c => {
            const u = holdingsOf(c, rows, baseline, receipts);
            const ct = (c in counted) ? +counted[c] : null;
            return { ccy: c, units: u, cad: cadOf(u, c), counted: ct, variance: ct == null ? null : +(ct - u).toFixed(2) };
          }).filter(x => Math.abs(x.units) > 0.005 || x.counted != null || x.ccy === 'CAD');
        })()
      };
    }, [rows, clients, settings, range, flags, scope]);

    // Every freshly generated report is snapshotted (rendered HTML frozen) into an
    // immutable history log — surfaced in the Compliance ▸ History tab, never silently changing.
    useEffect(() => {
      if (!active) return;
      const t = setTimeout(() => {
        const node = document.getElementById('cdos-report-doc');
        if (!node) return;
        let hist = []; try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]') || []; } catch (e) {}
        const last = hist[0];
        const nowMs = Date.now();
        if (last && last.type === active && last.range === range && (nowMs - (last.ms || 0)) < 1500) return; // dedupe re-renders
        const meta = REPORTS.find(r => r.id === active);
        const entry = { key: 'R' + nowMs.toString(36) + Math.random().toString(36).slice(2, 5), ms: nowMs, type: active, title: meta.title, icon: meta.icon, tone: meta.tone, range, rangeLabel, at: stampNow(), n: data.n, html: node.innerHTML };
        try { localStorage.setItem(HKEY, JSON.stringify([entry, ...hist].slice(0, 500))); } catch (e) {}
      }, 140);
      return () => clearTimeout(t);
    }, [active, range]);

    const csvFor = (id) => {
      if (id === 'endofday') return [['Currency', 'Units expected', 'CAD value'], ...data.cash.map(x => [x.ccy, x.units.toFixed(2), x.cad.toFixed(2)]),
        [], ['Transactions', data.n], ['Pay-in volume CAD', data.vol.toFixed(2)], ['Fees CAD', data.fees.toFixed(2)], ['FX spread CAD', data.spread.toFixed(2)], ['Revenue CAD', data.rev.toFixed(2)], ['Reportable', data.reportable.length], ['Open LCTRs', data.reportable.length - data.filed]];
      if (id === 'pnl') { const hstRate = (settings && settings.hstRate != null) ? +settings.hstRate : 13; return [['Line', 'CAD'], ['Commission & fees', data.fees.toFixed(2)], ['FX spread', data.spread.toFixed(2)], ['Gross revenue', data.rev.toFixed(2)], [`GST/HST on commission (${hstRate}%)`, (data.fees * hstRate / 100).toFixed(2)], ['Net revenue to business', data.rev.toFixed(2)]]; }
      if (id === 'summary') return [['Currency', 'Pay-in volume CAD'], ...data.byCcy.map(([c, v]) => [c, v.toFixed(2)])];
      if (id === 'fintrac') return [['Ref', 'Date', 'Customer', 'Amount', 'Currency', 'CAD equiv', 'Filed', 'LCTR ref'],
        ...data.reportable.map(r => [r.ref, r.date, r.customer, r.inAmt, r.inCcy, cadOf(r.inAmt, r.inCcy).toFixed(2), r.filed ? 'yes' : 'NO', r.filedInfo && r.filedInfo.ref || ''])];
      if (id === 'revenue') return [['Ref', 'Customer', 'Type', 'Teller', 'Fee', 'Spread', 'Earned'],
        ...data.perTx.map(o => [o.r.ref, o.r.customer, o.r.type, o.r.teller, o.fee.toFixed(2), o.sp.toFixed(2), o.earned.toFixed(2)])];
      if (id === 'register') return [['Ref', 'Date', 'Time', 'Customer', 'Type', 'In', 'InCcy', 'Out', 'OutCcy', 'Fee', 'Teller', 'Status'],
        ...data.inP.map(r => [r.ref, r.date, r.time, r.customer, r.type, r.inAmt, r.inCcy, r.outAmt, r.outCcy, r.fee, r.teller, r.status])];
      if (id === 'kyc') {
        const names = Array.from(new Set([...Object.keys(clients), ...data.live.map(r => r.customer)]));
        return [['Client', 'ID type', 'ID number', 'Expiry', 'Status', 'Tx in period', 'Volume CAD'],
          ...names.map(n => { const c = clients[n] || {}; const tx = data.live.filter(r => r.customer === n); const v = tx.reduce((s, r) => s + cadOf(r.inAmt, r.inCcy), 0);
            const st = (!c.idType || !c.idNum) ? 'missing ID' : (c.idExpiry && c.idExpiry < TODAY ? 'ID expired' : 'verified');
            return [n, c.idType || '', c.idNum || '', c.idExpiry || '', st, tx.length, v.toFixed(2)]; })];
      }
      return [];
    };

    /* ---------- the five documents ---------- */
    const renderDoc = (id) => {
      const sub = `${data.n} posted transaction${data.n === 1 ? '' : 's'} · CAD-equivalent at live spot`;
      const branchName = (station && branches && (branches.find(b => b.id === station.branchId) || {}).name) || (settings && (settings.operatingName || settings.bizName)) || 'York Currency Exchange';
      const tillName = (station && station.tillId) ? (((branches || []).find(b => b.id === station.branchId) || {}).tills || []).find(t => t.id === station.tillId)?.name : null;

      if (id === 'endofday') {
        const totalCashCad = data.cash.reduce((s, x) => s + x.cad, 0);
        const openRpt = data.reportable.length - data.filed;
        return (<div>
          <DocHead title="End-of-Day Sign-Off" subtitle={`${branchName}${tillName ? ' · ' + tillName : ''} · ${(() => { try { return new Date(TODAY + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return TODAY; } })()} · Day ${day && day.num || 1}`} rangeLabel={effRangeLabel} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, padding: '10px 14px', background: CD.greenSoft, border: `1px solid ${CD.green}`, borderRadius: 9 }}>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: CD.green, display: 'grid', placeItems: 'center', flex: 'none' }}><span style={{ color: 'var(--cd-on-ink)', fontSize: 14 }}>✓</span></span>
            <div style={{ fontSize: 12.5, color: '#14543a' }}><b>Close-out summary</b> — review every drawer against expected, then sign below. Filed to the day's permanent record.</div>
          </div>
          <KpiRow items={[
            { label: 'Transactions', value: data.n },
            { label: 'Pay-in volume', value: fmt(data.vol, 'CAD') },
            { label: 'Revenue (fees + spread)', value: fmt(data.rev, 'CAD'), accent: CD.green },
            { label: 'Cash on hand', value: fmt(totalCashCad, 'CAD'), sub: 'expected at close' }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={`${data.cash.length} drawer(s)`}>Cash on hand at close — expected vs. counted</SecTitle></div>
            <table><thead><tr><th style={thS}>Currency</th><th style={{ ...thS, textAlign: 'right' }}>Units expected</th><th style={{ ...thS, textAlign: 'right' }}>CAD value</th><th style={{ ...thS, textAlign: 'right' }}>Counted</th><th style={{ ...thS, textAlign: 'right' }}>Variance</th></tr></thead>
              <tbody>{data.cash.map(x => { const off = x.variance != null && Math.abs(x.variance) > 0.005; return (<tr key={x.ccy}>
                <td style={tdS}><b>{x.ccy}</b></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(x.units)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(x.cad, 'CAD')}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: x.counted == null ? CD.faint : CD.ink }}>{x.counted == null ? '— not counted' : num(x.counted)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: x.variance != null ? 600 : 400, color: x.variance == null ? CD.faint : off ? CD.flag : CD.green }}>{x.variance == null ? '—' : (Math.abs(x.variance) < 0.005 ? '✓ balanced' : (x.variance > 0 ? '+' : '') + num(x.variance))}</td>
              </tr>); })}
              {(() => { const ctTot = data.cash.reduce((s, x) => s + (x.counted == null ? 0 : cadOf(x.counted, x.ccy)), 0); const vTot = data.cash.reduce((s, x) => s + (x.variance == null ? 0 : cadOf(x.variance, x.ccy)), 0); const anyCounted = data.cash.some(x => x.counted != null); const off = Math.abs(vTot) > 0.005; return (
                <tr><td style={{ ...tdS, fontWeight: 700 }} colSpan={2}>Total · CAD</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(totalCashCad, 'CAD')}</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{anyCounted ? fmt(ctTot, 'CAD') : '—'}</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: !anyCounted ? CD.faint : off ? CD.flag : CD.green }}>{anyCounted ? (Math.abs(vTot) < 0.005 ? '✓ balanced' : (vTot > 0 ? '+' : '') + fmt(vTot, 'CAD')) : '—'}</td></tr>
              ); })()}
              </tbody></table>
            <div style={{ fontSize: 10.5, color: CD.faint, padding: '8px 16px 2px' }}>Counted &amp; variance are pulled automatically from the till's drawer count. Currencies not yet counted show “— not counted”; count them in Till &amp; Cash Drawer for a complete close.</div>
          </Card>
          <Cols>
            <Card><SecTitle>Activity by type</SecTitle><Bars data={data.byType} fmtV={v => fmt(v, 'CAD')} /></Card>
            <Card><SecTitle>Earnings by teller</SecTitle><Bars data={data.feeTeller} fmtV={v => fmt(v, 'CAD')} accent={CD.green} /></Card>
          </Cols>
          <Card>
            <SecTitle>Compliance at close</SecTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <Mini label="Reportable ≥ $10k" value={`${data.reportable.length}`} sub={`${data.filed} filed · ${openRpt} open`} tone={openRpt > 0 ? CD.flag : CD.green} />
              <Mini label="Structuring watch" value={`${data.stru.length}`} sub="open patterns" tone={data.stru.length ? CD.amber : CD.green} />
              <Mini label="KYC / ID gaps" value={`${data.kycGaps.length}`} sub="clients to verify" tone={data.kycGaps.length ? CD.flag : CD.green} />
            </div>
          </Card>
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${CD.ink}` }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: CD.faint, marginBottom: 12 }}>Sign-off</div>
            <div style={{ display: 'flex', gap: 30 }}>
              {[['Teller on duty', me ? me.name : ''], ['Manager / owner', '']].map(([r, nm]) => (<div key={r} style={{ flex: 1 }}>
                <div style={{ height: 34, borderBottom: `1px solid ${CD.ink}`, display: 'flex', alignItems: 'flex-end', paddingBottom: 3, color: CD.mute, fontSize: 12 }}>{nm}</div>
                <div style={{ fontSize: 10.5, color: CD.mute, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}><span>{r}</span><span>Date</span></div>
              </div>))}
            </div>
            <div style={{ fontSize: 10.5, color: CD.faint, marginTop: 12 }}>Prepared by {me ? `${me.name} · ${me.role}` : '—'} · {stampNow()}. The cash figures are the book's expected float; enter the physical count and variance, then both parties sign.</div>
          </div>
        </div>);
      }

      if (id === 'pnl') {
        const hstRate = (settings && settings.hstRate != null) ? +settings.hstRate : 13;
        const hstOnFees = data.fees * (hstRate / 100);
        const net = data.rev; // revenue is net to the business; HST is collected on top, remitted separately
        const margin = data.vol ? (data.rev / data.vol) * 100 : 0;
        return (<div>
          <DocHead title="Profit & Loss" subtitle={`${branchName} · ${sub}`} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Gross revenue', value: fmt(data.rev, 'CAD'), accent: CD.green, sub: 'fees + FX spread' },
            { label: 'Commission (fees)', value: fmt(data.fees, 'CAD') },
            { label: 'FX spread', value: fmt(data.spread, 'CAD') },
            { label: 'Margin %', value: `${margin.toFixed(2)}%`, sub: 'of pay-in volume' }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle>Profit &amp; loss statement</SecTitle></div>
            <table><tbody>
              <tr><td style={{ ...tdS, fontWeight: 600 }}>Commission &amp; service fees</td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(data.fees, 'CAD')}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 600 }}>FX spread (rate markup booked)</td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(data.spread, 'CAD')}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 700, borderTop: `2px solid ${CD.line}` }}>Gross revenue</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: CD.green, borderTop: `2px solid ${CD.line}` }}>{fmt(data.rev, 'CAD')}</td></tr>
              <tr><td style={{ ...tdS, color: CD.mute }}>GST/HST collected on commission ({hstRate}%) <span style={{ color: CD.faint }}>— remitted to CRA, not income</span></td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(hstOnFees, 'CAD')}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 700 }}>Net revenue to business</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: CD.green }}>{fmt(net, 'CAD')}</td></tr>
            </tbody></table>
          </Card>
          <Cols>
            <Card><SecTitle>Revenue by type</SecTitle><Bars data={data.feeType} fmtV={v => fmt(v, 'CAD')} accent={CD.green} /></Card>
            <Card><SecTitle>Revenue by teller</SecTitle><Bars data={data.feeTeller} fmtV={v => fmt(v, 'CAD')} accent={CD.green} /></Card>
          </Cols>
          <div style={{ fontSize: 11, color: CD.faint, lineHeight: 1.6, padding: '2px' }}>FX spread is the markup booked into the rate vs. the live spot; it is not separately taxed. GST/HST is estimated on commission income at {hstRate}% — confirm your registration and rate. This is a management P&amp;L, not a filed financial statement.</div>
          <Attest />
        </div>);
      }

      if (id === 'summary') {
        const avg = data.n ? data.vol / data.n : 0;
        return (<div>
          <DocHead title="Period Summary" subtitle={sub} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Pay-in volume', value: fmt(data.vol, 'CAD') },
            { label: 'Transactions', value: data.n },
            { label: 'Avg. ticket', value: fmt(avg, 'CAD') },
            { label: 'Total revenue', value: fmt(data.rev, 'CAD'), accent: CD.green, sub: 'fees + spread' }
          ]} />
          <Cols>
            <Card><SecTitle>Pay-in volume by currency</SecTitle><Bars data={data.byCcy} fmtV={v => fmt(v, 'CAD')} /></Card>
            <Card><SecTitle>Volume by transaction type</SecTitle><Bars data={data.byType} fmtV={v => fmt(v, 'CAD')} /></Card>
          </Cols>
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle>Cash drawer movement</SecTitle></div>
            <table><thead><tr><th style={thS}>Currency</th><th style={{ ...thS, textAlign: 'right' }}>Received (in)</th><th style={{ ...thS, textAlign: 'right' }}>Paid out</th><th style={{ ...thS, textAlign: 'right' }}>Net position</th></tr></thead>
              <tbody>{data.drawer.map(d => (<tr key={d.ccy}>
                <td style={tdS}><b>{d.ccy}</b></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(d.inA)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(d.outA)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: d.net >= 0 ? CD.green : CD.flag }}>{d.net >= 0 ? '+' : ''}{num(d.net)}</td>
              </tr>))}
              {data.drawer.length === 0 && <tr><td style={tdS} colSpan={4}>No movement in this period.</td></tr>}
              </tbody></table>
          </Card>
          <Card>
            <SecTitle>Compliance snapshot</SecTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <Mini label="Reportable ≥ $10k" value={`${data.reportable.length}`} sub={`${data.filed} filed · ${data.reportable.length - data.filed} open`} tone={data.reportable.length - data.filed > 0 ? CD.flag : CD.green} />
              <Mini label="Structuring watch" value={`${data.stru.length}`} sub="clients aggregating" tone={data.stru.length ? CD.amber : CD.green} />
              <Mini label="KYC / ID gaps" value={`${data.kycGaps.length}`} sub="clients to verify" tone={data.kycGaps.length ? CD.flag : CD.green} />
            </div>
          </Card>
        </div>);
      }
      if (id === 'fintrac') {
        return (<div>
          <DocHead title="FINTRAC / LCTR Compliance Pack" subtitle="Large Cash Transaction Reports, structuring watch and KYC exceptions" rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Reportable deals', value: data.reportable.length, sub: `≥ ${fmt(THRESHOLD, 'CAD')}` },
            { label: 'LCTRs filed', value: data.filed, accent: CD.green },
            { label: 'Open / unfiled', value: data.reportable.length - data.filed, accent: data.reportable.length - data.filed ? CD.flag : CD.green },
            { label: 'Structuring watch', value: data.stru.length, accent: data.stru.length ? CD.amber : CD.ink }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={`${data.reportable.length} record(s)`}>Reportable transactions — LCTR ≥ {fmt(THRESHOLD, 'CAD')}</SecTitle></div>
            <table><thead><tr><th style={thS}>Ref</th><th style={thS}>Date</th><th style={thS}>Customer</th><th style={{ ...thS, textAlign: 'right' }}>Amount</th><th style={{ ...thS, textAlign: 'right' }}>CAD equiv</th><th style={{ ...thS, textAlign: 'center' }}>Status</th></tr></thead>
              <tbody>{data.reportable.map(r => (<tr key={r.id}>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute }}>{r.ref}</td>
                <td style={tdS}>{r.date}</td><td style={tdS}>{r.customer}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(r.inAmt)} {r.inCcy}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(cadOf(r.inAmt, r.inCcy), 'CAD')}</td>
                <td style={{ ...tdS, textAlign: 'center' }}>{r.filed
                  ? <span style={{ fontSize: 10, fontWeight: 700, color: CD.green, background: CD.greenSoft, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{r.filedInfo && r.filedInfo.ref || 'FILED'}</span>
                  : <span style={{ fontSize: 10, fontWeight: 700, color: CD.flag, background: CD.flagSoft, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>UNFILED</span>}</td>
              </tr>))}
              {data.reportable.length === 0 && <tr><td style={tdS} colSpan={6}>No reportable transactions in this period.</td></tr>}
              </tbody></table>
          </Card>
          <Cols>
            <Card><SecTitle n={`${data.stru.length}`}>Structuring watch</SecTitle>
              {data.stru.length === 0 ? <div style={{ fontSize: 12, color: CD.faint }}>No clients aggregating to the threshold.</div>
                : data.stru.map(s => (<div key={s.customer} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: `1px solid ${CD.lineSoft}` }}>
                  <div><div style={{ fontSize: 13, color: CD.ink, fontWeight: 500 }}>{s.customer}</div><div style={{ fontSize: 10.5, color: CD.mute }}>{settings.structuringDays}-day total {fmt(s.agg, 'CAD')}</div></div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: s.ack ? CD.mute : CD.amber, background: s.ack ? CD.lineSoft : CD.amberSoft, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{s.ack ? 'REVIEWED' : 'REVIEW'}</span>
                </div>))}
            </Card>
            <Card><SecTitle n={`${data.kycGaps.length}`}>KYC / ID exceptions</SecTitle>
              {data.kycGaps.length === 0 ? <div style={{ fontSize: 12, color: CD.faint }}>All active clients verified.</div>
                : data.kycGaps.map(k => (<div key={k.customer} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: `1px solid ${CD.lineSoft}` }}>
                  <div style={{ fontSize: 13, color: CD.ink, fontWeight: 500 }}>{k.customer}</div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: CD.flag, background: CD.flagSoft, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{k.issue.toUpperCase()}</span>
                </div>))}
            </Card>
          </Cols>
          <div style={{ fontSize: 11, color: CD.faint, lineHeight: 1.6, padding: '4px 2px' }}>
            Prepared for FINTRAC record-keeping under the PCMLTFA. Large Cash Transaction Reports are required for single cash amounts of {fmt(THRESHOLD, 'CAD')} or more, with 24-hour aggregation. This pack is a working summary — verify each filing in the official portal.
          </div>
          <Attest />
        </div>);
      }
      if (id === 'revenue') {
        const margin = data.vol ? (data.rev / data.vol) * 100 : 0;
        return (<div>
          <DocHead title="Revenue & Earnings" subtitle="Posted fees plus the FX spread booked at the counter" rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Fees collected', value: fmt(data.fees, 'CAD'), accent: CD.green },
            { label: 'FX spread', value: fmt(data.spread, 'CAD'), accent: CD.green, sub: 'booked margin' },
            { label: 'Total revenue', value: fmt(data.rev, 'CAD'), accent: CD.green },
            { label: 'Margin %', value: `${margin.toFixed(2)}%`, sub: 'of pay-in volume' }
          ]} />
          <Cols>
            <Card><SecTitle>Earnings by teller</SecTitle><Bars data={data.feeTeller} fmtV={v => fmt(v, 'CAD')} accent={CD.green} /></Card>
            <Card><SecTitle>Earnings by type</SecTitle><Bars data={data.feeType} fmtV={v => fmt(v, 'CAD')} accent={CD.green} /></Card>
          </Cols>
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={`top ${Math.min(data.perTx.length, 25)} of ${data.perTx.length}`}>Earnings per transaction</SecTitle></div>
            <table><thead><tr><th style={thS}>Ref</th><th style={thS}>Customer</th><th style={thS}>Type</th><th style={{ ...thS, textAlign: 'right' }}>Fee</th><th style={{ ...thS, textAlign: 'right' }}>Spread</th><th style={{ ...thS, textAlign: 'right' }}>Earned</th><th style={{ ...thS, textAlign: 'right' }}>Margin</th></tr></thead>
              <tbody>{data.perTx.slice(0, 25).map(o => (<tr key={o.r.id}>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute }}>{o.r.ref}</td>
                <td style={tdS}>{o.r.customer}</td><td style={{ ...tdS, color: CD.mute }}>{o.r.type}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(o.fee, 'CAD')}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{o.sp > 0 ? fmt(o.sp, 'CAD') : '—'}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: CD.green }}>{fmt(o.earned, 'CAD')}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{o.vol ? ((o.earned / o.vol) * 100).toFixed(1) + '%' : '—'}</td>
              </tr>))}
              {data.perTx.length === 0 && <tr><td style={tdS} colSpan={7}>No transactions in this period.</td></tr>}
              </tbody></table>
          </Card>
        </div>);
      }
      if (id === 'register') {
        return (<div>
          <DocHead title="Transaction Register" subtitle={`${data.inP.length} record(s) including voided — the complete book`} rangeLabel={effRangeLabel} />
          <Card pad={0}>
            <table><thead><tr>
              <th style={thS}>Ref</th><th style={thS}>Date / time</th><th style={thS}>Customer</th><th style={thS}>Type</th>
              <th style={{ ...thS, textAlign: 'right' }}>Pay-in</th><th style={{ ...thS, textAlign: 'right' }}>Pay-out</th><th style={{ ...thS, textAlign: 'right' }}>Fee</th><th style={thS}>Teller</th><th style={{ ...thS, textAlign: 'center' }}>Flags</th>
            </tr></thead>
              <tbody>{data.inP.map(r => { const f = flags[r.id] || {}; const isVoid = r.status === 'void'; return (<tr key={r.id} style={{ opacity: isVoid ? 0.5 : 1 }}>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute, textDecoration: isVoid ? 'line-through' : 'none' }}>{r.ref}</td>
                <td style={{ ...tdS, whiteSpace: 'nowrap' }}>{r.date} <span style={{ color: CD.faint }}>{r.time}</span></td>
                <td style={{ ...tdS, fontWeight: 500 }}>{r.customer}</td>
                <td style={{ ...tdS, color: CD.mute }}>{r.type}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{num(r.inAmt)} <span style={{ color: CD.faint }}>{r.inCcy}</span></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: CD.green }}>{r.outAmt === '' ? '—' : num(r.outAmt)} <span style={{ color: CD.faint }}>{r.outCcy}</span></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.fee, 'CAD')}</td>
                <td style={{ ...tdS, color: CD.mute }}>{r.teller}</td>
                <td style={{ ...tdS, textAlign: 'center', fontFamily: 'Space Mono, monospace', fontSize: 10 }}>
                  {isVoid ? <span style={{ color: CD.mute }}>VOID</span> : <span>{[f.single ? 'RPT' : '', f.str ? 'STR' : '', (f.kyc && f.kyc !== 'ok') ? 'ID' : ''].filter(Boolean).join(' ') || '—'}</span>}
                </td>
              </tr>); })}
              {data.inP.length === 0 && <tr><td style={tdS} colSpan={9}>No records in this period.</td></tr>}
              </tbody></table>
          </Card>
          <div style={{ fontSize: 11, color: CD.faint, padding: '2px' }}>RPT = reportable ≥ {fmt(THRESHOLD, 'CAD')} · STR = structuring watch · ID = KYC exception. Voided records are retained, struck through, and never deleted.</div>
        </div>);
      }
      if (id === 'kyc') {
        const names = Array.from(new Set([...Object.keys(clients), ...data.live.map(r => r.customer)])).sort();
        const stat = (n) => { const c = clients[n] || {}; if (!c.idType || !c.idNum) return ['missing ID', CD.flag, CD.flagSoft]; if (c.idExpiry && c.idExpiry < TODAY) return ['ID expired', CD.flag, CD.flagSoft]; return ['verified', CD.green, CD.greenSoft]; };
        return (<div>
          <DocHead title="Client & KYC Register" subtitle={`${names.length} client file(s) · activity within ${rangeLabel.toLowerCase()}`} rangeLabel={effRangeLabel} />
          <Card pad={0}>
            <table><thead><tr><th style={thS}>Client</th><th style={thS}>ID type</th><th style={thS}>ID number</th><th style={thS}>Expiry</th><th style={{ ...thS, textAlign: 'center' }}>Status</th><th style={{ ...thS, textAlign: 'right' }}>Tx</th><th style={{ ...thS, textAlign: 'right' }}>Volume</th></tr></thead>
              <tbody>{names.map(n => { const c = clients[n] || {}; const [st, col, bg] = stat(n); const tx = data.live.filter(r => r.customer === n); const v = tx.reduce((s, r) => s + cadOf(r.inAmt, r.inCcy), 0); return (<tr key={n}>
                <td style={{ ...tdS, fontWeight: 500 }}>{n}</td>
                <td style={{ ...tdS, color: CD.mute }}>{c.idType || '—'}</td>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute }}>{c.idNum || '—'}</td>
                <td style={{ ...tdS, color: c.idExpiry && c.idExpiry < TODAY ? CD.flag : CD.mute }}>{c.idExpiry || '—'}</td>
                <td style={{ ...tdS, textAlign: 'center' }}><span style={{ fontSize: 10, fontWeight: 700, color: col, background: bg, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{st.toUpperCase()}</span></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{tx.length}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{v ? fmt(v, 'CAD') : '—'}</td>
              </tr>); })}</tbody></table>
          </Card>
        </div>);
      }
      return null;
    };

    /* ---------- shells ---------- */
    function Mini({ label, value, sub, tone }) {
      return (<div style={{ border: `1px solid ${CD.line}`, borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ fontSize: 10.5, color: CD.mute, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: tone || CD.ink, marginTop: 2 }}>{value}</div>
        {sub && <div style={{ fontSize: 10.5, color: CD.faint, marginTop: 1 }}>{sub}</div>}
      </div>);
    }
    function Attest() {
      return (<div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${CD.line}`, display: 'flex', justifyContent: 'space-between', gap: 30 }}>
        {['Prepared by', 'Compliance officer'].map(r => (<div key={r} style={{ flex: 1 }}>
          <div style={{ height: 30, borderBottom: `1px solid ${CD.ink}` }}></div>
          <div style={{ fontSize: 10.5, color: CD.mute, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}><span>{r}</span><span>Date</span></div>
        </div>))}
      </div>);
    }

    const RangePicker = (
      <div style={{ position: 'relative' }}>
        <button onClick={() => setMenu(m => !m)} className="flex items-center gap-2 px-3 py-2 text-sm" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>
          <Ic n="calendar" s={15} c={CD.mute} /> <span style={{ fontWeight: 500 }}>{rangeLabel}</span> <span style={{ transform: 'rotate(90deg)', display: 'inline-flex' }}><Ic n="chev" s={12} c={CD.mute} /></span>
        </button>
        {menu && (<div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 6, width: 190, background: 'var(--cd-paper-soft)', border: `1px solid ${CD.line}`, borderRadius: 11, boxShadow: '0 14px 34px -10px var(--cd-shade)', zIndex: 60, padding: 5 }}>
          {RANGES.map(([id, label]) => { const on = range === id; return (<button key={id} onClick={() => { setRange(id); setMenu(false); }} className="w-full flex items-center justify-between px-3 py-2 text-left text-sm" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.text, borderRadius: 7 }}>{label}{on && <Ic n="check" s={13} c="var(--cd-on-ink)" />}</button>); })}
        </div>)}
      </div>
    );

    const filterCount = activeFilters.length;
    const clearScope = () => setScope({ customers: [], tellers: [], types: [], from: '', to: '' });
    const addTo = (key, val) => setScope(s => s[key].includes(val) ? s : ({ ...s, [key]: [...s[key], val] }));
    const removeFrom = (key, val) => setScope(s => ({ ...s, [key]: s[key].filter(x => x !== val) }));
    const selSty = { width: '100%', fontSize: 13, padding: '8px 10px', border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', color: CD.ink, outline: 'none' };

    function ScopeRow({ label, scopeKey, options, placeholder }) {
      const [val, setVal] = useState('');
      const items = scope[scopeKey];
      const listId = 'scope-' + scopeKey;
      const tryAdd = (v) => { const t = (v || '').trim(); if (t && options.includes(t)) { addTo(scopeKey, t); setVal(''); return true; } return false; };
      return (<div>
        <div style={{ fontSize: 11, color: CD.mute, marginBottom: 5 }}>{label}{items.length > 0 && <span style={{ color: CD.faint }}> · {items.length} selected</span>}</div>
        {items.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>{items.map(it => (
          <span key={it} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999, padding: '3px 5px 3px 10px', maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it}</span>
            <button onClick={() => removeFrom(scopeKey, it)} style={{ display: 'grid', placeItems: 'center', width: 16, height: 16, borderRadius: '50%', background: 'var(--cd-on-ink-faint)', flex: 'none' }}><Ic n="x" s={10} c="var(--cd-on-ink)" /></button>
          </span>))}</div>}
        <div style={{ position: 'relative' }}>
          <input list={listId} value={val} onChange={e => { if (!tryAdd(e.target.value)) setVal(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); tryAdd(val); } }} placeholder={items.length ? 'Add another…' : placeholder} style={{ ...selSty, paddingRight: 26 }} />
          <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><Ic n="plus" s={13} c={CD.faint} /></span>
          <datalist id={listId}>{options.filter(o => !items.includes(o)).map(o => <option key={o} value={o} />)}</datalist>
        </div>
      </div>);
    }

    const FilterControl = (
      <div style={{ position: 'relative' }}>
        <button onClick={() => setFilterOpen(o => !o)} className="flex items-center gap-2 px-3 py-2 text-sm" style={{ background: filterCount ? CD.ink : CD.panel, border: `1px solid ${filterCount ? CD.ink : CD.line}`, borderRadius: 8, color: filterCount ? 'var(--cd-on-ink)' : CD.ink }}>
          <Ic n="search" s={14} c={filterCount ? 'var(--cd-on-ink)' : CD.mute} /> <span style={{ fontWeight: 500 }}>Filters</span>{filterCount > 0 && <span style={{ fontSize: 11, fontWeight: 700, background: 'var(--cd-panel)', color: CD.ink, borderRadius: 999, padding: '0 6px', fontFamily: 'Space Mono, monospace' }}>{filterCount}</span>}
        </button>
        {filterOpen && (<div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 6, width: 308, background: 'var(--cd-paper-soft)', border: `1px solid ${CD.line}`, borderRadius: 13, boxShadow: '0 18px 40px -10px var(--cd-scrim)', zIndex: 70, overflow: 'hidden' }}>
          <div className="flex items-center justify-between" style={{ padding: '11px 14px', borderBottom: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
            <span style={{ fontSize: 11, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: CD.faint }}>Scope this report</span>
            {filterCount > 0 ? <button onClick={clearScope} className="text-[11px] font-medium" style={{ color: CD.flag }}>Clear all</button> : <span className="text-[11px]" style={{ color: CD.faint }}>everything</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, maxHeight: 'min(60vh, 440px)', overflow: 'auto' }}>
            <ScopeRow label="Clients" scopeKey="customers" options={customersList} placeholder="All clients — type to add one" />
            <ScopeRow label="Tellers" scopeKey="tellers" options={tellersList} placeholder="All tellers" />
            <ScopeRow label="Transaction types" scopeKey="types" options={TYPES || []} placeholder="All types" />
            <div>
              <div style={{ fontSize: 11, color: CD.mute, marginBottom: 5 }}>Custom date range <span style={{ color: CD.faint }}>· overrides the period</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input type="date" value={scope.from} max={TODAY} onChange={e => setScope(s => ({ ...s, from: e.target.value }))} style={selSty} />
                <input type="date" value={scope.to} max={TODAY} onChange={e => setScope(s => ({ ...s, to: e.target.value }))} style={selSty} />
              </div>
            </div>
          </div>
          <div style={{ padding: '11px 14px', borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span className="text-[11px]" style={{ color: CD.mute }}>{filterCount ? `${filterCount} filter${filterCount > 1 ? 's' : ''} active` : 'No filters'}</span>
            <button onClick={() => setFilterOpen(false)} className="px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}>Done</button>
          </div>
        </div>)}
      </div>
    );

    // ---- access manager (Owner / Manager): role × report matrix ----
    const toggleAccess = (role, id) => {
      setAccess(prev => {
        const cur = prev[role] || DEFAULT_ACCESS[role] || [];
        const has = cur.includes(id);
        const nx = { ...prev, [role]: has ? cur.filter(x => x !== id) : [...cur, id] };
        try { localStorage.setItem(AKEY, JSON.stringify(nx)); } catch (e) {}
        return nx;
      });
    };
    const resetAccess = () => { try { localStorage.removeItem(AKEY); } catch (e) {} setAccess({ ...DEFAULT_ACCESS }); };

    if (manageAccess && canManage) {
      return (<div style={{ height: '100%', overflow: 'auto', background: 'transparent' }}>
        <div className="px-5 py-5" style={{ maxWidth: 880, margin: '0 auto' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setManageAccess(false)} className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="arrowleft" s={15} /> Reports</button>
              <span className="text-sm font-semibold ml-1" style={{ color: CD.ink }}>Report access by role</span>
            </div>
            <button onClick={resetAccess} className="px-3 py-2 text-[12px]" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute, background: CD.panel }}>Reset to defaults</button>
          </div>
          <p className="text-[12px] mb-3" style={{ color: CD.mute }}>Tick which reports each role can generate. Staff only see and generate the sheets allowed for their role; everything else is locked.</p>
          <div style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12, overflow: 'hidden' }}>
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: 'var(--cd-chip)' }}>
                <th style={{ ...thS, position: 'sticky', left: 0 }}>Report</th>
                {ROLES.map(role => <th key={role} style={{ ...thS, textAlign: 'center', whiteSpace: 'nowrap' }}>{role}</th>)}
              </tr></thead>
              <tbody>{REPORTS.map(rep => (<tr key={rep.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                <td style={{ ...tdS, fontWeight: 500 }}><span className="inline-flex items-center gap-2"><span className="grid place-items-center" style={{ width: 24, height: 24, borderRadius: 6, background: rep.tone }}><Ic n={rep.icon} s={13} c="var(--cd-on-ink)" /></span>{rep.title}</span></td>
                {ROLES.map(role => { const on = (access[role] || DEFAULT_ACCESS[role] || []).includes(rep.id); const locked = role === 'Owner'; return (
                  <td key={role} style={{ ...tdS, textAlign: 'center' }}>
                    <button onClick={() => !locked && toggleAccess(role, rep.id)} title={locked ? 'Owner always has full access' : ''} className="grid place-items-center mx-auto" style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${on ? CD.green : CD.line}`, background: on ? CD.green : 'transparent', cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.7 : 1 }}>{on && <Ic n="check" s={13} c="var(--cd-on-ink)" />}</button>
                  </td>); })}
              </tr>))}</tbody>
            </table>
          </div>
        </div>
      </div>);
    }

    // ---- launcher: reports to generate, gated by the signed-in user's role ----
    if (!active) {
      const visible = REPORTS;
      const openReport = (id) => { if (!canGen(id)) return; if (id === 'endofday') { setRange('today'); setScope({ customers: [], tellers: [], types: [], from: '', to: '' }); } setActive(id); };
      return (<div style={{ height: '100%', overflow: 'auto', background: 'transparent' }}>
        <div className="px-5 py-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-[12px]" style={{ color: CD.mute }}>Signed in as <b style={{ color: CD.ink }}>{me ? me.name : '—'}</b> · {myRole} — you can generate {allowed.length} of {REPORTS.length} reports</div>
            {canManage && <button onClick={() => setManageAccess(true)} className="flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="gear" s={14} c={CD.mute} /> Manage access</button>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 14 }}>
            {visible.map(r => { const ok = canGen(r.id); return (
              <button key={r.id} onClick={() => openReport(r.id)} className="text-left" style={{ background: CD.panel, border: `1px solid ${ok && r.signed ? CD.green : CD.line}`, borderRadius: 13, padding: 18, cursor: ok ? 'pointer' : 'not-allowed', opacity: ok ? 1 : 0.55, transition: 'border-color .14s, box-shadow .14s, transform .14s' }}
                onMouseEnter={e => { if (!ok) return; e.currentTarget.style.borderColor = CD.ink; e.currentTarget.style.boxShadow = '0 10px 26px -12px var(--cd-shade)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = ok && r.signed ? CD.green : CD.line; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}>
                <div className="flex items-center justify-between mb-9">
                  <span className="grid place-items-center" style={{ width: 42, height: 42, background: ok ? r.tone : CD.faint, borderRadius: 11 }}><Ic n={r.icon} s={21} c="var(--cd-on-ink)" /></span>
                  {ok
                    ? <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5" style={{ background: r.signed ? CD.green : CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}><Ic n={r.signed ? 'check' : 'filetext'} s={13} c="var(--cd-on-ink)" /> {r.signed ? 'Sign off' : 'Generate'}</span>
                    : <span className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 8 }}><Ic n="lock" s={12} c={CD.mute} /> Restricted</span>}
                </div>
                <div style={{ fontSize: 15.5, fontWeight: 700, color: CD.ink }}>{r.title}</div>
                <div style={{ fontSize: 12, color: CD.mute, marginTop: 3, lineHeight: 1.45 }}>{ok ? r.desc : `Not available for ${myRole}. Ask an owner or manager.`}</div>
              </button>); })}
          </div>
          <p className="mt-5 text-[11px] flex items-center gap-1.5" style={{ color: CD.faint }}><Ic n="shield" s={12} /> Reports read the live, immutable ledger. Every generated report is saved to History as a frozen snapshot — print / Save-PDF ready and exportable to CSV.{canManage ? ' Access is configurable per role via Manage access.' : ''}</p>
        </div>
      </div>);
    }

    // ---- document view ----
    const meta = REPORTS.find(r => r.id === active);
    return (<div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${CD.line}`, background: CD.panel, flex: 'none' }}>
        <div className="flex items-center gap-2">
          <button onClick={() => setActive(null)} className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="arrowleft" s={15} /> All reports</button>
          <span className="text-sm font-semibold ml-1" style={{ color: CD.ink }}>{meta.title}</span>
        </div>
        <div className="flex items-center gap-2">
          {active !== 'endofday' && FilterControl}
          {RangePicker}
          <button onClick={() => downloadCsv(`${active}-${range}.csv`, csvFor(active))} className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="download" s={15} /> CSV</button>
          <button onClick={() => printReport(meta.title)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="printer" s={15} /> Print / PDF</button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '22px' }}>
        <div id="cdos-report-doc" style={{ maxWidth: 820, margin: '0 auto', background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 4, boxShadow: '0 8px 30px -12px var(--cd-shade)', padding: '34px 38px' }}>
          {renderDoc(active)}
          <DocFoot />
        </div>
      </div>
    </div>);
  }

  /* ============================================================
     Report history — every generated report, frozen as an immutable
     snapshot. Its own Compliance tab: filter by type, re-open, re-print.
     ============================================================ */
  function ReportHistory() {
    const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]') || []; } catch (e) { return []; } });
    const [histFilter, setHistFilter] = useState('all');
    const [period, setPeriod] = useState('all');
    const [search, setSearch] = useState('');
    const [viewing, setViewing] = useState(null);
    const persist = (h) => { const cap = h.slice(0, 500); setHistory(cap); try { localStorage.setItem(HKEY, JSON.stringify(cap)); } catch (e) {} };
    const remove = (key) => persist(history.filter(e => e.key !== key));
    const metaFor = (type) => { const r = REPORTS.find(x => x.id === type); return r ? { label: r.title, icon: r.icon, tone: r.tone } : { label: type, icon: 'lock', tone: CD.flag }; };
    const openWindow = (html, title) => { const w = window.open('', '_blank', 'width=900,height=1100'); if (!w) return; w.document.write(html); w.document.close(); setTimeout(() => w.focus(), 200); };

    // saved-snapshot viewer (generated business/compliance reports render inline)
    if (viewing) {
      return (<div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${CD.line}`, background: CD.panel, flex: 'none' }}>
          <div className="flex items-center gap-2">
            <button onClick={() => setViewing(null)} className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="arrowleft" s={15} /> History</button>
            <span className="text-sm font-semibold ml-1" style={{ color: CD.ink }}>{viewing.title}</span>
            <span className="text-[11px] px-2 py-1" style={{ background: CD.lineSoft, borderRadius: 6, color: CD.mute, fontFamily: 'Space Mono, monospace' }}>SAVED · {viewing.at}</span>
          </div>
          <button onClick={() => printReport(viewing.title)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="printer" s={15} /> Print / PDF</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '22px' }}>
          <div id="cdos-report-doc" style={{ maxWidth: 820, margin: '0 auto', background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 4, boxShadow: '0 8px 30px -12px var(--cd-shade)', padding: '34px 38px' }} dangerouslySetInnerHTML={{ __html: viewing.html }} />
        </div>
      </div>);
    }

    const q = search.trim().toLowerCase();
    const matchesQ = (e) => !q || [e.title, e.ref, e.ack, e.subject, e.rangeLabel, e.at, metaFor(e.type).label].filter(Boolean).some(s => String(s).toLowerCase().includes(q));
    const PERIODS = [['all', 'All time'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['365d', 'This year']];
    const matchesPeriod = (e) => {
      if (period === 'all' || !e.ms) return true;
      const age = (Date.now() - e.ms) / 86400000;
      if (period === 'today') return age < 1;
      return age <= ({ '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period] || 1e9);
    };
    const typeCount = (id) => history.filter(e => e.type === id).length;
    const typesPresent = Array.from(new Set(history.map(e => e.type)));
    const filtered = history.filter(e => (histFilter === 'all' || e.type === histFilter) && matchesPeriod(e) && matchesQ(e));

    const openEntry = (e) => { if (e.filing && e.fullHTML) openWindow(e.fullHTML, e.title); else setViewing(e); };

    return (<div style={{ height: '100%', overflow: 'auto', background: 'transparent' }}>
      <div className="px-5 py-5">
        {history.length === 0 ? (
          <div className="grid place-items-center text-center" style={{ padding: '70px 0', color: CD.faint }}>
            <span className="grid place-items-center mb-3" style={{ width: 50, height: 50, background: CD.lineSoft, borderRadius: 13 }}><Ic n="scroll" s={24} c={CD.mute} /></span>
            <div className="text-[14px] font-medium" style={{ color: CD.mute }}>Nothing in history yet</div>
            <div className="text-[12px] mt-1" style={{ maxWidth: 360 }}>Every report generated and every compliance filing sealed is saved here automatically — permanently, and searchable.</div>
          </div>
        ) : (<>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 9, flex: '1 1 240px', minWidth: 200 }}>
              <Ic n="search" s={15} c={CD.mute} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, reference, FWR receipt…" className="outline-none text-sm bg-transparent flex-1" style={{ color: CD.ink, minWidth: 60 }} />
              {search && <button onClick={() => setSearch('')} className="grid place-items-center" style={{ width: 18, height: 18 }}><Ic n="x" s={13} c={CD.mute} /></button>}
            </div>
            <div className="relative flex items-center" style={{ flex: '0 0 auto' }}>
              <select value={histFilter} onChange={e => setHistFilter(e.target.value)} className="text-[13px] font-medium outline-none appearance-none cursor-pointer" style={{ background: CD.panel, border: `1px solid ${histFilter === 'all' ? CD.line : CD.ink}`, borderRadius: 9, color: CD.ink, padding: '8px 30px 8px 12px' }}>
                <option value="all">All report types ({history.length})</option>
                {typesPresent.map(t => <option key={t} value={t}>{metaFor(t).label} ({typeCount(t)})</option>)}
              </select>
              <span className="absolute pointer-events-none" style={{ right: 10, display: 'inline-flex' }}><Ic n="chev" s={13} c={CD.mute} /></span>
            </div>
            <div className="relative flex items-center" style={{ flex: '0 0 auto' }}>
              <select value={period} onChange={e => setPeriod(e.target.value)} className="text-[13px] font-medium outline-none appearance-none cursor-pointer" style={{ background: CD.panel, border: `1px solid ${period === 'all' ? CD.line : CD.ink}`, borderRadius: 9, color: CD.ink, padding: '8px 30px 8px 12px' }}>
                {PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <span className="absolute pointer-events-none" style={{ right: 10, display: 'inline-flex' }}><Ic n="chev" s={13} c={CD.mute} /></span>
            </div>
            <button onClick={() => { if (confirm('Clear the entire report history? This cannot be undone.')) persist([]); }} className="px-2.5 py-2 text-[12px] flex-none" style={{ color: CD.mute, border: `1px solid ${CD.line}`, borderRadius: 9, background: CD.panel }}>Clear all</button>
          </div>
          <div style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12, overflow: 'hidden' }}>
            {filtered.map((e, i) => (
              <div key={e.key} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, background: e.tone || metaFor(e.type).tone, borderRadius: 9 }}><Ic n={e.icon || metaFor(e.type).icon} s={16} c="var(--cd-on-ink)" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold truncate flex items-center gap-1.5" style={{ color: CD.ink }}>{e.title}{e.filing && <span className="text-[9px] px-1.5 py-0.5 font-semibold flex-none" style={{ background: e.badgeBg || CD.greenSoft, color: e.badgeColor || CD.green, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>{e.badge || 'FILED'}</span>}</div>
                  <div className="text-[11.5px] flex items-center gap-1.5 flex-wrap" style={{ color: CD.mute }}>
                    {e.filing
                      ? <><span style={{ fontFamily: 'Space Mono, monospace' }}>FWR {e.ack}</span><span style={{ color: CD.faint }}>·</span><span style={{ fontFamily: 'Space Mono, monospace' }}>{e.ref}</span></>
                      : <><span style={{ fontFamily: 'Space Mono, monospace' }}>{e.rangeLabel}</span><span style={{ color: CD.faint }}>·</span><span>{e.n} tx</span></>}
                    <span style={{ color: CD.faint }}>·</span><span>{e.at}</span>
                  </div>
                </div>
                <button onClick={() => openEntry(e)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n={e.filing ? 'printer' : 'filetext'} s={13} c={CD.mute} /> Open</button>
                <button onClick={() => remove(e.key)} title="Remove from history" className="grid place-items-center flex-none" style={{ width: 30, height: 30, border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute, background: CD.panel }}><Ic n="trash" s={14} c={CD.mute} /></button>
              </div>
            ))}
            {filtered.length === 0 && <div className="px-4 py-10 text-center text-[12.5px]" style={{ color: CD.faint }}>{q ? `No results for “${search}”.` : 'No reports match these filters.'}</div>}
          </div>
        </>)}
      </div>
    </div>);
  }

  /* ============================================================
     Demo seed — a realistic spread of history so the tab isn't empty
     on first look. Runs once; never overwrites real entries, and a
     "Clear all" sticks (the seed flag is set regardless).
     ============================================================ */
  function seedFakeHistory(force) {
    const SEEDFLAG = 'cdos_report_history_seed_v3';
    if (!force) {
      try {
        if (localStorage.getItem(SEEDFLAG)) return;
        const existing = JSON.parse(localStorage.getItem(HKEY) || '[]') || [];
        if (existing.length) { localStorage.setItem(SEEDFLAG, '1'); return; }
      } catch (e) { return; }
    }

    const ms = (s) => Date.parse(s.replace(' ', 'T'));
    const meta = (id) => REPORTS.find(r => r.id === id) || { icon: 'filetext', tone: CD.ink };
    const P = { ink: '#262216', mute: '#6f6857', faint: '#9a927e', line: '#e4e0d5', soft: '#f1efe7', green: '#1f8a5b', flag: '#c0392b', brass: '#9a7b3f' };

    // a believable one-page report document
    const doc = (title, sub, rangeLabel, kpis, table) => `
      <div style="font-family:'Archivo',system-ui,sans-serif;color:${P.ink};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:16px;border-bottom:2px solid ${P.ink};margin-bottom:22px;">
          <div>
            <div style="display:flex;align-items:center;gap:9px;"><span style="width:30px;height:30px;background:${P.ink};color:#fff;border-radius:7px;display:grid;place-items:center;font-family:'Space Mono',monospace;font-weight:700;font-size:13px;">CD</span><div style="font-family:'Space Mono',monospace;font-weight:700;font-size:13px;letter-spacing:.04em;">CURRENCYDESK OS</div></div>
            <div style="font-size:23px;font-weight:800;margin-top:12px;">${title}</div>
            <div style="font-size:12.5px;color:${P.mute};margin-top:2px;">${sub}</div>
          </div>
          <div style="text-align:right;font-size:11px;color:${P.mute};line-height:1.7;"><div style="font-family:'Space Mono',monospace;font-weight:700;color:${P.ink};font-size:12px;">${rangeLabel}</div><div>York Currency Exchange · MSB</div></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(${kpis.length},1fr);gap:1px;background:${P.line};border:1px solid ${P.line};margin-bottom:22px;">
          ${kpis.map(k => `<div style="background:#fff;padding:13px 15px;"><div style="font-size:10.5px;color:${P.mute};text-transform:uppercase;letter-spacing:.06em;">${k[0]}</div><div style="font-size:20px;font-weight:700;color:${k[2] || P.ink};margin-top:3px;font-variant-numeric:tabular-nums;">${k[1]}</div></div>`).join('')}
        </div>
        <div style="background:#fff;border:1px solid ${P.line};border-radius:10px;overflow:hidden;">
          <table style="border-collapse:collapse;width:100%;">
            <thead><tr>${table.head.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${P.mute};padding:8px 12px;background:${P.soft};border-bottom:1px solid ${P.line};font-weight:600;">${h}</th>`).join('')}</tr></thead>
            <tbody>${table.rows.map(r => `<tr>${r.map((c, i) => `<td style="font-size:12px;padding:8px 12px;border-bottom:1px solid ${P.soft};color:${P.ink};text-align:${i ? 'right' : 'left'};font-variant-numeric:tabular-nums;">${c}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;

    // a believable sealed filing document
    const sealed = (kind, kindLabel, subject, ref, ack, when, amount) => `
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>${kind} ${ref}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:40px 46px;color:${P.ink};}</style></head>
      <body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${P.ink};padding-bottom:16px;margin-bottom:22px;">
          <div><div style="font-family:'Space Mono',monospace;font-weight:700;font-size:13px;letter-spacing:.04em;">YORK CURRENCY EXCHANGE · MSB</div><div style="font-size:24px;font-weight:800;margin-top:10px;">${kindLabel}</div><div style="font-size:12.5px;color:${P.mute};margin-top:2px;">Sealed filed copy · ${kind}</div></div>
          <div style="text-align:right;font-size:11px;color:${P.mute};line-height:1.8;"><div style="display:inline-flex;align-items:center;gap:6px;background:#e7f3ec;color:${P.green};font-family:'Space Mono',monospace;font-weight:700;padding:4px 10px;border-radius:6px;">● SEALED</div><div style="margin-top:6px;">FWR receipt <b style="color:${P.ink};font-family:'Space Mono',monospace;">${ack}</b></div><div>Filed ${when}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:${P.line};border:1px solid ${P.line};margin-bottom:20px;">
          ${[['Report reference', ref], ['Subject', subject], ['Amount (CAD equiv)', amount], ['Filed by', 'A. Singh']].map(k => `<div style="background:#fff;padding:13px 15px;"><div style="font-size:10.5px;color:${P.mute};text-transform:uppercase;letter-spacing:.06em;">${k[0]}</div><div style="font-size:15px;font-weight:700;margin-top:3px;font-family:'Space Mono',monospace;">${k[1]}</div></div>`).join('')}
        </div>
        <div style="font-size:11.5px;color:${P.faint};line-height:1.6;">Immutable record retained under the PCMLTFA. This sealed copy is welded to the ledger entries that triggered it and cannot be altered. Verify against the official FINTRAC portal acknowledgement.</div>
      </body></html>`;

    const entries = [
      { type: 'register', range: 'today', rangeLabel: 'Today', at: '2026-06-24 21:40:10', n: 12,
        html: doc('Transaction Register', '12 records including voided — the complete book', 'Today',
          [['Records', '12'], ['Pay-in volume', '$84,210'], ['Fees', '$612']],
          { head: ['Ref', 'Customer', 'Pay-in', 'Fee'], rows: [['TX-4471', 'Maple Leaf Logistics Inc.', '8,200 USD', '$58.00'], ['TX-4470', 'Ashley Turner', '3,100 EUR', '$24.50'], ['TX-4469', 'Chris Delaney', '1,900 GBP', '$19.00'], ['TX-4468', 'Lauren Bishop', '12,400 USD', '$84.00']] }) },
      { type: 'summary', range: '30d', rangeLabel: 'Past 30 days', at: '2026-06-24 09:12:04', n: 142,
        html: doc('Period Summary', '142 posted transactions · CAD-equivalent at live spot', 'Past 30 days',
          [['Pay-in volume', '$1.84M'], ['Transactions', '142'], ['Avg. ticket', '$12,950'], ['Total revenue', '$21,470', P.green]],
          { head: ['Currency', 'Pay-in volume CAD'], rows: [['USD', '$1,102,400'], ['EUR', '$421,900'], ['GBP', '$208,300'], ['JPY', '$74,210'], ['SEK', '$33,100']] }) },
      { type: 'LCTR', filing: true, title: 'Large Cash Transaction Report · Brooke Lawson', icon: 'lock', tone: CD.flag, at: '2026-06-21 10:15:22', ref: 'LCTR-2026-L7XN0', ack: 'FIN-4471', subject: 'Brooke Lawson', amount: '$14,820',
        fullHTML: sealed('LCTR', 'Large Cash Transaction Report', 'Brooke Lawson', 'LCTR-2026-L7XN0', 'FIN-4471', '2026-06-21 10:15', '$14,820.00') },
      { type: 'revenue', range: '7d', rangeLabel: 'Past 7 days', at: '2026-06-23 17:48:31', n: 38,
        html: doc('Revenue & Earnings', 'Posted fees plus the FX spread booked at the counter', 'Past 7 days',
          [['Fees collected', '$2,140', P.green], ['FX spread', '$3,880', P.green], ['Total revenue', '$6,020', P.green], ['Margin %', '1.42%']],
          { head: ['Teller', 'Earned'], rows: [['A. Singh', '$2,710'], ['M. Cole', '$1,940'], ['R. Diaz', '$1,370']] }) },
      { type: 'fintrac', range: '90d', rangeLabel: 'This quarter', at: '2026-06-22 11:03:55', n: 211,
        html: doc('FINTRAC / LCTR Compliance Pack', 'Large Cash Transaction Reports, structuring watch and KYC exceptions', 'This quarter',
          [['Reportable deals', '14'], ['LCTRs filed', '12', P.green], ['Open / unfiled', '2', P.flag], ['Structuring watch', '3']],
          { head: ['Ref', 'Customer', 'CAD equiv', 'Status'], rows: [['LCTR-…L7XN0', 'Brooke Lawson', '$14,820', 'FILED'], ['LCTR-…22KP9', 'Northbridge Imports', '$26,400', 'FILED'], ['LCTR-…4HO55', 'Maple Leaf Logistics', '$11,295', 'UNFILED']] }) },
      { type: 'LCTR', filing: true, title: 'Large Cash Transaction Report · Northbridge Imports', icon: 'lock', tone: CD.flag, at: '2026-06-15 16:02:44', ref: 'LCTR-2026-22KP9', ack: 'FIN-5520', subject: 'Northbridge Imports', amount: '$26,400',
        fullHTML: sealed('LCTR', 'Large Cash Transaction Report', 'Northbridge Imports', 'LCTR-2026-22KP9', 'FIN-5520', '2026-06-15 16:02', '$26,400.00') },
      { type: 'kyc', range: '365d', rangeLabel: 'This year', at: '2026-06-18 14:20:09', n: 96,
        html: doc('Client & KYC Register', '96 client files · activity within this year', 'This year',
          [['Client files', '96'], ['Verified', '88', P.green], ['ID gaps', '8', P.flag]],
          { head: ['Client', 'Status', 'Volume'], rows: [['Maple Leaf Logistics', 'VERIFIED', '$182,400'], ['Brooke Lawson', 'VERIFIED', '$61,200'], ['Marcus Reed', 'MISSING ID', '$9,400']] }) },
      { type: 'EFTR', filing: true, title: 'Electronic Funds Transfer Report · Jakob Miller', icon: 'lock', tone: '#1d4ed8', at: '2026-06-09 13:31:08', ref: 'EFTR-2026-9XQ12', ack: 'FIN-6093', subject: 'Jakob Miller', amount: '$18,950',
        fullHTML: sealed('EFTR', 'Electronic Funds Transfer Report', 'Jakob Miller', 'EFTR-2026-9XQ12', 'FIN-6093', '2026-06-09 13:31', '$18,950.00') }
    ];

    const seed = entries.map((e, i) => {
      const m = meta(e.type);
      const base = { key: 'SEED' + i + '_' + (e.ref || e.type), ms: ms(e.at), at: e.at, type: e.type };
      if (e.filing) return { ...base, title: e.title, icon: e.icon, tone: e.tone, ref: e.ref, ack: e.ack, subject: e.subject, amount: e.amount, filing: true, fullHTML: e.fullHTML };
      return { ...base, title: m === REPORTS.find(r => r.id === e.type) ? REPORTS.find(r => r.id === e.type).title : e.type, icon: m.icon, tone: m.tone, range: e.range, rangeLabel: e.rangeLabel, n: e.n, html: e.html };
    }).sort((a, b) => b.ms - a.ms);

    let cur = []; try { cur = JSON.parse(localStorage.getItem(HKEY) || '[]') || []; } catch (e) {}
    const merged = [...seed, ...cur.filter(c => !seed.some(s => s.key === c.key))].sort((a, b) => b.ms - a.ms);
    try { localStorage.setItem(HKEY, JSON.stringify(merged)); localStorage.setItem(SEEDFLAG, '1'); } catch (e) {}
  }
  seedFakeHistory();

  window.CDOS = Object.assign(window.CDOS || {}, { Reports, ReportHistory, _seedHistory: seedFakeHistory });
})();
