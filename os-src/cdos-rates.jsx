/* ============================================================
   CurrencyDesk OS: Rates (Rates v2.5, the desk side, part one)

   One app for the shop's rates, in place of the Rate Board page. The
   Board tab shows every currency the desk trades: the market, what the
   desk buys and sells at, and whether it is on the board. Publish sends
   the board to the server (POST /api/rates/publish, append-only
   rate_boards), and every surface the shop's customers see reads that
   publish. Pricing & rates is the existing Pricing console, unchanged.

   The server is the record. The board loads from GET /api/rates (this
   desk's own branch), the market from GET /api/rates/ticker (already in
   the shop's home currency), recent publishes from GET /api/rates/history.
   The publish rights are the server's (rates:change); the screen only
   mirrors them so nobody types into a board they cannot publish.
   ============================================================ */
(function () {
  const { useState, useEffect, useMemo, useCallback } = React;
  const { CD, Ic } = window.CDOS;
  const B = window.CDOS.ratesBoard;

  /* The roles that hold rates:change on the server (auth/permissions.ts). */
  const PUBLISHERS = ['branch_manager', 'administrator'];

  const card = { background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 13 };
  const mono = { fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums' };
  const label = { color: CD.faint, fontFamily: 'Space Mono, monospace', fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700 };

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }
  function when(ms, settings) {
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    const t = window.CDOS.deskTime ? window.CDOS.deskTime(d, settings && settings.timeFormat) : d.toLocaleTimeString();
    return sameDay ? t : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  const six = (n) => (n >= 1 ? n.toFixed(4) : n >= 0.01 ? n.toFixed(5) : n.toFixed(6));

  function Toggle({ on, onClick, disabled, name }) {
    return (<button type="button" role="switch" aria-checked={on} aria-label={name} disabled={disabled} onClick={onClick}
      className="w-11 h-6 relative flex-none" style={{ background: on ? CD.green : 'var(--cd-disabled)', borderRadius: 999, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .15s' }}>
      <span className="absolute top-0.5 w-5 h-5" style={{ left: on ? 22 : 2, background: 'var(--cd-panel)', borderRadius: 999, transition: 'left .15s' }} />
    </button>);
  }

  function Board({ settings, serverRole, me, log }) {
    const canPublish = PUBLISHERS.includes(serverRole);
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    const defPct = settings.defaultSpread != null && settings.defaultSpread !== '' ? +settings.defaultSpread : B.DEFAULT_SPREAD_PCT;
    const floor = settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const target = settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const [data, setData] = useState({ loading: true, error: null, board: null, history: [], market: {} });
    const [edits, setEdits] = useState({ order: null, show: {} });
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);

    const load = useCallback(async () => {
      try {
        const [rates, history, ticker] = await Promise.all([getJson('/api/rates'), getJson('/api/rates/history'), getJson('/api/rates/ticker')]);
        const market = {};
        (ticker.priced ? ticker.quotes : []).forEach(t => { market[t.code] = t.mid; });
        setData({ loading: false, error: null, board: rates.board, history: history.publications || [], market });
      } catch (e) {
        setData(d => ({ ...d, loading: false, error: 'The board could not be loaded (' + e.message + '). Nothing has changed for customers.' }));
      }
    }, []);
    useEffect(() => { load(); }, [load]);

    const rows = useMemo(() => {
      const base = B.draftRows({ codes: window.CDOS.CCY || [], home, board: data.board, market: data.market, settings })
        .map(r => (edits.show[r.code] === undefined ? r : { ...r, show: edits.show[r.code] }));
      if (!edits.order) return base;
      const at = (c) => { const i = edits.order.indexOf(c); return i < 0 ? edits.order.length : i; };
      return base.slice().sort((a, b) => at(a.code) - at(b.code));
    }, [data, edits, settings, home]);

    /* Two different things. A change is something somebody did here: on or
       off, order, a spread or a pinned rate. That is compared at the
       published mids. The market moving since the last publish is not a
       change anyone made; it gets its own line, and Publish sends it. */
    const atPublishedMids = data.board ? rows.map(r => (!r.pinned && data.board.rows[r.code] ? { ...r, mid: Number(data.board.rows[r.code].mid) } : r)) : rows;
    const dirty = !B.sameAsPublished(atPublishedMids, data.board, defPct);
    const marketMoved = !dirty && !B.sameAsPublished(rows, data.board, defPct);
    const canSend = canPublish && (dirty || marketMoved) && !busy;
    const move = (code, by) => setEdits(e => {
      const order = rows.map(r => r.code);
      const i = order.indexOf(code), j = i + by;
      if (i < 0 || j < 0 || j >= order.length) return e;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...e, order };
    });
    const toggle = (r) => setEdits(e => ({ ...e, show: { ...e.show, [r.code]: !r.show } }));

    const publish = async () => {
      setNotice(null);
      const out = B.publishBody(rows, defPct);
      if (!out.ok) {
        setNotice(out.missing.length
          ? `No rate for ${out.missing.join(', ')}. Take it off the board, or pin a rate in Pricing & rates.`
          : 'A spread is over 20%. Lower it in Pricing & rates.');
        return;
      }
      setBusy(true);
      try {
        const res = await fetch('/api/rates/publish', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out.body) });
        if (!res.ok) {
          setNotice(res.status === 403 ? 'Only the owner and managers can publish rates.' : `Publish failed (the server answered ${res.status}). Customers still see your last publish.`);
          return;
        }
        const saved = (await res.json()).board;
        /* The desk's rate engine reads this browser cache (cdos-os.jsx,
           publishedBook). The server board is the record; this only spares
           the desk a reload before its next deal prices off the new board. */
        try {
          const cache = JSON.stringify({ buyMargin: saved.buyMargin, sellMargin: saved.sellMargin, rows: saved.rows, publishedAt: saved.publishedAt, publishedBy: saved.publishedBy });
          localStorage.setItem('yorkfx_rates_v1', cache);
          localStorage.setItem('yorkfx_board_order', JSON.stringify(saved.order || out.body.order));
          window.dispatchEvent(new StorageEvent('storage', { key: 'yorkfx_rates_v1', newValue: cache }));
        } catch (e) { console.warn('[rates] the browser cache was not updated; the desk reloads the board on its next read', e); }
        if (log) log('Rates published', `${out.body.order.length} currencies · default ${defPct}% · by ${me ? me.name : 'staff'}`);
        setEdits({ order: null, show: {} });
        setNotice('Published. Your site and window screens show it now.');
        await load();
      } catch (e) {
        setNotice('No connection. Nothing was published.');
      } finally { setBusy(false); }
    };

    const list = rows.filter(r => !q.trim() || r.code.toLowerCase().includes(q.trim().toLowerCase()));
    const onBoard = rows.filter(r => r.show).length;
    const pub = data.board;
    const preview = pub ? (pub.order || Object.keys(pub.rows)).filter(c => pub.rows[c] && pub.rows[c].show !== false).map(c => {
      const r = pub.rows[c];
      const pct = (m) => (r.spread != null ? r.spread : m) * 100;
      return { code: c, ...B.deskPair(r.mid, pct(pub.buyMargin), pct(pub.sellMargin)) };
    }) : [];
    const tone = (pct) => pct < floor ? [CD.flag, CD.flagSoft] : pct < target ? [CD.amber, CD.amberSoft] : [CD.green, CD.greenSoft];

    if (data.loading) return <div className="p-6 text-[13px]" style={{ color: CD.mute }}>Loading your board…</div>;
    return (<div className="rates-board">
      {data.error && <div role="alert" className="text-[12.5px] px-3 py-2.5" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 9 }}>{data.error}</div>}
      <div style={{ ...card, overflow: 'auto' }}>
        <div className="flex items-center gap-2" style={{ padding: 12, borderBottom: `1px solid ${CD.lineSoft}` }}>
          <Ic n="search" s={14} c={CD.faint} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a currency" aria-label="Find a currency" className="flex-1 text-[13px] outline-none bg-transparent" style={{ color: CD.ink }} />
        </div>
        <table className="w-full rates-table" style={{ borderCollapse: 'collapse' }}>
          <thead><tr className="text-left" style={label}>
            <th style={{ padding: '9px 14px' }}>Currency</th><th className="rc-wide" style={{ textAlign: 'right' }}>Market</th><th style={{ textAlign: 'right' }}>We buy</th>
            <th style={{ textAlign: 'right' }}>We sell</th><th className="rc-wide" style={{ textAlign: 'right' }}>Over market</th><th style={{ textAlign: 'center' }}>On board</th><th aria-label="Order" />
          </tr></thead>
          <tbody>{list.map((r, i) => {
            const pair = r.mid ? B.deskPair(r.mid, r.spreadPct, r.spreadPct) : null;
            const [fg, bg] = tone(r.spreadPct);
            return (<tr key={r.code} style={{ borderTop: `1px solid ${CD.lineSoft}`, opacity: r.show ? 1 : 0.6 }}>
              <td style={{ padding: '10px 14px' }}><b className="text-[13.5px]" style={{ color: CD.ink }}>{r.code}</b>{r.pinned && <span className="ml-2 text-[10px]" style={{ color: CD.amber }}>pinned</span>}</td>
              <td className="rc-wide" style={{ ...mono, textAlign: 'right', color: CD.mute }}>{r.mid ? six(r.mid) : 'No rate'}</td>
              <td style={{ ...mono, textAlign: 'right', color: CD.ink }}>{pair ? six(pair.buy) : '·'}</td>
              <td style={{ ...mono, textAlign: 'right', color: CD.ink, fontWeight: 700 }}>{pair ? six(pair.sell) : '·'}</td>
              <td className="rc-wide" style={{ textAlign: 'right' }}><span className="text-[11.5px] px-2 py-0.5" style={{ ...mono, background: bg, color: fg, borderRadius: 7, fontWeight: 700 }}>{r.spreadPct.toFixed(2)}%</span></td>
              <td style={{ textAlign: 'center' }}><Toggle on={r.show} disabled={!canPublish} onClick={() => toggle(r)} name={`${r.code} on the board`} /></td>
              <td style={{ padding: '0 10px', whiteSpace: 'nowrap' }}>
                <button type="button" aria-label={`Move ${r.code} up`} disabled={!canPublish || i === 0 || !!q} onClick={() => move(r.code, -1)} style={{ opacity: canPublish && i > 0 && !q ? 1 : 0.3 }}><Ic n="arrowup" s={13} c={CD.mute} /></button>
                <button type="button" aria-label={`Move ${r.code} down`} disabled={!canPublish || i === list.length - 1 || !!q} onClick={() => move(r.code, 1)} style={{ opacity: canPublish && i < list.length - 1 && !q ? 1 : 0.3 }}><Ic n="arrowdown" s={13} c={CD.mute} /></button>
              </td>
            </tr>);
          })}</tbody>
        </table>
        {!list.length && <div className="p-4 text-[12.5px]" style={{ color: CD.mute }}>No currency matches “{q}”.</div>}
        <div className="text-[11.5px]" style={{ padding: '10px 14px', borderTop: `1px solid ${CD.lineSoft}`, color: CD.faint }}>{onBoard} of {rows.length} on the board · the top six show on your homepage</div>
      </div>
      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <div style={{ ...card, padding: 14 }}>
          <div className="flex items-center gap-2 text-[13px] font-semibold px-3 py-2.5" style={{ borderRadius: 9, background: dirty ? CD.amberSoft : CD.greenSoft, color: dirty ? CD.amber : CD.green }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'currentColor' }} />{dirty ? 'Unpublished changes' : 'Live on your site and window'}
          </div>
          {marketMoved && <div className="text-[12px] mt-2" style={{ color: CD.mute }}>The market has moved since this publish. Publish to send today's rates.</div>}
          <button type="button" onClick={publish} disabled={!canSend} className="w-full mt-3 text-[13px] font-bold"
            style={{ height: 46, borderRadius: 12, letterSpacing: '0.14em', textTransform: 'uppercase', background: canSend ? CD.green : 'var(--cd-chip)', color: canSend ? '#fff' : CD.faint }}>{busy ? 'Publishing…' : 'Publish'}</button>
          {notice && <div role="status" className="text-[12px] mt-2" style={{ color: CD.ink }}>{notice}</div>}
          <div className="text-[11.5px] mt-3" style={{ color: CD.mute }}>{pub ? `Updated ${ago(pub.publishedAt)} by ${pub.publishedBy || 'the market feed'}` : 'Nothing published yet'}</div>
          <div className="mt-3" style={label}>Recent publishes</div>
          {data.history.slice(0, 3).map(h => (<div key={h.publicationId} className="flex items-center gap-2 text-[11.5px] mt-1.5" style={{ color: CD.mute }}>
            <b style={{ color: CD.ink, minWidth: 64 }}>{when(h.publishedAt, settings)}</b><span className="flex-1 truncate">{h.publishedBy || 'market feed'}</span>
            <span style={mono}>{Object.keys(h.rows || {}).length} ccy · {(Number(h.sellMargin) * 100).toFixed(1)}%</span>
          </div>))}
        </div>
        <section aria-label="What customers see now" style={{ ...card, padding: 14, background: CD.ink, color: 'var(--cd-on-ink)' }}>
          <div style={{ ...label, color: 'var(--cd-on-ink-faint)' }}>What customers see now</div>
          {dirty && <div className="text-[11.5px] mt-2" style={{ color: 'var(--cd-on-ink)' }}><b>Your changes aren't live yet.</b> Customers see your last publish.</div>}
          {!preview.length && <div className="text-[12px] mt-2">Nothing published yet.</div>}
          {preview.map(p => (<div key={p.code} className="flex items-center gap-3 text-[12.5px] mt-2" style={mono}>
            <b className="flex-1">{p.code}</b><span style={{ color: 'var(--cd-on-ink-faint)' }}>{six(p.buy)}</span><span style={{ fontWeight: 700 }}>{six(p.sell)}</span>
          </div>))}
        </section>
      </div>
    </div>);
  }

  function Rates({ settings, setSettings, me, log, serverRole }) {
    const [tab, setTab] = useState('board');
    const canPublish = PUBLISHERS.includes(serverRole);
    const Pricing = window.CDOS.Pricing;
    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper, overflow: 'hidden' }}>
      <div className="fld-bar fld-pinned">
        {[['board', 'Board', 'rateboard'], ['site', 'Website & window', 'globe'], ['pricing', 'Pricing & rates', 'percent']].map(([id, name, icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}><Ic n={icon} s={13} c={tab === id ? '#fff' : CD.mute} /> {name}</button>))}
      </div>
      {!canPublish && <div className="flex items-center gap-2 text-[12.5px] px-5 py-2.5" style={{ background: 'var(--cd-chip)', color: CD.mute }}><Ic n="info" s={14} c={CD.mute} /> You can see today's rates. Changing them is for the owner and managers.</div>}
      <div className="flex-1 overflow-auto rates-scroll">
        {tab === 'board' && <Board settings={settings} serverRole={serverRole} me={me} log={log} />}
        {tab === 'site' && <window.CDOS.RatesSite serverRole={serverRole} />}
        {tab === 'pricing' && <Pricing settings={settings} setSettings={setSettings} me={me} log={log} />}
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Rates });
})();
