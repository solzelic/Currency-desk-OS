/* ============================================================
   CurrencyDesk OS — Reports
   One-touch report generation off the live ledger. Pick a period,
   tap a report, and a formatted, print-ready document is built
   instantly: Period Summary, the desk's large-cash compliance pack,
   Revenue & Earnings, Transaction Register, Client & KYC Register.
   Print / Save-PDF and CSV export on every report.

   THESE ARE DOCUMENTS SOMEBODY SIGNS. The rule they follow is written
   down in docs/GENERATED_DOCUMENTS.md and it is short: every figure on a
   generated document comes from the ledger, is labelled in the desk's own
   currency, and is shown as absent when the book has no answer. A printed
   0.00 becomes evidence.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const HKEY = 'cdos_report_history_v1';
  const AKEY = 'cdos_report_access_v1';
  const { CD, Ic, TYPES, crossRate, perCadLive, fmt, num, dDiff, dealMargin, CCY,
    businessDate, businessDayWindow, reportingLimit, useDeskFacts, deskPack, Absent } = window.CDOS;
  /* The desk's own reporting line, in the desk's own currency. This file
     used to print `THRESHOLD` — a hardcoded 10,000 Canadian dollars — in
     four places, including the sentence claiming what the law requires,
     while the rest of the product honoured the owner's setting. */
  const limitOf = (settings) => reportingLimit(settings);

  /* WHO REGULATES THIS DESK, AND WHAT THE FORM IS CALLED.

     This file printed "Prepared for FINTRAC record-keeping under the
     PCMLTFA" on a compliance pack regardless of which country installed
     the product. The regulator, the report's name and the country are
     facts about the jurisdiction pack the entity points at, and the pack
     carries all three (`regulator`, `reportName`, `name`).

     getRegime() is deliberately NOT the first source here. It is the
     browser's own two-country table and it falls back to FINTRAC when
     `settings.regime` is unset — which is exactly how a London desk came
     to print a Canadian regulator's name. The server's pack is what the
     entity was actually created with, so it wins; the regime engine is a
     fallback for a desk that has not reached the server yet, and where
     neither can answer the document says "the regulator" rather than
     naming one. */
  function authorityOf(settings) {
    const pack = deskPack();
    const regime = (window.CDOS.getRegime ? window.CDOS.getRegime(settings) : null) || {};
    return {
      /* null, not a guess — a sentence claiming what a named regulator
         requires is not a sentence to fill in with a default. */
      authority: (pack && pack.regulator) || regime.authority || null,
      country: (pack && pack.name) || regime.country || null,
      largeCode: (pack && pack.reportName) || regime.largeCode || null,
      largeLabel: regime.largeLabel || ((pack && pack.reportName) ? pack.reportName + ' report' : null),
      aggHours: regime.aggHours || null,
    };
  }

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

  /* A foreign amount expressed in the desk's own money, or null.

     This was `cadOf`, and it divided by `crossRate('CAD', ccy)` on every
     desk in the world. The browser's rate board is quoted in units per
     CANADIAN dollar — that is what `PER_CAD` means — so on a London or
     Dubai entity this produced a Canadian-dollar figure and printed a
     pound sign in front of it. Same reasoning as the server's own
     `unitHome` in reporting.ts, which also refuses to value anything when
     the home currency is not the one the board is quoted against.

     Returns null rather than a number the reader cannot check. Every call
     site has to decide what to do with that, which is the point — see
     docs/ABSENT_FIGURES.md. */
  const homeEquiv = (amt, ccy, home) => {
    if (!home) return null;
    if (ccy === home) return +amt || 0;
    if (home !== 'CAD') return null;
    const rate = crossRate('CAD', ccy);
    return rate ? (+amt || 0) / rate : null;
  };
  // booked spread per deal — exact when two-side priced, else the live-mid estimate
  const spreadOf = (r) => dealMargin(r);
  const stampNow = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  /* The ledger records WHO posted a deal as a principal id, tenant-scoped
     ("tnt-yorkfx:a.singh"). Earnings by teller is the book's answer, so the
     id is the book's; turning it back into a person is presentation, and
     it is done from whatever staff list the desk actually has. An id with
     nobody behind it prints as the id rather than as a blank — a row of
     earnings attributed to nothing is a thing somebody needs to notice. */
  const principalOf = (id) => String(id == null ? '' : id).split(':').pop() || '';
  function tellerName(actorId, settings) {
    const staffId = principalOf(actorId);
    if (!staffId) return '—';
    const roster = (settings && Array.isArray(settings.employees) && settings.employees.length)
      ? settings.employees : (window.CDOS.STAFF || []);
    const found = roster.find(s => s && (s.staffId === staffId || s.name === staffId));
    return (found && found.name) || staffId;
  }
  /* A money field the ledger sent, or a dash and a reason. Inline rather
     than <Absent>, because these appear inside table cells and KPI tiles
     that are cloned into a print window — the printed page has no React. */
  const orDash = (value, currency, why) => value == null
    ? <span style={{ color: CD.faint }}>{why ? '— ' + why : '—'}</span>
    : fmt(value, currency);

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
    /* Named by the desk's own pack — see titleOf() below. The launcher card
       said "FINTRAC / LCTR Pack" on every desk in every country, which is
       the same defect as the document it opens. */
    { id: 'fintrac',  title: 'Large-Cash Compliance Pack', icon: 'shield', desc: 'Reportable deals, structuring watches and KYC gaps.', tone: CD.flag },
    { id: 'revenue',  title: 'Revenue & Earnings',    icon: 'coins',    desc: 'Fees plus FX spread, broken down by teller and type.',  tone: CD.green },
    { id: 'register', title: 'Transaction Register',  icon: 'scroll',   desc: 'The full book for the period — every posted record.',   tone: CD.ink },
    { id: 'kyc',      title: 'Client & KYC Register', icon: 'id',       desc: 'Every client, ID status and period activity.',          tone: CD.ink }
  ];

  /* What to call a report on this desk. Only the compliance pack changes
     with the jurisdiction; everything else is the desk's own document and
     is named the same everywhere. */
  function titleOf(report) {
    if (report.id !== 'fintrac') return report.title;
    const pack = deskPack();
    return (pack && pack.regulator && pack.reportName)
      ? `${pack.regulator} / ${pack.reportName} Pack`
      : report.title;
  }

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
    /* The trading day and the jurisdiction pack, from the server. Reports
       print, get signed and get filed, so both of these being right is not
       cosmetic: a close-out sheet headed with the wrong date and a
       threshold sentence quoting the wrong country's number is a document
       somebody keeps for five years. */
    const deskFacts = useDeskFacts();
    const limit = useMemo(() => limitOf(settings), [settings, deskFacts]);
    const regime = useMemo(() => authorityOf(settings), [settings, deskFacts]);
    /* WHAT THE DESK IS HOLDING AT CLOSE — the ledger's figure.

       The End-of-Day Sign-Off used to fill this column by DERIVING each
       currency from a demo opening baseline plus the browser's records,
       which is how a sign-off sheet came to be printed and signed over
       nine currencies the desk did not have. A report whose cash column
       cannot be sourced prints "—", which is the honest thing for a
       document that gets filed. */
    const [held, setHeld] = useState({ loading: true, position: null, error: '' });
    /* And what the desk earned over the trading day this till is in. The
       close-out sheet is the document that gets signed and filed, so its
       headline has to be the book's figure: fees plus the realized margin
       the disposal booked, not a spread re-estimated against a market mid.
       See docs/COST_BASIS.md. */
    const [dayBook, setDayBook] = useState({ loading: true, summary: null, error: '' });
    /* THE PHYSICAL COUNT, AS THE LEDGER RECORDED IT.

       The sign-off sheet used to read its "Counted" column out of
       localStorage — `cdos_till_history_v2` — which the Cash Drawer seeded
       with a YEAR of invented daily counts on first open. That is where the
       sheet's CAD variance of −249,270.79 came from, on a day the reconcile
       screen it was generated from said "Drawers off 0 · Total variance 0".
       Two books, disagreeing by a third of a million dollars, on the page
       with the signature lines.

       `GET /api/ledger/till-session` carries `latestCounts`: what was
       counted, what was expected AT COUNT TIME, and the variance the server
       computed from the two. That is the count that exists; a count taken
       on a machine and never sent is not one. */
    const [tillDay, setTillDay] = useState({ loading: true, session: null, counts: {}, error: '' });
    useEffect(() => {
      const backend = window.CDOS.Backend;
      if (!backend) {
        setHeld({ loading: false, position: null, error: 'not signed in to the ledger' });
        setDayBook({ loading: false, summary: null, error: 'not signed in to the ledger' });
        setTillDay({ loading: false, session: null, counts: {}, error: 'not signed in to the ledger' });
        return;
      }
      let live = true;
      backend.loadLedgerPosition()
        .then(position => { if (live) setHeld({ loading: false, position, error: '' }); })
        .catch(error => { if (live) setHeld({ loading: false, position: null, error: (error && error.message) || 'the ledger could not be reached' }); });
      backend.loadLedgerSummary(window.CDOS.businessDayWindow(1))
        .then(summary => { if (live) setDayBook({ loading: false, summary, error: '' }); })
        .catch(error => { if (live) setDayBook({ loading: false, summary: null, error: (error && error.message) || 'the ledger could not be reached' }); });
      backend.loadTillSession()
        .then(answer => { if (live) setTillDay({ loading: false, session: (answer && answer.session) || null, counts: (answer && answer.latestCounts) || {}, error: '' }); })
        .catch(error => { if (live) setTillDay({ loading: false, session: null, counts: {}, error: (error && error.message) || 'the ledger could not be reached' }); });
      return () => { live = false; };
    }, [deskFacts]);
    const [active, setActive] = useState(null);
    /* THE PERIOD'S OWN BOOK.

       Volume, fees and earnings on every other report were summed here in
       the browser, over `rows` — a copy of the last hundred ledger
       transactions, re-priced against a live market mid. Two things were
       wrong with that on a printed document. The margin was an ESTIMATE
       (docs/COST_BASIS.md: the desk earns what the disposal booked, not
       what a mid says it should have), and the copy is capped at a hundred
       records, so a busy quarter silently reported a fraction of itself.

       So the headline figures come from GET /api/ledger/summary over the
       same window the report is scoped to. The row-by-row tables still
       render `rows`, because those rows ARE ledger transactions and a
       register is a list, not a total. */
    const [periodBook, setPeriodBook] = useState({ loading: true, summary: null, error: '' });
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
      const ago = dDiff(date, businessDate());
      return ago >= -0.0001 && ago <= days + 0.0001;
    };
    const allRange = range === 'all';
    const within = (d) => allRange ? true : inRange(d);

    /* The window to ask the book for, as two instants. A custom date range
       the user typed is honoured; "All time" is an omitted window, which
       the server reads as everything this till has ever posted. */
    const bookWindow = useMemo(() => {
      if (scope.from || scope.to) {
        const at = (d, plusDay) => {
          const t = new Date(d + 'T00:00:00');
          if (plusDay) t.setDate(t.getDate() + 1);
          return t.toISOString();
        };
        return { from: scope.from ? at(scope.from) : undefined, to: scope.to ? at(scope.to, true) : undefined };
      }
      const days = (RANGES.find(r => r[0] === range) || [])[2];
      return days == null ? {} : businessDayWindow(Math.max(1, days || 1));
    }, [range, scope.from, scope.to, deskFacts]);

    useEffect(() => {
      const backend = window.CDOS.Backend;
      if (!backend) { setPeriodBook({ loading: false, summary: null, error: 'not signed in to the ledger' }); return; }
      let live = true;
      setPeriodBook(b => ({ ...b, loading: true }));
      backend.loadLedgerSummary(bookWindow)
        .then(summary => { if (live) setPeriodBook({ loading: false, summary, error: '' }); })
        .catch(error => { if (live) setPeriodBook({ loading: false, summary: null, error: (error && error.message) || 'the ledger could not be reached' }); });
      return () => { live = false; };
    }, [bookWindow]);

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
    const effRangeLabel = useCustomDates ? `${scope.from || 'start'} → ${scope.to || businessDate()}` : rangeLabel;

    /* The currency this desk keeps its books in, as the pack states it —
       not a "CAD" literal. */
    const homeCcy = (held.position && held.position.homeCurrency) || limit.currency || 'CAD';

    const flags = useMemo(() => window.CDOS.computeFlags(rows, clients, settings), [rows, clients, settings, deskFacts]);

    const data = useMemo(() => {
      const inP = rows.filter(r => inWindow(r.date) && matchesScope(r));
      const live = inP.filter(r => r.status !== 'void');
      let vol = 0, fees = 0, spread = 0;
      const byCcy = {}, byType = {}, feeTeller = {}, feeType = {}, drawerIn = {}, drawerOut = {};
      live.forEach(r => {
        const v = homeEquiv(r.inAmt, r.inCcy, homeCcy), fee = +r.fee || 0, sp = spreadOf(r);
        vol += (v || 0); fees += fee; spread += sp;
        if (v != null) { byCcy[r.inCcy] = (byCcy[r.inCcy] || 0) + v; byType[r.type] = (byType[r.type] || 0) + v; }
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
      const perTx = live.map(r => ({ r, fee: +r.fee || 0, sp: spreadOf(r), vol: homeEquiv(r.inAmt, r.inCcy, homeCcy) }))
        .map(o => ({ ...o, earned: o.fee + o.sp })).sort((a, b) => b.earned - a.earned);
      return {
        inP, live, vol, fees, spread, rev: fees + spread, n: live.length,
        byCcy: sortE(byCcy), byType: sortE(byType), feeTeller: sortE(feeTeller), feeType: sortE(feeType),
        reportable, stru, kycGaps, drawer, perTx,
        filed: reportable.filter(r => r.filed).length,
        /* CASH ON HAND AT CLOSE — the drawer, and the count of the drawer.

           This table used to put the branch's WHOLE position — drawer plus
           strong room, which is what position().currencies totals — in a
           column headed "On the ledger", and subtract from it a count of
           the DRAWER. Those are two different boxes. The reconcile screen
           the sheet was generated from compares the drawer against the
           drawer and said every currency balanced; the sheet compared the
           drawer against the drawer plus the safe and printed a CAD
           variance of −249,270.79 above the signature lines. Nobody had
           lost anything. The sheet was subtracting a safe.

           So the ledger column is `row.till` — the box that was counted —
           and the safe is reported separately, as its own line, because an
           owner signing a close-out is entitled to see it and it must
           never be netted into a variance. */
        cash: (() => {
          const position = held.position;
          if (!position) return [];
          const counts = tillDay.counts || {};
          return (position.currencies || []).map(row => {
            const till = row.till;
            const record = counts[row.currency];
            /* The variance the SERVER computed when the count was taken,
               against the expected balance AT THAT MOMENT. Recomputing it
               here against the balance now would silently fold in every
               movement since the count — which is a different number with
               the same name. */
            return {
              ccy: row.currency,
              /* null, not zero: a currency held only in the safe has no
                 drawer balance, and a drawer line of 0.00 against a
                 counted figure would read as a variance. */
              units: till ? Number(till.quantity) : null,
              home: till && till.marketValueHome != null ? Number(till.marketValueHome) : null,
              vaultUnits: row.vault ? Number(row.vault.quantity) : null,
              counted: record && record.counted != null ? Number(record.counted) : null,
              countedExpected: record && record.expected != null ? Number(record.expected) : null,
              variance: record && record.variance != null ? Number(record.variance) : null,
              countedAt: record ? record.countedAt : null,
            };
          }).filter(x => x.units != null || x.counted != null || x.vaultUnits != null);
        })()
      };
    }, [rows, clients, settings, range, flags, scope, held.position, tillDay.counts, homeCcy]);

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
        const entry = { key: 'R' + nowMs.toString(36) + Math.random().toString(36).slice(2, 5), ms: nowMs, type: active, title: titleOf(meta), icon: meta.icon, tone: meta.tone, range, rangeLabel, at: stampNow(), n: data.n, html: node.innerHTML };
        try { localStorage.setItem(HKEY, JSON.stringify([entry, ...hist].slice(0, 500))); } catch (e) {}
      }, 140);
      return () => clearTimeout(t);
    }, [active, range]);

    /* A CSV cell for a figure the ledger has no answer for. Blank, never
       "0.00" — a spreadsheet is where an absent figure most easily becomes
       a confident one, because SUM() treats a blank and a zero identically
       but a reader does not. */
    const csvMoney = (v) => v == null ? '' : Number(v).toFixed(2);
    const csvFor = (id) => {
      const s = periodBook.summary;
      if (id === 'endofday') {
        const d = dayBook.summary;
        return [['Currency', 'In the drawer · ledger', `${homeCcy} value`, 'Counted', 'Variance', 'In the safe · ledger'],
          ...data.cash.map(x => [x.ccy, csvMoney(x.units), csvMoney(x.home), csvMoney(x.counted), csvMoney(x.variance), csvMoney(x.vaultUnits)]),
          [], ['Transactions', d ? d.posted : ''], ['Voided', d ? d.reversed : ''],
          [`Pay-in volume ${homeCcy}`, d ? csvMoney(d.volumeHome) : ''],
          [`Fees ${homeCcy}`, d ? csvMoney(d.feesHome) : ''],
          [`Realized margin ${homeCcy}`, d ? csvMoney(d.realizedPnlHome) : ''],
          [`Earned ${homeCcy}`, d ? csvMoney(d.earningsHome) : ''],
          ['Reportable', data.reportable.length], [`Open ${regime.largeCode || 'reports'}`, data.reportable.length - data.filed]];
      }
      if (id === 'pnl') { const hstRate = (settings && settings.hstRate != null) ? +settings.hstRate : 13; return [['Line', homeCcy], ['Commission & fees', s ? csvMoney(s.feesHome) : ''], ['Realized FX margin', s ? csvMoney(s.realizedPnlHome) : ''], ['Gross revenue', s ? csvMoney(s.earningsHome) : ''], [`Sales tax on commission (${hstRate}%)`, s && s.feesHome != null ? (Number(s.feesHome) * hstRate / 100).toFixed(2) : ''], ['Net revenue to business', s ? csvMoney(s.earningsHome) : '']]; }
      if (id === 'summary') return [['Currency', 'Sold to customers', `Realized margin ${homeCcy}`], ...((s && s.byCurrency) || []).map(c => [c.currency, csvMoney(c.sold), csvMoney(c.realizedPnlHome)])];
      if (id === 'fintrac') return [['Ref', 'Date', 'Customer', 'Amount', 'Currency', `${homeCcy} equiv`, 'Filed', `${regime.largeCode || 'Report'} ref`],
        ...data.reportable.map(r => [r.ref, r.date, r.customer, r.inAmt, r.inCcy, csvMoney(homeEquiv(r.inAmt, r.inCcy, homeCcy)), r.filed ? 'yes' : 'NO', r.filedInfo && r.filedInfo.ref || ''])];
      if (id === 'revenue') return [['Teller', 'Deals', `Fees ${homeCcy}`, `Realized margin ${homeCcy}`, `Earned ${homeCcy}`, 'Deals with a cost basis'],
        ...((s && s.byActor) || []).map(a => [tellerName(a.actorId, settings), a.deals, csvMoney(a.feesHome), csvMoney(a.realizedPnlHome), csvMoney(a.earningsHome), a.pricedDeals])];
      if (id === 'register') return [['Ref', 'Date', 'Time', 'Customer', 'Type', 'In', 'InCcy', 'Out', 'OutCcy', 'Fee', 'Teller', 'Status'],
        ...data.inP.map(r => [r.ref, r.date, r.time, r.customer, r.type, r.inAmt, r.inCcy, r.outAmt, r.outCcy, r.fee, r.teller, r.status])];
      if (id === 'kyc') {
        const names = Array.from(new Set([...Object.keys(clients), ...data.live.map(r => r.customer)]));
        return [['Client', 'ID type', 'ID number', 'Expiry', 'Status', 'Tx in period', `Volume ${homeCcy}`],
          ...names.map(n => { const c = clients[n] || {}; const tx = data.live.filter(r => r.customer === n);
            const parts = tx.map(r => homeEquiv(r.inAmt, r.inCcy, homeCcy));
            const v = parts.some(p => p == null) ? null : parts.reduce((sum, p) => sum + p, 0);
            const st = (!c.idType || !c.idNum) ? 'missing ID' : (c.idExpiry && c.idExpiry < businessDate() ? 'ID expired' : 'verified');
            return [n, c.idType || '', c.idNum || '', c.idExpiry || '', st, tx.length, csvMoney(v)]; })];
      }
      return [];
    };

    /* ---------- the five documents ---------- */
    const renderDoc = (id) => {
      const book = periodBook.summary;
      /* Why a figure on this document is a dash, in one short line. The
         order matters: "we could not reach the book" and "the book has
         nothing for this period" are different answers and a reader acting
         on them does different things. */
      const noBook = periodBook.error || (periodBook.loading ? 'reading the ledger…' : 'nothing posted in this period');
      const sub = book
        ? `${book.posted} posted transaction${book.posted === 1 ? '' : 's'}${book.reversed ? ` · ${book.reversed} voided` : ''} · valued in ${homeCcy}`
        : `the ledger has no figures for this period — ${noBook}`;
      const branchName = (station && branches && (branches.find(b => b.id === station.branchId) || {}).name) || (settings && (settings.operatingName || settings.bizName)) || 'York Currency Exchange';
      const tillName = (station && station.tillId) ? (((branches || []).find(b => b.id === station.branchId) || {}).tills || []).find(t => t.id === station.tillId)?.name : null;

      if (id === 'endofday') {
        const d = dayBook.summary;
        /* Why the day's money reads "—", said once and reused. "Nothing was
           posted" and "we could not reach the book" are different facts and
           a manager signing the sheet acts differently on each. */
        const whyNoDay = dayBook.error || (dayBook.loading ? 'reading the ledger…' : 'nothing posted on this trading day');
        /* A total is only a total when every line has a figure. Where one
           currency in the drawer could not be valued the sheet prints a dash
           and names the reason rather than a sum that quietly omits it. */
        const drawerRows = data.cash.filter(x => x.units != null);
        const cashComplete = drawerRows.length > 0 && drawerRows.every(x => x.home != null);
        const totalCashHome = cashComplete ? drawerRows.reduce((s, x) => s + x.home, 0) : null;
        const unvalued = drawerRows.filter(x => x.home == null).map(x => x.ccy);
        const openRpt = data.reportable.length - data.filed;
        /* Earnings by teller, from the book — GET /api/ledger/summary's
           byActor block. This panel used to be summed in the browser and on
           the desk that was audited it named three tellers with money beside
           them, on a day one person had traded once and voided it. */
        const earners = (d && d.byActor) || [];
        /* The day the sheet is FOR. The business date the till session
           carries, not the wall clock — a session opened before midnight is
           still on yesterday's trading day at 00:05, and the sheet has to
           agree with the movements filed under it. The session's own number
           replaces "Day 1", which was a counter kept in the browser. */
        const sheetDate = (tillDay.session && tillDay.session.businessDate) || businessDate();
        const dayLabel = tillDay.session ? `Session #${tillDay.session.sessionNumber}` : 'no till session';
        const longDate = (() => { try { return new Date(sheetDate + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return sheetDate; } })();
        const closed = tillDay.session && tillDay.session.status === 'closed';
        return (<div>
          <DocHead title="End-of-Day Sign-Off" subtitle={`${branchName}${tillName ? ' · ' + tillName : ''} · ${longDate} · ${dayLabel}`} rangeLabel={effRangeLabel} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, padding: '10px 14px', background: closed ? CD.greenSoft : 'var(--cd-chip)', border: `1px solid ${closed ? CD.green : CD.line}`, borderRadius: 9 }}>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: closed ? CD.green : CD.mute, display: 'grid', placeItems: 'center', flex: 'none' }}><span style={{ color: 'var(--cd-on-ink)', fontSize: 14 }}>{closed ? '✓' : '·'}</span></span>
            <div style={{ fontSize: 12.5, color: closed ? '#14543a' : CD.mute }}>
              {closed
                ? <><b>Closed and counted</b> — every figure below is the ledger's, for the trading day named above. Review, then sign.</>
                : <><b>This till is not closed.</b> The figures below are the ledger's as of now; the counts are whatever has been recorded so far. A sign-off sheet for a day still trading is a snapshot, not a close-out.</>}
            </div>
          </div>
          {/* THE CLOSE-OUT FIGURES, FROM THE BOOK. These used to be summed
              in the browser over a demo seed — the sheet read "Earned today
              $223.00 · Transactions 10" for a desk that had posted one deal
              and voided it. A dash here is correct and signable; a wrong
              number is not. */}
          <KpiRow items={[
            { label: 'Transactions', value: d ? d.posted : '—', sub: d ? (d.reversed ? `${d.reversed} voided` : 'none voided') : whyNoDay },
            { label: 'Pay-in volume', value: d && d.volumeHome != null ? fmt(d.volumeHome, homeCcy) : '—', sub: d && d.volumeHome != null ? `in ${homeCcy}` : whyNoDay },
            { label: 'Earned today', value: d && d.earningsHome != null ? fmt(d.earningsHome, homeCcy) : '—', accent: CD.green, sub: d && d.earningsHome != null ? 'commission + realized margin' : whyNoDay },
            { label: 'In the drawer', value: totalCashHome == null ? '—' : fmt(totalCashHome, homeCcy), sub: totalCashHome == null ? (held.error || (unvalued.length ? `no board rate for ${unvalued.join(', ')}` : 'no ledger balances for this drawer')) : `the ledger’s ${homeCcy} value at close` }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={`${data.cash.length} currenc${data.cash.length === 1 ? 'y' : 'ies'}`}>This drawer at close — the ledger vs. the count</SecTitle></div>
            {!data.cash.length ? (
              <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{held.loading ? 'Reading the ledger…' : `This till has no cash balances on the ledger${held.error ? ' — ' + held.error : ''}. Nothing is printed here rather than a figure from somewhere else.`}</div>
            ) : (<>
            <table><thead><tr><th style={thS}>Currency</th><th style={{ ...thS, textAlign: 'right' }}>In the drawer</th><th style={{ ...thS, textAlign: 'right' }}>{homeCcy} value</th><th style={{ ...thS, textAlign: 'right' }}>Counted</th><th style={{ ...thS, textAlign: 'right' }}>Variance</th><th style={{ ...thS, textAlign: 'right' }}>In the safe</th></tr></thead>
              <tbody>{data.cash.map(x => { const off = x.variance != null && Math.abs(x.variance) > 0.005; return (<tr key={x.ccy}>
                <td style={tdS}><b>{x.ccy}</b></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: x.units == null ? CD.faint : CD.ink }}>{x.units == null ? '— not in this drawer' : num(x.units)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: x.home == null ? CD.faint : CD.ink }}>{x.home == null ? '— no board rate' : fmt(x.home, homeCcy)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: x.counted == null ? CD.faint : CD.ink }}>{x.counted == null ? '— not counted' : num(x.counted)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: x.variance != null ? 600 : 400, color: x.variance == null ? CD.faint : off ? CD.flag : CD.green }}>{x.variance == null ? '—' : (Math.abs(x.variance) < 0.005 ? '✓ balanced' : (x.variance > 0 ? '+' : '') + num(x.variance))}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{x.vaultUnits == null ? '—' : num(x.vaultUnits)}</td>
              </tr>); })}
              {(() => {
                /* The counted and variance totals are only offered in the
                   desk's own money when every counted line can BE valued in
                   it. Summing a home value the board cannot produce is how
                   the old sheet reached a total; where it cannot, the column
                   still totals the per-currency variances it does have, and
                   says which currencies it could not price. */
                const counted = data.cash.filter(x => x.counted != null);
                const ctParts = counted.map(x => homeEquiv(x.counted, x.ccy, homeCcy));
                const vParts = counted.map(x => homeEquiv(x.variance == null ? 0 : x.variance, x.ccy, homeCcy));
                const ctTot = ctParts.length && ctParts.every(p => p != null) ? ctParts.reduce((s, p) => s + p, 0) : null;
                const vTot = vParts.length && vParts.every(p => p != null) ? vParts.reduce((s, p) => s + p, 0) : null;
                const off = vTot != null && Math.abs(vTot) > 0.005;
                return (
                <tr><td style={{ ...tdS, fontWeight: 700 }} colSpan={2}>{`Total · ${homeCcy}`}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{totalCashHome == null ? '—' : fmt(totalCashHome, homeCcy)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{ctTot == null ? '—' : fmt(ctTot, homeCcy)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: vTot == null ? CD.faint : off ? CD.flag : CD.green }}>{vTot == null ? '—' : (Math.abs(vTot) < 0.005 ? '✓ balanced' : (vTot > 0 ? '+' : '') + fmt(vTot, homeCcy))}</td>
                  <td style={tdS}></td></tr>
              ); })()}
              </tbody></table>
            {/* The note the reader gets says what the columns ARE. It does
                NOT recount how they were once wrong: a filed document is
                not the place for a changelog, and printing the old
                six-figure discrepancy on the page put a number on the
                sheet that belongs to no transaction. The history lives in
                docs/GENERATED_DOCUMENTS.md and in the comment above. */}
            <div style={{ fontSize: 10.5, color: CD.faint, padding: '8px 16px 2px' }}>
              Every figure in this table is the server ledger's. <b>In the drawer</b> is this till's own balance — not the branch's, which would also include the safe. <b>Counted</b> and <b>variance</b> are what the ledger recorded when the count was taken, measured against the expected balance at that moment. A currency not counted says so; a currency the branch has never published a rate for cannot be valued and says so. <b>In the safe</b> is shown for information and is never netted into a variance.
            </div>
            </>)}
          </Card>
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={earners.length ? `${earners.length} on the book` : null}>Earnings by teller — from the ledger</SecTitle></div>
            {!earners.length ? (
              <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{d ? 'Nobody posted a deal at this till on this trading day. No earnings are attributed rather than a table of zeros.' : `The ledger has no answer — ${whyNoDay}.`}</div>
            ) : (<table><thead><tr><th style={thS}>Teller</th><th style={{ ...thS, textAlign: 'right' }}>Deals</th><th style={{ ...thS, textAlign: 'right' }}>Commission</th><th style={{ ...thS, textAlign: 'right' }}>Realized margin</th><th style={{ ...thS, textAlign: 'right' }}>Earned</th></tr></thead>
              <tbody>{earners.map(a => (<tr key={a.actorId}>
                <td style={tdS}><b>{tellerName(a.actorId, settings)}</b></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{a.deals}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.feesHome, homeCcy, 'no fee recorded')}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.realizedPnlHome, homeCcy, a.pricedDeals ? 'not priced' : 'nothing sold')}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: a.earningsHome == null ? CD.faint : CD.green }}>{orDash(a.earningsHome, homeCcy, 'nothing to attribute')}</td>
              </tr>))}</tbody></table>)}
            {earners.some(a => a.pricedDeals < a.deals) && <div style={{ fontSize: 10.5, color: CD.faint, padding: '8px 16px 2px' }}>Some deals here carry no cost basis, so the margin beside them covers fewer deals than the count. See docs/COST_BASIS.md — the desk earns what the disposal booked, and a deal the book never priced has no margin to report.</div>}
          </Card>
          <Card>
            <SecTitle>Compliance at close</SecTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <Mini label={limit.amount == null ? 'Reportable' : `Reportable ≥ ${limit.label}`} value={limit.amount == null ? '—' : `${data.reportable.length}`} sub={limit.amount == null ? 'this desk has no reporting line set' : `${data.filed} filed · ${openRpt} open`} tone={limit.amount == null ? CD.mute : openRpt > 0 ? CD.flag : CD.green} />
              <Mini label="Structuring watch" value={`${data.stru.length}`} sub="open patterns" tone={data.stru.length ? CD.amber : CD.green} />
              <Mini label="KYC / ID gaps" value={`${data.kycGaps.length}`} sub="clients to verify" tone={data.kycGaps.length ? CD.flag : CD.green} />
            </div>
          </Card>
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${CD.ink}` }}>
            <div style={{ fontSize: 11, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: CD.faint, marginBottom: 12 }}>Sign-off</div>
            <div style={{ display: 'flex', gap: 30 }}>
              {[['Teller on duty', (tillDay.session && tillDay.session.closedBy && principalOf(tillDay.session.closedBy)) || (me ? me.name : '')], ['Manager / owner', '']].map(([r, nm]) => (<div key={r} style={{ flex: 1 }}>
                <div style={{ height: 34, borderBottom: `1px solid ${CD.ink}`, display: 'flex', alignItems: 'flex-end', paddingBottom: 3, color: CD.mute, fontSize: 12 }}>{nm}</div>
                <div style={{ fontSize: 10.5, color: CD.mute, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}><span>{r}</span><span>Date</span></div>
              </div>))}
            </div>
            <div style={{ fontSize: 10.5, color: CD.faint, marginTop: 12 }}>Prepared by {me ? `${me.name} · ${me.role}` : '—'} · generated {stampNow()} for trading day {sheetDate}. Every figure above is read from the server ledger; nothing on this sheet is computed in the browser. A figure the book cannot source is printed as “—” with the reason beside it, and is never a zero.</div>
          </div>
        </div>);
      }

      if (id === 'pnl') {
        const hstRate = (settings && settings.hstRate != null) ? +settings.hstRate : 13;
        /* THE MONEY ON A P&L IS THE BOOK'S.

           Commission is the fee column the ledger stored. The other half of
           revenue is the REALIZED margin the disposal booked — what the
           stock actually cost against what it sold for — and not a "spread"
           re-derived here by comparing the rate quoted against a live market
           mid. Those two numbers disagree by whatever the market did between
           buying the notes and selling them, which on a currency desk is the
           whole business. See docs/COST_BASIS.md. */
        const fees = book && book.feesHome != null ? Number(book.feesHome) : null;
        const realized = book && book.realizedPnlHome != null ? Number(book.realizedPnlHome) : null;
        const gross = book && book.earningsHome != null ? Number(book.earningsHome) : null;
        const volume = book && book.volumeHome != null ? Number(book.volumeHome) : null;
        const hstOnFees = fees == null ? null : fees * (hstRate / 100);
        const margin = gross != null && volume != null && volume > 0 ? (gross / volume) * 100 : null;
        const taxAuthority = (settings && settings.taxAuthority) || null;
        return (<div>
          <DocHead title="Profit & Loss" subtitle={`${branchName} · ${sub}`} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Gross revenue', value: orDash(gross, homeCcy, noBook), accent: CD.green, sub: 'commission + realized margin' },
            { label: 'Commission (fees)', value: orDash(fees, homeCcy, noBook) },
            { label: 'Realized FX margin', value: orDash(realized, homeCcy, book ? 'nothing sold in this period' : noBook) },
            { label: 'Margin %', value: margin == null ? '—' : `${margin.toFixed(2)}%`, sub: margin == null ? 'no volume to divide by' : 'of pay-in volume' }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle>Profit &amp; loss statement · {homeCcy}</SecTitle></div>
            <table><tbody>
              <tr><td style={{ ...tdS, fontWeight: 600 }}>Commission &amp; service fees</td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(fees, homeCcy, noBook)}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 600 }}>Realized FX margin <span style={{ color: CD.faint }}>— what the stock sold for, less what it cost</span></td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(realized, homeCcy, book ? 'nothing sold' : noBook)}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 700, borderTop: `2px solid ${CD.line}` }}>Gross revenue</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: CD.green, borderTop: `2px solid ${CD.line}` }}>{orDash(gross, homeCcy, noBook)}</td></tr>
              <tr><td style={{ ...tdS, color: CD.mute }}>Sales tax collected on commission ({hstRate}%) <span style={{ color: CD.faint }}>— remitted{taxAuthority ? ` to ${taxAuthority}` : ''}, not income</span></td><td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{orDash(hstOnFees, homeCcy, 'no commission to tax')}</td></tr>
              <tr><td style={{ ...tdS, fontWeight: 700 }}>Net revenue to business</td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: CD.green }}>{orDash(gross, homeCcy, noBook)}</td></tr>
            </tbody></table>
          </Card>
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={((book && book.byActor) || []).length || null}>Revenue by teller — from the ledger</SecTitle></div>
            {!((book && book.byActor) || []).length
              ? <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{book ? 'Nobody posted a deal at this till in this period.' : `The ledger has no answer — ${noBook}.`}</div>
              : <table><thead><tr><th style={thS}>Teller</th><th style={{ ...thS, textAlign: 'right' }}>Deals</th><th style={{ ...thS, textAlign: 'right' }}>Commission</th><th style={{ ...thS, textAlign: 'right' }}>Realized margin</th><th style={{ ...thS, textAlign: 'right' }}>Earned</th></tr></thead>
                <tbody>{book.byActor.map(a => (<tr key={a.actorId}>
                  <td style={tdS}><b>{tellerName(a.actorId, settings)}</b></td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{a.deals}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.feesHome, homeCcy, 'no fee')}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.realizedPnlHome, homeCcy, 'nothing sold')}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: CD.green }}>{orDash(a.earningsHome, homeCcy, 'nothing to attribute')}</td>
                </tr>))}</tbody></table>}
          </Card>
          <div style={{ fontSize: 11, color: CD.faint, lineHeight: 1.6, padding: '2px' }}>Realized margin is the figure the disposal booked against the stock's own cost — not a markup measured against a market mid, which is a different number and one the desk never earned. Sales tax is estimated on commission income at {hstRate}%; confirm your registration and rate. This is a management P&amp;L, not a filed financial statement.</div>
          <Attest />
        </div>);
      }

      if (id === 'summary') {
        const volume = book && book.volumeHome != null ? Number(book.volumeHome) : null;
        const posted = book ? book.posted : null;
        const avg = volume != null && posted ? volume / posted : null;
        const revenue = book && book.earningsHome != null ? Number(book.earningsHome) : null;
        return (<div>
          <DocHead title="Period Summary" subtitle={sub} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Pay-in volume', value: orDash(volume, homeCcy, noBook), sub: book && book.unvaluedDeals ? `${book.unvaluedDeals} cross-currency deal(s) this book cannot value in ${homeCcy}` : null },
            { label: 'Transactions', value: posted == null ? '—' : posted, sub: posted == null ? noBook : (book.reversed ? `${book.reversed} voided` : null) },
            { label: 'Avg. ticket', value: orDash(avg, homeCcy, 'no volume to average') },
            { label: 'Total revenue', value: orDash(revenue, homeCcy, noBook), accent: CD.green, sub: 'commission + realized margin' }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={((book && book.byCurrency) || []).length || null}>Where the margin came from — by currency sold</SecTitle></div>
            {!((book && book.byCurrency) || []).length
              ? <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{book ? 'No foreign currency left this till in the period.' : `The ledger has no answer — ${noBook}.`}</div>
              : <table><thead><tr><th style={thS}>Currency</th><th style={{ ...thS, textAlign: 'right' }}>Deals</th><th style={{ ...thS, textAlign: 'right' }}>Units sold</th><th style={{ ...thS, textAlign: 'right' }}>Realized margin</th></tr></thead>
                <tbody>{book.byCurrency.map(c => (<tr key={c.currency}>
                  <td style={tdS}><b>{c.currency}</b></td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.deals}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(c.sold)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{orDash(c.realizedPnlHome, homeCcy, c.pricedDeals ? 'partly priced' : 'no cost basis recorded')}</td>
                </tr>))}</tbody></table>}
          </Card>
          <Cols>
            <Card><SecTitle>Pay-in volume by currency</SecTitle><Bars data={data.byCcy} fmtV={v => fmt(v, homeCcy)} /></Card>
            <Card><SecTitle>Volume by transaction type</SecTitle><Bars data={data.byType} fmtV={v => fmt(v, homeCcy)} /></Card>
          </Cols>
          <Card pad={0}>
            {/* Units in and units out, not a home valuation — these are
                counts of notes that crossed the counter and they are exact.
                The home-currency headline above is the ledger's; this table
                deliberately does not restate it at a rate. */}
            <div style={{ padding: '14px 16px 4px' }}><SecTitle>Cash drawer movement · in units</SecTitle></div>
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
              <Mini label={limit.amount == null ? 'Reportable' : `Reportable ≥ ${limit.label}`} value={limit.amount == null ? '—' : `${data.reportable.length}`} sub={limit.amount == null ? 'no reporting line set for this desk' : `${data.filed} filed · ${data.reportable.length - data.filed} open`} tone={limit.amount == null ? CD.mute : data.reportable.length - data.filed > 0 ? CD.flag : CD.green} />
              <Mini label="Structuring watch" value={`${data.stru.length}`} sub="clients aggregating" tone={data.stru.length ? CD.amber : CD.green} />
              <Mini label="KYC / ID gaps" value={`${data.kycGaps.length}`} sub="clients to verify" tone={data.kycGaps.length ? CD.flag : CD.green} />
            </div>
          </Card>
        </div>);
      }
      if (id === 'fintrac') {
        /* The pack names this document, because "FINTRAC / LCTR" is a
           Canadian answer and this product is sold in six jurisdictions. A
           desk whose pack has not arrived gets a neutral title rather than
           somebody else's regulator on the letterhead. */
        const packTitle = regime.authority && regime.largeCode
          ? `${regime.authority} / ${regime.largeCode} Compliance Pack`
          : 'Large-Cash Compliance Pack';
        return (<div>
          <DocHead title={packTitle} subtitle={`${regime.largeLabel || 'Large-cash reports'}, structuring watch and KYC exceptions`} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Reportable deals', value: limit.amount == null ? '—' : data.reportable.length, sub: limit.amount == null ? 'no reporting line set for this desk' : `≥ ${limit.label}` },
            { label: `${regime.largeCode || 'Reports'} filed`, value: data.filed, accent: CD.green },
            { label: 'Open / unfiled', value: data.reportable.length - data.filed, accent: data.reportable.length - data.filed ? CD.flag : CD.green },
            { label: 'Structuring watch', value: data.stru.length, accent: data.stru.length ? CD.amber : CD.ink }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={`${data.reportable.length} record(s)`}>Reportable transactions — {limit.code} ≥ {limit.label}</SecTitle></div>
            <table><thead><tr><th style={thS}>Ref</th><th style={thS}>Date</th><th style={thS}>Customer</th><th style={{ ...thS, textAlign: 'right' }}>Amount</th><th style={{ ...thS, textAlign: 'right' }}>{homeCcy} equiv</th><th style={{ ...thS, textAlign: 'center' }}>Status</th></tr></thead>
              <tbody>{data.reportable.map(r => (<tr key={r.id}>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute }}>{r.ref}</td>
                <td style={tdS}>{r.date}</td><td style={tdS}>{r.customer}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(r.inAmt)} {r.inCcy}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(homeEquiv(r.inAmt, r.inCcy, homeCcy), homeCcy, `no ${homeCcy} rate`)}</td>
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
                  <div><div style={{ fontSize: 13, color: CD.ink, fontWeight: 500 }}>{s.customer}</div><div style={{ fontSize: 10.5, color: CD.mute }}>{settings.structuringDays}-day total {orDash(s.agg, homeCcy, 'not valued')}</div></div>
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
          {/* The sentence that claims what the law requires. It used to read
              "Prepared for FINTRAC record-keeping under the PCMLTFA" on every
              desk in every country. The regulator, the form's name and the
              aggregation window belong to the jurisdiction pack, and where
              the pack cannot state one the sentence does not invent it —
              naming the wrong country's regulator on a compliance pack is
              worse than naming none. */}
          <div style={{ fontSize: 11, color: CD.faint, lineHeight: 1.6, padding: '4px 2px' }}>
            {regime.authority
              ? <>Prepared for {regime.authority} record-keeping{regime.country ? ` (${regime.country})` : ''}.{' '}</>
              : <>Prepared for record-keeping. This desk's regulator is not stated on its jurisdiction pack, so none is named here.{' '}</>}
            {limit.amount == null
              ? <>No reporting line has been established for this desk, so no deal on this pack is flagged as reportable. Set one in Settings, or install the jurisdiction pack for the country you operate in.</>
              : <>{regime.largeLabel || 'Large-cash reports'} are required for single cash amounts of {limit.label} or more{regime.aggHours ? `, with ${regime.aggHours}-hour aggregation` : ''} — this desk's own line, from its jurisdiction pack.</>}
            {' '}This pack is a working summary; verify each filing in the official portal.
          </div>
          <Attest />
        </div>);
      }
      if (id === 'revenue') {
        /* This document exists to answer "who earned what", and it used to
           answer it from the browser's copy of the day's deals, with the
           margin re-estimated against a live market mid. Both halves are
           now the book's: GET /api/ledger/summary's byActor block, grouped
           by the principal the ledger recorded against each posting. */
        const fees = book && book.feesHome != null ? Number(book.feesHome) : null;
        const realized = book && book.realizedPnlHome != null ? Number(book.realizedPnlHome) : null;
        const total = book && book.earningsHome != null ? Number(book.earningsHome) : null;
        const volume = book && book.volumeHome != null ? Number(book.volumeHome) : null;
        const margin = total != null && volume != null && volume > 0 ? (total / volume) * 100 : null;
        const earners = (book && book.byActor) || [];
        return (<div>
          <DocHead title="Revenue & Earnings" subtitle={`Commission plus the margin each disposal actually booked · ${homeCcy}`} rangeLabel={effRangeLabel} />
          <KpiRow items={[
            { label: 'Fees collected', value: orDash(fees, homeCcy, noBook), accent: CD.green },
            { label: 'Realized FX margin', value: orDash(realized, homeCcy, book ? 'nothing sold in this period' : noBook), accent: CD.green, sub: 'against the stock’s own cost' },
            { label: 'Total revenue', value: orDash(total, homeCcy, noBook), accent: CD.green },
            { label: 'Margin %', value: margin == null ? '—' : `${margin.toFixed(2)}%`, sub: margin == null ? 'no volume to divide by' : 'of pay-in volume' }
          ]} />
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={earners.length || null}>Earnings by teller</SecTitle></div>
            {!earners.length
              ? <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{book ? 'Nobody posted a deal at this till in this period. No earnings are attributed rather than a table of zeros.' : `The ledger has no answer — ${noBook}.`}</div>
              : <table><thead><tr><th style={thS}>Teller</th><th style={{ ...thS, textAlign: 'right' }}>Deals</th><th style={{ ...thS, textAlign: 'right' }}>Volume</th><th style={{ ...thS, textAlign: 'right' }}>Commission</th><th style={{ ...thS, textAlign: 'right' }}>Realized margin</th><th style={{ ...thS, textAlign: 'right' }}>Earned</th></tr></thead>
                <tbody>{earners.map(a => (<tr key={a.actorId}>
                  <td style={{ ...tdS, fontWeight: 500 }}>{tellerName(a.actorId, settings)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{a.deals}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.volumeHome, homeCcy, `no ${homeCcy} leg`)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(a.feesHome, homeCcy, 'no fee')}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{orDash(a.realizedPnlHome, homeCcy, 'nothing sold')}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: CD.green }}>{orDash(a.earningsHome, homeCcy, 'nothing to attribute')}</td>
                </tr>))}</tbody></table>}
          </Card>
          <Card pad={0}>
            <div style={{ padding: '14px 16px 4px' }}><SecTitle n={((book && book.byCurrency) || []).length || null}>Earnings by currency sold</SecTitle></div>
            {!((book && book.byCurrency) || []).length
              ? <div style={{ padding: '10px 16px 14px', fontSize: 11.5, color: CD.faint }}>{book ? 'No foreign currency left this till in the period.' : `The ledger has no answer — ${noBook}.`}</div>
              : <table><thead><tr><th style={thS}>Currency</th><th style={{ ...thS, textAlign: 'right' }}>Deals</th><th style={{ ...thS, textAlign: 'right' }}>Units sold</th><th style={{ ...thS, textAlign: 'right' }}>Realized margin</th></tr></thead>
                <tbody>{book.byCurrency.map(c => (<tr key={c.currency}>
                  <td style={tdS}><b>{c.currency}</b></td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.deals}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(c.sold)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: CD.green }}>{orDash(c.realizedPnlHome, homeCcy, c.pricedDeals ? 'partly priced' : 'no cost basis recorded')}</td>
                </tr>))}</tbody></table>}
          </Card>
          <div style={{ fontSize: 11, color: CD.faint, lineHeight: 1.6, padding: '2px' }}>
            {book && book.pricedDeals < book.posted
              ? <>{book.posted - book.pricedDeals} of {book.posted} deal(s) in this period carry no cost basis, so no margin is reported for them — see docs/COST_BASIS.md. A deal the book never priced has no margin, which is not the same as a margin of nothing.</>
              : <>Realized margin is the figure each disposal booked against the stock's own cost, under the desk's costing method. It is not a markup measured against a market mid.</>}
          </div>
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
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.fee, homeCcy)}</td>
                <td style={{ ...tdS, color: CD.mute }}>{tellerName(r.teller, settings)}</td>
                <td style={{ ...tdS, textAlign: 'center', fontFamily: 'Space Mono, monospace', fontSize: 10 }}>
                  {isVoid ? <span style={{ color: CD.mute }}>VOID</span> : <span>{[f.single ? 'RPT' : '', f.str ? 'STR' : '', (f.kyc && f.kyc !== 'ok') ? 'ID' : ''].filter(Boolean).join(' ') || '—'}</span>}
                </td>
              </tr>); })}
              {data.inP.length === 0 && <tr><td style={tdS} colSpan={9}>No records in this period.</td></tr>}
              </tbody></table>
          </Card>
          <div style={{ fontSize: 11, color: CD.faint, padding: '2px' }}>{limit.amount == null ? 'RPT = reportable — no reporting line is set for this desk, so nothing is flagged' : <>RPT = reportable ≥ {limit.label}</>} · STR = structuring watch · ID = KYC exception. Fees are shown in {homeCcy}. Voided records are retained, struck through, and never deleted.</div>
        </div>);
      }
      if (id === 'kyc') {
        const names = Array.from(new Set([...Object.keys(clients), ...data.live.map(r => r.customer)])).sort();
        const stat = (n) => { const c = clients[n] || {}; if (!c.idType || !c.idNum) return ['missing ID', CD.flag, CD.flagSoft]; if (c.idExpiry && c.idExpiry < businessDate()) return ['ID expired', CD.flag, CD.flagSoft]; return ['verified', CD.green, CD.greenSoft]; };
        return (<div>
          <DocHead title="Client & KYC Register" subtitle={`${names.length} client file(s) · activity within ${rangeLabel.toLowerCase()}`} rangeLabel={effRangeLabel} />
          <Card pad={0}>
            <table><thead><tr><th style={thS}>Client</th><th style={thS}>ID type</th><th style={thS}>ID number</th><th style={thS}>Expiry</th><th style={{ ...thS, textAlign: 'center' }}>Status</th><th style={{ ...thS, textAlign: 'right' }}>Tx</th><th style={{ ...thS, textAlign: 'right' }}>Volume</th></tr></thead>
              <tbody>{names.map(n => { const c = clients[n] || {}; const [st, col, bg] = stat(n); const tx = data.live.filter(r => r.customer === n);
                /* A client's volume in the desk's own money, or nothing. One
                   leg this board cannot price makes the whole total unknown
                   — a sum quietly missing a currency is worse than a dash,
                   because it looks complete. */
                const parts = tx.map(r => homeEquiv(r.inAmt, r.inCcy, homeCcy));
                const v = !parts.length || parts.some(p => p == null) ? null : parts.reduce((s, p) => s + p, 0);
                return (<tr key={n}>
                <td style={{ ...tdS, fontWeight: 500 }}>{n}</td>
                <td style={{ ...tdS, color: CD.mute }}>{c.idType || '—'}</td>
                <td style={{ ...tdS, fontFamily: 'Space Mono, monospace', fontSize: 11, color: CD.mute }}>{c.idNum || '—'}</td>
                <td style={{ ...tdS, color: c.idExpiry && c.idExpiry < businessDate() ? CD.flag : CD.mute }}>{c.idExpiry || '—'}</td>
                <td style={{ ...tdS, textAlign: 'center' }}><span style={{ fontSize: 10, fontWeight: 700, color: col, background: bg, padding: '2px 7px', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{st.toUpperCase()}</span></td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{tx.length}</td>
                <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{orDash(v, homeCcy, tx.length ? `no ${homeCcy} rate` : 'nothing in this period')}</td>
              </tr>); })}</tbody></table>
          </Card>
          <div style={{ fontSize: 11, color: CD.faint, padding: '2px' }}>Volumes are shown in {homeCcy}, this desk's own currency as its jurisdiction pack states it. A client whose deals include a currency this branch has never published a rate for has no total to show, and says so.</div>
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
                <input type="date" value={scope.from} max={businessDate()} onChange={e => setScope(s => ({ ...s, from: e.target.value }))} style={selSty} />
                <input type="date" value={scope.to} max={businessDate()} onChange={e => setScope(s => ({ ...s, to: e.target.value }))} style={selSty} />
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
                <td style={{ ...tdS, fontWeight: 500 }}><span className="inline-flex items-center gap-2"><span className="grid place-items-center" style={{ width: 24, height: 24, borderRadius: 6, background: rep.tone }}><Ic n={rep.icon} s={13} c="var(--cd-on-ink)" /></span>{titleOf(rep)}</span></td>
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
                <div style={{ fontSize: 15.5, fontWeight: 700, color: CD.ink }}>{titleOf(r)}</div>
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
          <span className="text-sm font-semibold ml-1" style={{ color: CD.ink }}>{titleOf(meta)}</span>
        </div>
        <div className="flex items-center gap-2">
          {active !== 'endofday' && FilterControl}
          {RangePicker}
          <button onClick={() => downloadCsv(`${active}-${range}.csv`, csvFor(active))} className="flex items-center gap-1.5 px-3 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="download" s={15} /> CSV</button>
          <button onClick={() => printReport(titleOf(meta))} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="printer" s={15} /> Print / PDF</button>
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
    const metaFor = (type) => { const r = REPORTS.find(x => x.id === type); return r ? { label: titleOf(r), icon: r.icon, tone: r.tone } : { label: type, icon: 'lock', tone: CD.flag }; };
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
     THE DEMO HISTORY IS GONE, AND THIS IS ITS HEADSTONE

     `seedFakeHistory()` stood here and ran on module load. It wrote nine
     entries into the report history, and four of them were SEALED
     COMPLIANCE FILINGS: a Large Cash Transaction Report for "Brooke
     Lawson" with acknowledgement number FIN-4471, an EFTR for "Jakob
     Miller" with FIN-6093, each rendered as a full print-ready document
     headed "YORK CURRENCY EXCHANGE · MSB", stamped ● SEALED, and footed
     "Immutable record retained under the PCMLTFA."

     No such report was ever filed. No such acknowledgement was ever
     issued. They were props, and they sat in the same list, with the same
     print button, as the ones a desk actually files — on the screen an
     examiner is shown.

     A fabricated business figure is a bug. A fabricated regulatory filing
     with an invented receipt number is a different category of thing, and
     it does not belong in a shipped product at any stage of its life. The
     tab now opens empty for a desk that has generated nothing, and says
     so, which is the truth about that desk.

     If a populated history is ever wanted for a sales demo, it belongs
     behind an explicit demo-tenant flag on the server, generated from
     that tenant's own ledger — never compiled into the browser where the
     only thing separating it from a real record is a key in
     localStorage. See docs/GENERATED_DOCUMENTS.md.
     ============================================================ */

  window.CDOS = Object.assign(window.CDOS || {}, { Reports, ReportHistory });
})();
