/* ============================================================
   CurrencyDesk OS: Rates (Rates v2.5)

   One app for the shop's rates, in place of the Rate Board page. It is a
   port of Sol's design (handoff rates-v2.5, "CurrencyDesk Rates v2.5"):
   the header, folder tabs, Board table and cards, publish rail and "What
   customers see now" keep the design's own markup, copy and style strings.
   The design's style strings are kept word for word and turned into React
   styles by css() below, so a reviewer can hold the two side by side.

   The Board tab shows every currency the desk trades: the market, what the
   desk buys and sells at, and whether it is on the board. Pricing & rates
   is the existing Pricing console, unchanged.

   Publish sends the board to the server (POST /api/rates/publish,
   append-only rate_boards), and every surface the shop's customers see
   reads that publish.

   The server is the record. The board loads from GET /api/rates (this
   desk's own branch), the market from GET /api/rates/market (raw mids,
   converted to the shop's home currency without rounding), recent
   publishes from GET /api/rates/history. The shop's window screens come
   from GET /api/window-screens, for Open full screen.
   The publish rights are the server's (rates:change); the screen only
   mirrors them so nobody types into a board they cannot publish.
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

  /* A read that may fail without stopping the screen, which still says
     what failed and why (engineering standard §5: never swallow an error). */
  function orElse(what, fallback) {
    return (e) => { console.warn('[rates] ' + what + ' could not be read', e); return fallback; };
  }
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

  /* Publish a board (POST /api/rates/publish): the Board's Publish and
     Pricing & rates' Publish to Rate Board. Answers { ok } or { ok: false,
     status, message } in words for the screen. */
  async function publishRows(rows, defPct, { me, log } = {}) {
    const out = B.publishBody(rows, defPct);
    if (!out.ok) {
      return { ok: false, status: 0, message: out.missing.length
        ? `No rate for ${out.missing.join(', ')}. Take it off the board, or pin a rate in Pricing & rates.`
        : 'A spread is over 20%. Lower it in Pricing & rates.' };
    }
    let res;
    try {
      res = await fetch('/api/rates/publish', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out.body) });
    } catch (e) {
      return { ok: false, status: 0, message: 'No connection. Nothing was published.' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: res.status === 409 ? 'Rates are locked. Unlock them to publish. Customers still see your last publish.'
        : res.status === 403 ? 'Only the owner and managers can publish rates.' : `Publish failed (the server answered ${res.status}). Customers still see your last publish.` };
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
    return { ok: true, board: saved };
  }

  /* The design's feed sheet: where the market column comes from. On this
     desk the feed is the platform's own, pulled every hour (GET
     /api/rates/market); holding today's rates is Lock rates, and typing
     them is pinning a currency in Pricing & rates. There is no other feed
     to pick yet, so none is listed. */
  function FeedSheet({ feed, locked, canLock, onLock, onPins, onClose, cards }) {
    const closeRef = useRef(null);
    useEffect(() => {
      if (closeRef.current) closeRef.current.focus();
      const esc = (e) => { if (e.key === 'Escape') onClose(); };
      document.addEventListener('keydown', esc);
      return () => document.removeEventListener('keydown', esc);
    }, [onClose]);
    const live = !!(feed && feed.provider);
    const mode = locked ? 'held' : 'live';
    const DOT = { live: '#2EA36B', held: '#e0a106', manual: '#9a938a' };
    const modes = [
      ['live', 'Live feed', live ? 'Market rates update on their own from the feed below, every hour.' : 'There is no market feed right now. Your board holds its last publish.', null],
      ['held', 'Hold today’s rates', canLock ? (locked ? 'Your rates are locked. Unlock them in the header to follow the market again.' : 'Lock your rates: nothing publishes and the market leaves your board alone until you unlock it.') : 'The owner or a manager can lock the rates.', canLock && !locked ? onLock : null],
      ['manual', 'Type them myself', 'Pin a currency’s market rate in Pricing & rates. The market then leaves that currency alone.', onPins],
    ];
    const optStyle = (on, active) => css('appearance:none;width:100%;display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border-radius:12px;text-align:left;transition:border-color .2s ease;cursor:' + (active ? 'pointer' : 'default') + ';border:' + (on ? '1.5px solid var(--primary)' : '1px solid var(--line)') + ';background:' + (on ? 'var(--green-soft)' : '#fff') + ';');
    return (<div onClick={onClose} style={css('position:absolute;inset:0;z-index:40;display:flex;align-items:' + (cards ? 'stretch' : 'center') + ';justify-content:center;padding:' + (cards ? '0' : '28px') + ';background:rgba(23,20,15,0.32);animation:rtFade .2s ease both;')}>
      <div role="dialog" aria-modal="true" aria-label="Where your market rates come from" onClick={e => e.stopPropagation()} style={css('display:flex;flex-direction:column;width:' + (cards ? '100%' : 'min(560px, 100%)') + ';max-height:100%;background:#FBFAF7;overflow:hidden;border-radius:' + (cards ? '0' : '18px') + ';box-shadow:0 40px 90px -30px rgba(23,20,15,0.6),0 0 0 1px rgba(23,20,15,0.08);animation:rtIn .26s cubic-bezier(.22,1,.36,1) both;')}>
        <div style={css('flex:1;min-height:0;overflow-y:auto;padding:22px 22px 18px;')}>
          <div style={css('display:flex;align-items:flex-start;gap:12px;')}><span style={css('flex:1;min-width:0;font-family:var(--m);font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--mute);')}>Market rates</span>
            <button ref={closeRef} type="button" onClick={onClose} title="Close" aria-label="Close" style={css('flex:none;appearance:none;border:0;background:rgba(23,20,15,0.06);width:30px;height:30px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--mute);')}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
          <h2 style={css('margin:0;font-size:23px;font-weight:800;letter-spacing:-0.02em;line-height:1.15;')}>Where your market rates come from</h2>
          <p style={css('font-size:13.5px;line-height:1.55;color:var(--mute);margin:6px 0 0;')}>This is the column your prices are built on. Your margins sit on top of it.</p>
          <div style={css('margin-top:18px;')}>
            <span style={css('display:block;font-size:13px;font-weight:700;margin-bottom:8px;')}>How the market column behaves</span>
            <div style={css('display:flex;flex-direction:column;gap:6px;')}>
              {modes.map(([id, name, body, act]) => (<button key={id} type="button" aria-current={mode === id ? 'true' : undefined} onClick={() => { if (act) act(); }} style={optStyle(mode === id, !!act)}><span style={css('flex:none;width:10px;height:10px;border-radius:50%;margin-top:4px;background:' + DOT[id] + ';')} /><span style={css('flex:1;min-width:0;text-align:left;')}><b style={css('display:block;font-size:13.5px;')}>{name}</b><span style={css('display:block;font-size:12px;line-height:1.45;color:var(--mute);margin-top:2px;')}>{body}</span></span></button>))}
            </div>
          </div>
          <div style={css('margin-top:20px;')}>
            <span style={css('display:block;font-size:13px;font-weight:700;margin-bottom:8px;')}>Your feed</span>
            <div style={css('display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border-radius:12px;border:1px solid var(--line);background:#fff;')}>
              <span style={css('flex:none;width:18px;height:18px;border-radius:50%;margin-top:1px;border:' + (live ? '5px solid var(--primary)' : '1.5px solid rgba(23,20,15,0.25)') + ';background:#fff;box-sizing:border-box;')} />
              <span style={css('flex:1;min-width:0;')}><span style={css('display:flex;align-items:center;gap:7px;flex-wrap:wrap;')}><b style={css('font-size:14px;')}>{live ? feed.provider : 'No market feed'}</b>{live && <span style={css('font-family:var(--m);font-size:8.5px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;padding:2px 7px;border-radius:999px;color:var(--primary-deep);background:var(--green-soft);')}>Connected</span>}</span>
                <span style={css('display:block;font-family:var(--m);font-size:11px;color:var(--mute);margin-top:4px;')}>{live ? 'every hour' + (feed.fetchedAt ? ' · last pulled ' + ago(feed.fetchedAt) : '') : 'rates hold at the last publish'}</span></span>
            </div>
          </div>
          <p style={css('font-size:12px;line-height:1.5;color:var(--mute);margin:12px 0 0;')}>The feed is the same for every shop on CurrencyDesk and updates every hour. Faster feeds will come as paid add-ons.</p>
        </div>
        <div style={css('flex:none;display:flex;justify-content:flex-end;padding:14px 22px;border-top:1px solid var(--line);background:#fff;')}>
          <button type="button" onClick={onClose} style={css('flex:none;appearance:none;border:0;border-radius:11px;padding:12px 20px;font-family:var(--m);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;cursor:pointer;background:var(--primary);color:#fff;')}>Done</button>
        </div>
      </div>
    </div>);
  }

  /* The design's tone for a margin: red under the floor (or a loss),
     amber under the target, green on target. */
  const toneOf = (pct, floor, target) => (pct < 0 || pct < floor ? 'red' : pct < target ? 'amber' : 'green');

  /* The design's currency panel (CURRENCY DRAWER): a row's › opens it.
     The market, what the desk paid when the server will say (GET
     /api/ledger/position, which a Rates plan or a teller does not get),
     what it sells at, the margin against the floor and target, the
     currency's own spread or the default, cash on hand, and on or off
     the board. A change here is a draft like any other on the board;
     Publish sends it. The spread is the shop's setting (spreads), the
     same one Pricing & rates edits. */
  function CurrencyPanel({ row, home, defPct, floor, target, stock, low, readOnly, onClose, onSpread, onToggle, onRecord, cards }) {
    const closeRef = useRef(null);
    useEffect(() => {
      if (closeRef.current) closeRef.current.focus();
      const key = e => { if (e.key === 'Escape') onClose(); };
      document.addEventListener('keydown', key);
      return () => document.removeEventListener('keydown', key);
    }, [onClose]);
    const name = FACE.currencyName(row.code);
    const pair = row.mid ? B.deskPair(row.mid, row.spreadPct, row.spreadPct) : null;
    const held = stock && stock.byCode[row.code];
    const cost = stock && stock.hasCost && held && held.cost ? held.cost : null;
    const keep = pair ? (cost ? pair.sell - cost : pair.sell - row.mid) : null;
    const pct = pair ? keep / (cost || row.mid) * 100 : null;
    const t = pct === null ? null : toneOf(pct, floor, target);
    const head = pct === null ? 'No market rate' : pct < 0 ? 'You lose on every sale' : t === 'red' ? 'Below your floor' : t === 'amber' ? 'Thin margin' : 'On target';
    const levels = 'Floor ' + floor.toFixed(1) + '%, target ' + target.toFixed(1) + '%.';
    const line = pct === null ? 'There is no market rate for ' + row.code + ' yet, so it has no price. ' + levels
      : cost ? ((pct < 0 ? 'You sell for less than you paid: ' : 'You keep ') + fx(Math.abs(keep)) + ' ' + home + ' on every ' + row.code + ' you sell (' + Math.abs(pct).toFixed(2) + '%). ' + levels)
        : ('You sell ' + fx(Math.abs(keep)) + ' ' + home + ' over the market on every ' + row.code + ' (' + Math.abs(pct).toFixed(2) + '%). ' + levels);
    const trio = [
      { label: 'Market', value: row.mid ? fx(row.mid) : 'No rate', note: row.pinned ? 'Pinned by you' : 'Market mid', bg: '#fff' },
      cost ? { label: 'You paid', value: fx(cost), note: stock.method, bg: '#fff' } : { label: 'You buy at', value: pair ? fx(pair.buy) : '·', note: 'Under market', bg: '#fff' },
      { label: 'You sell at', value: pair ? fx(pair.sell) : '·', note: pair ? 'Buy at ' + fx(pair.buy) : 'No rate', bg: 'rgba(29,107,69,0.06)' },
    ];
    const tr = track(!row.custom, readOnly);
    const step = by => onSpread(Math.min(8, Math.max(0, Math.round((row.spreadPct + by) * 10) / 10)));
    const stepBtn = css('width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:18px;color:var(--ink);cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';');
    const ghostBtn = css('flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:700;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';border:1px solid var(--line);background:#fff;color:var(--ink);transition:border-color .2s ease,color .2s ease,background .2s ease;');
    const n = v => Number(v).toLocaleString('en-CA', { maximumFractionDigits: 2 });
    return (<div onClick={onClose} style={css('position:absolute;inset:0;z-index:20;background:rgba(23,20,15,0.22);animation:rtFade 0.2s ease both;')}>
      <div role="dialog" aria-modal="true" aria-label={row.code + ' ' + name} onClick={e => e.stopPropagation()}
        style={css('position:absolute;top:0;right:0;bottom:0;width:' + (cards ? '100%' : 'min(440px, 100%)') + ';display:flex;flex-direction:column;background:#fbfaf7;box-shadow:-30px 0 60px -30px rgba(23,20,15,0.45);animation:rtDrawer .3s cubic-bezier(.22,1,.36,1) both;')}>
        <div style={css('flex:none;display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--line);')}>
          <Flag code={row.code} size={40} />
          <span style={css('flex:1;min-width:0;')}><b style={css('display:block;font-size:20px;font-weight:800;')}>{row.code}</b><span style={css('font-size:13px;color:var(--mute);')}>{name}</span></span>
          <button ref={closeRef} type="button" onClick={onClose} title="Close" aria-label="Close" style={css('appearance:none;border:0;background:rgba(23,20,15,0.06);width:30px;height:30px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--mute);')}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <div style={css('flex:1;min-height:0;overflow-y:auto;padding:18px 20px 24px;display:flex;flex-direction:column;gap:14px;')}>
          <div style={css('display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:1px;border-radius:14px;overflow:hidden;background:var(--line);border:1px solid var(--line);')}>
            {trio.map(x => (<div key={x.label} style={css('padding:13px 12px;background:' + x.bg + ';')}><div style={css('font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);')}>{x.label}</div><div style={css('font-family:var(--m);font-size:17px;font-weight:700;margin-top:5px;')}>{x.value}</div><div style={css('font-size:11.5px;color:var(--mute);margin-top:3px;')}>{x.note}</div></div>))}
          </div>
          <div style={css('padding:14px 16px;border-radius:14px;background:' + (t === 'green' ? 'var(--green-soft)' : t === 'amber' ? 'var(--amber-soft)' : 'var(--clay-soft)') + ';color:' + (t === 'green' ? 'var(--primary-deep)' : t === 'amber' ? 'var(--amber)' : 'var(--clay)') + ';')}><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;')}>{head}</div><div style={css('font-size:14px;line-height:1.5;margin-top:5px;')}>{line}</div></div>
          <div style={css('padding:14px 16px;border-radius:14px;background:#fff;border:1px solid var(--line);')}>
            <div style={css('display:flex;align-items:center;gap:12px;')}><span style={css('flex:1;min-width:0;')}><b style={css('display:block;font-size:14px;')}>Use the default spread</b><span style={css('display:block;font-size:12px;color:var(--mute);margin-top:2px;')}>{row.custom ? 'Off: ' + row.code + ' has its own spread.' : defPct.toFixed(1) + '% above and below the market.'}</span></span>
              <button type="button" role="switch" aria-checked={!row.custom} aria-label="Use the default spread" disabled={readOnly} onClick={() => onSpread(row.custom ? null : Math.round(defPct * 10) / 10)} style={tr.track}><span style={tr.knob} /></button></div>
            {row.custom && <div style={css('display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--hair);')}>
              <div><div style={css('font-family:var(--m);font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--mute);margin-bottom:7px;')}>Spread</div><div style={css('display:flex;align-items:center;gap:5px;')}>
                <button type="button" aria-label="Lower the spread" disabled={readOnly} onClick={() => step(-0.1)} style={stepBtn}>−</button>
                <output aria-label="Spread" style={css('min-width:70px;height:38px;display:grid;place-items:center;border-radius:10px;background:rgba(23,20,15,0.05);font-family:var(--m);font-size:16px;font-weight:700;')}>{row.spreadPct.toFixed(1) + '%'}</output>
                <button type="button" aria-label="Raise the spread" disabled={readOnly} onClick={() => step(0.1)} style={stepBtn}>+</button></div></div>
            </div>}
          </div>
          {stock && <div style={css('padding:14px 16px;border-radius:14px;background:#fff;border:1px solid var(--line);')}>
            <div style={css('display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;')}><b style={css('font-size:14px;')}>On hand</b><span style={css('font-family:var(--m);font-size:13px;')}>{held ? n(held.qty) + ' ' + row.code + (held.basis !== null && held.basis !== undefined ? ' · ' + home + ' ' + n(held.basis) + ' at cost' : '') : 'None'}</span></div>
            {held && <div style={css('font-size:12.5px;color:var(--mute);margin-top:3px;')}>{'Vault ' + n(held.vault) + ' · your till ' + n(held.till) + (low > 0 && held.qty < low ? ' · below your ' + n(low) + ' reorder point' : '')}</div>}
          </div>}
        </div>
        <div style={css('flex:none;display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px;border-top:1px solid var(--line);background:#fff;')}>
          {onRecord && <button type="button" onClick={onRecord} style={css('flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:700;border:0;background:var(--primary);color:#fff;cursor:pointer;')}>Record cash bought</button>}
          <span style={{ flex: 1 }} />
          <button type="button" disabled={readOnly} onClick={onToggle} style={ghostBtn}>{row.show ? 'Take off the board' : 'Put on the board'}</button>
        </div>
      </div>
    </div>);
  }

  function Board({ settings, setSettings, serverRole, me, log, w, onTip, tip, onToast, onOpenSite, locked, onLock, onRecordCash }) {
    const canPublish = PUBLISHERS.includes(serverRole);
    /* Locked rates take no changes until a manager unlocks them (the
       server refuses a publish meanwhile). */
    const readOnly = !canPublish || !!locked;
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
    const [sel, setSel] = useState(null);
    const [stock, setStock] = useState(null);
    const drag = useRef(null);
    const opener = useRef(null);
    const boardRef = useRef(null);
    const cards = w < 880, wide = w >= 1240;

    /* What the desk holds and what it paid, when the server will say. A
       Rates plan is refused (the ledger is not in it), and a role that
       cannot read the shop's earnings gets the quantities without the
       cost. Without it the board shows the margin over the market, as
       the design does for a Rates plan. */
    useEffect(() => {
      let live = true;
      Promise.all([getJson('/api/ledger/position'), getJson('/api/ledger/cost-method').catch(orElse('the cost method', null))]).then(([pos, cm]) => {
        if (!live) return;
        /* The server's figures, shown as they come: what one unit cost
           (avgCostHome) and the basis are the ledger's, never worked out
           here (the browser renders cash, it never computes it). */
        const byCode = {};
        (pos.currencies || []).forEach(c => {
          byCode[c.currency] = { qty: Number(c.quantity), basis: c.costBasisHome == null ? null : Number(c.costBasisHome), cost: c.avgCostHome == null ? null : Number(c.avgCostHome),
            vault: c.vault ? Number(c.vault.quantity) : 0, till: c.till ? Number(c.till.quantity) : 0 };
        });
        setStock({ hasCost: 'costBasisHome' in pos, byCode, method: cm && cm.method === 'fifo' ? 'First in, first out' : 'Average' });
      }).catch((e) => {
        /* A Rates plan is refused the ledger, and that is expected; the
           board then shows the margin over the market. */
        if (!/answered 403/.test(String(e && e.message))) console.warn('[rates] the desk\'s cash could not be read', e);
        if (live) setStock(null);
      });
      return () => { live = false; };
    }, []);
    /* A desk that has recorded no cost yet shows the margin over the
       market, not a column of blanks. */
    const hasCost = !!(stock && stock.hasCost && Object.keys(stock.byCode).some(c => stock.byCode[c].cost));
    /* The cost columns show once some cost is known (hasCost). Record cash
       bought is offered whenever this person may see costs at all
       (stock.hasCost), because recording a purchase is how a cost becomes
       known: gated on hasCost, a desk with no known cost never saw it. */
    const costOf = code => (hasCost && stock.byCode[code] && stock.byCode[code].cost) || null;

    /* A currency's own spread, or null for the default (Settings, spreads:
       the same key Pricing & rates edits). */
    const setSpread = (code, pct) => setSettings(s => {
      const sp = { ...(s.spreads || {}) };
      if (pct === null) delete sp[code]; else sp[code] = pct;
      return { ...s, spreads: sp };
    });
    const openPanel = (code, e) => { opener.current = e && e.currentTarget; setSel(code); };
    const closePanel = useCallback(() => { setSel(null); if (opener.current && opener.current.focus) opener.current.focus(); }, []);

    const load = useCallback(async () => {
      try {
        const [rates, history, feed, screens] = await Promise.all([getJson('/api/rates'), getJson('/api/rates/history'), getJson('/api/rates/market'),
          getJson('/api/window-screens').catch(e => { console.warn('[rates] window screens could not be read', e); return { screens: [] }; })]);
        if (onLock && rates.locked !== undefined) onLock(rates.locked);
        setData({ loading: false, error: null, board: rates.board, autoPublish: rates.autoPublish === true, history: history.publications || [], market: B.homeMarket(feed.mids, home), screens: screens.screens || [] });
      } catch (e) {
        setData(d => ({ ...d, loading: false, error: 'The board could not be loaded (' + e.message + '). Nothing has changed for customers.' }));
      }
      /* Again when the shop's home currency is known: the market is
         divided into it, and a board read before the desk's pack arrived
         would be priced in the wrong currency. */
    }, [home]);
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

    /* A row dropped on another takes that row's place: moving down it goes
       after it, moving up it goes before it. So one row down is one row
       down, by mouse, finger or keys. */
    const moveTo = (code, target) => setEdits(e => {
      const all = rows.map(r => r.code);
      const down = all.indexOf(code) < all.indexOf(target);
      const order = all.filter(c => c !== code);
      const at = order.indexOf(target);
      order.splice(at < 0 ? order.length : at + (down ? 1 : 0), 0, code);
      return { ...e, order };
    });
    const step = (code, by) => {
      const order = rows.map(r => r.code), i = order.indexOf(code), j = i + by;
      if (i >= 0 && j >= 0 && j < order.length) moveTo(code, order[j]);
    };
    /* The browser's own drag and drop is mouse only. A finger or a pen
       holds the handle and lets go over another row; the row under the
       pointer then is where the currency goes. */
    const fingerDrag = (code) => (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      const rowAt = (ev) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const row = el && el.closest('[data-rate-row]');
        return row ? row.getAttribute('data-rate-row') : null;
      };
      const done = (ev) => {
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        const to = ev.type === 'pointerup' ? rowAt(ev) : null;
        if (to && to !== code) moveTo(code, to);
      };
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
    };
    const toggle = (r) => setEdits(e => ({ ...e, show: { ...e.show, [r.code]: !r.show } }));
    const selRow = sel ? rows.find(r => r.code === sel) || null : null;

    /* Auto-publish (PUT /api/rates/auto-publish): every market refresh
       publishes this branch's board again, in the shop's own currency,
       keeping spreads, order and pinned rates. The server decides who may. */
    const setAuto = async () => {
      if (readOnly) return;
      const on = !data.autoPublish;
      setData(d => ({ ...d, autoPublish: on }));
      let res = null;
      try {
        res = await fetch('/api/rates/auto-publish', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
      } catch (e) {
        console.warn('[rates] Auto-publish could not be saved', e);
      }
      /* Not saved: the switch goes back to what the server holds. */
      if (!res || !res.ok) {
        setData(d => ({ ...d, autoPublish: !on }));
        setNotice(!res ? 'Auto-publish was not changed: the server could not be reached.' : res.status === 403 ? 'Only the owner and managers can change Auto-publish.' : `Auto-publish was not changed (the server answered ${res.status}).`);
        return;
      }
      log('Rates', `Auto-publish ${on ? 'on' : 'off'}`);
      if (onToast) onToast(on ? 'Auto-publish on · the board follows the market' : 'Auto-publish off');
    };
    const publish = async () => {
      if (pubOff) return;
      setNotice(null);
      setBusy(true);
      try {
        const done = await publishRows(rows, defPct, { me, log });
        if (!done.ok) {
          if (done.status === 409) await load();
          setNotice(done.message);
          return;
        }
        setEdits({ order: null, show: {}, added: [] });
        onToast('Published · your site and window updated');
        await load();
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
    /* The design's columns. You paid and You keep when the server gives
       this desk's cost; Over market without it. Then the › that opens
       the currency panel. */
    const cols = hasCost
      ? '22px minmax(130px,1.5fr) minmax(76px,1fr) minmax(76px,1fr) minmax(80px,1fr) minmax(80px,1fr) minmax(76px,0.9fr) 64px 20px'
      : '22px minmax(130px,1.6fr) minmax(80px,1fr) minmax(84px,1fr) minmax(84px,1fr) minmax(90px,1fr) 64px 20px';
    const keepHead = hasCost ? 'You keep' : 'Over market';
    const more = (r, name) => (<button type="button" aria-label={'Open ' + r.code} title={'Open ' + r.code + ' ' + name} onClick={e => { e.stopPropagation(); openPanel(r.code, e); }}
      style={css('appearance:none;border:0;background:transparent;padding:0;width:20px;height:28px;display:grid;place-items:center;cursor:pointer;color:var(--faint);')}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></button>);
    const btnBase = 'flex:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:700;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';';
    const ghostBtn = btnBase + 'border:1px solid var(--line);background:#fff;color:var(--ink);transition:border-color .2s ease,color .2s ease,background .2s ease;';
    const addable = Object.keys(data.market).filter(c => !rows.some(r => r.code === c)).sort();

    return (<div ref={boardRef} style={css('display:grid;grid-template-columns:' + (wide ? 'minmax(0,1fr) 330px' : 'minmax(0,1fr)') + ';gap:14px;align-items:start;')}>
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
            <span /><span>Currency</span><span style={{ textAlign: 'right' }}>Market</span>{hasCost && <span style={{ textAlign: 'right' }}>You paid</span>}<span style={{ textAlign: 'right' }}>We buy</span><span style={{ textAlign: 'right' }}>We sell</span><span style={{ textAlign: 'right' }}>{keepHead}</span><span style={{ textAlign: 'center' }}>On board</span><span />
          </div>}
          {list.map((r, i) => {
            const pair = r.mid ? B.deskPair(r.mid, r.spreadPct, r.spreadPct) : null;
            const cost = costOf(r.code);
            const pct = pair ? (pair.sell - (cost || r.mid)) / (cost || r.mid) * 100 : 0;
            const tone = toneOf(pct, B.floorFor(settings, r.code), target);
            const keepChip = chip(tone);
            const keep = pair ? (pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%' : '·';
            const name = FACE.currencyName(r.code);
            const dragProps = readOnly || ql ? {} : {
              draggable: true,
              onDragStart: e => { drag.current = r.code; e.dataTransfer.effectAllowed = 'move'; },
              onDragOver: e => { if (drag.current && drag.current !== r.code) e.preventDefault(); },
              onDrop: e => { e.preventDefault(); if (drag.current && drag.current !== r.code) moveTo(drag.current, r.code); drag.current = null; },
              onKeyDown: e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(r.code, e.key === 'ArrowUp' ? -1 : 1); } },
            };
            /* The dotted handle, on the table and on a phone's cards. */
            const handle = (<span title={dragProps.draggable ? 'Drag to reorder (or Alt and the arrow keys)' : undefined} onPointerDown={dragProps.draggable ? fingerDrag(r.code) : undefined}
              style={css('flex:none;display:inline-grid;place-items:center;min-width:22px;min-height:32px;margin:-6px 0;color:var(--faint);font-size:14px;letter-spacing:-2px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:' + (dragProps.draggable ? 'grab' : 'default') + ';')}>⋮⋮</span>);
            if (cards) return (<div key={r.code} data-rate-row={r.code} {...dragProps} tabIndex={dragProps.draggable ? 0 : undefined} aria-label={`${r.code} ${name}`}
              style={css('padding:14px 16px;' + (i ? 'border-top:1px solid var(--hair);' : '') + (r.show ? '' : 'opacity:0.55;'))}>
              <div style={css('display:flex;align-items:center;gap:11px;')}>
                {dragProps.draggable && handle}
                <Flag code={r.code} />
                <span style={css('flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}><b style={css('font-size:15px;font-weight:800;')}>{r.code}</b> <span style={css('font-size:12.5px;color:var(--mute);')}>{name}</span></span>
                <Switch on={r.show} off={readOnly} onClick={() => toggle(r)} name={`${r.code} on the board`} />
                {more(r, name)}
              </div>
              <div style={css('display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;margin-top:12px;')}>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>We buy</span><span style={css('font-family:var(--m);font-size:15px;')}>{pair ? fx(pair.buy) : 'No rate'}</span></span>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>We sell</span><span style={css('font-family:var(--m);font-size:15px;font-weight:700;')}>{pair ? fx(pair.sell) : 'No rate'}</span></span>
                <span><span style={css('display:block;font-family:var(--m);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--faint);')}>{keepHead}</span><span data-tone={tone} style={keepChip}>{keep}</span></span>
              </div>
              <div style={css('font-family:var(--m);font-size:10.5px;color:var(--faint);margin-top:9px;')}>{r.mid ? 'Market ' + fx(r.mid) + (r.pinned ? ' · pinned' : '') : 'No market rate'}</div>
            </div>);
            return (<div key={r.code} data-rate-row={r.code} {...dragProps} tabIndex={dragProps.draggable ? 0 : undefined} aria-label={`${r.code} ${name}`}
              style={css('display:grid;grid-template-columns:' + cols + ';min-width:0;align-items:center;gap:12px;padding:12px 16px;transition:background .15s ease;' + (i ? 'border-top:1px solid var(--hair);' : '') + (r.show ? '' : 'opacity:0.55;'))}>
              {handle}
              <span style={css('display:flex;align-items:center;gap:11px;min-width:0;')}><Flag code={r.code} /><span style={css('min-width:0;')}><b style={css('display:block;font-size:14.5px;font-weight:800;')}>{r.code}</b><span style={css('display:block;font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{name}{r.pinned ? ' · pinned' : ''}</span></span></span>
              <span style={css('text-align:right;font-family:var(--m);font-size:13px;color:var(--mute);')}>{r.mid ? fx(r.mid) : 'No rate'}</span>
              {hasCost && <span style={css('text-align:right;font-family:var(--m);font-size:14.5px;')}>{cost ? fx(cost) : '·'}</span>}
              <span style={css('text-align:right;font-family:var(--m);font-size:14.5px;')}>{pair ? fx(pair.buy) : '·'}</span>
              <span style={css('text-align:right;font-family:var(--m);font-size:14.5px;font-weight:700;')}>{pair ? fx(pair.sell) : '·'}</span>
              <span style={{ textAlign: 'right' }}><span data-tone={tone} style={keepChip}>{keep}</span></span>
              <span style={css('display:flex;justify-content:center;')}><Switch on={r.show} off={readOnly} onClick={() => toggle(r)} name={`${r.code} on the board`} /></span>
              {more(r, name)}
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
          <div style={css('display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 11px 13px; border-radius: 13px; border: 1px solid var(--line);')}>
            <span style={css('flex: 1; min-width: 0;')}><b style={css('display: block; font-family: var(--m); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;')}>Auto-publish</b><span style={css('display: block; font-size: 12px; line-height: 1.4; color: var(--mute); margin-top: 2px;')}>Every market refresh goes straight out.</span></span>
            <Switch on={!!data.autoPublish} off={readOnly} name="Auto-publish" onClick={setAuto} />
          </div>
          <div style={css('font-family:var(--m);font-size:11px;line-height:1.6;color:var(--mute);margin-top:11px;')}>{!pub ? 'Nothing published yet' : data.autoPublish ? 'Auto · updates with the market · last ' + ago(pub.publishedAt) : 'Updated ' + ago(pub.publishedAt) + ' by ' + (pub.publishedBy || 'the market feed')}</div>
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
      {/* Over the whole Rates window, as the design's drawer is: the tab
          body animates in, and an animated box would hold the panel
          inside it. */}
      {selRow && boardRef.current && ReactDOM.createPortal(<CurrencyPanel row={selRow} home={home} defPct={defPct} floor={B.floorFor(settings, selRow.code)} target={target} stock={stock}
        low={settings.vaultFloors ? Number(settings.vaultFloors[selRow.code]) : 0} readOnly={readOnly} cards={cards}
        onClose={closePanel} onSpread={pct => setSpread(selRow.code, pct)} onToggle={() => toggle(selRow)}
        onRecord={stock && stock.hasCost && onRecordCash && ['supervisor', 'branch_manager', 'administrator'].includes(serverRole) ? () => onRecordCash(selRow.code) : null} />, boardRef.current.closest('[data-rates]') || document.body)}
    </div>);
  }

  /* The design's folder tabs. */
  const TAB_ICON = { board: 'M5 4h14v16H5zM8.5 8.5h7M8.5 12h7M8.5 15.5h4', site: 'M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0M3 12h18M12 3c2.5 2.6 2.5 15 0 18M12 3c-2.5 2.6-2.5 15 0 18', rules: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4', guard: 'M12 3.2 4 6.4v5.1c0 4.6 3.3 8.5 8 9.3 4.7-.8 8-4.7 8-9.3V6.4zM9.2 12.2 11.3 14.4 15 10.4', stock: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8' };

  function Rates({ settings, setSettings, me, log, serverRole, deals }) {
    const [tab, setTab] = useState('board');
    const [tip, setTip] = useState(null);
    const [toast, setToast] = useState(null);
    const [feed, setFeed] = useState(null);
    /* Lock rates: null, or who locked them and when (GET /api/rates,
       PUT /api/rates/lock). */
    const [lock, setLock] = useState(null);
    const [locking, setLocking] = useState(false);
    const lockRef = useRef(null);
    lockRef.current = lock;
    const rootRef = useRef(null);
    const w = useWidth(rootRef);
    const cards = w < 880;
    const readOnly = !PUBLISHERS.includes(serverRole);
    const flash = useCallback((t) => { setToast(t); clearTimeout(flash.t); flash.t = setTimeout(() => setToast(null), 2400); }, []);
    useEffect(() => {
      getJson('/api/rates/market').then(m => setFeed(m), e => console.warn('[rates] the market feed could not be read', e));
      getJson('/api/rates').then(r => setLock(r.locked || null), e => console.warn('[rates] the lock could not be read', e));
      const esc = (e) => { if (e.key === 'Escape') setTip(null); };
      window.addEventListener('keydown', esc);
      return () => window.removeEventListener('keydown', esc);
    }, []);
    /* The design's tabs. Cost & stock is for plans with the ledger; on a
       Rates plan the owner sees what Full System adds (locked), and staff
       do not see it. */
    const hasDeals = (settings.billingPlan || 'premium') !== 'basic';
    const owns = (serverRole || (me && me.role === 'Owner' ? 'administrator' : '')) === 'administrator';
    const tabs = [['board', 'Board']].concat(hasDeals ? [['stock', 'Cost & stock']] : (owns ? [['stock', 'Cost & stock', true]] : []),
      [['site', 'Website & window'], ['rules', 'Pricing & rates'], ['guard', 'Guardrails']]);
    /* Record cash bought: from Cost & stock, or a currency's panel. */
    const [buying, setBuying] = useState(null);
    const [feedOpen, setFeedOpen] = useState(false);
    const [stockVersion, setStockVersion] = useState(0);
    const setLocked = async (on) => {
      if (readOnly || locking) return;
      setLocking(true);
      try {
        const res = await fetch('/api/rates/lock', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locked: on }) });
        if (!res.ok) { flash(res.status === 403 ? 'Only the owner and managers can lock rates.' : 'The lock did not change (the server answered ' + res.status + ').'); return; }
        setLock((await res.json()).locked || null);
        flash(on ? 'Rates locked. Nothing changes until you unlock them.' : 'Rates unlocked');
      } catch (e) {
        flash('The lock did not change. Check the connection and try again.');
      } finally { setLocking(false); }
    };
    const isLocked = !!lock;
    /* The desk's top bar has the same lock. It hears a change made here
       (a storage event), and this hears one made there. */
    useEffect(() => {
      const on = isLocked ? '1' : '0';
      let was = null;
      try { was = localStorage.getItem('yorkfx_rates_locked'); localStorage.setItem('yorkfx_rates_locked', on); } catch (e) { return; }
      if (was !== on) { try { window.dispatchEvent(new StorageEvent('storage', { key: 'yorkfx_rates_locked', newValue: on })); } catch (e) { console.warn('[rates] the top bar was not told about the lock', e); } }
    }, [isLocked]);
    useEffect(() => {
      const heard = (e) => {
        if (!e || e.key !== 'yorkfx_rates_locked') return;
        const on = e.newValue === '1';
        if (on !== !!lockRef.current) getJson('/api/rates').then(r => setLock(r.locked || null), err => console.warn('[rates] the lock could not be read', err));
      };
      window.addEventListener('storage', heard);
      return () => window.removeEventListener('storage', heard);
    }, []);
    const feedAgo = feed && feed.fetchedAt ? ago(feed.fetchedAt) : null;

    return (<div ref={rootRef} data-rates="true" style={{ ...TOKENS, position: 'relative', lineHeight: 'normal', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'rgba(251,250,247,0.96)' }}>
      <div style={css('flex:none;padding:' + (cards ? '16px 16px 0' : '22px 26px 0') + ';border-bottom:1px solid var(--line);background:#fbfaf7;')}>
        <div style={css('display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;')}>
          <div style={css('flex:1 1 260px;min-width:0;')}>
            <h1 style={css('margin:0;font-size:clamp(28px, 3.4vw, 42px);font-weight:800;letter-spacing:-0.03em;line-height:1;')}>Today's rates</h1>
            <p style={css("margin:8px 0 0;font-family:var(--m);font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--mute);")}>What it's worth · what you paid · what you charge</p>
          </div>
          <div style={css('display:flex;align-items:center;gap:8px;flex-wrap:wrap;')}>
            <button type="button" onClick={() => setFeedOpen(true)} style={css('display:inline-flex;align-items:center;gap:9px;height:40px;max-width:100%;padding:0 12px 0 13px;border-radius:11px;border:1px solid var(--line);background:#fff;cursor:pointer;text-align:left;')}>
              <span style={css('flex:none;width:8px;height:8px;border-radius:50%;background:' + (feed && feed.provider ? '#2EA36B' : '#9a938a') + ';' + (feed && feed.provider ? 'animation:rtLive 2s infinite;' : ''))} />
              <span style={css('min-width:0;line-height:1.15;')}><b style={css('display:block;font-size:12.5px;white-space:nowrap;')}>{feed && feed.provider ? 'Live feed' : 'No market feed'}</b><span style={css('display:block;font-family:var(--m);font-size:9.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{feed && feed.provider ? feed.provider + ' · hourly' + (feedAgo ? ' · ' + feedAgo : '') : 'Rates hold at the last publish'}</span></span>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="var(--mute)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <button type="button" onClick={() => setLocked(!isLocked)} disabled={readOnly || locking} title={isLocked && lock.by ? 'Locked by ' + lock.by : undefined}
              style={css('display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 14px;border-radius:11px;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';font-family:var(--m);font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;transition:background .25s cubic-bezier(.22,1,.36,1),border-color .25s ease,box-shadow .25s ease,color .2s ease;border:1px solid ' + (isLocked ? 'var(--lock)' : 'var(--line)') + ';background:' + (isLocked ? 'var(--lock)' : '#fff') + ';color:' + (isLocked ? '#fff' : 'var(--ink)') + ';box-shadow:' + (isLocked ? '0 1px 0 rgba(255,255,255,0.25) inset, 0 2px 7px rgba(224,161,6,0.45)' : 'none') + ';')}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d={isLocked ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-2'} /></svg>{isLocked ? 'Locked' : 'Lock rates'}
            </button>
          </div>
        </div>
        <div role="tablist" aria-label="Rates" style={css('display:flex;align-items:flex-end;gap:2px;margin:16px ' + (cards ? '-16px' : '-26px') + ' 0;padding:0 ' + (cards ? '12px' : '26px') + ';overflow-x:auto;scrollbar-width:none;border-bottom:3px solid var(--primary);')}>
          {tabs.map(([id, label, lockedTab]) => { const on = tab === id; return (<button key={id} type="button" role="tab" aria-selected={on} data-tour={id === 'site' ? 'rate-page' : undefined} onClick={() => { setTab(id); setTip(null); }}
            style={css('flex:none;display:inline-flex;align-items:center;gap:9px;appearance:none;border:0;cursor:pointer;white-space:nowrap;font-family:var(--m);font-size:' + (cards ? '11px' : '12.5px') + ';letter-spacing:0.12em;text-transform:uppercase;font-weight:700;transition:background .2s ease,color .2s ease;'
              + (on ? 'background:var(--primary);color:#fff;padding:' + (cards ? '11px 26px 11px 13px' : '13px 34px 13px 18px') + ';border-radius:5px 0 0 0;clip-path:polygon(0 0,calc(100% - 20px) 0,100% 100%,0 100%);'
                : 'background:transparent;color:var(--mute);padding:' + (cards ? '11px 13px' : '13px 16px') + ';'))}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d={TAB_ICON[id]} /></svg>{label}{lockedTab && <svg aria-label="Full System" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>}</button>); })}
        </div>
      </div>
      {readOnly && <div style={css('flex:none;display:flex;align-items:center;gap:10px;padding:10px 24px;font-size:12.5px;font-weight:500;border-bottom:1px solid var(--line);background:rgba(23,20,15,0.04);color:var(--mute);')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" /></svg>
        <span style={css('flex:1;min-width:0;')}>You can see today's rates. Changing them is for the owner and managers.</span>
      </div>}
      {!readOnly && isLocked && <div style={css('flex:none;display:flex;align-items:center;gap:10px;padding:10px 24px;font-size:12.5px;font-weight:600;animation:rtIn .28s cubic-bezier(.22,1,.36,1) both;border-bottom:1px solid rgba(224,161,6,0.32);background:var(--lock-soft);color:var(--lock-text);')}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" /></svg>
        <span style={css('flex:1;min-width:0;')}>Rates are locked. Unlock them to make changes.</span>
        <button type="button" onClick={() => setLocked(false)} disabled={locking} style={css('flex:none;appearance:none;border:0;background:none;cursor:pointer;padding:2px 0;font-family:var(--m);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:var(--lock-text);')}>Unlock</button>
      </div>}
      <div style={css('flex:1;min-height:0;overflow-y:auto;')}>
        <div key={'t-' + tab} style={css('padding:' + (cards ? '14px 12px 90px' : '20px 26px 90px') + ';animation:rtIn .3s cubic-bezier(.22,1,.36,1) both;')}>
          {tab === 'board' && <Board settings={settings} setSettings={setSettings} locked={isLocked} onRecordCash={hasDeals ? (code) => setBuying({ code }) : null} onLock={l => setLock(l || null)} serverRole={serverRole} me={me} log={log} w={w} tip={tip} onTip={setTip} onToast={flash} onOpenSite={() => setTab('site')} />}
          {tab === 'stock' && <window.CDOS.RatesStock settings={settings} serverRole={serverRole} me={me} hasDeals={hasDeals} owns={owns} w={w} version={stockVersion} onRecord={(code) => setBuying({ code })} />}
          {tab === 'site' && <window.CDOS.RatesSite serverRole={serverRole} onToast={flash} settings={settings} setSettings={setSettings} />}
          {tab === 'rules' && <window.CDOS.RatesPricing settings={settings} setSettings={setSettings} me={me} log={log} serverRole={serverRole} onToast={flash} locked={isLocked} w={w} onGoGuard={() => setTab('guard')} />}
          {tab === 'guard' && <window.CDOS.RatesGuard settings={settings} setSettings={setSettings} me={me} log={log} serverRole={serverRole} deals={deals} locked={isLocked} />}
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
      {feedOpen && <FeedSheet feed={feed} locked={isLocked} canLock={!readOnly} cards={cards} onClose={() => setFeedOpen(false)}
        onLock={() => { setFeedOpen(false); setLocked(true); }} onPins={() => { setFeedOpen(false); setTab('rules'); }} />}
      {buying && <window.CDOS.RatesRecordCash code={buying.code} onClose={() => setBuying(null)} onDone={(msg) => { setBuying(null); setStockVersion(v => v + 1); flash(msg); }} />}
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
  window.CDOS = Object.assign(window.CDOS || {}, { Rates, ratesUi: { css, Flag, track, Switch, useWidth, seg, pill, fx, ago, getJson, orElse, chip, toneOf, publishRows, PUBLISHERS } });
})();
