/* ============================================================
   CurrencyDesk OS: Rates (Rates v2.5)

   One app for the shop's rates, in place of the Rate Board page. It is a
   port of Sol's design (handoff rates-v2.5, "CurrencyDesk Rates v2.5"):
   the header, folder tabs, Board table and cards, publish rail and "What
   customers see now" keep the design's own markup, copy and style strings.
   The design's style strings are kept word for word and turned into React
   styles by css() below, so a reviewer can hold the two side by side.

   The server is the record. The board loads from GET /api/rates (this
   desk's own branch), the market from GET /api/rates/market (raw mids,
   converted to the shop's home currency without rounding), recent
   publishes from GET /api/rates/history, and the shop's window screens
   from GET /api/window-screens. Publish sends POST /api/rates/publish
   (append-only rate_boards); every surface the shop's customers see reads
   that publish. The publish rights are the server's (rates:change); the
   screen only mirrors them so nobody types into a board they cannot
   publish.
   ============================================================ */
(function () {
  const { useState, useEffect, useMemo, useCallback, useRef } = React;
  const B = window.CDOS.ratesBoard;
  const FACE = window.CurrencyFace;

  /* The roles that hold rates:change on the server (auth/permissions.ts). */
  const PUBLISHERS = ['branch_manager', 'administrator'];

  /* The design's style strings, as written, into a React style object.
     Custom properties (--name) keep their names. */
  function css(text) {
    const out = {};
    String(text || '').split(';').forEach(rule => {
      const at = rule.indexOf(':');
      if (at < 0) return;
      const key = rule.slice(0, at).trim();
      const value = rule.slice(at + 1).trim();
      if (!key || !value) return;
      out[key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    });
    return out;
  }

  /* The design's tokens (data-rates), scoped to this window. */
  const TOKENS = css("--f: 'Archivo', system-ui, sans-serif; --m: 'Space Mono', monospace; --ink: #17140F; --mute: #6E675E; --faint: #9a938a; --line: rgba(23,20,15,0.12); --hair: rgba(23,20,15,0.07); --primary: #1D6B45; --primary-deep: #17583A; --green-soft: #E2EFE8; --amber: #9a6b1f; --amber-soft: #f5e8cf; --lock: #e0a106; --lock-soft: rgba(224,161,6,0.12); --lock-text: #6b5119; --clay: #C2452D; --clay-soft: #F6E3DE; font-family: var(--f); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; color: var(--ink);");

  const TIPS = {
    publish: ['Publishing', 'Nothing you change here reaches customers until you press Publish. Then your website and window screen update together, and the change is logged with your name. Auto-publish does it for you every time the market refreshes.'],
  };

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  /* The design's "1h 41m ago". */
  function ago(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return mins < 1 ? 'just now' : (mins < 60 ? mins + 'm ago' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago');
  }
  /* The desk's one clock (cdos-desk-time.js): today's publishes by the
     time on the branch clock, older ones by their civil date there. */
  function when(ms, settings) {
    const zone = settings && settings.timezone;
    const { deskTime, deskDay } = window.CDOS;
    return deskDay(ms, zone) === deskDay(Date.now(), zone) ? deskTime(ms, settings && settings.timeFormat, zone) : deskDay(ms, zone);
  }
  /* The design's fx(): four places at 1 and over, more for small units. */
  function fx(v) { const a = Math.abs(v); return a >= 1 ? v.toFixed(4) : (a >= 0.01 ? v.toFixed(5) : (a >= 0.0001 ? v.toFixed(6) : v.toFixed(8))); }

  /* The design's flag box, with the shop's image or its emoji. */
  function Flag({ code, size }) {
    const w = size || 30, h = Math.round(w * 0.68);
    const url = FACE.flagUrl(code);
    const box = 'flex:none;width:' + w + 'px;height:' + h + 'px;border-radius:4px;box-shadow:0 0 0 1px rgba(23,20,15,0.1);background:rgba(23,20,15,0.06) center/cover no-repeat' + (url ? ' url(' + url + ')' : '') + ';display:inline-grid;place-items:center;font-size:' + Math.round(h * 0.8) + 'px;line-height:1;';
    return <span aria-hidden="true" style={css(box)}>{url ? null : FACE.flagEmoji(code)}</span>;
  }

  /* The design's track(): a switch, and its knob. */
  function track(on, off) {
    return {
      track: css('flex:none;position:relative;width:40px;height:24px;border-radius:999px;border:0;padding:0;transition:background .25s cubic-bezier(.22,1,.36,1);cursor:' + (off ? 'not-allowed' : 'pointer') + ';opacity:' + (off ? '0.55' : '1') + ';background:' + (on ? 'var(--primary)' : 'rgba(23,20,15,0.16)') + ';'),
      knob: css('position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.25);transition:transform .25s cubic-bezier(.22,1,.36,1);transform:translateX(' + (on ? '16px' : '0') + ');'),
    };
  }
  function Switch({ on, off, onClick, name }) {
    const t = track(on, off);
    return <button type="button" role="switch" aria-checked={on} aria-label={name} disabled={off} onClick={e => { e.stopPropagation(); if (!off) onClick(); }} style={t.track}><span style={t.knob} /></button>;
  }
  const chip = (t) => css('display:inline-block;font-family:var(--m);font-size:12px;font-weight:700;padding:3px 8px;border-radius:7px;background:' + (t === 'green' ? 'var(--green-soft)' : t === 'amber' ? 'var(--amber-soft)' : 'var(--clay-soft)') + ';color:' + (t === 'green' ? 'var(--primary-deep)' : t === 'amber' ? 'var(--amber)' : 'var(--clay)') + ';');

  /* Width of this window, for the design's breakpoints (cards under 880,
     the rail beside the board at 1240 and over). */
  function useWidth(ref) {
    const [w, setW] = useState(1280);
    useEffect(() => {
      const el = ref.current;
      if (!el) return undefined;
      const measure = () => setW(el.clientWidth);
      measure();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
      if (ro) ro.observe(el);
      return () => { if (ro) ro.disconnect(); };
    }, [ref]);
    return w;
  }

  function Tip({ tipKey, open, onToggle }) {
    const btn = css('flex:none;appearance:none;width:18px;height:18px;border-radius:50%;display:inline-grid;place-items:center;padding:0;cursor:pointer;font-family:var(--m);font-size:10.5px;font-weight:700;line-height:1;letter-spacing:0;text-transform:none;transition:background .2s ease,color .2s ease,border-color .2s ease;border:1.5px solid ' + (open ? 'var(--ink)' : 'rgba(23,20,15,0.28)') + ';background:' + (open ? 'var(--ink)' : '#fff') + ';color:' + (open ? '#fff' : 'var(--mute)') + ';');
    return <button type="button" onClick={() => onToggle(open ? null : tipKey)} title="What is this?" aria-label={`What is ${TIPS[tipKey][0].toLowerCase()}?`} style={btn}>i</button>;
  }

  function Board({ settings, serverRole, me, log, w, onTip, tip, onToast, onOpenSite }) {
    const canPublish = PUBLISHERS.includes(serverRole);
    const readOnly = !canPublish;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    const defPct = settings.defaultSpread != null && settings.defaultSpread !== '' ? +settings.defaultSpread : B.DEFAULT_SPREAD_PCT;
    const floor = settings.marginFloorPct != null ? +settings.marginFloorPct : 0.5;
    const target = settings.marginTargetPct != null ? +settings.marginTargetPct : 1.0;
    const [data, setData] = useState({ loading: true, error: null, board: null, history: [], market: {}, screens: [] });
    const [edits, setEdits] = useState({ order: null, show: {}, added: [] });
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [liveOpen, setLiveOpen] = useState(true);
    const [copied, setCopied] = useState(false);
    const [picking, setPicking] = useState(false);
    const drag = useRef(null);
    const cards = w < 880, wide = w >= 1240;

    const load = useCallback(async () => {
      try {
        const [rates, history, feed, screens] = await Promise.all([getJson('/api/rates'), getJson('/api/rates/history'), getJson('/api/rates/market'),
          getJson('/api/window-screens').catch(e => { console.warn('[rates] window screens could not be read', e); return { screens: [] }; })]);
        setData({ loading: false, error: null, board: rates.board, history: history.publications || [], market: B.homeMarket(feed.mids, home), screens: screens.screens || [] });
      } catch (e) {
        setData(d => ({ ...d, loading: false, error: 'The board could not be loaded (' + e.message + '). Nothing has changed for customers.' }));
      }
    }, []);
    useEffect(() => { load(); }, [load]);

    const rows = useMemo(() => {
      const base = B.draftRows({ codes: (window.CDOS.CCY || []).concat(edits.added), home, board: data.board, market: data.market, settings })
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
    const pubOff = readOnly || !(dirty || marketMoved) || busy;

    const moveTo = (code, target) => setEdits(e => {
      const order = rows.map(r => r.code).filter(c => c !== code);
      const at = order.indexOf(target);
      order.splice(at < 0 ? order.length : at, 0, code);
      return { ...e, order };
    });
    const step = (code, by) => {
      const order = rows.map(r => r.code), i = order.indexOf(code), j = i + by;
      if (i >= 0 && j >= 0 && j < order.length) moveTo(code, by < 0 ? order[j] : order[j + 1]);
    };
    const toggle = (r) => setEdits(e => ({ ...e, show: { ...e.show, [r.code]: !r.show } }));

    const publish = async () => {
      if (pubOff) return;
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
        setEdits({ order: null, show: {}, added: [] });
        onToast('Published · your site and window updated');
        await load();
      } catch (e) {
        setNotice('No connection. Nothing was published.');
      } finally { setBusy(false); }
    };

    if (data.loading) return <div style={css('padding:30px;text-align:center;font-size:13.5px;color:var(--mute);')}>Loading your board…</div>;

    const ql = q.trim().toLowerCase();
    const list = rows.filter(r => !ql || r.code.toLowerCase().includes(ql) || FACE.currencyName(r.code).toLowerCase().includes(ql));
    const onBoard = rows.filter(r => r.show).length;
    const pub = data.board;
    const preview = pub ? (pub.order || Object.keys(pub.rows)).filter(c => pub.rows[c] && pub.rows[c].show !== false).slice(0, 6).map(c => {
      const r = pub.rows[c];
      const pct = (m) => (r.spread != null ? r.spread : m) * 100;
      return { code: c, ...B.deskPair(r.mid, pct(pub.buyMargin), pct(pub.sellMargin)) };
    }) : [];
    const screen = data.screens[0] || null;
    const cols = '22px minmax(130px,1.6fr) minmax(80px,1fr) minmax(84px,1fr) minmax(84px,1fr) minmax(90px,1fr) 64px';
    const btnBase = 'flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:700;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';';
    const ghostBtn = btnBase + 'border:1px solid var(--line);background:#fff;color:var(--ink);transition:border-color .2s ease,color .2s ease,background .2s ease;';
    const addable = Object.keys(data.market).filter(c => !rows.some(r => r.code === c)).sort();

    return (<div style={css('display:grid;grid-template-columns:' + (wide ? 'minmax(0,1fr) 330px' : 'minmax(0,1fr)') + ';gap:14px;align-items:start;')}>
      <div style={css('min-width:0;display:flex;flex-direction:column;gap:14px;')}>
        {data.error && <div role="alert" style={css('padding:11px 13px;border-radius:12px;background:var(--clay-soft);color:var(--clay);font-size:13px;')}>{data.error}</div>}
        <div style={css('border-radius:16px;background:#fff;border:1px solid var(--line);overflow:hidden;')}>
          <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line);')}>
            <span style={css('flex:1 1 200px;min-width:0;position:relative;')}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--faint)" strokeWidth="2.2" strokeLinecap="round" style={css('position:absolute;left:12px;top:50%;transform:translateY(-50%);')}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a currency" aria-label="Find a currency" style={css('width:100%;height:38px;padding:0 12px 0 36px;border-radius:10px;border:1px solid var(--line);background:rgba(23,20,15,0.03);outline:none;font-size:14px;color:var(--ink);')} />
            </span>
            <button type="button" disabled={readOnly} onClick={() => setPicking(p => !p)} style={css(ghostBtn)}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Add currency</button>
          </div>
          {picking && !readOnly && <div role="listbox" aria-label="Add a currency" style={css('display:flex;flex-wrap:wrap;gap:6px;padding:12px 14px;border-bottom:1px solid var(--line);background:rgba(23,20,15,0.02);')}>
            {addable.length ? addable.map(c => (<button key={c} type="button" role="option" aria-selected="false" onClick={() => { setEdits(e => ({ ...e, added: e.added.concat(c), show: { ...e.show, [c]: true } })); setPicking(false); }}
              style={css('display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:12.5px;font-weight:700;')}><Flag code={c} size={18} />{c}</button>))
              : <span style={css('font-size:13px;color:var(--mute);')}>Every currency the market feed prices is already on your list.</span>}
          </div>}

          {!cards && <div style={css('display:grid;grid-template-columns:' + cols + ';gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>
            <span /><span>Currency</span><span style={{ textAlign: 'right' }}>Market</span><span style={{ textAlign: 'right' }}>We buy</span><span style={{ textAlign: 'right' }}>We sell</span><span style={{ textAlign: 'right' }}>Over market</span><span style={{ textAlign: 'center' }}>On board</span>
          </div>}
          {list.map((r, i) => {
            const pair = r.mid ? B.deskPair(r.mid, r.spreadPct, r.spreadPct) : null;
            const pct = pair ? (pair.sell - r.mid) / r.mid * 100 : 0;
            const keepChip = chip(pct < 0 ? 'red' : pct < floor ? 'red' : pct < target ? 'amber' : 'green');
            const keep = pair ? (pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%' : '·';
            const name = FACE.currencyName(r.code);
            const dragProps = readOnly || ql ? {} : {
              draggable: true,
              onDragStart: e => { drag.current = r.code; e.dataTransfer.effectAllowed = 'move'; },
              onDragOver: e => { if (drag.current && drag.current !== r.code) e.preventDefault(); },
              onDrop: e => { e.preventDefault(); if (drag.current && drag.current !== r.code) moveTo(drag.current, r.code); drag.current = null; },
              onKeyDown: e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(r.code, e.key === 'ArrowUp' ? -1 : 1); } },
            };
            if (cards) return (<div key={r.code} {...dragProps} tabIndex={dragProps.draggable ? 0 : undefined} aria-label={`${r.code} ${name}`}
              style={css('padding:14px 16px;' + (i ? 'border-top:1px solid var(--hair);' : '') + (r.show ? '' : 'opacity:0.55;'))}>
              <div style={css('display:flex;align-items:center;gap:11px;')}>
                <Flag code={r.code} />
                <span style={css('flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}><b style={css('font-size:15px;font-weight:800;')}>{r.code}</b> <span style={css('font-size:12.5px;color:var(--mute);')}>{name}</span></span>
                <Switch on={r.show} off={readOnly} onClick={() => toggle(r)} name={`${r.code} on the board`} />
              </div>
              <div style={css('display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;margin-top:12px;')}>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>We buy</span><span style={css('font-family:var(--m);font-size:15px;')}>{pair ? fx(pair.buy) : 'No rate'}</span></span>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>We sell</span><span style={css('font-family:var(--m);font-size:15px;font-weight:700;')}>{pair ? fx(pair.sell) : 'No rate'}</span></span>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>Over market</span><span style={keepChip}>{keep}</span></span>
              </div>
              <div style={css('font-family:var(--m);font-size:10.5px;color:var(--faint);margin-top:9px;')}>{r.mid ? 'Market ' + fx(r.mid) + (r.pinned ? ' · pinned' : '') : 'No market rate'}</div>
            </div>);
            return (<div key={r.code} {...dragProps} tabIndex={dragProps.draggable ? 0 : undefined} aria-label={`${r.code} ${name}`}
              style={css('display:grid;grid-template-columns:' + cols + ';min-width:0;align-items:center;gap:12px;padding:12px 16px;transition:background .15s ease;' + (i ? 'border-top:1px solid var(--hair);' : '') + (r.show ? '' : 'opacity:0.55;'))}>
              <span title={dragProps.draggable ? 'Drag to reorder (or Alt and the arrow keys)' : undefined} style={css('color:var(--faint);font-size:14px;letter-spacing:-2px;cursor:' + (dragProps.draggable ? 'grab' : 'default') + ';')}>⋮⋮</span>
              <span style={css('display:flex;align-items:center;gap:11px;min-width:0;')}><Flag code={r.code} /><span style={css('min-width:0;')}><b style={css('display:block;font-size:14.5px;font-weight:800;')}>{r.code}</b><span style={css('display:block;font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{name}{r.pinned ? ' · pinned' : ''}</span></span></span>
              <span style={css('text-align:right;font-family:var(--m);font-size:13px;color:var(--mute);')}>{r.mid ? fx(r.mid) : 'No rate'}</span>
              <span style={css('text-align:right;font-family:var(--m);font-size:14.5px;')}>{pair ? fx(pair.buy) : '·'}</span>
              <span style={css('text-align:right;font-family:var(--m);font-size:14.5px;font-weight:700;')}>{pair ? fx(pair.sell) : '·'}</span>
              <span style={{ textAlign: 'right' }}><span style={keepChip}>{keep}</span></span>
              <span style={css('display:flex;justify-content:center;')}><Switch on={r.show} off={readOnly} onClick={() => toggle(r)} name={`${r.code} on the board`} /></span>
            </div>);
          })}
          {!list.length && <div style={css('padding:30px;text-align:center;font-size:13.5px;color:var(--mute);')}>No currency matches “{q}”.</div>}
          <div style={css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--line);font-family:var(--m);font-size:11px;color:var(--mute);')}>
            <span>{onBoard} of {rows.length} on the board · the top six show on your homepage</span><span style={{ flex: 1 }} />
            <span style={css('display:inline-flex;align-items:center;gap:12px;flex-wrap:wrap;')}>
              <span style={css('display:inline-flex;align-items:center;gap:5px;')}><span style={css('width:8px;height:8px;border-radius:50%;background:var(--primary);')} />On target</span>
              <span style={css('display:inline-flex;align-items:center;gap:5px;')}><span style={css('width:8px;height:8px;border-radius:50%;background:var(--amber);')} />Thin</span>
              <span style={css('display:inline-flex;align-items:center;gap:5px;')}><span style={css('width:8px;height:8px;border-radius:50%;background:var(--clay);')} />Below your floor</span>
            </span>
          </div>
        </div>
      </div>

      {/* rail */}
      <div style={css('min-width:0;display:flex;flex-direction:column;gap:14px;')}>
        <div style={css('padding:16px;border-radius:18px;background:#fff;border:1px solid var(--line);')}>
          <div style={css('display:flex;align-items:center;gap:9px;padding:11px 13px;border-radius:12px;font-size:14px;font-weight:700;background:' + (dirty ? 'var(--amber-soft)' : 'var(--green-soft)') + ';color:' + (dirty ? 'var(--amber)' : 'var(--primary-deep)') + ';')}>
            <span style={css('flex:none;width:8px;height:8px;border-radius:50%;background:' + (dirty ? 'var(--amber)' : 'var(--primary)') + ';')} />
            <span style={css('flex:1;min-width:0;')}>{dirty ? 'Unpublished changes' : 'Live on your site and window'}</span>
            <Tip tipKey="publish" open={tip === 'publish'} onToggle={onTip} />
          </div>
          {marketMoved && <div style={css('font-size:12.5px;line-height:1.45;color:var(--mute);margin-top:10px;')}>The market has moved since this publish. Publish to send today's rates.</div>}
          <button type="button" onClick={publish} disabled={pubOff} style={css('width:100%;margin-top:12px;height:50px;border:0;border-radius:13px;font-family:var(--m);font-size:13px;letter-spacing:0.16em;text-transform:uppercase;font-weight:700;transition:background .2s ease,color .2s ease;cursor:' + (pubOff ? 'default' : 'pointer') + ';background:' + (pubOff ? 'rgba(23,20,15,0.08)' : 'var(--primary)') + ';color:' + (pubOff ? 'rgba(23,20,15,0.35)' : '#fff') + ';')}>{busy ? 'Publishing…' : 'Publish'}</button>
          {notice && <div role="alert" style={css('font-size:12.5px;line-height:1.45;color:var(--clay);margin-top:10px;')}>{notice}</div>}
          <div style={css('font-family:var(--m);font-size:11px;line-height:1.6;color:var(--mute);margin-top:11px;')}>{pub ? 'Updated ' + ago(pub.publishedAt) + ' by ' + (pub.publishedBy || 'the market feed') : 'Nothing published yet'}</div>
          <div style={css('margin-top:12px;padding-top:11px;border-top:1px solid var(--hair);')}>
            <div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);margin-bottom:6px;')}>Recent publishes</div>
            {data.history.slice(0, 3).map(h => (<div key={h.publicationId} style={css('display:flex;align-items:baseline;gap:8px;padding:4px 0;font-family:var(--m);font-size:11px;')}>
              <b style={css('flex:none;width:74px;color:var(--ink);')}>{when(h.publishedAt, settings)}</b>
              <span style={css('flex:1;min-width:0;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{h.publishedBy || 'market feed'}</span>
              <span style={css('flex:none;color:var(--faint);')}>{Object.keys(h.rows || {}).length + ' ccy · ' + (Number(h.sellMargin) * 100).toFixed(1) + '%'}</span>
            </div>))}
          </div>
        </div>

        <section aria-label="What customers see now" style={css('border-radius:18px;overflow:hidden;background:#17140F;color:#F1EEE8;')}>
          <button type="button" onClick={() => setLiveOpen(o => !o)} aria-expanded={liveOpen} style={css('width:100%;appearance:none;border:0;background:none;color:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;padding:13px 16px;text-align:left;')}>
            <span style={css('width:7px;height:7px;border-radius:50%;background:#2EA36B;animation:rtLive 2s infinite;')} />
            <span style={css('flex:1;font-family:var(--m);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;')}>What customers see now</span>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="rgba(241,238,232,0.5)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css('flex:none;transition:transform .25s cubic-bezier(.22,1,.36,1);transform:rotate(' + (liveOpen ? '180deg' : '0') + ');')}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {liveOpen && <>
            {dirty && <div style={css('margin:0 16px 8px;padding:8px 11px;border-radius:9px;background:rgba(217,169,44,0.16);color:#e5c56a;font-size:12px;line-height:1.45;')}>Your changes aren't live yet. Customers see your last publish.</div>}
            <div style={css('display:flex;padding:4px 16px 2px;font-family:var(--m);font-size:8.5px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(241,238,232,0.45);border-top:1px solid rgba(241,238,232,0.1);')}><span style={{ flex: 1 }} /><span style={css('width:66px;text-align:right;')}>We buy</span><span style={css('width:66px;text-align:right;')}>We sell</span></div>
            {!preview.length && <div style={css('padding:7px 16px;font-size:12px;color:rgba(241,238,232,0.75);')}>Nothing published yet.</div>}
            {preview.map(p => (<div key={p.code} style={css('display:flex;align-items:center;gap:9px;padding:7px 16px;border-top:1px solid rgba(241,238,232,0.07);')}>
              <Flag code={p.code} size={20} /><b style={css('flex:1;font-family:var(--m);font-size:12.5px;')}>{p.code}</b>
              <span style={css('width:66px;text-align:right;font-family:var(--m);font-size:12px;color:rgba(241,238,232,0.75);')}>{fx(p.buy)}</span>
              <span style={css('width:66px;text-align:right;font-family:var(--m);font-size:12px;font-weight:700;color:#5FD69B;')}>{fx(p.sell)}</span>
            </div>))}
            <div style={css('display:flex;gap:6px;padding:12px 16px 14px;border-top:1px solid rgba(241,238,232,0.1);')}>
              {screen
                ? <a href={'/s/' + screen.token} target="_blank" rel="noopener" style={css('flex:1;display:inline-flex;align-items:center;justify-content:center;height:34px;border-radius:10px;background:#F1EEE8;color:#17140F;font-size:12.5px;font-weight:700;text-decoration:none;')}>Open full screen ↗</a>
                : <button type="button" onClick={onOpenSite} style={css('flex:1;appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;height:34px;border-radius:10px;background:#F1EEE8;color:#17140F;font-size:12.5px;font-weight:700;')}>Set up a window screen</button>}
              {screen && <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(location.origin + '/s/' + screen.token); setCopied(true); setTimeout(() => setCopied(false), 1500); }
                catch (e) { onToast('The link could not be copied. Open it and copy it from the address bar.'); }
              }} style={css('flex:none;appearance:none;height:34px;padding:0 13px;border-radius:10px;cursor:pointer;font-size:12.5px;font-weight:700;border:1px solid rgba(241,238,232,0.3);background:' + (copied ? '#2EA36B' : 'transparent') + ';color:#F1EEE8;')}>{copied ? 'Copied' : 'Copy link'}</button>}
            </div>
          </>}
        </section>
      </div>
    </div>);
  }

  /* The design's folder tabs. */
  const TAB_ICON = { board: 'M5 4h14v16H5zM8.5 8.5h7M8.5 12h7M8.5 15.5h4', site: 'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0M3 12h18M12 3c2.5 2.6 2.5 15 0 18M12 3c-2.5 2.6-2.5 15 0 18', rules: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4' };

  function Rates({ settings, setSettings, me, log, serverRole }) {
    const [tab, setTab] = useState('board');
    const [tip, setTip] = useState(null);
    const [toast, setToast] = useState(null);
    const [feed, setFeed] = useState(null);
    const rootRef = useRef(null);
    const w = useWidth(rootRef);
    const cards = w < 880;
    const readOnly = !PUBLISHERS.includes(serverRole);
    const Pricing = window.CDOS.Pricing;
    const flash = useCallback((t) => { setToast(t); clearTimeout(flash.t); flash.t = setTimeout(() => setToast(null), 2400); }, []);
    useEffect(() => {
      getJson('/api/rates/market').then(m => setFeed(m), e => console.warn('[rates] the market feed could not be read', e));
      const esc = (e) => { if (e.key === 'Escape') setTip(null); };
      window.addEventListener('keydown', esc);
      return () => window.removeEventListener('keydown', esc);
    }, []);
    const tabs = [['board', 'Board'], ['site', 'Website & window'], ['rules', 'Pricing & rates']];
    const feedAgo = feed && feed.fetchedAt ? ago(feed.fetchedAt) : null;

    return (<div ref={rootRef} data-rates="true" style={{ ...TOKENS, position: 'relative', lineHeight: 'normal', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'rgba(251,250,247,0.96)' }}>
      <div style={css('flex:none;padding:' + (cards ? '16px 16px 0' : '22px 26px 0') + ';border-bottom:1px solid var(--line);background:#fbfaf7;')}>
        <div style={css('display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;')}>
          <div style={css('flex:1 1 260px;min-width:0;')}>
            <h1 style={css('margin:0;font-size:clamp(28px, 3.4vw, 42px);font-weight:800;letter-spacing:-0.03em;line-height:1;')}>Today's rates</h1>
            <p style={css("margin:8px 0 0;font-family:var(--m);font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);")}>What it's worth · what you paid · what you charge</p>
          </div>
          <div style={css('display:flex;align-items:center;gap:8px;flex-wrap:wrap;')}>
            <span style={css('display:inline-flex;align-items:center;gap:9px;height:40px;max-width:100%;padding:0 13px;border-radius:11px;border:1px solid var(--line);background:#fff;text-align:left;')}>
              <span style={css('flex:none;width:8px;height:8px;border-radius:50%;background:' + (feed && feed.provider ? '#2EA36B' : '#9a938a') + ';' + (feed && feed.provider ? 'animation:rtLive 2s infinite;' : ''))} />
              <span style={css('min-width:0;line-height:1.15;')}><b style={css('display:block;font-size:12.5px;white-space:nowrap;')}>{feed && feed.provider ? 'Live feed' : 'No market feed'}</b><span style={css('display:block;font-family:var(--m);font-size:9.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{feed && feed.provider ? feed.provider + ' · hourly' + (feedAgo ? ' · ' + feedAgo : '') : 'Rates hold at the last publish'}</span></span>
            </span>
          </div>
        </div>
        <div role="tablist" aria-label="Rates" style={css('display:flex;align-items:flex-end;gap:2px;margin:16px ' + (cards ? '-16px' : '-26px') + ' 0;padding:0 ' + (cards ? '12px' : '26px') + ';overflow-x:auto;scrollbar-width:none;border-bottom:3px solid var(--primary);')}>
          {tabs.map(([id, label]) => { const on = tab === id; return (<button key={id} type="button" role="tab" aria-selected={on} onClick={() => { setTab(id); setTip(null); }}
            style={css('flex:none;display:inline-flex;align-items:center;gap:9px;appearance:none;border:0;cursor:pointer;white-space:nowrap;font-family:var(--m);font-size:' + (cards ? '11px' : '12.5px') + ';letter-spacing:0.12em;text-transform:uppercase;font-weight:700;transition:background .2s ease,color .2s ease;'
              + (on ? 'background:var(--primary);color:#fff;padding:' + (cards ? '11px 26px 11px 13px' : '13px 34px 13px 18px') + ';border-radius:5px 0 0 0;clip-path:polygon(0 0,calc(100% - 20px) 0,100% 100%,0 100%);'
                : 'background:transparent;color:var(--mute);padding:' + (cards ? '11px 13px' : '13px 16px') + ';'))}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d={TAB_ICON[id]} /></svg>{label}</button>); })}
        </div>
      </div>
      {readOnly && <div style={css('flex:none;display:flex;align-items:center;gap:10px;padding:10px 24px;font-size:12.5px;font-weight:500;border-bottom:1px solid var(--line);background:rgba(23,20,15,0.04);color:var(--mute);')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" /></svg>
        <span style={css('flex:1;min-width:0;')}>You can see today's rates. Changing them is for the owner and managers.</span>
      </div>}
      <div style={css('flex:1;min-height:0;overflow-y:auto;')}>
        <div key={'t-' + tab} style={css('padding:' + (cards ? '14px 12px 90px' : '20px 26px 90px') + ';animation:rtIn .3s cubic-bezier(.22,1,.36,1) both;')}>
          {tab === 'board' && <Board settings={settings} serverRole={serverRole} me={me} log={log} w={w} tip={tip} onTip={setTip} onToast={flash} onOpenSite={() => setTab('site')} />}
          {tab === 'site' && <window.CDOS.RatesSite serverRole={serverRole} onToast={flash} />}
          {tab === 'rules' && <Pricing settings={settings} setSettings={setSettings} me={me} log={log} />}
        </div>
      </div>
      {tip && TIPS[tip] && <div role="dialog" aria-label={TIPS[tip][0]} style={css('position:absolute;right:' + (cards ? '12px' : '22px') + ';bottom:' + (cards ? '12px' : '22px') + ';z-index:55;width:min(360px, calc(100% - 24px));padding:14px 16px;border-radius:16px;background:#fff;border:1px solid var(--line);box-shadow:0 26px 60px -24px rgba(23,20,15,0.5);animation:rtIn .26s cubic-bezier(.22,1,.36,1) both;')}>
        <div style={css('display:flex;align-items:center;gap:9px;')}>
          <span style={css('flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:#fff;font-family:var(--m);font-size:11px;font-weight:700;')}>i</span>
          <b style={css('flex:1;min-width:0;font-size:14.5px;')}>{TIPS[tip][0]}</b>
          <button type="button" onClick={() => setTip(null)} title="Close" aria-label="Close" style={css('flex:none;appearance:none;border:0;background:rgba(23,20,15,0.06);width:26px;height:26px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--mute);')}><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <p style={css('font-size:13px;line-height:1.6;color:var(--ink);margin:10px 0 0;')}>{TIPS[tip][1]}</p>
        <div style={css('display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid var(--hair);')}>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => setTip(null)} style={css('flex:none;appearance:none;border:0;background:none;cursor:pointer;padding:0;font-family:var(--m);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:var(--primary);')}>Got it</button>
        </div>
      </div>}
      {toast && <div role="status" style={css('position:absolute;left:50%;bottom:26px;z-index:60;transform:translateX(-50%);max-width:calc(100% - 32px);display:flex;align-items:center;gap:8px;padding:11px 16px;border-radius:12px;background:#17140F;color:#fff;font-size:13px;font-weight:600;box-shadow:0 18px 40px -16px rgba(0,0,0,0.5);animation:rtIn 0.25s ease both;')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#5FD69B" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M4 12.5l5 5L20 6.5" /></svg>{toast}</div>}
    </div>);
  }

  /* The design helpers, shared with the Website & window tab
     (cdos-rates-site.jsx), so both tabs draw the same switch, flag and
     segmented control from the same design strings. */
  function seg(opts, cur, fn, off) {
    return opts.map(o => ({ label: o, on: cur === o, onPick: () => { if (!off) fn(o); },
      style: css('appearance:none;border:0;cursor:' + (off ? 'not-allowed' : 'pointer') + ';opacity:' + (off && cur !== o ? '0.6' : '1') + ';font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:8px;transition:background .2s ease,color .2s ease,box-shadow .2s ease;background:' + (cur === o ? '#fff' : 'transparent') + ';color:' + (cur === o ? 'var(--ink)' : 'var(--mute)') + ';box-shadow:' + (cur === o ? '0 1px 3px rgba(23,20,15,0.14)' : 'none') + ';') }));
  }
  const pill = (copied) => css('appearance:none;display:inline-flex;align-items:center;height:32px;padding:0 13px;border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:700;transition:all .2s ease;border:1px solid ' + (copied ? 'var(--primary)' : 'var(--line)') + ';background:' + (copied ? 'var(--primary)' : '#fff') + ';color:' + (copied ? '#fff' : 'var(--ink)') + ';');
  window.CDOS = Object.assign(window.CDOS || {}, { Rates, ratesUi: { css, Flag, track, Switch, useWidth, seg, pill } });
})();
