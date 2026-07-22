/* ============================================================
   CurrencyDesk OS — Sign-in (design: "CurrencyDesk Sign In")
   A faithful rebuild of the sign-in lifecycle from the design project:
     A1 CurrencyDesk ID  →  A2 Password  →  A3 email-code keypad
   then the existing station picker / desktop. The shared on-screen
   keypad also powers desk-lock unlock (B) and operator handover (C).
   Backend auth is unchanged: the ID resolves a staff record, the
   password calls /api/auth/login, the code step is the (simulated) 2FA.
   Tokens mirror the design exactly (ink #17140F, primary #1D6B45, …).
   ============================================================ */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;

  // design tokens → CSS vars, scoped to the sign-in surface
  const VARS = {
    '--si-ink': '#17140F', '--si-paper': '#F1EEE8', '--si-panel': '#FFFFFF',
    '--si-pin': '#F4F1E9', '--si-line': 'rgba(23,20,15,0.12)', '--si-soft': 'rgba(23,20,15,0.07)',
    '--si-mute': '#6E675E', '--si-faint': '#9a938a', '--si-primary': '#1D6B45',
    '--si-primary-deep': '#17583A', '--si-plum': '#5E4B8B', '--si-flag': '#c0392b',
    fontFamily: "'Archivo', system-ui, sans-serif", color: 'var(--si-ink)',
  };
  const MONO = "'Space Mono', monospace";
  const PAPER_BG = {
    backgroundColor: '#e7e4dd',
    backgroundImage: 'radial-gradient(130% 100% at 50% -10%, #f4f2ed 0%, #e4e1d9 55%, #d3cfc5 100%), radial-gradient(circle, rgba(23,20,15,0.05) 1px, transparent 1.4px)',
    backgroundSize: 'auto, 22px 22px',
  };

  // CD logo mark (filled disc + D bowl + green dot). `cut` = the notch colour
  // (matches whatever surface it sits on).
  function Mark({ w = 34, h = 24, cut = '#F1EEE8' }) {
    return (
      <svg viewBox="0 0 200 140" width={w} height={h} style={{ display: 'block' }}>
        <circle cx="60" cy="70" r="48" fill="#17140F" />
        <path d="M116,22 H136 A48,48 0 0 1 136,118 H116 Z" fill="#17140F" />
        <rect x="60" y="64.5" width="92" height="11" fill={cut} />
        <circle cx="112" cy="70" r="6.5" fill="#1D6B45" />
      </svg>
    );
  }

  const initialsOf = (name) => (name || '').split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase() || 'CD';
  const firstOf = (name) => (name || '').split(/[ .]+/).filter(Boolean)[0] || '';

  /* ---- shared on-screen keypad (A3 code, B unlock, C handover) --------- */
  function Keypad({ value, max, onDigit, onBack, leftLabel, onLeft, verifying }) {
    const numKey = (d) => (
      <button key={d} type="button" disabled={verifying} onClick={() => onDigit(String(d))}
        style={{ height: 62, background: 'var(--si-panel)', border: '1px solid rgba(23,20,15,0.07)', borderRadius: 16,
          fontFamily: MONO, fontSize: 24, fontWeight: 700, color: 'var(--si-ink)', cursor: verifying ? 'default' : 'pointer',
          boxShadow: '0 1px 0 rgba(23,20,15,0.04), 0 10px 18px -12px rgba(23,20,15,0.4)', transition: 'filter .12s, transform .06s' }}
        onMouseDown={e => { e.currentTarget.style.transform = 'translateY(1px) scale(0.99)'; }}
        onMouseUp={e => { e.currentTarget.style.transform = 'none'; }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}>
        {d}
      </button>
    );
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(numKey)}
        {leftLabel != null
          ? <button type="button" disabled={verifying} onClick={onLeft}
              style={{ background: 'none', border: 'none', fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--si-ink)', cursor: 'pointer' }}>{leftLabel}</button>
          : <span />}
        {numKey(0)}
        <button type="button" disabled={verifying} onClick={onBack} aria-label="Delete"
          style={{ background: 'none', border: 'none', fontSize: 26, color: 'var(--si-mute)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>←</button>
      </div>
    );
  }

  // small mail glyph for the email-code card
  function MailGlyph() {
    return (
      <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(29,107,69,0.10)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#1D6B45" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
        </svg>
      </div>
    );
  }

  const primaryBtn = (enabled) => ({
    width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
    background: enabled ? 'var(--si-primary)' : 'rgba(23,20,15,0.07)', color: enabled ? '#fff' : 'var(--si-faint)',
    fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', transition: 'background .15s',
  });

  /* ====================== SIGN-IN FLOW (A1 → A2 → A3) ================== */
  function SignIn({ employees, onSignup, onComplete, onMustChange }) {
    const [step, setStep] = useState('id');            // id | password | code
    const [idInput, setIdInput] = useState('');
    const [pw, setPw] = useState(''); const [showPw, setShowPw] = useState(false);
    const [code, setCode] = useState('');
    const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
    const [verifying, setVerifying] = useState(false); const [note, setNote] = useState('');
    const dir = (employees || []).filter(e => e.active !== false);
    // recognise the typed ID against the local directory (by code, then name)
    const resolve = (raw) => { const q = (raw || '').trim().toLowerCase(); return dir.find(e => (e.code || '').toLowerCase() === q) || dir.find(e => e.name.toLowerCase() === q) || null; };
    const known = useMemo(() => resolve(idInput), [idInput, dir]);
    const owner = dir.find(e => e.role === 'Owner') || dir[0];
    const rep = dir.find(e => e.role !== 'Owner' && e !== owner) || dir[1];
    const examples = [owner, rep].filter(Boolean).slice(0, 2);

    // captured across the login call so the code step can complete
    const authRef = useRef({ rec: null, srvPlan: null, srvUser: null });

    const goPassword = () => { if (idInput.trim().length < 3) { setErr('Enter your CurrencyDesk ID.'); return; } setErr(''); setStep('password'); };

    const SRV2OS = { administrator: 'Owner', branch_manager: 'Manager', supervisor: 'Senior teller', compliance_officer: 'Manager', teller: 'Cashier', auditor: 'Trainee' };
    const adopt = (u, rec) => rec || { id: 'e_' + Date.now(), code: u.id, name: u.name || u.id, role: SRV2OS[u.role] || 'Cashier', active: true, branches: [], home: null, _adopted: true };

    // Step 1: prove the password. The server emails a code (email identities)
    // and we advance to the keypad; users with no email sign in immediately.
    async function submitPassword(e) {
      e && e.preventDefault();
      if (pw.length < 4) { setErr('Enter your password.'); return; }
      let rec = known;
      const staffId = rec ? (rec.code || rec.name) : idInput.trim().toLowerCase();
      setBusy(true); setErr('Checking… (first sign-in of the day can take ~30s while the server wakes)');
      try {
        const res = await fetch('/api/auth/login/start', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId, password: pw }),
        });
        if (res && res.status === 401) { setBusy(false); setErr('That password doesn’t match this ID. Try again — or the owner can reset it.'); return; }
        if (res && !res.ok) { setBusy(false); setErr('Sign-in service error (' + res.status + ') — try again in a moment.'); return; }
        const data = await res.json().catch(() => null);
        const u = (data && data.user) || null;
        const srvPlan = (u && u.plan) || null;
        if (!rec && u) rec = adopt(u, null);
        setBusy(false); setErr('');
        if (u && u.mustChangePassword) { onMustChange(rec, { current: pw }, srvPlan, u); return; }
        authRef.current = { rec, srvPlan, srvUser: u, staffId, tenantId: (u && u.tenantId) || undefined, maskedEmail: data && data.maskedEmail };
        if (data && data.needsCode === false) { onComplete(rec, srvPlan, u); return; } // password-only (no email on file)
        setCode(''); setStep('code');
      } catch (_) {
        // no backend at all — keep the offline demo flowing through the code step
        setBusy(false); setErr('');
        if (!rec) { setErr('No staff record for that ID — pick one from the examples.'); return; }
        authRef.current = { rec, srvPlan: null, srvUser: null, staffId, demo: true };
        setCode(''); setStep('code');
      }
    }

    // Step 2: the emailed code grants the session.
    async function verifyCode(codeVal) {
      const a = authRef.current;
      setVerifying(true); setErr('');
      if (a.demo || !a.staffId) { setTimeout(() => onComplete(a.rec, a.srvPlan, a.srvUser), 900); return; } // offline demo
      try {
        const res = await fetch('/api/auth/login/verify', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId: a.staffId, tenantId: a.tenantId, code: codeVal }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setVerifying(false); setCode(''); setErr((data && data.detail) || 'That code isn’t right — check your email.'); return; }
        const u = (data && data.user) || a.srvUser;
        onComplete(a.rec, (u && u.plan) || a.srvPlan, u);
      } catch (_) { setVerifying(false); setErr('Network error — try again.'); }
    }
    async function resendCode() {
      const a = authRef.current;
      if (!a.staffId || a.demo) { setCode(''); return; }
      setNote('Sending a new code…');
      try { await fetch('/api/auth/login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ staffId: a.staffId, password: pw }) }); setNote('A new code is on its way.'); setCode(''); } catch (_) { setNote('Couldn’t resend — try again.'); }
    }

    const pushDigit = (d) => {
      if (verifying || code.length >= 6) return;
      const next = (code + d).slice(0, 6);
      setCode(next);
      if (next.length === 6) verifyCode(next);
    };
    const backDigit = () => { if (!verifying) setCode(code.slice(0, -1)); };

    const maskedEmail = (() => {
      if (authRef.current.maskedEmail) return authRef.current.maskedEmail;
      const em = (authRef.current.srvUser && authRef.current.srvUser.id) || (known && known.email) || '';
      if (em.indexOf('@') < 0) return 'your email on file';
      const [u, d] = em.split('@'); return (u[0] || '') + '••••@' + d;
    })();

    // ---- shells --------------------------------------------------------
    const card = (children, width = 404) => (
      <div style={{ width, maxWidth: 'calc(100vw - 40px)', background: step === 'code' ? 'var(--si-pin)' : 'rgba(255,255,255,0.55)',
        backdropFilter: 'saturate(180%) blur(30px)', WebkitBackdropFilter: 'saturate(180%) blur(30px)',
        border: '1px solid rgba(23,20,15,0.08)', borderRadius: step === 'code' ? 30 : 20, padding: step === 'code' ? '30px 34px' : '34px 34px 26px',
        boxShadow: step === 'code' ? '0 40px 90px -28px rgba(23,20,15,0.6)' : '0 24px 60px -14px rgba(23,20,15,0.32), 0 0 0 1px rgba(23,20,15,0.05)',
        animation: 'cdWinIn .42s cubic-bezier(0.2,0.8,0.2,1)' }}>{children}</div>
    );

    const shell = (children) => (
      <div id="lock" style={{ ...VARS, ...PAPER_BG, position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', overflow: 'auto' }}>
        <style>{'@keyframes cdWinIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}@keyframes cdSpin{to{transform:rotate(360deg)}}'}</style>
        <div style={{ position: 'absolute', top: 26, left: 30, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Mark w={30} h={21} cut="#e7e4dd" />
          <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, letterSpacing: '0.12em' }}>CURRENCYDESK</span>
          <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.2em', color: 'var(--si-faint)' }}>OS</span>
        </div>
        {children}
      </div>
    );

    // ---- A1 · CurrencyDesk ID -----------------------------------------
    if (step === 'id') return shell(card(<form onSubmit={e => { e.preventDefault(); goPassword(); }}>
      <div style={{ display: 'grid', placeItems: 'center', marginBottom: 4 }}><Mark w={44} h={31} cut="rgba(255,255,255,0.55)" /></div>
      <div style={{ textAlign: 'center', fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.34em', color: 'var(--si-primary)', margin: '8px 0 6px' }}>FAIR EXCHANGE</div>
      <h1 style={{ textAlign: 'center', fontSize: 23, fontWeight: 800, letterSpacing: '-0.01em', margin: '0 0 2px' }}>Sign in</h1>
      <div style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.18em', color: 'var(--si-mute)', marginBottom: 18 }}>CURRENCYDESK OS</div>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--si-mute)', marginBottom: 6 }}>CURRENCYDESK ID</div>
      <input value={idInput} onChange={e => { setIdInput(e.target.value); setErr(''); }} autoFocus placeholder="your-staff-id"
        style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: MONO, fontSize: 18, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          padding: '13px 12px', border: '1px solid var(--si-line)', borderRadius: 11, background: 'var(--si-panel)', outline: 'none' }}
        onFocus={e => { e.target.style.borderColor = 'var(--si-primary)'; e.target.style.boxShadow = '0 0 0 3px rgba(29,107,69,0.14)'; }}
        onBlur={e => { e.target.style.borderColor = 'var(--si-line)'; e.target.style.boxShadow = 'none'; }} />
      {known && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, padding: '9px 12px', borderRadius: 10, background: 'rgba(29,107,69,0.08)', border: '1px solid rgba(29,107,69,0.2)' }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#1D6B45" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          <span style={{ fontSize: 13 }}><b>{known.name}</b> <span style={{ color: 'var(--si-mute)' }}>· {(known.role || 'Staff')} · York Currency Exchange</span></span>
        </div>
      )}
      {!known && examples.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: 'var(--si-faint)' }}>EXAMPLES</span>
          {examples.map(ex => (
            <button key={ex.code || ex.name} type="button" onClick={() => { setIdInput(ex.code || ex.name); setErr(''); }}
              style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, padding: '5px 9px', borderRadius: 8, border: '1px dashed var(--si-line)', background: 'transparent', color: 'var(--si-ink)', cursor: 'pointer' }}>
              {(ex.code || ex.name)} · {(ex.role || 'staff').toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {err && <div style={{ color: 'var(--si-flag)', fontSize: 12, marginTop: 12 }}>{err}</div>}
      <button type="submit" disabled={idInput.trim().length < 3} style={{ ...primaryBtn(idInput.trim().length >= 3), marginTop: 16 }}>Continue →</button>
      <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--si-mute)', marginTop: 16, lineHeight: 1.6 }}>
        Every session is <b style={{ color: 'var(--si-ink)' }}>on the record</b>. No ID? Ask the owner of your desk.
      </div>
      {onSignup && <div style={{ textAlign: 'center', fontSize: 12, marginTop: 10 }}>
        New to CurrencyDesk? <button type="button" onClick={onSignup} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--si-primary)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Create your desk →</button>
      </div>}
    </form>));

    // ---- A2 · Password -------------------------------------------------
    if (step === 'password') {
      const first = firstOf(known ? known.name : '');
      return shell(card(<form onSubmit={submitPassword}>
        <div style={{ display: 'grid', placeItems: 'center', marginBottom: 12 }}>
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'var(--si-ink)', color: '#fff', display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 19, fontWeight: 700 }}>{initialsOf(known ? known.name : idInput)}</div>
        </div>
        <h1 style={{ textAlign: 'center', fontSize: 23, fontWeight: 800, letterSpacing: '-0.01em', margin: '0 0 4px' }}>{first ? 'Welcome back, ' + first : 'Welcome back'}</h1>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--si-mute)', marginBottom: 18 }}>
          <span style={{ fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{idInput}</span> · <button type="button" onClick={() => { setStep('id'); setPw(''); setErr(''); }} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--si-primary)', cursor: 'pointer', fontWeight: 700 }}>not you?</button>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--si-mute)', marginBottom: 6 }}>PASSWORD</div>
        <div style={{ position: 'relative' }}>
          <input type={showPw ? 'text' : 'password'} value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} autoFocus placeholder="••••••••" autoComplete="current-password"
            style={{ width: '100%', boxSizing: 'border-box', padding: '13px 62px 13px 14px', fontSize: 15, border: '1px solid var(--si-line)', borderRadius: 11, background: 'var(--si-panel)', outline: 'none' }}
            onFocus={e => { e.target.style.borderColor = 'var(--si-primary)'; e.target.style.boxShadow = '0 0 0 3px rgba(29,107,69,0.14)'; }}
            onBlur={e => { e.target.style.borderColor = 'var(--si-line)'; e.target.style.boxShadow = 'none'; }} />
          <button type="button" onClick={() => setShowPw(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--si-mute)', background: 'var(--si-soft)', border: 'none', borderRadius: 7, padding: '5px 9px', cursor: 'pointer' }}>{showPw ? 'HIDE' : 'SHOW'}</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--si-faint)', marginTop: 8 }}>Forgot it? The owner can reset it.</div>
        {err && <div style={{ color: 'var(--si-flag)', fontSize: 12, marginTop: 12 }}>{err}</div>}
        <button type="submit" disabled={busy || pw.length < 4} style={{ ...primaryBtn(!busy && pw.length >= 4), marginTop: 16 }}>{busy ? 'Checking…' : 'Send my code'}</button>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--si-mute)', marginTop: 14 }}>We'll email a fresh code to confirm it's you.</div>
      </form>));
    }

    // ---- A3 · Email code (keypad) -------------------------------------
    return shell(card(<div style={{ textAlign: 'center' }}>
      <MailGlyph />
      <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', margin: '0 0 4px' }}>Check your email</h1>
      <div style={{ fontSize: 13.5, color: 'var(--si-mute)', marginBottom: 16 }}>A fresh 6-digit code just went to <b style={{ color: 'var(--si-ink)' }}>{maskedEmail}</b>.</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {[0, 1, 2, 3, 4, 5].map(i => {
          const filled = i < code.length, active = i === code.length && !verifying;
          return <div key={i} style={{ flex: 1, height: 56, borderRadius: 12, background: 'var(--si-panel)', display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 22, fontWeight: 700,
            border: active ? '1.5px solid var(--si-primary)' : '1px solid var(--si-line)', boxShadow: active ? '0 0 0 3px rgba(29,107,69,0.12)' : 'none' }}>{filled ? '•' : ''}</div>;
        })}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: err ? 'var(--si-flag)' : 'var(--si-faint)', margin: '4px 0 14px' }}>{err ? err.toUpperCase() : verifying ? 'VERIFYING…' : 'TAP THE CODE IN BELOW'}</div>
      <Keypad value={code} max={6} onDigit={pushDigit} onBack={backDigit} leftLabel="Resend" onLeft={resendCode} verifying={verifying} />
      <div style={{ fontSize: 11, color: 'var(--si-faint)', marginTop: 16 }}>{note || 'Code expires in 10 minutes · prefer a text? Method choice coming soon.'}</div>
      <button type="button" onClick={() => { setStep('password'); setCode(''); }} style={{ background: 'none', border: 'none', color: 'var(--si-mute)', fontSize: 12, marginTop: 10, cursor: 'pointer' }}>← Back</button>
    </div>));
  }

  /* ---- shared PIN-card bits (lock B + handover C) --------------------- */
  const cdKeyframes = '@keyframes cdWinIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}';
  const PinCard = { width: 380, maxWidth: 'calc(100vw - 40px)', background: 'var(--si-pin)', border: '1px solid rgba(23,20,15,0.08)', borderRadius: 30, padding: '30px 34px', textAlign: 'center', boxShadow: '0 40px 90px -28px rgba(23,20,15,0.6)', animation: 'cdWinIn .42s cubic-bezier(0.2,0.8,0.2,1)' };
  const Scrim = { position: 'fixed', inset: 0, zIndex: 9000, display: 'grid', placeItems: 'center', ...VARS, background: 'radial-gradient(120% 90% at 50% 32%, rgba(23,20,15,0.2), rgba(23,20,15,0.44))', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' };
  function Pill({ children }) {
    return <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', border: '1px solid var(--si-line)', borderRadius: 999, fontFamily: MONO, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--si-mute)', marginBottom: 16, background: 'rgba(255,255,255,0.5)' }}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>{children}</div>;
  }
  function Avatar({ name, size = 74 }) {
    return <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--si-ink)', color: '#fff', display: 'grid', placeItems: 'center', margin: '0 auto 14px', fontFamily: MONO, fontSize: size * 0.3, fontWeight: 700 }}>{initialsOf(name)}</div>;
  }
  function Dots({ n, filled }) {
    return <div style={{ display: 'flex', gap: 20, justifyContent: 'center', margin: '6px 0 18px' }}>
      {Array.from({ length: n }).map((_, i) => { const f = i < filled; return <span key={i} style={{ width: 17, height: 17, borderRadius: '50%', transition: 'all .18s', ...(f ? { background: 'var(--si-ink)', border: '1.5px solid var(--si-ink)', transform: 'scale(1.05)' } : { border: '1.6px solid rgba(23,20,15,0.28)', background: 'transparent' }) }} />; })}
    </div>;
  }

  /* ---- B · desk lock / PIN unlock ------------------------------------- */
  function LockDesk({ operator, onUnlock, onSwitch, onSignout }) {
    const [pin, setPin] = useState(''); const [verifying, setVerifying] = useState(false);
    const push = (d) => { if (verifying || pin.length >= 4) return; const n = (pin + d).slice(0, 4); setPin(n); if (n.length === 4) { setVerifying(true); setTimeout(onUnlock, 850); } };
    return (<div style={Scrim}><style>{cdKeyframes}</style>
      <div style={PinCard}>
        <Pill>Desk locked</Pill>
        <Avatar name={operator && operator.name} />
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 4 }}>{'Welcome back, ' + (firstOf(operator && operator.name) || 'there')}</div>
        <div style={{ fontSize: 13.5, color: 'var(--si-mute)', marginBottom: 4 }}>Enter your PIN — the session's still live.</div>
        <Dots n={4} filled={pin.length} />
        <Keypad value={pin} max={4} onDigit={push} onBack={() => { if (!verifying) setPin(pin.slice(0, -1)); }} leftLabel={null} verifying={verifying} />
        <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 18, fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em' }}>
          <button type="button" onClick={onSwitch} style={{ background: 'none', border: 'none', color: 'var(--si-plum)', cursor: 'pointer' }}>Switch operator</button>
          <span style={{ color: 'var(--si-faint)' }}>·</span>
          <button type="button" onClick={onSignout} style={{ background: 'none', border: 'none', color: 'var(--si-flag)', cursor: 'pointer' }}>Sign out</button>
        </div>
      </div>
    </div>);
  }

  /* ---- C · operator handover ------------------------------------------ */
  function Handover({ operators, current, onCancel, onConfirm }) {
    const [pick, setPick] = useState(null);
    const [pin, setPin] = useState(''); const [verifying, setVerifying] = useState(false);
    const others = (operators || []).filter(o => o.active !== false);
    if (!pick) {
      return (<div style={Scrim}><style>{cdKeyframes}</style>
        <div style={{ ...PinCard, width: 448, textAlign: 'left', padding: '28px 30px' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--si-plum)', marginBottom: 8 }}>Handover · on the record</div>
          <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 6 }}>Who's taking the desk?</div>
          <div style={{ fontSize: 13, color: 'var(--si-mute)', marginBottom: 16, lineHeight: 1.6 }}>The live session and the open drawer pass to the next operator. Every handover is logged with who, when, and which till.</div>
          <div style={{ display: 'grid', gap: 8, maxHeight: 260, overflow: 'auto' }}>
            {others.map(o => {
              const isCur = current && o.name === current.name;
              return (<div key={o.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', borderRadius: 12,
                background: isCur ? 'var(--si-soft)' : 'transparent', border: isCur ? '1px solid var(--si-line)' : '1.5px solid rgba(29,107,69,0.35)' }}>
                <Avatar name={o.name} size={38} />
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{o.name}</span><span style={{ display: 'block', fontSize: 12, color: 'var(--si-mute)' }}>{o.role || 'Staff'}</span></span>
                {isCur ? <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--si-faint)', textTransform: 'uppercase' }}>On the desk now</span>
                  : <button type="button" onClick={() => { setPick(o); setPin(''); }} style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--si-primary)', background: 'rgba(29,107,69,0.08)', border: 'none', borderRadius: 9, padding: '7px 13px', cursor: 'pointer' }}>Take over</button>}
              </div>);
            })}
          </div>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button type="button" onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--si-mute)', fontSize: 12.5, cursor: 'pointer' }}>← Keep the desk with me</button>
          </div>
        </div>
      </div>);
    }
    const push = (d) => { if (verifying || pin.length >= 4) return; const n = (pin + d).slice(0, 4); setPin(n); if (n.length === 4) { setVerifying(true); setTimeout(() => onConfirm(pick), 850); } };
    return (<div style={Scrim}><style>{cdKeyframes}</style>
      <div style={PinCard}>
        <Pill>PIN required</Pill>
        <Avatar name={pick.name} />
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 4 }}>Confirm it's you</div>
        <div style={{ fontSize: 13.5, color: 'var(--si-mute)', marginBottom: 4 }}>{firstOf(pick.name)}, enter your PIN to take this drawer.</div>
        <Dots n={4} filled={pin.length} />
        <Keypad value={pin} max={4} onDigit={push} onBack={() => { if (!verifying) setPin(pin.slice(0, -1)); }} leftLabel="Cancel" onLeft={() => { setPick(null); setPin(''); }} verifying={verifying} />
      </div>
    </div>);
  }

  window.CDOS = window.CDOS || {};
  window.CDOS.SignIn = SignIn;
  window.CDOS.LockDesk = LockDesk;
  window.CDOS.Handover = Handover;
  window.CDOS.SignInMark = Mark;
  window.CDOS.SignInKeypad = Keypad;
})();
