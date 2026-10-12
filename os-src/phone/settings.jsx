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
    ['business', 'Shop details', 'Name, address, phone', 'building', 'logo msb name address phone business profile'],
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
  const bell = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
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

  function PinChanger({ hasPin, onClose, onSaved }) {
    const [step, setStep] = useState(hasPin ? 'current' : 'new');
    const [forgot, setForgot] = useState(false);
    const [digits, setDigits] = useState('');
    const [cur, setCur] = useState('');
    const [nw, setNw] = useState('');
    const [pw, setPw] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [locked, setLocked] = useState(false);
    const [shake, setShake] = useState(false);
    const [retry, setRetry] = useState(null);
    const busyRef = useRef(false);
    const live = useRef(true);
    useEffect(() => () => { live.current = false; }, []);
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
        let payload = {};
        try { payload = await res.json(); } catch (err) { payload = {}; }
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
        if (body.password != null) { setStep('password'); setErr('That’s not your sign-in password.'); }
        else { setStep(hasPin ? 'current' : 'new'); setCur(''); setErr('That PIN isn’t right.'); }
        return;
      }
      if (res.status === 429) {
        setLocked(true);
        setErr('Too many wrong tries. Wait a few minutes.');
        return;
      }
      setErr('That didn’t save. Try again.');
      setRetry({ ...body, pin });
    };

    const proof = () => (forgot ? { password: pw } : (hasPin ? { currentPin: cur } : {}));

    const onDigit = (d) => {
      if (busyRef.current || locked || step === 'password') return;
      const next = (digits + d).replace(/\D/g, '').slice(0, 4);
      setDigits(next);
      setErr('');
      if (next.length < 4) return;
      if (step === 'current') { setCur(next); setDigits(''); setStep('new'); return; }
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
      <FullScreenSheet title={hasPin ? 'Change your PIN' : 'Set your PIN'} onClose={onClose}>
        <PinPad
          step={stepNo}
          steps={steps}
          question={step === 'current' ? 'Enter your current PIN' : step === 'password' ? 'Enter your sign-in password' : step === 'new' ? 'Enter a new PIN' : 'Enter it again'}
          hint={step === 'password' ? 'Your sign-in password proves it’s you. The new PIN is yours alone.' : (step === 'current' ? '4 digits.' : '4 digits. Do not share it.')}
          digits={digits}
          error={err}
          shake={shake}
          busy={busy}
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
    const save = async () => {
      if (a.length < 8) { setMsg('New password needs at least 8 characters.'); return; }
      if (a !== b) { setMsg('The two new entries don’t match.'); return; }
      setBusy(true); setMsg('');
      let res;
      try {
        res = await fetch('/api/auth/change-password', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ currentPassword: cur, newPassword: a }),
        });
      } catch (err) {
        setBusy(false);
        setMsg('No connection. Your password was not changed.');
        return;
      }
      setBusy(false);
      if (res.status === 401) { setMsg('That’s not your sign-in password.'); return; }
      if (!res.ok) { setMsg('That didn’t save. Try again.'); return; }
      onSaved();
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

  function shopFacts(settings, hours) {
    const zone = settings.timezone;
    const name = settings.operatingName || settings.bizName || '';
    const address = [settings.bizAddress, [settings.bizCity, settings.bizRegion, settings.bizPostal].filter(Boolean).join(' '), settings.bizCountry].filter(Boolean).join(', ');
    const hourText = (Array.isArray(hours) ? hours : [])
      .filter((row) => row && String(row.days || '').trim() && String(row.hours || '').trim())
      .map((row) => String(row.days).trim() + ' ' + phoneClocks(String(row.hours).trim(), zone))
      .join(', ');
    const rows = [];
    if (name) rows.push({ label: 'Name', value: name });
    if (address) rows.push({ label: 'Address', value: address });
    if (hourText) rows.push({ label: 'Hours', value: hourText });
    return rows;
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
    return (
      <Phone.Screen app="settings" className="phone-computer">
        <Back label="Settings" onClick={onBack} />
        {rows.length ? (SummaryList ? <SummaryList rows={rows} /> : (
          <div className="phq-kv">
            {rows.map((row) => (
              <div key={row.label}><span>{row.label}</span><b>{row.value}</b></div>
            ))}
          </div>
        )) : null}
        <Phone.EmptyState icon={monitor} title="Change this on a computer" message="Use a computer to change this." />
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

    const staff = (settings.staff && settings.staff[me.name]) || {};
    /* Same test the void gate uses. This screen does not write either
       flag: the shop switch and this person's require PIN are the
       owner's, on a computer. */
    const emp = (settings.employees || []).find((x) => x.name === me.name);
    const voidAsks = settings.pinOnVoid !== false && (!emp || emp.requirePin !== false);
    const writeStaff = (key, value) => setSettings((s) => ({
      ...s,
      staff: { ...(s.staff || {}), [me.name]: { ...((s.staff || {})[me.name] || {}), [key]: value } },
    }));
    const flip = (key, next) => {
      const prev = staff[key];
      try {
        writeStaff(key, next);
        setToast('Saved');
      } catch (err) {
        writeStaff(key, prev);
        setToast('Not saved. Check the connection.');
      }
    };

    const query = q.trim().toLowerCase();
    const hit = (label, keys) => !query || (label + ' ' + (keys || '')).toLowerCase().includes(query);
    const pinValue = mustChange ? 'Pick your own' : hasPin ? 'PIN set' : 'No PIN yet';
    const you = [
      hit('PIN and sign-in', 'pin password security void') && { id: 'pin', icon: 'lock', title: 'PIN and sign-in', value: pinState === 'ready' ? pinValue : '', valueTone: mustChange ? 'warn' : '', onClick: () => setScreen('pin') },
      hit('Notifications', 'alerts compliance summary') && { id: 'notes', icon: bell, title: 'Notifications', onClick: () => setScreen('notes') },
    ].filter(Boolean);
    const openComputer = (id, title) => setComputer({ id, title });
    const shop = canSys ? SHOP.filter((r) => hit(r[1], r[4])).map((r) => ({ id: r[0], icon: r[3], title: r[1], detail: r[2], onClick: () => openComputer(r[0], r[1]) })) : [];
    const apps = canSys ? APPS.filter((r) => hit(r[1], r[4])).map((r) => ({ id: r[0], icon: r[3], title: r[1], detail: r[2], onClick: () => openComputer(r[0], r[1]) })) : [];
    const computerRows = query ? COMPUTER.filter((r) => hit(r[1], r[2])).map((r) => ({ id: r[0], icon: 'info', title: r[1], onClick: () => openComputer(r[0], r[1]) })) : [];
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
      <div>
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
          <ProfileScreen me={me} staff={staff} onBack={() => setScreen('list')} onSave={(email, phone) => {
            try {
              setSettings((s) => ({ ...s, staff: { ...(s.staff || {}), [me.name]: { ...((s.staff || {})[me.name] || {}), email, phone } } }));
              setToast('Saved');
              log && log('My details', 'email and phone');
            } catch (err) {
              setToast('Not saved. Check the connection.');
            }
          }} />
        )}

        {screen === 'notes' && (
          <div>
            <Back label="Settings" onClick={() => setScreen('list')} />
            <h1 className="phone-h1">Notifications</h1>
            <p className="phone-sub">On this phone, for you.</p>
            <section className="phone-list">
              <NavRow icon={bell} title="Compliance alerts" detail="Large cash and possible split deals" switchOn={staff.notifyCompliance !== false} switchLabel="Compliance alerts" onClick={() => flip('notifyCompliance', !(staff.notifyCompliance !== false))} />
              <NavRow icon="mail" title="Daily summary" detail="End of day, volume and earnings" switchOn={!!staff.notifyDaily} switchLabel="Daily summary" onClick={() => flip('notifyDaily', !staff.notifyDaily)} />
            </section>
          </div>
        )}

        {screen === 'pin' && (
          <div className="phone-pin">
            <Back label="Settings" onClick={() => setScreen('list')} />
            <h1 className="phone-h1">PIN and sign-in</h1>
            <p className="phone-sub">Only you can change these.</p>
            <section className="phone-list">
              <NavRow icon={keyIcon} title="Your PIN" detail="Asked when you take a till, switch user or void." badge={mustChange ? 'Pick your own' : hasPin ? 'PIN set' : 'No PIN yet'} badgeTone={mustChange ? 'warn' : hasPin ? 'pos' : 'neutral'} />
            </section>
            <div className="phone-sec">Sign-in</div>
            <section className="phone-list">
              <NavRow icon="lock" title="Password" detail="Signs out other devices" onClick={() => setPwOpen(true)} />
              <NavRow icon="mail" title="Sign-in code" detail="Emailed to you at every sign-in." badge="Always on" badgeTone="neutral" />
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
          <PinChanger hasPin={hasPin} onClose={() => setPinOpen(false)} onSaved={() => {
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

  function ProfileScreen({ me, staff, onBack, onSave }) {
    const [email, setEmail] = useState(staff.email || '');
    const [phone, setPhone] = useState(staff.phone || '');
    return (
      <div>
        <Back label="Settings" onClick={onBack} />
        <h1 className="phone-h1">My details</h1>
        <p className="phone-sub">Your name and role are set by the owner.</p>
        <div className="phone-form">
          <label>Full name<input value={me.name || ''} disabled /></label>
          <label>Role<input value={me.role || ''} disabled /></label>
          <label>Work email<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" /></label>
          <label>Mobile phone<input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" /></label>
          <button type="button" className="phone-btn primary" onClick={() => onSave(email, phone)}>Save</button>
        </div>
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneSettings });
})();
