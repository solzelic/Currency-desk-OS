/* Phone Settings. List first, then one screen per section.
   Desktop Settings is the rail beside this; the stylesheet hides
   that rail under 430px and hides this list above it.

   Shop and app rows open a read-only note. The desktop form does
   not fit a phone, so it is not opened here. Texts, receipts,
   billing, the ticker, and the role matrix are not phone screens:
   search can name the computer ones, and says so. */
(function () {
  const { useState, useEffect, useRef } = React;
  const { Ic, NavRow, ProfileRow, PinPad, FullScreenSheet, Toast } = window.CDOS;

  const SHOP = [
    ['business', 'Shop details', 'Name, address, and hours', 'building', 'logo msb name address hours business profile'],
    ['locations', 'Staff and tills', 'Who works which till', 'users', 'branch till teller station locations'],
    ['rates', 'Rates and fees', 'Your margin and fees', 'percent', 'spread margin fee rate'],
    ['till', 'Cash drawer', 'How the drawer is counted', 'wallet', 'count denomination variance blind drawer'],
    ['clients', 'Clients and ID', 'When to ask for ID', 'id', 'kyc risk id expiry client'],
    ['compliance', 'Compliance rules', 'Country rules and limits', 'shield', 'threshold jurisdiction reporting country'],
    ['ledger', 'Ledger', 'Deal defaults', 'scroll', 'import csv excel duplicate'],
  ];
  const APPS = [
    ['vault', 'Vault', 'Stock floors and reserves', 'building', 'cash floor reserve stock'],
    ['transfers', 'Transfers', 'Reporting line and defaults', 'globe', 'remittance corridor beneficiary'],
    ['cheques', 'Cheques', 'How long a cheque is held', 'receipt', 'cheque check clearing hold'],
  ];
  /* Not drawn as rows. Search still finds them, and says to use a computer.
     Texts and receipts are absent until they are live, so they are not here. */
  const COMPUTER = [
    ['employees', 'Employees', 'staff team seats accounts'],
    ['localization', 'Localization', 'currency timezone date time format'],
    ['billing', 'Billing and plan', 'plan subscription invoice payment'],
    ['payment', 'Payment methods', 'card visa mastercard'],
    ['tagged', 'Tagged rules', 'auto tag follow-up review'],
    ['ticker', 'Ticker tape', 'tape scroll speed flags'],
    ['permissions', 'Role presets', 'roles presets teller handoff permissions matrix'],
  ];

  const initials = (name) => (name || '?').split(/[ .]+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  /* Milliseconds when the keypad may open again, or null when the
     body has no clock. A sentence in `detail` is not a time. */
  /* Milliseconds when the keypad may open again.
     0 means the server named a wait that is already over (0, negative,
     or an end in the past). null means the body has no clock. */
  function lockEndMs(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const secs = payload.retryAfter != null ? payload.retryAfter : payload.secondsLeft;
    if (typeof secs === 'number' && Number.isFinite(secs)) {
      if (secs <= 0) return 0;
      return Date.now() + secs * 1000;
    }
    const iso = typeof payload.lockedUntil === 'string' ? payload.lockedUntil : (typeof payload.until === 'string' ? payload.until : '');
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    if (t <= Date.now()) return 0;
    return t;
  }
  function triesLeft(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
    if (n === 1) return ' 1 try left.';
    return ' ' + n + ' tries left.';
  }
  function lockSentence(left, until, timeZone) {
    const fmt = window.CDOS && window.CDOS.formatPhoneLock;
    if (typeof fmt !== 'function') return '';
    return fmt(left, until, timeZone);
  }
  const OWNER_ONLY = { localization: true, billing: true, permissions: true };
  const keyIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" />
    </svg>
  );

  function Back({ label, onClick }) {
    return (
      <button type="button" className="phone-back" onClick={onClick}>
        <Ic n="chev" s={16} />{label}
      </button>
    );
  }

  function PinChanger({ hasPin, timeZone, onClose, onSaved }) {
    const [step, setStep] = useState(hasPin ? 'current' : 'new');
    const [forgot, setForgot] = useState(false);
    const [digits, setDigits] = useState('');
    const [cur, setCur] = useState('');
    const [nw, setNw] = useState('');
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [locked, setLocked] = useState(false);
    const [lockUntil, setLockUntil] = useState(0);
    const [lockPlain, setLockPlain] = useState(false);
    const [shake, setShake] = useState(false);
    const [retry, setRetry] = useState(null);
    const busyRef = useRef(false);
    const live = useRef(true);
    useEffect(() => () => { live.current = false; }, []);
    /* A lockout counts down only from a time the server sent.
       `retryAfter` is seconds left. `lockedUntil` is the end the
       staff PIN routes already know. 0, a negative, or a past end
       means the keypad is back. No clock at all is the PIN locked
       screen: the heading, one sentence, and Close. The dots and
       the keypad are not on that screen. */
    useEffect(() => {
      if (!lockUntil) return undefined;
      const paint = () => {
        const left = Math.ceil((lockUntil - Date.now()) / 1000);
        const sentence = lockSentence(left, lockUntil, timeZone);
        if (left <= 0) {
          setLockUntil(0);
          setLocked(false);
          setLockPlain(false);
          setErr(sentence || 'The keypad is back.');
          return;
        }
        setErr(sentence);
      };
      paint();
      const id = setInterval(paint, 1000);
      return () => clearInterval(id);
    }, [lockUntil, timeZone]);
    const steps = hasPin ? 3 : 2;
    const stepNo = (step === 'current' || step === 'password') ? 1 : step === 'new' ? (hasPin ? 2 : 1) : (hasPin ? 3 : 2);

    const save = async (pin, body) => {
      if (busyRef.current || locked) return;
      busyRef.current = true;
      setBusy(true);
      setErr('');
      setRetry(null);
      let res;
      try {
        res = await fetch(body.password != null ? '/api/staff/pin/reset' : '/api/staff/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body.password != null ? { pin, password: body.password } : (body.currentPin != null ? { pin, currentPin: body.currentPin } : { pin })),
        });
      } catch (err) {
        busyRef.current = false;
        setBusy(false);
        setErr('No connection. Your PIN was not changed.');
        setRetry({ ...body, pin });
        return;
      }
      busyRef.current = false;
      setBusy(false);
      if (res.ok) { onSaved(); return; }
      if (res.status === 401) {
        const payload = await readPayload(res);
        setDigits('');
        /* A dead session and a wrong PIN are both 401. Saying the PIN
           is wrong when the session has gone would send them to type
           it again. */
        if (payload.error === 'unauthenticated') {
          setLocked(true);
          setStep(hasPin ? 'current' : 'new');
          setCur('');
          setErr('Your session expired. Sign in again. Your PIN was not changed.');
          return;
        }
        if (payload.locked) { applyLock(payload); return; }
        if (body.password != null) { setStep('password'); setErr('That’s not your sign-in password.' + triesLeft(payload.remaining)); }
        else { setStep(hasPin ? 'current' : 'new'); setCur(''); setErr('That PIN isn’t right.' + triesLeft(payload.remaining)); }
        return;
      }
      if (res.status === 429) {
        const payload = await readPayload(res);
        applyLock(payload);
        return;
      }
      setErr('That didn’t save. Try again.');
      setRetry({ ...body, pin });
    };

    const proof = () => (forgot ? { password: pw } : (hasPin ? { currentPin: cur } : {}));

    const applyLock = (payload) => {
      const until = lockEndMs(payload);
      setDigits('');
      if (until === 0) {
        setLockUntil(0);
        setLocked(false);
        setLockPlain(false);
        setErr('The keypad is back.');
        return;
      }
      setLocked(true);
      if (until == null) {
        setLockUntil(0);
        setLockPlain(true);
        setErr('Too many wrong tries. Try again in a few minutes. You can\u2019t switch staff on the till until then.');
        return;
      }
      setLockPlain(false);
      setLockUntil(until);
    };

    const readPayload = async (res) => {
      try { return await res.json(); } catch (err) { return {}; }
    };

    /* The current PIN is checked before a new one is asked. A wrong
       one stays on this step and says how many tries are left. The
       same counter locks the till. */
    const checkCurrent = async (pin) => {
      if (busyRef.current || locked) return;
      busyRef.current = true;
      setBusy(true);
      setErr('');
      let res;
      try {
        res = await fetch('/api/staff/pin/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pin }),
        });
      } catch (err) {
        busyRef.current = false;
        setBusy(false);
        setDigits('');
        setErr('No connection. Your PIN was not checked.');
        return;
      }
      busyRef.current = false;
      setBusy(false);
      const payload = await readPayload(res);
      setDigits('');
      if (res.ok) { setCur(pin); setStep('new'); return; }
      if (payload.error === 'unauthenticated') {
        setLocked(true);
        setCur('');
        setErr('Your session expired. Sign in again. Your PIN was not changed.');
        return;
      }
      if (res.status === 409 && payload.error === 'no_pin') { setStep('new'); return; }
      if (res.status === 429 || payload.locked) { setCur(''); applyLock(payload); return; }
      if (res.status === 401) {
        setCur('');
        setErr('That PIN isn’t right.' + triesLeft(payload.remaining));
        return;
      }
      setErr('That didn’t save. Try again.');
    };

    const onDigit = (d) => {
      if (busyRef.current || locked || step === 'password') return;
      const next = (digits + d).replace(/\D/g, '').slice(0, 4);
      setDigits(next);
      setErr('');
      if (next.length < 4) return;
      if (step === 'current') { setDigits(''); checkCurrent(next); return; }
      if (step === 'new') { setNw(next); setDigits(''); setStep('confirm'); return; }
      if (next !== nw) {
        setShake(true);
        setErr('The PINs don’t match. Try again.');
        setDigits('');
        setNw('');
        setStep('new');
        setTimeout(() => { if (live.current) setShake(false); }, 320);
        return;
      }
      save(next, proof());
    };

    return (
      <FullScreenSheet title={lockPlain ? 'PIN locked' : (hasPin ? 'Change your PIN' : 'Set your PIN')} onClose={onClose}>
        <PinPad
          step={stepNo}
          steps={steps}
          plainLock={lockPlain}
          question={step === 'current' ? 'Enter your current PIN' : step === 'password' ? 'Enter your sign-in password' : step === 'new' ? 'Enter a new PIN' : 'Enter it again'}
          hint={step === 'password' ? 'Your sign-in password proves it’s you. The new PIN is yours alone.' : (step === 'current' ? '4 digits.' : '4 digits. Do not share it.')}
          digits={digits}
          error={err}
          shake={shake}
          busy={busy}
          busyLabel={step === 'current' ? 'Checking...' : 'Saving...'}
          locked={locked}
          passwordMode={step === 'password'}
          password={pw}
          onPassword={(v) => { setPw(v); setErr(''); }}
          onPasswordNext={() => { if (!pw) { setErr('Enter your sign-in password.'); return; } setDigits(''); setStep('new'); }}
          onDigit={onDigit}
          onDelete={() => { setDigits((v) => v.slice(0, -1)); setErr(''); }}
          forgotLabel={step === 'password' ? 'I remember my PIN' : 'I forgot my PIN'}
          onForgot={hasPin && (step === 'current' || step === 'password') ? () => {
            const next = !forgot;
            setForgot(next);
            setStep(next ? 'password' : 'current');
            setErr(''); setDigits(''); setCur(''); setPw('');
          } : null}
          onRetry={retry ? () => save(retry.pin, retry) : null}
          onClose={lockPlain ? onClose : null}
        />
      </FullScreenSheet>
    );
  }

  function PasswordSheet({ onClose, onSaved }) {
    const [cur, setCur] = useState('');
    const [a, setA] = useState('');
    const [b, setB] = useState('');
    const [msg, setMsg] = useState('');
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const save = async () => {
      if (busyRef.current) return;
      if (a.length < 8) { setMsg('New password needs at least 8 characters.'); return; }
      if (a !== b) { setMsg('The two new entries don’t match.'); return; }
      busyRef.current = true;
      setBusy(true);
      setMsg('');
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ currentPassword: cur, newPassword: a }),
        });
        if (res.status === 401) { setMsg('That’s not your sign-in password.'); return; }
        if (!res.ok) { setMsg('That didn’t save. Try again.'); return; }
        onSaved();
      } catch (err) {
        setMsg('No connection. Your password was not changed.');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };
    return (
      <FullScreenSheet title="Password" label="Change your password" onClose={onClose}>
        <div className="phone-form">
          <p className="phone-sub">Changing it signs out your other devices.</p>
          <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
          <label>New password<input type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} /></label>
          <label>New password again<input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} /></label>
          {msg ? <p className="pin-err" role="alert">{msg}</p> : null}
          <button type="button" className="phone-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </FullScreenSheet>
    );
  }

  function phoneClocks(text, timeZone) {
    const fmt = window.CDOS && window.CDOS.formatPhoneTime;
    if (typeof fmt !== 'function') return String(text);
    return String(text).replace(/\d{1,2}:\d{2}\s*(?:am|pm)?/gi, (bit) => fmt(bit, timeZone) || bit);
  }

  /* Day groups are spoken, not dashed: Mon–Fri is "Mon to Fri", and
     the weekend seed is "Sat, Sun and holidays". Each clock is
     formatPhoneTime, then the range between them is "to". */
  function phoneDays(days) {
    const raw = String(days || '').trim();
    if (/^sat\s*[–—-]\s*sun\s*(?:&|and)\s*holidays$/i.test(raw)) return 'Sat, Sun and holidays';
    return raw.replace(/\s*[–—-]\s*/g, ' to ');
  }

  function phoneHours(hours, timeZone) {
    return phoneClocks(String(hours || '').trim(), timeZone).replace(/\s*[–—-]\s*/g, ' to ').trim();
  }

  function shopFacts(settings, hours) {
    const zone = settings.timezone;
    const name = settings.operatingName || settings.bizName || '';
    const address = [settings.bizAddress, [settings.bizCity, settings.bizRegion, settings.bizPostal].filter(Boolean).join(' '), settings.bizCountry].filter(Boolean).join(', ');
    const rows = [];
    if (name) rows.push({ label: 'Name', value: name });
    if (address) rows.push({ label: 'Address', value: address });
    let anyHours = false;
    (Array.isArray(hours) ? hours : []).forEach((row) => {
      const days = phoneDays(row && row.days);
      const span = phoneHours(row && row.hours, zone);
      if (days && span) {
        anyHours = true;
        rows.push({ label: days, value: span, line: true });
      }
    });
    if (!anyHours) rows.push({ label: 'Hours', value: 'Not set', line: true });
    return rows;
  }

  function computerWhy(section) {
    if (section.id === 'business') return 'Shop details are edited on a computer so nothing is changed by accident.';
    return 'These are edited on a computer so nothing is changed by accident.';
  }

  function ComputerNote({ section, settings, hours, onBack }) {
    const Phone = window.CDOS.Phone;
    const SummaryList = window.CDOS.SummaryList;
    const rows = section.id === 'business' ? shopFacts(settings, hours) : [];
    const monitor = (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    );
    const lined = rows.some((row) => row.line);
    return (
      <Phone.Screen app="settings" className="phone-computer">
        <Back label="Settings" onClick={onBack} />
        <Phone.Title title={section.title} />
        {rows.length ? (SummaryList && !lined ? <SummaryList rows={rows} /> : (
          <div className="phq-kv">
            {rows.map((row) => (
              <div key={row.label} className={row.line ? 'is-line' : ''}><span>{row.label}</span><b>{row.value}</b></div>
            ))}
          </div>
        )) : null}
        <Phone.EmptyState icon={monitor} title="Change this on a computer" message={computerWhy(section)} />
      </Phone.Screen>
    );
  }

  function PhoneSettings({ canSys, me, settings, setSettings, shopName, tillOpen, onLeave, onSignOut, log, hours }) {
    const [screen, setScreen] = useState('list');
    const [q, setQ] = useState('');
    const [pinState, setPinState] = useState('loading');
    const [hasPin, setHasPin] = useState(false);
    const [mustChange, setMustChange] = useState(false);
    const [slow, setSlow] = useState(false);
    const [pinOpen, setPinOpen] = useState(false);
    const [pwOpen, setPwOpen] = useState(false);
    const [signOut, setSignOut] = useState(false);
    const [computer, setComputer] = useState(null);
    const [toast, setToast] = useState('');
    const [reload, setReload] = useState(0);
    const [signInCode, setSignInCode] = useState(false);
    const [signInId, setSignInId] = useState('');
    const [contactEmail, setContactEmail] = useState('');
    const [mobilePhone, setMobilePhone] = useState('');
    const screenRef = useRef(screen);
    screenRef.current = screen;
    const drafts = useRef({ contactEmail: null, mobilePhone: null });

    useEffect(() => {
      let live = true;
      fetch('/api/auth/me', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!live || !body || !body.user) return;
          setSignInId(body.user.id || '');
          setSignInCode(!!body.user.signInCode);
          setContactEmail(body.user.contactEmail || '');
          setMobilePhone(body.user.mobilePhone || '');
        })
        .catch(() => {});
      return () => { live = false; };
    }, []);

    useEffect(() => {
      let live = true;
      setPinState('loading');
      setSlow(false);
      const slowTimer = setTimeout(() => { if (live) setSlow(true); }, 3000);
      fetch('/api/staff/pin', { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error('Could not load settings. (' + r.status + ')'); return r.json(); })
        .then((body) => {
          if (!live) return;
          setHasPin(!!body.hasPin);
          setMustChange(!!body.mustChange);
          setPinState('ready');
        })
        .catch(() => { if (live) setPinState('error'); });
      return () => { live = false; clearTimeout(slowTimer); };
    }, [reload]);

    /* Same test the void gate uses. This screen does not write either
       flag: the shop switch and this person's require PIN are the
       owner's, on a computer. */
    const emp = (settings.employees || []).find((x) => x.name === me.name);
    const voidAsks = settings.pinOnVoid !== false && (!emp || emp.requirePin !== false);
    /* One field. The request lives on this screen, so leaving My details
       within a second does not cancel it. "Saved" waits for the server. */
    const saveField = async (field, value) => {
      const body = {};
      body[field] = value;
      let res;
      try {
        res = await fetch('/api/auth/contact', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
      } catch (err) {
        drafts.current[field] = value;
        const detail = 'No connection. That was not saved.';
        if (screenRef.current !== 'profile') setToast(detail);
        throw new Error(detail);
      }
      if (!res.ok) {
        drafts.current[field] = value;
        let detail = 'That didn’t save.';
        try {
          const payload = await res.json();
          if (payload && typeof payload.detail === 'string' && payload.detail) detail = payload.detail;
        } catch (err) { detail = 'That didn’t save.'; }
        if (screenRef.current !== 'profile') setToast(detail);
        throw new Error(detail);
      }
      drafts.current[field] = null;
      if (field === 'contactEmail') setContactEmail(value);
      else setMobilePhone(value);
      setToast('Saved');
      log && log('My details', field);
    };

    const query = q.trim().toLowerCase();
    const hit = (label, keys) => !query || (label + ' ' + (keys || '')).toLowerCase().includes(query);
    const pinValue = mustChange ? 'Pick your own' : hasPin ? 'PIN set' : 'No PIN yet';
    const you = [
      hit('PIN and sign-in', 'pin password security void') && { id: 'pin', icon: 'lock', title: 'PIN and sign-in', value: pinState === 'ready' ? pinValue : '', valueTone: mustChange ? 'warn' : '', onClick: () => setScreen('pin') },
    ].filter(Boolean);
    const openComputer = (id, title) => setComputer({ id, title });
    const shop = canSys ? SHOP.filter((r) => hit(r[1], r[4])).map((r) => ({ id: r[0], icon: r[3], title: r[1], detail: r[2], onClick: () => openComputer(r[0], r[1]) })) : [];
    const apps = canSys ? APPS.filter((r) => hit(r[1], r[4])).map((r) => ({ id: r[0], icon: r[3], title: r[1], detail: r[2], onClick: () => openComputer(r[0], r[1]) })) : [];
    const computerRows = query ? COMPUTER.filter((r) => {
      if (OWNER_ONLY[r[0]] && me.role !== 'Owner') return false;
      return hit(r[1], r[2]);
    }).map((r) => ({ id: r[0], icon: 'info', title: r[1], onClick: () => openComputer(r[0], r[1]) })) : [];
    const showOut = hit('Sign out', 'log out leave');
    const showMe = hit(me.name || '', 'profile my details account ' + (me.role || ''));
    const nothing = query && !showMe && !you.length && !shop.length && !apps.length && !computerRows.length && !showOut;

    const group = (label, rows) => rows.length ? (
      <div key={label}>
        <div className="phone-sec">{label}</div>
        <section className="phone-list">{rows.map((r) => <NavRow key={r.id} rowId={r.id} {...r} />)}</section>
      </div>
    ) : null;

    return (
      <div className="phone-settings-body">
        {screen === 'list' && computer && (
          <ComputerNote section={computer} settings={settings} hours={hours} onBack={() => setComputer(null)} />
        )}

        {screen === 'list' && !computer && (
          <div>
            <Back label="More" onClick={onLeave} />
            <h1 className="phone-h1">Settings</h1>
            <label className="phone-search">
              <Ic n="search" s={20} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
            </label>
            {pinState === 'loading' && slow ? <p className="phone-banner info" role="status">Waking the server</p> : null}
            {pinState === 'error' && (
              <div className="phone-banner err" role="alert">
                <b>Could not load settings.</b>
                <button type="button" className="phone-text" onClick={() => setReload((n) => n + 1)}>Try again</button>
              </div>
            )}
            {pinState === 'loading' ? (
              <div className="phone-list" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => <div key={i} className="phone-sk" />)}
              </div>
            ) : (
              <div>
                {showMe ? <section className="phone-list"><ProfileRow initials={initials(me.name)} name={me.name} detail={(me.role || 'Staff') + ' · My details'} onClick={() => setScreen('profile')} /></section> : null}
                {group('You', you)}
                {group('This shop. Change on a computer', shop)}
                {group('Other apps. Change on a computer', apps)}
                {group('On a computer', computerRows)}
                {!canSys && !query ? <p className="phone-note">Shop settings are managed by the owner.</p> : null}
                {nothing ? (
                  <div className="phone-empty">
                    <p>Nothing matches “{q.trim()}”.</p>
                    <button type="button" className="phone-btn secondary" onClick={() => setQ('')}>Clear</button>
                  </div>
                ) : null}
                {showOut ? (
                  <div>
                    <div className="phone-sec">&nbsp;</div>
                    <section className="phone-list">
                      <NavRow rowId="signout" icon="logout" title="Sign out" detail="Asks you to confirm" danger onClick={() => setSignOut(true)} />
                    </section>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}

        {screen === 'profile' && (
          <ProfileScreen
            me={me}
            signInId={signInId}
            contactEmail={drafts.current.contactEmail != null ? drafts.current.contactEmail : contactEmail}
            mobilePhone={drafts.current.mobilePhone != null ? drafts.current.mobilePhone : mobilePhone}
            onBack={() => setScreen('list')}
            onSaveField={saveField}
          />
        )}

        {screen === 'pin' && (
          <div className="phone-pin">
            <Back label="Settings" onClick={() => setScreen('list')} />
            <h1 className="phone-h1">PIN and sign-in</h1>
            <p className="phone-sub">Only you can change these.</p>
            <section className="phone-list">
              <NavRow icon={keyIcon} title="Your PIN" detail="Asked when you take a till, switch user or void." badge={mustChange ? 'Pick your own' : hasPin ? 'PIN set' : 'No PIN yet'} badgeTone={mustChange ? 'warn' : hasPin ? 'pos' : 'neutral'} onClick={() => setPinOpen(true)} />
            </section>
            <div className="phone-sec">Sign-in</div>
            <section className="phone-list">
              <NavRow icon="lock" title="Password" detail="Signs out other devices" onClick={() => setPwOpen(true)} />
              {signInCode ? <NavRow icon="mail" title="Sign-in code" detail="Emailed to you at every sign-in." badge="Always on" badgeTone="neutral" /> : null}
            </section>
            <div className="phone-sec">Voids</div>
            <section className="phone-list">
              <NavRow icon="shield" title="PIN before a void" detail={voidAsks ? 'A void asks for your PIN. The owner sets this.' : 'A void does not ask for your PIN. The owner sets this.'} />
            </section>
            {mustChange ? <p className="phone-banner warn">Your PIN was set by the owner. Pick your own.</p> : null}
            <div className="phone-cta">
              <button type="button" className="phone-btn primary" onClick={() => setPinOpen(true)}>
                <Ic n="lock" s={20} c="#fff" />{hasPin ? 'Change my PIN' : 'Set my PIN'}
              </button>
            </div>
          </div>
        )}

        {pinOpen && (
          <PinChanger hasPin={hasPin} timeZone={settings.timezone} onClose={() => setPinOpen(false)} onSaved={() => {
            setHasPin(true); setMustChange(false); setPinOpen(false); setToast('PIN changed');
            log && log('Transaction PIN', 'PIN set');
          }} />
        )}
        {pwOpen && <PasswordSheet onClose={() => setPwOpen(false)} onSaved={() => { setPwOpen(false); setToast('Password changed'); log && log('Password changed', 'sign-in password'); }} />}
        {signOut && (
          <FullScreenSheet title="Sign out" label={'Sign out of ' + (shopName || 'this shop') + '?'} onClose={() => setSignOut(false)}>
            <div className="phone-form">
              <h3 className="phone-ask">Sign out of {shopName || 'this shop'}?</h3>
              {tillOpen ? <p className="phone-banner warn">Your till stays open. Hand it off or close it first.</p> : null}
              <button type="button" className="phone-btn danger" onClick={() => { if (onSignOut) onSignOut(); }}>Sign out</button>
              <button type="button" className="phone-btn secondary" onClick={() => setSignOut(false)}>Stay signed in</button>
            </div>
          </FullScreenSheet>
        )}
        <Toast text={toast} onDone={() => setToast('')} />
      </div>
    );
  }

  function ProfileScreen({ me, signInId, contactEmail, mobilePhone, onBack, onSaveField }) {
    const [email, setEmail] = useState(contactEmail || '');
    const [phone, setPhone] = useState(mobilePhone || '');
    const [emailErr, setEmailErr] = useState('');
    const [phoneErr, setPhoneErr] = useState('');
    const [emailBusy, setEmailBusy] = useState(false);
    const [phoneBusy, setPhoneBusy] = useState(false);
    const emailBusyRef = useRef(false);
    const phoneBusyRef = useRef(false);
    const emailRef = useRef(email);
    const phoneRef = useRef(phone);
    const emailDirty = useRef(false);
    const phoneDirty = useRef(false);
    emailRef.current = email;
    phoneRef.current = phone;
    useEffect(() => { if (!emailDirty.current) setEmail(contactEmail || ''); }, [contactEmail]);
    useEffect(() => { if (!phoneDirty.current) setPhone(mobilePhone || ''); }, [mobilePhone]);

    const saveOne = async (field) => {
      const isEmail = field === 'contactEmail';
      const ref = isEmail ? emailBusyRef : phoneBusyRef;
      if (ref.current) return;
      const value = isEmail ? emailRef.current : phoneRef.current;
      const saved = isEmail ? (contactEmail || '') : (mobilePhone || '');
      if (value === saved) return;
      ref.current = true;
      (isEmail ? setEmailBusy : setPhoneBusy)(true);
      (isEmail ? setEmailErr : setPhoneErr)('');
      try {
        await onSaveField(field, value);
        (isEmail ? emailDirty : phoneDirty).current = false;
      } catch (err) {
        (isEmail ? setEmailErr : setPhoneErr)(err && err.message ? err.message : 'That didn’t save.');
      } finally {
        ref.current = false;
        (isEmail ? setEmailBusy : setPhoneBusy)(false);
      }
    };

    const leave = () => {
      if (emailRef.current !== (contactEmail || '') && !emailBusyRef.current) onSaveField('contactEmail', emailRef.current).catch(() => {});
      if (phoneRef.current !== (mobilePhone || '') && !phoneBusyRef.current) onSaveField('mobilePhone', phoneRef.current).catch(() => {});
      onBack();
    };

    return (
      <div>
        <Back label="Settings" onClick={leave} />
        <h1 className="phone-h1">My details</h1>
        <p className="phone-sub">Your name and role are set by the owner. You sign in as the name below.</p>
        <div className="phone-form">
          <label>Full name<input value={me.name || ''} disabled /></label>
          <label>Role<input value={me.role || ''} disabled /></label>
          <label>Sign-in<input value={signInId || ''} disabled /></label>
          <label>Contact email
            <input value={email} disabled={emailBusy} onChange={(e) => { emailDirty.current = true; setEmail(e.target.value); setEmailErr(''); }} autoComplete="email" inputMode="email" />
          </label>
          <p className="phone-note">Not the name you sign in with.</p>
          {emailErr ? <p className="pin-err" role="alert">{emailErr}</p> : null}
          <button type="button" className="phone-btn primary" disabled={emailBusy} onClick={() => saveOne('contactEmail')}>{emailBusy ? 'Saving...' : 'Save contact email'}</button>
          <label>Mobile phone
            <input value={phone} disabled={phoneBusy} onChange={(e) => { phoneDirty.current = true; setPhone(e.target.value); setPhoneErr(''); }} autoComplete="tel" inputMode="tel" />
          </label>
          {phoneErr ? <p className="pin-err" role="alert">{phoneErr}</p> : null}
          <button type="button" className="phone-btn primary" disabled={phoneBusy} onClick={() => saveOne('mobilePhone')}>{phoneBusy ? 'Saving...' : 'Save mobile phone'}</button>
        </div>
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneSettings });
})();
