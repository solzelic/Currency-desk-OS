/* ============================================================
   CurrencyDesk OS — Pricing Console  (roadmap #5)
   The owner's profit lever in one place. Reads & writes the SAME
   settings keys the Ledger prices from (settings.spreads, defaultSpread,
   defaultFee, marginFloor/Target/Enforce, payoutRound*, rateProvider) —
   so this is a richer cockpit over the one source of truth, never a fork.
   Every edit recomputes the live buy/sell rates and the deal simulator.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, CCY, crossRate, fmt, num, priceDeal, spreadOf, buyUnitCad, sellUnitCad, roundPayout, unitCadMid } = window.CDOS;

  const NAME = { CAD: 'Canadian Dollar', USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', INR: 'Indian Rupee', PHP: 'Philippine Peso', CNY: 'Chinese Yuan', MXN: 'Mexican Peso', AED: 'UAE Dirham' };
  const PROVIDERS = ['OANDA · fxTrade rates', 'XE Currency Data', 'Refinitiv (Reuters) FX', 'European Central Bank', 'Wise rates'];

  const card = { background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 13 };
  const inWrap = { display: 'inline-flex', alignItems: 'center', border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden', background: 'var(--cd-panel)' };

  function Eyebrow({ icon, children, right }) {
    return (<div className="flex items-center justify-between mb-3">
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{icon && <Ic n={icon} s={13} c={CD.mute} />}{children}</span>
      {right}
    </div>);
  }
  function Seg({ value, onPick, opts }) {
    return (<div className="inline-flex flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>
      {opts.map(([v, l], i) => { const on = value === v; return <button key={v} onClick={() => onPick(v)} className="text-[12px] px-3 py-1.5 font-medium" style={{ background: on ? CD.ink : 'transparent', color: on ? 'var(--cd-on-ink)' : CD.mute, borderLeft: i ? `1px solid ${CD.line}` : 'none' }}>{l}</button>; })}
    </div>);
  }

  function PricingDesk({ settings, setSettings, me, log }) {
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : 'CAD';
    const FOREIGN = (CCY || []).filter(c => c !== home);
    const set = (k, v, note) => { setSettings(s => ({ ...s, [k]: v })); if (note && log) log('Pricing updated', note); };
    const setSpread = (code, v) => setSettings(s => ({ ...s, spreads: { ...(s.spreads || {}), [code]: v } }));
    const clearSpread = (code) => setSettings(s => { const sp = { ...(s.spreads || {}) }; delete sp[code]; return { ...s, spreads: sp }; });
    // ---- manual spot override: editing a spot PINS it (stops pulling from the
    // source feed) until reset. The source of truth is the feed; a pin is a
    // deliberate deviation the owner owns. ----
    const ov = settings.spotOverride || {};
    const isPinned = (c) => ov[c] != null && ov[c] !== '';
    const spotOf = (c) => c === home ? 1 : (isPinned(c) ? +ov[c] : (home === 'CAD' ? (crossRate(c, 'CAD') || 0) : ((window.CDOS.homePerUnit && window.CDOS.homePerUnit(c)) || 0)));
    const setSpot = (c, v) => setSettings(s => ({ ...s, spotOverride: { ...(s.spotOverride || {}), [c]: v } }));
    const resetSpot = (c) => setSettings(s => { const o = { ...(s.spotOverride || {}) }; delete o[c]; return { ...s, spotOverride: o }; });

    const [refreshedAt, setRefreshedAt] = useState(() => Date.now() - 132000);  // ~2m ago
    const [tick, setTick] = useState(0);
    const [pushedAt, setPushedAt] = useState(null);   // last push to the public Rate Board
    const [justPushed, setJustPushed] = useState(false);   // transient green confirm
    const refresh = () => { setRefreshedAt(Date.now()); setTick(t => t + 1); log && log('Rates refreshed', (settings.rateProvider || PROVIDERS[0])); };
    // push the console's spreads to the public Rate Board. MERGES into the
    // published config — staff mids, currency order, show-flags and any other
    // rows are preserved; only each currency's spread (+ default margins) is set.
    const pushRates = () => {
      let cfg = {};
      try { cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || '{}') || {}; } catch (e) {}
      cfg.rows = cfg.rows || {};
      const dflt = (defSpread || 1.5) / 100;
      cfg.buyMargin = dflt; cfg.sellMargin = dflt;
              FOREIGN.forEach(c => { cfg.rows[c] = Object.assign({}, cfg.rows[c], { mid: spotOf(c), spread: spreadOf(c, settings), show: cfg.rows[c] ? (cfg.rows[c].show !== false) : true }); });
      cfg.publishedAt = Date.now(); cfg.publishedBy = me ? me.name : 'owner';
      const str = JSON.stringify(cfg);
      try { localStorage.setItem('yorkfx_rates_v1', str); window.dispatchEvent(new StorageEvent('storage', { key: 'yorkfx_rates_v1', newValue: str })); } catch (e) {}
      // publish to the backend too (append-only rate_boards + audit trail);
      // requires a session with rates:change — silently skipped standalone
      try {
        fetch('/api/rates/publish', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ buyMargin: cfg.buyMargin, sellMargin: cfg.sellMargin, rows: cfg.rows, order: (JSON.parse(localStorage.getItem('yorkfx_board_order') || 'null') || undefined) }),
        }).catch(() => {});
      } catch (e) {}
      setPushedAt(Date.now());
      setJustPushed(true); setTimeout(() => setJustPushed(false), 1800);
      log && log('Rates published to board', `${FOREIGN.length} currencies · default ${defSpread}% · by ${me ? me.name : 'owner'}`);
    };
    const agoLabel = (() => { const s = Math.max(0, Math.round((Date.now() - refreshedAt) / 1000)); if (s < 60) return s + 's ago'; const m = Math.round(s / 60); return m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago'; })();

    const defSpread = settings.defaultSpread != null ? +settings.defaultSpread : 1.5;
    const mFloor = settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const mTarget = settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const roundInc = settings.payoutRoundTo != null ? +settings.payoutRoundTo : 0.01;
    const roundMode = settings.payoutRoundMode || 'nearest';

    // blended spread across the foreign book (simple average of effective spreads)
    const blended = useMemo(() => FOREIGN.reduce((s, c) => s + spreadOf(c, settings) * 100, 0) / (FOREIGN.length || 1), [settings, tick]);
    const customCount = FOREIGN.filter(c => { const sp = settings.spreads || {}; return sp[c] != null && sp[c] !== ''; }).length;
    const pinnedCount = FOREIGN.filter(c => isPinned(c)).length;

    // live deal simulator
    const [sim, setSim] = useState(() => { const h = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : 'CAD'; return { inCcy: h, outCcy: h === 'USD' ? 'EUR' : 'USD', inAmt: '1000' }; });
    const simP = useMemo(() => {
      const inC = sim.inCcy, outC = sim.outCcy, amt = parseFloat(sim.inAmt) || 0;
      const sprdOf = (c) => c === home ? 0 : spreadOf(c, settings);
      const inUnit = inC === home ? 1 : spotOf(inC) * (1 - sprdOf(inC));
      const outUnit = outC === home ? 1 : spotOf(outC) * (1 + sprdOf(outC));
      const rate = outUnit ? inUnit / outUnit : 0;
      const outAmt = roundPayout(amt * rate, settings);
      const midIn = amt * (inC === home ? 1 : spotOf(inC));
      const midOut = outAmt * (outC === home ? 1 : spotOf(outC));
      const midRate = (outC === home ? 1 : spotOf(outC)) ? (inC === home ? 1 : spotOf(inC)) / (outC === home ? 1 : spotOf(outC)) : 0;
      return { rate: +rate.toFixed(6), outAmt, midRate: +midRate.toFixed(6), marginCad: +(midIn - midOut).toFixed(2), midCadIn: midIn };
    }, [sim, settings, tick]);
    const simBasis = simP.midCadIn || 0;
    const simPct = simBasis ? (simP.marginCad / simBasis) * 100 : 0;
    const simZone = simPct >= mTarget ? CD.green : simPct >= mFloor ? CD.amber : CD.flag;

    // rounding example
    const roundEx = roundPayout(1234.567, settings);

    const PctInput = ({ value, onChange, placeholder, w = 78, strong }) => (
      <div style={{ ...inWrap, borderColor: strong ? CD.ink : CD.line }}>
        <input type="number" step="0.05" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: w, fontVariantNumeric: 'tabular-nums', color: CD.ink }} />
        <span className="px-2 text-[11px]" style={{ color: CD.mute, borderLeft: `1px solid ${CD.line}` }}>%</span>
      </div>
    );

    return (
      <div style={{ height: '100%', overflow: 'auto', background: 'transparent' }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 22px 40px' }}>
          {/* title */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-[18px] font-bold" style={{ color: CD.ink, letterSpacing: '-0.01em' }}>Pricing &amp; Rates</div>
              <div className="text-[12px]" style={{ color: CD.mute }}>What the desk pays and charges. Every change here prices the next deal in the Ledger.</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={pushRates} disabled={justPushed} className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 text-white" style={{ background: justPushed ? CD.green : CD.ink, borderRadius: 8, transition: 'background .2s' }}><Ic n={justPushed ? 'check' : 'upload'} s={13} c="var(--cd-on-ink)" /> {justPushed ? 'Pushed to board' : 'Publish to Rate Board'}</button>
              <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 999 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: CD.green }}></span> Saves automatically</span>
            </div>
          </div>

          {/* hero band */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ ...card, padding: 16 }}>
              <Eyebrow icon="globe">Rate source</Eyebrow>
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '100%' }}>
                <select value={settings.rateProvider || PROVIDERS[0]} onChange={e => { set('rateProvider', e.target.value, `rate provider ${e.target.value}`); try { localStorage.setItem('yorkfx_rate_provider', e.target.value); } catch (_) {} }} className="text-sm px-3 py-2 outline-none w-full" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-paper-soft)', appearance: 'none', paddingRight: 28, color: CD.ink, fontWeight: 500 }}>
                  {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <span style={{ position: 'absolute', right: 10, pointerEvents: 'none', color: CD.faint }}><Ic n="chev" s={13} c={CD.faint} /></span>
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: CD.mute }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: CD.green }}></span> Live spot · refreshed {agoLabel}</span>
                <button onClick={refresh} className="flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="bars" s={13} c={CD.mute} /> Refresh</button>
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Spreads &amp; margins below are applied on top of this spot. The same feed drives the public Rate Board.</div>
            </div>

            <div style={{ ...card, padding: 16 }}>
              <Eyebrow icon="percent">Default spread</Eyebrow>
              <div className="flex items-baseline gap-2">
                <PctInput value={settings.defaultSpread ?? ''} onChange={v => set('defaultSpread', v === '' ? '' : +v)} placeholder="1.5" w={70} strong />
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Applied to any currency without its own spread. Blended book average <b style={{ color: CD.ink }}>{blended.toFixed(2)}%</b>.</div>
            </div>

            <div style={{ ...card, padding: 16 }}>
              <Eyebrow icon="coins">Default commission</Eyebrow>
              <div style={inWrap}>
                <span className="px-2 text-[11px]" style={{ color: CD.mute, borderRight: `1px solid ${CD.line}` }}>CAD</span>
                <input type="number" step="1" value={settings.defaultFee ?? ''} onChange={e => set('defaultFee', e.target.value === '' ? '' : +e.target.value)} placeholder="0" className="text-sm px-2.5 py-2 outline-none text-right bg-transparent" style={{ width: 80, fontVariantNumeric: 'tabular-nums', color: CD.ink }} />
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Flat fee pre-filled on a new deal, on top of the spread.</div>
            </div>
          </div>

          {/* margin guardrails */}
          <div style={{ ...card, padding: 16, marginBottom: 12 }}>
            <Eyebrow icon="activity" right={<Seg value={settings.marginEnforce || 'block'} onPick={v => set('marginEnforce', v, `margin enforce ${v}`)} opts={[['warn', 'Warn only'], ['block', 'Require override']]} />}>Margin guardrails</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 16, alignItems: 'center' }}>
              <div>
                <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Healthy target</div>
                <PctInput value={settings.marginTargetPct ?? 1.0} onChange={v => set('marginTargetPct', +v || 0, `margin target ${v}%`)} />
              </div>
              <div>
                <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Minimum floor</div>
                <PctInput value={settings.marginFloorPct ?? 0.5} onChange={v => set('marginFloorPct', +v || 0, `margin floor ${v}%`)} />
              </div>
              <div>
                <div className="text-[11px] mb-1.5" style={{ color: CD.mute }}>Where deals land on the meter</div>
                <div style={{ position: 'relative', height: 10, borderRadius: 999, overflow: 'hidden', display: 'flex', border: `1px solid ${CD.lineSoft}` }}>
                  {(() => { const max = Math.max(mTarget * 2, mFloor * 2, 1.5); const fp = Math.min(100, (mFloor / max) * 100); const tp = Math.min(100, (mTarget / max) * 100); return (<>
                    <div style={{ width: fp + '%', background: CD.flagSoft }} />
                    <div style={{ width: (tp - fp) + '%', background: CD.amberSoft }} />
                    <div style={{ flex: 1, background: CD.greenSoft }} />
                  </>); })()}
                </div>
                <div className="flex items-center justify-between text-[10px] mt-1" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>
                  <span style={{ color: CD.flag }}>● below floor</span><span style={{ color: CD.amber }}>● watch</span><span style={{ color: CD.green }}>● healthy</span>
                </div>
              </div>
            </div>
            <div className="text-[10.5px] mt-2.5" style={{ color: CD.faint }}>The New-Transaction screen meters every deal's margin (spread + fee ÷ pay-in). {settings.marginEnforce === 'warn' ? 'Below the floor it warns but lets the teller post (logged).' : 'Below the floor the teller must override with a reason before posting.'}</div>
          </div>

          {/* per-currency matrix */}
          <div style={{ ...card, padding: 0, marginBottom: 12, overflow: 'hidden' }}>
            <div className="flex items-center justify-between" style={{ padding: '14px 16px 10px' }}>
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}><Ic n="bars" s={13} c={CD.mute} /> Spread by currency</span>
              <span className="text-[11px]" style={{ color: pinnedCount ? CD.amber : CD.mute }}>{[customCount ? `${customCount} custom spread` : 'spreads on default', pinnedCount ? `${pinnedCount} spot pinned` : ''].filter(Boolean).join(' · ')}</span>
            </div>
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10px] uppercase tracking-wide text-left">
                <th style={{ padding: '8px 16px' }}>Currency</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Spot · {home}</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>Spread</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>We buy</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>We sell</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' }}>Margin / unit</th>
              </tr></thead>
              <tbody>{FOREIGN.map(c => {
                const sp = settings.spreads || {};
                const custom = sp[c] != null && sp[c] !== '';
                const pinned = isPinned(c);
                const spot = spotOf(c);
                const liveMid = (home === 'CAD' ? crossRate(c, 'CAD') : ((window.CDOS.homePerUnit && window.CDOS.homePerUnit(c)) || 0)) || 0;
                const sprd = spreadOf(c, settings);
                const buy = spot * (1 - sprd), sell = spot * (1 + sprd);
                const perUnit = spot * sprd;   // captured each side vs spot
                const eff = sprd * 100;
                const thin = eff < 0.4;
                return (<tr key={c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  <td style={{ padding: '8px 16px' }}>
                    <div className="flex items-center gap-2.5">
                      <span className="grid place-items-center flex-none font-semibold" style={{ width: 30, height: 30, borderRadius: 8, background: CD.lineSoft, color: CD.ink, fontSize: 11, fontFamily: 'Space Mono, monospace' }}>{c}</span>
                      <div><div className="text-[13px] font-medium leading-tight" style={{ color: CD.ink }}>{NAME[c] || c}</div><div className="text-[10.5px]" style={{ color: CD.faint }}>{custom ? 'custom spread' : `default ${defSpread}%`}</div></div>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <div className="inline-flex items-center gap-1 justify-end">
                      <div style={{ ...inWrap, borderColor: pinned ? CD.amber : CD.line }}>
                        <input type="text" inputMode="decimal" value={pinned ? ov[c] : ''} onChange={e => setSpot(c, e.target.value)} placeholder={liveMid.toFixed(4)} title={pinned ? 'Manual spot — not pulling from the source feed' : 'Live from source — type to pin a manual spot'} className="text-sm px-2 py-1.5 outline-none text-right bg-transparent" style={{ width: 92, fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: pinned ? CD.amber : CD.mute }} />
                      </div>
                      <button onClick={() => resetSpot(c)} title="Reset to source spot (resume the feed)" className="grid place-items-center" style={{ width: 22, height: 22, borderRadius: 6, visibility: pinned ? 'visible' : 'hidden', color: CD.amber }}><Ic n="x" s={12} c={CD.amber} /></button>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    <div className="inline-flex items-center justify-end gap-1">
                      <div style={{ ...inWrap, borderColor: custom ? CD.ink : CD.line }}>
                        <input type="text" inputMode="decimal" value={sp[c] ?? ''} onChange={e => setSpread(c, e.target.value)} placeholder={defSpread.toString()} className="text-sm px-2 py-1.5 outline-none text-right bg-transparent" style={{ width: 52, fontVariantNumeric: 'tabular-nums', color: thin ? CD.flag : CD.ink }} />
                        <span className="px-1.5 text-[11px]" style={{ color: CD.faint }}>%</span>
                      </div>
                      <button onClick={() => clearSpread(c)} title="Reset to default" className="grid place-items-center" style={{ width: 24, height: 24, borderRadius: 6, visibility: custom ? 'visible' : 'hidden', color: CD.mute }}><Ic n="x" s={12} c={CD.mute} /></button>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.flag }}>{buy.toFixed(4)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.green }}>{sell.toFixed(4)}</td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink, fontWeight: 600 }}>{(home === 'CAD' ? '$' : '') + perUnit.toFixed(3)}</td>
                </tr>); })}</tbody>
            </table>
            <div className="flex items-center gap-4 text-[11px]" style={{ padding: '10px 16px', borderTop: `1px solid ${CD.lineSoft}`, color: CD.faint }}>
              <span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.flag }}></span> We buy — {home} we pay per unit acquired</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.green }}></span> We sell — {home} we charge per unit released</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.amber }}></span> Amber spot = manual (feed paused)</span>
              <span style={{ marginLeft: 'auto' }}>Margin / unit = captured each side vs. spot</span>
            </div>
          </div>

          {/* rounding + simulator */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* rounding */}
            <div style={{ ...card, padding: 16 }}>
              <Eyebrow icon="coins">Pay-out rounding</Eyebrow>
              <div className="flex items-center gap-2 mb-3">
                <Seg value={roundMode} onPick={v => set('payoutRoundMode', v, `rounding ${v}`)} opts={[['down', 'Down'], ['nearest', 'Nearest'], ['up', 'Up']]} />
                <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                  <select value={roundInc} onChange={e => set('payoutRoundTo', +e.target.value)} className="text-sm px-3 py-2 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', appearance: 'none', paddingRight: 26 }}>
                    {[['0.01', 'to ¢'], ['0.05', 'to 5¢'], ['0.25', 'to 25¢'], ['1', 'to $1'], ['5', 'to $5'], ['10', 'to $10']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <span style={{ position: 'absolute', right: 9, pointerEvents: 'none' }}><Ic n="chev" s={12} c={CD.faint} /></span>
                </div>
              </div>
              <div className="flex items-center justify-between px-3 py-2.5" style={{ background: 'var(--cd-paper-soft)', border: `1px solid ${CD.lineSoft}`, borderRadius: 9 }}>
                <span className="text-[12px]" style={{ color: CD.mute }}>Example</span>
                <span className="text-[12.5px]" style={{ fontFamily: 'Space Mono, monospace', color: CD.ink }}>{home === 'CAD' ? '$' : ''}1,234.567 <span style={{ color: CD.faint }}>→</span> <b>{fmt(roundEx, home)}</b></span>
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>{roundMode === 'down' ? 'Down favours the desk.' : roundMode === 'up' ? 'Up favours the customer.' : 'Nearest is neutral.'} Applied to the amount the customer receives.</div>
            </div>

            {/* live simulator */}
            <div style={{ ...card, padding: 16 }}>
              <Eyebrow icon="calc">Live deal preview</Eyebrow>
              <div className="flex items-stretch gap-2">
                <div style={{ flex: 1 }}>
                  <div className="text-[10.5px] mb-1" style={{ color: CD.mute }}>Customer pays</div>
                  <div style={{ ...inWrap, width: '100%' }}>
                    <select value={sim.inCcy} onChange={e => setSim(s => ({ ...s, inCcy: e.target.value }))} className="text-sm px-2 outline-none" style={{ background: 'var(--cd-chip)', borderRight: `1px solid ${CD.line}`, fontWeight: 600 }}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                    <input value={sim.inAmt} onChange={e => setSim(s => ({ ...s, inAmt: e.target.value }))} inputMode="decimal" className="text-sm px-2.5 py-2 outline-none text-right w-full bg-transparent" style={{ fontVariantNumeric: 'tabular-nums' }} />
                  </div>
                </div>
                <button onClick={() => setSim(s => ({ ...s, inCcy: s.outCcy, outCcy: s.inCcy }))} title="Swap" className="grid place-items-center flex-none mt-4" style={{ width: 32, border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute }}><Ic n="swap" s={14} c={CD.mute} /></button>
                <div style={{ flex: 1 }}>
                  <div className="text-[10.5px] mb-1" style={{ color: CD.mute }}>Receives</div>
                  <div style={{ ...inWrap, width: '100%', background: 'var(--cd-paper-soft)' }}>
                    <select value={sim.outCcy} onChange={e => setSim(s => ({ ...s, outCcy: e.target.value }))} className="text-sm px-2 outline-none" style={{ background: 'var(--cd-chip)', borderRight: `1px solid ${CD.line}`, fontWeight: 600 }}>{CCY.map(c => <option key={c}>{c}</option>)}</select>
                    <div className="text-sm px-2.5 py-2 text-right w-full font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.green }}>{sim.inCcy === sim.outCcy ? '—' : num(simP.outAmt)}</div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <div className="px-2.5 py-2" style={{ background: 'var(--cd-paper-soft)', borderRadius: 8 }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Rate</div><div className="text-[13px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(simP.rate)}</div></div>
                <div className="px-2.5 py-2" style={{ background: 'var(--cd-paper-soft)', borderRadius: 8 }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>vs spot</div><div className="text-[13px] font-semibold" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{num(simP.midRate)}</div></div>
                <div className="px-2.5 py-2" style={{ background: simZone === CD.green ? CD.greenSoft : simZone === CD.amber ? CD.amberSoft : CD.flagSoft, borderRadius: 8 }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Margin</div><div className="text-[13px] font-semibold" style={{ color: simZone, fontVariantNumeric: 'tabular-nums' }}>{fmt(simP.marginCad, home)} · {simPct.toFixed(2)}%</div></div>
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Priced exactly as the Ledger would, with your spreads &amp; rounding above. Edit a spread and watch it move.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* Phone pricing is its own tree, mounted only at 430px. A wide
     window keeps PricingDesk, so the desktop paint does not change.
     NavRow, FullScreenSheet, and Toast belong to feat/phone-settings
     and are not on the shell yet. The stand-ins below must not take
     those names.
     TODO: switch to them when that branch is the base, and delete
     PricingSheet, the stepper, and PricingNote. */
  function usePhone() {
    const query = '(max-width: 430px)';
    const [on, setOn] = useState(() => !!(window.matchMedia && window.matchMedia(query).matches));
    useEffect(() => {
      if (!window.matchMedia) return undefined;
      const mq = window.matchMedia(query);
      const apply = () => setOn(mq.matches);
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }, []);
    return on;
  }

  const PHONE_CCY = { USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', INR: 'Indian rupee', PHP: 'Philippine peso', CNY: 'Chinese yuan', MXN: 'Mexican peso', AED: 'UAE dirham' };

  function homeOf() { return window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : 'CAD'; }

  /* Amounts go through the shell formatter. An empty string is an
     absent figure, drawn as a dash, never as zero. */
  function pricingMoney(n, ccy) {
    const format = window.CDOS && window.CDOS.formatPhoneMoney;
    if (typeof format !== 'function') throw new Error('Pricing: formatPhoneMoney did not load.');
    return format(n, ccy) || '—';
  }
  /* Clocks go through the same formatter. "3:02 PM", never 15:02. */
  function pricingClock(when, timeZone) {
    const format = window.CDOS && window.CDOS.formatPhoneTime;
    if (typeof format !== 'function') throw new Error('Pricing: formatPhoneTime did not load.');
    return format(when, timeZone) || '';
  }
  function rate4(n, known) {
    if (!known || n == null || !isFinite(+n)) return '—';
    return (+n).toFixed(4);
  }
  function pctText(n) {
    const x = +n;
    return isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) + '%' : '—';
  }
  /* The mid a desktop Publish would write. The live preview does not
     use a pin: priceDeal prices the next deal off the live mid. */
  function spotFor(code, settings, home) {
    const ov = (settings && settings.spotOverride) || {};
    if (code === home) return 1;
    if (ov[code] != null && ov[code] !== '' && isFinite(+ov[code])) return +ov[code];
    if (home === 'CAD') return crossRate(code, 'CAD') || 0;
    return (window.CDOS.homePerUnit && window.CDOS.homePerUnit(code)) || 0;
  }
  function withSpread(settings, code, spreadPct) {
    const next = Object.assign({}, settings, { spreads: Object.assign({}, (settings && settings.spreads) || {}) });
    if (spreadPct == null || spreadPct === '' || !isFinite(+spreadPct)) delete next.spreads[code];
    else next.spreads[code] = spreadPct;
    return next;
  }
  /* Same call the ledger makes. 500 units of this currency into home. */
  function dealPreview(code, spreadPct, settings) {
    const home = homeOf();
    const next = withSpread(settings, code, spreadPct);
    const mid = unitCadMid(code);
    const known = mid > 0 && isFinite(mid);
    if (!known) return { home, known: false, mid: null, buy: null, sell: null, out: null, earn: null };
    const deal = priceDeal({ inCcy: code, outCcy: home, inAmt: 500, settings: next });
    return { home, known: true, mid, buy: buyUnitCad(code, next), sell: sellUnitCad(code, next), out: deal.outAmt, earn: deal.marginCad };
  }

  /* TODO: FullScreenSheet. */
  function PricingSheet({ title, onCancel, children, footer }) {
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);
    return ReactDOM.createPortal(
      <div className="pr-sheet" data-app="pricing" role="dialog" aria-modal="true" aria-label={title} data-pr="sheet">
        <div className="pr-sheet-h"><button type="button" onClick={onCancel}>Cancel</button><h2>{title}</h2><span /></div>
        <div className="pr-sheet-b">{children}</div>
        {footer ? <div className="pr-sheet-f">{footer}</div> : null}
      </div>,
      document.body
    );
  }
  function Stepper({ label, value, onChange, step, suffix }) {
    const [focus, setFocus] = useState(false);
    const by = step || 0.1;
    const bump = (dir) => {
      const places = by < 1 ? 1 : 2;
      const n = Math.round(((parseFloat(value) || 0) + dir * by) * (10 ** places)) / (10 ** places);
      onChange(String(Math.max(0, n)));
    };
    return (
      <div className="pr-field">
        {label ? <div className="pr-label">{label}</div> : null}
        <div className="pr-step">
          <button type="button" aria-label={'Less, ' + by} onClick={() => bump(-1)} disabled={(parseFloat(value) || 0) <= 0}>−</button>
          <label className={'pr-amt' + (focus ? ' is-on' : '')}>
            <input value={value} inputMode="decimal" aria-label={label || 'Amount'} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))} />
            {suffix ? <span>{suffix}</span> : null}
          </label>
          <button type="button" aria-label={'More, ' + by} onClick={() => bump(1)}>+</button>
        </div>
      </div>
    );
  }
  /* TODO: Toast. Four seconds, above the publish button, per the
     pricing spec. The settings toast is three seconds at the top. */
  function PricingNote({ text }) {
    if (!text) return null;
    const tail = text.replace(/^Sent to the Rate Board\.\s*/, '');
    return ReactDOM.createPortal(
      <div className="pr-note" role="status" data-pr="toast" aria-live="polite">
        <span className="pr-note-ok" aria-hidden="true">✓</span>
        <span><b>Sent to the Rate Board.</b> {tail}</span>
      </div>,
      document.body
    );
  }

  function PhonePricing({ settings, setSettings, me, log }) {
    const Phone = window.CDOS.Phone;
    if (!Phone || !Phone.Screen || !Phone.ListRow || !Phone.StickyAction) {
      throw new Error('Pricing: the phone shell did not load.');
    }
    const safe = settings || {};
    const home = homeOf();
    const book = (window.CDOS.deskCurrencyList && window.CDOS.deskCurrencyList()) || CCY;
    const foreign = [];
    (book || []).forEach((raw) => {
      const code = String(raw || '').toUpperCase();
      if (code && code !== home && foreign.indexOf(code) < 0) foreign.push(code);
    });
    const defSpread = safe.defaultSpread != null && safe.defaultSpread !== '' && isFinite(+safe.defaultSpread) ? +safe.defaultSpread : 1.5;
    const mFloor = safe.marginFloorPct != null && safe.marginFloorPct !== '' && isFinite(+safe.marginFloorPct) ? +safe.marginFloorPct : 0.5;
    const mTarget = safe.marginTargetPct != null && safe.marginTargetPct !== '' && isFinite(+safe.marginTargetPct) ? +safe.marginTargetPct : 1;
    const feeN = safe.defaultFee != null && safe.defaultFee !== '' && isFinite(+safe.defaultFee) ? +safe.defaultFee : 0;
    const roundMode = safe.payoutRoundMode || 'nearest';
    const roundLabel = roundMode === 'down' ? 'Down' : roundMode === 'up' ? 'Up' : 'Nearest';
    /* rates:change is the owner and the branch manager. The desk
       calls those Owner and Manager. A cashier cannot publish. */
    const canPublish = !!(me && (me.role === 'Owner' || me.role === 'Manager'));
    const [feed, setFeed] = useState('loading');
    const [attempt, setAttempt] = useState(0);
    const [sheet, setSheet] = useState(null);
    const [draft, setDraft] = useState('');
    const [extra, setExtra] = useState(null);
    const [phase, setPhase] = useState('idle');
    const [toast, setToast] = useState('');
    const [banner, setBanner] = useState('');
    const busy = useRef(false);
    const timers = useRef([]);
    useEffect(() => () => { timers.current.forEach((id) => clearTimeout(id)); }, []);
    useEffect(() => {
      let gone = false;
      setFeed('loading');
      fetch('/api/rates', { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await res.json();
          if (!gone) setFeed('ready');
        })
        .catch((err) => {
          if (gone) return;
          setFeed('error');
          if (log) log('Pricing', 'rate board did not load: ' + (err && err.message ? err.message : 'network'));
        });
      return () => { gone = true; };
    }, [attempt]);

    const set = (k, v, note) => { setSettings((s) => Object.assign({}, s, { [k]: v })); if (note && log) log('Pricing updated', note); };
    const setSpread = (code, v) => setSettings((s) => Object.assign({}, s, { spreads: Object.assign({}, (s && s.spreads) || {}, { [code]: v }) }));
    const clearSpread = (code) => setSettings((s) => { const sp = Object.assign({}, (s && s.spreads) || {}); delete sp[code]; return Object.assign({}, s, { spreads: sp }); });
    const draftOk = draft !== '' && isFinite(+draft) && +draft >= 0;

    function openSheet(kind, code) {
      setBanner('');
      if (kind === 'ccy') {
        const sp = (safe.spreads || {})[code];
        setDraft(String(sp != null && sp !== '' ? sp : defSpread));
      } else if (kind === 'spread') setDraft(String(defSpread));
      else if (kind === 'fee') setDraft(String(feeN));
      else if (kind === 'floor') {
        setDraft(String(mFloor));
        setExtra({ target: String(mTarget), enforce: safe.marginEnforce || 'block' });
      }
      setSheet({ kind, code: code || null });
    }
    function saveCurrency(code) {
      if (!draftOk) return;
      const n = Math.round(+draft * 10) / 10;
      if (n === +defSpread) clearSpread(code); else setSpread(code, n);
      if (log) log('Pricing updated', code + ' spread ' + n + '%');
      setSheet(null);
    }
    function useDefault(code) {
      clearSpread(code);
      setDraft(String(defSpread));
      if (log) log('Pricing updated', code + ' spread cleared');
    }

    async function publish() {
      if (busy.current || !canPublish || phase !== 'idle') return;
      busy.current = true;
      setPhase('publishing');
      setBanner('');
      const dflt = (defSpread || 1.5) / 100;
      let cfg = {};
      try { cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || '{}') || {}; }
      catch (err) {
        busy.current = false; setPhase('idle'); setBanner('Not published. Try again.');
        if (log) log('Rates not published', err && err.message ? err.message : 'saved board was not readable');
        return;
      }
      cfg.rows = cfg.rows || {};
      cfg.buyMargin = dflt; cfg.sellMargin = dflt;
      const rows = {};
      foreign.forEach((code) => {
        const mid = spotFor(code, safe, home);
        if (!(mid > 0) || !isFinite(mid)) return;
        const prev = cfg.rows[code] || {};
        const row = { mid, spread: spreadOf(code, safe), show: prev.show !== false };
        cfg.rows[code] = Object.assign({}, prev, row);
        rows[code] = row;
      });
      if (!Object.keys(rows).length) {
        busy.current = false; setPhase('idle'); setBanner('Not published. Try again.');
        if (log) log('Rates not published', 'no live rate to send');
        return;
      }
      let order;
      try {
        const raw = localStorage.getItem('yorkfx_board_order');
        if (raw) order = JSON.parse(raw);
        if (order == null) order = undefined;
      } catch (err) {
        order = undefined;
        if (log) log('Pricing', 'board order was not readable: ' + (err && err.message ? err.message : 'parse'));
      }
      cfg.publishedAt = Date.now();
      cfg.publishedBy = me && me.name ? me.name : 'owner';
      try {
        const res = await fetch('/api/rates/publish', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ buyMargin: cfg.buyMargin, sellMargin: cfg.sellMargin, rows, order }),
        });
        const text = await res.text();
        if (!res.ok) {
          let detail = 'HTTP ' + res.status;
          try { const body = JSON.parse(text); detail = body.detail || body.error || detail; }
          catch (err) { detail = text ? text.slice(0, 180) : detail; }
          throw new Error(detail);
        }
      } catch (err) {
        busy.current = false; setPhase('idle'); setBanner('Not published. Try again.');
        if (log) log('Rates not published', err && err.message ? err.message : 'publish failed');
        return;
      }
      /* The server accepted the board. A copy on this phone is a
         convenience; a storage failure does not unpublish it. */
      try {
        const str = JSON.stringify(cfg);
        localStorage.setItem('yorkfx_rates_v1', str);
        window.dispatchEvent(new StorageEvent('storage', { key: 'yorkfx_rates_v1', newValue: str }));
      } catch (err) {
        if (log) log('Pricing', err && err.message ? err.message : 'this phone did not keep a copy of the board');
      }
      let when = '';
      try {
        when = pricingClock(new Date(), safe.timezone);
        if (!when && log) log('Pricing', 'formatPhoneTime returned no clock');
      } catch (err) {
        if (log) log('Pricing', err && err.message ? err.message : 'formatPhoneTime did not load');
      }
      const sent = Object.keys(rows).length;
      setToast('Sent to the Rate Board. ' + sent + ' currencies' + (when ? ', ' + when : '') + '.');
      if (log) log('Rates published to board', sent + ' currencies · default ' + defSpread + '% · by ' + (me && me.name ? me.name : 'owner'));
      setPhase('locked');
      const hold = (fn, ms) => { const id = setTimeout(fn, ms); timers.current.push(id); };
      hold(() => setToast(''), 4000);
      hold(() => { busy.current = false; setPhase('idle'); }, 3000);
    }

    const Row = Phone.ListRow;
    let sheetEl = null;
    if (sheet && sheet.kind === 'ccy') {
      const code = sheet.code;
      const view = dealPreview(code, draft, safe);
      const pinned = (safe.spotOverride || {})[code] != null && (safe.spotOverride || {})[code] !== '';
      const low = draftOk && +draft < mFloor;
      sheetEl = (
        <PricingSheet title={(PHONE_CCY[code] || code) + ' spread'} onCancel={() => setSheet(null)} footer={<button type="button" className="pr-go" disabled={!draftOk} onClick={() => saveCurrency(code)}>Save {pctText(draft)} for {code}</button>}>
          <Stepper label="Spread on each side" value={draft} onChange={setDraft} suffix="%" />
          <p className="pr-hint">Default is {pctText(defSpread)}. Live rate now: {rate4(view.mid, view.known)} {view.home}.</p>
          {pinned ? <p className="pr-warn">Manual rate, feed paused for {code}.</p> : null}
          {low ? <p className="pr-warn">Below your {pctText(mFloor)} warning</p> : null}
          <div className="pr-prev">
            <div><span>We buy</span><b className="pr-buy" data-pr="buy">{rate4(view.buy, view.known)}</b></div>
            <div><span>Live</span><b data-pr="mid">{rate4(view.mid, view.known)}</b></div>
            <div><span>We sell</span><b className="pr-sell" data-pr="sell">{rate4(view.sell, view.known)}</b></div>
          </div>
          <div className="pr-kv">
            <div><span>Customer sells 500 {code}, gets</span><b data-pr="gets">{view.known ? pricingMoney(view.out, view.home) : '—'}</b></div>
            <div><span>You earn on that deal</span><b data-pr="earn">{view.known ? pricingMoney(view.earn, view.home) : '—'}</b></div>
          </div>
          <p className="pr-hint">Nothing changes on the Rate Board until you tap Publish.</p>
          <button type="button" className="pr-link" onClick={() => useDefault(code)}>Use the default ({pctText(defSpread)})</button>
        </PricingSheet>
      );
    } else if (sheet && sheet.kind === 'spread') {
      sheetEl = (
        <PricingSheet title="Spread" onCancel={() => setSheet(null)} footer={<button type="button" className="pr-go" disabled={!draftOk} onClick={() => { if (!draftOk) return; set('defaultSpread', Math.round(+draft * 10) / 10, 'default spread ' + pctText(draft)); setSheet(null); }}>Save {pctText(draft)} for every currency</button>}>
          <Stepper label="Spread on each side" value={draft} onChange={setDraft} suffix="%" />
          <p className="pr-hint">Added on each side of the live rate. A currency with its own spread keeps that.</p>
          {draftOk && +draft < mFloor ? <p className="pr-warn">Below your {pctText(mFloor)} warning</p> : null}
        </PricingSheet>
      );
    } else if (sheet && sheet.kind === 'fee') {
      sheetEl = (
        <PricingSheet title="Fee per deal" onCancel={() => setSheet(null)} footer={<button type="button" className="pr-go" disabled={!draftOk} onClick={() => { if (!draftOk) return; const n = Math.round(+draft * 100) / 100; set('defaultFee', n, 'default fee ' + n); setSheet(null); }}>Save {pricingMoney(draftOk ? +draft : null, home)}</button>}>
          <Stepper label="Fee per deal" value={draft} onChange={setDraft} step={1} suffix={home} />
          <p className="pr-hint">Added to every new deal, on top of the spread.</p>
        </PricingSheet>
      );
    } else if (sheet && sheet.kind === 'floor' && extra) {
      const targetOk = extra.target !== '' && isFinite(+extra.target) && +extra.target >= 0;
      sheetEl = (
        <PricingSheet title="Low margin warning" onCancel={() => setSheet(null)} footer={<button type="button" className="pr-go" disabled={!draftOk || !targetOk} onClick={() => { if (!draftOk || !targetOk) return; set('marginFloorPct', Math.round(+draft * 10) / 10, 'margin floor ' + pctText(draft)); set('marginTargetPct', Math.round(+extra.target * 10) / 10, 'margin target ' + pctText(extra.target)); set('marginEnforce', extra.enforce, 'margin enforce ' + extra.enforce); setSheet(null); }}>Save warning</button>}>
          <Stepper label="Warn below" value={draft} onChange={setDraft} suffix="%" />
          <Stepper label="Healthy target" value={extra.target} onChange={(v) => setExtra((x) => Object.assign({}, x, { target: v }))} suffix="%" />
          <div className="pr-label">When a deal is below</div>
          <div className="pr-picks">
            {[['warn', 'Warn only'], ['block', 'Ask for a manager']].map(([v, label]) => (
              <button type="button" key={v} className={'pr-pick' + (extra.enforce === v ? ' is-on' : '')} onClick={() => setExtra((x) => Object.assign({}, x, { enforce: v }))}>{label}</button>
            ))}
          </div>
        </PricingSheet>
      );
    } else if (sheet && sheet.kind === 'round') {
      sheetEl = (
        <PricingSheet title="Round payouts" onCancel={() => setSheet(null)}>
          <div className="pr-label">Cash you hand over</div>
          <div className="pr-picks">
            {[['down', 'Down'], ['nearest', 'Nearest'], ['up', 'Up']].map(([v, label]) => (
              <button type="button" key={v} className={'pr-pick' + (roundMode === v ? ' is-on' : '')} onClick={() => { set('payoutRoundMode', v, 'rounding ' + v); setSheet(null); }}>{label}</button>
            ))}
          </div>
          <p className="pr-hint">Down favours the desk. Up favours the customer. Nearest is neutral.</p>
        </PricingSheet>
      );
    } else if (sheet && sheet.kind === 'source') {
      sheetEl = (
        <PricingSheet title="Rate source" onCancel={() => setSheet(null)}>
          <div className="pr-src is-on"><span><b>Open Exchange Rates</b><small>Hourly</small></span>{feed === 'error' ? <span>Not loaded</span> : <span className="pr-live">Live</span>}</div>
          {['OANDA', 'Bank of Canada', 'XE'].map((name) => (
            <div className="pr-src" key={name}><span><b>{name}</b></span><span>Not connected</span></div>
          ))}
          <p className="pr-hint">Only Open Exchange Rates is connected.</p>
        </PricingSheet>
      );
    }

    const live = feed !== 'error';
    const body = feed === 'loading'
      ? <div data-pr="loading"><Phone.LoadingState rows={6} label="Loading pricing" /></div>
      : foreign.length === 0
        ? <div data-pr="empty"><Phone.EmptyState title="No currencies yet" message="This desk has no foreign currencies to price." /></div>
        : (
          <div data-pr="list">
            <Phone.ListSection title="For every currency">
              <Row title="Rate source" subtitle="Open Exchange Rates, hourly" badge={live ? { label: 'Live', tone: 'pos' } : null} amount={live ? '' : 'Not loaded'} chevron onClick={() => openSheet('source')} />
              <Row title="Spread" subtitle="Added on each side of the live rate" amount={pctText(defSpread)} chevron onClick={() => openSheet('spread')} />
              <Row title="Fee per deal" subtitle="Added to every new deal" amount={pricingMoney(feeN, home)} chevron onClick={() => openSheet('fee')} />
              <Row title="Low margin warning" subtitle="Warn when a deal earns less than" amount={pctText(mFloor)} chevron onClick={() => openSheet('floor')} />
              <Row title="Round payouts" subtitle="Cash you hand over" amount={roundLabel} chevron onClick={() => openSheet('round')} />
            </Phone.ListSection>
            <Phone.ListSection title="Spread by currency">
              {foreign.map((code) => {
                const sp = (safe.spreads || {})[code];
                const custom = sp != null && sp !== '';
                return <Row key={code} title={code} subtitle={PHONE_CCY[code] || code} amount={pctText(custom ? sp : defSpread)} meta={custom ? 'custom' : 'default'} chevron onClick={() => openSheet('ccy', code)} />;
              })}
            </Phone.ListSection>
          </div>
        );
    const showPublish = feed === 'loading' || foreign.length > 0;
    let why = '';
    if (!canPublish) why = 'Only an owner or a manager can publish.';
    else if (feed === 'loading') why = 'The Rate Board is still loading.';
    const sticky = showPublish
      ? <Phone.StickyAction label={phase === 'publishing' ? 'Publishing…' : 'Publish to Rate Board'} disabled={feed === 'loading' || !canPublish || phase !== 'idle'} disabledReason={why} onClick={publish} />
      : null;
    const alerts = (feed === 'error' || banner) ? (
      <>
        {feed === 'error' ? <Phone.ErrorState message="The Rate Board didn't load." onRetry={() => setAttempt((n) => n + 1)} /> : null}
        {banner ? <p className="pr-fail" role="alert">{banner}</p> : null}
      </>
    ) : null;
    return (
      <>
        <Phone.Screen app="pricing" className="pr-phone" title="Pricing" subtitle="Changes save by themselves" banner={alerts} sticky={sticky}>
          {body}
        </Phone.Screen>
        {sheetEl}
        <PricingNote text={toast} />
      </>
    );
  }

  function Pricing(props) {
    const phone = usePhone();
    return phone ? <PhonePricing {...props} /> : <PricingDesk {...props} />;
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Pricing });
})();
