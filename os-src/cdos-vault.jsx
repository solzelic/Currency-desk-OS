/* ============================================================
   CurrencyDesk OS — Cash on Hand · Vault
   The treasury pillar, reading the one book.

   THIS SCREEN USED TO DERIVE THE SAFE'S CONTENTS IN THE BROWSER, from a
   demo opening baseline plus every posted record, and it announced
   $594,124.00 across nine currencies for a vault that was empty until
   somebody counted it. The Assign modal showed three different balances
   for the same safe on one screen — GBP 6,111.05 on the "to a person"
   tab, 8,000 on the "to a till" tab, 8,000 behind it on Position, and 0
   in the ledger — and a red bar two lines under the 8,000 read "The vault
   holds 0.00 GBP". And the P&L tab printed "Unrealized +$4,813.65" over
   currencies whose avg_cost is NULL on the server.

   Every one of those is the same defect: a second book. So:

     • Position  — GET /api/ledger/position. Quantity, average cost and
                   unrealized P&L as the ledger states them, with "—" and
                   a reason wherever it has no answer. Nothing here
                   multiplies a quantity by a rate for itself.
     • Floats    — one source for every balance on the screen. The assign
                   modal reads the same vault figures the Position tab
                   does, so one currency cannot show two numbers.
     • Orders    — a delivery is a recorded movement into the safe.
     • P&L       — GET /api/ledger/summary. Realized profit from the
                   figure the disposal wrote, per docs/COST_BASIS.md,
                   never a spread against a market mid.

   The vault owns only accountability records (shifts). Cash is the
   ledger's — see docs/CASH_OWNERSHIP_INVARIANTS.md — and an absent
   figure is shown as absent, per docs/ABSENT_FIGURES.md.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, crossRate, Absent, businessDate, useDeskFacts, STAFF } = window.CDOS;

  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  /* Display-only conversion, for totalling a float across currencies in
     the assign modal. It never produces a HOLDING — every quantity on
     this screen came from the ledger. */
  const cadPer = (c) => c === 'CAD' ? 1 : (crossRate(c, 'CAD') || 0);
  const cadVal = (units, c) => (+units || 0) * cadPer(c);

  /* ---- the branch's position, from the book ----
     One fetch, shared by every tab, re-read whenever cash has moved
     (`cashVersion` ticks on each recorded movement). `error` is rendered,
     not swallowed: a screen that fails to reach the ledger and shows its
     last figures anyway is the second book coming back. */
  function useLedgerPosition(serverBacked, cashVersion) {
    const [state, setState] = useState({ loading: true, data: null, error: '' });
    useEffect(() => {
      if (!serverBacked || !window.CDOS.Backend) {
        setState({ loading: false, data: null, error: 'This desk is not signed in to the ledger, so it cannot say what the safe holds.' });
        return;
      }
      let live = true;
      setState(s => ({ ...s, loading: true }));
      window.CDOS.Backend.loadLedgerPosition()
        .then(data => { if (live) setState({ loading: false, data, error: '' }); })
        .catch(error => { if (live) setState({ loading: false, data: null, error: (error && error.message) || 'The ledger could not be reached.' }); });
      return () => { live = false; };
    }, [serverBacked, cashVersion]);
    return state;
  }

  /* What the SAFE holds, per currency, as the ledger states it. Returns
     null for a currency the vault has no row for — which is not zero, and
     the callers below are careful about the difference. */
  function vaultRowsOf(position) {
    if (!position || !position.vaultTracked) return null;
    return (position.currencies || [])
      .filter(row => row.vault)
      .map(row => ({ c: row.currency, ...row.vault, marketUnitHome: row.marketUnitHome }));
  }

  const SKEY = 'cdos_vault_shifts';
  const DEFAULT_FC = ['CAD', 'USD', 'EUR', 'GBP'];
  /* What a wholesale order can be placed in. The ledger carries these four
     today (see the scope limits in docs/CASH_OWNERSHIP_INVARIANTS.md), and
     offering the other five would let somebody record a delivery the book
     cannot take. The nine-currency list this replaced was the demo seed's. */
  const ORDER_CCYS = DEFAULT_FC;
  const floatCcysOf = (settings) => (settings && Array.isArray(settings.floatCcys) && settings.floatCcys.length) ? settings.floatCcys : DEFAULT_FC;

  /* reorder bands — min (reorder point) / target / max in UNITS */
  const BANDS = {
    CAD: { min: 120000, target: 250000, max: 400000 },
    USD: { min: 40000, target: 90000, max: 150000 },
    EUR: { min: 18000, target: 35000, max: 60000 },
    GBP: { min: 8000, target: 16000, max: 28000 },
    INR: { min: 2500000, target: 4500000, max: 7000000 },
    PHP: { min: 1200000, target: 2000000, max: 3200000 },
    CNY: { min: 120000, target: 240000, max: 400000 },
    MXN: { min: 200000, target: 400000, max: 650000 },
    AED: { min: 35000, target: 70000, max: 120000 },
  };

  /* Shifts are accountability records — who had which float on the desk —
     and they are this screen's own, kept on the device.

     Sixteen invented settled shifts used to be WRITTEN INTO localStorage
     here on first render, so "variance by person" opened with three weeks
     of track record for people who had never worked a day and drawers
     that had never been counted. A real desk starts with none, and the
     empty state below says so. */
  function loadShifts() {
    try { const saved = JSON.parse(localStorage.getItem(SKEY) || 'null'); return Array.isArray(saved) ? saved : []; }
    catch (e) { return []; }
  }

  /* floors: the owner's Settings → Vault floors override the built-in reorder bands.
     CAD uses the base-currency reserve floor; others use per-currency floors. */
  const floorOf = (c, settings) => {
    if (settings) {
      if (c === 'CAD' && settings.vaultReserveCad != null && settings.vaultReserveCad !== '' && +settings.vaultReserveCad > 0) return +settings.vaultReserveCad;
      const f = settings.vaultFloors && settings.vaultFloors[c];
      if (f != null && f !== '' && +f > 0) return +f;
    }
    return BANDS[c] ? BANDS[c].min : 0;
  };
  function bandStatus(c, units, settings) {
    const b = BANDS[c] || {};
    const min = floorOf(c, settings);
    if (!min && !b.max) return { tone: CD.mute, label: 'no band', level: 'ok' };
    if (min && units < min) return { tone: CD.flag, label: 'below reorder', level: 'low' };
    if (b.max && units > b.max) return { tone: CD.amber, label: 'over-stocked', level: 'high' };
    return { tone: CD.green, label: 'in band', level: 'ok' };
  }

  /* ===================== shared bits ===================== */
  function Stat({ label, value, sub, tone, big }) {
    return (<div style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12, padding: big ? '14px 16px' : '12px 14px' }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 19, fontWeight: 800, color: tone || CD.ink, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, marginTop: 3 }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: CD.faint }}>{sub}</div>}
    </div>);
  }
  // simple, legible stock status — replaces the busy reorder-band bar
  function StatusPill({ level }) {
    const cfg = level === 'low' ? { bg: CD.flagSoft, fg: CD.flag, t: 'Low stock' } : level === 'high' ? { bg: CD.amberSoft, fg: CD.amber, t: 'Overstocked' } : { bg: CD.greenSoft, fg: CD.green, t: 'Healthy' };
    return <span className="inline-flex items-center gap-1.5 px-2 py-1" style={{ background: cfg.bg, color: cfg.fg, borderRadius: 999, fontSize: 11, fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.fg }}></span>{cfg.t}</span>;
  }
  function ConcBar({ parts, total }) {
    return (<div className="flex" style={{ height: 14, borderRadius: 5, overflow: 'hidden', border: `1px solid ${CD.line}` }}>
      {parts.map((p, i) => { const w = total ? (p.mkt / total) * 100 : 0; if (w < 0.4) return null;
        const shade = `hsl(${(i * 47) % 360} 8% ${22 + (i % 5) * 11}%)`;
        return <div key={p.c} title={`${p.c} · ${w.toFixed(1)}%`} style={{ width: w + '%', background: p.c === 'CAD' ? CD.ink : shade }}></div>; })}
    </div>);
  }

  /* ===================== POSITION (the ledger's, not ours) ===================== */
  function Position({ position, loading, error, settings, vaultTracked, onRecordOpening }) {
    const home = (position && position.homeCurrency) || 'CAD';
    const rows = vaultRowsOf(position);

    /* Three genuinely different states, and they used to render the same.
       A vault nobody has declared is not an empty vault, and an empty
       vault is not a vault worth $594,124. */
    if (loading) return <div className="p-8 text-center text-[12px]" style={{ color: CD.faint }}>Reading the vault off the ledger…</div>;
    if (error) return (<div className="p-4">
      <div className="flex items-start gap-2 px-3 py-2.5 text-[12px]" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 10 }}>
        <Ic n="alert" s={14} c={CD.flag} /><span>{error} Nothing is shown here rather than a figure from somewhere else.</span>
      </div>
    </div>);
    if (!rows) return (<div className="p-8 text-center">
      <Absent why="" size={30} />
      <div className="text-[12.5px] mt-1" style={{ color: CD.mute, maxWidth: 420, margin: '0 auto' }}>
        This vault has no opening position on the ledger, so there is nothing it can say the safe holds. Count it once and record it — after that every float, delivery and run is checked against it.
      </div>
      {onRecordOpening && <button onClick={onRecordOpening} className="inline-flex items-center gap-1.5 px-3.5 py-2 mt-3 text-[12.5px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="check" s={14} c="var(--cd-on-ink)" /> Record what’s in the safe</button>}
    </div>);

    const totals = (position && position.vaultTotals) || { currencies: 0, marketValueHome: null, costBasisHome: null, unrealizedPnlHome: null };
    const held = rows.filter(r => Number(r.quantity) > 0);
    /* Concentration and the FX share are shares of a total, so they mean
       nothing unless the total does. Where the ledger could not value
       every currency it says so instead of dividing by a partial sum. */
    const totalMkt = totals.marketValueHome == null ? null : Number(totals.marketValueHome);
    const fxMkt = totalMkt == null ? null : held
      .filter(r => r.c !== home)
      .reduce((sum, r) => sum + Number(r.marketValueHome || 0), 0);
    const top = held.slice().sort((a, b) => Number(b.marketValueHome || 0) - Number(a.marketValueHome || 0))[0] || null;
    const unvalued = (position.unvaluedCurrencies || []).filter(c => held.some(r => r.c === c));
    const unpriced = (position.unpricedCurrencies || []).filter(c => held.some(r => r.c === c));
    const lowN = held.filter(r => bandStatus(r.c, Number(r.quantity), settings).level === 'low').length;
    const pct = (part) => totalMkt ? Math.round((part / totalMkt) * 100) : null;

    return (<div className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <Stat big label={`Total on hand · ${home}`}
          value={totals.marketValueHome == null
            ? <Absent why={unvalued.length ? `no board rate for ${unvalued.join(', ')}` : 'the ledger cannot value this safe'} size={26} />
            : fmt(totals.marketValueHome, home)}
          sub={`market value · ${held.length} currenc${held.length === 1 ? 'y' : 'ies'} on the ledger`} />
        <Stat label="FX exposure"
          value={pct(fxMkt) == null ? <Absent why="needs a full valuation" size={19} /> : pct(fxMkt) + '%'}
          sub={fxMkt == null ? 'unknown' : `${fmt(fxMkt, home)} not in ${home}`}
          tone={pct(fxMkt) != null && pct(fxMkt) > 70 ? CD.amber : CD.ink} />
        <Stat label="Top concentration"
          value={!top || pct(Number(top.marketValueHome || 0)) == null ? <Absent why="needs a full valuation" size={19} /> : pct(Number(top.marketValueHome)) + '%'}
          sub={top ? `${top.c} ${flagOf(top.c)}` : ''} />
        {/* The tile that used to be pure fiction: it printed +$4,461.13 over
            currencies whose average cost is NULL on the server. There is no
            honest figure to put there and now there isn't one. */}
        <Stat label="Unrealized P&L"
          value={totals.unrealizedPnlHome == null
            ? <Absent why={unpriced.length ? `no cost basis for ${unpriced.join(', ')}` : 'market value or basis unknown'} size={19} />
            : (Number(totals.unrealizedPnlHome) >= 0 ? '+' : '') + fmt(totals.unrealizedPnlHome, home)}
          sub="market vs cost basis"
          tone={totals.unrealizedPnlHome == null ? CD.faint : Number(totals.unrealizedPnlHome) >= 0 ? CD.green : CD.flag} />
      </div>

      {totalMkt != null && (<div className="p-3 mb-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Concentration by value</span>
        </div>
        <ConcBar parts={held.map(r => ({ c: r.c, mkt: Number(r.marketValueHome || 0) }))} total={totalMkt} />
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
          {held.slice(0, 6).map(r => <span key={r.c} className="text-[11px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{flagOf(r.c)} {r.c} {pct(Number(r.marketValueHome || 0))}%</span>)}
        </div>
      </div>)}

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">On hand</th>
            <th className="px-3 py-2 text-right">Avg cost</th><th className="px-3 py-2 text-right">{`Market · ${home}`}</th>
            <th className="px-3 py-2 text-right">Unrlzd P&L</th><th className="px-3 py-2 text-right" style={{ width: 130 }}>Status</th>
          </tr></thead>
          <tbody>{held.map(r => { const st = bandStatus(r.c, Number(r.quantity), settings); const upl = r.unrealizedPnlHome; return (<tr key={r.c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2.5 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(r.c)}</span> {r.c}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(Number(r.quantity)))}</td>
            {/* an average nobody recorded is a dash, not a guess */}
            <td className="px-3 py-2.5 text-right text-[12px]" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.mute }} title={r.avgCost == null && r.c !== home ? 'This cash reached the safe without a recorded price. Record a delivery invoice to give it one.' : ''}>{r.c === home ? '—' : r.avgCost == null ? '—' : Number(r.avgCost).toFixed(Number(r.avgCost) < 0.1 ? 5 : 4)}</td>
            <td className="px-3 py-2.5 text-right font-semibold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: r.marketValueHome == null ? CD.faint : CD.ink }} title={r.marketValueHome == null ? 'This branch has never published a rate for ' + r.c + ', so the ledger cannot value it.' : ''}>{r.marketValueHome == null ? '—' : num(Math.round(Number(r.marketValueHome)))}</td>
            <td className="px-3 py-2.5 text-right text-[12px] font-semibold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: upl == null ? CD.faint : (Number(upl) >= 0 ? CD.green : CD.flag) }}>{upl == null ? '—' : (Number(upl) >= 0 ? '+' : '') + num(Math.round(Number(upl)))}</td>
            <td className="px-3 py-2.5 text-right"><StatusPill level={st.level} /></td>
          </tr>); })}
          {!held.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-[12px]" style={{ color: CD.faint }}>This vault is on the ledger and holds nothing.</td></tr>}
          </tbody>
          <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
            <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>{`Total · ${home}`}</td><td></td><td></td>
            <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: totals.marketValueHome == null ? CD.faint : CD.ink }}>{totals.marketValueHome == null ? '—' : num(Math.round(Number(totals.marketValueHome)))}</td>
            <td className="px-3 py-2 text-right font-bold text-[12px]" style={{ fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: totals.unrealizedPnlHome == null ? CD.faint : Number(totals.unrealizedPnlHome) >= 0 ? CD.green : CD.flag }}>{totals.unrealizedPnlHome == null ? '—' : (Number(totals.unrealizedPnlHome) >= 0 ? '+' : '') + num(Math.round(Number(totals.unrealizedPnlHome)))}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>
        Every figure here is the ledger's — the safe's recorded balance, the average it actually paid, and the branch's own published board. A dash means the book has no answer, not zero: {unpriced.length ? `${unpriced.join(', ')} reached the safe without a recorded price` : 'nothing is missing a price'}{unvalued.length ? ` · no board rate published for ${unvalued.join(', ')}` : ''}. Reorder floors follow Settings → Vault{lowN ? ` · ${lowN} below floor` : ''}.
      </p>
    </div>);
  }

  /* ===================== SHIFTS (per-teller float + blind count) ===================== */
  function Shifts({ rows, position, me, log, shifts, setShifts, settings, setSettings, branches, station, onIssueTill }) {
    const [assigning, setAssigning] = useState(false);
    const [settling, setSettling] = useState(null);
    const fc = floatCcysOf(settings);
    // the branch you're standing in — assignment targets live here
    const myB = (branches || []).find(b => b.id === (station && station.branchId)) || (branches || [])[0];
    const roster = ((settings && settings.employees && settings.employees.length ? settings.employees : STAFF) || []).filter(e => e.active !== false && e.role !== 'Owner');
    const tellers = roster.filter(e => e.branches === '*' || !myB || !Array.isArray(e.branches) || e.branches.includes(myB.id));
    const tills = ((myB && myB.tills) || []).filter(t => t.status !== 'closed');
    /* ONE SOURCE FOR WHAT THE SAFE HOLDS.

       There used to be two functions here — `vaultAvailOf` reading this
       branch's local record for the "to a till" tab, and `availOf`
       deriving a pooled figure for the "to a person" tab — so the same
       modal showed GBP 6,111.05 on one tab and 8,000 on the other, over a
       vault the ledger said held nothing. Both tabs now read the ledger's
       vault row, and a currency with no row answers null so the modal can
       say "the ledger has no figure" instead of "0". */
    const vaultRows = vaultRowsOf(position);
    const vaultAvailOf = (c) => {
      if (!vaultRows) return null;
      const row = vaultRows.find(r => r.c === c);
      return row ? Number(row.quantity) : null;
    };
    const ccyChoices = Array.from(new Set([...(DEFAULT_FC), ...fc, ...((vaultRows || []).map(r => r.c))]));
    const open = shifts.filter(s => s.status === 'open');
    const settled = shifts.filter(s => s.status === 'settled').sort((a, b) => (b.settledAt || '').localeCompare(a.settledAt || ''));

    const byPerson = useMemo(() => {
      const m = {};
      settled.forEach(s => { const k = s.teller; (m[k] = m[k] || { teller: k, shifts: 0, net: 0, abs: 0 }); m[k].shifts++; m[k].net += (+s.varCad || 0); m[k].abs += Math.abs(+s.varCad || 0); });
      return Object.values(m).sort((a, b) => a.abs - b.abs);
    }, [shifts]);

    // expected for a shift = the float handed over + that teller's net ledger
    // movement during the shift. Pure read of posted records — no stock mutation.
    const expectedFor = (shift, c) => {
      const opening = (shift.opening && shift.opening[c]) || 0;
      const inSum = rows.filter(r => r.status !== 'void' && r.teller === shift.teller && r.date === shift.date && r.inCcy === c).reduce((s, r) => s + (+r.inAmt || 0), 0);
      const outSum = rows.filter(r => r.status !== 'void' && r.teller === shift.teller && r.date === shift.date && r.outCcy === c).reduce((s, r) => s + (+r.outAmt || 0), 0);
      return opening + inSum - outSum;
    };
    // assigning a float is accountability + location only: total holdings are
    // INVARIANT across it (the cash was already in the pool). No setVault here.
    const doAssign = (teller, opening) => {
      const sh = { id: Date.now(), teller, date: businessDate(), openedAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), openedBy: me.name, opening: { ...opening }, status: 'open', blind: true };
      setShifts(s => [sh, ...s]);
      log && log('Shift float assigned', `${teller} · ${fmt(fc.reduce((t, c) => t + cadVal(+opening[c] || 0, c), 0), 'CAD')} on the desk (accountability — holdings unchanged)`);
      setAssigning(false);
    };
    // vault → till: real cash, so the modal only closes once the movement has
    // actually been taken (by the ledger on a server-backed desk, locally
    // otherwise). A refusal comes back to the modal and stays on screen.
    const doIssueTill = async (tId, opening) => {
      if (!onIssueTill) { setAssigning(false); return { ok: true }; }
      const result = await onIssueTill(tId, opening);
      if (result && result.ok === false) return result;
      setAssigning(false);
      return { ok: true };
    };
    const doSettle = (shift, counted) => {
      let varCad = 0;
      Object.keys(shift.opening || {}).forEach(c => { varCad += cadVal((+counted[c] || 0) - expectedFor(shift, c), c); });
      setShifts(list => list.map(s => s.id === shift.id ? { ...s, status: 'settled', counted: { ...counted }, varCad: Math.round(varCad), settledAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', ''), settledBy: me.name } : s));
      log && log('Shift settled', `${shift.teller} · ${Math.abs(varCad) < 0.5 ? 'balanced' : (varCad > 0 ? '+' : '') + fmt(varCad, 'CAD')} variance`);
      setSettling(null);
    };
    const toggleFc = (c) => {
      if (c === 'CAD') return; // base currency always active
      const cur = fc.slice();
      const next = cur.includes(c) ? cur.filter(x => x !== c) : [...cur, c];
      setSettings(s => ({ ...s, floatCcys: next.length ? next : ['CAD'] }));
    };

    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Assign money — to a person or a till</div><div className="text-[11px]" style={{ color: CD.mute }}>To a <b>person</b>: a shift float — accountability, settled at close, variance lands on the name. To a <b>till</b>: cash physically moves vault → drawer on the rail, recorded in History.</div></div>
        <button onClick={() => setAssigning(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="userplus" s={15} c="var(--cd-on-ink)" /> Assign</button>
      </div>

      {/* active float currencies — a setting (Tel Aviv shop sets its own) */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Active float currencies</span>
        {ccyChoices.map(c => { const on = fc.includes(c); const locked = c === 'CAD'; return (
          <button key={c} onClick={() => toggleFc(c)} disabled={locked} title={locked ? 'Base currency — always active' : (on ? 'Active' : 'Inactive')} className="px-2 py-1 text-[11px]" style={{ borderRadius: 7, border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.faint, fontFamily: 'Space Mono, monospace', cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.85 : 1 }}>{c}</button>); })}
      </div>

      {open.length > 0 && <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>On the floor now</div>
        <div className="grid sm:grid-cols-2 gap-2">
          {open.map(s => { const floatCad = Object.keys(s.opening || {}).reduce((t, c) => t + cadVal(s.opening[c] || 0, c), 0); return (
            <div key={s.id} className="p-3 flex items-center justify-between" style={{ background: CD.panel, border: `1px solid ${CD.ink}`, borderRadius: 12 }}>
              <div>
                <div className="flex items-center gap-2"><span className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: '50%', background: CD.ink, color: 'var(--cd-on-ink)', fontFamily: 'Space Mono', fontSize: 11 }}>{s.teller.split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2)}</span><div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{s.teller}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>since {(s.openedAt || '').slice(-5)}</div></div></div>
                <div className="text-[11px] mt-1.5" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>float {fmt(floatCad, 'CAD')}</div>
              </div>
              <button onClick={() => setSettling(s)} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="checkcircle" s={14} /> Settle</button>
            </div>); })}
        </div>
      </div>}

      <div className="p-3 mb-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
        <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Variance by person · settled shifts</div>
        <div className="grid sm:grid-cols-3 gap-2">
          {byPerson.map(p => (<div key={p.teller} className="flex items-center justify-between px-3 py-2" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
            <div><div className="text-[12.5px] font-medium" style={{ color: CD.ink }}>{p.teller}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>{p.shifts} shift{p.shifts === 1 ? '' : 's'}</div></div>
            <div className="text-right"><div className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono, monospace', color: p.abs < 1 ? CD.green : p.abs < 30 ? CD.amber : CD.flag }}>{p.net >= 0 ? '+' : ''}{num(p.net)}</div><div className="text-[9.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>±{num(p.abs)} abs</div></div>
          </div>))}
          {!byPerson.length && <div className="text-[12px] col-span-3 text-center py-3" style={{ color: CD.faint }}>No settled shifts yet.</div>}
        </div>
      </div>

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Date</th><th className="px-3 py-2">Teller</th><th className="px-3 py-2 text-right">Float · CAD</th><th className="px-3 py-2 text-right">Variance</th><th className="px-3 py-2">Count</th>
          </tr></thead>
          <tbody>{settled.slice(0, 30).map(s => { const floatCad = Object.keys(s.opening || {}).reduce((t, c) => t + cadVal(s.opening[c] || 0, c), 0); const off = Math.abs(+s.varCad || 0) >= 0.5; return (
            <tr key={s.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <td className="px-3 py-2 font-medium" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{s.date}{s.date === businessDate() && <span className="ml-2 text-[9px] px-1.5 py-0.5" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 4, fontFamily: 'Space Mono' }}>TODAY</span>}</td>
              <td className="px-3 py-2" style={{ color: CD.ink }}>{s.teller}</td>
              <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono, monospace', color: CD.mute }}>{num(Math.round(floatCad))}</td>
              <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono, monospace', color: off ? (s.varCad > 0 ? CD.amber : CD.flag) : CD.green }}>{off ? (s.varCad > 0 ? '+' : '') + num(s.varCad) : '✓ 0'}</td>
              <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 4, color: CD.mute, fontFamily: 'Space Mono' }}>{s.blind ? 'blind' : 'open'}</span></td>
            </tr>); })}</tbody>
        </table>
      </div>

      {assigning && <AssignModal tellers={tellers} tills={tills} branchCode={myB && myB.code} fc={fc} vaultTracked={!!vaultRows} vaultAvailOf={vaultAvailOf} onClose={() => setAssigning(false)} onAssign={doAssign} onIssueTill={doIssueTill} />}
      {settling && <SettleModal shift={settling} expectedFor={expectedFor} onClose={() => setSettling(null)} onSettle={doSettle} />}
    </div>);
  }

  /* ===================== THE OPENING POSITION =====================
     Stated once, by a person who has counted the safe. From then on the
     figure only moves through a recorded movement — which is the whole
     reason the ledger can refuse a float the vault cannot cover. */
  function OpeningPositionModal({ fc, onClose, onSave }) {
    const [amounts, setAmounts] = useState(() => Object.fromEntries(fc.map(c => [c, ''])));
    const [err, setErr] = useState('');
    const [saving, setSaving] = useState(false);
    const entered = fc.filter(c => String(amounts[c] ?? '').trim() !== '' && +amounts[c] >= 0);
    const totalCad = entered.reduce((t, c) => t + cadVal(+amounts[c] || 0, c), 0);
    const submit = async () => {
      if (!entered.length || saving) return;
      setSaving(true); setErr('');
      try {
        const result = await onSave(Object.fromEntries(entered.map(c => [c, (+amounts[c] || 0).toFixed(2)])));
        if (result && result.ok === false) setErr(result.message || 'That opening position was refused.');
        else onClose();
      } catch (e) {
        setErr((e && e.message) || 'That opening position was refused.');
      } finally { setSaving(false); }
    };
    return (<Modal onClose={onClose} icon="vaultsafe" title="What’s in the safe" sub="Counted once, to put this vault on the ledger. Everything after this is a recorded movement.">
      <div className="grid grid-cols-2 gap-2 mb-3">
        {fc.map(c => (<div key={c}>
          <div className="flex items-center" style={{ border: `1px solid ${CD.line}`, borderRadius: 9 }}>
            <span className="px-2.5 text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono', borderRight: `1px solid ${CD.line}` }}>{flagOf(c)} {c}</span>
            <input type="number" value={amounts[c] ?? ''} onChange={e => setAmounts(o => ({ ...o, [c]: e.target.value }))} placeholder="0" className="flex-1 min-w-0 px-2.5 py-2 text-right outline-none" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
          </div>
        </div>))}
      </div>
      <div className="text-[11px] px-3 py-2 mb-3" style={{ background: 'var(--cd-chip)', borderRadius: 8, color: CD.mute }}>Leave a currency blank if the safe holds none of it — only what you type is recorded, and a currency you leave out stays absent from the book rather than being set to zero. This can only be set once; after that, corrections are movements, so the trail stays honest.</div>
      {/* An opening position states a QUANTITY. What that cash cost is a
          separate question, and one this desk may genuinely not be able to
          answer — the safe can predate the software. Saying so here is
          better than the P&L tab silently reading "—" next week with no
          explanation of why. The ledger accepts a unit cost alongside these
          balances; wiring the field is tracked work. */}
      <div className="text-[11px] px-3 py-2 mb-3 flex items-start gap-1.5" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 8 }}><Ic n="info" s={13} c={CD.brass} /><span>This records how much is in the safe, not what it cost. Until a priced delivery arrives, the Position tab will show these currencies with no average cost and no unrealized P&L — which is the truth, not a gap.</span></div>
      {err && <div className="flex items-start gap-2 text-[11.5px] px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="alert" s={13} c={CD.flag} /><span>{err}</span></div>}
      <div className="flex items-center justify-between pt-1">
        <div className="text-[12px]" style={{ color: CD.mute }}>Opening value <b style={{ color: CD.ink, fontFamily: 'Space Mono' }}>{fmt(totalCad, 'CAD')}</b></div>
        <button disabled={!entered.length || saving} onClick={submit} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: entered.length ? CD.ink : CD.faint, borderRadius: 9, cursor: !entered.length ? 'not-allowed' : saving ? 'wait' : 'pointer' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> {saving ? 'Recording…' : 'Put the vault on the ledger'}</button>
      </div>
    </Modal>);
  }

  /* ONE MODAL, ONE SAFE, ONE NUMBER PER CURRENCY.

     Both tabs read `vaultAvailOf`, which is the ledger's vault row and
     nothing else. It answers null for a currency the vault has no row
     for, and null is rendered "—", never 0: the modal used to print
     "vault holds 8,000" on the row while a red bar two lines below read
     "The vault holds 0.00 GBP — this movement would overdraw it".

     The float amounts start EMPTY. They used to be pre-filled with 5,000
     CAD and 2,000 USD, which is somebody else's opening float and reads
     as a recommendation from the software about a drawer it knows
     nothing about. */
  function AssignModal({ tellers, tills, branchCode, fc, vaultTracked, vaultAvailOf, onClose, onAssign, onIssueTill }) {
    const [target, setTarget] = useState('person');   // 'person' = accountability · 'till' = cash moves on the rail
    const [teller, setTeller] = useState(tellers[0] ? tellers[0].name : '');
    const [tillId, setTillId] = useState(tills && tills[0] ? tills[0].id : '');
    const [opening, setOpening] = useState(() => Object.fromEntries(fc.map(c => [c, ''])));
    const floatCad = fc.reduce((t, c) => t + cadVal(+opening[c] || 0, c), 0);
    /* Short only where the ledger has a figure to be short against. A
       currency it cannot answer for blocks the movement separately below
       — refusing is right, but calling it "short" would imply the safe
       was counted and came up empty. */
    const short = fc.filter(c => { const have = vaultAvailOf(c); return have != null && (+opening[c] || 0) > have; });
    const unknown = fc.filter(c => (+opening[c] || 0) > 0 && vaultAvailOf(c) == null);
    const tillOk = target !== 'till' || !!tillId;
    const valid = tillOk && (target === 'till' || !!teller) && short.length === 0 && unknown.length === 0 && floatCad > 0;
    const [issueErr, setIssueErr] = useState('');
    const [issuing, setIssuing] = useState(false);
    const submit = async () => {
      if (!valid || issuing) return;
      if (target !== 'till') { onAssign(teller, opening); return; }
      setIssuing(true); setIssueErr('');
      try {
        const result = await onIssueTill(tillId, opening);
        if (result && result.ok === false) setIssueErr(result.message || 'That float was refused.');
      } catch (e) {
        setIssueErr((e && e.message) || 'That float was refused.');
      } finally { setIssuing(false); }
    };
    return (<Modal onClose={onClose} icon="userplus" title="Assign money" sub={target === 'person' ? 'A shift float on a named teller — accountability only, holdings don’t move.' : `Cash physically moves ${branchCode || 'this branch'} Vault → the drawer — recorded on the rail.`}>
      {/* who gets it — a person (accountability) or a till (cash moves) */}
      <div className="grid grid-cols-2 gap-1.5 mb-3">
        {[['person', 'To a person', 'Shift float · settled at close'], ['till', 'To a till', 'Vault → drawer · moves cash']].map(([id, label, sub]) => { const on = target === id; return (
          <button key={id} onClick={() => setTarget(id)} className="px-3 py-2 text-left" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', borderRadius: 10, cursor: 'pointer' }}>
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: on ? 'var(--cd-on-ink)' : CD.ink }}><Ic n={id === 'person' ? 'users' : 'wallet'} s={13} c={on ? 'var(--cd-on-ink)' : CD.mute} />{label}</span>
            <span className="block text-[9.5px] mt-0.5" style={{ color: on ? 'var(--cd-on-ink)' : CD.faint, fontFamily: 'Space Mono, monospace', opacity: on ? 0.75 : 1 }}>{sub}</span>
          </button>); })}
      </div>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{target === 'person' ? 'Teller' : 'Till · ' + (branchCode || '')}</div>
        {target === 'person'
          ? <div className="flex flex-wrap gap-1.5">{tellers.map(t => <button key={t.name} onClick={() => setTeller(t.name)} className="px-3 py-1.5 text-[12px]" style={{ borderRadius: 8, border: `1px solid ${teller === t.name ? CD.ink : CD.line}`, background: teller === t.name ? CD.ink : 'transparent', color: teller === t.name ? 'var(--cd-on-ink)' : CD.mute }}>{t.name}</button>)}</div>
          : <div className="flex flex-wrap gap-1.5">{(tills || []).map(t => <button key={t.id} onClick={() => setTillId(t.id)} className="px-3 py-1.5 text-[12px]" style={{ borderRadius: 8, border: `1px solid ${tillId === t.id ? CD.ink : CD.line}`, background: tillId === t.id ? CD.ink : 'transparent', color: tillId === t.id ? 'var(--cd-on-ink)' : CD.mute }}>{t.name.replace(/\s+—.*/, '')}{t.operator ? ' · ' + t.operator : ''}</button>)}{!(tills || []).length && <span className="text-[11px]" style={{ color: CD.faint }}>No open tills at this branch.</span>}</div>}
      </div>
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{target === 'person' ? 'Opening float' : 'Amounts · from the vault'}</div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {fc.map(c => (<div key={c}>
          <div className="flex items-center" style={{ border: `1px solid ${short.includes(c) ? CD.flag : CD.line}`, borderRadius: 9 }}>
            <span className="px-2.5 text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono', borderRight: `1px solid ${CD.line}` }}>{flagOf(c)} {c}</span>
            <input type="number" value={opening[c] ?? ''} onChange={e => setOpening(o => ({ ...o, [c]: e.target.value }))} placeholder="0" className="flex-1 min-w-0 px-2.5 py-2 text-right outline-none" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
          </div>
          <div className="text-[9px] text-right mt-0.5 pr-1" style={{ color: short.includes(c) ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>vault holds {vaultAvailOf(c) == null ? '—' : num(vaultAvailOf(c))}</div>
        </div>))}
      </div>
      {short.length > 0 && <div className="text-[11px] px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>The vault is short on {short.join(', ')} — reduce the amount or replenish first.</div>}
      {unknown.length > 0 && <div className="text-[11px] px-3 py-2 mb-3" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 8 }}>{vaultTracked ? `This vault has no ${unknown.join(', ')} on the ledger, so nothing can be issued from it. Record a delivery first.` : 'This vault has no opening position on the ledger yet — count the safe and record it before moving cash out of it.'}</div>}
      {issueErr && <div className="flex items-start gap-2 text-[11.5px] px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}><Ic n="alert" s={13} c={CD.flag} /><span>{issueErr}</span></div>}
      <div className="flex items-center justify-between pt-1">
        <div className="text-[12px]" style={{ color: CD.mute }}>{target === 'person' ? 'Float value ' : 'Moving '}<b style={{ color: CD.ink, fontFamily: 'Space Mono' }}>{fmt(floatCad, 'CAD')}</b></div>
        <button disabled={!valid || issuing} onClick={submit} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: !valid ? CD.faint : CD.ink, borderRadius: 9, cursor: !valid ? 'not-allowed' : issuing ? 'wait' : 'pointer' }}><Ic n="arrowright" s={15} c="var(--cd-on-ink)" /> {issuing ? 'Issuing…' : target === 'person' ? 'Assign to desk' : 'Issue to till'}</button>
      </div>
    </Modal>);
  }

  /* settle modal — BLIND COUNT: expected/variance hidden until the count is locked */
  function SettleModal({ shift, expectedFor, onClose, onSettle }) {
    const ccys = Object.keys(shift.opening || {});
    const [counted, setCounted] = useState(() => Object.fromEntries(ccys.map(c => [c, ''])));
    const [locked, setLocked] = useState(false);
    const anyEntered = ccys.some(c => counted[c] !== '' && counted[c] != null);
    const varCad = ccys.reduce((t, c) => t + cadVal((+counted[c] || 0) - expectedFor(shift, c), c), 0);
    const off = Math.abs(varCad) >= 0.5;
    return (<Modal onClose={onClose} icon="checkcircle" title={`Settle ${shift.teller}'s drawer`} sub="Blind count — enter what you physically counted, then lock to reveal the variance.">
      <div className="grid grid-cols-2 gap-2 mb-3">
        {ccys.map(c => { const exp = expectedFor(shift, c); const cnt = +counted[c] || 0; const d = cnt - exp; return (
          <div key={c} style={{ border: `1px solid ${CD.line}`, borderRadius: 9, padding: '8px 10px' }}>
            <div className="flex items-center justify-between mb-1"><span className="text-[12px]" style={{ color: CD.mute, fontFamily: 'Space Mono' }}>{flagOf(c)} {c}</span>
              {locked ? <span className="text-[10.5px]" style={{ fontFamily: 'Space Mono', color: Math.abs(d) < 0.005 ? CD.green : (d > 0 ? CD.amber : CD.flag) }}>{Math.abs(d) < 0.005 ? '✓' : (d > 0 ? '+' : '') + num(d)}</span> : <span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>expected hidden</span>}
            </div>
            <input type="number" value={counted[c] ?? ''} disabled={locked} onChange={e => setCounted(o => ({ ...o, [c]: e.target.value }))} placeholder="count…" className="w-full px-2 py-1.5 text-right outline-none" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 7, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', background: locked ? '#f7f6f3' : 'var(--cd-panel)' }} />
            {locked && <div className="text-[10px] mt-1 text-right" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>exp {num(exp)}</div>}
          </div>); })}
      </div>
      {!locked ? (
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px]" style={{ color: CD.faint }}>You can't see the expected figures until you lock.</span>
          <button disabled={!anyEntered} onClick={() => setLocked(true)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: anyEntered ? CD.ink : CD.faint, borderRadius: 9, cursor: anyEntered ? 'pointer' : 'not-allowed' }}><Ic n="lock" s={14} c="var(--cd-on-ink)" /> Lock count</button>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between px-3 py-2.5 mb-3" style={{ background: off ? CD.flagSoft : CD.greenSoft, borderRadius: 10 }}>
            <span className="text-[12px] font-medium" style={{ color: off ? CD.flag : '#1c5c3a' }}>{off ? 'Drawer is off' : 'Drawer balanced'}</span>
            <span className="text-[16px] font-bold" style={{ fontFamily: 'Space Mono', color: off ? CD.flag : '#1c5c3a' }}>{off ? (varCad > 0 ? '+' : '') + fmt(varCad, 'CAD') : '✓ 0.00'}</span>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setLocked(false)} className="text-[12px] px-3 py-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>← Recount</button>
            <button onClick={() => onSettle(shift, counted)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="checkcircle" s={15} c="var(--cd-on-ink)" /> Settle on {shift.teller.split(' ').slice(-1)[0]}</button>
          </div>
        </div>
      )}
    </Modal>);
  }

  /* ===================== ORDERS (on order → received) ===================== */
  // Creating an order is the header's job (one entry point). Low balances are
  // notifications, not cards here. This tab just lists orders: what's on the way,
  // and what's landed.
  function Orders({ receipts, pending, onOrder, onCancel }) {
    const received = (receipts || []).filter(o => o.status === 'received').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    return (<div className="p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold" style={{ color: CD.ink }}>Orders</div>
        <div className="text-[11px]" style={{ color: CD.mute }}>Place an order with <b>Order</b> up top; mark it received when the cash lands — that's what lifts inventory and re-weights cost basis. Low balances arrive as notifications.</div>
      </div>

      {/* on order — pending, awaiting delivery */}
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>On order · awaiting delivery</div>
      {pending.length > 0 ? <div className="grid sm:grid-cols-2 gap-2 mb-4">
        {pending.map(o => (<div key={o.id} className="p-3 flex items-center justify-between" style={{ background: CD.panel, border: `1px dashed ${CD.amber}`, borderRadius: 12 }}>
          <div>
            <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{flagOf(o.ccy)} {num(o.units)} {o.ccy}</div>
            <div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{o.supplier} · placed {o.date}</div>
          </div>
          <div className="flex items-center gap-1.5 flex-none">
            <button onClick={() => onCancel(o.id)} title="Cancel this order" className="px-2.5 py-2 text-[12px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute }}>Cancel</button>
            <button onClick={() => onOrder({ order: o })} className="px-3 py-2 text-[12px] font-semibold text-white flex items-center gap-1.5" style={{ background: CD.green, borderRadius: 8 }}><Ic n="checkcircle" s={14} c="var(--cd-on-ink)" /> Mark received</button>
          </div>
        </div>))}
      </div> : <div className="text-[12px] px-3 py-3 mb-4" style={{ background: 'var(--cd-chip)', color: CD.mute, borderRadius: 10 }}>No open orders. Place one with the <b>Order</b> button above.</div>}

      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Received</div>
      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Ref</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">Units</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">CAD paid</th><th className="px-3 py-2">Supplier</th>
          </tr></thead>
          <tbody>{received.map(o => (<tr key={o.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2 font-medium" style={{ color: CD.ink, fontFamily: 'Space Mono', fontSize: 11.5 }}>{o.ref}</td>
            <td className="px-3 py-2" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{o.date}</td>
            <td className="px-3 py-2" style={{ color: CD.ink }}>{flagOf(o.ccy)} {o.ccy}</td>
            <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(o.units)}</td>
            <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{(o.unitCost || 0).toFixed((o.unitCost || 0) < 0.1 ? 5 : 4)}</td>
            <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(o.costCad || 0))}</td>
            <td className="px-3 py-2 text-[11.5px]" style={{ color: CD.mute }}>{o.supplier}</td>
          </tr>))}
          {!received.length && <tr><td colSpan={7} className="px-3 py-5 text-center text-[12px]" style={{ color: CD.faint }}>No received orders yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>);
  }

  /* one modal, two outcomes: Place order (pending) or Order received (posts).
     Placing is optional — you can record a received order directly. */
  function OrderModal({ init, onClose, onPlace, onReceive }) {
    const src = (init && init.order) || null;     // receiving an existing pending order
    const receiveOnly = !!src;
    const [ccy, setCcy] = useState((src && src.ccy) || (init && init.ccy) || 'USD');
    const [units, setUnits] = useState((src && src.units) ? String(Math.round(src.units)) : (init && init.units) ? String(Math.round(init.units)) : '');
    const [costCad, setCostCad] = useState('');
    const [supplier, setSupplier] = useState((src && src.supplier) || 'Bank of Montreal — Wholesale Notes');
    const [receiveNow, setReceiveNow] = useState(false);   // "cash already in hand" — opt in
    const [done, setDone] = useState(false);               // green-confirm latch (also blocks double-click)
    const u = +units || 0, cc = +costCad || 0;
    const unitCost = u ? cc / u : 0;
    const mkt = cadPer(ccy);
    const suggestCost = u ? Math.round(u * mkt * 0.999) : 0;
    // ONE action at a time: placing (default) OR receiving. Never two adjacent buttons.
    const receiving = receiveOnly || receiveNow;
    const ready = receiving ? (u > 0 && cc > 0) : (u > 0);
    // press → flash green + lock, then commit a beat later so the confirm is seen
    const fire = () => {
      if (done || !ready) return;
      setDone(true);
      setTimeout(() => {
        if (receiving) onReceive({ id: src ? src.id : null, ccy, units: u, costCad: cc, supplier });
        else onPlace({ ccy, units: u, supplier });
      }, 480);
    };
    return (<Modal onClose={done ? undefined : onClose} icon={receiving ? 'checkcircle' : 'plus'} title={receiveOnly ? 'Receive order' : 'New banknote order'} sub={receiveOnly ? 'Confirm what arrived and what you paid — this posts the cash into inventory.' : 'Record a wholesale order. You’ll mark it received when the cash arrives.'}>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Currency</div>
        <div className="flex flex-wrap gap-1.5">{ORDER_CCYS.filter(c => c !== 'CAD').map(c => <button key={c} disabled={receiveOnly} onClick={() => setCcy(c)} className="px-2.5 py-1.5 text-[12px]" style={{ borderRadius: 8, border: `1px solid ${ccy === c ? CD.ink : CD.line}`, background: ccy === c ? CD.ink : 'transparent', color: ccy === c ? 'var(--cd-on-ink)' : CD.mute, fontFamily: 'Space Mono', cursor: receiveOnly ? 'default' : 'pointer', opacity: receiveOnly && ccy !== c ? 0.4 : 1 }}>{flagOf(c)} {c}</button>)}</div>
      </div>
      <div className={receiving ? 'grid grid-cols-2 gap-2 mb-3' : 'mb-3'}>
        <div>
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Units</div>
          <input type="number" autoFocus={!receiveOnly} value={units} onChange={e => setUnits(e.target.value)} placeholder="0" className="w-full px-3 py-2 text-right outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
        </div>
        {receiving && <div>
          <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>CAD paid</div>
          <input type="number" autoFocus={receiveOnly} value={costCad} onChange={e => setCostCad(e.target.value)} placeholder={suggestCost ? String(suggestCost) : '0'} className="w-full px-3 py-2 text-right outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }} />
        </div>}
      </div>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Supplier</div>
        <input value={supplier} onChange={e => setSupplier(e.target.value)} className="w-full px-3 py-2 outline-none text-[13px]" style={{ border: `1px solid ${CD.line}`, borderRadius: 9 }} />
      </div>
      {receiving && cc > 0 && <div className="flex items-center justify-between px-3 py-2 mb-3" style={{ background: 'var(--cd-chip)', borderRadius: 9 }}>
        <span className="text-[11.5px]" style={{ color: CD.mute }}>Effective unit cost</span>
        <span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink }}>{unitCost ? unitCost.toFixed(unitCost < 0.1 ? 5 : 4) : '—'} {unitCost ? <span className="text-[10px] font-normal" style={{ color: cc > u * mkt ? CD.flag : CD.green }}>· {cc > u * mkt ? 'above' : 'below'} market {mkt.toFixed(mkt < 0.1 ? 5 : 4)}</span> : null}</span>
      </div>}

      {/* opt-in receive — keeps the consequential action off the default path */}
      {!receiveOnly && <button onClick={() => { setReceiveNow(v => !v); if (receiveNow) setCostCad(''); }} className="w-full flex items-center gap-2.5 px-3 py-2.5 mb-3 text-left" style={{ border: `1px solid ${receiveNow ? CD.ink : CD.line}`, borderRadius: 10, background: receiveNow ? 'var(--cd-chip)' : 'transparent' }}>
        <span className="grid place-items-center flex-none" style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${receiveNow ? CD.ink : CD.faint}`, background: receiveNow ? CD.ink : 'transparent' }}>{receiveNow && <Ic n="check" s={12} c="var(--cd-on-ink)" />}</span>
        <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>Cash is already in hand — receive now</span><span className="text-[11px]" style={{ color: CD.mute }}>Posts straight to inventory instead of tracking it as on-order.</span></span>
      </button>}

      <div className="text-[10.5px] px-3 py-2 mb-3 flex items-start gap-1.5" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 8 }}><Ic n="info" s={13} c={CD.brass} /><span>Orders aren’t sent to a wholesaler from the app yet — this records the order. Receiving is what posts the cash to inventory.</span></div>

      <div className="flex items-center justify-end">
        <button disabled={!ready || done} onClick={fire} className="till-save flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white" style={{ background: done ? CD.green : (!ready ? CD.faint : CD.ink), borderRadius: 10, cursor: (!ready || done) ? 'default' : 'pointer', transition: 'background .25s ease, transform .12s ease', minWidth: 168, justifyContent: 'center' }}>
          <Ic n={done ? 'checkcircle' : (receiving ? 'checkcircle' : 'plus')} s={15} c="var(--cd-on-ink)" />
          {done ? (receiving ? 'Received' : 'Order placed') : (receiving ? 'Confirm received' : 'Place order')}
        </button>
      </div>
    </Modal>);
  }

  /* ===================== P&L (the figure the disposal wrote) =====================
     What a desk earns is the difference between what it paid for a
     currency and what it sold it for, and nothing else is profit. That
     number is decided once, by dispose(), and stored on the transaction
     — so this tab reads it rather than recomputing anything.

     What was here before computed a cost basis in the browser from a demo
     baseline, compared it against a "mid-spread estimate", and presented
     the gap between two guesses as an insight. See docs/COST_BASIS.md. */
  function PnL({ summary, loading, error, rangeLabel }) {
    if (loading) return <div className="p-8 text-center text-[12px]" style={{ color: CD.faint }}>Reading the book…</div>;
    if (error) return (<div className="p-4"><div className="flex items-start gap-2 px-3 py-2.5 text-[12px]" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 10 }}><Ic n="alert" s={14} c={CD.flag} /><span>{error}</span></div></div>);

    const home = (summary && summary.homeCurrency) || 'CAD';
    const list = ((summary && summary.byCurrency) || []).filter(r => r.deals > 0);
    const realized = summary ? summary.realizedPnlHome : null;
    const cost = summary ? summary.costOfSaleHome : null;
    const fees = summary ? summary.feesHome : null;
    const volume = summary ? summary.volumeHome : null;
    const posted = summary ? summary.posted : 0;
    const priced = summary ? summary.pricedDeals : 0;
    /* Margin is a ratio of two ledger figures, and it is only a ratio
       when both exist. A zero denominator used to render 0.00%, which
       reads as "we made nothing on a busy day" rather than "nothing has
       been posted". */
    const margin = (realized != null && volume != null && Number(volume) > 0)
      ? (Number(realized) / Number(volume)) * 100 : null;
    const why = posted === 0 ? 'nothing posted in this period' : 'no cost basis on these deals';

    return (<div className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
        <Stat big label={`Realized P&L · ${rangeLabel}`}
          value={realized == null ? <Absent why={why} size={26} /> : (Number(realized) >= 0 ? '+' : '') + fmt(realized, home)}
          sub={realized == null ? '' : `${priced} of ${posted} deal${posted === 1 ? '' : 's'} costed`}
          tone={realized == null ? CD.faint : Number(realized) >= 0 ? CD.green : CD.flag} />
        <Stat label="Cost of what was sold"
          value={cost == null ? <Absent why={why} size={19} /> : fmt(cost, home)}
          sub="what the notes actually cost" />
        <Stat label="Commission"
          value={fees == null ? <Absent why="nothing posted in this period" size={19} /> : fmt(fees, home)}
          sub="fees charged" />
        <Stat label="Margin on volume"
          value={margin == null ? <Absent why={why} size={19} /> : margin.toFixed(2) + '%'}
          sub={volume == null ? '' : `on ${fmt(volume, home)} taken in`} />
      </div>

      <div className="p-3 mb-3" style={{ background: CD.brassSoft, borderRadius: 12 }}>
        <div className="flex items-start gap-2">
          <Ic n="info" s={15} c={CD.brass} />
          <p className="text-[11.5px]" style={{ color: 'var(--cd-brass-text)' }}>Every figure here is the one the sale itself booked — proceeds minus what those notes cost, decided at the moment of the disposal and stored on the transaction. It is not a spread against a market mid, and nothing on this screen recomputes it. {priced < posted && posted > 0 ? `${posted - priced} deal${posted - priced === 1 ? '' : 's'} in this period carr${posted - priced === 1 ? 'ies' : 'y'} no cost basis and ${posted - priced === 1 ? 'is' : 'are'} left out of the profit above.` : ''}</p>
        </div>
      </div>

      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 12 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
            <th className="px-3 py-2">Currency sold</th><th className="px-3 py-2 text-right">Deals</th><th className="px-3 py-2 text-right">Units out</th><th className="px-3 py-2 text-right">Costed</th><th className="px-3 py-2 text-right">Realized P&L</th>
          </tr></thead>
          <tbody>{list.map(r => (<tr key={r.currency} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
            <td className="px-3 py-2.5 font-medium" style={{ color: CD.ink }}>{flagOf(r.currency)} {r.currency}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono', color: CD.mute }}>{r.deals}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(Math.round(Number(r.sold)))}</td>
            <td className="px-3 py-2.5 text-right text-[12px]" style={{ fontFamily: 'Space Mono', color: r.pricedDeals < r.deals ? CD.amber : CD.mute }}>{r.pricedDeals}/{r.deals}</td>
            <td className="px-3 py-2.5 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: r.realizedPnlHome == null ? CD.faint : Number(r.realizedPnlHome) >= 0 ? CD.green : CD.flag }}>{r.realizedPnlHome == null ? '—' : (Number(r.realizedPnlHome) >= 0 ? '+' : '') + num(Math.round(Number(r.realizedPnlHome)))}</td>
          </tr>))}
          {!list.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-[12px]" style={{ color: CD.faint }}>No foreign currency has left this till in {rangeLabel.toLowerCase()}.</td></tr>}
          </tbody>
          {list.length > 0 && <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
            <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total</td><td></td><td></td><td></td>
            <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: realized == null ? CD.faint : Number(realized) >= 0 ? CD.green : CD.flag }}>{realized == null ? '—' : (Number(realized) >= 0 ? '+' : '') + num(Math.round(Number(realized)))}</td>
          </tr></tfoot>}
        </table>
      </div>
    </div>);
  }

  /* ===================== shared modal shell ===================== */
  function Modal({ icon, title, sub, children, onClose }) {
    return (<div style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(24,21,17,0.46)', display: 'grid', placeItems: 'center', padding: 20 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="flex flex-col" style={{ width: 'min(560px, 100%)', maxHeight: '100%', background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 16, boxShadow: '0 24px 60px rgba(0,0,0,0.30)', overflow: 'hidden' }}>
        <div className="px-5 pt-4 pb-3 flex items-start gap-3 flex-none" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, background: CD.ink, borderRadius: 9 }}><Ic n={icon} s={16} c="var(--cd-on-ink)" /></span>
          <div className="flex-1"><div className="text-[15px] font-semibold" style={{ color: CD.ink }}>{title}</div>{sub && <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{sub}</div>}</div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 7, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>
        <div className="overflow-auto px-5 py-4" style={{ flex: 1 }}>{children}</div>
      </div>
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Vault({ rows, me, log, baseline, receipts, setReceipts, settings, setSettings, branches, station, onMoveCash, onOpenBranches, moves, onOrderReceived, onIssueTill, serverBacked, vaultTracked, onOpenVaultPosition, cashVersion }) {
    const [tab, setTab] = useState('position');
    const [shifts, setShifts] = useState(loadShifts);
    const [ordering, setOrdering] = useState(null);   // null | { ccy?, units?, order? }
    const [notifOpen, setNotifOpen] = useState(false);
    const [openingVault, setOpeningVault] = useState(false);   // stating what is in the safe
    /* THE STRONG ROOM, READ FROM THE BOOK.

       This used to read `branches[].vault` — a record the OS mirrors the
       ledger onto — and fall back to a figure derived here from the
       browser's transactions when the ledger had no row. Two problems, and
       both were live: the mirror is a MERGE, so recording an opening
       position for CAD/USD/EUR left the branch record's pre-existing demo
       INR, PHP, CNY and GBP standing beside the three real ones under a
       header reading "on the ledger"; and the fallback meant a vault the
       ledger knew nothing about still showed a confident total.

       Asking the server directly fixes both at once. What is not here is
       not shown. */
    const deskFacts = useDeskFacts();   // the trading day, from the till session
    const { data: position, loading: posLoading, error: posError } = useLedgerPosition(serverBacked, cashVersion);
    const ledgerRows = vaultRowsOf(position);
    const onLedger = !!ledgerRows;
    useEffect(() => { try { localStorage.setItem(SKEY, JSON.stringify(shifts)); } catch (e) {} }, [shifts]);

    /* The desk's earnings over the trading day this till is in. The window
       comes from the till session's own business date — see the note on
       businessDate() in cdos-base.jsx. */
    const [summary, setSummary] = useState({ loading: true, data: null, error: '' });
    useEffect(() => {
      if (!serverBacked || !window.CDOS.Backend) { setSummary({ loading: false, data: null, error: 'This desk is not signed in to the ledger.' }); return; }
      let live = true;
      window.CDOS.refreshBusinessDate()
        .then(() => window.CDOS.Backend.loadLedgerSummary(window.CDOS.businessDayWindow(30)))
        .then(data => { if (live) setSummary({ loading: false, data, error: '' }); })
        .catch(error => { if (live) setSummary({ loading: false, data: null, error: (error && error.message) || 'The ledger could not be reached.' }); });
      return () => { live = false; };
    }, [serverBacked, cashVersion]);

    const totalOnHand = position && position.vaultTotals ? position.vaultTotals.marketValueHome : null;
    // low-stock notifications honour Settings → Vault: the alert switch + the
    // owner's floors, and they are raised only for currencies the safe
    // actually has a ledger row for — a floor cannot be breached by a
    // currency nobody has told the book about.
    const lowAlert = !settings || settings.vaultLowAlert !== false;
    const lowList = !lowAlert || !ledgerRows ? [] : ledgerRows.map(r => { const units = Number(r.quantity); const min = floorOf(r.c, settings); const b = BANDS[r.c] || {}; if (!min || units >= min) return null; return { c: r.c, units, need: Math.max((b.target || min * 2) - units, 0) }; }).filter(Boolean);
    const pending = (receipts || []).filter(o => o.status === 'pending').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const onOrderCcys = new Set(pending.map(o => o.ccy));
    const notifs = [
      ...lowList.filter(s => !onOrderCcys.has(s.c)).map(s => ({ type: 'low', c: s.c, units: s.units, need: s.need })),
      ...pending.map(o => ({ type: 'pending', order: o }))
    ];
    const openShifts = shifts.filter(s => s.status === 'open').length;
    // station context — which branch's vault this window is standing in front of
    const _ST = window.CDOS._stations || {};
    const myB = (branches || []).find(b => b.id === (station && station.branchId)) || (branches || [])[0];
    const mainB = (branches || []).find(b => b.main) || (branches || [])[0];
    const vCad = (b) => _ST.vaultCad ? _ST.vaultCad(b) : 0;

    const onOrder = (init) => { setNotifOpen(false); setOrdering(init || {}); };
    const onPlace = (p) => {
      const units = +p.units || 0; if (!units) return;
      const ord = { id: Date.now(), ccy: p.ccy, units, costCad: 0, unitCost: 0, supplier: p.supplier || 'Wholesale notes', ref: 'WO-' + businessDate().slice(2).replace(/-/g, '') + '-' + p.ccy, date: businessDate(), by: me.name, status: 'pending' };
      setReceipts(list => [ord, ...(list || [])]);
      log && log('Order placed', `${num(units)} ${p.ccy} from ${ord.supplier} — on order`);
      setOrdering(null); setTab('receive');
    };
    const onReceive = (p) => {
      const units = +p.units || 0, costCad = +p.costCad || 0; if (!units || !costCad) return;
      const unitCost = +(costCad / units).toFixed(6);
      if (p.id) {
        setReceipts(list => (list || []).map(o => o.id === p.id ? { ...o, ccy: p.ccy, units, costCad, unitCost, supplier: p.supplier, status: 'received', date: businessDate(), receivedAt: new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '') } : o));
      } else {
        const rec = { id: Date.now(), ccy: p.ccy, units, costCad, unitCost, supplier: p.supplier || 'Wholesale notes', ref: 'WO-' + businessDate().slice(2).replace(/-/g, '') + '-' + p.ccy, date: businessDate(), by: me.name, status: 'received' };
        setReceipts(list => [rec, ...(list || [])]);
      }
      log && log('Order received', `${num(units)} ${p.ccy} @ ${fmt(unitCost, 'CAD')} · ${fmt(costCad, 'CAD')} posted to inventory`);
      onOrderReceived && onOrderReceived(p.ccy, units, p.supplier || 'Wholesale notes');   // the notes physically land in THIS branch's vault
      setOrdering(null); setTab('receive');
    };
    const onCancel = (id) => { setReceipts(list => (list || []).filter(o => o.id !== id)); log && log('Order cancelled', 'Pending banknote order removed'); };

    const TABS = [['position', 'Position', 'pie'], ['shifts', 'Floats', 'users'], ['receive', 'Orders', 'arrowdown'], ['history', 'History', 'clock'], ['pnl', 'P&L', 'trendup']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper, position: 'relative' }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="vaultsafe" s={17} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight flex items-center gap-2" style={{ color: CD.ink }}>Vault{myB ? <span className="text-[12px] font-normal" style={{ color: CD.mute }}>· {myB.name}</span> : null}{myB && <span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ background: myB.main ? CD.ink : CD.brassSoft, color: myB.main ? 'var(--cd-on-ink)' : 'var(--cd-brass-text, ' + CD.brass + ')', borderRadius: 4, letterSpacing: '0.06em' }}>{myB.main ? 'MAIN VAULT' : 'SUB-VAULT'}</span>}</div><div className="text-[11px]" style={{ color: CD.mute }}>{totalOnHand == null ? '—' : fmt(totalOnHand, (position && position.homeCurrency) || 'CAD')} on hand{onLedger ? ' · on the ledger' : serverBacked ? ' · not on the ledger' : ''}{lowList.length ? ` · ${lowList.length} low` : ''}{openShifts ? ` · ${openShifts} float${openShifts === 1 ? '' : 's'} out` : ''}{myB && !myB.main && mainB ? ` · funded from ${mainB.code}` : ''}</div></div>
          </div>
          <div className="flex items-center gap-2" style={{ position: 'relative' }}>
            {/* notifications */}
            <button onClick={() => setNotifOpen(o => !o)} title="Notifications" className="grid place-items-center relative" style={{ width: 36, height: 36, borderRadius: 9, border: `1px solid ${notifOpen ? CD.ink : CD.line}`, background: notifOpen ? CD.ink : 'transparent', color: notifOpen ? 'var(--cd-on-ink)' : CD.ink }}>
              <Ic n="alert" s={17} c={notifOpen ? 'var(--cd-on-ink)' : CD.ink} />
              {notifs.length > 0 && <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 4px', background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 999, fontSize: 10, fontWeight: 700, fontFamily: 'Space Mono', display: 'grid', placeItems: 'center', border: '2px solid var(--cd-panel)' }}>{notifs.length}</span>}
            </button>
            <button onClick={() => onMoveCash && onMoveCash({ kind: 'issue', bId: myB && myB.id })} title="Vault → till · till → vault · vault → vault" className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'transparent' }}><Ic n="swap" s={15} c={CD.ink} /> Move cash</button>
            <button onClick={() => onOrder({})} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> Order</button>
            {notifOpen && (<>
              <div onClick={() => setNotifOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }}></div>
              <div style={{ position: 'absolute', top: 44, right: 0, width: 320, maxHeight: 360, overflow: 'auto', background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 12, boxShadow: '0 18px 44px rgba(0,0,0,0.22)', zIndex: 41 }}>
                <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.line}` }}><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Notifications</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: 'var(--cd-chip)', color: CD.mute, borderRadius: 999, fontFamily: 'Space Mono' }}>{notifs.length}</span></div>
                {notifs.length === 0 ? <div className="px-3.5 py-6 text-center text-[12px]" style={{ color: CD.faint }}>All caught up — nothing needs attention.</div> :
                  notifs.map((n, i) => n.type === 'low' ? (
                    <button key={'l' + n.c} onClick={() => onOrder({ ccy: n.c, units: n.need })} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                      <span className="grid place-items-center flex-none mt-0.5" style={{ width: 26, height: 26, borderRadius: 7, background: CD.flagSoft }}><Ic n="alert" s={14} c={CD.flag} /></span>
                      <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>{flagOf(n.c)} {n.c} is low</span><span className="text-[11px]" style={{ color: CD.mute }}>{num(Math.round(n.units))} on hand · tap to order</span></span>
                      <Ic n="arrowright" s={14} c={CD.faint} />
                    </button>
                  ) : (
                    <button key={'p' + n.order.id} onClick={() => onOrder({ order: n.order })} className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                      <span className="grid place-items-center flex-none mt-0.5" style={{ width: 26, height: 26, borderRadius: 7, background: CD.amberSoft }}><Ic n="clock" s={14} c={CD.amber} /></span>
                      <span className="flex-1"><span className="text-[12.5px] font-medium block" style={{ color: CD.ink }}>{flagOf(n.order.ccy)} {num(n.order.units)} {n.order.ccy} on order</span><span className="text-[11px]" style={{ color: CD.mute }}>{n.order.supplier} · tap to receive</span></span>
                      <Ic n="arrowright" s={14} c={CD.faint} />
                    </button>
                  ))}
              </div>
            </>)}
          </div>
        </div>
        <div className="fld-bar" style={{ '--ft': '#17140F', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => { const badge = id === 'receive' ? notifs.length : id === 'shifts' && openShifts ? openShifts : 0; return (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: id === 'receive' ? CD.flag : CD.green, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>); })}
        </div>
      </div>

      {/* A server-backed desk whose strong room has never been declared. The
          ledger will not police what nobody has stated, so it says so plainly
          rather than quietly balancing against zero. */}
      {serverBacked && !posLoading && !onLedger && (
        <div className="flex items-center gap-3 px-4 py-2.5 flex-none" style={{ background: CD.brassSoft, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 8, background: CD.brass }}><Ic n="vaultsafe" s={15} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-[12.5px] font-semibold" style={{ color: CD.ink }}>This vault isn’t on the ledger yet</div>
            <div className="text-[11px]" style={{ color: CD.mute }}>Count the safe once and record it. After that every float, delivery and run is checked against it, and a drawer can’t be floated with money the vault doesn’t have.</div>
          </div>
          <button onClick={() => setOpeningVault(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-[12.5px] font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="check" s={14} c="var(--cd-on-ink)" /> Record what’s in the safe</button>
        </div>
      )}
      {openingVault && <OpeningPositionModal fc={DEFAULT_FC} onClose={() => setOpeningVault(false)} onSave={onOpenVaultPosition} />}

      <div className="flex-1 overflow-auto">
        {tab === 'position' && <Position position={position} loading={posLoading} error={posError} settings={settings} vaultTracked={onLedger} onRecordOpening={serverBacked ? () => setOpeningVault(true) : null} />}
        {tab === 'shifts' && <Shifts rows={rows} position={position} me={me} log={log} shifts={shifts} setShifts={setShifts} settings={settings} setSettings={setSettings} branches={branches} station={station} onIssueTill={onIssueTill} />}
        {tab === 'receive' && <Orders receipts={receipts} pending={pending} onOrder={onOrder} onCancel={onCancel} />}
        {tab === 'history' && (() => {
          const vLabel = myB ? myB.code + ' · Vault' : '';
          const vMoves = (moves || []).filter(m => m.from === vLabel || m.to === vLabel);
          const today = vMoves.filter(m => m.date === businessDate());
          const inToday = today.filter(m => m.to === vLabel).reduce((s, m) => s + (m.cadVal || 0), 0);
          const outToday = today.filter(m => m.from === vLabel).reduce((s, m) => s + (m.cadVal || 0), 0);
          const KB = { issue: 'Float issued', return: 'Cash returned', vault: 'Vault run', order: 'Order received', branch: 'Vault run' };
          return (<div className="p-4">
            <div className="grid grid-cols-3 gap-2 mb-3" style={{ maxWidth: 560 }}>
              {[['Into this vault · today', fmt(inToday, 'CAD'), CD.green], ['Out of this vault · today', fmt(outToday, 'CAD'), CD.mute], ['Net · today', (inToday - outToday >= 0 ? '+' : '') + fmt(inToday - outToday, 'CAD'), CD.ink]].map(([l, v, c]) => (
                <div key={l} className="px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[9.5px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[15px] font-bold" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
            </div>
            <div style={{ border: `1px solid ${CD.line}`, borderRadius: 11, overflow: 'hidden', background: CD.panel }}>
              {vMoves.length ? vMoves.slice(0, 30).map((m, i) => { const out = m.from === vLabel; const other = out ? m.to : m.from; return (
                <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                  <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, background: out ? CD.lineSoft : CD.greenSoft }}><Ic n={out ? 'arrowup' : 'arrowdown'} s={14} c={out ? CD.mute : CD.green} /></span>
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[12.5px]" style={{ color: CD.ink }}><b>{KB[m.kind] || 'Movement'}</b> <span style={{ color: CD.faint }}>{out ? '→' : '←'}</span> {other}</div>
                    <div className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{m.ref} · {m.date === businessDate() ? 'today' : m.date} · {m.by}</div>
                  </div>
                  <span className="flex-none text-right text-[13px] font-bold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: out ? CD.mute : CD.green }}>{out ? '−' : '+'}{num(m.amount)} {m.ccy}</span>
                </div>); }) : <div className="px-4 py-10 text-center text-[12px]" style={{ color: CD.faint }}>Nothing on the rail yet — issue a float, receive an order, or run cash between vaults.</div>}
            </div>
            <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>Every dollar in and out of this vault, recorded forever — floats to tills, returns at close, wholesale orders received, and runs to other branches. The full network view lives in <button onClick={() => onOpenBranches && onOpenBranches()} style={{ color: CD.mute, textDecoration: 'underline', border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>Branch Network</button>.</p>
          </div>);
        })()}
        {tab === 'pnl' && <PnL summary={summary.data} loading={summary.loading} error={summary.error} rangeLabel="past 30 days" />}
      </div>

      {ordering && <OrderModal init={ordering} onClose={() => setOrdering(null)} onPlace={onPlace} onReceive={onReceive} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Vault });
})();
