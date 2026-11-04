/* ============================================================
   CurrencyDesk OS: Rates, the Website & window tab (Rates v2.5)

   Where the shop's published board is shown. The owner names the shop's
   public rate page (/r/<address>) and takes it live; staff who may change
   rates add and retire window screens (/s/<token>). The server decides
   every one of these (PUT /api/rate-page needs site:publish, the screen
   routes need rates:change); this tab only shows each person what they can
   do, and says plainly when the server refuses.
   ============================================================ */
(function () {
  const { useState, useEffect, useCallback } = React;
  const { CD, Ic } = window.CDOS;

  const card = { background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 13, padding: 16 };
  const field = { border: `1px solid ${CD.line}`, borderRadius: 9, padding: '8px 10px', background: 'var(--cd-panel)', color: CD.ink, fontSize: 13 };
  const ghost = { border: `1px solid ${CD.line}`, borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: CD.ink, background: 'var(--cd-panel)' };
  const primary = { borderRadius: 9, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: CD.green };
  const PAGE_ERRORS = {
    400: 'Use 3 to 40 lowercase letters, numbers and hyphens, starting and ending with a letter or number.',
    403: 'Only the owner can change the rate page.',
    409: 'Another shop already uses that address. Pick another.',
    422: 'Choose an address before the page goes live.',
  };

  async function call(method, url, body) {
    const res = await fetch(url, body
      ? { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method, credentials: 'same-origin' });
    /* An error answer may have no JSON body; the status says enough. */
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }

  function Toggle({ on, onClick, disabled, name }) {
    return (<button type="button" role="switch" aria-checked={on} aria-label={name} disabled={disabled} onClick={onClick}
      className="w-11 h-6 relative flex-none" style={{ background: on ? CD.green : 'var(--cd-disabled)', borderRadius: 999, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span className="absolute top-0.5 w-5 h-5" style={{ left: on ? 22 : 2, background: 'var(--cd-panel)', borderRadius: 999, transition: 'left .15s' }} />
    </button>);
  }

  function RatesSite({ serverRole }) {
    const owner = serverRole === 'administrator';
    const staff = owner || serverRole === 'branch_manager';
    const [page, setPage] = useState(null);
    const [slug, setSlug] = useState('');
    const [screens, setScreens] = useState([]);
    const [form, setForm] = useState({ name: '', kind: 'tv', layout: 'two', theme: 'dark', showHours: true });
    const [msg, setMsg] = useState(null);

    const load = useCallback(async () => {
      try {
        const [p, s] = await Promise.all([call('GET', '/api/rate-page'), call('GET', '/api/window-screens')]);
        if (!p.ok || !s.ok) throw new Error(`the server answered ${p.ok ? s.status : p.status}`);
        setPage(p.data); setSlug(p.data.slug || ''); setScreens(s.data.screens);
      } catch (e) { setMsg(`Your website and screens could not be loaded (${e.message}).`); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const savePage = async (patch) => {
      setMsg(null);
      const r = await call('PUT', '/api/rate-page', patch);
      if (r.ok) { setPage(r.data); setSlug(r.data.slug || ''); return; }
      setMsg(PAGE_ERRORS[r.status] || `The rate page was not saved (the server answered ${r.status}).`);
    };
    const addScreen = async () => {
      setMsg(null);
      const r = await call('POST', '/api/window-screens', { ...form, name: form.name.trim(), currencies: [] });
      if (!r.ok) { setMsg(r.status === 403 ? 'Only the owner and managers can add screens.' : 'Give the screen a name of up to 60 characters.'); return; }
      setForm(f => ({ ...f, name: '' }));
      await load();
    };
    const retire = async (s) => {
      if (!window.confirm(`Retire ${s.name}? Its link stops showing rates.`)) return;
      const r = await call('POST', `/api/window-screens/${encodeURIComponent(s.id)}/retire`);
      if (!r.ok) { setMsg(`${s.name} was not retired (the server answered ${r.status}).`); return; }
      await load();
    };
    const copy = async (path) => {
      try { await navigator.clipboard.writeText(location.origin + path); setMsg('Link copied.'); }
      catch (e) { setMsg('The link could not be copied. Open it and copy it from the address bar.'); }
    };

    if (!page) return <div className="p-6 text-[13px]" style={{ color: CD.mute }}>{msg || 'Loading your website and screens…'}</div>;
    return (<div style={{ display: 'grid', gap: 14, padding: '16px 18px 40px', maxWidth: 980 }}>
      {msg && <div role="status" className="text-[12.5px] px-3 py-2" style={{ background: 'var(--cd-chip)', color: CD.ink, borderRadius: 9 }}>{msg}</div>}
      <section aria-label="Rate page" style={card}>
        <div className="flex items-center gap-2"><Ic n="globe" s={15} c={CD.ink} /><b className="text-[14px]" style={{ color: CD.ink }}>Rate page</b><span className="text-[11px] ml-auto" style={{ color: CD.mute }}>Your website</span></div>
        <p className="text-[12.5px] mt-1" style={{ color: CD.mute }}>Rates, hours and a converter, on a page we host for you. Share it, link to it, put it on Google.</p>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-[12.5px]" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{location.host}/r/</span>
          <input aria-label="Page address" value={slug} readOnly={!owner} onChange={e => setSlug(e.target.value.toLowerCase())} placeholder="your-shop" style={{ ...field, flex: '1 1 180px', fontFamily: 'Space Mono, monospace' }} />
          {owner && <button type="button" style={ghost} disabled={!slug || slug === page.slug} onClick={() => savePage({ slug })}>Save address</button>}
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Toggle on={page.live} name="Rate page live" disabled={!owner || !page.slug} onClick={() => savePage({ live: !page.live })} />
          <span className="text-[12.5px]" style={{ color: CD.ink }}>{page.live ? 'Live. Anyone with the link sees your published rates.' : 'Private. Nobody can open this address until you turn it on.'}</span>
        </div>
        {!owner && <div className="text-[12px] mt-2" style={{ color: CD.mute }}>Only the owner can take the rate page live.</div>}
        {page.slug && <div className="flex gap-2 mt-3">
          <a href={`/r/${page.slug}`} target="_blank" rel="noopener" style={ghost}>Open page</a>
          <button type="button" style={ghost} onClick={() => copy(`/r/${page.slug}`)}>Copy link</button>
        </div>}
      </section>
      <section aria-label="Window screens" style={card}>
        <div className="flex items-center gap-2"><Ic n="dashboardgrid" s={15} c={CD.ink} /><b className="text-[14px]" style={{ color: CD.ink }}>Window screens</b><span className="text-[11px] ml-auto" style={{ color: CD.mute }}>{screens.length} {screens.length === 1 ? 'screen' : 'screens'}</span></div>
        <p className="text-[12.5px] mt-1" style={{ color: CD.mute }}>Each screen gets its own link. Open it on the TV or tablet and leave it. No login, always on, your last publish.</p>
        <ul className="mt-3" style={{ display: 'grid', gap: 8 }}>
          {!screens.length && <li className="text-[12.5px]" style={{ color: CD.mute }}>No screens yet.</li>}
          {screens.map(s => (<li key={s.id} className="flex items-center gap-2 flex-wrap px-3 py-2" style={{ border: `1px solid ${CD.lineSoft}`, borderRadius: 10 }}>
            <b className="text-[13px]" style={{ color: CD.ink }}>{s.name}</b>
            <span className="text-[11.5px] flex-1" style={{ color: CD.mute }}>{s.kind === 'tv' ? 'TV' : 'Tablet'} · {s.layout === 'two' ? 'two columns' : 'one column'} · {s.theme}</span>
            <a href={`/s/${s.token}`} target="_blank" rel="noopener" style={ghost}>Open screen</a>
            <button type="button" style={ghost} onClick={() => copy(`/s/${s.token}`)}>Copy link</button>
            {staff && <button type="button" style={{ ...ghost, color: CD.flag }} onClick={() => retire(s)}>Retire</button>}
          </li>))}
        </ul>
        {staff && <div className="flex items-end gap-2 mt-4 flex-wrap">
          <label className="text-[11.5px]" style={{ color: CD.mute, display: 'grid', gap: 4, flex: '1 1 160px' }}>Screen name
            <input value={form.name} maxLength={60} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Front window" style={field} /></label>
          <label className="text-[11.5px]" style={{ color: CD.mute, display: 'grid', gap: 4 }}>Kind
            <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} style={field}><option value="tv">TV</option><option value="tablet">Tablet</option></select></label>
          <label className="text-[11.5px]" style={{ color: CD.mute, display: 'grid', gap: 4 }}>Layout
            <select value={form.layout} onChange={e => setForm(f => ({ ...f, layout: e.target.value }))} style={field}><option value="two">Two columns</option><option value="one">One column</option></select></label>
          <label className="text-[11.5px]" style={{ color: CD.mute, display: 'grid', gap: 4 }}>Theme
            <select value={form.theme} onChange={e => setForm(f => ({ ...f, theme: e.target.value }))} style={field}><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <label className="text-[12px] flex items-center gap-2" style={{ color: CD.ink, paddingBottom: 8 }}>
            <input type="checkbox" checked={form.showHours} onChange={e => setForm(f => ({ ...f, showHours: e.target.checked }))} /> Show hours</label>
          <button type="button" style={{ ...primary, opacity: form.name.trim() ? 1 : 0.5 }} disabled={!form.name.trim()} onClick={addScreen}>Add screen</button>
        </div>}
      </section>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { RatesSite });
})();
