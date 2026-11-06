/* ============================================================
   CurrencyDesk OS: Rates, the Website & window tab (Rates v2.5)

   Where the shop's published board is shown, in the look of the design
   file (CurrencyDesk Rates v2.5, "isSite"): two tiles with live previews,
   the rate page editor ("Your online rate page") and the window screens
   page. Every shop already has a rate page at its own address, private
   until the owner turns it on.

   The owner names the shop's public rate page (/r/<address>) and takes it
   live; staff who may change rates add and retire window screens
   (/s/<token>). The server decides every one of these (PUT /api/rate-page
   needs site:publish, the screen routes need rates:change); this tab only
   shows each person what they can do, and says plainly when the server
   refuses.

   Since the editor: staff who may change rates also edit what the page
   says (PATCH /api/rate-page/content, rates:change), and the regulator
   block is the owner's (site:publish), as in auth/permissions.ts. Changes
   save as you type; the preview reloads after each save.
   ============================================================ */
(function () {
  const { useState, useEffect, useCallback, useRef } = React;
  const FACE = window.CurrencyFace;
  const EDITORS = ['branch_manager', 'administrator'];
  const PAGE_ERRORS = {
    400: 'Use 3 to 40 lowercase letters, numbers and hyphens, starting and ending with a letter or number.',
    403: 'Only the owner can change that.',
    409: 'Another shop already uses that address. Pick another.',
    422: 'Choose an address before the page goes live.',
  };
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0];
  /* Screen kinds the server knows, with the size each previews at. */
  const KINDS = [['tv', 'TV in landscape', '16:9 · most shop windows', 1920, 1080], ['portrait', 'Screen on its side', '9:16 · tall and narrow', 1080, 1920], ['tablet', 'Tablet on the counter', '4:3 · facing customers', 1024, 768], ['strip', 'Strip above the counter', '8:1 · scrolling ticker', 1920, 240]];
  const LAYOUTS = { one: 'One column', two: 'Two columns', rotate: 'Rotate pages' };
  const SHOWS = [['flags', 'Flags'], ['names', 'Currency names'], ['clock', 'Clock'], ['hours', 'Opening hours'], ['logo', 'Your logo']];

  /* Whatever the owner picks is drawn onto a 240px square and sent as a
     PNG: the server takes nothing else. Drawing it also turns any picture,
     an SVG logo included, into plain pixels. */
  function pngFrom(src, done) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const size = 240, c = document.createElement('canvas');
        c.width = size; c.height = size;
        const scale = Math.min(size / (img.width || size), size / (img.height || size));
        const w = (img.width || size) * scale, h = (img.height || size) * scale;
        c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        if (done) done();
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { if (done) done(); reject(new Error('That picture could not be read.')); };
      img.src = src;
    });
  }
  function logoPng(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return Promise.reject(new Error('Use a PNG, JPG or WebP picture.'));
    const url = URL.createObjectURL(file);
    return pngFrom(url, () => URL.revokeObjectURL(url));
  }

  async function call(method, url, body) {
    const res = await fetch(url, body
      ? { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method, credentials: 'same-origin' });
    /* An error answer may have no JSON body; the status says enough. */
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }
  /* A screen's sighting as the design says it: On while it asked in the
     last ten minutes, then Last seen, or Not opened yet. */
  function sighting(ms) {
    if (!ms) return { on: false, seen: false, text: 'Not opened yet' };
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    const txt = m < 2 ? 'just now' : (m < 60 ? m + ' min ago' : (m < 1440 ? Math.floor(m / 60) + 'h ago' : Math.floor(m / 1440) + 'd ago'));
    return m < 10 ? { on: true, seen: true, text: 'On · seen ' + txt } : { on: false, seen: true, text: 'Last seen ' + txt };
  }
  const sightDot = (s) => 'flex:none;width:7px;height:7px;border-radius:50%;background:' + (s.on ? '#2EA36B' : (s.seen ? '#D9A441' : 'rgba(23,20,15,0.25)')) + ';' + (s.on ? 'animation:rtLive 2s infinite;' : '');

  /* 24 is midnight at the end of the day: 12 am. */
  function fmtT(v) { const h = Math.floor(v), m = Math.round((v - h) * 60), h12 = h % 12 || 12; return h12 + ':' + String(m).padStart(2, '0') + (h < 12 || h === 24 ? ' am' : ' pm'); }
  const TIME_OPTS = []; for (let t = 6; t <= 23.5; t += 0.5) TIME_OPTS.push({ v: String(t), l: fmtT(t) });
  function initials(name) { return String(name || 'Shop').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }

  /* Typing saves after a short pause, one request for the lot. */
  function useDebouncedSave(save) {
    const pending = useRef({});
    const timer = useRef(null);
    const latest = useRef(save);
    latest.current = save;
    /* Leaving the tab or closing Rates sends what was typed in the last
       moment rather than dropping it. */
    useEffect(() => () => {
      clearTimeout(timer.current);
      const p = pending.current; pending.current = {};
      if (Object.keys(p).length) latest.current(p);
    }, []);
    return useCallback((patch, now) => {
      pending.current = { ...pending.current, ...patch };
      clearTimeout(timer.current);
      const flush = () => { const p = pending.current; pending.current = {}; save(p); };
      if (now) flush(); else timer.current = setTimeout(flush, 700);
    }, [save]);
  }

  function Seg({ items, ui }) {
    return (<span style={ui.css('display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; background: rgba(23,20,15,0.06); flex-wrap: wrap;')}>
      {items.map(o => <button key={o.label} type="button" aria-pressed={o.on} onClick={o.onPick} style={o.style}>{o.label}</button>)}
    </span>);
  }

  function Back({ ui, onBack, title, lead }) {
    const { css } = ui;
    return (<div style={css('display: flex; flex-direction: column; gap: 6px; animation: rtIn .28s cubic-bezier(.22,1,.36,1) both;')}>
      <button type="button" onClick={onBack} style={css('align-self: flex-start; appearance: none; border: 0; background: none; padding: 4px 0; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--primary);')}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>Website &amp; window</button>
      <h2 style={css('margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.02em;')}>{title}</h2>
      <p style={css('margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--mute); max-width: 620px;')}>{lead}</p>
    </div>);
  }

  /* The design's currency chip: flag, code, and its place in the order. */
  function Chip({ ui, code, at, picking, off, onToggle }) {
    const { css, Flag } = ui;
    const on = at >= 0;
    return (<button type="button" aria-pressed={on} aria-label={code} onClick={onToggle} disabled={off}
      style={css('appearance:none;display:flex;align-items:center;gap:8px;height:40px;padding:0 9px 0 8px;border-radius:11px;cursor:' + (off ? 'not-allowed' : 'pointer') + ';transition:border-color .18s ease,opacity .18s ease;background:' + (on ? '#fff' : 'rgba(23,20,15,0.025)') + ';border:' + (on && picking ? '1.5px solid var(--primary)' : '1px solid var(--line)') + ';opacity:' + (on ? '1' : '0.62') + ';')}>
      <Flag code={code} size={22} />
      <b style={css('flex: 1; min-width: 0; text-align: left; font-family: var(--m); font-size: 12.5px; color: var(--ink);')}>{code}</b>
      <span style={css('flex:none;min-width:20px;height:20px;padding:0 5px;border-radius:999px;display:' + (picking ? 'grid' : 'none') + ';place-items:center;font-family:var(--m);font-size:10.5px;font-weight:700;background:' + (on ? 'var(--primary)' : 'rgba(23,20,15,0.06)') + ';color:' + (on ? '#fff' : 'var(--mute)') + ';')}>{picking ? (on ? String(at + 1) : '+') : ''}</span>
    </button>);
  }

  /* The business profile as the desk's Settings keeps it (cdos-settings.jsx,
     Business profile). Those fields are the owner's (server/src/state/
     owner-settings.ts), so only the owner's desk copies a saved profile
     into Settings; a manager's change is offered to the owner there. */
  const settingsFromProfile = (p) => ({
    bizPhone: p.phone || '', bizEmail: p.email || '', bizAddress: p.address || '', bizCity: p.city || '',
    bizRegion: p.region || '', bizPostal: p.postal || '',
    hours: p.hours || [], hoursWeek: p.week || null, siteConfigAt: p.updatedAt || null,
  });

  /* The design's Take it further (under the two tiles). Three ways to put
     the rate page on the shop's own web:
     - Use it as the website: the owner sends the domain and where it was
       bought (POST /api/rate-page/domain-request). A person on the team
       points it for now, so the request lands in the team's inbox and the
       desk shows it as requested until it is done or cancelled.
     - No domain yet: how to get one.
     - Pull the rates into the shop's current site: a code to paste that
       shows the live rate page in a frame. The design's plugin and script
       do not exist yet; a frame works on every site builder today, and the
       server lets any site frame /r/ pages (and only those).
     A full website from templates is coming; a fully custom one is sales. */
  const REGISTRARS = ['GoDaddy', 'Namecheap', 'Squarespace', 'Other'];
  const PLATFORMS = ['WordPress', 'Wix', 'Squarespace', 'Shopify', 'Other'];
  const PASTE = {
    WordPress: ['Edit the page where the rates should go.', 'Add a Custom HTML block.', 'Paste the code below into it and update the page.'],
    Wix: ['In the Wix editor, add Embed code, then Embed HTML.', 'Paste the code below into it.', 'Publish your Wix site.'],
    Squarespace: ['Edit a page and add a Code block.', 'Paste the code below into it.', 'Save the page.'],
    Shopify: ['In Online Store, open Pages and edit a page.', 'Switch the editor to HTML (the <> button).', 'Paste the code below and save.'],
    Other: ['Open the page of your site where the rates should go.', 'Paste the code below where they should appear.', 'Save and publish your site.'],
  };
  const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

  function TakeItFurther({ page, owner, onPage, say }) {
    const { css, seg, pill } = window.CDOS.ratesUi;
    const [choice, setChoice] = useState(null);
    const [open, setOpen] = useState(false);
    const [domain, setDomain] = useState('');
    const [registrar, setRegistrar] = useState('GoDaddy');
    const [plat, setPlat] = useState('WordPress');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const pending = page.domainRequest || null;
    const typed = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const domOk = DOMAIN_RE.test(typed);
    const canSend = owner && domOk && !busy;
    const OPTS = [
      ['have', 'Use my rate page as my website', 'Point your own domain, like yourshop.com, at your rate page. We do the technical part.'],
      ['none', 'I don’t have a domain yet', 'Buy one wherever you like, then come back and connect it.'],
      ['plugin', 'Pull my rates into my current website', 'A code to paste. WordPress, Wix, Squarespace and more.'],
    ];
    const cur = OPTS.find(o => o[0] === choice);
    const send = async () => {
      if (!canSend) return;
      setBusy(true);
      try {
        const r = await call('POST', '/api/rate-page/domain-request', { domain: typed, registrar });
        if (r.ok) { onPage(p => ({ ...p, domainRequest: r.data.domainRequest })); setDomain(''); say('Sent to the team'); }
        else say(r.status === 403 ? 'Only the owner can connect a domain.' : (r.data && r.data.detail) || 'The request was not sent (the server answered ' + r.status + ').');
      } finally { setBusy(false); }
    };
    const cancel = async () => {
      setBusy(true);
      try {
        const r = await call('DELETE', '/api/rate-page/domain-request');
        if (r.ok) { onPage(p => ({ ...p, domainRequest: null })); say('Request cancelled'); }
        else say('The request was not cancelled (the server answered ' + r.status + ').');
      } finally { setBusy(false); }
    };
    /* The shop's name goes into an attribute of code pasted into another
       site, so it is escaped there. The address is the server's checked slug. */
    const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const code = '<iframe src="' + location.origin + '/r/' + encodeURIComponent(page.slug) + '" title="' + attr(((page.content && page.content.name) || 'Our') + ' exchange rates') + '" loading="lazy" style="width:100%;height:760px;border:0"></iframe>';
    const copyCode = async () => {
      try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); }
      catch (e) { say('The code could not be copied. Select it and copy it.'); }
    };
    const step = (n, head, body) => (<div key={n} style={css('display: flex; align-items: flex-start; gap: 12px;')}><span style={css('flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; font-family: var(--m); font-size: 11.5px; font-weight: 700; background: var(--ink); color: #fff;')}>{n}</span><span style={css('min-width: 0;')}>{head && <b style={css('display: block; font-size: 14px;')}>{head}</b>}<span style={css('display: block; font-size: 12.5px; line-height: 1.5; color: var(--mute);' + (head ? ' margin-top: 2px;' : ''))}>{body}</span></span></div>);
    const segRow = (opts, now, fn, label) => (<span role="group" aria-label={label} style={css('display: inline-flex; gap: 3px; padding: 3px; border-radius: 10px; background: rgba(23,20,15,0.06); flex-wrap: wrap;')}>{seg(opts, now, fn, false).map(o => <button key={o.label} type="button" aria-pressed={o.on} onClick={o.onPick} style={o.style}>{o.label}</button>)}</span>);
    const when = pending ? new Date(pending.at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';

    return (<section aria-label="Take it further" style={css('display: flex; flex-direction: column; gap: 10px;')}>
      <div style={css('font-family: var(--m); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); font-weight: 700;')}>Take it further</div>
      <div style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line);')}>
        <div style={css('padding: 16px 16px 0;')}>
          <b style={css('display: block; font-size: 15px;')}>Connect your rate page to your website</b>
          <span style={css('display: block; font-size: 13px; line-height: 1.5; color: var(--mute); margin-top: 3px;')}>Put the page we made for you on your own address, or pull your rates into the site you already have. Both are free.</span>
        </div>
        <div style={css('position: relative; padding: 14px 16px 16px;')}>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={css('width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: rgba(23,20,15,0.03); cursor: pointer; text-align: left;')}>
            <span style={css('flex: 1; min-width: 0; text-align: left;')}><b style={css('display: block; font-size: 14px; color: var(--ink);')}>{cur ? cur[1] : 'Choose how to connect it'}</b><span style={css('display: block; font-size: 12px; color: var(--mute); margin-top: 2px;')}>{cur ? cur[2] : 'Use your own domain, or pull your rates into your current site'}</span></span>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--mute)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {open && <div style={css('display: flex; flex-direction: column; gap: 4px; margin-top: 6px; padding: 6px; border-radius: 12px; border: 1px solid var(--line); background: #fff; box-shadow: 0 18px 40px -20px rgba(23,20,15,0.4);')}>
            {OPTS.map(o => (<button key={o[0]} type="button" onClick={() => { setChoice(o[0]); setOpen(false); }} style={css('appearance: none; display: flex; align-items: flex-start; gap: 10px; padding: 10px 11px; border: 0; border-radius: 10px; cursor: pointer; text-align: left; background: ' + (choice === o[0] ? 'var(--green-soft)' : 'transparent') + ';')}>
              <span style={css('flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: ' + (choice === o[0] ? 'var(--primary)' : 'rgba(23,20,15,0.2)') + ';')} /><span style={css('flex: 1; min-width: 0; text-align: left;')}><b style={css('display: block; font-size: 13.5px;')}>{o[1]}</b><span style={css('display: block; font-size: 12px; line-height: 1.45; color: var(--mute); margin-top: 2px;')}>{o[2]}</span></span></button>))}
          </div>}
        </div>
        {choice && <div key={choice} style={css('padding: 16px; border-top: 1px solid var(--hair); animation: rtIn .26s cubic-bezier(.22,1,.36,1) both;')}>
          {choice === 'have' && pending && <div style={css('display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;')}>
            <span style={css('flex: 1 1 260px; min-width: 0;')}><span style={css('display: inline-flex; align-items: center; gap: 6px; font-family: var(--m); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; color: var(--amber); background: var(--amber-soft); padding: 4px 10px; border-radius: 999px;')}><span style={css('width: 6px; height: 6px; border-radius: 50%; background: currentColor;')} />{'Requested · ' + when}</span>
              <b style={css('display: block; font-size: 15px; margin-top: 9px;')}>{'Connecting ' + pending.domain}</b>
              <span style={css('display: block; font-size: 13px; line-height: 1.5; color: var(--mute); margin-top: 3px;')}>{'Bought at ' + pending.registrar + '. The team points it at your rate page and tells you when it is live. Reference ' + pending.reference + '.'}</span></span>
            {owner && <button type="button" onClick={cancel} disabled={busy} style={css('flex: none; appearance: none; height: 38px; padding: 0 15px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font-size: 13px; font-weight: 700; cursor: pointer;')}>Cancel request</button>}
          </div>}
          {choice === 'have' && !pending && <>
            <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;')}>
              <label style={css('display: block;')}><span style={css('display: block; font-size: 13px; font-weight: 700; margin-bottom: 7px;')}>Your domain</span><input value={domain} onChange={e => setDomain(e.target.value)} placeholder="yourshop.com" disabled={!owner} style={css('width: 100%; height: 42px; padding: 0 13px; border-radius: 11px; border: 1px solid var(--line); background: #fff; outline: none; font-size: 15px; color: var(--ink); box-sizing: border-box;')} /></label>
              <div><span style={css('display: block; font-size: 13px; font-weight: 700; margin-bottom: 7px;')}>Where did you buy it?</span>{segRow(REGISTRARS, registrar, setRegistrar, 'Where did you buy it?')}</div>
            </div>
            <div style={css('display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px;')}>
              <button type="button" onClick={send} disabled={!canSend} style={css('flex: none; display: inline-flex; align-items: center; height: 40px; padding: 0 17px; border: 0; border-radius: 11px; font-size: 13px; font-weight: 700; cursor: ' + (canSend ? 'pointer' : 'not-allowed') + '; background: ' + (canSend ? 'var(--primary)' : 'rgba(23,20,15,0.1)') + '; color: ' + (canSend ? '#fff' : 'rgba(23,20,15,0.4)') + ';')}>Send to the team</button>
              <span style={css('flex: 1 1 220px; font-size: 12.5px; line-height: 1.5; color: var(--mute);')}>{owner ? 'We point your domain at your rate page and tell you when it’s live. No charge.' : 'Only the owner can connect a domain.'}</span>
            </div>
          </>}
          {choice === 'none' && <>
            <div style={css('display: flex; flex-direction: column; gap: 12px;')}>
              {step('1', 'Buy a domain anywhere', 'Any registrar works: GoDaddy, Namecheap, Squarespace. Your shop name is usually the best choice.')}
              {step('2', 'You only need the name', 'No hosting, email or website builder. Your rate page is the website.')}
              {step('3', 'Come back and connect it', 'Choose “Use my rate page as my website” and type the name. We do the technical part and tell you when it’s live.')}
            </div>
            <div style={css('margin-top: 14px;')}><button type="button" onClick={() => setChoice('have')} style={css('appearance: none; height: 38px; padding: 0 15px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font-size: 13px; font-weight: 700; cursor: pointer;')}>I’ve got one, connect it</button></div>
          </>}
          {choice === 'plugin' && <>
            <div><span style={css('display: block; font-size: 13px; font-weight: 700; margin-bottom: 7px;')}>What is your site built on?</span>{segRow(PLATFORMS, plat, setPlat, 'What is your site built on?')}</div>
            <div style={css('display: flex; flex-direction: column; gap: 11px; margin-top: 16px;')}>{(PASTE[plat] || PASTE.Other).map((t, i) => step(String(i + 1), null, t))}</div>
            <pre aria-label="Code to paste" style={css('margin: 14px 0 0; padding: 12px 14px; border-radius: 12px; background: #17140F; color: #F1EEE8; font-family: var(--m); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;')}>{code}</pre>
            {!page.live && <div style={css('margin-top: 10px; padding: 10px 12px; border-radius: 11px; background: var(--amber-soft); color: var(--amber); font-size: 12.5px; font-weight: 600;')}>Your rate page is private. Until it is live, this shows that the page is not available.</div>}
            <div style={css('display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;')}>
              <button type="button" onClick={copyCode} style={pill(copied)}>{copied ? 'Copied' : 'Copy code'}</button>
              <span style={css('flex: 1 1 220px; font-size: 12.5px; line-height: 1.5; color: var(--mute);')}>Shows your live rate page and updates on its own. Free on every plan.</span>
            </div>
          </>}
        </div>}
        <div style={css('display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; padding: 16px; border-top: 1px solid var(--hair); background: rgba(23,20,15,0.02); border-radius: 0 0 16px 16px;')}>
          <span style={css('flex: 1 1 300px; min-width: 0;')}>
            <span style={css('display: inline-flex; align-items: center; gap: 6px; font-family: var(--m); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; color: var(--amber); background: var(--amber-soft); padding: 4px 10px; border-radius: 999px;')}><span style={css('width: 6px; height: 6px; border-radius: 50%; background: currentColor;')} />Coming soon</span>
            <b style={css('display: block; font-size: 14.5px; margin-top: 9px;')}>Build a full website in a few clicks</b>
            <span style={css('display: block; font-size: 12.5px; line-height: 1.55; color: var(--mute); margin-top: 3px;')}>Pick a template, add your pages and photos, and your live rates are built in. Same address, nothing to move.</span>
          </span>
          <span style={css('flex: 0 1 260px; min-width: 0; padding-left: 14px; border-left: 1px solid var(--line);')}>
            <b style={css('display: block; font-size: 14px;')}>Want it fully custom?</b>
            <span style={css('display: block; font-size: 12.5px; line-height: 1.5; color: var(--mute); margin-top: 2px;')}>Our team can design and build a site just for your shop.</span>
            <a href="/contact" target="_blank" rel="noopener" style={css('display: inline-flex; align-items: center; height: 36px; margin-top: 10px; padding: 0 14px; border-radius: 10px; background: var(--ink); color: #fff; font-size: 13px; font-weight: 700; text-decoration: none;')}>Contact sales</a>
          </span>
        </div>
      </div>
    </section>);
  }

  function RatesSite({ serverRole, onToast, settings, setSettings }) {
    const ui = window.CDOS.ratesUi;
    const { css, Switch, useWidth, seg, pill } = ui;
    const owner = serverRole === 'administrator';
    const readOnly = !EDITORS.includes(serverRole);
    const rootRef = useRef(null);
    const w = useWidth(rootRef);
    const [view, setView] = useState(null);
    const [page, setPage] = useState(null);
    const [draft, setDraft] = useState(null);
    const [screens, setScreens] = useState([]);
    const [board, setBoard] = useState([]);
    const [sel, setSel] = useState(null);
    const [copied, setCopied] = useState(null);
    const [device, setDevice] = useState('Phone');
    const [frame, setFrame] = useState(0);
    const [menu, setMenu] = useState(false);
    const [slug, setSlug] = useState('');
    const [err, setErr] = useState(null);
    const say = useCallback((text) => { if (onToast) onToast(text); }, [onToast]);

    const load = useCallback(async () => {
      try {
        const [p, s, r] = await Promise.all([call('GET', '/api/rate-page'), call('GET', '/api/window-screens'), call('GET', '/api/rates')]);
        if (!p.ok || !s.ok) throw new Error(`the server answered ${p.ok ? s.status : p.status}`);
        setPage(p.data); setSlug(p.data.slug);
        setDraft({ ...p.data.content, profile: p.data.profile });
        setScreens(s.data.screens);
        setSel(cur => (s.data.screens.some(x => x.id === cur) ? cur : (s.data.screens[0] ? s.data.screens[0].id : null)));
        /* The currencies a page or screen can show: the published board, in its order. */
        const b = r.ok && r.data && r.data.board;
        if (b && b.rows) setBoard((b.order || Object.keys(b.rows)).filter(c => b.rows[c] && b.rows[c].show !== false));
      } catch (e) { setErr(`Your website and screens could not be loaded (${e.message}).`); }
    }, []);
    useEffect(() => { load(); }, [load]);
    /* On the screens page, ask again every 30 seconds, so a screen that
       has just been switched on shows as On. */
    useEffect(() => {
      if (view !== 'screen') return undefined;
      load();
      const every = setInterval(load, 30 * 1000);
      return () => clearInterval(every);
    }, [view, load]);

    const copy = async (key, path) => {
      try { await navigator.clipboard.writeText(location.origin + path); setCopied(key); setTimeout(() => setCopied(c => (c === key ? null : c)), 1600); }
      catch (e) { say('The link could not be copied. Open it and copy it from the address bar.'); }
    };

    /* ---- the rate page ---- */
    const saveContent = useCallback(async (patch) => {
      if (!Object.keys(patch).length) return;
      const r = await call('PATCH', '/api/rate-page/content', patch);
      if (r.ok) {
        setPage(r.data); setFrame(f => f + 1);
        if (patch.profile && owner && setSettings) setSettings(s => ({ ...s, ...settingsFromProfile(r.data.profile) }));
        return;
      }
      say(r.status === 403 ? 'Only the owner can change that.' : `Not saved: ${(r.data && r.data.detail) || 'the server answered ' + r.status}.`);
      load();
    }, [say, load, owner, setSettings]);
    const queue = useDebouncedSave(saveContent);
    const edit = (key, value, now) => { setDraft(d => ({ ...d, [key]: value })); queue({ [key]: value }, now); };
    const editProfile = (key, value, now) => {
      setDraft(d => ({ ...d, profile: { ...d.profile, [key]: value } }));
      /* The whole editable profile goes each time; an unset week (null) is
         left out, and so are the lines and time the server sends back. */
      const p = draft.profile || {};
      const fields = {};
      ['phone', 'email', 'address', 'city', 'region', 'postal'].forEach(f => { fields[f] = p[f] || ''; });
      if (Array.isArray(p.week)) fields.week = p.week;
      queue({ profile: { ...fields, [key]: value } }, now);
    };
    const sendLogo = async (pngPromise) => {
      try {
        const r = await call('PUT', '/api/rate-page/logo', { dataUrl: await pngPromise });
        if (!r.ok) throw new Error(r.status === 403 ? 'Only the owner and managers can change the logo.' : 'The logo was not saved. Try a smaller picture.');
        setPage(r.data); setFrame(f => f + 1); say('Logo saved');
      } catch (err) { say(err.message); }
    };
    const uploadLogo = (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || readOnly) return;
      sendLogo(logoPng(file));
    };
    /* The logo the desk already has (Settings → Business profile, a data
       URL the owner set), so the shop does not upload it twice. */
    const deskLogo = settings && typeof settings.logo === 'string' && settings.logo.startsWith('data:image/') ? settings.logo : null;
    const useDeskLogo = () => { if (deskLogo && !readOnly) sendLogo(pngFrom(deskLogo)); };
    const removeLogo = async () => {
      const r = await call('DELETE', '/api/rate-page/logo');
      if (r.ok) { setPage(r.data); setFrame(f => f + 1); say('Logo removed'); } else say(`The logo was not removed (the server answered ${r.status}).`);
    };
    const savePage = async (patch) => {
      const r = await call('PUT', '/api/rate-page', patch);
      if (r.ok) { await load(); setFrame(f => f + 1); say(patch.live === true ? 'Your rate page is live' : patch.live === false ? 'Your rate page is private' : 'Address saved'); return; }
      say(PAGE_ERRORS[r.status] || `The rate page was not saved (the server answered ${r.status}).`);
    };

    /* ---- screens ---- */
    const screen = screens.find(x => x.id === sel) || null;
    /* A name being typed saves after a pause; any other change to screens
       takes it along first, so a reload never puts the old name back. */
    const pendingName = useRef(null);
    const nameTimer = useRef(null);
    const patchScreen = useCallback(async (id, patch) => {
      clearTimeout(nameTimer.current);
      const typed = pendingName.current;
      pendingName.current = null;
      if (typed && typed.id !== id) await call('PATCH', `/api/window-screens/${encodeURIComponent(typed.id)}`, { name: typed.name });
      if (typed && typed.id === id && !patch.name) patch = { ...patch, name: typed.name };
      if (!Object.keys(patch).length) return;
      setScreens(list => list.map(x => (x.id === id ? { ...x, ...patch } : x)));
      const r = await call('PATCH', `/api/window-screens/${encodeURIComponent(id)}`, patch);
      if (!r.ok) { say(r.status === 403 ? 'Only the owner and managers can change screens.' : `Not saved: ${(r.data && r.data.detail) || 'the server answered ' + r.status}.`); load(); return; }
      setFrame(f => f + 1);
    }, [say, load]);
    const renameScreen = (id, name) => {
      setScreens(list => list.map(x => (x.id === id ? { ...x, name } : x)));
      clearTimeout(nameTimer.current);
      pendingName.current = name.trim() ? { id, name: name.trim() } : null;
      if (name.trim()) nameTimer.current = setTimeout(() => patchScreen(id, {}), 700);
    };
    const flushName = async () => { if (pendingName.current) await patchScreen(pendingName.current.id, {}); };
    const addScreen = async () => {
      if (readOnly) return;
      await flushName();
      const r = await call('POST', '/api/window-screens', { name: 'Screen ' + (screens.length + 1), kind: 'tv', layout: 'two', theme: 'dark', currencies: [], showHours: true });
      if (!r.ok) { say(r.status === 403 ? 'Only the owner and managers can add screens.' : `The screen was not added (the server answered ${r.status}).`); return; }
      await load(); setSel(r.data.id); setView('screen');
      say('Screen added · copy its link to the screen');
    };
    const resetScreen = async () => {
      await flushName();
      const r = await call('POST', `/api/window-screens/${encodeURIComponent(screen.id)}/reset`);
      setMenu(false);
      if (!r.ok) { say(`The link was not reset (the server answered ${r.status}).`); return; }
      await load(); setFrame(f => f + 1);
      say('New link ready · open it on ' + screen.name);
    };
    const removeScreen = async () => {
      await flushName();
      if (!window.confirm(`Remove ${screen.name}? Its link stops showing rates.`)) return;
      const r = await call('POST', `/api/window-screens/${encodeURIComponent(screen.id)}/retire`);
      setMenu(false);
      if (!r.ok) { say(`${screen.name} was not removed (the server answered ${r.status}).`); return; }
      await load();
      say('Screen removed · its link stops working');
    };

    /* One measured element for every view, so the width follows the tab. */
    const wrap = (el) => <div ref={rootRef}>{el}</div>;
    /* The fee note follows the desk's Pricing (Default commission): when
       the editor opens and the page says something else, staff who may
       change rates bring it in step. */
    const fee = settings && settings.defaultFee != null && settings.defaultFee !== '' ? Number(settings.defaultFee) : 0;
    const home = window.CDOS.deskHomeCcy ? window.CDOS.deskHomeCcy() : '';
    const wantFeeNote = fee > 0 && home ? 'A service fee of ' + fee.toFixed(2) + ' ' + home + ' may apply to each exchange.' : '';
    /* Once per opening of the editor: a refused save reloads the page,
       and trying again on every reload would never stop. */
    const feeSynced = useRef(false);
    useEffect(() => {
      if (view !== 'web') { feeSynced.current = false; return; }
      if (feeSynced.current || readOnly || !page || !page.content) return;
      feeSynced.current = true;
      if ((page.content.feeNote || '') !== wantFeeNote) saveContent({ feeNote: wantFeeNote });
    }, [view, readOnly, page, wantFeeNote, saveContent]);

    if (!page || !draft) return wrap(<div style={css('padding: 24px; font-size: 13px; color: var(--mute);')}>{err || 'Loading your website and screens…'}</div>);

    const pagePath = `/r/${page.slug}`;
    const previewPath = `${pagePath}?preview`;
    const contentW = Math.min(980, w);

    /* ---------- overview: two tiles ---------- */
    if (!view) {
      const two = contentW >= 680, tileW = two ? (contentW - 14) / 2 : contentW;
      const tH = Math.round(Math.min(260, tileW * 0.6));
      const first = screens[0];
      const tiles = [
        { k: 'win', title: 'Window screens', tag: screens.length + (screens.length === 1 ? ' screen' : ' screens'), path: first ? `/s/${first.token}` : null, note: 'Each screen gets its own link. Open it on the TV, tap once and leave it. No login, always on.', vw: 1280, vh: 720, open: 'Open on this screen ↗', edit: first ? 'Set up' : 'Add a screen', go: first ? () => setView('screen') : addScreen, live: screens.some(x => sighting(x.lastSeenAt).on) },
        { k: 'site', title: 'Rate page', tag: page.live ? 'Your website' : 'Private', path: pagePath, src: previewPath, note: page.live ? 'Rates, hours, map and a converter. Share it, put it on Google, link to it from anywhere.' : 'Private: only your staff can see it. The owner turns it on in Edit.', vw: 520, vh: 900, open: 'Open page ↗', edit: 'Edit', go: () => setView('web'), live: page.live },
      ];
      return wrap(<div style={css('display: flex; flex-direction: column; gap: 18px; max-width: 980px;')}>
        <div style={css('display: grid; grid-template-columns: ' + (two ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)') + '; gap: 14px;')}>
          {tiles.map(t => (<section key={t.k} aria-label={t.title} style={css('border-radius: 18px; overflow: hidden; background: #fff; border: 1px solid var(--line); display: flex; flex-direction: column;')}>
            <div onClick={t.go} style={css('position:relative;cursor:pointer;height:' + tH + 'px;overflow:hidden;background:' + (t.k === 'win' ? '#0b0a08' : '#f4f0e6') + ';')}>
              {t.path ? <iframe key={frame} src={t.src || t.path} title={t.title + ' preview'} tabIndex={-1} style={css('position:absolute;top:0;left:0;width:' + t.vw + 'px;height:' + t.vh + 'px;border:0;transform:scale(' + (tileW / t.vw).toFixed(4) + ');transform-origin:0 0;pointer-events:none;')} />
                : <div style={css('position:absolute;inset:0;display:grid;place-items:center;color:rgba(241,238,232,0.6);font-family:var(--m);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;')}>No screen yet</div>}
            </div>
            <div style={css('padding: 14px 16px 16px; border-top: 1px solid var(--line);')}>
              <div style={css('display: flex; align-items: center; gap: 8px;')}><span style={css('width: 7px; height: 7px; border-radius: 50%; background: ' + (t.live ? '#2EA36B; animation: rtLive 2s infinite' : 'rgba(23,20,15,0.25)') + ';')} /><b style={css('font-size: 14.5px;')}>{t.title}</b><span style={css('font-family: var(--m); font-size: 8.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; color: var(--primary-deep); background: var(--green-soft); padding: 2px 7px; border-radius: 999px;')}>{t.tag}</span></div>
              {t.path && <div style={css('font-family: var(--m); font-size: 12px; margin-top: 7px; overflow-wrap: anywhere;')}>{location.host + t.path}</div>}
              <div style={css('font-size: 12.5px; line-height: 1.45; color: var(--mute); margin-top: 4px;')}>{t.note}</div>
              <div style={css('display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap;')}>
                {t.path && <button type="button" onClick={() => copy(t.k, t.path)} style={pill(copied === t.k)}>{copied === t.k ? 'Copied' : 'Copy link'}</button>}
                {t.path && <a href={t.live ? t.path : t.src || t.path} target="_blank" rel="noopener" style={css('display: inline-flex; align-items: center; height: 32px; padding: 0 13px; border-radius: 999px; border: 1px solid var(--line); background: #fff; font-size: 12.5px; font-weight: 600; color: var(--ink);')}>{t.open}</a>}
                <span style={css('flex: 1;')} />
                <button type="button" onClick={t.go} disabled={t.k === 'win' && !first && readOnly} style={css('appearance: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 14px; border-radius: 999px; border: 0; background: var(--ink); color: #fff; font-size: 12.5px; font-weight: 700; cursor: pointer;')}>{t.edit}<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></button>
              </div>
            </div>
          </section>))}
        </div>
        <TakeItFurther page={page} owner={owner} onPage={setPage} say={say} />
      </div>);
    }

    /* ---------- the rate page editor ---------- */
    if (view === 'web') {
      const rpWide = w >= 988;
      const p = draft.profile || {};
      const week = Array.isArray(p.week) ? p.week : [null, null, null, null, null, null, null];
      const setDay = (di, v) => { const h = week.slice(); h[di] = v; editProfile('week', h, true); };
      const input = css('width: 100%; height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; outline: none; font-size: 14px; color: var(--ink);');
      const label = css('display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px;');
      const head = css('font-family: var(--m); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); font-weight: 700;');
      const field = (text, value, onChange, ph, opts) => (<label style={css('display:block;' + (opts && opts.wide ? 'grid-column:1 / -1;' : ''))}><span style={label}>{text}</span>
        <input value={value || ''} onChange={e => onChange(e.target.value)} placeholder={ph} disabled={(opts && opts.locked) || readOnly} style={input} /></label>);
      const synced = (<span style={css('display: inline-flex; align-items: center; gap: 5px; font-family: var(--m); font-size: 9.5px; letter-spacing: 0.06em; color: var(--faint);')}><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 13a8 8 0 0 0 14.3 4.9L20 16M4 4v4h4M20 20v-4h-4" /></svg>Synced with Settings · Business profile</span>);
      const show = draft.show || {};
      const picking = Array.isArray(draft.codes) && draft.codes.length > 0;
      const codesNow = picking ? draft.codes.filter(c => board.includes(c)) : board.slice(0, 6);
      const reg = draft.regulator || { name: '', number: '', officer: '' };
      const regLocked = readOnly || !owner;
      const timeSel = css('height:34px;padding:0 8px;border-radius:9px;border:1px solid var(--line);background:#fff;font-family:var(--m);font-size:12.5px;color:var(--ink);outline:none;');
      const dev = device === 'Computer' ? [1280, 800] : [390, 844];
      const rpW = rpWide ? 330 : Math.min(330, w - 28), rpS = rpW / dev[0], rpH = Math.round(dev[1] * rpS);
      return wrap(<div style={css('display: flex; flex-direction: column; gap: 18px; max-width: 980px;')}>
        <Back ui={ui} onBack={() => setView(null)} title="Your online rate page" lead="Free with every desk. A page in your shop’s name you can send to anyone. Set it up here, and every change shows on the page straight away." />
        <div style={css('display:grid;grid-template-columns:' + (rpWide ? 'minmax(0,1fr) 380px' : 'minmax(0,1fr)') + ';gap:16px;align-items:start;')}>
          <div style={css('min-width: 0; display: flex; flex-direction: column; gap: 14px;')}>

            <section aria-label="Your brand" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); padding: 16px;')}>
              <div style={head}>Your brand</div>
              <div style={css('display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px;')}>
                <span aria-hidden="true" style={css('flex:none;width:56px;height:56px;border-radius:14px;display:grid;place-items:center;font-weight:800;font-size:17px;color:#fff;overflow:hidden;' + (page.logo ? 'background:#fff;border:1px solid var(--line);' : 'background:var(--ink);'))}>{page.logo ? <img src={page.logo} alt="" style={css('width:100%;height:100%;object-fit:contain;')} /> : initials(draft.name)}</span>
                <span style={css('flex: 1 1 180px; min-width: 0;')}><b style={css('display: block; font-size: 14px;')}>Logo</b><span style={css('display: block; font-size: 12px; line-height: 1.45; color: var(--mute); margin-top: 2px;')}>Square works best. PNG or JPG. We show your initials until you add one.</span></span>
                <label style={css('flex:none;display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:700;color:var(--ink);transition:border-color .2s ease,color .2s ease;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';')}>{page.logo ? 'Replace logo' : 'Upload logo'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Logo" onChange={uploadLogo} disabled={readOnly} style={{ display: 'none' }} /></label>
                {deskLogo && !readOnly && <button type="button" onClick={useDeskLogo} style={css('flex:none;appearance:none;display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:13px;font-weight:700;color:var(--ink);cursor:pointer;')}>Use your desk logo</button>}
                {page.logo && !readOnly && <button type="button" onClick={removeLogo} style={css('appearance: none; border: 0; background: none; cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--mute); padding: 6px 2px;')}>Remove</button>}
              </div>
              <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 14px;')}>
                {field('Shop name', draft.name, v => edit('name', v), 'Your shop name')}
                {field('Short line under your name', draft.tagline, v => edit('tagline', v), 'e.g. Best rates in town since 2009')}
              </div>
            </section>

            <section aria-label="Where to find you" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); padding: 16px;')}>
              <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: space-between;')}><div style={head}>Where to find you</div>{synced}</div>
              <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px;')}>
                {field('Address', p.address, v => editProfile('address', v), 'Street', { wide: true })}
                {field('City', p.city, v => editProfile('city', v), 'City')}
                {field('Phone', p.phone, v => editProfile('phone', v), 'Phone')}
                {field('Email', p.email, v => editProfile('email', v), 'Optional')}
              </div>
            </section>

            <section aria-label="Opening hours" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); overflow: hidden;')}>
              <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 16px 16px 6px;')}><span style={head}>Opening hours</span><span style={css('flex: 1; font-size: 12px; color: var(--faint);')}>Shows open or closed on your page</span>{synced}</div>
              {DAY_INDEX.map((di, i) => { const hr = week[di]; return (<div key={di} style={css('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;' + (i ? 'border-top:1px solid var(--hair);' : ''))}>
                <b style={css('width: 92px; flex: none; font-size: 13.5px;')}>{DAY_NAMES[i]}</b>
                <Switch on={!!hr} off={readOnly} name={`Open on ${DAY_NAMES[i]}`} onClick={() => setDay(di, hr ? null : [9.5, 18])} />
                {hr ? (<span style={css('display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap;')}>
                  <select aria-label={`${DAY_NAMES[i]} opens`} value={String(hr[0])} disabled={readOnly} onChange={e => { const v = parseFloat(e.target.value); setDay(di, [v, Math.max(v + 0.5, hr[1])]); }} style={timeSel}>{TIME_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                  <span style={css('font-size: 12px; color: var(--faint);')}>to</span>
                  <select aria-label={`${DAY_NAMES[i]} closes`} value={String(hr[1])} disabled={readOnly} onChange={e => { const v = parseFloat(e.target.value); setDay(di, [Math.min(hr[0], v - 0.5), v]); }} style={timeSel}>{TIME_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                </span>) : <span style={css('font-size: 13px; color: var(--faint);')}>Closed</span>}
              </div>); })}
            </section>

            <section aria-label="What your page shows" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); overflow: hidden;')}>
              <div style={css('padding: 16px 16px 4px;')}><span style={head}>What your page shows</span></div>
              {[['converter', 'The converter', 'Customers work out an amount before they come in.'], ['hours', 'Opening hours and map', 'From the hours above, with a Directions link.'], ['compliance', 'Compliance page', 'Plain-language page on ID, reporting and privacy. Recommended.']].map(([key, text, hint], i) => (
                <div key={key} style={css('display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:13px 16px;' + (i ? 'border-top:1px solid var(--hair);' : ''))}>
                  <span style={css('flex: 1 1 240px; min-width: 0;')}><b style={css('display: block; font-size: 14px;')}>{text}</b><span style={css('display: block; font-size: 12.5px; line-height: 1.5; color: var(--mute); margin-top: 2px;')}>{hint}</span></span>
                  <Switch on={show[key] !== false} off={readOnly} name={text} onClick={() => edit('show', { ...show, [key]: show[key] === false }, true)} />
                </div>))}
              <div style={css('padding: 14px 16px 16px; border-top: 1px solid var(--hair);')}>
                <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap;')}>
                  <span style={css('flex: 1 1 220px; min-width: 0;')}><b style={css('display: block; font-size: 14px;')}>Currencies</b><span style={css('display: block; font-size: 12.5px; color: var(--mute); margin-top: 2px;')}>{picking ? codesNow.length + ' on your page, in the order you picked them' : 'The first six on your board. Tap any to choose your own.'}</span></span>
                  <Seg ui={ui} items={seg(['Top 6', 'Choose'], picking ? 'Choose' : 'Top 6', v => edit('codes', v === 'Top 6' ? null : board.slice(0, 6), true), readOnly)} />
                </div>
                <div style={css('display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 7px; margin-top: 12px;')}>
                  {board.map(c => <Chip key={c} ui={ui} code={c} at={codesNow.indexOf(c)} picking off={readOnly} onToggle={() => { const cur = codesNow.slice(); const i = cur.indexOf(c); if (i >= 0) cur.splice(i, 1); else cur.push(c); edit('codes', cur.length ? cur : null, true); }} />)}
                </div>
              </div>
            </section>

            <section aria-label="Always on your page" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); padding: 16px;')}>
              <div style={css('display: flex; align-items: center; gap: 8px; flex-wrap: wrap;')}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2 4 6.4v5.1c0 4.6 3.3 8.5 8 9.3 4.7-.8 8-4.7 8-9.3V6.4z" /></svg><span style={{ ...head, color: 'var(--ink)' }}>Always on your page</span><span style={css('font-size: 12px; color: var(--faint);')}>{owner ? 'Required, so you can’t switch these off' : 'Only the owner changes these'}</span></div>
              <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 12px;')}>
                {field('Regulator', reg.name, v => edit('regulator', { ...reg, name: v }), 'Your regulator', { locked: regLocked })}
                {field('Registration number', reg.number, v => edit('regulator', { ...reg, number: v }), 'As registered', { locked: regLocked })}
                {field('Compliance officer', reg.officer, v => edit('regulator', { ...reg, officer: v }), 'Full name', { locked: regLocked })}
              </div>
              <div style={css('display: flex; flex-direction: column; gap: 7px; margin-top: 14px;')}>
                {['Your registered name and registration number, in the footer of every page', 'A note that rates are a guide and the rate on the receipt is final', wantFeeNote ? 'Your service fee: “' + wantFeeNote + '”' : 'Any service fee you charge, taken from your pricing', 'Who to contact with a question or a complaint'].map(u => (<span key={u} style={css('display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; line-height: 1.5; color: var(--mute);')}><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#1D6B45" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={css('flex: none; margin-top: 3px;')}><path d="M4 12.5l5 5L20 6.5" /></svg>{u}</span>))}
              </div>
              <div style={css('font-size: 11.5px; line-height: 1.5; color: var(--faint); margin-top: 12px;')}>Written for {reg.name || 'your regulator'}’s rules. Have your compliance officer check the wording before you share the page.</div>
            </section>
          </div>

          <div style={css(rpWide ? 'position:sticky;top:14px;min-width:0;' : 'min-width:0;order:-1;')}>
            <section aria-label="Live preview" style={css('border-radius: 16px; background: #fff; border: 1px solid var(--line); overflow: hidden;')}>
              <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid var(--line);')}>
                <span style={css('width: 7px; height: 7px; border-radius: 50%; background: #2EA36B; animation: rtLive 2s infinite;')} />
                <b style={css('flex: 1; min-width: 0; font-size: 13.5px;')}>Live preview</b>
                <Seg ui={ui} items={seg(['Phone', 'Computer'], device, setDevice)} />
              </div>
              <div style={css('display: grid; place-items: center; padding: 18px 14px; background: #ECE9E2;')}>
                <div style={css('padding:' + (device === 'Computer' ? '8px' : '10px') + ';border-radius:' + (device === 'Computer' ? '12px' : '30px') + ';background:#17140F;box-shadow:0 24px 50px -24px rgba(23,20,15,0.6);')}>
                  <div style={css('position:relative;width:' + rpW + 'px;height:' + rpH + 'px;overflow:hidden;border-radius:' + (device === 'Computer' ? '5px' : '22px') + ';background:#F4F0E6;')}>
                    <iframe key={frame + device} src={previewPath} title="Rate page preview" tabIndex={-1} style={css('position:absolute;top:0;left:0;width:' + dev[0] + 'px;height:' + dev[1] + 'px;border:0;transform:scale(' + rpS.toFixed(4) + ');transform-origin:0 0;pointer-events:none;')} />
                  </div>
                </div>
              </div>
              <div style={css('display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 14px; border-top: 1px solid var(--line);')}>
                <span style={css('flex: 1 1 180px; min-width: 0; font-family: var(--m); font-size: 11.5px; color: var(--mute); overflow-wrap: anywhere;')}>{location.host + pagePath}</span>
                <button type="button" onClick={() => copy('rp', pagePath)} style={pill(copied === 'rp')}>{copied === 'rp' ? 'Copied' : 'Copy link'}</button>
                <a href={page.live ? pagePath : previewPath} target="_blank" rel="noopener" style={css('display: inline-flex; align-items: center; height: 32px; padding: 0 13px; border-radius: 999px; border: 1px solid var(--line); background: #fff; font-size: 12.5px; font-weight: 600; color: var(--ink);')}>Open ↗</a>
              </div>
              {/* Not in the design file: the page is private until the owner turns it on. */}
              <div style={css('display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; border-top: 1px solid var(--line); background: rgba(23,20,15,0.02);')}>
                <div style={css('display: flex; align-items: center; gap: 10px;')}>
                  <Switch on={page.live} off={!owner} name="Rate page live" onClick={() => savePage({ live: !page.live })} />
                  <span style={css('flex: 1; font-size: 12.5px; line-height: 1.45; color: var(--ink);')}>{page.live ? 'Live. Anyone with the link sees your published rates.' : 'Private. Only your staff can see it until the owner turns it on.'}</span>
                </div>
                {owner && <div style={css('display: flex; align-items: center; gap: 6px;')}>
                  <span style={css('font-family: var(--m); font-size: 11px; color: var(--mute);')}>/r/</span>
                  <input aria-label="Page address" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} style={css('flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--line); background: #fff; outline: none; font-family: var(--m); font-size: 12px; color: var(--ink);')} />
                  <button type="button" disabled={!slug || slug === page.slug} onClick={() => savePage({ slug })} style={pill(false)}>Save address</button>
                </div>}
              </div>
            </section>
          </div>
        </div>
      </div>);
    }

    /* ---------- window screens ---------- */
    const kd = KINDS.find(k => screen && k[0] === screen.kind) || KINDS[0];
    const side = contentW >= 760;
    const pw = (side ? contentW - 290 : contentW) - 44, maxH = kd[0] === 'portrait' ? 440 : 340;
    const zs = Math.min(pw / kd[3], maxH / kd[4]);
    const bw = Math.round(kd[3] * zs), bh = Math.round(kd[4] * zs);
    const picking = screen && screen.currencies.length > 0;
    const shown = screen ? (picking ? screen.currencies.filter(c => board.includes(c)) : board.slice(0, 6)) : [];
    const head = css('font-family: var(--m); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); font-weight: 700; margin-bottom: 8px;');
    return wrap(<div style={css('display: flex; flex-direction: column; gap: 18px; max-width: 980px;')}>
      <Back ui={ui} onBack={() => { setView(null); setMenu(false); }} title="Window screens" lead="Every screen gets its own web address. Open it on the TV or tablet, go full screen and leave it. It stays on, needs no login, and updates after you publish." />
      <div role="list" aria-label="Your screens" style={css('display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px;')}>
        {screens.map(x => { const on = x.id === sel; const ki = { tv: [22, 13], portrait: [11, 19], tablet: [19, 14], strip: [24, 6] }[x.kind] || [22, 13]; return (
          <button key={x.id} role="listitem" type="button" onClick={() => { setSel(x.id); setMenu(false); }} style={css('appearance:none;display:block;width:100%;padding:13px 14px;border-radius:14px;cursor:pointer;background:#fff;transition:border-color .2s ease,box-shadow .2s ease;border:' + (on ? '1.5px solid var(--primary)' : '1px solid var(--line)') + ';box-shadow:' + (on ? '0 10px 24px -18px rgba(29,107,69,0.6)' : 'none') + ';')}>
            <span style={css('display: flex; align-items: center; gap: 10px;')}><span style={css('flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:' + (on ? 'rgba(29,107,69,0.1)' : 'rgba(23,20,15,0.05)') + ';')}><span style={css('display:block;width:' + ki[0] + 'px;height:' + ki[1] + 'px;border-radius:2px;border:1.6px solid ' + (on ? 'var(--primary)' : 'var(--mute)') + ';')} /></span><b style={css('flex: 1; min-width: 0; font-size: 14px; color: var(--ink); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;')}>{x.name}</b></span>
            <span style={css('display: flex; align-items: center; gap: 7px; margin-top: 10px; font-size: 12px; color: var(--mute); text-align: left;')}><span style={css(sightDot(sighting(x.lastSeenAt)))} />{sighting(x.lastSeenAt).text}</span>
            <span style={css('display: block; font-family: var(--m); font-size: 10.5px; color: var(--faint); margin-top: 4px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;')}>{({ tv: 'TV · landscape', portrait: 'Screen on its side', tablet: 'Tablet', strip: 'Strip ticker' }[x.kind] || 'Screen') + ' · ' + x.theme}</span>
          </button>); })}
        <button type="button" onClick={addScreen} disabled={readOnly} style={css('appearance:none;display:flex;align-items:center;justify-content:center;gap:8px;min-height:72px;padding:13px 14px;border-radius:14px;cursor:' + (readOnly ? 'not-allowed' : 'pointer') + ';opacity:' + (readOnly ? '0.5' : '1') + ';background:transparent;border:1.5px dashed rgba(23,20,15,0.22);font-size:13.5px;font-weight:700;color:var(--mute);transition:all .2s ease;')}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Add a screen</button>
      </div>

      {screen && <section aria-label="Screen setup" style={css('border-radius: 18px; background: #fff; border: 1px solid var(--line); overflow: hidden;')}>
        <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid var(--line);')}>
          <span title={sighting(screen.lastSeenAt).text} style={css(sightDot(sighting(screen.lastSeenAt)).replace('7px;height:7px', '8px;height:8px'))} />
          <label style={css('flex: 0 1 240px; min-width: 150px; position: relative; display: block; cursor: text;')}>
            <input value={screen.name} onChange={e => renameScreen(screen.id, e.target.value)} disabled={readOnly} maxLength={60} aria-label="Screen name" placeholder="Name this screen" style={css('width: 100%; height: 36px; padding: 0 34px 0 11px; border-radius: 10px; border: 1px solid var(--line); background: #fff; outline: none; font-size: 15px; font-weight: 800; color: var(--ink); box-shadow: inset 0 1px 2px rgba(23,20,15,0.05);')} />
          </label>
          <span style={css('flex: 1 1 220px; min-width: 0; font-family: var(--m); font-size: 12px; color: var(--mute); overflow-wrap: anywhere;')}>{location.host}/s/{screen.token}</span>
          <button type="button" onClick={() => copy('scr', `/s/${screen.token}`)} style={pill(copied === 'scr')}>{copied === 'scr' ? 'Copied' : 'Copy link'}</button>
          <a href={`/s/${screen.token}`} target="_blank" rel="noopener" style={css('display: inline-flex; align-items: center; height: 32px; padding: 0 13px; border-radius: 999px; border: 1px solid var(--line); background: #fff; font-size: 12.5px; font-weight: 600; color: var(--ink);')}>Open ↗</a>
          {!readOnly && <button type="button" onClick={() => setMenu(m => !m)} title="More" aria-label="More" aria-expanded={menu} style={css('flex: none; appearance: none; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--line); background: #fff; cursor: pointer; color: var(--mute); font-size: 16px; line-height: 1;')}>⋯</button>}
          {menu && <div style={css('flex-basis: 100%; display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px;')}>
            <button type="button" onClick={resetScreen} style={css('appearance: none; border: 1px solid var(--line); background: #fff; border-radius: 10px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; font-weight: 700; color: var(--ink);')}>Reset link</button>
            <button type="button" onClick={removeScreen} style={css('appearance: none; border: 1px solid rgba(194,69,45,0.3); background: #fff; border-radius: 10px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; font-weight: 700; color: var(--clay);')}>Remove screen</button>
            <span style={css('flex: 1 1 220px; font-size: 12px; line-height: 1.5; color: var(--mute); align-self: center;')}>Reset gives this screen a new address. The old one stops working straight away.</span>
          </div>}
        </div>
        <div style={css('display:grid;grid-template-columns:' + (side ? '290px minmax(0,1fr)' : 'minmax(0,1fr)') + ';')}>
          <div style={css('padding: 16px; display: flex; flex-direction: column; gap: 16px; border-right: 1px solid var(--hair);')}>
            <div><div style={head}>Screen</div>
              <div style={css('display: flex; flex-direction: column; gap: 6px;')}>
                {KINDS.map(k => { const on = screen.kind === k[0], r = k[3] / k[4], iw = r >= 1 ? 30 : Math.round(30 * r * 1.6), ih = r >= 1 ? Math.max(5, Math.round(30 / r)) : 30; return (
                  <button key={k[0]} type="button" aria-pressed={on} disabled={readOnly} onClick={() => patchScreen(screen.id, { kind: k[0] })} style={css('appearance:none;display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:12px;cursor:pointer;text-align:left;transition:border-color .2s ease,background .2s ease;border:1px solid ' + (on ? 'var(--primary)' : 'var(--line)') + ';background:' + (on ? 'rgba(29,107,69,0.05)' : '#fff') + ';')}>
                    <span style={css('width: 32px; display: grid; place-items: center; flex: none;')}><span style={css('flex:none;width:' + iw + 'px;height:' + ih + 'px;border-radius:3px;border:2px solid ' + (on ? 'var(--primary)' : 'rgba(23,20,15,0.35)') + ';background:' + (on ? 'rgba(29,107,69,0.12)' : 'transparent') + ';')} /></span>
                    <span style={css('min-width: 0;')}><b style={css('display: block; font-size: 13px; color: var(--ink);')}>{k[1]}</b><span style={css('display: block; font-family: var(--m); font-size: 10.5px; color: var(--mute); margin-top: 2px;')}>{k[2]}</span></span>
                  </button>); })}
              </div>
            </div>
            {screen.kind !== 'strip' && <div><div style={head}>Layout</div>
              <Seg ui={ui} items={seg(['One column', 'Two columns', 'Rotate pages'], LAYOUTS[screen.layout], v => patchScreen(screen.id, { layout: { 'One column': 'one', 'Two columns': 'two', 'Rotate pages': 'rotate' }[v] }), readOnly)} />
              <div style={css('font-size: 12px; line-height: 1.45; color: var(--mute); margin-top: 7px;')}>{screen.layout === 'rotate' ? 'Pages turn every 8 seconds when your currencies don’t fit on one screen.' : (screen.kind === 'portrait' || screen.kind === 'tablet' ? 'Tall screens always use one column.' : 'Every currency you pick, on one screen.')}</div>
            </div>}
            <div><div style={head}>Look</div>
              <Seg ui={ui} items={seg(['Dark', 'Light'], screen.theme === 'light' ? 'Light' : 'Dark', v => patchScreen(screen.id, { theme: v.toLowerCase() }), readOnly)} />
            </div>
            <div><div style={head}>Show on screen</div>
              <div style={css('display: flex; flex-wrap: wrap; gap: 6px;')}>
                {SHOWS.map(([key, text]) => { const on = key === 'hours' ? screen.showHours : (screen.show || {})[key] !== false; return (
                  <button key={key} type="button" aria-pressed={on} disabled={readOnly} onClick={() => patchScreen(screen.id, key === 'hours' ? { showHours: !on } : { show: { ...(screen.show || {}), [key]: !on } })} style={css('appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:600;transition:all .2s ease;border:1px solid ' + (on ? 'var(--ink)' : 'var(--line)') + ';background:' + (on ? 'var(--ink)' : '#fff') + ';color:' + (on ? '#fff' : 'var(--mute)') + ';')}>{text}</button>); })}
              </div>
            </div>
          </div>
          <div style={css('min-width: 0; padding: 22px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: #ECE9E2; background-image: radial-gradient(circle, rgba(23,20,15,0.05) 1px, transparent 1.4px); background-size: 18px 18px;')}>
            <div>
              <div style={css('padding:' + (kd[0] === 'strip' ? 5 : kd[0] === 'tablet' ? 12 : 8) + 'px;border-radius:' + (kd[0] === 'tablet' ? 20 : 10) + 'px;background:#1b1916;box-shadow:0 24px 50px -24px rgba(23,20,15,0.6),inset 0 0 0 1px rgba(255,255,255,0.06);')}>
                <div style={css('position:relative;width:' + bw + 'px;height:' + bh + 'px;overflow:hidden;border-radius:' + (kd[0] === 'tablet' ? 9 : 3) + 'px;background:#0b0a08;')}>
                  <iframe key={frame + screen.token} src={`/s/${screen.token}`} title="Window screen preview" tabIndex={-1} style={css('position:absolute;top:0;left:0;width:' + kd[3] + 'px;height:' + kd[4] + 'px;border:0;transform:scale(' + zs.toFixed(4) + ');transform-origin:0 0;pointer-events:none;')} />
                </div>
              </div>
              {kd[0] === 'tv' && <div style={css('width:' + Math.round(bw * 0.18) + 'px;height:10px;margin:0 auto;border-radius:0 0 6px 6px;background:#2a2723;')} />}
            </div>
            <div style={css('font-family: var(--m); font-size: 10.5px; color: var(--mute); text-align: center;')}>{kd[3]} × {kd[4]} · {kd[1].toLowerCase()} · changes show on the real screen within a minute</div>
          </div>
        </div>
        <div style={css('padding: 16px; border-top: 1px solid var(--line);')}>
          <div style={css('display: flex; align-items: center; gap: 10px; flex-wrap: wrap;')}>
            <span style={css('flex: 1 1 220px; min-width: 0;')}><span style={css('font-family: var(--m); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); font-weight: 700;')}>Currencies on this screen</span><span style={css('display: block; font-size: 12.5px; color: var(--mute); margin-top: 4px;')}>{picking ? 'Showing ' + shown.length + ' ' + (shown.length === 1 ? 'currency' : 'currencies') + '. Tap a currency to add it or take it off.' : 'Your top six, in board order. Tap a currency to choose your own.'}</span></span>
          </div>
          <div style={css('display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 7px; margin-top: 12px;')}>
            {board.map(c => <Chip key={c} ui={ui} code={c} at={shown.indexOf(c)} picking off={readOnly} onToggle={() => { const cur = shown.slice(); const i = cur.indexOf(c); if (i >= 0) cur.splice(i, 1); else cur.push(c); patchScreen(screen.id, { currencies: cur }); }} />)}
          </div>
          <div style={css('display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 11.5px; color: var(--mute);')}>
            <span style={css('display: inline-flex; align-items: center; gap: 6px;')}><span style={css('width: 16px; height: 16px; border-radius: 999px; background: var(--primary); color: #fff; display: grid; place-items: center; font-family: var(--m); font-size: 9px; font-weight: 700;')}>1</span>On this screen, in this order</span>
            <span style={css('display: inline-flex; align-items: center; gap: 6px;')}><span style={css('width: 16px; height: 16px; border-radius: 999px; background: rgba(23,20,15,0.07); color: var(--mute); display: grid; place-items: center; font-size: 11px; font-weight: 700;')}>+</span>On your board, tap to add</span>
          </div>
        </div>
      </section>}

      <div style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px;')}>
        <div style={css('padding: 18px; border-radius: 16px; background: #fff; border: 1px solid var(--line);')}>
          <div style={head}>Set up a screen</div>
          <div style={css('display: flex; flex-direction: column; gap: 13px; margin-top: 14px;')}>
            {[['1', 'Copy the link', 'Each screen has its own address. Copy it here, or text it to yourself.'], ['2', 'Open it on the screen', 'In the TV’s web browser, or on whatever is plugged in: a streaming stick, an old laptop, a tablet. No app to install, no account to sign in to.'], ['3', 'Tap to start, then leave it', 'The first tap goes full screen and keeps the screen awake. After that it runs on its own.']].map(([n, h, b]) => (
              <div key={n} style={css('display: flex; align-items: flex-start; gap: 12px;')}><span style={css('flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--ink); color: #fff; font-family: var(--m); font-size: 11.5px; font-weight: 700;')}>{n}</span><span style={css('min-width: 0;')}><b style={css('display: block; font-size: 14px;')}>{h}</b><span style={css('display: block; font-size: 12.5px; line-height: 1.55; color: var(--mute); margin-top: 2px;')}>{b}</span></span></div>))}
          </div>
          <div style={css('display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px;')}>{['Smart TV browser', 'Fire TV or Chromecast', 'Any laptop or mini PC', 'iPad or Android tablet'].map(d => <span key={d} style={css('font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px; background: rgba(23,20,15,0.05); color: var(--mute);')}>{d}</span>)}</div>
        </div>
        <div style={css('display: flex; flex-direction: column; gap: 14px;')}>
          <div style={css('padding: 18px; border-radius: 16px; background: #fff; border: 1px solid var(--line);')}>
            <div style={head}>Once it's running</div>
            <div style={css('display: flex; flex-direction: column; gap: 9px; margin-top: 12px;')}>{['Updates within a minute of every publish', 'If the wifi drops it keeps showing your last rates, then catches up', 'Shows “On” here while it’s running, so you know it’s working', 'Turn off the TV’s own sleep timer so it stays on all day'].map(f => <span key={f} style={css('display: flex; align-items: flex-start; gap: 9px; font-size: 13px; line-height: 1.5;')}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#1D6B45" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={css('flex: none; margin-top: 3px;')}><path d="M4 12.5l5 5L20 6.5" /></svg>{f}</span>)}</div>
          </div>
          <div style={css('display: flex; align-items: flex-start; gap: 12px; padding: 15px 16px; border-radius: 16px; background: rgba(23,20,15,0.04); border: 1px solid var(--line);')}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--ink)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={css('flex: none; margin-top: 1px;')}><path d="M12 3.2 4 6.4v5.1c0 4.6 3.3 8.5 8 9.3 4.7-.8 8-4.7 8-9.3V6.4z" /></svg>
            <span style={css('min-width: 0; font-size: 12.5px; line-height: 1.55; color: var(--mute);')}><b style={css('color: var(--ink);')}>A screen link only shows your published rates.</b> Nothing private, and no way into the desk. If one ends up somewhere it shouldn't, reset it from the ⋯ menu and open the new address on the screen.</span>
          </div>
        </div>
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { RatesSite });
})();
