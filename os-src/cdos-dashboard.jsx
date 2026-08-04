/* ============================================================
   CurrencyDesk OS — Dashboard (owner command center)
   Design language: banknote security engraving. Guilloché rosettes,
   intaglio hairlines, treasury inks (slate / green / oxblood / bronze)
   on cream, serial-number typography — the feel of currency itself,
   held to Apple-grade restraint. All data is live off the ledger
   and the rate engine.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, crossRate, Absent, businessDate, businessDayWindow, dDiff, useDeskFacts } = window.CDOS;
  const computeFlags = window.CDOS.computeFlags;
  const RANGES = [['7d', 'Week', 7], ['30d', 'Month', 30], ['90d', '3M', 90], ['180d', '6M', 180], ['365d', 'Year', 365], ['all', 'All', null]];
  const HEAD = { '7d': 'Past 7 days', '30d': 'Past 30 days', '90d': 'Past 90 days', '180d': 'Past 6 months', '365d': 'Past year', 'all': 'All-time' };

  /* treasury-ink accents (used sparingly over the OS black/cream base).
     Themed like CD: values are CSS vars; light = engraving on cream,
     dark = the same plate printed on midnight stock, inks lifted to keep
     the intaglio contrast. */
  const T_THEMES = {
    light: {
      cream: '#f3eee2', panel: '#faf6ec', vignette: '#f6f1e4',
      slate: '#33425f', green: '#2f6b54', oxblood: '#9c3b46', bronze: '#9a7536', steel: '#5a6a86',
      line: 'rgba(40,52,80,0.20)', hair: 'rgba(40,52,80,0.12)', wash: 'rgba(40,52,80,0.05)',
    },
    dark: {
      cream: '#191a17', panel: '#1e1f1b', vignette: '#232420',
      slate: '#aab6d2', green: '#7cc2a2', oxblood: '#dd8f97', bronze: '#cfa96a', steel: '#93a0ba',
      line: 'rgba(186,200,232,0.24)', hair: 'rgba(186,200,232,0.13)', wash: 'rgba(186,200,232,0.06)',
    }
  };
  (function injectDashVars() {
    if (document.getElementById('cdos-dash-vars')) return;
    const decl = (o) => Object.keys(o).map(k => '--dt-' + k + ':' + o[k] + ';').join('');
    const el = document.createElement('style'); el.id = 'cdos-dash-vars';
    el.textContent = ':root{' + decl(T_THEMES.light) + '}html[data-cdtheme="dark"]{' + decl(T_THEMES.dark) + '}';
    document.head.appendChild(el);
  })();
  const T = {}; Object.keys(T_THEMES.light).forEach(k => { T[k] = 'var(--dt-' + k + ')'; });
  const money0 = (v) => (v < 0 ? '−' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-CA');
  const cadOf = (a, ccy) => ccy === 'CAD' ? (+a || 0) : (+a || 0) / (crossRate('CAD', ccy) || 1);
  const flagEmoji = (code) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(c => c.code === code) || {}).flag : '') || ''; } catch (e) { return ''; } };
  const initials = (n) => (n || '?').split(/[\s.]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();

  /* ---------------- guilloché rosette (hypotrochoid weave) ---------------- */
  function hypo(R, r, d, turns, steps) {
    const k = (R - r) / r; let p = '';
    const N = steps * turns;
    for (let i = 0; i <= N; i++) { const t = (i / steps) * 2 * Math.PI; const x = (R - r) * Math.cos(t) + d * Math.cos(k * t); const y = (R - r) * Math.sin(t) - d * Math.sin(k * t); p += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1); }
    return p;
  }
  function Rosette({ size = 132, stroke = T.slate, opacity = 1, style }) {
    // a few layered hypotrochoids → the woven banknote rosette
    const layers = useMemo(() => ([
      { d: hypo(48, 7, 32, 7, 240), w: 0.5, o: 0.9 },
      { d: hypo(44, 5, 26, 5, 240), w: 0.5, o: 0.8 },
      { d: hypo(38, 9, 30, 9, 240), w: 0.45, o: 0.7 },
      { d: hypo(28, 4, 18, 4, 220), w: 0.45, o: 0.85 },
    ]), []);
    return (<svg width={size} height={size} viewBox="-52 -52 104 104" style={style} aria-hidden="true">
      <g stroke={stroke} fill="none" opacity={opacity} strokeLinejoin="round">
        <circle r="50" strokeWidth="0.6" opacity="0.5" />
        <circle r="46" strokeWidth="0.4" opacity="0.35" />
        {layers.map((l, i) => <path key={i} d={l.d} strokeWidth={l.w} opacity={l.o} />)}
        <circle r="9" strokeWidth="0.5" opacity="0.6" />
      </g>
    </svg>);
  }
  function WaveRule({ color = T.line, h = 10, amp = 3, period = 22 }) {
    const w = 1200; let d = `M0,${h / 2}`;
    for (let x = 0; x <= w; x += 2) d += ` L${x},${(h / 2 + amp * Math.sin((x / period) * 2 * Math.PI)).toFixed(2)}`;
    return (<svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden="true"><path d={d} fill="none" stroke={color} strokeWidth="1" /><path d={d.replace(/M0,/, `M0,`)} transform={`translate(0,${amp}) `} fill="none" stroke={color} strokeWidth="1" opacity="0.5" /></svg>);
  }

  /* ---------------- engraved charts ---------------- */
  function AreaChart({ data, w = 420, h = 92, stroke = T.slate }) {
    if (!data || data.length < 2) return <div style={{ height: h, display: 'grid', placeItems: 'center', color: T.steel, fontSize: 11, fontFamily: 'Space Mono, monospace' }}>Awaiting history</div>;
    const max = Math.max(...data, 1), min = Math.min(...data, 0), rng = max - min || 1;
    const X = (i) => (i / (data.length - 1)) * w;
    const Y = (v) => h - ((v - min) / rng) * (h - 10) - 5;
    const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    return (<svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs><linearGradient id="dEng" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={stroke} stopOpacity="0.16" /><stop offset="100%" stopColor={stroke} stopOpacity="0" /></linearGradient></defs>
      {/* engraved guide hairlines */}
      {[0.25, 0.5, 0.75].map(g => <line key={g} x1="0" x2={w} y1={h * g} y2={h * g} stroke={T.hair} strokeWidth="0.6" />)}
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="url(#dEng)" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((v, i) => i === data.length - 1 && <circle key={i} cx={X(i)} cy={Y(v)} r="2.6" fill={T.bronze} />)}
    </svg>);
  }
  function Donut({ a, b }) {
    const size = 128, total = a + b || 1, r = size / 2 - 11, c = 2 * Math.PI * r, aFrac = a / total, cx = size / 2, cy = size / 2;
    return (<div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.wash} strokeWidth="12" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={CD.ink} strokeWidth="12" strokeDasharray={`${c * aFrac} ${c}`} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.bronze} strokeWidth="12" strokeDasharray={`${c * (1 - aFrac)} ${c}`} strokeDashoffset={-c * aFrac} />
        <circle cx={cx} cy={cy} r={r + 8} fill="none" stroke={T.hair} strokeWidth="0.6" />
        <circle cx={cx} cy={cy} r={r - 8} fill="none" stroke={T.hair} strokeWidth="0.6" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div><div style={{ fontSize: 8.5, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Earned</div><div style={{ fontSize: 17, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(total)}</div></div>
      </div>
    </div>);
  }
  function VBars({ series, h = 100 }) {
    const max = Math.max(...series.map(s => s.v), 1);
    return (<div className="flex items-end gap-2" style={{ height: h }}>
      {series.map((s, i) => { const last = i === series.length - 1; return (
        <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5" style={{ minWidth: 0 }} title={`${s.label}: ${money0(s.v)}`}>
          <div style={{ width: '100%', maxWidth: 26, height: Math.max(3, (s.v / max) * (h - 24)), background: last ? T.bronze : T.slate, opacity: last ? 1 : 0.78, boxShadow: `inset 0 0 0 0.5px ${T.line}` }}></div>
          <div style={{ fontSize: 8.5, color: last ? CD.ink : T.steel, fontFamily: 'Space Mono, monospace', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{s.label}</div>
        </div>); })}
    </div>);
  }

  /* ---------------- intaglio card shell ---------------- */
  function Engrave({ children }) { return <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontFamily: 'Space Mono, monospace', color: T.slate, fontWeight: 700 }}>{children}</span>; }
  function Card({ title, action, children, span }) {
    return (<div style={{ gridColumn: span ? `span ${span}` : 'auto', background: CD.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 0, position: 'relative', display: 'flex', flexDirection: 'column', boxShadow: '0 1px 0 rgba(40,52,80,0.04)' }}>
      <div style={{ position: 'absolute', inset: 4, border: `1px solid ${T.hair}`, borderRadius: 8, pointerEvents: 'none' }}></div>
      <div className="flex items-center justify-between" style={{ padding: '12px 16px 9px', position: 'relative' }}>
        <div className="flex items-center gap-2"><span style={{ width: 5, height: 5, transform: 'rotate(45deg)', background: T.bronze, display: 'inline-block' }}></span><Engrave>{title}</Engrave></div>
        {action}
      </div>
      <div style={{ height: 1, background: `repeating-linear-gradient(90deg, ${T.line} 0 4px, transparent 4px 7px)` }}></div>
      <div style={{ padding: '13px 16px 16px', position: 'relative', flex: 1 }}>{children}</div>
    </div>);
  }
  function Delta({ cur, prev, light }) {
    if (prev == null || prev === 0) return <span style={{ fontSize: 11, color: light ? 'var(--cd-on-ink-soft)' : T.steel, fontFamily: 'Space Mono, monospace' }}>—</span>;
    const pct = ((cur - prev) / Math.abs(prev)) * 100, up = pct >= 0;
    return (<span className="inline-flex items-center gap-1" style={{ fontSize: 12, fontWeight: 700, color: up ? T.green : T.oxblood, fontFamily: 'Space Mono, monospace' }}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%</span>);
  }

  /* ============================================================
     THE OFFICE OF THE DESK

     Every headline on this screen used to be computed here, in the
     browser, from a demo seed. It announced Earnings $1,150, Volume
     $130,566, Deals 38 and Margin 0.88% for a desk that had posted one
     $1,000 trade and voided it, over a serial number reading № 20260618
     — a date seven weeks in the past.

     The FX exposure panel was worse than wrong, it was dangerous. It
     computed a position as the NET OF THE PERIOD'S DEALS: pay-ins minus
     pay-outs. That is a flow, not a holding, and it reported the desk
     SHORT €10,302 and SHORT ₱13,900 when the ledger had it LONG €12,000
     and holding no pesos at all. An owner hedging off that panel would
     sell euros they do not have short and buy pesos they never held.

     Both now come from the ledger — GET /api/ledger/summary for what was
     earned over a window, GET /api/ledger/position for what is actually
     in the boxes. Where the book has no answer the tile says so; see
     docs/ABSENT_FIGURES.md.
     ============================================================ */
  function Dashboard({ rows, clients, settings, me, onOpenLedger, onOpenClient, openFiltered, onOpenApp, serverBacked, cashVersion }) {
    const [posMode, setPosMode] = useState('value');
    const [range, setRange] = useState('30d');
    // the trading day and the jurisdiction pack, from the server
    const deskFacts = useDeskFacts();
    /* The window this screen is asking the book about. Its length comes
       from the range picker; where it STARTS comes from the till session's
       business date, because that is the day the desk considers itself to
       be trading in. */
    const winDays = (RANGES.find(r => r[0] === range) || RANGES[1])[2];
    const [book, setBook] = useState({ loading: true, summary: null, prior: null, position: null, error: '' });
    useEffect(() => {
      const backend = window.CDOS.Backend;
      if (!backend) { setBook({ loading: false, summary: null, prior: null, position: null, error: 'This desk is not signed in to the ledger.' }); return; }
      let live = true;
      setBook(b => ({ ...b, loading: true }));
      window.CDOS.refreshBusinessDate().then(() => {
        /* Two windows, so "up 12% on the period before" is a comparison of
           two real periods rather than of one real one against a guess.
           An all-time range has no period before it and asks for none. */
        const current = winDays == null ? {} : window.CDOS.businessDayWindow(winDays);
        const prior = winDays == null ? null : { from: window.CDOS.businessDayWindow(winDays * 2).from, to: current.from };
        return Promise.all([
          backend.loadLedgerSummary(current),
          prior ? backend.loadLedgerSummary(prior) : Promise.resolve(null),
          backend.loadLedgerPosition(),
        ]);
      })
        .then(([summary, prior, position]) => { if (live) setBook({ loading: false, summary, prior, position, error: '' }); })
        .catch(error => { if (live) setBook({ loading: false, summary: null, prior: null, position: null, error: (error && error.message) || 'The ledger could not be reached.' }); });
      return () => { live = false; };
    }, [range, serverBacked, cashVersion, deskFacts]);

    const summary = book.summary;
    const home = (summary && summary.homeCurrency) || (book.position && book.position.homeCurrency) || 'CAD';
    /* What the desk EARNED: commission plus the realized margin the
       disposal itself booked. Not a spread against a market mid — see
       docs/COST_BASIS.md. Null means the ledger has nothing to total,
       which is a different statement from "earned nothing". */
    const periodEarn = summary ? summary.earningsHome : null;
    const priorEarn = book.prior ? book.prior.earningsHome : null;
    const totVol = summary ? summary.volumeHome : null;
    const totFees = summary ? summary.feesHome : null;
    const totRealized = summary ? summary.realizedPnlHome : null;
    const dealCount = summary ? summary.posted : null;
    const marginPct = (periodEarn != null && totVol != null && Number(totVol) > 0)
      ? (Number(periodEarn) / Number(totVol)) * 100 : null;

    /* WHAT THE DESK IS HOLDING — till and vault, as the ledger states it.
       Long means the cash is in the box; there is no "short" here, because
       a desk cannot hold negative banknotes. A currency the desk has run
       out of simply is not in the list, and the panel says which
       currencies are on the book rather than implying a hedge. */
    const held = useMemo(() => {
      const p = book.position;
      if (!p) return null;
      return (p.currencies || [])
        .map(c => ({
          ccy: c.currency,
          units: Number(c.quantity),
          home: c.marketValueHome == null ? null : Number(c.marketValueHome),
          unrealized: c.unrealizedPnlHome == null ? null : Number(c.unrealizedPnlHome),
        }))
        .filter(c => c.units > 0)
        .sort((a, b) => (b.home || 0) - (a.home || 0));
    }, [book.position]);
    const fxRows = (held || []).filter(p => p.ccy !== home);
    const fxValued = fxRows.every(p => p.home != null);
    /* Gross foreign exposure: the home value of every foreign note in the
       building. There is no net-versus-gross distinction on physical cash
       — you are long all of it — so the panel reports one figure and what
       a one-percent move does to it. */
    const fxTotal = fxValued ? fxRows.reduce((s, p) => s + p.home, 0) : null;
    const sensitivity = fxTotal == null ? null : Math.abs(fxTotal) * 0.01;
    const maxPos = Math.max(1, ...((held || []).map(p => Math.abs(p.home || 0))));

    const D = useMemo(() => {
      /* These read the transaction rows the ledger sent, which is what
         `rows` now is — the demo seed is gone. Grouping records the server
         supplied is presentation, not a second book; no cash figure is
         derived here. Earnings per client and per teller use the deal's
         own booked spread rather than a re-estimate. */
      const earnOf = (r) => (+r.fee || 0) + (r.spreadCad != null && !isNaN(r.spreadCad) ? Math.max(0, +r.spreadCad) : 0);
      const inWindow = (d) => winDays == null ? true : (dDiff(d, businessDate()) >= -0.5 && dDiff(d, businessDate()) <= winDays + 0.5);
      const live = rows.filter(r => r.status !== 'void' && inWindow(r.date));

      const cl = {};
      live.forEach(r => { const k = r.customer || '—'; const c = cl[k] || (cl[k] = { name: k, vol: 0, earn: 0, n: 0 }); c.vol += cadOf(r.inAmt, r.inCcy); c.earn += earnOf(r); c.n++; });
      const topClients = Object.values(cl).sort((a, b) => b.vol - a.vol).slice(0, 5);
      const tl = {}; live.forEach(r => { tl[r.teller || '—'] = (tl[r.teller || '—'] || 0) + earnOf(r); });
      const tellers = Object.entries(tl).sort((a, b) => b[1] - a[1]);
      const corrM = {}; live.forEach(r => { const k = r.inCcy + ' → ' + r.outCcy; const c = corrM[k] || (corrM[k] = { route: k, vol: 0, n: 0 }); c.vol += cadOf(r.inAmt, r.inCcy); c.n++; });
      const corridors = Object.values(corrM).sort((a, b) => b.vol - a.vol).slice(0, 5);

      const flags = computeFlags(rows, clients, settings);
      let rptOpen = 0, rptFiled = 0; const strSet = new Set(), kycSet = new Set();
      live.forEach(r => { const f = flags[r.id] || {}; if (f.single) { r.filed ? rptFiled++ : rptOpen++; } if (f.str && !r.ackStr) strSet.add(r.customer); if (f.kyc && f.kyc !== 'ok') kycSet.add(r.customer); });
      const recent = [...live].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 6);
      const movers = (typeof CUR !== 'undefined' ? CUR : []).filter(c => c.code !== 'CAD').map(c => ({ code: c.code, flag: c.flag, chg: +c.chg || 0 })).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 6);

      const bmode = (winDays == null || winDays > 180) ? 'month' : winDays > 31 ? 'week' : 'day';
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const keyOf = (date) => { if (bmode === 'day') return date; if (bmode === 'month') return date.slice(0, 7); const dt = new Date(date); const off = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - off); return dt.toISOString().slice(0, 10); };
      const labelOf = (k) => { if (bmode === 'day') return k.slice(5); if (bmode === 'month') return MON[(+k.slice(5, 7)) - 1] + ' ' + k.slice(2, 4); return k.slice(5); };
      const bk = {}; live.forEach(r => { const k = keyOf(r.date); bk[k] = (bk[k] || 0) + earnOf(r); });
      const series = Object.keys(bk).sort().slice(-12).map(k => ({ key: k, label: labelOf(k), earn: bk[k] }));

      return { topClients, tellers, corridors, rptOpen, rptFiled, str: strSet.size, kyc: kycSet.size, recent, movers, series, bmode };
    }, [rows, clients, settings, range, deskFacts]);

    // ---- cross-module consolidation: Transfers, Cheques, Vault, screening ----
    const X = useMemo(() => {
      const J = (k, d) => { try { const r = JSON.parse(localStorage.getItem(k) || 'null'); return r == null ? d : r; } catch (e) { return d; } };
      const P = window.CDOS, comp = P._compliance;
      const transfers = J('cdos_transfers_v1', []), cheques = J('cdos_cheques_v1', []), beneficiaries = J('cdos_beneficiaries_v1', []);
      const tInProg = transfers.filter(t => t.status !== 'paid' && t.status !== 'cancelled').length;
      const tHold = transfers.filter(t => t.status === 'hold').length;
      const tVol = transfers.filter(t => t.status !== 'cancelled').reduce((s, t) => s + (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')), 0);
      const chRisk = cheques.filter(c => c.status === 'held').reduce((s, c) => s + (+c.netCad || 0), 0);
      const chOverdue = cheques.filter(c => c.status === 'held' && c.holdUntil < businessDate()).length;
      const chLoss = cheques.filter(c => c.status === 'returned').reduce((s, c) => s + (+c.netCad || 0), 0);
      /* The vault tile reads the SAFE's own figures out of the same
         position response the exposure panel uses, so the Dashboard and
         the Vault app cannot report two different strong rooms. */
      const vaultTotals = (book.position && book.position.vaultTotals) || null;
      const vaultTracked = !!(book.position && book.position.vaultTracked);
      const regime = P.getRegime ? P.getRegime(settings) : { aggHours: 24 };
      /* The reporting line: the desk's own, in the desk's own currency,
         from the jurisdiction pack the server states — never the hardcoded
         10,000 Canadian dollars this file used to inherit. */
      const limit = P.reportingLimit(settings);
      let sanc = 0;
      if (comp) { Object.keys(clients || {}).forEach(n => { if (comp.screen(n).status !== 'clear') sanc++; }); beneficiaries.forEach(b => { if (comp.screen(b.name).status !== 'clear') sanc++; }); }
      const agg = comp ? comp.aggClusters(rows, Object.assign({}, regime, limit.amount != null ? { threshold: limit.amount } : null)).length : 0;
      const eftr = limit.amount == null ? null : transfers.filter(t => t.status !== 'cancelled' && (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')) >= limit.amount).length;
      return { tInProg, tHold, tVol, chRisk, chOverdue, chLoss, vaultTotals, vaultTracked, sanc, agg, eftr, regime, limit };
    }, [rows, clients, settings, range, book.position, deskFacts]);

    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const firstName = (me && me.name ? me.name.split(/[ .]/).filter(Boolean).pop() : '') || 'there';
    const maxTeller = Math.max(1, ...D.tellers.map(t => t[1]));
    const maxCorr = Math.max(1, ...D.corridors.map(c => c.vol));
    const headLabel = HEAD[range] || 'Period';
    const bucketWord = D.bmode === 'day' ? 'days' : D.bmode === 'week' ? 'weeks' : 'months';
    /* The serial is the trading day this desk is actually in, not the last
       date a demo record happened to carry. */
    const serial = businessDate().replace(/-/g, '') + ' · ' + (settings && settings.deskName ? settings.deskName.replace(/[^0-9]/g, '') || '01' : '01');
    const deskName = (settings && (settings.operatingName || settings.bizName)) || 'This desk';
    /* One line, used by every tile that has to explain a dash. */
    const noBook = book.error || (book.loading ? 'reading the book…' : 'nothing posted in this period');

    return (<div style={{ height: '100%', overflow: 'auto', background: CD.paper }}>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 13 }}>

        {/* ===== BANKNOTE MASTHEAD ===== */}
        <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 14, border: `1px solid ${CD.ink}`, background: `linear-gradient(180deg, ${T.panel}, ${T.cream})` }}>
          <div style={{ position: 'absolute', inset: 5, border: `1px solid ${T.line}`, borderRadius: 9, pointerEvents: 'none' }}></div>
          <div style={{ position: 'absolute', inset: 8, border: `1px solid ${T.hair}`, borderRadius: 7, pointerEvents: 'none' }}></div>
          <Rosette size={300} stroke={T.slate} opacity={0.06} style={{ position: 'absolute', right: -40, top: -70, pointerEvents: 'none' }} />
          <div style={{ position: 'relative', padding: '16px 22px 14px' }}>
            {/* eyebrow / serial line */}
            <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
              <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: T.slate, fontWeight: 700 }}>CurrencyDesk · Office of the Desk</span>
              <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 10, letterSpacing: '0.14em', color: T.steel }}>№ {serial}</span>
            </div>
            <div className="flex justify-between" style={{ gap: 24, flexWrap: 'wrap' }}>
              {/* left — denomination */}
              <div style={{ minWidth: 250 }}>
                <div style={{ fontSize: 11, color: T.steel, fontFamily: 'Space Mono, monospace', letterSpacing: '0.04em' }}>{greet}, {firstName}</div>
                <div style={{ fontSize: 10, color: T.slate, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.16em', marginTop: 12 }}>{headLabel} · earnings</div>
                <div className="flex items-baseline gap-3" style={{ marginTop: 2 }}>
                  {/* The number an owner reads first. It is the ledger's or
                      it is a dash — never a demo figure, and never a
                      confident $0 for a period the book has not answered. */}
                  {periodEarn == null
                    ? <Absent why={noBook} size={40} />
                    : <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(Number(periodEarn))}</span>}
                  {periodEarn != null && <Delta cur={Number(periodEarn)} prev={priorEarn == null ? null : Number(priorEarn)} />}
                </div>
                <div style={{ height: 1, background: `repeating-linear-gradient(90deg, ${T.slate} 0 5px, transparent 5px 9px)`, opacity: 0.5, margin: '12px 0', maxWidth: 300 }}></div>
                <div className="flex" style={{ gap: 0 }}>
                  {[
                    ['Volume', totVol == null ? null : money0(Number(totVol))],
                    ['Deals', dealCount == null ? null : String(dealCount)],
                    ['Margin', marginPct == null ? null : marginPct.toFixed(2) + '%'],
                  ].map(([l, v], i) => (
                    <div key={l} style={{ paddingRight: 18, marginRight: 18, borderRight: i < 2 ? `1px solid ${T.hair}` : 'none' }}>
                      <div style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.12em', color: T.steel, fontFamily: 'Space Mono, monospace' }}>{l}</div>
                      {v == null
                        ? <div style={{ marginTop: 2 }}><Absent why="" size={17} /></div>
                        : <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div>}
                    </div>
                  ))}
                </div>
              </div>
              {/* right — vignette window with seal + engraved curve */}
              <div style={{ flex: 1, minWidth: 250, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div style={{ position: 'relative', border: `1px solid ${T.line}`, borderRadius: 8, background: T.vignette, overflow: 'hidden', padding: '8px 12px 6px' }}>
                  <div style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}><Rosette size={108} stroke={T.green} opacity={0.55} /></div>
                  <div className="flex items-center justify-between" style={{ position: 'relative' }}>
                    <span style={{ fontSize: 9, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.14em', color: T.slate, fontWeight: 700 }}>Earnings · {D.series.length} {bucketWord}</span>
                    <span style={{ fontSize: 10, fontFamily: 'Space Mono, monospace', color: T.bronze }}>{periodEarn == null ? '—' : money0(Number(periodEarn)) + ' total'}</span>
                  </div>
                  <div style={{ position: 'relative', marginTop: 4 }}><AreaChart data={D.series.map(s => s.earn)} h={78} /></div>
                </div>
                <div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textAlign: 'right', marginTop: 5, letterSpacing: '0.08em' }}>{deskName.toUpperCase()} · REGISTERED MSB</div>
              </div>
            </div>
          </div>
          <div style={{ opacity: 0.55 }}><WaveRule color={T.line} h={9} amp={2.5} /></div>
        </div>

        {/* ===== REPORTING PERIOD ===== */}
        <div className="flex items-center justify-between" style={{ padding: '0 2px' }}>
          <div className="flex items-center gap-2"><span style={{ width: 5, height: 5, transform: 'rotate(45deg)', background: T.bronze, display: 'inline-block' }}></span><Engrave>Reporting period</Engrave></div>
          <div className="inline-flex" style={{ border: `1px solid ${T.line}`, borderRadius: 8, overflow: 'hidden', background: CD.panel }}>
            {RANGES.map(([id, label]) => <button key={id} onClick={() => setRange(id)} style={{ fontFamily: 'Space Mono, monospace', fontSize: 11, padding: '5px 12px', background: range === id ? CD.ink : 'transparent', color: range === id ? 'var(--cd-on-ink)' : T.steel, borderLeft: id !== '7d' ? `1px solid ${T.hair}` : 'none', letterSpacing: '0.04em', fontWeight: range === id ? 700 : 400 }}>{label}</button>)}
          </div>
        </div>

        {/* ===== GRID ===== */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 13 }}>

          {/* CASH POSITION & FX EXPOSURE — the desk's actual holdings.

              What was here derived a "position" from the net of the
              period's deals, which is a FLOW. It reported the desk short
              currencies it was long and short a currency it had never
              held. This reads the boxes. */}
          <Card title="Cash position · FX exposure" span={2}
            action={<div className="inline-flex" style={{ border: `1px solid ${T.line}`, borderRadius: 6, overflow: 'hidden' }}>{[['value', home], ['units', 'Units']].map(([v, l]) => <button key={v} onClick={() => setPosMode(v)} className="text-[10px] px-2 py-0.5" style={{ background: posMode === v ? CD.ink : 'transparent', color: posMode === v ? 'var(--cd-on-ink)' : T.steel, fontFamily: 'Space Mono, monospace' }}>{l}</button>)}</div>}>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[
                ['Foreign cash held', fxTotal, CD.ink, false],
                ['Currencies on the book', fxRows.length, T.slate, false, 'count'],
                ['1% rate move', sensitivity, T.bronze, true],
              ].map(([l, v, col, pm, kind]) => (
                <div key={l} style={{ background: T.vignette, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '8px 11px' }}>
                  <div style={{ fontSize: 8.5, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{l}</div>
                  {v == null
                    ? <div style={{ marginTop: 2 }}><Absent why={held ? 'no board rate published' : ''} size={16} /></div>
                    : <div style={{ fontSize: 16, fontWeight: 800, color: col, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{kind === 'count' ? v : (pm ? '±' : '') + money0(v)}</div>}
                </div>
              ))}
            </div>
            {!held ? (
              <div style={{ padding: '18px 0', textAlign: 'center' }}>
                <Absent why={book.error || (book.loading ? 'reading the book…' : 'no till or vault balance on the ledger yet')} size={26} />
              </div>
            ) : !held.length ? (
              <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 11.5, color: T.steel }}>The ledger has this desk's boxes and they are empty.</div>
            ) : (<div className="space-y-1.5">
              {held.map(p => { const isBase = p.ccy === home; const wpc = ((Math.abs(p.home == null ? 0 : p.home)) / maxPos) * 100; const col = isBase ? CD.ink : T.green; return (
                <div key={p.ccy} className="flex items-center gap-2.5">
                  <span style={{ width: 18, textAlign: 'center', fontSize: 14 }}>{flagEmoji(p.ccy)}</span>
                  <span style={{ width: 36, fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 700, color: CD.ink }}>{p.ccy}</span>
                  <span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ borderRadius: 3, border: `1px solid ${col}`, color: col, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>{isBase ? 'BASE' : 'HELD'}</span>
                  <div className="flex-1 overflow-hidden" style={{ height: 6, background: T.wash, borderRadius: 999 }}><div style={{ width: wpc + '%', height: '100%', background: col, borderRadius: 999, opacity: 0.9 }}></div></div>
                  <span style={{ width: 92, textAlign: 'right', fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 600, color: p.home == null && posMode === 'value' ? T.steel : CD.ink, fontVariantNumeric: 'tabular-nums' }} title={p.home == null ? 'This branch has never published a rate for ' + p.ccy + ', so the ledger cannot value it.' : ''}>{posMode === 'value' ? (p.home == null ? '—' : money0(p.home)) : num(p.units)}</span>
                </div>); })}
            </div>)}
            <div className="mt-3 pt-2.5" style={{ borderTop: `1px solid ${T.hair}` }}><span style={{ fontSize: 10, color: T.steel }}>What the drawer and the safe physically hold, per the ledger — <span style={{ color: T.green }}>held</span> means the notes are in the building. Physical cash is never short. {sensitivity == null ? 'A currency the branch has not published a rate for cannot be valued, so the exposure figure is withheld rather than estimated.' : `A 1% move against ${home} shifts the foreign holding ±${money0(sensitivity)}.`}</span></div>
          </Card>

          {/* REVENUE MIX — commission versus TRADING MARGIN.

              The second slice used to be an FX spread estimated against a
              market mid. It is now the realized figure the disposal booked
              against what the notes actually cost, which is the only thing
              a desk may call profit. See docs/COST_BASIS.md. */}
          <Card title="Revenue mix">
            {periodEarn == null ? (
              <div style={{ padding: '22px 0', textAlign: 'center' }}><Absent why={noBook} size={26} /></div>
            ) : (<div className="flex items-center gap-4">
              <Donut a={Number(totFees || 0)} b={Number(totRealized || 0)} />
              <div className="flex-1 space-y-2.5">
                <div><div className="flex items-center gap-1.5" style={{ fontSize: 11, color: T.steel }}><span style={{ width: 9, height: 9, background: CD.ink, display: 'inline-block' }}></span> Commission</div>{totFees == null ? <Absent why="" size={16} /> : <div style={{ fontSize: 16, fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(Number(totFees))}</div>}</div>
                <div><div className="flex items-center gap-1.5" style={{ fontSize: 11, color: T.steel }}><span style={{ width: 9, height: 9, background: T.bronze, display: 'inline-block' }}></span> Trading margin</div>{totRealized == null ? <Absent why="no cost basis on these deals" size={16} /> : <div style={{ fontSize: 16, fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(Number(totRealized))}</div>}</div>
                <div className="pt-1.5" style={{ borderTop: `1px solid ${T.hair}` }}><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Blended margin</div>{marginPct == null ? <Absent why="" size={15} /> : <div style={{ fontSize: 15, fontWeight: 700, color: T.green }}>{marginPct.toFixed(2)}%</div>}</div>
              </div>
            </div>)}
          </Card>

          {/* TOP CORRIDORS */}
          <Card title="Top corridors">
            {D.corridors.length ? <div className="space-y-2">{D.corridors.map(c => { const wpc = (c.vol / maxCorr) * 100; return (
              <div key={c.route} className="flex items-center gap-2.5">
                <span style={{ width: 86, fontFamily: 'Space Mono, monospace', fontSize: 11.5, fontWeight: 700, color: CD.ink, whiteSpace: 'nowrap' }}>{c.route}</span>
                <div className="flex-1 overflow-hidden" style={{ height: 6, background: T.wash, borderRadius: 999 }}><div style={{ width: wpc + '%', height: '100%', background: T.slate, borderRadius: 999 }}></div></div>
                <span style={{ width: 72, textAlign: 'right', fontFamily: 'Space Mono, monospace', fontSize: 11.5, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(c.vol)}</span>
              </div>); })}</div> : <div style={{ fontSize: 11, color: T.steel, padding: '12px 0' }}>No deals in this period.</div>}
          </Card>

          {/* TOP CLIENTS */}
          <Card title="Top clients" action={onOpenLedger && <button onClick={() => onOpenLedger()} style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>ledger ›</button>}>
            <div className="space-y-2">
              {D.topClients.map((c, i) => (
                <button key={c.name} onClick={() => onOpenClient && onOpenClient(c.name)} className="w-full flex items-center gap-2.5 text-left">
                  <span style={{ width: 14, fontFamily: 'Space Mono, monospace', fontSize: 11, color: T.bronze }}>{i + 1}</span>
                  <span className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: '50%', background: CD.ink, color: 'var(--cd-on-ink)', fontSize: 10, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{initials(c.name)}</span>
                  <div className="flex-1 min-w-0"><div className="text-[12.5px] font-medium truncate" style={{ color: CD.ink }}>{c.name}</div><div style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>{c.n} deals</div></div>
                  <div className="text-right"><div style={{ fontSize: 12.5, fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(c.vol)}</div><div style={{ fontSize: 10, color: T.green, fontVariantNumeric: 'tabular-nums' }}>+{money0(c.earn)}</div></div>
                </button>
              ))}
            </div>
          </Card>

          {/* DESK PERFORMANCE */}
          <Card title="Desk performance">
            <div className="space-y-2.5">
              {D.tellers.map(([name, earn]) => (
                <div key={name}>
                  <div className="flex justify-between" style={{ fontSize: 11.5, marginBottom: 4 }}><span style={{ color: CD.ink }}>{name}</span><span style={{ color: T.steel, fontVariantNumeric: 'tabular-nums', fontFamily: 'Space Mono, monospace' }}>{money0(earn)}</span></div>
                  <div className="overflow-hidden" style={{ height: 6, background: T.wash, borderRadius: 999 }}><div style={{ width: (earn / maxTeller) * 100 + '%', height: '100%', background: T.slate, borderRadius: 999 }}></div></div>
                </div>
              ))}
            </div>
          </Card>

          {/* COMPLIANCE */}
          <Card title="Compliance">
            <div className="grid grid-cols-2 gap-2">
              {[['Reportable open', D.rptOpen, D.rptOpen > 0 ? T.oxblood : T.green, 'RPT'], ['LCTRs filed', D.rptFiled, T.green, 'RPT'], ['Structuring', D.str, D.str > 0 ? T.bronze : T.green, 'STR'], ['KYC gaps', D.kyc, D.kyc > 0 ? T.oxblood : T.green, 'ID']].map(([l, v, col, view]) => (
                <button key={l} onClick={() => openFiltered && openFiltered(view)} className="text-left" style={{ background: T.vignette, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: col, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                  <div style={{ fontSize: 10.5, color: T.steel, marginTop: 1 }}>{l}</div>
                </button>
              ))}
            </div>
            <div className="mt-2.5" style={{ fontSize: 10.5, color: (D.rptOpen + D.kyc + X.sanc) > 0 ? T.oxblood : T.green, display: 'flex', alignItems: 'center', gap: 6 }}><Ic n={(D.rptOpen + D.kyc + X.sanc) > 0 ? 'alert' : 'checkcircle'} s={12} /> {(D.rptOpen + D.kyc + X.sanc) > 0 ? `${D.rptOpen + D.kyc + X.sanc} item(s) need attention` : 'Book is clean — all clear'}</div>
            <div className="grid grid-cols-3 gap-2 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${T.hair}` }}>
              {[['Sanctions', X.sanc, X.sanc > 0 ? T.oxblood : T.green], [`${X.regime.aggHours}h aggregates`, X.agg, X.agg > 0 ? T.bronze : T.green], [`${X.regime.wireCode} to file`, X.eftr == null ? '—' : X.eftr, X.eftr ? T.oxblood : T.green]].map(([l, v, col]) => (
                <button key={l} onClick={() => onOpenApp && onOpenApp('compliance')} className="text-left" style={{ background: T.vignette, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '7px 10px' }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: col, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                  <div style={{ fontSize: 9.5, color: T.steel }}>{l}</div>
                </button>))}
            </div>
          </Card>

          {/* TRANSFERS */}
          <Card title="Transfers" action={onOpenApp && <button onClick={() => onOpenApp('transfers')} style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>open ›</button>}>
            <div className="flex items-end justify-between">
              <div><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>In flight value</div><div style={{ fontSize: 26, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{money0(X.tVol)}</div></div>
              <div className="text-right"><div style={{ fontSize: 22, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{X.tInProg}</div><div style={{ fontSize: 9.5, color: T.steel }}>in progress</div></div>
            </div>
            <div className="mt-2.5 pt-2.5 flex items-center gap-2" style={{ borderTop: `1px solid ${T.hair}`, fontSize: 10.5 }}>
              {X.tHold > 0 ? <span style={{ color: T.oxblood, fontWeight: 600 }}>{X.tHold} on hold</span> : <span style={{ color: T.green }}>none on hold</span>}
              <span style={{ color: T.steel }}>· {X.limit.amount == null ? 'no reporting line set for this desk' : `${X.eftr} cross-border ≥ ${X.limit.label}`}</span>
            </div>
          </Card>

          {/* CHEQUES — cash at risk */}
          <Card title="Cheques · cash at risk" action={onOpenApp && <button onClick={() => onOpenApp('cheques')} style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>open ›</button>}>
            <div className="flex items-end justify-between">
              <div><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Fronted, uncleared</div><div style={{ fontSize: 26, fontWeight: 800, color: X.chOverdue ? T.oxblood : CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{money0(X.chRisk)}</div></div>
              {X.chLoss > 0 && <div className="text-right"><div style={{ fontSize: 16, fontWeight: 800, color: T.oxblood, fontVariantNumeric: 'tabular-nums' }}>{money0(X.chLoss)}</div><div style={{ fontSize: 9.5, color: T.steel }}>returned loss</div></div>}
            </div>
            <div className="mt-2.5 pt-2.5 flex items-center gap-1.5" style={{ borderTop: `1px solid ${T.hair}`, fontSize: 10.5, color: X.chOverdue ? T.oxblood : T.green }}><Ic n={X.chOverdue ? 'alert' : 'checkcircle'} s={12} />{X.chOverdue > 0 ? `${X.chOverdue} past hold date — chase the bank` : 'all holds current'}</div>
          </Card>

          {/* VAULT — treasury */}
          <Card title="Vault · cash on hand" action={onOpenApp && <button onClick={() => onOpenApp('vault')} style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>open ›</button>}>
            <div className="flex items-end justify-between">
              <div><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Total on hand</div>
                {X.vaultTotals && X.vaultTotals.marketValueHome != null
                  ? <div style={{ fontSize: 26, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{money0(Number(X.vaultTotals.marketValueHome))}</div>
                  : <Absent why={X.vaultTracked ? 'not every currency has a board rate' : 'this vault is not on the ledger yet'} size={26} />}
              </div>
              {X.vaultTotals && X.vaultTotals.unrealizedPnlHome != null && <div className="text-right"><div style={{ fontSize: 16, fontWeight: 800, color: Number(X.vaultTotals.unrealizedPnlHome) >= 0 ? T.green : T.oxblood, fontVariantNumeric: 'tabular-nums' }}>{money0(Number(X.vaultTotals.unrealizedPnlHome))}</div><div style={{ fontSize: 9.5, color: T.steel }}>unrealized</div></div>}
            </div>
            <div className="mt-2.5 pt-2.5 flex items-center gap-1.5" style={{ borderTop: `1px solid ${T.hair}`, fontSize: 10.5, color: X.vaultTracked ? T.green : T.bronze }}><Ic n={X.vaultTracked ? 'checkcircle' : 'alert'} s={12} />{X.vaultTracked ? `${X.vaultTotals.currencies} currenc${X.vaultTotals.currencies === 1 ? 'y' : 'ies'} on the ledger` : 'count the safe once and record it'}</div>
          </Card>

          {/* MARKET MOVERS */}
          <Card title="Market movers">
            <div className="grid grid-cols-2 gap-1.5">
              {D.movers.map(m => { const up = m.chg >= 0; return (
                <div key={m.code} className="flex items-center gap-2 px-2 py-1.5" style={{ background: T.vignette, border: `1px solid ${T.hair}`, borderRadius: 7 }}>
                  <span style={{ fontSize: 14 }}>{m.flag}</span>
                  <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 700, color: CD.ink }}>{m.code}</span>
                  <span className="ml-auto inline-flex items-center gap-0.5" style={{ fontSize: 11, fontWeight: 700, color: up ? T.green : T.oxblood, fontFamily: 'Space Mono, monospace' }}>{up ? '▲' : '▼'}{Math.abs(m.chg).toFixed(2)}%</span>
                </div>); })}
            </div>
          </Card>

          {/* LIVE ACTIVITY */}
          <Card title="Live activity" span={2} action={onOpenLedger && <button onClick={() => onOpenLedger()} style={{ fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace' }}>open ledger ›</button>}>
            <div>
              {D.recent.map((r, i) => (
                <button key={r.id} onClick={() => onOpenLedger && onOpenLedger()} className="w-full flex items-center gap-3 py-1.5 text-left" style={{ borderTop: i ? `1px solid ${T.hair}` : 'none' }}>
                  <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 10.5, color: T.steel, width: 92, whiteSpace: 'nowrap' }}>{r.date.slice(5)} {r.time}</span>
                  <span className="grid place-items-center flex-none" style={{ width: 24, height: 24, borderRadius: '50%', background: T.wash, color: T.slate, fontSize: 9, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{initials(r.customer)}</span>
                  <span className="text-[12px] font-medium truncate" style={{ color: CD.ink, flex: 1, minWidth: 0 }}>{r.customer}</span>
                  <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 11.5, color: T.steel, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{num(r.inAmt)} {r.inCcy} <span style={{ color: T.bronze }}>→</span> <span style={{ color: T.green }}>{num(r.outAmt)} {r.outCcy}</span></span>
                  <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 11, color: T.bronze, width: 54, textAlign: 'right' }}>+{fmt(r.fee, 'CAD')}</span>
                </button>
              ))}
            </div>
          </Card>

        </div>
        <div style={{ textAlign: 'center', padding: '2px 0 6px', fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace', letterSpacing: '0.08em' }}>EVERY FIGURE FROM THE LEDGER · {home}-EQUIVALENT AT THE DESK'S OWN BOARD · VOIDED RECORDS EXCLUDED · A DASH MEANS THE BOOK HAS NO ANSWER</div>
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Dashboard });
})();
