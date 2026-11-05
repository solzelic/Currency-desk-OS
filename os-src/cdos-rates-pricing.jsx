/* ============================================================
   CurrencyDesk OS: Rates, the Pricing & rates tab (Rates v2.5)

   A port of the design's Pricing & rates tab (handoff rates-v2.5,
   "CurrencyDesk Rates v2.5", the isRules section): the design's markup,
   copy and style strings, turned into React styles by the Rates app's
   css(), so a reviewer can hold the two side by side.

   What the desk pays and charges, in the shop's own currency:
   - Rate source: the market feed the server pulls (GET /api/rates/market).
   - Default spread, and each currency's own spread and pinned market rate
     (Settings: defaultSpread, spreads, spotOverride, the keys the Board
     reads).
   - Default commission with tiers (Settings: defaultFee, feeTiers). The
     new-deal screen fills the fee in from the deal's size
     (ratesBoard.feeFor).
   - The guardrails, summarised; they are edited on the Guardrails tab.
   - A live deal preview, priced the way the desk prices (deskPair).
   - How cost is worked out (GET/PUT /api/ledger/cost-method) and pay-out
     rounding, on plans with deals.
   Publish to Rate Board sends the board as it stands
   (POST /api/rates/publish), as the Board's Publish does.

   Who may change what is the server's rule (state/owner-settings.ts): a
   teller sees it, a manager prices, the owner also sets the cost method.
   Locked rates (Lock rates) take no changes. Where the design and the
   code differ, the code wins: prices use the desk's formula, amounts are
   in the shop's home currency, and the feed is the one the server pulls.
   ============================================================ */
(function () {
  const { useState, useEffect, useCallback } = React;
  const B = window.CDOS.ratesBoard;
  const FACE = window.CurrencyFace;

  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
  const money = (v) => Number(v).toLocaleString('en-CA', { maximumFractionDigits: 2 });

  function RatesPricing({ settings, setSettings, serverRole, me, log, onToast, onGoGuard, locked, w }) {
    const ui = window.CDOS.ratesUi;
    const { css, Flag, track, seg, fx, ago, getJson, publishRows, PUBLISHERS } = ui;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    /* The server decides; without a server role (the offline prototype)
       the desk's own role stands in. */
    const role = serverRole || (me && me.role === 'Owner' ? 'administrator' : me && me.role === 'Manager' ? 'branch_manager' : 'teller');
    const canPrice = PUBLISHERS.includes(role);
    const owns = role === 'administrator';
    const readOnly = !canPrice || !!locked;
    /* A Rates plan prices its board; deals, commission and cost come with
       Full System (the ledger refuses a Rates plan on the server). */
    const hasDeals = (settings.billingPlan || 'premium') !== 'basic';
    const defPct = settings.defaultSpread != null && settings.defaultSpread !== '' && isFinite(+settings.defaultSpread) ? +settings.defaultSpread : B.DEFAULT_SPREAD_PCT;
    const floor = settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const target = settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const wideTable = (w || 1280) >= 880;

    const [data, setData] = useState({ loading: true, board: null, market: {}, feed: null });
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    /* What is being typed, until the field is left: "5,000" stays as typed. */
    const [raw, setRaw] = useState({});
    const typed = (k, fallback) => (raw[k] != null ? raw[k] : fallback);
    const typing = (k, v) => setRaw(r => ({ ...r, [k]: v }));
    const leave = (k) => setRaw(r => { const n = { ...r }; delete n[k]; return n; });
    const [method, setMethod] = useState(null);
    const [infoOpen, setInfoOpen] = useState(false);
    const [sim, setSim] = useState({ in: home, out: '', amt: '500' });
    const [simFee, setSimFee] = useState(true);

    const load = useCallback(async () => {
      try {
        const [rates, feed] = await Promise.all([getJson('/api/rates'), getJson('/api/rates/market')]);
        setData({ loading: false, board: rates.board, market: B.homeMarket(feed.mids, home), feed });
      } catch (e) {
        setData(d => ({ ...d, loading: false }));
        setNotice('The board could not be loaded (' + e.message + '). Nothing has changed for customers.');
      }
    }, [home]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
      if (!hasDeals) return;
      getJson('/api/ledger/cost-method').then(m => setMethod(m && m.method), () => setMethod(null));
    }, [hasDeals]);

    const set = (patch, note) => { if (readOnly) return; setSettings(s => ({ ...s, ...patch })); if (note && log) log('Pricing updated', note); };
    const setOwnSpread = (code, v) => { if (readOnly) return; setSettings(s => { const sp = { ...(s.spreads || {}) }; if (v === null) delete sp[code]; else sp[code] = v; return { ...s, spreads: sp }; }); };
    const setPin = (code, v) => { if (readOnly) return; setSettings(s => { const o = { ...(s.spotOverride || {}) }; if (v === null) delete o[code]; else o[code] = v; return { ...s, spotOverride: o }; }); };

    const rows = B.draftRows({ codes: window.CDOS.CCY || [], home, board: data.board, market: data.market, settings });
    const onBoard = rows.filter(r => r.show && r.mid);
    const atPublishedMids = data.board ? rows.map(r => (!r.pinned && data.board.rows[r.code] ? { ...r, mid: Number(data.board.rows[r.code].mid) } : r)) : rows;
    const dirty = !B.sameAsPublished(atPublishedMids, data.board, defPct);
    const moved = !dirty && !B.sameAsPublished(rows, data.board, defPct);
    const pubOff = readOnly || !(dirty || moved) || busy;
    const publish = async () => {
      if (pubOff) return;
      setNotice(null);
      setBusy(true);
      try {
        const done = await publishRows(rows, defPct, { me, log });
        if (!done.ok) { setNotice(done.message); return; }
        onToast('Published · your site and window updated');
        await load();
      } finally { setBusy(false); }
    };

    /* ---- the design's pieces ---- */
    const card = 'padding:18px;border-radius:16px;background:#fff;border:1px solid var(--line);min-width:0;';
    const cardHead = 'display:flex;align-items:center;gap:9px;font-family:var(--m);font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:var(--ink);';
    const stepBtn = css('width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:18px;color:var(--ink);cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';');
    const pubBtnSm = 'flex:none;display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 15px;border:0;border-radius:11px;font-size:13px;font-weight:700;cursor:' + (pubOff ? 'default' : 'pointer') + ';background:' + (pubOff ? 'rgba(23,20,15,0.08)' : 'var(--ink)') + ';color:' + (pubOff ? 'rgba(23,20,15,0.35)' : '#fff') + ';';
    const saveLabel = dirty ? 'Saved · not published' : 'Saved · live';
    const saveChip = 'display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 13px;border-radius:999px;font-size:12.5px;font-weight:600;background:' + (dirty ? 'var(--amber-soft)' : 'var(--green-soft)') + ';color:' + (dirty ? 'var(--amber)' : 'var(--primary-deep)') + ';';
    const feed = data.feed;
    const live = !!(feed && feed.provider);
    const refreshedLine = live ? 'Live market · refreshed ' + (feed.fetchedAt ? ago(feed.fetchedAt) : 'just now') : 'No market feed · rates hold at the last publish';
    const feedDot = 'flex:none;width:8px;height:8px;border-radius:50%;background:' + (live ? '#2EA36B' : '#9a938a') + ';' + (live ? 'animation:rtLive 2s infinite;' : '');
    /* The server pulls the market on its own schedule; Refresh reads the
       newest pull it has. */
    const refresh = async () => {
      const before = feed && feed.fetchedAt;
      await load();
      onToast(before && data.feed && data.feed.fetchedAt === before ? 'Up to date · the market is pulled every hour' : 'Market rates refreshed');
    };

    /* Default spread: the design's stepper, typed or stepped by 0.1. */
    const stepSpread = (v) => set({ defaultSpread: Math.min(20, Math.max(0, Math.round(v * 10) / 10)) }, 'default spread ' + v + '%');
    const avgSp = onBoard.length ? onBoard.reduce((a, r) => a + r.spreadPct, 0) / onBoard.length : defPct;

    /* Commission: the flat fee on every deal, and tiers for bigger deals. */
    const tiersRaw = Array.isArray(settings.feeTiers) ? settings.feeTiers : [];
    const tiers = tiersRaw.map((t, i) => ({ i, over: t ? t.over : '', fee: t ? t.fee : '' })).sort((a, b) => (num(a.over) || 0) - (num(b.over) || 0));
    const setTier = (i, patch) => set({ feeTiers: tiersRaw.map((t, k) => (k === i ? { ...t, ...patch } : t)) });
    const addTier = () => {
      if (readOnly) return;
      const top = tiers.length ? num(tiers[tiers.length - 1].over) || 0 : 0;
      const lastFee = tiers.length ? num(tiers[tiers.length - 1].fee) || 0 : num(settings.defaultFee) || 0;
      set({ feeTiers: tiersRaw.concat([{ over: top ? top * 2 : 5000, fee: Math.round(lastFee * 2) || 10 }]) }, 'commission tier added');
    };
    const removeTier = (i) => set({ feeTiers: tiersRaw.filter((t, k) => k !== i) }, 'commission tier removed');
    const big = Math.max(12000, Math.round((tiers.length ? num(tiers[tiers.length - 1].over) || 0 : 0) * 1.2));
    const feeExample = [750].concat(tiers.length ? [big] : []).map(a => { const f = B.feeFor(settings, a); return 'A ' + home + ' ' + a.toLocaleString('en-CA') + ' deal pays ' + (f ? home + ' ' + money(f) : 'no fee'); }).join(' · ') + ', plus the spread.';
    const feeInput = 'width:44px;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:14px;color:var(--ink);';
    const feeBox = 'display:inline-flex;align-items:center;gap:4px;height:34px;padding:0 9px;border-radius:9px;border:1px solid var(--line);background:#fff;';

    /* The guardrails, summarised; the Guardrails tab edits them. */
    const enforce = settings.marginEnforce || 'block';
    const guardSummary = 'Floor ' + floor.toFixed(1) + '%, target ' + target.toFixed(1) + '%' + (hasDeals ? ' · below the floor, ' + (enforce === 'warn' ? 'warn only' : 'a reason is required') + '.' : ' · checked on your board.');
    const below = onBoard.filter(r => { const p = B.deskPair(r.mid, r.spreadPct, r.spreadPct); return (p.sell - r.mid) / r.mid * 100 < B.floorFor(settings, r.code); }).map(r => r.code);
    const guardNote = below.length ? below.join(', ') + (below.length === 1 ? ' is' : ' are') + ' below your floor right now.' : 'Everything on your board is above your floor.';

    /* Spread by currency. */
    const nCustom = rows.filter(r => r.custom).length;
    const customCount = nCustom === 0 ? 'All on the default' : (nCustom + ' custom spread' + (nCustom === 1 ? '' : 's'));
    const spCols = 'display:grid;grid-template-columns:minmax(150px,1.6fr) minmax(96px,1fr) 150px minmax(84px,1fr) minmax(84px,1fr) minmax(90px,1fr);gap:14px;';
    const spreadRows = rows.map((r, i) => {
      const pair = r.mid ? B.deskPair(r.mid, r.spreadPct, r.spreadPct) : null;
      const sp = settings.spreads || {};
      return {
        r, pair, name: FACE.currencyName(r.code),
        sub: (r.pinned ? 'market pinned' : (r.custom ? 'custom spread' : 'default ' + defPct.toFixed(1) + '%')) + (r.show ? '' : ' · off board'),
        spIn: typed('sp-' + r.code, r.custom ? String(sp[r.code]) : ''),
        spBox: css('display:inline-flex;align-items:center;gap:4px;width:96px;height:40px;padding:0 11px;border-radius:10px;background:#fff;border:' + (r.custom ? '1.5px solid var(--ink)' : '1px solid var(--line)') + ';'),
        spotBox: css('width:100px;height:40px;padding:0 10px;border-radius:10px;text-align:right;outline:none;font-family:var(--m);font-size:15px;border:' + (r.pinned ? '1.5px solid var(--amber)' : '1px solid var(--line)') + ';background:' + (r.pinned ? 'var(--amber-soft)' : (readOnly ? 'rgba(23,20,15,0.03)' : '#fff')) + ';color:' + (readOnly ? 'var(--faint)' : 'var(--ink)') + ';'),
        row: css(spCols + 'align-items:center;padding:12px 18px;' + (i ? 'border-top:1px solid var(--hair);' : '') + (r.show ? '' : 'opacity:0.6;')),
        card: css('padding:14px 16px;' + (i ? 'border-top:1px solid var(--hair);' : 'border-top:1px solid var(--line);') + (r.show ? '' : 'opacity:0.6;')),
      };
    });
    const onSp = (code) => (e) => {
      const v = e.target.value;
      typing('sp-' + code, v);
      const n = num(v);
      if (v.trim() === '') setOwnSpread(code, null);
      else if (isFinite(n)) setOwnSpread(code, Math.min(20, Math.max(0, n)));
    };
    const onSpot = (code) => (e) => {
      const v = e.target.value;
      typing('spot-' + code, v);
      const n = num(v);
      if (n > 0) setPin(code, n);
    };
    const spInput = (x) => (<input type="number" step="0.1" aria-label={x.r.code + ' spread'} value={x.spIn} placeholder={defPct.toFixed(1)} disabled={readOnly} onChange={onSp(x.r.code)} onBlur={() => leave('sp-' + x.r.code)}
      style={css('width:100%;min-width:0;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:15px;color:var(--ink);')} />);
    const clearBtn = (x) => (x.r.custom && !readOnly ? <button type="button" onClick={() => { leave('sp-' + x.r.code); setOwnSpread(x.r.code, null); }} title="Back to default" aria-label={'Use the default spread for ' + x.r.code} style={css('flex:none;appearance:none;border:0;background:none;color:var(--faint);cursor:pointer;font-size:16px;line-height:1;padding:4px;')}>×</button> : null);

    /* The live deal preview, priced the way the desk prices. */
    const simCodes = [home].concat(onBoard.map(r => r.code)).filter(Boolean);
    const simIn = simCodes.includes(sim.in) ? sim.in : simCodes[0];
    const simOut = simCodes.includes(sim.out) && sim.out !== simIn ? sim.out : (simCodes.find(c => c !== simIn) || simIn);
    const find = (k) => rows.find(r => r.code === k && r.mid);
    const priced = (r) => B.deskPair(r.mid, r.spreadPct, r.spreadPct);
    const amt = num(sim.amt) || 0;
    const step = num(settings.payoutRoundTo) > 0 ? num(settings.payoutRoundTo) : 0.01;
    const mode = settings.payoutRoundMode || 'nearest';
    const rnd = (v) => { const q = v / step; return (mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q)) * step; };
    const xin = find(simIn), xout = find(simOut), same = simIn === simOut;
    const withFee = hasDeals && simFee;
    const size = simIn === home ? amt : amt * (xin ? xin.mid : 0);
    const fee = withFee ? (B.feeFor(settings, size) || 0) : 0;
    let recv = 0, rate = '', margin = 0, base = amt;
    if (!same) {
      if (simIn === home && xout) { const pr = priced(xout); recv = Math.max(0, amt - fee) / pr.sell; margin = recv * (pr.sell - xout.mid); rate = '1 ' + xout.code + ' = ' + fx(pr.sell); }
      else if (xin && simOut === home) { const pr = priced(xin); recv = Math.max(0, amt * pr.buy - fee); margin = amt * (xin.mid - pr.buy); base = amt * xin.mid; rate = '1 ' + xin.code + ' = ' + fx(pr.buy); }
      else if (xin && xout) { const pi = priced(xin), po = priced(xout); recv = amt * pi.buy / po.sell; margin = amt * (xin.mid - pi.buy) + recv * (po.sell - xout.mid); base = amt * xin.mid; rate = '1 ' + xin.code + ' = ' + (pi.buy / po.sell).toFixed(4) + ' ' + xout.code; }
    }
    const ok = !same && amt > 0 && recv > 0, r2 = ok ? rnd(recv) : 0, dp = step >= 1 ? 0 : 2, pct = ok ? margin / base * 100 : 0;
    const total = margin + fee, tPct = ok ? total / base * 100 : 0;
    const vs = (tone) => css('font-family:var(--m);font-size:14px;font-weight:700;margin-top:4px;color:' + tone + ';');
    const toneVar = (p) => (p < floor ? 'var(--clay)' : (p < target ? 'var(--amber)' : 'var(--primary-deep)'));
    const simStats = withFee ? [
      { label: 'Rate', value: ok ? rate : '·', vStyle: vs('var(--ink)') },
      { label: 'Flat fee', value: ok ? (fee ? money(fee) + ' ' + home : 'None') : '·', vStyle: vs('var(--ink)') },
      { label: 'Spread margin', value: ok ? margin.toFixed(2) + ' ' + home : '·', vStyle: vs('var(--mute)') },
      { label: 'You make', value: ok ? total.toFixed(2) + ' ' + home : '·', vStyle: vs('var(--primary-deep)') },
      { label: 'Effective %', value: ok ? tPct.toFixed(2) + '%' : '·', vStyle: vs(toneVar(tPct)) },
    ] : [
      { label: 'Rate', value: ok ? rate : '·', vStyle: vs('var(--ink)') },
      { label: 'Margin · ' + home, value: ok ? margin.toFixed(2) : '·', vStyle: vs('var(--primary-deep)') },
      { label: 'Margin %', value: ok ? pct.toFixed(2) + '%' : '·', vStyle: vs(toneVar(pct)) },
      { label: 'Rounding', value: ok ? (r2 - recv >= 0 ? '+' : '−') + Math.abs(r2 - recv).toFixed(2) + ' ' + simOut : '·', vStyle: vs('var(--mute)') },
    ];
    const simNote = same ? 'Pick two different currencies.' : ('Pay-out rounded ' + mode + ' to ' + step + '. ' + (withFee ? (simIn === home ? 'The fee comes off what they pay before it is converted. ' : 'The fee comes off what they receive. ') + 'Effective % is spread plus fee, over the deal size.' : 'Margin is what you capture against the market, before any fee.'));
    const ft = track(withFee, false);
    const simSelect = css('flex:none;border:0;border-right:1px solid var(--line);background:rgba(23,20,15,0.04);padding:0 10px;font-family:var(--m);font-size:13px;font-weight:700;outline:none;');
    const simLabel = css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);margin-bottom:6px;');

    /* How cost is worked out (owner), and pay-out rounding. */
    const methodName = method === 'fifo' ? 'FIFO' : 'Average';
    const setCostMethod = async (m) => {
      if (!owns || readOnly) return;
      const want = m === 'FIFO' ? 'fifo' : 'weighted_average';
      try {
        const res = await fetch('/api/ledger/cost-method', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: want }) });
        if (!res.ok) { onToast('The cost method did not change (the server answered ' + res.status + ').'); return; }
        const body = await res.json();
        setMethod(body && body.method ? body.method : want);
        if (log) log('Cost method changed', m);
      } catch (e) { onToast('The cost method did not change. Check the connection and try again.'); }
    };
    const methods = seg(['Average', 'FIFO'], methodName, setCostMethod, !owns || readOnly);
    const methodNote = (methodName === 'FIFO' ? 'First in, first out: each sale uses your oldest notes first.' : 'Every purchase blends into one average price per currency.') + (owns ? '' : ' Only the owner can change this.');
    const infoBtn = css('flex:none;appearance:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;cursor:pointer;font-family:var(--m);font-size:11px;font-weight:700;line-height:1;transition:all .2s ease;border:1.5px solid ' + (infoOpen ? 'var(--primary)' : 'rgba(23,20,15,0.3)') + ';background:' + (infoOpen ? 'var(--primary)' : '#fff') + ';color:' + (infoOpen ? '#fff' : 'var(--mute)') + ';');
    const infoCases = [
      { name: 'Average', how: 'Both purchases blend: 2,000 USD for 2,730 ' + home + '.', cost: '1.365', keep: '17.50 ' + home },
      { name: 'FIFO', how: 'The 500 you sell come from Monday’s batch first.', cost: '1.350', keep: '25.00 ' + home },
    ];
    const ROUND_TO = ['0.01', '0.05', '0.25', '1.00', '5.00'];
    const roundToNow = ROUND_TO.find(o => num(o) === step) || String(step);
    const roundRows = [
      { label: 'Round what the customer gets to', hint: 'So the drawer never has to find a coin it doesn’t have.', opts: seg(ROUND_TO.includes(roundToNow) ? ROUND_TO : ROUND_TO.concat([roundToNow]), roundToNow, (v) => set({ payoutRoundTo: num(v) }, 'pay-out rounding ' + v), readOnly) },
      { label: 'Which way', hint: 'Down always favours the shop. Up favours the customer. Nearest is fairest.', opts: seg(['Nearest', 'Down', 'Up'], mode.charAt(0).toUpperCase() + mode.slice(1), (v) => set({ payoutRoundMode: v.toLowerCase() }, 'pay-out rounding ' + v.toLowerCase()), readOnly) },
    ];
    const upgrade = () => { if (window.CDOS.openSettingsTab) window.CDOS.openSettingsTab('billing'); else if (window.CDOS.openApp) window.CDOS.openApp('settings'); };

    if (data.loading) return <div style={css('padding:30px;text-align:center;font-size:13.5px;color:var(--mute);')}>Loading your pricing…</div>;

    return (<div style={css('display:flex;flex-direction:column;gap:14px;max-width:1080px;')}>
      <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;')}>
        <span style={css('flex:1 1 260px;min-width:0;font-size:13.5px;line-height:1.5;color:var(--mute);')}>{'What the desk pays and charges. ' + (hasDeals ? 'Every change here prices your board and the next deal in the Ledger.' : 'Every change here prices your board.')}</span>
        <span style={css(saveChip)}><span style={css('width:7px;height:7px;border-radius:50%;background:currentColor;')} />{saveLabel}</span>
        <button type="button" onClick={publish} disabled={pubOff} style={css(pubBtnSm)}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>{busy ? 'Publishing…' : 'Publish to Rate Board'}</button>
      </div>
      {notice && <div role="alert" style={css('padding:11px 14px;border-radius:12px;background:var(--clay-soft);color:var(--clay);font-size:13px;font-weight:600;')}>{notice}</div>}

      <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(250px, 1fr));gap:14px;')}>
        <div style={css(card)}>
          <div style={css(cardHead)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15 0 18M12 3c-2.5 2.6-2.5 15 0 18" /></svg>Rate source</div>
          <div style={css('width:100%;display:flex;align-items:center;gap:10px;margin-top:13px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:rgba(23,20,15,0.03);text-align:left;box-sizing:border-box;')}><b style={css('flex:1;min-width:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{live ? feed.provider + ' · hourly' : 'No market feed'}</b></div>
          <div style={css('display:flex;align-items:center;gap:9px;margin-top:12px;')}><span style={css(feedDot)} /><span style={css('flex:1;min-width:0;font-size:13px;color:var(--mute);')}>{refreshedLine}</span><button type="button" onClick={refresh} style={css('flex:none;appearance:none;height:34px;padding:0 12px;border-radius:9px;border:1px solid var(--line);background:#fff;font-size:12.5px;font-weight:700;cursor:pointer;')}>Refresh</button></div>
          <p style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin:11px 0 0;')}>Spreads below sit on top of this rate. The same feed drives your board, website and window.</p>
        </div>
        <div style={css(card)}>
          <div style={css(cardHead)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 5 5 19" /><circle cx="7" cy="7" r="2.5" /><circle cx="17" cy="17" r="2.5" /></svg>Default spread</div>
          <div style={css('margin-top:13px;')}><div><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);margin-bottom:7px;')}>Above and below market</div><div style={css('display:flex;align-items:center;gap:5px;')}>
            <button type="button" aria-label="Lower the default spread" disabled={readOnly} onClick={() => stepSpread(defPct - 0.1)} style={stepBtn}>−</button>
            <span style={css('display:inline-flex;align-items:center;justify-content:center;gap:2px;min-width:80px;height:38px;padding:0 9px;border-radius:10px;background:rgba(23,20,15,0.05);')}><input aria-label="Default spread" value={typed('defaultSpread', defPct.toFixed(1))} inputMode="decimal" disabled={readOnly}
              onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); typing('defaultSpread', v); const n = parseFloat(v); if (!isNaN(n)) set({ defaultSpread: Math.min(20, Math.max(0, n)) }); }} onBlur={() => leave('defaultSpread')}
              style={css('width:46px;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:16px;font-weight:700;color:var(--ink);')} /><span style={css('font-family:var(--m);font-size:14px;color:var(--mute);')}>%</span></span>
            <button type="button" aria-label="Raise the default spread" disabled={readOnly} onClick={() => stepSpread(defPct + 0.1)} style={stepBtn}>+</button></div></div></div>
          <p style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin:11px 0 0;')}>Applied above and below the market to any currency without its own. Average across your board <b style={css('color:var(--ink);')}>{avgSp.toFixed(2) + '%'}</b>.</p>
        </div>
        {hasDeals && <div style={css(card + ' padding-bottom: 6px;')}>
          <div style={css(cardHead)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="9" r="6" /><path d="M15.5 9.2A6 6 0 1 1 9.2 15.5" /></svg>Default commission</div>
          <p style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin:9px 0 0;')}>A flat fee on top of the spread. Bigger deals can pay a different fee.</p>
          <div style={css('display:flex;flex-direction:column;gap:6px;margin-top:12px;')}>
            <div style={css('display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 10px;border-radius:11px;background:rgba(23,20,15,0.035);')}>
              <span style={css('font-size:12.5px;font-weight:600;min-width:74px;')}>Every deal</span>
              <span style={css('font-size:12.5px;color:var(--mute);')}>pay</span>
              <span style={css(feeBox)}><span style={css('font-family:var(--m);font-size:10.5px;color:var(--faint);')}>{home}</span><input aria-label="Fee on every deal" value={typed('fee', settings.defaultFee == null ? '' : String(settings.defaultFee))} inputMode="decimal" disabled={readOnly}
                onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); typing('fee', v); set({ defaultFee: v === '' ? '' : Number(v) }); }} onBlur={() => leave('fee')} style={css(feeInput)} /></span>
            </div>
            {tiers.map((t, n) => (<div key={t.i} style={css('display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 10px;border-radius:11px;background:rgba(23,20,15,0.035);')}>
              <span style={css('font-size:12.5px;font-weight:600;min-width:74px;')}>Deals over</span>
              <span style={css(feeBox)}><span style={css('font-family:var(--m);font-size:10.5px;color:var(--faint);')}>{home}</span><input aria-label={'Tier ' + (n + 1) + ' starts over'} value={typed('over-' + t.i, isFinite(num(t.over)) && String(t.over) !== '' ? num(t.over).toLocaleString('en-CA') : String(t.over))} inputMode="numeric" disabled={readOnly}
                onChange={e => { const v = e.target.value.replace(/[^0-9,]/g, ''); typing('over-' + t.i, v); setTier(t.i, { over: v === '' ? '' : num(v) }); }} onBlur={() => leave('over-' + t.i)} style={css('width:64px;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:14px;color:var(--ink);')} /></span>
              <span style={css('font-size:12.5px;color:var(--mute);')}>pay</span>
              <span style={css(feeBox)}><span style={css('font-family:var(--m);font-size:10.5px;color:var(--faint);')}>{home}</span><input aria-label={'Tier ' + (n + 1) + ' fee'} value={typed('tfee-' + t.i, String(t.fee))} inputMode="decimal" disabled={readOnly}
                onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); typing('tfee-' + t.i, v); setTier(t.i, { fee: v === '' ? '' : Number(v) }); }} onBlur={() => leave('tfee-' + t.i)} style={css(feeInput)} /></span>
              <span style={{ flex: 1 }} />
              {!readOnly && <button type="button" onClick={() => removeTier(t.i)} title="Remove this tier" aria-label="Remove this tier" style={css('appearance:none;border:0;background:none;color:var(--faint);cursor:pointer;font-size:17px;line-height:1;padding:4px;')}>×</button>}
            </div>))}
            <button type="button" onClick={addTier} disabled={readOnly} style={css('align-self:flex-start;appearance:none;border:1px dashed rgba(23,20,15,0.25);background:none;border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;color:var(--mute);cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';')}>+ Add a tier</button>
          </div>
          <div style={css('margin-top:12px;padding:10px 12px;border-radius:11px;background:var(--green-soft);font-size:12.5px;line-height:1.55;color:var(--primary-deep);')}>{feeExample}</div>
          <p style={css('font-size:12px;line-height:1.5;color:var(--faint);margin:8px 0 12px;')}>Filled in on the new-deal screen. Tellers can remove it for a regular.</p>
        </div>}
      </div>

      <div style={css(card + ' display: flex; align-items: center; gap: 14px; flex-wrap: wrap;')}>
        <div style={css('flex:1 1 260px;min-width:0;')}><div style={css(cardHead)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>Margin guardrails</div><div style={css('font-size:13px;line-height:1.5;color:var(--mute);margin-top:8px;')}>{guardSummary}</div><div style={css('font-size:12.5px;font-weight:600;margin-top:4px;')}>{guardNote}</div></div>
        {onGoGuard && <button type="button" onClick={onGoGuard} style={css('flex:none;appearance:none;height:38px;padding:0 15px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:700;cursor:pointer;')}>Open guardrails →</button>}
      </div>

      <section aria-label="Spread by currency" style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
        <div style={css('display:flex;align-items:center;gap:10px;padding:16px 18px;')}><div style={css(cardHead + ' flex: 1;')}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>Spread by currency</div><span style={css('font-size:12.5px;color:var(--mute);')}>{customCount}</span></div>
        {wideTable && <>
          <div style={css(spCols + 'padding:11px 18px;background:rgba(23,20,15,0.035);border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}><span>Currency</span><span style={{ textAlign: 'right' }}>{'Market · ' + home}</span><span style={{ textAlign: 'center' }}>Spread</span><span style={{ textAlign: 'right' }}>We buy</span><span style={{ textAlign: 'right' }}>We sell</span><span style={{ textAlign: 'right' }}>Margin / unit</span></div>
          {spreadRows.map(x => (<div key={x.r.code} style={x.row}>
            <span style={css('display:flex;align-items:center;gap:11px;min-width:0;')}><Flag code={x.r.code} size={28} /><span style={css('min-width:0;')}><b style={css('display:block;font-size:14.5px;')}>{x.name}</b><span style={css('display:block;font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{x.r.code + ' · ' + x.sub}</span></span></span>
            <span style={css('display:flex;align-items:center;justify-content:flex-end;gap:4px;')}>{x.r.pinned && !readOnly && <button type="button" onClick={() => { leave('spot-' + x.r.code); setPin(x.r.code, null); }} title="Back to the feed" aria-label={'Back to the feed for ' + x.r.code} style={css('flex:none;appearance:none;border:0;background:none;color:var(--amber);cursor:pointer;font-size:15px;line-height:1;padding:3px;')}>↺</button>}
              <input type="number" step="0.0001" aria-label={x.r.code + ' market rate'} value={typed('spot-' + x.r.code, x.r.mid ? fx(x.r.mid) : '')} readOnly={readOnly} onChange={onSpot(x.r.code)} onBlur={() => leave('spot-' + x.r.code)} style={x.spotBox} /></span>
            <span style={css('display:flex;align-items:center;justify-content:center;gap:6px;')}><span style={x.spBox}>{spInput(x)}<span style={css('color:var(--faint);font-size:12px;')}>%</span></span>{clearBtn(x)}</span>
            <span style={css('text-align:right;font-family:var(--m);font-size:15px;color:var(--clay);')}>{x.pair ? fx(x.pair.buy) : '·'}</span>
            <span style={css('text-align:right;font-family:var(--m);font-size:15px;color:var(--primary);')}>{x.pair ? fx(x.pair.sell) : '·'}</span>
            <span style={css('text-align:right;font-family:var(--m);font-size:15px;font-weight:700;')}>{x.pair ? fx(x.pair.sell - x.r.mid) : '·'}</span>
          </div>))}
        </>}
        {!wideTable && spreadRows.map(x => (<div key={x.r.code} style={x.card}>
          <div style={css('display:flex;align-items:center;gap:11px;')}><Flag code={x.r.code} size={28} /><span style={css('flex:1;min-width:0;')}><b style={css('font-size:14.5px;')}>{x.name}</b><span style={css('display:block;font-size:12px;color:var(--mute);')}>{x.r.code + ' · ' + x.sub}</span></span><span style={x.spBox}>{spInput(x)}<span style={css('color:var(--faint);font-size:12px;')}>%</span></span>{clearBtn(x)}</div>
          <div style={css('display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;margin-top:11px;')}>
            <span><span style={css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>Market</span><span style={css('font-family:var(--m);font-size:13px;color:var(--mute);')}>{x.r.mid ? fx(x.r.mid) : '·'}</span></span>
            <span><span style={css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>We buy</span><span style={css('font-family:var(--m);font-size:13px;color:var(--clay);')}>{x.pair ? fx(x.pair.buy) : '·'}</span></span>
            <span><span style={css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>We sell</span><span style={css('font-family:var(--m);font-size:13px;color:var(--primary);')}>{x.pair ? fx(x.pair.sell) : '·'}</span></span>
            <span><span style={css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>Margin</span><span style={css('font-family:var(--m);font-size:13px;font-weight:700;')}>{x.pair ? fx(x.pair.sell - x.r.mid) : '·'}</span></span>
          </div>
        </div>))}
      </section>

      <div style={css('padding:18px;border-radius:16px;background:#fff;border:1px solid var(--line);')}>
        <div style={css('display:flex;align-items:center;gap:9px;font-family:var(--m);font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;')}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v4" /></svg><span style={css('flex:1;display:inline-flex;align-items:center;gap:9px;')}>Live deal preview</span>
          {hasDeals && <button type="button" role="switch" aria-checked={withFee} onClick={() => setSimFee(!withFee)} style={css('display:inline-flex;align-items:center;gap:9px;appearance:none;border:0;background:none;cursor:pointer;padding:0;font:inherit;letter-spacing:0.1em;color:var(--mute);')}>Include fee<span style={{ ...ft.track, width: 34, height: 20 }}><span style={{ ...ft.knob, width: 14, height: 14, transform: 'translateX(' + (withFee ? 14 : 0) + 'px)' }} /></span></button>}</div>
        <p style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin:6px 0 0;')}>Try a deal against the rates above. Changes to spreads show here straight away.</p>
        <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;margin-top:14px;align-items:end;')}>
          <label style={css('display:block;')}><span style={simLabel}>Customer pays</span><span style={css('display:flex;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:#fff;')}><select aria-label="Customer pays in" value={simIn} onChange={e => setSim(s => ({ ...s, in: e.target.value }))} style={simSelect}>{simCodes.map(c => <option key={c} value={c}>{c}</option>)}</select><input aria-label="Customer pays" value={sim.amt} onChange={e => setSim(s => ({ ...s, amt: e.target.value.replace(/[^0-9.,]/g, '') }))} inputMode="decimal" style={css('flex:1;min-width:0;height:42px;border:0;outline:none;padding:0 12px;text-align:right;font-family:var(--m);font-size:16px;color:var(--ink);')} /></span></label>
          <label style={css('display:block;')}><span style={simLabel}>Receives</span><span style={css('display:flex;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:rgba(29,107,69,0.05);')}><select aria-label="Receives in" value={simOut} onChange={e => setSim(s => ({ ...s, out: e.target.value }))} style={simSelect}>{simCodes.map(c => <option key={c} value={c}>{c}</option>)}</select><span style={css('flex:1;min-width:0;height:42px;display:flex;align-items:center;justify-content:flex-end;padding:0 12px;font-family:var(--m);font-size:16px;font-weight:700;color:var(--primary-deep);')}>{ok ? r2.toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '·'}</span></span></label>
        </div>
        <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:1px;margin-top:12px;border-radius:11px;overflow:hidden;background:var(--line);border:1px solid var(--line);')}>
          {simStats.map(g => (<div key={g.label} style={css('padding:10px 12px;background:#fff;')}><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>{g.label}</div><div style={g.vStyle}>{g.value}</div></div>))}
        </div>
        <div style={css('font-size:12px;line-height:1.5;color:var(--mute);margin-top:9px;')}>{simNote}</div>
      </div>

      {hasDeals && <div style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
        <div style={css('display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:15px 18px;')}>
          <span style={css('flex:1 1 240px;min-width:0;')}><span style={css('display:flex;align-items:center;gap:7px;')}><b style={css('font-size:14px;')}>How cost is worked out</b><button type="button" onClick={() => setInfoOpen(!infoOpen)} title="How this works" aria-label="How this works" aria-expanded={infoOpen} style={infoBtn}>i</button></span><span style={css('display:block;font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:2px;')}>{methodNote}</span></span>
          <span role="group" aria-label="Cost method" style={css('display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:rgba(23,20,15,0.06);')}>{methods.map(m => <button key={m.label} type="button" aria-pressed={m.label === methodName} disabled={!owns || readOnly} onClick={m.onPick} style={m.style}>{m.label}</button>)}</span>
        </div>
        {infoOpen && <div style={css('margin:0 18px 16px;padding:14px 15px;border-radius:13px;background:rgba(23,20,15,0.035);border:1px solid var(--hair);animation:rtIn .22s ease both;')}>
          <div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>Worked example · USD</div>
          <div style={css('font-size:13px;line-height:1.55;margin-top:6px;')}>You buy <b>1,000 USD at 1.35</b> on Monday, then <b>1,000 at 1.38</b> on Thursday. On Friday you sell <b>500</b> at 1.40.</div>
          <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;margin-top:12px;')}>
            {infoCases.map(c => (<div key={c.name} style={css('padding:12px 13px;border-radius:11px;background:#fff;border:1px solid ' + (methodName === c.name ? 'var(--primary)' : 'var(--line)') + ';')}><div style={css('display:flex;align-items:center;gap:7px;')}><b style={css('font-size:13.5px;')}>{c.name}</b>{methodName === c.name && <span style={css('font-family:var(--m);font-size:8.5px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:var(--primary-deep);background:var(--green-soft);padding:2px 7px;border-radius:999px;')}>You use this</span>}</div><div style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:4px;')}>{c.how}</div><div style={css('font-family:var(--m);font-size:12px;margin-top:6px;')}>{'Cost ' + c.cost + ' · you keep ' + c.keep}</div></div>))}
          </div>
          <div style={css('font-size:12px;line-height:1.5;color:var(--mute);margin-top:10px;')}>Neither changes the price on your board, only how much profit each sale shows. Most shops use the average. Your accountant may prefer FIFO.</div>
        </div>}
        {roundRows.map(r => (<div key={r.label} style={css('display:flex;align-items:center;gap:12px 14px;flex-wrap:wrap;padding:13px 18px;border-top:1px solid var(--hair);')}>
          <span style={css('flex:1 1 220px;min-width:0;')}><b style={css('display:block;font-size:14px;')}>{r.label}</b><span style={css('display:block;font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:2px;')}>{r.hint}</span></span>
          <span role="group" aria-label={r.label} style={css('display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:rgba(23,20,15,0.06);flex-wrap:wrap;')}>{r.opts.map(o => <button key={o.label} type="button" aria-pressed={o.on} disabled={readOnly} onClick={o.onPick} style={o.style}>{o.label}</button>)}</span>
        </div>))}
      </div>}

      {!hasDeals && owns && <div style={css('display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:16px 18px;border-radius:16px;border:1px dashed rgba(23,20,15,0.22);')}>
        <span style={css('flex:1 1 260px;min-width:0;')}><b style={css('display:block;font-size:14px;')}>Commission, real profit and deal guardrails come with Full System</b><span style={css('display:block;font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:3px;')}>On Rates you price your board. Full System adds deals, what you paid for your cash, and a check on every deal before it posts.</span></span>
        <button type="button" onClick={upgrade} style={css('flex:none;appearance:none;height:40px;padding:0 16px;border-radius:11px;border:0;background:var(--ink);color:#fff;font-size:13px;font-weight:700;cursor:pointer;')}>See Full System</button>
      </div>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { RatesPricing });
})();
