/* ============================================================
   CurrencyDesk OS: Rates, the Cost & stock tab and Record cash bought
   (Rates v2.5)

   A port of the design's Cost & stock tab and its "buy" sheet (handoff
   rates-v2.5, "CurrencyDesk Rates v2.5", the isStock and isBuy sections):
   the design's markup and style strings, turned into React styles by the
   Rates app's css().

   What the desk holds and what it cost, from the server:
   - GET /api/ledger/position: each currency's quantity, in the vault and
     this till, and its cost basis. A Rates plan is refused (the ledger is
     not in it); a role that cannot read the shop's earnings gets the
     quantities without the cost.
   - The market value and what selling now would make are the server's
     (the ledger values a holding at the rates the shop last published),
     never worked out here: the browser renders cash, it never computes it.
   - Running low: Settings vaultFloors, the Vault's reorder points.
   - Recent cash bought: GET /api/ledger/vault/movements.
   - The cost method: GET /api/ledger/cost-method.

   Record cash bought sends a delivery into the vault with what it cost
   (POST /api/ledger/vault/receipts, costHome), so the desk's average cost
   is real. Staff who may move vault cash record it (vault:move, the
   server's rule). The design also counts the notes by denomination; the
   ledger does not keep denominations, so that step is not here.

   A Rates plan shows the owner what Full System adds, and hides the tab
   from staff, as the design does.
   ============================================================ */
(function () {
  const { useState, useEffect, useCallback, useRef } = React;
  const B = window.CDOS.ratesBoard;
  const FACE = window.CurrencyFace;

  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
  const money = (v, dp = 0) => Number(v).toLocaleString('en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const units = (v) => Number(v).toLocaleString('en-CA', { maximumFractionDigits: 2 });
  const MOVERS = ['supervisor', 'branch_manager', 'administrator'];

  /* The desk's position as the Rates app reads it, the server's figures as
     they come (the browser renders cash, it never computes it): per
     currency the quantity, vault and this till, what one unit cost
     (avgCostHome), the basis, the market value and what selling it now
     would make; and the same totals for everything held. Null where the
     server does not know, or does not show this role. */
  function readPosition(pos) {
    const n = (v) => (v == null ? null : Number(v));
    const byCode = {};
    (pos.currencies || []).forEach(c => {
      byCode[c.currency] = { qty: Number(c.quantity), basis: n(c.costBasisHome), cost: n(c.avgCostHome), market: n(c.marketValueHome), gain: n(c.unrealizedPnlHome),
        vault: c.vault ? Number(c.vault.quantity) : 0, till: c.till ? Number(c.till.quantity) : 0 };
    });
    return { hasCost: 'costBasisHome' in pos, byCode, unpriced: pos.unpricedCurrencies || [],
      totals: { basis: n(pos.costBasisHome), market: n(pos.marketValueHome), gain: n(pos.unrealizedPnlHome) } };
  }

  /* ---- Record cash bought (the design's buy sheet, step one) ---- */
  function RecordCash({ code: first, onClose, onDone }) {
    const ui = window.CDOS.ratesUi;
    const { css, Flag, fx, getJson } = ui;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    /* The market and what is on hand, for the preview: the rate paid
       against the market, and the new average. */
    const [market, setMarket] = useState({});
    const [position, setPosition] = useState(null);
    useEffect(() => {
      const { orElse } = window.CDOS.ratesUi;
      Promise.all([getJson('/api/rates/market').catch(orElse('the market', { mids: null })), getJson('/api/rates').catch(orElse('the board', { board: null }))]).then(([f, r]) => {
        const mids = {};
        B.draftRows({ codes: window.CDOS.CCY || [], home, board: r.board, market: B.homeMarket(f.mids, home), settings: {} }).forEach(x => { if (x.mid) mids[x.code] = x.mid; });
        setMarket(mids);
      });
      getJson('/api/ledger/position').then(p => setPosition(readPosition(p)), (e) => { console.warn('[rates] the desk\'s cash could not be read for the preview', e); setPosition(null); });
    }, [home]);
    const codes = (window.CDOS.CCY || []).filter(c => c && c !== home);
    const [code, setCode] = useState(first && codes.includes(first) ? first : '');
    const [q, setQ] = useState('');
    const [amt, setAmt] = useState('');
    const [paid, setPaid] = useState('');
    const [from, setFrom] = useState('');
    const [kind, setKind] = useState('supplier');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    /* One key for this sheet: a retry after a lost answer is the same
       delivery, not a second one. */
    const key = useRef('rates-buy:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10));
    const closeRef = useRef(null);
    useEffect(() => {
      if (closeRef.current) closeRef.current.focus();
      const esc = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
      document.addEventListener('keydown', esc);
      return () => document.removeEventListener('keydown', esc);
    }, [busy, onClose]);

    const a = num(amt), p = num(paid);
    const rate = a > 0 && p > 0 ? p / a : null;
    const mid = code && market[code] ? market[code] : null;
    const held = code && position ? position.byCode[code] : null;
    const newAvg = rate && held && position.hasCost && held.basis !== null ? (held.basis + p) / (held.qty + a) : null;
    const off = rate && mid ? (rate / mid - 1) * 100 : null;
    const odd = off !== null && Math.abs(off) > 5;
    const ready = !!code && a > 0 && p > 0 && from.trim() && !busy;
    const shown = codes.filter(c => !q.trim() || c.toLowerCase().includes(q.trim().toLowerCase()) || FACE.currencyName(c).toLowerCase().includes(q.trim().toLowerCase()));
    const field = css('width:100%;height:44px;padding:0 13px;border-radius:11px;border:1px solid var(--line);background:#fff;outline:none;font-size:15px;color:var(--ink);box-sizing:border-box;');

    const record = async () => {
      if (!ready) return;
      setBusy(true); setErr('');
      try {
        const res = await fetch('/api/ledger/vault/receipts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          idempotencyKey: key.current, direction: 'in', currency: code, amount: a.toFixed(2),
          counterpartyType: kind, counterpartyRef: from.trim(), reason: 'Cash bought from ' + from.trim(), costHome: p.toFixed(2),
        }) });
        if (!res.ok) {
          let body = null;
          try { body = await res.json(); } catch (e) { body = null; }
          setErr(res.status === 403 ? 'Only a supervisor, manager or the owner can record cash into the vault.' : ((body && body.message) || 'The ledger refused this delivery (it answered ' + res.status + '). Nothing was recorded.'));
          return;
        }
        onDone(units(a) + ' ' + code + ' recorded at ' + fx(rate));
      } catch (e) {
        setErr('No connection. Nothing was recorded; try again.');
      } finally { setBusy(false); }
    };

    return (<div onClick={() => { if (!busy) onClose(); }} style={css('position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(23,20,15,0.32);animation:rtFade .2s ease both;')}>
      <div role="dialog" aria-modal="true" aria-label="Record cash bought" onClick={e => e.stopPropagation()} style={css('display:flex;flex-direction:column;width:min(560px, 100%);max-height:100%;background:#FBFAF7;overflow:hidden;border-radius:18px;box-shadow:0 40px 90px -30px rgba(23,20,15,0.6),0 0 0 1px rgba(23,20,15,0.08);animation:rtIn .26s cubic-bezier(.22,1,.36,1) both;')}>
        <div style={css('flex:none;display:flex;align-items:flex-start;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line);')}>
          <span style={css('flex:1;min-width:0;')}><span style={css('display:block;font-family:var(--m);font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--mute);')}>Vault</span><b style={css('display:block;font-size:19px;font-weight:800;margin-top:3px;')}>Record cash bought</b><span style={css('display:block;font-size:12.5px;color:var(--mute);margin-top:3px;')}>What came in, and what you paid for it. This is what makes your cost real.</span></span>
          <button ref={closeRef} type="button" onClick={onClose} disabled={busy} title="Close" aria-label="Close" style={css('flex:none;appearance:none;border:0;background:rgba(23,20,15,0.06);width:30px;height:30px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--mute);')}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <div style={css('flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;')}>
          <div>
            <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;')}><span style={css('font-size:13px;font-weight:700;')}>Currency</span><span style={css('flex:1;')} />
              <input aria-label="Find a currency" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a currency" style={css('flex:0 1 190px;min-width:140px;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:rgba(23,20,15,0.03);outline:none;font-size:13px;')} /></div>
            <div style={css('display:grid;grid-template-columns:repeat(auto-fill, minmax(104px, 1fr));gap:6px;max-height:176px;overflow-y:auto;')}>
              {shown.map(c => { const on = c === code; const h = position && position.byCode[c]; return (<button key={c} type="button" aria-pressed={on} onClick={() => setCode(c)}
                style={css('appearance:none;display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:10px;cursor:pointer;text-align:left;border:' + (on ? '1.5px solid var(--primary)' : '1px solid var(--line)') + ';background:' + (on ? 'var(--green-soft)' : '#fff') + ';')}>
                <Flag code={c} size={24} /><span style={css('min-width:0;line-height:1.15;')}><b style={css('display:block;font-family:var(--m);font-size:13px;')}>{c}</b><span style={css('display:block;font-size:10.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{h ? units(h.qty) + ' on hand' : FACE.currencyName(c)}</span></span></button>); })}
              {!shown.length && <span style={css('grid-column:1 / -1;padding:14px 4px;font-size:13px;color:var(--mute);')}>{'No currency matches “' + q + '”.'}</span>}
            </div>
          </div>
          <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;')}>
            <label style={css('display:block;')}><span style={css('display:block;font-size:13px;font-weight:700;margin-bottom:7px;')}>{'Amount you got · ' + (code || 'currency')}</span><input type="number" min="0" value={amt} onChange={e => setAmt(e.target.value)} placeholder="10000" style={field} /></label>
            <label style={css('display:block;')}><span style={css('display:block;font-size:13px;font-weight:700;margin-bottom:7px;')}>{'Total you paid · ' + home}</span><input type="number" min="0" value={paid} onChange={e => setPaid(e.target.value)} placeholder="13600" style={field} /></label>
          </div>
          <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;align-items:end;')}>
            <label style={css('display:block;')}><span style={css('display:block;font-size:13px;font-weight:700;margin-bottom:7px;')}>Bought from</span><input value={from} onChange={e => setFrom(e.target.value)} placeholder="Your wholesaler or bank" style={field} /></label>
            <span role="group" aria-label="Who sold it" style={css('display:inline-flex;gap:3px;padding:3px;border-radius:10px;background:rgba(23,20,15,0.06);justify-self:start;')}>
              {[['supplier', 'Wholesaler'], ['bank', 'Bank'], ['other', 'Other']].map(([v, l]) => (<button key={v} type="button" aria-pressed={kind === v} onClick={() => setKind(v)} style={css('appearance:none;border:0;cursor:pointer;font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:8px;background:' + (kind === v ? '#fff' : 'transparent') + ';color:' + (kind === v ? 'var(--ink)' : 'var(--mute)') + ';box-shadow:' + (kind === v ? '0 1px 3px rgba(23,20,15,0.14)' : 'none') + ';')}>{l}</button>))}
            </span>
          </div>
          <div style={css('font-size:12.5px;color:var(--mute);')}>It goes into the vault. Move it to a till from the Vault when you need it there.</div>
          {rate && <div style={css('flex:none;border-radius:13px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
            <div style={css('display:flex;align-items:center;gap:10px;padding:11px 14px;')}><span style={css('flex:1;min-width:0;font-size:13px;font-weight:600;')}>{'You paid ' + fx(rate) + ' ' + home + ' per ' + code}</span>{mid && <span style={css('font-family:var(--m);font-size:12px;color:var(--mute);')}>{'Market ' + fx(mid)}</span>}</div>
            {newAvg !== null && <div style={css('display:flex;align-items:center;gap:10px;padding:11px 14px;border-top:1px solid var(--hair);')}><span style={css('flex:1;min-width:0;font-size:13px;')}>New average cost</span><span style={css('font-family:var(--m);font-size:13px;font-weight:700;')}>{fx(newAvg)}</span></div>}
            {off !== null && <div style={css('padding:11px 14px;border-top:1px solid var(--hair);font-size:12.5px;line-height:1.5;color:' + (odd ? 'var(--clay)' : 'var(--mute)') + ';font-weight:' + (odd ? '600' : '400') + ';')}>{odd ? 'That is ' + Math.abs(off).toFixed(1) + '% ' + (off > 0 ? 'over' : 'under') + ' the market. Check the amount and what you paid before you record it.' : Math.abs(off).toFixed(2) + '% ' + (off >= 0 ? 'over' : 'under') + ' the market.'}</div>}
          </div>}
          {err && <div role="alert" style={css('flex:none;padding:11px 14px;border-radius:12px;background:var(--clay-soft);color:var(--clay);font-size:13px;font-weight:600;')}>{err}</div>}
          <div style={css('flex:none;display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:12px;background:rgba(23,20,15,0.04);font-size:12px;line-height:1.5;color:var(--mute);')}>Only for cash bought from a wholesaler or a bank. Cash a customer sells you at the counter is a deal, and goes through the Ledger.</div>
        </div>
        <div style={css('flex:none;display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--line);background:#fff;')}>
          <button type="button" onClick={onClose} disabled={busy} style={css('appearance:none;border:0;background:none;cursor:pointer;font-size:13px;font-weight:700;color:var(--mute);padding:8px 4px;')}>Cancel</button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={record} disabled={!ready} style={css('flex:none;appearance:none;border:0;border-radius:11px;padding:12px 20px;font-family:var(--m);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;cursor:' + (ready ? 'pointer' : 'not-allowed') + ';background:' + (ready ? 'var(--primary)' : 'rgba(23,20,15,0.08)') + ';color:' + (ready ? '#fff' : 'rgba(23,20,15,0.35)') + ';')}>{busy ? 'Recording…' : 'Record'}</button>
        </div>
      </div>
    </div>);
  }

  /* ---- the Cost & stock tab ---- */
  function RatesStock({ settings, serverRole, me, hasDeals, owns, onRecord, version, w }) {
    const ui = window.CDOS.ratesUi;
    const { css, Flag, fx, getJson, chip } = ui;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    const canMove = MOVERS.includes(serverRole || (me && me.role === 'Owner' ? 'administrator' : me && me.role === 'Manager' ? 'branch_manager' : 'teller'));
    const [data, setData] = useState({ loading: true, error: null, position: null, market: {}, board: null, moves: [], method: null });

    const load = useCallback(async () => {
      try {
        const [pos, feed, rates] = await Promise.all([getJson('/api/ledger/position'), getJson('/api/rates/market'), getJson('/api/rates')]);
        const [moves, cm] = await Promise.all([
          getJson('/api/ledger/vault/movements?limit=40').catch(ui.orElse('recent cash bought', { movements: [] })),
          getJson('/api/ledger/cost-method').catch(ui.orElse('the cost method', null)),
        ]);
        setData({ loading: false, error: null, position: readPosition(pos), market: B.homeMarket(feed.mids, home), board: rates.board, moves: moves.movements || [], method: cm && cm.method });
      } catch (e) {
        setData(d => ({ ...d, loading: false, error: e.message }));
      }
    }, [home]);
    useEffect(() => { if (hasDeals) load(); }, [load, hasDeals, version]);

    if (!hasDeals) {
      /* A Rates plan: the owner sees what Full System adds. */
      const upgrade = () => { if (window.CDOS.openSettingsTab) window.CDOS.openSettingsTab('billing'); else if (window.CDOS.openApp) window.CDOS.openApp('settings'); };
      return (<div style={css('max-width:640px;padding:26px;border-radius:20px;background:#fff;border:1px solid var(--line);')}>
        <span style={css('display:inline-flex;align-items:center;gap:7px;font-family:var(--m);font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:var(--mute);background:rgba(23,20,15,0.05);padding:5px 10px;border-radius:999px;')}><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Full System and AI Bundle</span>
        <h2 style={css('margin:14px 0 0;font-size:24px;font-weight:800;letter-spacing:-0.02em;')}>Know what you actually make</h2>
        <p style={css('font-size:14px;line-height:1.6;color:var(--mute);margin:8px 0 0;')}>You're on Rates. You price against the market, which is all a board needs. Full System adds the vault, so the desk knows what you paid for every note.</p>
        <div style={css('display:flex;flex-direction:column;gap:9px;margin-top:16px;')}>{['What every currency cost you, and what it is worth now', 'What you would make selling it today', 'What is running low, before a customer asks for it', 'Deals, commission and a check on every deal before it posts'].map(u => (<span key={u} style={css('display:flex;align-items:flex-start;gap:9px;font-size:13.5px;line-height:1.5;')}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#1D6B45" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 3 }}><path d="M4 12.5l5 5L20 6.5" /></svg>{u}</span>))}</div>
        {owns && <div style={css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:20px;')}><button type="button" onClick={upgrade} style={css('flex:none;appearance:none;height:40px;padding:0 16px;border-radius:11px;border:0;background:var(--ink);color:#fff;font-size:13px;font-weight:700;cursor:pointer;')}>See Full System</button><span style={css('font-size:12.5px;color:var(--faint);')}>Your board, website and window keep working either way.</span></div>}
      </div>);
    }
    if (data.loading) return <div style={css('padding:30px;text-align:center;font-size:13.5px;color:var(--mute);')}>Loading your cash…</div>;
    if (data.error || !data.position) return <div role="alert" style={css('padding:16px 18px;border-radius:14px;background:#fff;border:1px solid var(--line);font-size:13.5px;color:var(--mute);')}>{'The desk’s cash could not be read (' + (data.error || 'no answer') + '). Your board is not affected.'}</div>;

    const pos = data.position;
    const drafted = B.draftRows({ codes: window.CDOS.CCY || [], home, board: data.board, market: data.market, settings });
    const onBoard = new Set(drafted.filter(r => r.show).map(r => r.code));
    const floors = settings.vaultFloors || {};
    const codes = Object.keys(pos.byCode).filter(c => c !== home).sort((a, b) => (onBoard.has(b) ? 1 : 0) - (onBoard.has(a) ? 1 : 0) || a.localeCompare(b));
    const lines = codes.map(c => {
      const h = pos.byCode[c];
      const atCost = pos.hasCost && h.basis !== null ? h.basis : null;
      const atMkt = h.market;
      const gain = h.gain;
      const low = num(floors[c]);
      const status = h.qty <= 0 ? 'none' : (low > 0 && h.qty < low ? 'low' : 'ok');
      const fill = low > 0 ? Math.min(100, h.qty / (low * 2) * 100) : (h.qty > 0 ? 60 : 0);
      return { c, h, atCost, atMkt, gain, status, fill };
    });
    /* The totals are the server's, over everything held (the home
       currency included), only when it knows every row. */
    const totCost = pos.hasCost ? pos.totals.basis : null, totMkt = pos.totals.market, totGain = pos.totals.gain;
    const lowList = lines.filter(l => l.status !== 'ok').map(l => l.c);
    const big = (v, tone) => css('font-family:var(--m);font-size:20px;font-weight:700;margin-top:5px;color:' + tone + ';');
    const stats = [
      { label: 'Cash at cost', value: totCost !== null ? home + ' ' + money(totCost) : '·', note: pos.hasCost ? 'What you paid for everything on hand' : 'Your role does not see what the cash cost', vStyle: big(0, 'var(--ink)') },
      { label: 'At market', value: totMkt !== null ? home + ' ' + money(totMkt) : '·', note: totMkt !== null ? 'At the rates you last published' : 'Not known for every currency held', vStyle: big(0, 'var(--primary-deep)') },
      { label: 'If sold at market', value: totGain !== null ? (totGain >= 0 ? '+' : '−') + home + ' ' + money(Math.abs(totGain)) : '·', note: 'Before spread or fees', vStyle: big(0, totGain !== null && totGain < 0 ? 'var(--clay)' : 'var(--primary-deep)') },
      { label: 'Running low', value: String(lowList.length), note: lowList.length ? lowList.join(', ') + ' below the line' : 'Nothing below its reorder point', vStyle: big(0, lowList.length ? 'var(--clay)' : 'var(--ink)') },
    ];
    const wide = (w || 1280) >= 880;
    const cols = 'display:grid;grid-template-columns:minmax(170px,1.7fr) minmax(110px,1fr) minmax(84px,0.8fr) minmax(90px,0.9fr) minmax(90px,0.9fr) minmax(90px,0.9fr) 110px;gap:12px;';
    const methodName = data.method === 'fifo' ? 'FIFO' : 'Average';
    const bought = (data.moves || []).filter(m => m.direction === 'in' && (m.counterpartyType === 'supplier' || m.counterpartyType === 'bank')).slice(0, 5);
    const when = (iso) => { const t = Date.parse(iso); if (!isFinite(t)) return ''; const { deskTime, deskDay } = window.CDOS; const zone = settings && settings.timezone; return deskDay(t, zone) === deskDay(Date.now(), zone) ? deskTime(t, settings && settings.timeFormat, zone) : deskDay(t, zone); };
    const statusChip = (s) => ({ ...chip(s === 'ok' ? 'green' : s === 'low' ? 'red' : 'amber'), fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' });
    const statusText = (s) => (s === 'ok' ? 'In stock' : s === 'low' ? 'Reorder now' : 'None on hand');
    const primaryBtn = css('flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:700;border:0;background:var(--primary);color:#fff;cursor:pointer;');

    return (<div style={css('display:flex;flex-direction:column;gap:14px;')}>
      <div style={css('display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:1px;border-radius:16px;overflow:hidden;background:var(--line);border:1px solid var(--line);')}>
        {stats.map(g => (<div key={g.label} style={css('padding:14px 16px;background:#fff;')}><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>{g.label}</div><div style={g.vStyle}>{g.value}</div><div style={css('font-size:12px;color:var(--mute);margin-top:3px;')}>{g.note}</div></div>))}
      </div>

      <section aria-label="By currency" style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
        <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 16px;border-bottom:1px solid var(--line);')}>
          <b style={css('flex:1 1 160px;display:inline-flex;align-items:center;gap:8px;font-size:14.5px;')}>By currency</b>
          <span style={css('border:1px solid var(--line);background:rgba(23,20,15,0.03);border-radius:999px;padding:6px 11px;font-family:var(--m);font-size:10.5px;color:var(--mute);')}>{'Cost method · ' + methodName}</span>
          {canMove && <button type="button" onClick={() => onRecord(null)} style={primaryBtn}>Record cash bought</button>}
        </div>
        {wide && lines.length > 0 && <div style={css(cols + 'padding:11px 16px;background:rgba(23,20,15,0.035);border-bottom:1px solid var(--line);font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}><span>Currency</span><span style={{ textAlign: 'right' }}>On hand</span><span style={{ textAlign: 'right' }}>Avg cost</span><span style={{ textAlign: 'right' }}>At cost</span><span style={{ textAlign: 'right' }}>At market</span><span style={{ textAlign: 'right' }}>If sold now</span><span style={{ textAlign: 'right' }}>Stock</span></div>}
        {!lines.length && <div style={css('padding:16px;font-size:13.5px;color:var(--mute);')}>The vault and this till hold no foreign cash yet. Record cash bought when a delivery comes in.</div>}
        {lines.map((l, i) => {
          const head = (<span style={css('display:flex;align-items:center;gap:11px;min-width:0;')}><Flag code={l.c} size={30} /><span style={css('min-width:0;flex:1;')}><span style={css('display:flex;align-items:baseline;gap:7px;')}><b style={css('font-size:14.5px;font-weight:800;')}>{l.c}</b>{onBoard.has(l.c) && <span style={css('font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>On board</span>}</span><span style={css('display:block;height:4px;border-radius:999px;background:rgba(23,20,15,0.07);margin-top:6px;overflow:hidden;')}><span style={css('display:block;height:100%;width:' + l.fill + '%;background:' + (l.status === 'ok' ? 'var(--primary)' : 'var(--clay)') + ';')} /></span></span></span>);
          const cells = [
            ['On hand', <><span style={css('font-family:var(--m);font-size:13px;')}>{units(l.h.qty)}</span><span style={css('display:block;font-size:11px;color:var(--faint);white-space:nowrap;')}>{'Vault ' + units(l.h.vault) + ' · your till ' + units(l.h.till)}</span></>],
            ['Avg cost', <span style={css('font-family:var(--m);font-size:13px;')}>{pos.hasCost && l.h.cost ? fx(l.h.cost) : '·'}</span>],
            ['At cost', <span style={css('font-family:var(--m);font-size:13px;')}>{l.atCost !== null ? money(l.atCost) : '·'}</span>],
            ['At market', <span style={css('font-family:var(--m);font-size:13px;')}>{l.atMkt !== null ? money(l.atMkt) : '·'}</span>],
            ['If sold now', <span style={css('font-family:var(--m);font-size:13px;font-weight:700;color:' + (l.gain === null ? 'var(--mute)' : l.gain < 0 ? 'var(--clay)' : 'var(--primary-deep)') + ';')}>{l.gain === null ? '·' : (l.gain >= 0 ? '+' : '−') + money(Math.abs(l.gain))}</span>],
          ];
          if (wide) return (<div key={l.c} data-stock-row={l.c} style={css(cols + 'align-items:center;padding:12px 16px;' + (i ? 'border-top:1px solid var(--hair);' : ''))}>{head}{cells.map(([k, v]) => <span key={k} style={css('text-align:right;min-width:0;')}>{v}</span>)}<span style={css('text-align:right;')}><span style={statusChip(l.status)}>{statusText(l.status)}</span></span></div>);
          return (<div key={l.c} data-stock-row={l.c} style={css('padding:13px 16px;' + (i ? 'border-top:1px solid var(--hair);' : ''))}>
            <div style={css('display:flex;align-items:center;gap:10px;')}>{head}<span style={statusChip(l.status)}>{statusText(l.status)}</span></div>
            <div style={css('display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:8px 12px;margin-top:10px;')}>{cells.map(([k, v]) => (<span key={k}><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>{k}</span>{v}</span>))}</div>
          </div>);
        })}
      </section>

      <section aria-label="Recent cash bought" style={css('padding:16px;border-radius:16px;background:#fff;border:1px solid var(--line);')}>
        <div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);margin-bottom:6px;')}>Recent cash bought</div>
        {!bought.length && <div style={css('font-size:13px;color:var(--mute);padding:6px 0;')}>No deliveries recorded yet.</div>}
        {bought.map((m, i) => (<div key={m.movementId || i} style={css('display:flex;align-items:center;gap:10px;padding:9px 0;' + (i ? 'border-top:1px solid var(--hair);' : ''))}><span style={css('flex:1;min-width:0;')}><b style={css('font-size:13px;')}>{units(m.amount) + ' ' + m.currency}</b><span style={css('display:block;font-size:11.5px;color:var(--mute);')}>{m.counterpartyRef}</span></span><span style={css('font-size:11px;color:var(--faint);')}>{when(m.createdAt)}</span></div>))}
      </section>

      {pos.hasCost && pos.unpriced.length > 0 && <div style={css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 15px;border-radius:14px;background:var(--amber-soft);font-size:13px;line-height:1.45;')}><span style={css('flex:1 1 240px;min-width:0;')}><b>{pos.unpriced.join(', ') + ' cost is not known.'}</b> Profit on it isn't real until a delivery comes in with what you paid.</span></div>}
      {window.CDOS.openApp && <button type="button" onClick={() => window.CDOS.openApp('vault')} style={css('align-self:flex-start;appearance:none;border:0;background:none;padding:0;cursor:pointer;font-size:13px;font-weight:600;color:var(--primary);')}>Counts, moves and ordering are in the Vault →</button>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { RatesStock, RatesRecordCash: RecordCash, ratesReadPosition: readPosition });
})();
