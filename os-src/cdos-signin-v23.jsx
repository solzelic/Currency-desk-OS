/* CD-221: presentation only. No credential checks, fixture state or route switch.
   The existing SignIn owns requests and session handoff. Activation waits for
   returning-auth contracts; tests select this view through a component prop. */
(function () {
  const { useEffect, useRef, useId, useState } = React;
  const CSS = `
    .si23 { --f:'Schibsted Grotesk',system-ui,sans-serif; --m:'IBM Plex Mono',monospace; --serif:'Instrument Serif',serif;
      --ink:#17140F; --mute:#6E675E; --faint:#736C62; --green:#1D6B45; --green-deep:#17583A; --flag:#C2452D; --line:rgba(23,20,15,.1);
      position:fixed; inset:0; top:var(--cdos-banner,0px); container-type:inline-size; background:#F6F3EC; color:var(--ink); font-family:var(--f); font-size:16px; line-height:normal; color-scheme:light; -webkit-font-smoothing:antialiased; overflow:auto; }
    .si23 *, .si23 *::before, .si23 *::after { box-sizing:border-box; }
    .si23 button, .si23 input, .si23 a { font:inherit; }
    .si23 button, .si23 a { cursor:pointer; }
    .si23 button:disabled { cursor:default; }
    .si23 :focus-visible { outline:2px solid var(--green); outline-offset:4px; }
    .si23 .si23-lnk { border:0; background:none; padding:0; color:var(--ink); font-weight:600; text-decoration:none; min-height:44px; display:inline-flex; align-items:center; }
    .si23 .si23-logo { display:flex; align-items:center; gap:10px; color:inherit; }
    .si23 .si23-logo svg { height:34px; width:auto; display:block; }
    .si23 .si23-logo b { font-size:18px; font-weight:800; letter-spacing:.04em; }
    .si23 .si23-logo i { font:800 10px var(--m); letter-spacing:.1em; color:var(--green); margin-left:2px; position:relative; top:-7px; }
    .si23 .si23-back { display:inline-flex; align-items:center; gap:7px; min-height:44px; min-width:44px; padding:0 14px 0 11px; border-radius:999px; border:1px solid rgba(23,20,15,.18); background:transparent; color:var(--ink); font:600 12px/1 var(--f); letter-spacing:.02em; text-decoration:none; }
    .si23 .si23-back:hover { background:#fff; }
    .si23 .si23-land { position:absolute; inset:0; display:flex; flex-direction:column; padding:0 5.5cqw; overflow:auto; }
    .si23 .si23-hd, .si23 .si23-chrome { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(23,20,15,.14); padding:3.6cqw 0 2.8cqw; }
    .si23 .si23-land .si23-logo i { vertical-align:top; top:-2px; }
    .si23 .si23-new { display:flex; gap:8px; align-items:baseline; font-size:15px; color:var(--mute); }
    .si23 .si23-new .si23-lnk::after { content:' →'; color:var(--green); }
    .si23 .si23-body { flex:1 0 auto; display:grid; grid-template-columns:1fr minmax(400px,31cqw); align-items:end; gap:5cqw; padding:5cqw 0 5.2cqw; min-height:0; }
    .si23 .si23-eyebrow { font:400 11px var(--m); letter-spacing:.22em; text-transform:uppercase; color:var(--mute); margin-bottom:3cqw; }
    .si23 h1 { font:400 clamp(56px,min(12.2cqw,19vh),180px)/.86 var(--serif); letter-spacing:-.035em; margin:0; }
    .si23 h1 em { font-style:italic; }
    .si23 .si23-dot { display:inline-block; width:.21em; height:.21em; border-radius:50%; background:var(--green-deep); margin-left:.04em; transform:translateY(.02em); position:relative; animation:si23-dot .7s .55s cubic-bezier(.2,1.7,.4,1) both; }
    .si23 .si23-dot::after { content:''; position:absolute; left:150%; top:50%; height:1px; width:var(--wire,0px); background:var(--ink); opacity:.9; transform-origin:left; animation:si23-wire .85s 1.1s cubic-bezier(.6,0,.2,1) both; }
    .si23 .si23-lede { font-size:clamp(18px,1.9cqw,28px); color:var(--mute); margin:3.6cqw 0 0; }
    .si23 .si23-lede b { color:var(--ink); }
    .si23 .si23-err { color:var(--flag); }
    .si23 .si23-col { display:flex; flex-direction:column; gap:14px; margin:0; }
    .si23 .si23-ab { position:relative; display:flex; align-items:center; gap:14px; height:60px; padding:0 18px; border-radius:14px; border:1px solid #747775; background:#fff; color:#1F1F1F; font-size:17px; font-weight:600; text-align:left; white-space:nowrap; }
    .si23 .si23-ab.si23-dark { height:64px; font-size:16px; background:var(--ink); color:#F1ECE1; border-color:var(--ink); box-shadow:0 24px 40px -24px rgba(23,20,15,.9); }
    .si23 .si23-ab.si23-dark::after { content:''; position:absolute; inset:-1px; border-radius:inherit; pointer-events:none; animation:si23-answer 1.1s 1.9s ease-out both; }
    .si23 .si23-ic { flex:none; width:22px; height:22px; display:grid; place-items:center; }
    .si23 .si23-ic svg { width:26px; height:26px; }
    .si23 .si23-ic img { width:20px; height:20px; object-fit:contain; }
    .si23 .si23-tag { margin-left:auto; font:700 10px var(--m); letter-spacing:.14em; text-transform:uppercase; padding:5px 9px; border-radius:999px; border:1px solid #2EA36B; color:#7BE0A8; }
    .si23 .si23-two { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .si23 .si23-two .si23-ab { justify-content:center; padding:0 14px; }
    .si23 .si23-two .si23-ic { width:24px; height:24px; }
    .si23 .si23-or { display:flex; align-items:center; gap:12px; margin:14px 0 10px; font:400 10px var(--m); letter-spacing:.16em; text-transform:uppercase; color:var(--faint); }
    .si23 .si23-or::before, .si23 .si23-or::after { content:''; flex:1; height:1px; background:var(--line); }
    .si23 .si23-field { margin-top:4px; }
    .si23 label { display:block; font:400 10px var(--m); letter-spacing:.2em; text-transform:uppercase; color:var(--mute); margin-bottom:10px; }
    .si23 .si23-inp { display:flex; align-items:center; height:60px; border:1.5px solid rgba(23,20,15,.14); border-radius:14px; background:#fff; padding:0 8px 0 18px; }
    .si23 .si23-inp:focus-within { border-color:var(--green); box-shadow:0 0 0 4px rgba(29,107,69,.12); }
    .si23 .si23-inp input { flex:1; width:0; min-width:0; border:0; outline:0; padding:1px 0; background:none; font-size:17px; letter-spacing:.02em; color:var(--ink); }
    .si23 input::placeholder { color:var(--faint); letter-spacing:.06em; }
    .si23 .si23-ib { flex:none; height:44px; min-width:44px; padding:0 10px; border-radius:8px; border:1px solid var(--line); background:#FAF9F6; color:var(--mute); font:700 10px var(--m); letter-spacing:.1em; text-transform:uppercase; }
    .si23 .si23-ib.si23-arrow { display:grid; place-items:center; padding:0; border-radius:10px; background:var(--ink); color:#fff; border-color:var(--ink); }
    .si23 .si23-ib.si23-arrow:disabled { background:rgba(23,20,15,.08); color:var(--faint); border-color:transparent; }
    .si23 .si23-rec { font-size:15px; color:var(--mute); margin-top:6px; }
    .si23 .si23-rec .si23-lnk { border-bottom:1.5px solid rgba(23,20,15,.25); padding-bottom:1px; }
    .si23 .si23-ft, .si23 .si23-cfoot { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid rgba(23,20,15,.14); padding:0 0 2cqw; margin-bottom:3.4cqw; font:italic clamp(16px,1.5cqw,22px) var(--serif); }
    .si23 .si23-chrome { position:absolute; top:0; left:5.5cqw; right:5.5cqw; }
    .si23 .si23-topback { display:none; }
    .si23 .si23-counter { display:flex; gap:6px; }
    .si23 .si23-counter span { width:6px; height:6px; border-radius:50%; background:rgba(23,20,15,.18); }
    .si23 .si23-counter .si23-on { width:18px; border-radius:3px; background:var(--ink); }
    .si23 .si23-cfoot { position:absolute; bottom:0; left:5.5cqw; right:5.5cqw; }
    .si23 .si23-card { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:404px; max-width:calc(100% - 32px); padding:36px 34px 30px; background:#FFFEFB; border:1px solid rgba(23,20,15,.08); border-radius:24px; box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 2px 4px rgba(23,20,15,.03),0 36px 70px -44px rgba(23,20,15,.42); }
    .si23 h2 { font:400 34px/1.05 var(--serif); letter-spacing:-.015em; text-align:center; margin:6px 0 0; }
    .si23 .si23-who-id { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-radius:12px; background:rgba(23,20,15,.04); font-size:14px; margin-top:14px; }
    .si23 .si23-who-id b { font:700 13px var(--m); letter-spacing:.02em; overflow-wrap:anywhere; }
    .si23 .si23-card .si23-field { margin-top:14px; }
    .si23 .si23-card label { letter-spacing:.18em; margin-bottom:9px; }
    .si23 .si23-card .si23-inp { height:54px; padding-left:16px; }
    .si23 .si23-card input { font-size:16px; }
    .si23 .si23-hint { font-size:11.5px; line-height:1.45; margin-top:8px; }
    .si23 .si23-cta { display:flex; align-items:center; justify-content:center; width:100%; height:54px; margin-top:14px; border-radius:14px; border:0; background:var(--ink); color:#F1ECE1; font-size:15px; font-weight:700; }
    .si23 .si23-cta:disabled { background:rgba(23,20,15,.08); color:var(--faint); }
    .si23 .si23-quiet { display:flex; justify-content:space-between; gap:12px; margin-top:18px; font-size:13px; }
    .si23 .si23-quiet .si23-lnk { color:var(--mute); font-weight:500; }
    @keyframes si23-dot { from { transform:translateY(.02em) scale(0); } to { transform:translateY(.02em) scale(1); } }
    @keyframes si23-wire { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes si23-answer { from { box-shadow:0 0 0 0 rgba(46,163,107,.55); } to { box-shadow:0 0 0 14px rgba(46,163,107,0); } }
    @media(max-height:1100px) {
      .si23 .si23-hd, .si23 .si23-chrome { padding:24px 0 18px; }
      .si23 .si23-ft, .si23 .si23-cfoot { padding-bottom:14px; margin-bottom:22px; }
      .si23 .si23-body { padding:3.4cqw 0 3.6cqw; }
    }
    @media(max-height:940px) {
      .si23 .si23-hd { padding:20px 0 16px; } .si23 .si23-body { padding:2.6cqw 0 2.4cqw; }
      .si23 .si23-eyebrow { margin-bottom:1.6cqw; } .si23 .si23-lede { margin-top:1.8cqw; font-size:clamp(16px,1.6cqw,22px); }
      .si23 .si23-ab, .si23 .si23-land .si23-inp { height:54px; } .si23 .si23-ab.si23-dark { height:58px; } .si23 .si23-col { gap:12px; }
    }
    @media(max-height:900px) { .si23 h1 { font-size:clamp(52px,min(12.2cqw,16.5vh),180px); } .si23 .si23-lede { margin-top:1.2cqw; } }
    @media(max-height:800px) {
      .si23 h1 { font-size:clamp(48px,min(12.2cqw,15vh),180px); } .si23 .si23-hd { padding:14px 0 12px; }
      .si23 .si23-body { padding:1.6cqw 0; } .si23 .si23-ab, .si23 .si23-land .si23-inp { height:50px; } .si23 .si23-ab.si23-dark { height:54px; }
      .si23 .si23-or { margin:8px 0 6px; } .si23 .si23-col { gap:10px; } .si23 .si23-eyebrow { margin-bottom:1cqw; }
    }
    @media(min-width:600px) and (max-width:980px) { .si23 .si23-body { grid-template-columns:1fr; align-items:start; } .si23 .si23-dot::after { display:none; } }
    @media(max-width:599px) {
      .si23 { background:var(--ink); } .si23 .si23-land { padding:0; color:#F1ECE1; }
      .si23 .si23-land .si23-hd { padding:22px 22px 0; border:0; } .si23 .si23-logo svg { height:28px; } .si23 .si23-logo b { font-size:14px; }
      .si23 .si23-logo i { top:-5px; color:#7BE0A8; } .si23 .si23-new { font-size:12px; } .si23 .si23-new .si23-lnk { color:#F1ECE1; } .si23 .si23-q { display:none; }
      .si23 .si23-land .si23-body { display:flex; flex-direction:column; gap:0; padding:0; align-items:stretch; }
      .si23 .si23-hero { padding:54px 22px 38px; } .si23 .si23-land .si23-eyebrow { font-size:10px; color:rgba(241,236,225,.55); margin-bottom:16px; }
      .si23 .si23-land h1 { font-size:78px; line-height:.88; color:#F1ECE1; } .si23 .si23-dot { background:#2EA36B; } .si23 .si23-dot::after { display:none; }
      .si23 .si23-land .si23-lede { font-size:15px; color:rgba(241,236,225,.7); margin-top:18px; } .si23 .si23-lede b { color:#F1ECE1; }
      .si23 .si23-land .si23-col { margin-top:auto; background:#F6F3EC; color:var(--ink); border-radius:28px 28px 0 0; padding:26px 20px 8px; gap:10px; box-shadow:0 -30px 60px -30px rgba(0,0,0,.6); }
      .si23 .si23-land .si23-ab { height:52px; font-size:14px; border-radius:13px; } .si23 .si23-land .si23-ab.si23-dark { height:56px; }
      .si23 .si23-ic svg { width:22px; height:22px; } .si23 .si23-tag { padding:4px 8px; } .si23 .si23-two { gap:10px; }
      .si23 .si23-land .si23-or { margin:8px 0 4px; } .si23 .si23-land .si23-inp { height:52px; border-radius:13px; }
      .si23 .si23-rec { font-size:13px; margin-top:4px; } .si23 .si23-land .si23-ft { background:#F6F3EC; color:var(--mute); border:0; margin:0; padding:18px 20px 26px; font-size:13px; }
      .si23 .si23-back { font-size:11px; } .si23 .si23-chrome { left:22px; right:22px; padding:22px 0 0; border:0; color:#F1ECE1; }
      .si23 .si23-topback { display:block; } .si23 .si23-chrome .si23-back { color:#F1ECE1; border-color:rgba(241,236,225,.28); }
      .si23 .si23-chrome .si23-back:hover { background:rgba(241,236,225,.1); } .si23 .si23-counter { display:none; } .si23 .si23-cfoot { display:none; }
      .si23 .si23-card { left:0; right:0; top:auto; bottom:0; transform:none; width:100%; max-width:none; border:0; border-radius:28px 28px 0 0; background:#F6F3EC; padding:30px 22px; max-height:calc(100% - 96px); overflow-y:auto; overscroll-behavior:contain; }
    }
    @media(prefers-reduced-motion:reduce) { .si23 *, .si23 *::before, .si23 *::after { animation:none!important; transition:none!important; } .si23 .si23-dot::after { display:none; } }
  `;

  function Brand() {
    const id = useId();
    return <div className="si23-logo"><svg viewBox="12 22 172 96" aria-hidden="true">
      <mask id={id}><rect x="12" y="22" width="172" height="96" fill="#fff" /><rect x="60" y="64.5" width="92" height="11" fill="#000" /></mask>
      <g mask={'url(#' + id + ')'} fill="currentColor"><circle cx="60" cy="70" r="48" /><path d="M116,22 H136 A48,48 0 0 1 136,118 H116 Z" /></g><circle cx="112" cy="70" r="6.5" fill="#2EA36B" />
    </svg><b>CURRENCYDESK<i>OS</i></b></div>;
  }
  function Arrow({ back = false }) {
    return <svg aria-hidden="true" viewBox="0 0 24 24" width={back ? 14 : 16} height={back ? 14 : 16} fill="none" stroke="currentColor" strokeWidth={back ? 2.2 : 2.6} strokeLinecap="round" strokeLinejoin="round"><path d={back ? 'M19 12H5M11 6l-6 6 6 6' : 'M5 12h14M13 6l6 6-6 6'} /></svg>;
  }
  function Back({ onBack }) { return <button type="button" className="si23-back" onClick={onBack}><Arrow back />Back</button>; }
  function Surface({ children }) {
    return <main className="si23"><link rel="stylesheet" href="/web/fonts/fonts.css" /><style>{CSS}</style>{children}</main>;
  }
  function Frame({ children, onBack }) {
    return <Surface><header className="si23-chrome"><Brand /><div className="si23-counter" aria-hidden="true"><span className="si23-on" /><span /><span /></div><span className="si23-topback"><Back onBack={onBack} /></span></header>
      {children}<footer className="si23-cfoot"><Back onBack={onBack} /><span>Every exchange, on the record.</span></footer></Surface>;
  }
  function PasskeyIcon() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M9 6.8a6 6 0 0 1 9 5.2v2M2 12a10 10 0 0 1 18-6M14 13.12c0 2.38 0 6.38-1 8.88M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M21.8 16c.2-2 .13-5.35 0-6M17.29 21.02c.12-.6.43-2.3.5-3.02M8.65 22c.21-.66.45-1.32.57-2M2 16h.01" />
    </svg>;
  }
  // Complete v2 syntax follows enquiries/cd-id.ts; this is cosmetic, not an
  // account lookup. Preserve raw editing text: an ID-shaped email local part
  // may still gain an @. Legacy numeric-tail IDs pass through unchanged.
  function formatIdentifier(value) {
    if (/^CD-[A-Z]{2,6}-\d{4,}$/i.test(value)) return value;
    const match = /^(?:CD[ -]*)?([A-Z]{4})[ -]*([2-9A-HJKMNP-Z]{4})$/i.exec(value);
    return match ? ('CD-' + match[1] + '-' + match[2]).toUpperCase() : value;
  }
  function FirstScreen({ identifier, onIdentifier, onContinue, onRecover, onSignup, onBack, error = '', shopName = '', methods = {} }) {
    const land = useRef(null);
    const [editing, setEditing] = useState(true);
    // Let the browser finish its focus/select operation, then restore raw
    // text and the selection together. Otherwise autofill/select-all can
    // lose the selection when React replaces the formatted value.
    const editIdentifier = event => {
      const input = event.target;
      queueMicrotask(() => {
        if (document.activeElement !== input) return;
        const start = input.selectionStart, end = input.selectionEnd, length = input.value.length;
        ReactDOM.flushSync(() => setEditing(true));
        input.setSelectionRange(start === length ? identifier.length : start, end === length ? identifier.length : end);
      });
    };
    useEffect(() => {
      let active = true;
      const fit = () => {
        if (!active || !land.current) return;
        const hero = land.current.querySelector('.si23-hero'), dot = land.current.querySelector('.si23-dot'), button = land.current.querySelector('.si23-dark');
        hero.style.marginBottom = '0px';
        let d = dot.getBoundingClientRect(), b = button.getBoundingClientRect();
        const wide = b.left > d.right;
        if (wide) {
          // Preserve the original settled hero's 5px optical offset.
          const room = hero.getBoundingClientRect().top - land.current.querySelector('.si23-body').getBoundingClientRect().top - 8;
          hero.style.marginBottom = Math.max(0, Math.min(d.top + d.height / 2 - b.top - b.height / 2 - 5, room)) + 'px';
        }
        b = button.getBoundingClientRect();
        const width = b.left - d.right - d.width * .5 - 2;
        dot.style.setProperty('--wire', (wide && width > 24 ? width : 0) + 'px');
      };
      fit(); document.fonts.ready.then(fit);
      const node = land.current; node.addEventListener('animationend', fit);
      window.addEventListener('resize', fit);
      return () => { active = false; window.removeEventListener('resize', fit); node.removeEventListener('animationend', fit); };
    }, [error, shopName]);
    return <Surface><div className="si23-land" ref={land}><header className="si23-hd"><Brand /><div className="si23-new"><span className="si23-q">New here?</span><button type="button" className="si23-lnk" onClick={onSignup}>Create your desk</button></div></header>
      <div className="si23-body"><div className="si23-hero"><div className="si23-eyebrow">Sign in</div><h1>Open<br /><em>the</em> desk<span className="si23-dot" aria-hidden="true" /></h1>
        {error ? <p className="si23-lede si23-err" role="alert">{error}</p> : shopName ? <p className="si23-lede">Signing in to <b>{shopName}</b></p> : null}</div>
        <form className="si23-col" onSubmit={e => { e.preventDefault(); onContinue(); }}>
          <button type="button" className="si23-ab si23-dark" disabled={!methods.passkey} onClick={methods.passkey} title={!methods.passkey ? 'Passkey sign-in is not connected yet' : undefined}><span className="si23-ic"><PasskeyIcon /></span>Continue with a passkey<span className="si23-tag">Recommended</span></button>
          <div className="si23-two">{['google', 'microsoft'].map(provider => <button key={provider} type="button" className="si23-ab" disabled={!methods[provider]} onClick={methods[provider]} aria-label={'Sign in with ' + (provider === 'google' ? 'Google' : 'Microsoft')} title={!methods[provider] ? 'Provider sign-in is not connected yet' : undefined}>
            <span className="si23-ic"><img alt="" src={'/assets/signin/' + (provider === 'google' ? 'google-g-logo.png' : 'microsoft-logo.svg')} /></span>{provider === 'google' ? 'Google' : 'Microsoft'}</button>)}</div>
          <div className="si23-or">or</div><div className="si23-field"><label htmlFor="si23-id">Email or CurrencyDesk ID</label><div className="si23-inp">
            <input id="si23-id" value={editing ? identifier : formatIdentifier(identifier)} onChange={e => onIdentifier(e.target.value)} onFocus={editIdentifier} onBlur={() => setEditing(false)} autoFocus autoComplete="username webauthn" autoCapitalize="off" spellCheck={false} placeholder="Your email or ID" />
            <button className="si23-ib si23-arrow" type="submit" aria-label="Continue" disabled={identifier.trim().length < 3}><Arrow /></button></div></div>
          <div className="si23-rec">Can’t get in? <button className="si23-lnk" type="button" onClick={onRecover}>Recover access</button></div>
        </form></div><footer className="si23-ft"><Back onBack={onBack} /><span>Every exchange, on the record.</span></footer></div></Surface>;
  }
  function Password({ identifier, password, onPassword, show, onShow, onBack, onSubmit, onRecover, error, status, busy, disabled, onPasskey }) {
    return <Frame onBack={onBack}><form className="si23-card" onSubmit={onSubmit} aria-busy={busy}>
      <h2>Enter your password</h2><div className="si23-who-id"><span><b>{identifier}</b></span><button className="si23-lnk" type="button" onClick={onBack}>Change</button></div>
      <div className="si23-field"><label htmlFor="si23-password">Password</label><div className="si23-inp"><input id="si23-password" aria-describedby={error || status ? 'si23-password-status' : undefined} aria-invalid={!!error} type={show ? 'text' : 'password'} value={password} onChange={e => onPassword(e.target.value)} autoComplete="current-password" placeholder="Your password" autoFocus />
        <button className="si23-ib" type="button" onClick={onShow}>{show ? 'Hide' : 'Show'}</button></div>{(error || status) && <div id="si23-password-status" className={'si23-hint' + (error ? ' si23-err' : '')} role={error ? 'alert' : 'status'}>{error || status}</div>}</div>
      <button className="si23-cta" type="submit" disabled={disabled}>{busy ? 'Checking…' : 'Continue →'}</button>
      <div className="si23-quiet"><button type="button" className="si23-lnk" onClick={onRecover}>Forgot password?</button><button type="button" className="si23-lnk" disabled={!onPasskey} onClick={onPasskey}>Use a passkey instead</button></div>
    </form></Frame>;
  }
  window.CDOS = window.CDOS || {};
  window.CDOS.SignInV23 = { FirstScreen, Password, Frame, formatIdentifier };
})();
