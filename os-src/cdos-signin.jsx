/* ============================================================
   CurrencyDesk OS — Sign-in (design: "CurrencyDesk Sign In")
   A faithful rebuild of the sign-in lifecycle from the design project:
     A1 CurrencyDesk ID  →  A2 Password  →  A3 email-code keypad
   then the existing station picker / desktop. The shared on-screen
   keypad also powers desk-lock unlock (B) and operator handover (C).
   Backend auth is unchanged: the ID resolves a staff record, the
   password calls /api/auth/login/start, the code step is the emailed
   factor checked by /api/auth/login/verify.
   Tokens mirror the design exactly (ink #17140F, primary #1D6B45, …).

   A phone (max-width 430px) renders a different tree: ID and password
   together, then six code boxes. The returns further down are the wide
   layout and are not used at that width, so a desktop pixel stays put.
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
  /* Viewport, not a second app. A wide window never takes this branch.
     A phone turned sideways is wider than 430px and shorter than it, so
     the code step has to follow that shape too. 932px is a large phone
     on its side. A 1280 desk, even a short one, stays on the wide screen. */
  const PHONE_Q = '(max-width: 430px), (max-width: 932px) and (max-height: 430px) and (orientation: landscape)';
  const phoneNow = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_Q).matches;
  /* The staff ID is the only thing this device stores. The password is
     never written — Apple Passwords (autocomplete) is the only memory.
     The name is not cdos_* or yorkfx_*. Those prefixes are the desk's
     saved state: signing in copies that document over every matching
     key, which would forget this phone's ID or share it with the shop. */
  const STAFF_KEY = 'phone_staff_id';
  const readStaffId = () => {
    try { return localStorage.getItem(STAFF_KEY) || ''; }
    catch (e) { return ''; } // storage blocked: the field starts empty, sign-in still works
  };
  /* The code step, and nothing secret. A refresh, the browser's back
     button, and the on-screen Back all have to be able to show the
     boxes again: the server will not email a second code for two
     minutes, so a password form with only "a code went out" is a
     dead end. The password and the six digits are never written.
     sessionStorage, not localStorage, so closing the tab drops it.
     The name is not cdos_* or yorkfx_*. Those prefixes are the desk's
     saved state. */
  const STEP_KEY = 'phone_signin_step';
  const CODE_TTL_MS = 10 * 60 * 1000;
  const RESEND_WAIT_MS = 120 * 1000;
  const CODE_WRONG = 'That code is not right. Check the newest email.';
  const CODE_EXPIRED = 'That code has expired. Sign in again for a new one.';
  const CODE_LOCKED = 'This sign-in is locked after 5 tries.';
  const SIGNIN_TROUBLE = 'Sign-in is having trouble. Try again in a minute.';
  const PASTE_ONLY = 'Paste only the 6-digit code.';
  const RESEND_SENT = 'A new code is on its way.';
  const SRV2OS_ROLE = { administrator: 'Owner', branch_manager: 'Manager', supervisor: 'Senior teller', compliance_officer: 'Manager', teller: 'Cashier', auditor: 'Trainee' };
  const clearCodeStep = () => { try { sessionStorage.removeItem(STEP_KEY); } catch (e) {} };
  const readCodeStep = () => {
    let raw = '';
    try { raw = sessionStorage.getItem(STEP_KEY) || ''; }
    catch (e) { return null; }
    if (!raw) return null;
    let d = null;
    try { d = JSON.parse(raw); }
    catch (e) { clearCodeStep(); return null; }
    if (!d || d.step !== 'code' || typeof d.staffId !== 'string' || !d.staffId || typeof d.sentAt !== 'number') {
      clearCodeStep(); return null;
    }
    /* Ten minutes is the server's challenge life. After that the
       boxes would only collect a code the server has already dropped. */
    if (Date.now() - d.sentAt > CODE_TTL_MS) { clearCodeStep(); return null; }
    return d;
  };
  /* Explicit fields. A future edit that passes the whole form must
     not be able to sneak the password or the code into this record. */
  const writeCodeStep = (d) => {
    const safe = {
      step: 'code',
      staffId: d.staffId,
      maskedEmail: d.maskedEmail || '',
      tenantId: d.tenantId || '',
      mustChange: !!d.mustChange,
      sentAt: d.sentAt,
      waitUntil: d.waitUntil,
      user: d.user ? {
        id: d.user.id,
        name: d.user.name,
        role: d.user.role,
        tenantId: d.user.tenantId,
        mustChangePassword: !!d.user.mustChangePassword,
      } : null,
    };
    try { sessionStorage.setItem(STEP_KEY, JSON.stringify(safe)); }
    catch (e) {}
    return safe;
  };
  const waitLeft = (waitUntil) => (typeof waitUntil === 'number' ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0);
  const stepRecord = (saved) => {
    const u = saved.user || null;
    const staffId = saved.staffId;
    const rec = u
      ? { id: 'e_' + (u.id || staffId), code: u.id || staffId, name: u.name || u.id || staffId, role: SRV2OS_ROLE[u.role] || 'Cashier', active: true, branches: [], home: null, _adopted: true }
      : { id: 'e_' + staffId, code: staffId, name: staffId, role: 'Cashier', active: true, branches: [], home: null, _adopted: true };
    return {
      rec,
      srvPlan: null,
      srvUser: u,
      staffId,
      tenantId: saved.tenantId || (u && u.tenantId) || undefined,
      maskedEmail: saved.maskedEmail || '',
      mustChange: !!saved.mustChange || !!(u && u.mustChangePassword),
    };
  };
  /* One code, or nothing. A run is digits in a row. One run of six
     is the code, including when a sentence also has a shorter number
     ("Till 2: your code is 482913"). Spaces that only split a single
     code ("482 913") still join to six once the other characters are
     gone. Seven or eight digits, two codes, or letters are not a code:
     the screen says so and does not spend a try. */
  const oneSixDigitCode = (text) => {
    const raw = String(text || '');
    const runs = raw.match(/\d+/g) || [];
    const sixes = runs.filter((r) => r.length === 6);
    if (sixes.length === 1) return sixes[0];
    if (sixes.length > 1) return '';
    const stripped = raw.replace(/\D/g, '');
    return stripped.length === 6 ? stripped : '';
  };
  const WAKE_MS = 3000;
  const GIVE_UP_MS = 90000;
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
          ? <button type="button" disabled={verifying || !onLeft} onClick={onLeft || undefined}
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
    /* Read once. A later render must not pull a cleared record back. */
    const savedStep = useRef(null);
    const [step, setStep] = useState(() => {
      const saved = phoneNow() ? readCodeStep() : null;
      savedStep.current = saved;
      return saved ? 'code' : 'id';
    });            // id | password | code | forgot | reset
    const [phone, setPhone] = useState(phoneNow);
    const [idInput, setIdInput] = useState(() => (savedStep.current ? savedStep.current.staffId : (phoneNow() ? readStaffId() : '')));
    const [held, setHeld] = useState(() => phoneNow() && !!readStaffId());
    const [pw, setPw] = useState(''); const [showPw, setShowPw] = useState(false);
    const [waking, setWaking] = useState(false); const [gaveUp, setGaveUp] = useState(false);
    const [badPw, setBadPw] = useState(false);
    const codeOnce = useRef(false);
    const [code, setCode] = useState('');
    const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
    const [verifying, setVerifying] = useState(false); const [note, setNote] = useState('');
    const [resetEmail, setResetEmail] = useState(''); const [newPw, setNewPw] = useState('');
    /* HOW LONG UNTIL ANOTHER CODE MAY BE ASKED FOR.

       The server allows one every two minutes and answers 429 with
       `retryAfter` when it is too soon. Counting it down here is not
       decoration: without it the button looks broken, which is exactly
       what makes somebody press it again.

       `sending` is a separate latch from `busy` because it has to be set
       BEFORE the await. React state does not update synchronously, so
       `disabled` alone loses the race against a double-click — the second
       press lands while the first render is still pending. A ref cannot. */
    const [cool, setCool] = useState(() => (savedStep.current ? waitLeft(savedStep.current.waitUntil) : 0));
    const [locked, setLocked] = useState(false);
    const sending = useRef(false);
    useEffect(() => {
      if (cool <= 0) return;
      const t = setTimeout(() => setCool(c => c - 1), 1000);
      return () => clearTimeout(t);
    }, [cool]);
    useEffect(() => {
      const mq = window.matchMedia(PHONE_Q);
      const apply = () => setPhone(mq.matches);
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }, []);
    /* Browser back does not reset React state on its own, and a refresh
       does. Both have to land on the boxes while a code is still live.
       pushState keeps that back press inside this page; the listener
       puts the boxes back if an on-screen Back had already left them. */
    useEffect(() => {
      if (!phone) return undefined;
      const onPop = () => {
        const saved = readCodeStep();
        if (!saved || !phoneNow()) return;
        authRef.current = stepRecord(saved);
        setIdInput(saved.staffId);
        setCool(waitLeft(saved.waitUntil));
        setCode('');
        setErr('');
        setNote('');
        setLocked(false);
        setPw('');
        codeOnce.current = false;
        setStep('code');
        try {
          if (!history.state || history.state.phoneSignIn !== 'code') history.pushState({ phoneSignIn: 'code' }, '');
        } catch (e) {}
      };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }, [phone]);
    useEffect(() => {
      if (!phone || step !== 'code' || locked) return;
      try {
        if (history.state && history.state.phoneSignIn === 'code') return;
        history.pushState({ phoneSignIn: 'code' }, '');
      } catch (e) {}
    }, [phone, step, locked]);
    const startCooldown = (secs) => setCool(Math.max(1, Math.round(secs || 120)));
    const dir = (employees || []).filter(e => e.active !== false);
    // recognise the typed ID against the local directory (by code, then name)
    const resolve = (raw) => { const q = (raw || '').trim().toLowerCase(); return dir.find(e => (e.code || '').toLowerCase() === q) || dir.find(e => e.name.toLowerCase() === q) || null; };
    const known = useMemo(() => resolve(idInput), [idInput, dir]);
    /* EXAMPLES ARE ONLY EVER THIS DESK'S PEOPLE.

       A browser that has never signed in here carries the rehearsal desk's
       five, and offering those to a returning customer showed them two
       strangers' staff IDs and told them to pick one. Somebody who runs
       their own shop signs in with their email address, which looks
       nothing like `j.masri`. If we do not know this desk's people yet, we
       say what the field wants instead of guessing. */
    const ours = dir.filter(e => !e.demo);
    const owner = ours.find(e => e.role === 'Owner') || ours[0];
    const rep = ours.find(e => e.role !== 'Owner' && e !== owner) || ours[1];
    const examples = [owner, rep].filter(Boolean).slice(0, 2);

    // captured across the login call so the code step can complete.
    // A refresh rebuilds it from the saved step, which has no password and no code.
    const authRef = useRef(savedStep.current ? stepRecord(savedStep.current) : { rec: null, srvPlan: null, srvUser: null });

    const goPassword = () => { if (idInput.trim().length < 3) { setErr('Enter your CurrencyDesk ID.'); return; } setErr(''); setStep('password'); };

    const SRV2OS = { administrator: 'Owner', branch_manager: 'Manager', supervisor: 'Senior teller', compliance_officer: 'Manager', teller: 'Cashier', auditor: 'Trainee' };
    const adopt = (u, rec) => rec || { id: 'e_' + Date.now(), code: u.id, name: u.name || u.id, role: SRV2OS[u.role] || 'Cashier', active: true, branches: [], home: null, _adopted: true };
    /* The prototype remains useful as a file/localhost demo, but a deployed
       desk must never look signed in when its API is unavailable. In the live
       product the server session is the identity, not browser state. */
    const offlineDemoAllowed = () => {
      const host = (window.location && window.location.hostname || '').toLowerCase();
      return window.location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local');
    };

    // Step 1: prove the password. The server emails a code (email identities)
    // and we advance to the keypad; users with no email sign in immediately.
    async function submitPassword(e) {
      e && e.preventDefault();
      if (pw.length < 4) { setErr('Enter your password.'); return; }
      // set before the first await, or a double-click gets through
      if (sending.current) return;
      sending.current = true;
      let rec = known;
      const staffId = rec ? (rec.code || rec.name) : idInput.trim().toLowerCase();
      setBusy(true); setErr('Checking… (first sign-in of the day can take ~30s while the server wakes)');
      try {
        const res = await fetch('/api/auth/login/start', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId, password: pw }),
        });
        if (res && res.status === 401) { sending.current = false; setBusy(false); setErr('That password doesn’t match this ID. Try again — or reset it below.'); return; }
        if (res && res.status === 429) {
          const d = await res.json().catch(() => null);
          sending.current = false; setBusy(false);
          startCooldown(d && d.retryAfter);
          setErr((d && d.detail) || 'A code went out moments ago — check your email.');
          return;
        }
        if (res && !res.ok) { sending.current = false; setBusy(false); setErr('Sign-in service error (' + res.status + ') — try again in a moment.'); return; }
        const data = await res.json().catch(() => null);
        const u = (data && data.user) || null;
        const srvPlan = (u && u.plan) || null;
        if (!rec && u) rec = adopt(u, null);
        sending.current = false; setBusy(false); setErr('');
        if (u && u.mustChangePassword) { onMustChange(rec, { current: pw }, srvPlan, u); return; }
        authRef.current = { rec, srvPlan, srvUser: u, staffId, tenantId: (u && u.tenantId) || undefined, maskedEmail: data && data.maskedEmail };
        if (data && data.needsCode === false) { onComplete(rec, srvPlan, u); return; } // password-only (no email on file)
        setCode(''); setStep('code'); startCooldown(120);
      } catch (_) {
        // A static local prototype can still demonstrate the flow. A deployed
        // desk must fail closed and wait for the authentication service.
        sending.current = false; setBusy(false);
        if (!offlineDemoAllowed()) {
          setErr('The sign-in service is unavailable. Check your connection and try again.');
          return;
        }
        if (!rec) { setErr('No staff record for that ID — pick one from the examples.'); return; }
        authRef.current = { rec, srvPlan: null, srvUser: null, staffId, demo: true };
        setCode(''); setStep('code');
      }
    }

    /* Phone door. Same /api/auth/login/start contract as submitPassword.
       The waking card is not a spinner we show immediately: it appears
       only after WAKE_MS with the request still unanswered, and it leaves
       the moment the server answers. At GIVE_UP_MS the request is aborted. */
    const rememberStaff = (id) => {
      try { localStorage.setItem(STAFF_KEY, id); setHeld(true); }
      catch (e) { setHeld(false); } // sign-in continues; the ID just will not be here next time
    };
    const forgetStaff = () => {
      setIdInput(''); setHeld(false); setPw(''); setErr(''); setBadPw(false);
      try { localStorage.removeItem(STAFF_KEY); }
      catch (e) { setErr('This phone could not forget the saved staff ID.'); }
    };
    const mmss = (n) => { const s = Math.max(0, n | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const showCode = (saved) => {
      authRef.current = stepRecord(saved);
      setIdInput(saved.staffId);
      setCool(waitLeft(saved.waitUntil));
      setCode('');
      setErr('');
      setNote('');
      setLocked(false);
      setGaveUp(false);
      setWaking(false);
      codeOnce.current = false;
      setVerifying(false);
      setStep('code');
    };
    /* Five wrong codes and the server deletes the challenge. The
       countdown has to go with it: "New code in 1:23" would keep them
       on a code they can no longer use. Sign in again starts clean. */
    const lockOut = () => {
      clearCodeStep();
      codeOnce.current = false;
      sending.current = false;
      setVerifying(false);
      setBusy(false);
      setCool(0);
      setCode('');
      setNote('');
      setWaking(false);
      setGaveUp(false);
      setLocked(true);
      setErr(CODE_LOCKED);
      setStep('code');
    };
    const signInAgain = () => {
      clearCodeStep();
      codeOnce.current = false;
      setLocked(false);
      setCool(0);
      setCode('');
      setErr('');
      setNote('');
      setPw('');
      setVerifying(false);
      setStep('id');
    };
    const leaveCode = () => {
      codeOnce.current = false; setVerifying(false); setCode(''); setErr(''); setNote(''); setPw(''); setLocked(false); setStep('id');
    };
    /* The staff ID stays. The password field does not: it is not kept
       on screen, and it is not in the saved step. The step itself stays,
       so browser back and a second Sign in can open the boxes again. */
    const useAnother = () => {
      leaveCode();
      setIdInput('');
      setHeld(false);
      try { localStorage.removeItem(STAFF_KEY); }
      catch (e) { setErr('This phone could not forget the saved staff ID.'); }
    };
    /* A short viewport is the keyboard. The button is below the field
       that was just focused, so bring it into the scrolling lock. */
    const keepSignInInView = () => {
      requestAnimationFrame(() => {
        const btn = document.querySelector('#lock.si-phone .si-go');
        if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    async function phoneSubmit(e) {
      e && e.preventDefault();
      if (sending.current) return;
      if (!idInput.trim() || !pw) return;
      sending.current = true;
      setBusy(true); setErr(''); setBadPw(false); setGaveUp(false); setWaking(false);
      const ac = new AbortController();
      const wakeTimer = setTimeout(() => setWaking(true), WAKE_MS);
      const abortTimer = setTimeout(() => ac.abort(), GIVE_UP_MS);
      let rec = known;
      const staffId = rec ? (rec.code || rec.name) : idInput.trim().toLowerCase();
      const stopWait = () => { clearTimeout(wakeTimer); clearTimeout(abortTimer); setWaking(false); };
      try {
        const res = await fetch('/api/auth/login/start', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId, password: pw }), signal: ac.signal,
        });
        stopWait();
        if (res.status === 401) {
          sending.current = false; setBusy(false); setBadPw(true); setPw('');
          setErr('That password does not match this staff ID. Check caps lock and try again.');
          setTimeout(() => { const el = document.getElementById('si-pw'); if (el) el.focus(); }, 0);
          return;
        }
        if (res.status === 429) {
          let d = null;
          try { d = await res.json(); } catch (parseErr) { d = null; }
          sending.current = false; setBusy(false);
          /* too_many_attempts is the verify lock. login/start's 429 is
             too_soon: a code is already in the inbox. The boxes have to
             come back, with the time the server still wants us to wait.
             The sentence alone, on the password form, is the dead end. */
          if (d && d.error === 'too_many_attempts') { lockOut(); return; }
          const retry = Math.max(1, Math.round((d && d.retryAfter) || 120));
          const prev = readCodeStep();
          const same = prev && prev.staffId === staffId ? prev : null;
          const u = (d && d.user) || (same && same.user) || null;
          const saved = writeCodeStep({
            staffId,
            maskedEmail: (d && d.maskedEmail) || (same && same.maskedEmail) || '',
            tenantId: (u && u.tenantId) || (same && same.tenantId) || '',
            mustChange: !!(u && u.mustChangePassword) || !!(same && same.mustChange),
            sentAt: (same && same.sentAt) || Date.now(),
            waitUntil: Date.now() + retry * 1000,
            user: u,
          });
          showCode(saved);
          return;
        }
        if (!res.ok) {
          sending.current = false; setBusy(false);
          /* Never the status number. A 500 is one sentence. Anything
             else keeps the server's own words when it sent them. */
          if (res.status >= 500) { setErr(SIGNIN_TROUBLE); return; }
          let d = null;
          try { d = await res.json(); } catch (parseErr) { d = null; }
          setErr((d && d.detail) || SIGNIN_TROUBLE);
          return;
        }
        let data = null;
        try { data = await res.json(); }
        catch (parseErr) {
          sending.current = false; setBusy(false); setGaveUp(true);
          setErr('The sign-in service answered in a form this screen could not read. Try again.');
          return;
        }
        const u = (data && data.user) || null;
        const srvPlan = (u && u.plan) || null;
        if (!rec && u) rec = adopt(u, null);
        rememberStaff(staffId);
        sending.current = false; setBusy(false); setErr('');
        if (data && data.needsCode === false) {
          clearCodeStep();
          if (u && u.mustChangePassword) { onMustChange(rec, { current: pw }, srvPlan, u); return; }
          onComplete(rec, srvPlan, u); return;
        }
        /* needsCode stays in front of the must-change screen. The code is
           the second factor; the password change needs the session it grants. */
        const sentAt = Date.now();
        const saved = writeCodeStep({
          staffId,
          maskedEmail: (data && data.maskedEmail) || '',
          tenantId: (u && u.tenantId) || '',
          mustChange: !!(u && u.mustChangePassword),
          sentAt,
          waitUntil: sentAt + RESEND_WAIT_MS,
          user: u,
        });
        authRef.current = { rec, srvPlan, srvUser: u, staffId, tenantId: (u && u.tenantId) || undefined, maskedEmail: saved.maskedEmail, mustChange: !!saved.mustChange };
        codeOnce.current = false; setCode(''); setErr(''); setNote(''); setLocked(false); setStep('code'); startCooldown(120);
      } catch (err) {
        stopWait();
        sending.current = false; setBusy(false);
        const aborted = err && err.name === 'AbortError';
        if (!aborted && offlineDemoAllowed()) {
          if (!rec) { setErr('No staff record for that ID.'); return; }
          authRef.current = { rec, srvPlan: null, srvUser: null, staffId, demo: true };
          codeOnce.current = false; setCode(''); setStep('code'); return;
        }
        setGaveUp(true);
        setErr('The sign-in service is not answering. Check the internet and try again.');
      }
    }

    /* ---- forgot password ------------------------------------------
       Nobody could get back in on their own. This screen said "the owner
       can reset it" to the owner, so the only path was a phone call to
       CurrencyDesk and a temporary password read down the line. */
    async function askForReset(e) {
      e && e.preventDefault();
      const addr = (resetEmail || idInput).trim().toLowerCase();
      if (addr.indexOf('@') < 0) { setErr('Enter the email address you sign in with.'); return; }
      if (sending.current || cool > 0) return;
      sending.current = true;
      setBusy(true); setErr('');
      try {
        const res = await fetch('/api/auth/forgot', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ email: addr }),
        });
        sending.current = false; setBusy(false);
        if (res.status === 429) {
          const d = await res.json().catch(() => null);
          startCooldown(d && d.retryAfter);
          setErr((d && d.detail) || 'Too many requests — wait a few minutes.');
          return;
        }
        startCooldown(120);
        /* Deliberately the same words whether or not that address has an
           account. The server says nothing either, and a screen that said
           "no account here" would undo the point of that. */
        setResetEmail(addr); setCode(''); setNewPw(''); setStep('reset');
      } catch (_) { sending.current = false; setBusy(false); setErr('The sign-in service is unavailable. Try again in a moment.'); }
    }

    async function submitReset(e) {
      e && e.preventDefault();
      if (code.length < 6) { setErr('Enter the 6-digit code from your email.'); return; }
      if (newPw.length < 8) { setErr('Pick a password of at least 8 characters.'); return; }
      if (sending.current) return;
      sending.current = true;
      setBusy(true); setErr('');
      try {
        const res = await fetch('/api/auth/reset', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ email: resetEmail, code, newPassword: newPw }),
        });
        const data = await res.json().catch(() => null);
        sending.current = false; setBusy(false);
        if (!res.ok) { setErr((data && data.detail) || 'That code is not right, or it has expired.'); return; }
        /* Straight back to signing in, with the address filled in. The
           reset signed every device out — including any this browser had —
           so proving the new password is both the next step and the proof
           it took. */
        setIdInput(resetEmail); setPw(''); setCode(''); setNewPw('');
        if (phoneNow()) rememberStaff(resetEmail);
        setStep('password');
        setNote('Password changed. Sign in with the new one.');
        setErr('');
      } catch (_) { sending.current = false; setBusy(false); setErr('Network error — try again.'); }
    }

    // Step 2: the emailed code grants the session. One in-flight verify.
    async function verifyCode(codeVal) {
      if (codeOnce.current) return;
      codeOnce.current = true;
      const a = authRef.current;
      setVerifying(true); setErr('');
      if (a.demo || !a.staffId) { setTimeout(() => onComplete(a.rec, a.srvPlan, a.srvUser), 900); return; } // offline demo
      try {
        const res = await fetch('/api/auth/login/verify', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ staffId: a.staffId, tenantId: a.tenantId, code: codeVal }),
        });
        const data = await res.json().catch(() => null); // a non-JSON body has no detail; the status still decides
        if (!res.ok) {
          codeOnce.current = false; setVerifying(false); setCode('');
          if (!phoneNow()) {
            setErr((data && data.detail) || 'That code isn’t right — check your email.');
            return;
          }
          /* One sentence per answer. The status number is never the
             sentence: a 500 is the same words every time. */
          const error = data && data.error;
          if (res.status >= 500) { setErr(SIGNIN_TROUBLE); return; }
          if (res.status === 429 && error === 'too_many_attempts') { lockOut(); return; }
          if (res.status === 410) { setErr(CODE_EXPIRED); return; }
          if (res.status === 401) { setErr(CODE_WRONG); return; }
          setErr(SIGNIN_TROUBLE);
          return;
        }
        clearCodeStep();
        const u = (data && data.user) || a.srvUser;
        if (a.mustChange) { onMustChange(a.rec, { current: pw }, (u && u.plan) || a.srvPlan, u); return; }
        onComplete(a.rec, (u && u.plan) || a.srvPlan, u);
      } catch (err) {
        codeOnce.current = false; setVerifying(false);
        setErr(phoneNow() ? 'The sign-in service is not answering. Check the internet and try again.' : 'Network error — try again.');
      }
    }
    async function resendCode() {
      const a = authRef.current;
      if (!a.staffId || a.demo) { setCode(''); return; }
      if (sending.current || cool > 0 || locked) return;   // the latch, before any await
      sending.current = true;
      setNote('');
      setErr('');
      try {
        const res = await fetch('/api/auth/login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ staffId: a.staffId, password: pw }) });
        const d = await res.json().catch(() => null);
        /* The success sentence waits for the answer. A 429, a 401, or a
           500 used to fall through and tell them a new code was coming. */
        if (res.status === 429 && d && d.error === 'too_many_attempts') { lockOut(); return; }
        if (res.status === 429) {
          const retry = Math.max(1, Math.round((d && d.retryAfter) || 120));
          const prev = readCodeStep();
          if (prev) writeCodeStep({ ...prev, waitUntil: Date.now() + retry * 1000, user: prev.user });
          startCooldown(retry);
          setNote('');
          return;
        }
        if (!res.ok) {
          setNote('');
          if (phoneNow()) setErr(res.status >= 500 ? SIGNIN_TROUBLE : 'Sign in again to send a new code.');
          else setNote('Couldn’t resend — try again.');
          return;
        }
        const sentAt = Date.now();
        const u = (d && d.user) || a.srvUser;
        writeCodeStep({
          staffId: a.staffId,
          maskedEmail: (d && d.maskedEmail) || a.maskedEmail || '',
          tenantId: (u && u.tenantId) || a.tenantId || '',
          mustChange: !!(u && u.mustChangePassword) || !!a.mustChange,
          sentAt,
          waitUntil: sentAt + RESEND_WAIT_MS,
          user: u,
        });
        if (u) authRef.current = { ...a, srvUser: u, maskedEmail: (d && d.maskedEmail) || a.maskedEmail };
        setNote(RESEND_SENT);
        setCode('');
        startCooldown(120);
      } catch (_) {
        setNote('');
        if (phoneNow()) setErr('The sign-in service is not answering. Check the internet and try again.');
        else setNote('Couldn’t resend — try again.');
      }
      finally { sending.current = false; }
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

    /* Phone tree. Returned before any desktop shell so the wide layout's
       elements are not created at this width. The existing logo is the
       mark — the design's "placeholder" caption is a note, not copy. */
    if (phone) {
      const backBtn = (fn) => (
        <button type="button" className="si-back" onClick={fn}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          Back
        </button>
      );
      const eye = (on) => (
        <button type="button" className="si-eye" aria-label={on ? 'Hide password' : 'Show password'} onClick={() => setShowPw(s => !s)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
            {on ? <path d="M4 4l16 16" /> : null}
          </svg>
        </button>
      );
      /* Typing is digits, one at a time, up to six. Anything else is a
         paste or an autofill: exactly one 6-digit run, or the paste
         sentence and no request. maxlength is off so a longer paste is
         not cut to the first six characters before we can see it.
         autocomplete=one-time-code is how iOS Safari can offer the code
         from Mail. Other phones do not fill it from the email. */
      const applyDigits = (raw, fromPaste) => {
        if (locked || verifying) return;
        const text = String(raw || '');
        const digitsOnly = text.replace(/\D/g, '');
        const typed = !fromPaste && text === digitsOnly && digitsOnly.length <= 6;
        if (typed) {
          setCode(digitsOnly);
          if (err) setErr('');
          if (digitsOnly.length === 6) verifyCode(digitsOnly);
          return;
        }
        const next = oneSixDigitCode(text);
        if (!next) {
          setCode('');
          setErr(PASTE_ONLY);
          return;
        }
        setErr('');
        setCode(next);
        verifyCode(next);
      };
      const onCode = (e) => applyDigits(e.target.value, false);
      const onCodePaste = (e) => {
        const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
        e.preventDefault();
        applyDigits(text, true);
      };
      const root = (children) => <div id="lock" className="si-phone" data-phone-signin="1">{children}</div>;
      if (step === 'code') return root(
        <div className="si-col">
          {backBtn(locked ? signInAgain : leaveCode)}
          <h1>Check your email</h1>
          <p className="si-lead">We sent a 6-digit code to {maskedEmail}. Type it here.</p>
          <div className={'si-code' + (err ? ' is-err' : '')}>
            <input id="si-code" className="si-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" autoFocus={!locked} aria-label="6-digit code" disabled={locked} value={code} onChange={onCode} onPaste={onCodePaste} />
            {[0, 1, 2, 3, 4, 5].map(i => <i key={i} className={!err && !locked && i === code.length && !verifying ? 'cur' : ''}>{code[i] || ''}</i>)}
          </div>
          {err ? <p className="si-err" role="alert">{err}</p> : <p className="si-hint">You are signed in as soon as all 6 numbers are in.</p>}
          {locked
            ? <button type="button" className="si-go" onClick={signInAgain}>Sign in again</button>
            : <div className="si-resend">
                {cool > 0 ? <span>New code in {mmss(cool)}</span> : <button type="button" className="si-link" onClick={resendCode}>Send a new code</button>}
                <button type="button" className="si-link" onClick={useAnother}>Use another account</button>
              </div>}
          {!locked && note ? <p className="si-hint">{note}</p> : null}
        </div>
      );
      if (step === 'forgot') return root(
        <form className="si-col" onSubmit={askForReset}>
          {backBtn(leaveCode)}
          <h1>Forgot password?</h1>
          <p className="si-lead">Type the email address you sign in with. We’ll send a code, and you set a new password with it.</p>
          <div className="si-field">
            <label htmlFor="si-email">Email</label>
            <div className="si-input"><input id="si-email" type="email" autoComplete="email" autoFocus value={resetEmail} onChange={e => { setResetEmail(e.target.value); setErr(''); }} /></div>
          </div>
          <p className="si-hint">If that address signs in here, the code is on its way. This screen says the same thing either way.</p>
          {err && <p className="si-err" role="alert">{err}</p>}
          <button className="si-go" type="submit" disabled={busy || cool > 0}>{busy ? 'Sending…' : cool > 0 ? ('New code in ' + mmss(cool)) : 'Send a code'}</button>
        </form>
      );
      if (step === 'reset') return root(
        <form className="si-col" onSubmit={submitReset}>
          {backBtn(() => { setStep('forgot'); setErr(''); setCode(''); })}
          <h1>Check your email</h1>
          <p className="si-lead">If {resetEmail} has an account, a 6-digit code is on its way. Choose a new password of at least 8 characters.</p>
          <div className="si-field">
            <label htmlFor="si-reset-code">Code</label>
            <div className="si-input"><input id="si-reset-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr(''); }} /></div>
          </div>
          <div className="si-field">
            <label htmlFor="si-newpw">New password</label>
            <div className="si-input">
              <input id="si-newpw" type={showPw ? 'text' : 'password'} autoComplete="new-password" value={newPw} onChange={e => { setNewPw(e.target.value); setErr(''); }} />
              {eye(showPw)}
            </div>
          </div>
          <p className="si-hint">Setting a new password signs out every device on this account. You’ll sign in again with the new one.</p>
          {err && <p className="si-err" role="alert">{err}</p>}
          <button className="si-go" type="submit" disabled={busy || code.length < 6 || newPw.length < 8}>{busy ? 'Setting it…' : 'Set new password'}</button>
        </form>
      );
      const ready = idInput.trim().length > 0 && pw.length > 0 && !busy;
      return root(
        <form className="si-col" onSubmit={phoneSubmit}>
          <div className="si-brand"><Mark w={46} h={32} cut="var(--gray-50)" /><b>Currency Desk</b></div>
          <h1>Sign in</h1>
          <p className="si-lead">Use the staff ID and password your manager gave you.</p>
          {note ? <p className="si-banner" role="status">{note}</p> : null}
          <div className="si-field">
            <div className="si-labrow">
              <label htmlFor="si-id">Staff ID</label>
              {held ? <button type="button" className="si-link" onClick={forgetStaff}>Not you?</button> : null}
            </div>
            <div className="si-input">
              <input id="si-id" name="username" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus={!held} value={idInput} onFocus={keepSignInInView} onChange={e => { setIdInput(e.target.value); setErr(''); setBadPw(false); }} />
            </div>
          </div>
          <div className="si-field">
            <label htmlFor="si-pw">Password</label>
            <div className={'si-input' + (badPw ? ' is-err' : '')}>
              <input id="si-pw" name="password" type={showPw ? 'text' : 'password'} autoComplete="current-password" autoFocus={!!held} value={pw} onFocus={keepSignInInView} onChange={e => { setPw(e.target.value); setErr(''); setBadPw(false); setGaveUp(false); }} />
              {eye(showPw)}
            </div>
            {badPw && <p className="si-err" role="alert">{err}</p>}
          </div>
          {waking && <div className="si-wait" role="status"><span className="si-spin" aria-hidden="true" /><span><b>Signing you in.</b> The first sign-in of the day can take up to a minute while the system wakes up. Please keep this screen open.</span></div>}
          {!badPw && err && <p className="si-err" role="alert">{err}</p>}
          <button className="si-go" type="submit" disabled={!ready}>{busy ? 'Signing in…' : gaveUp ? 'Try again' : 'Sign in'}</button>
          <div className="si-links"><button type="button" className="si-link" onClick={() => { setResetEmail(idInput.indexOf('@') >= 0 ? idInput : ''); setErr(''); setNote(''); setStep('forgot'); }}>Forgot password?</button></div>
          {onSignup ? <p className="si-foot">New shop? <button type="button" onClick={onSignup}>Set up your desk</button></p> : null}
        </form>
      );
    }

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
      {!known && examples.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--si-faint)', marginTop: 10, lineHeight: 1.5 }}>
          The email address you set the desk up with, or the ID whoever runs your desk gave you.
        </div>
      )}
      {!known && examples.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: 'var(--si-faint)' }}>ON THIS DESK</span>
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
        Every session is <b style={{ color: 'var(--si-ink)' }}>on the record</b>.{' '}
        <button type="button" onClick={() => { setResetEmail(idInput.indexOf('@') >= 0 ? idInput : ''); setErr(''); setStep('forgot'); }}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--si-primary)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontSize: 11.5 }}>
          Can't get in?</button>
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
        <div style={{ fontSize: 11.5, color: 'var(--si-faint)', marginTop: 8 }}>
          Forgot it?{' '}
          <button type="button" onClick={() => { setResetEmail(idInput.indexOf('@') >= 0 ? idInput : ''); setErr(''); setNote(''); setStep('forgot'); }}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--si-primary)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontSize: 11.5 }}>
            Send yourself a reset code</button>.
        </div>
        {err && <div style={{ color: 'var(--si-flag)', fontSize: 12, marginTop: 12 }}>{err}</div>}
        <button type="submit" disabled={busy || cool > 0 || pw.length < 4} style={{ ...primaryBtn(!busy && cool === 0 && pw.length >= 4), marginTop: 16 }}>
          {busy ? 'Checking…' : cool > 0 ? 'Another code in ' + cool + 's' : 'Send my code'}</button>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: note ? 'var(--si-primary)' : 'var(--si-mute)', marginTop: 14, fontWeight: note ? 700 : 400 }}>
          {note || "We'll email a fresh code to confirm it's you."}</div>
      </form>));
    }

    // ---- B1 · Can't get in — ask for a reset code ---------------------
    if (step === 'forgot') {
      return shell(card(<form onSubmit={askForReset}>
        <h1 style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-0.01em', margin: '0 0 6px' }}>Let's get you back in.</h1>
        <div style={{ fontSize: 13, color: 'var(--si-mute)', lineHeight: 1.6, marginBottom: 18 }}>
          Type the email address you sign in with and we'll send a code. You'll set a new password with it — no old
          password needed, and nobody to ring.
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--si-mute)', marginBottom: 6 }}>EMAIL ADDRESS</div>
        <input type="email" value={resetEmail} onChange={e => { setResetEmail(e.target.value); setErr(''); }} autoFocus
          placeholder="you@yourshop.com" autoComplete="username"
          style={{ width: '100%', boxSizing: 'border-box', padding: '13px 14px', fontSize: 15, border: '1px solid var(--si-line)', borderRadius: 11, background: 'var(--si-panel)', outline: 'none' }}
          onFocus={e => { e.target.style.borderColor = 'var(--si-primary)'; e.target.style.boxShadow = '0 0 0 3px rgba(29,107,69,0.14)'; }}
          onBlur={e => { e.target.style.borderColor = 'var(--si-line)'; e.target.style.boxShadow = 'none'; }} />
        {/* Says nothing about whether that address has an account — the
            server does not either, and a screen that leaked it would undo
            the point of that. */}
        <div style={{ fontSize: 11.5, color: 'var(--si-faint)', marginTop: 8, lineHeight: 1.5 }}>
          If your desk signs you in with a name rather than an address, whoever runs it can reset you from their side.
        </div>
        {err && <div style={{ color: 'var(--si-flag)', fontSize: 12, marginTop: 12 }}>{err}</div>}
        <button type="submit" disabled={busy || cool > 0} style={{ ...primaryBtn(!busy && cool === 0), marginTop: 16 }}>
          {busy ? 'Sending…' : cool > 0 ? 'Another code in ' + cool + 's' : 'Send me a code'}</button>
        <button type="button" onClick={() => { setStep('id'); setErr(''); }}
          style={{ display: 'block', margin: '12px auto 0', background: 'none', border: 'none', color: 'var(--si-mute)', fontSize: 12, cursor: 'pointer' }}>← Back to sign in</button>
      </form>));
    }

    // ---- B2 · The code, and a new password ----------------------------
    if (step === 'reset') {
      return shell(card(<form onSubmit={submitReset}>
        <div style={{ display: 'grid', placeItems: 'center', marginBottom: 10 }}><MailGlyph /></div>
        <h1 style={{ textAlign: 'center', fontSize: 23, fontWeight: 800, letterSpacing: '-0.01em', margin: '0 0 4px' }}>Check your email</h1>
        <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--si-mute)', lineHeight: 1.6, marginBottom: 18 }}>
          If <b style={{ color: 'var(--si-ink)' }}>{resetEmail}</b> has an account, a 6-digit code is on its way. It's good for 15 minutes.
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--si-mute)', marginBottom: 6 }}>CODE</div>
        <input value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr(''); }} autoFocus
          inputMode="numeric" placeholder="000000" autoComplete="one-time-code"
          style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center', fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: '0.3em',
            padding: '13px 12px', border: '1px solid var(--si-line)', borderRadius: 11, background: 'var(--si-panel)', outline: 'none' }} />
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--si-mute)', margin: '14px 0 6px' }}>NEW PASSWORD</div>
        <div style={{ position: 'relative' }}>
          <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => { setNewPw(e.target.value); setErr(''); }}
            placeholder="At least 8 characters" autoComplete="new-password"
            style={{ width: '100%', boxSizing: 'border-box', padding: '13px 62px 13px 14px', fontSize: 15, border: '1px solid var(--si-line)', borderRadius: 11, background: 'var(--si-panel)', outline: 'none' }} />
          <button type="button" onClick={() => setShowPw(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--si-mute)', background: 'var(--si-soft)', border: 'none', borderRadius: 7, padding: '5px 9px', cursor: 'pointer' }}>{showPw ? 'HIDE' : 'SHOW'}</button>
        </div>
        {/* Said before they press it, not after. Somebody resetting from a
            phone while the till is signed in at the shop should know the
            till is about to be signed out. */}
        <div style={{ fontSize: 11.5, color: 'var(--si-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Setting a new password signs out every device on this account, including this one — you'll sign in again with the new password.
        </div>
        {err && <div style={{ color: 'var(--si-flag)', fontSize: 12, marginTop: 12 }}>{err}</div>}
        <button type="submit" disabled={busy || code.length < 6 || newPw.length < 8}
          style={{ ...primaryBtn(!busy && code.length >= 6 && newPw.length >= 8), marginTop: 16 }}>{busy ? 'Setting it…' : 'Set my new password'}</button>
        <button type="button" onClick={() => { setStep('forgot'); setErr(''); setCode(''); }}
          style={{ display: 'block', margin: '12px auto 0', background: 'none', border: 'none', color: 'var(--si-mute)', fontSize: 12, cursor: 'pointer' }}>
          {cool > 0 ? '← Send it again in ' + cool + 's' : '← Send it again'}</button>
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
      <Keypad value={code} max={6} onDigit={pushDigit} onBack={backDigit}
        leftLabel={cool > 0 ? cool + 's' : 'Resend'} onLeft={cool > 0 ? null : resendCode} verifying={verifying} />
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
