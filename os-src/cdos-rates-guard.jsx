/* ============================================================
   CurrencyDesk OS: Rates, the Guardrails tab (Rates v2.5)

   A port of the design's Guardrails tab (handoff rates-v2.5,
   "CurrencyDesk Rates v2.5", the isGuard section): the design's markup
   and style strings, turned into React styles by the Rates app's css().

   One floor, checked in three places: on the board (a currency selling
   under its floor turns amber or red), on every deal (the new-deal screen
   meters spread plus fee over the deal size), and afterwards (each
   override stays on the deal with who, why and how far under, and is
   listed here). The settings are the shop's: the target and the floor
   (marginTargetPct, marginFloorPct), what happens below it
   (marginEnforce, changed in Settings, Rates & fees), and each currency's
   own floor (marginFloorByCcy, read by ratesBoard.floorFor wherever a
   floor is checked).

   The guardrails are the owner's (state/owner-settings.ts); everyone else
   sees them. Where the design and the code differ the copy says what the
   code does: on this desk the teller who posts a deal under the floor
   gives the reason, and the overrides are listed here, not sent.
   ============================================================ */
(function () {
  const { useState, useEffect, useCallback } = React;
  const B = window.CDOS.ratesBoard;

  const money = (v) => Number(v).toLocaleString('en-CA', { maximumFractionDigits: 2 });
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  /* The desk's deal stamp, "2026-11-05 14:32:10", on the desk's clock. */
  const stampMs = (at) => { const t = Date.parse(String(at || '').replace(' ', 'T')); return isFinite(t) ? t : NaN; };

  function RatesGuard({ settings, setSettings, serverRole, me, log, deals, locked }) {
    const ui = window.CDOS.ratesUi;
    const { css, Flag, getJson, toneOf, chip } = ui;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    const role = serverRole || (me && me.role === 'Owner' ? 'administrator' : me && me.role === 'Manager' ? 'branch_manager' : 'teller');
    const owns = role === 'administrator';
    const readOnly = !owns || !!locked;
    const hasDeals = (settings.billingPlan || 'premium') !== 'basic';
    const floor = settings.marginFloorPct != null && isFinite(+settings.marginFloorPct) ? +settings.marginFloorPct : 0.5;
    const target = settings.marginTargetPct != null && isFinite(+settings.marginTargetPct) ? +settings.marginTargetPct : 1.0;

    const [data, setData] = useState({ loading: true, board: null, market: {} });
    const [raw, setRaw] = useState({});
    const typed = (k, fallback) => (raw[k] != null ? raw[k] : fallback);
    const typing = (k, v) => setRaw(r => ({ ...r, [k]: v }));
    const leave = (k) => setRaw(r => { const n = { ...r }; delete n[k]; return n; });

    const load = useCallback(async () => {
      try {
        const [rates, feed] = await Promise.all([getJson('/api/rates'), getJson('/api/rates/market')]);
        setData({ loading: false, board: rates.board, market: B.homeMarket(feed.mids, home) });
      } catch (e) {
        console.warn('[rates] the board could not be read for the guardrails', e);
        setData(d => ({ ...d, loading: false }));
      }
    }, [home]);
    useEffect(() => { load(); }, [load]);

    const set = (patch, note) => { if (readOnly) return; setSettings(s => ({ ...s, ...patch })); if (note && log) log('Guardrails updated', note); };
    const setOwnFloor = (code, v) => { if (readOnly) return; setSettings(s => { const o = { ...(s.marginFloorByCcy || {}) }; if (v === null) delete o[code]; else o[code] = v; return { ...s, marginFloorByCcy: o }; }); };

    const rows = B.draftRows({ codes: window.CDOS.CCY || [], home, board: data.board, market: data.market, settings }).filter(r => r.show && r.mid);

    /* ---- the design's pieces ---- */
    const card = 'padding:18px;border-radius:16px;background:#fff;border:1px solid var(--line);min-width:0;';
    const cardHead = 'display:flex;align-items:center;gap:9px;font-family:var(--m);font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:var(--ink);';
    const stepBtn = css('width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:18px;color:var(--ink);cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';');
    const where = [
      ['1', 'On your board', 'Before you publish, a currency selling under its floor turns amber or red, so you see it first.', true],
      ['2', 'On every deal', hasDeals ? 'The new-deal screen meters spread plus fee over the deal size, live, while the teller types.' : 'Full System checks every deal before it posts.', hasDeals],
      ['3', 'Afterwards', hasDeals ? 'Every override stays on the deal with who, why and how far under. This week’s are listed below.' : 'Full System keeps every override for you.', hasDeals],
    ];
    const steppers = [['Healthy target', 'marginTargetPct', target], ['Minimum floor', 'marginFloorPct', floor]];
    const stepTo = (key, v, label) => set({ [key]: Math.min(20, Math.max(0, Math.round(v * 10) / 10)) }, label.toLowerCase() + ' ' + v.toFixed(1) + '%');
    const mScale = Math.max(3, target * 1.3, floor * 1.3);
    const levelNote = hasDeals
      ? 'On a deal, margin is the spread plus any fee over the deal size. On your board it is what you sell at over the market. A currency’s own floor below overrides this.'
      : 'On this plan the desk doesn’t know what you paid, so the floor is measured against the market rate.';
    const enforce = settings.marginEnforce || 'block';
    const policyLine = enforce === 'warn'
      ? 'Warn only · the teller sees the warning and can still post · every deal under the floor shows here.'
      : 'A reason is required · the teller marks the override and says why before it posts · every one is listed below.';
    const toSettings = () => { if (window.CDOS.openSettingsTab) window.CDOS.openSettingsTab('rates'); else if (window.CDOS.openApp) window.CDOS.openApp('settings'); };

    /* Floor by currency: each on the board, what it sells at over the
       market now, against its own floor or the shop's. */
    const own = settings.marginFloorByCcy || {};
    const floorRows = rows.map((r, i) => {
      const p = B.deskPair(r.mid, r.spreadPct, r.spreadPct);
      const pct = (p.sell - r.mid) / r.mid * 100;
      const tone = toneOf(pct, B.floorFor(settings, r.code), target);
      return { r, pct, tone, v: typed('fl-' + r.code, own[r.code] != null ? String(own[r.code]) : ''), row: css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 18px;border-top:1px solid var(--hair);') };
    });

    /* Overrides this week, from the desk's own deals. */
    const now = Date.now();
    const overrides = (Array.isArray(deals) ? deals : [])
      .filter(d => d && d.marginOverride && now - stampMs(d.marginOverride.at) <= WEEK_MS)
      .sort((a, b) => stampMs(b.marginOverride.at) - stampMs(a.marginOverride.at))
      .map(d => {
        const code = d.inCcy && d.inCcy !== home ? d.inCcy : d.outCcy;
        const homeAmt = d.inCcy === home ? +d.inAmt : d.outCcy === home ? +d.outAmt : null;
        return { key: d.ref || d.id || d.marginOverride.at, code, m: d.marginOverride.pct, why: d.marginOverride.reason || 'No reason given', homeAmt,
          amt: homeAmt != null && isFinite(homeAmt) ? home + ' ' + money(homeAmt) : (d.inAmt != null ? money(d.inAmt) + ' ' + (d.inCcy || '') : ''),
          who: d.marginOverride.by || '', when: d.marginOverride.at || '' };
      });
    const underSum = overrides.reduce((a, o) => a + (o.homeAmt != null && isFinite(o.homeAmt) ? o.homeAmt : 0), 0);
    const ovCount = overrides.length ? overrides.length + (underSum ? ' · ' + home + ' ' + money(underSum) + ' under the floor' : '') : 'None';

    return (<div style={css('display:flex;flex-direction:column;gap:14px;max-width:1000px;')}>
      <div><h2 style={css('margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;')}>One floor, checked in three places</h2><p style={css('font-size:13.5px;line-height:1.55;color:var(--mute);margin:6px 0 0;max-width:640px;')}>Guardrails stop a rate or a deal going out below what you can live with. You set the floor once; the desk checks it on your board, on every deal, and afterwards.</p></div>
      {!owns && <div style={css('font-size:12.5px;font-weight:600;color:var(--ink);')}>Only the owner can change the guardrails.</div>}
      <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:10px;')}>
        {where.map(w => (<div key={w[0]} style={css('padding:15px 16px;border-radius:14px;background:#fff;border:1px solid var(--line);' + (w[3] ? '' : 'opacity:0.55;'))}><span style={css('display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;font-family:var(--m);font-size:11.5px;font-weight:700;background:' + (w[3] ? 'var(--ink)' : 'rgba(23,20,15,0.1)') + ';color:' + (w[3] ? '#fff' : 'var(--mute)') + ';')}>{w[0]}</span><b style={css('display:block;font-size:14.5px;margin-top:10px;')}>{w[1]}</b><span style={css('display:block;font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:4px;')}>{w[2]}</span></div>))}
      </div>

      <div style={css(card)}>
        <div style={css(cardHead)}>The levels</div>
        <div style={css('display:flex;gap:16px 26px;flex-wrap:wrap;align-items:flex-end;margin-top:14px;')}>
          {steppers.map(([label, key, value]) => (<div key={key}><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);margin-bottom:7px;')}>{label}</div><div style={css('display:flex;align-items:center;gap:5px;')}>
            <button type="button" aria-label={'Lower the ' + label.toLowerCase()} disabled={readOnly} onClick={() => stepTo(key, value - 0.1, label)} style={stepBtn}>−</button>
            <span style={css('display:inline-flex;align-items:center;justify-content:center;gap:2px;min-width:80px;height:38px;padding:0 9px;border-radius:10px;background:rgba(23,20,15,0.05);')}><input aria-label={label} value={typed(key, value.toFixed(1))} inputMode="decimal" disabled={readOnly}
              onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); typing(key, v); const n = parseFloat(v); if (!isNaN(n)) set({ [key]: Math.min(20, Math.max(0, n)) }); }} onBlur={() => leave(key)}
              style={css('width:46px;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:16px;font-weight:700;color:var(--ink);')} /><span style={css('font-family:var(--m);font-size:14px;color:var(--mute);')}>%</span></span>
            <button type="button" aria-label={'Raise the ' + label.toLowerCase()} disabled={readOnly} onClick={() => stepTo(key, value + 0.1, label)} style={stepBtn}>+</button></div></div>))}
          <div style={css('flex:1 1 260px;min-width:0;')}><div style={css('height:10px;border-radius:999px;overflow:hidden;display:flex;')}><span style={css('width:' + Math.min(100, floor / mScale * 100) + '%;background:var(--clay);opacity:0.75;')} /><span style={css('width:' + Math.max(0, Math.min(100, (target - floor) / mScale * 100)) + '%;background:#e0a106;opacity:0.75;')} /><span style={css('flex:1;background:var(--primary);')} /></div><div style={css('display:flex;justify-content:space-between;margin-top:7px;font-family:var(--m);font-size:10.5px;')}><span style={css('color:var(--clay);')}>● below floor</span><span style={css('color:var(--amber);')}>● watch</span><span style={css('color:var(--primary);')}>● healthy</span></div></div>
        </div>
        {floor >= target && <p style={css('font-size:12.5px;line-height:1.5;color:var(--amber);font-weight:600;margin:13px 0 0;')}>The floor is at or above the target, so nothing can be on target. Lower the floor or raise the target.</p>}
        <p style={css('font-size:12.5px;line-height:1.5;color:var(--mute);margin:13px 0 0;')}>{levelNote}</p>
      </div>

      {hasDeals && <div style={css(card + ' display: flex; align-items: center; gap: 14px; flex-wrap: wrap;')}>
        <div style={css('flex:1 1 260px;min-width:0;')}><div style={css(cardHead)}>When a deal lands below the floor</div><div style={css('font-size:13px;line-height:1.5;color:var(--mute);margin-top:8px;')}>{policyLine}</div></div>
        <button type="button" onClick={toSettings} style={css('flex:none;display:inline-flex;align-items:center;height:38px;padding:0 15px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:700;color:var(--ink);cursor:pointer;')}>Change in Settings →</button>
      </div>}

      <section aria-label="Floor by currency" style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
        <div style={css('padding:16px 18px 12px;')}><div style={css(cardHead)}>Floor by currency</div><span style={css('display:block;font-size:12.5px;line-height:1.5;color:var(--mute);margin-top:6px;')}>{'Leave blank to use ' + floor.toFixed(1) + '%. Raise it where a currency is hard to restock; lower it where you always undercut.'}</span></div>
        {data.loading && <div style={css('padding:14px 18px;font-size:13px;color:var(--mute);border-top:1px solid var(--hair);')}>Loading your board…</div>}
        {!data.loading && !floorRows.length && <div style={css('padding:14px 18px;font-size:13px;color:var(--mute);border-top:1px solid var(--hair);')}>Nothing is on your board yet.</div>}
        {floorRows.map(x => (<div key={x.r.code} data-floor-row={x.r.code} style={x.row}>
          <span style={css('flex:1 1 140px;min-width:0;display:flex;align-items:center;gap:10px;')}><Flag code={x.r.code} size={26} /><b style={css('font-size:14px;')}>{x.r.code}</b></span>
          <span data-tone={x.tone} style={chip(x.tone)}>{'Now ' + x.pct.toFixed(2) + '%'}</span>
          <span style={css('display:inline-flex;align-items:center;gap:4px;width:104px;height:38px;padding:0 11px;border-radius:10px;border:1px solid var(--line);background:#fff;box-sizing:border-box;')}><input aria-label={x.r.code + ' floor'} value={x.v} placeholder={floor.toFixed(1)} inputMode="decimal" disabled={readOnly}
            onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); typing('fl-' + x.r.code, v); const n = parseFloat(v); setOwnFloor(x.r.code, v === '' || isNaN(n) ? null : Math.min(20, Math.max(0, n))); }} onBlur={() => leave('fl-' + x.r.code)}
            style={css('width:100%;min-width:0;border:0;outline:none;background:transparent;text-align:right;font-family:var(--m);font-size:14px;color:var(--ink);')} /><span style={css('color:var(--faint);font-size:12px;')}>%</span></span>
        </div>))}
      </section>

      {hasDeals && <section aria-label="Overrides this week" style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
        <div style={css('display:flex;align-items:center;gap:10px;padding:16px 18px 10px;')}><div style={css(cardHead + ' flex: 1;')}>Overrides this week</div><span style={css('font-family:var(--m);font-size:11px;color:var(--mute);')}>{ovCount}</span></div>
        {!overrides.length && <div style={css('padding:12px 18px 16px;font-size:13px;color:var(--mute);border-top:1px solid var(--hair);')}>No deal went out under the floor this week.</div>}
        {overrides.map(o => (<div key={o.key} style={css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--hair);')}><span style={{ ...chip('red'), flex: 'none' }}>{o.code + ' · ' + o.m + '%'}</span><span style={css('flex:1 1 220px;min-width:0;')}><b style={css('display:block;font-size:13.5px;')}>{'“' + o.why + '”'}</b><span style={css('display:block;font-size:12px;color:var(--mute);margin-top:2px;')}>{[o.amt, o.who, o.when].filter(Boolean).join(' · ')}</span></span></div>))}
      </section>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { RatesGuard });
})();
