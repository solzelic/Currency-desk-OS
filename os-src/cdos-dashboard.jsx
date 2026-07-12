/* ============================================================
   CurrencyDesk OS — Dashboard (owner command center)
   Design language: banknote security engraving. Guilloché rosettes,
   intaglio hairlines, treasury inks (slate / green / oxblood / bronze)
   on cream, serial-number typography — the feel of currency itself,
   held to Apple-grade restraint. All data is live off the ledger
   and the rate engine.
   ============================================================ */
(function () {
  const { useState, useMemo } = React;
  const { CD, Ic, fmt, num, crossRate, perCadLive, TODAY, dDiff } = window.CDOS;
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
  const spreadOf = (r) => { const mid = (+r.inAmt || 0) * crossRate(r.inCcy, r.outCcy); const d = mid - (+r.outAmt || 0); return d > 0 ? d / (perCadLive(r.outCcy) || 1) : 0; };
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

  /* ============================================================ */
  function Dashboard({ rows, clients, settings, me, onOpenLedger, onOpenClient, openFiltered, onOpenApp }) {
    const [posMode, setPosMode] = useState('value');
    const [range, setRange] = useState('30d');
    const D = useMemo(() => {
      const rdef = RANGES.find(r => r[0] === range) || RANGES[1];
      const winDays = rdef[2];
      const inCur = (d) => winDays == null ? true : (dDiff(d, TODAY) >= -0.5 && dDiff(d, TODAY) <= winDays + 0.5);
      const inPrev = (d) => winDays == null ? false : (dDiff(d, TODAY) > winDays + 0.5 && dDiff(d, TODAY) <= winDays * 2 + 0.5);
      const allLive = rows.filter(r => r.status !== 'void');
      const live = allLive.filter(r => inCur(r.date));
      const allDates = [...new Set(allLive.map(r => r.date))].sort();
      const serialKey = allLive.some(r => r.date === TODAY) ? TODAY : (allDates[allDates.length - 1] || TODAY);

      let totVol = 0, totFees = 0, totSpread = 0;
      const pos = {}, ccys = new Set();
      live.forEach(r => { totVol += cadOf(r.inAmt, r.inCcy); totFees += (+r.fee || 0); totSpread += spreadOf(r); ccys.add(r.inCcy); ccys.add(r.outCcy); pos[r.inCcy] = (pos[r.inCcy] || 0) + (+r.inAmt || 0); pos[r.outCcy] = (pos[r.outCcy] || 0) - (+r.outAmt || 0); });
      const positions = [...ccys].map(c => ({ ccy: c, units: pos[c] || 0, cad: c === 'CAD' ? (pos[c] || 0) : (pos[c] || 0) / (crossRate('CAD', c) || 1) })).sort((a, b) => Math.abs(b.cad) - Math.abs(a.cad));
      const fxNet = positions.filter(p => p.ccy !== 'CAD').reduce((s, p) => s + p.cad, 0);
      const fxGross = positions.filter(p => p.ccy !== 'CAD').reduce((s, p) => s + Math.abs(p.cad), 0);
      const prevEarn = allLive.filter(r => inPrev(r.date)).reduce((s, r) => s + (+r.fee || 0) + spreadOf(r), 0);

      const cl = {};
      live.forEach(r => { const k = r.customer || '—'; const c = cl[k] || (cl[k] = { name: k, vol: 0, earn: 0, n: 0 }); c.vol += cadOf(r.inAmt, r.inCcy); c.earn += (+r.fee || 0) + spreadOf(r); c.n++; });
      const topClients = Object.values(cl).sort((a, b) => b.vol - a.vol).slice(0, 5);
      const tl = {}; live.forEach(r => { tl[r.teller || '—'] = (tl[r.teller || '—'] || 0) + (+r.fee || 0) + spreadOf(r); });
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
      const bk = {}; live.forEach(r => { const k = keyOf(r.date); bk[k] = (bk[k] || 0) + (+r.fee || 0) + spreadOf(r); });
      const series = Object.keys(bk).sort().slice(-12).map(k => ({ key: k, label: labelOf(k), earn: bk[k] }));

      return { totVol, totFees, totSpread, rev: totFees + totSpread, periodEarn: totFees + totSpread, prevEarn, n: live.length, positions, fxNet, fxGross, topClients, tellers, corridors, rptOpen, rptFiled, str: strSet.size, kyc: kycSet.size, recent, movers, series, serialKey, bmode };
    }, [rows, clients, settings, range]);

    // ---- cross-module consolidation: Transfers, Cheques, Vault, screening ----
    const X = useMemo(() => {
      const J = (k, d) => { try { const r = JSON.parse(localStorage.getItem(k) || 'null'); return r == null ? d : r; } catch (e) { return d; } };
      const P = window.CDOS, comp = P._compliance;
      const transfers = J('cdos_transfers_v1', []), cheques = J('cdos_cheques_v1', []), beneficiaries = J('cdos_beneficiaries_v1', []);
      const tInProg = transfers.filter(t => t.status !== 'paid' && t.status !== 'cancelled').length;
      const tHold = transfers.filter(t => t.status === 'hold').length;
      const tVol = transfers.filter(t => t.status !== 'cancelled').reduce((s, t) => s + (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')), 0);
      const chRisk = cheques.filter(c => c.status === 'held').reduce((s, c) => s + (+c.netCad || 0), 0);
      const chOverdue = cheques.filter(c => c.status === 'held' && c.holdUntil < TODAY).length;
      const chLoss = cheques.filter(c => c.status === 'returned').reduce((s, c) => s + (+c.netCad || 0), 0);
      const baseline = J('cdos_baseline_v1', null) || (P.defaultBaseline ? P.defaultBaseline() : null);
      const receipts = J('cdos_receipts_v1', null) || (P.defaultReceipts ? P.defaultReceipts() : []);
      const VCCYS = ['CAD', 'USD', 'EUR', 'GBP', 'INR', 'PHP', 'CNY', 'MXN', 'AED'];
      const hold = (c) => P.holdings ? P.holdings(c, rows, baseline, receipts) : 0;
      const vaultTotal = VCCYS.reduce((s, c) => s + (c === 'CAD' ? hold(c) : hold(c) * (crossRate(c, 'CAD') || 0)), 0);
      const vaultFx = VCCYS.filter(c => c !== 'CAD').reduce((s, c) => s + hold(c) * (crossRate(c, 'CAD') || 0), 0);
      const regime = P.getRegime ? P.getRegime(settings) : { threshold: 10000, aggHours: 24 };
      const lowN = VCCYS.filter(c => { const b = { CAD: 120000, USD: 40000, EUR: 18000, GBP: 8000, INR: 2500000, PHP: 1200000, CNY: 120000, MXN: 200000, AED: 35000 }[c]; return b && hold(c) < b; }).length;
      let sanc = 0;
      if (comp) { Object.keys(clients || {}).forEach(n => { if (comp.screen(n).status !== 'clear') sanc++; }); beneficiaries.forEach(b => { if (comp.screen(b.name).status !== 'clear') sanc++; }); }
      const agg = comp ? comp.aggClusters(rows, regime).length : 0;
      const eftr = transfers.filter(t => t.status !== 'cancelled' && (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')) >= regime.threshold).length;
      return { tInProg, tHold, tVol, chRisk, chOverdue, chLoss, vaultTotal, vaultFx, lowN, sanc, agg, eftr, regime };
    }, [rows, clients, settings, range]);

    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const firstName = (me && me.name ? me.name.split(/[ .]/).filter(Boolean).pop() : '') || 'there';
    const marginPct = D.totVol ? (D.rev / D.totVol) * 100 : 0;
    const sensitivity = Math.abs(D.fxNet) * 0.01;
    const maxPos = Math.max(1, ...D.positions.map(p => Math.abs(p.cad)));
    const maxTeller = Math.max(1, ...D.tellers.map(t => t[1]));
    const maxCorr = Math.max(1, ...D.corridors.map(c => c.vol));
    const headLabel = HEAD[range] || 'Period';
    const bucketWord = D.bmode === 'day' ? 'days' : D.bmode === 'week' ? 'weeks' : 'months';
    const serial = (D.serialKey || '').replace(/-/g, '') + ' · ' + (settings && settings.deskName ? settings.deskName.replace(/[^0-9]/g, '') || '01' : '01');
    const deskName = (settings && (settings.operatingName || settings.bizName)) || 'York Currency Exchange';

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
                  <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(D.periodEarn)}</span>
                  <Delta cur={D.periodEarn} prev={D.prevEarn} />
                </div>
                <div style={{ height: 1, background: `repeating-linear-gradient(90deg, ${T.slate} 0 5px, transparent 5px 9px)`, opacity: 0.5, margin: '12px 0', maxWidth: 300 }}></div>
                <div className="flex" style={{ gap: 0 }}>
                  {[['Volume', money0(D.totVol)], ['Deals', String(D.n)], ['Margin', marginPct.toFixed(2) + '%']].map(([l, v], i) => (
                    <div key={l} style={{ paddingRight: 18, marginRight: 18, borderRight: i < 2 ? `1px solid ${T.hair}` : 'none' }}>
                      <div style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.12em', color: T.steel, fontFamily: 'Space Mono, monospace' }}>{l}</div>
                      <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
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
                    <span style={{ fontSize: 10, fontFamily: 'Space Mono, monospace', color: T.bronze }}>{money0(D.rev)} total</span>
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

          {/* CASH POSITION & FX EXPOSURE */}
          <Card title="Cash position · FX exposure" span={2}
            action={<div className="inline-flex" style={{ border: `1px solid ${T.line}`, borderRadius: 6, overflow: 'hidden' }}>{[['value', 'CAD'], ['units', 'Units']].map(([v, l]) => <button key={v} onClick={() => setPosMode(v)} className="text-[10px] px-2 py-0.5" style={{ background: posMode === v ? CD.ink : 'transparent', color: posMode === v ? 'var(--cd-on-ink)' : T.steel, fontFamily: 'Space Mono, monospace' }}>{l}</button>)}</div>}>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[['Net exposure', D.fxNet, D.fxNet >= 0 ? T.green : T.oxblood, false], ['Gross exposure', D.fxGross, CD.ink, false], ['1% rate move', sensitivity, T.bronze, true]].map(([l, v, col, pm]) => (
                <div key={l} style={{ background: T.vignette, border: `1px solid ${T.hair}`, borderRadius: 8, padding: '8px 11px' }}>
                  <div style={{ fontSize: 8.5, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{l}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: col, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{pm ? '±' : ''}{money0(v)}</div>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {D.positions.map(p => { const long = p.cad >= 0, isBase = p.ccy === 'CAD'; const wpc = (Math.abs(p.cad) / maxPos) * 100; const col = isBase ? CD.ink : long ? T.green : T.oxblood; return (
                <div key={p.ccy} className="flex items-center gap-2.5">
                  <span style={{ width: 18, textAlign: 'center', fontSize: 14 }}>{flagEmoji(p.ccy)}</span>
                  <span style={{ width: 36, fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 700, color: CD.ink }}>{p.ccy}</span>
                  <span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ borderRadius: 3, border: `1px solid ${col}`, color: col, fontFamily: 'Space Mono, monospace', letterSpacing: '0.05em' }}>{isBase ? 'BASE' : long ? 'LONG' : 'SHORT'}</span>
                  <div className="flex-1 overflow-hidden" style={{ height: 6, background: T.wash, borderRadius: 999 }}><div style={{ width: wpc + '%', height: '100%', background: col, borderRadius: 999, opacity: 0.9 }}></div></div>
                  <span style={{ width: 92, textAlign: 'right', fontFamily: 'Space Mono, monospace', fontSize: 12, fontWeight: 600, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{posMode === 'value' ? money0(p.cad) : num(p.units)}</span>
                </div>); })}
            </div>
            <div className="mt-3 pt-2.5" style={{ borderTop: `1px solid ${T.hair}` }}><span style={{ fontSize: 10, color: T.steel }}>Net of every posted deal · <span style={{ color: T.green }}>long</span> you hold it, <span style={{ color: T.oxblood }}>short</span> you owe it · a 1% CAD move shifts the book ±{money0(sensitivity)}.</span></div>
          </Card>

          {/* REVENUE MIX */}
          <Card title="Revenue mix">
            <div className="flex items-center gap-4">
              <Donut a={D.totFees} b={D.totSpread} />
              <div className="flex-1 space-y-2.5">
                <div><div className="flex items-center gap-1.5" style={{ fontSize: 11, color: T.steel }}><span style={{ width: 9, height: 9, background: CD.ink, display: 'inline-block' }}></span> Commission</div><div style={{ fontSize: 16, fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(D.totFees)}</div></div>
                <div><div className="flex items-center gap-1.5" style={{ fontSize: 11, color: T.steel }}><span style={{ width: 9, height: 9, background: T.bronze, display: 'inline-block' }}></span> FX spread</div><div style={{ fontSize: 16, fontWeight: 700, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{money0(D.totSpread)}</div></div>
                <div className="pt-1.5" style={{ borderTop: `1px solid ${T.hair}` }}><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Blended margin</div><div style={{ fontSize: 15, fontWeight: 700, color: T.green }}>{marginPct.toFixed(2)}%</div></div>
              </div>
            </div>
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
              {[['Sanctions', X.sanc, X.sanc > 0 ? T.oxblood : T.green], [`${X.regime.aggHours}h aggregates`, X.agg, X.agg > 0 ? T.bronze : T.green], [`${X.regime.wireCode} to file`, X.eftr, X.eftr > 0 ? T.oxblood : T.green]].map(([l, v, col]) => (
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
              <span style={{ color: T.steel }}>· {X.eftr} cross-border ≥ {money0(X.regime.threshold)}</span>
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
              <div><div style={{ fontSize: 9, color: T.steel, fontFamily: 'Space Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Total on hand</div><div style={{ fontSize: 26, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{money0(X.vaultTotal)}</div></div>
              <div className="text-right"><div style={{ fontSize: 16, fontWeight: 800, color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{X.vaultTotal ? Math.round(X.vaultFx / X.vaultTotal * 100) : 0}%</div><div style={{ fontSize: 9.5, color: T.steel }}>in FX</div></div>
            </div>
            <div className="mt-2.5 pt-2.5 flex items-center gap-1.5" style={{ borderTop: `1px solid ${T.hair}`, fontSize: 10.5, color: X.lowN ? T.oxblood : T.green }}><Ic n={X.lowN ? 'alert' : 'checkcircle'} s={12} />{X.lowN > 0 ? `${X.lowN} currenc${X.lowN === 1 ? 'y' : 'ies'} low — reorder` : 'all currencies stocked'}</div>
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
        <div style={{ textAlign: 'center', padding: '2px 0 6px', fontSize: 10, color: T.steel, fontFamily: 'Space Mono, monospace', letterSpacing: '0.08em' }}>ALL FIGURES CAD-EQUIVALENT AT LIVE SPOT · VOIDED RECORDS EXCLUDED</div>
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Dashboard });
})();
