/* ============================================================
   CurrencyDesk OS — Pricing Console  (roadmap #5)
   The owner's profit lever in one place. Reads & writes the SAME
   settings keys the Ledger prices from (settings.spreads, defaultSpread,
   defaultFee, marginFloor/Target/Enforce, payoutRound*, rateProvider) —
   so this is a richer cockpit over the one source of truth, never a fork.
   Every edit recomputes the live buy/sell rates and the deal simulator.
   ============================================================ */
(function () {
  const { useState, useMemo } = React;
  const { CD, Ic, CCY, crossRate, fmt, num, priceDeal, spreadOf, buyUnitCad, sellUnitCad, roundPayout } = window.CDOS;

  const NAME = { CAD: 'Canadian Dollar', USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', INR: 'Indian Rupee', PHP: 'Philippine Peso', CNY: 'Chinese Yuan', MXN: 'Mexican Peso', AED: 'UAE Dirham' };
  const FOREIGN = (CCY || []).filter(c => c !== 'CAD');
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

  function Pricing({ settings, setSettings, me, log }) {
    const set = (k, v, note) => { setSettings(s => ({ ...s, [k]: v })); if (note && log) log('Pricing updated', note); };
    const setSpread = (code, v) => setSettings(s => ({ ...s, spreads: { ...(s.spreads || {}), [code]: v } }));
    const clearSpread = (code) => setSettings(s => { const sp = { ...(s.spreads || {}) }; delete sp[code]; return { ...s, spreads: sp }; });
    // ---- manual spot override: editing a spot PINS it (stops pulling from the
    // source feed) until reset. The source of truth is the feed; a pin is a
    // deliberate deviation the owner owns. ----
    const ov = settings.spotOverride || {};
    const isPinned = (c) => ov[c] != null && ov[c] !== '';
    const spotOf = (c) => c === 'CAD' ? 1 : (isPinned(c) ? +ov[c] : (crossRate(c, 'CAD') || 0));
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
    const [sim, setSim] = useState({ inCcy: 'CAD', outCcy: 'USD', inAmt: '1000' });
    const simP = useMemo(() => {
      const inC = sim.inCcy, outC = sim.outCcy, amt = parseFloat(sim.inAmt) || 0;
      const sprdOf = (c) => c === 'CAD' ? 0 : spreadOf(c, settings);
      const inUnit = inC === 'CAD' ? 1 : spotOf(inC) * (1 - sprdOf(inC));
      const outUnit = outC === 'CAD' ? 1 : spotOf(outC) * (1 + sprdOf(outC));
      const rate = outUnit ? inUnit / outUnit : 0;
      const outAmt = roundPayout(amt * rate, settings);
      const midIn = amt * (inC === 'CAD' ? 1 : spotOf(inC));
      const midOut = outAmt * (outC === 'CAD' ? 1 : spotOf(outC));
      const midRate = (outC === 'CAD' ? 1 : spotOf(outC)) ? (inC === 'CAD' ? 1 : spotOf(inC)) / (outC === 'CAD' ? 1 : spotOf(outC)) : 0;
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
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Spot · CAD</th>
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
                const liveMid = crossRate(c, 'CAD') || 0;
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
                  <td style={{ padding: '8px 16px', textAlign: 'right', fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums', color: CD.ink, fontWeight: 600 }}>{'$' + perUnit.toFixed(3)}</td>
                </tr>); })}</tbody>
            </table>
            <div className="flex items-center gap-4 text-[11px]" style={{ padding: '10px 16px', borderTop: `1px solid ${CD.lineSoft}`, color: CD.faint }}>
              <span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.flag }}></span> We buy — CAD we pay per unit acquired</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: CD.green }}></span> We sell — CAD we charge per unit released</span>
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
                <span className="text-[12.5px]" style={{ fontFamily: 'Space Mono, monospace', color: CD.ink }}>$1,234.567 <span style={{ color: CD.faint }}>→</span> <b>{fmt(roundEx, 'CAD')}</b></span>
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
                <div className="px-2.5 py-2" style={{ background: simZone === CD.green ? CD.greenSoft : simZone === CD.amber ? CD.amberSoft : CD.flagSoft, borderRadius: 8 }}><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Margin</div><div className="text-[13px] font-semibold" style={{ color: simZone, fontVariantNumeric: 'tabular-nums' }}>{fmt(simP.marginCad, 'CAD')} · {simPct.toFixed(2)}%</div></div>
              </div>
              <div className="text-[10.5px] mt-2" style={{ color: CD.faint }}>Priced exactly as the Ledger would, with your spreads &amp; rounding above. Edit a spread and watch it move.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Pricing });
})();
