/* Built from source by scripts/build-os.mjs — do not edit.
   Edit admin.html instead, then run: npm run build:os */

const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;
const MONO = "var(--m)";

// ---- helpers ----
const api = async (path, opts) => {
  const init = Object.assign({
    credentials: 'same-origin'
  }, opts || {});
  init.headers = Object.assign({
    'content-type': 'application/json'
  }, opts && opts.headers || {});
  const r = await fetch(path, init);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw {
    status: r.status,
    body
  };
  return body;
};
const initialsOf = n => (n || '?').split(/[ .@]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
const hueOf = s => {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
const fmtDay = s => {
  try {
    return new Date(s).toLocaleDateString('en-CA', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch (e) {
    return s;
  }
};
const fmtWhen = s => {
  try {
    return new Date(s).toLocaleString('en-CA', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (e) {
    return s;
  }
};
const PLAN_TONE = {
  trial: 'amber',
  basic: 'mute',
  pro: 'green',
  premium: 'purple'
};
const STATUS_TONE = {
  active: 'green',
  trial: 'amber',
  suspended: 'red'
};
const toneColor = t => ({
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  purple: 'var(--purple)',
  blue: 'var(--blue)',
  mute: 'var(--mute)'
})[t] || 'var(--mute)';
function Mark({
  w = 26
}) {
  const h = w * 0.7;
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 200 140",
    width: w,
    height: h,
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("mask", {
    id: "cdm"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "200",
    height: "140",
    fill: "#fff"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "60",
    y: "64.5",
    width: "92",
    height: "11",
    fill: "#000"
  })), /*#__PURE__*/React.createElement("g", {
    mask: "url(#cdm)"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "60",
    cy: "70",
    r: "48",
    fill: "#fff"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M116,22 H136 A48,48 0 0 1 136,118 H116 Z",
    fill: "#fff"
  })), /*#__PURE__*/React.createElement("circle", {
    cx: "112",
    cy: "70",
    r: "6.5",
    fill: "var(--green)"
  }));
}
function Avatar({
  name,
  size = 26
}) {
  const hue = hueOf(name);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      flex: 'none',
      display: 'grid',
      placeItems: 'center',
      fontSize: size * 0.4,
      fontWeight: 700,
      color: '#fff',
      background: 'hsl(' + hue + ',42%,42%)'
    }
  }, initialsOf(name));
}
function Pill({
  tone,
  dot,
  children
}) {
  const c = toneColor(tone);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11.5,
      fontWeight: 600,
      color: c,
      background: 'color-mix(in srgb,' + c + ' 15%, transparent)',
      border: '1px solid color-mix(in srgb,' + c + ' 30%, transparent)',
      borderRadius: 7,
      padding: '3px 9px',
      whiteSpace: 'nowrap',
      textTransform: 'capitalize'
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: c
    }
  }), children);
}
const dot = c => /*#__PURE__*/React.createElement("span", {
  style: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: c,
    flex: 'none'
  }
});

// ===================== LOGIN =====================
function Login({
  onIn
}) {
  const [step, setStep] = useState('pw'); // pw | code
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [masked, setMasked] = useState('');
  const submitPw = async e => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await api('/api/auth/login/start', {
        method: 'POST',
        body: JSON.stringify({
          staffId: email.trim().toLowerCase(),
          password: pw
        })
      });
      if (d.needsCode) {
        setMasked(d.maskedEmail || '');
        setStep('code');
        setBusy(false);
      } else {
        await afterAuth();
      }
    } catch (x) {
      setBusy(false);
      setErr(x.status === 401 ? 'Wrong email or password.' : x.status === 403 ? 'That desk is suspended.' : 'Sign-in error — try again.');
    }
  };
  const submitCode = async e => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api('/api/auth/login/verify', {
        method: 'POST',
        body: JSON.stringify({
          staffId: email.trim().toLowerCase(),
          code: code.trim()
        })
      });
      await afterAuth();
    } catch (x) {
      setBusy(false);
      setErr(x.status === 401 ? 'That code isn’t right.' : 'Verification error — try again.');
    }
  };
  const afterAuth = async () => {
    try {
      const me = await api('/api/admin/me');
      if (me.isAdmin) {
        onIn();
        return;
      }
      setBusy(false);
      setErr('This account isn’t a platform admin.');
    } catch (x) {
      setBusy(false);
      setErr('Signed in, but not authorized here.');
    }
  };
  const inSty = {
    width: '100%',
    padding: '11px 13px',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    color: 'var(--text)',
    fontSize: 14,
    outline: 'none'
  };
  const btn = {
    width: '100%',
    padding: '11px',
    background: 'var(--text)',
    color: '#111',
    border: 'none',
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13.5,
    cursor: 'pointer',
    marginTop: 4
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 380,
      maxWidth: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      justifyContent: 'center',
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    w: 30
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 800,
      fontSize: 20
    }
  }, "CurrencyDesk"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 9,
      letterSpacing: '0.16em',
      color: 'var(--faint)',
      border: '1px solid var(--line)',
      borderRadius: 6,
      padding: '3px 7px'
    }
  }, "CONTROL")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 16,
      padding: '26px 26px'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 18,
      fontWeight: 800,
      margin: '0 0 4px'
    }
  }, step === 'pw' ? 'Sign in' : 'Check your email'), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: 'var(--mute)',
      margin: '0 0 18px'
    }
  }, step === 'pw' ? 'Platform admin access only.' : 'We sent a 6-digit code to ' + masked + '.'), step === 'pw' ? /*#__PURE__*/React.createElement("form", {
    onSubmit: submitPw,
    style: {
      display: 'grid',
      gap: 11
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: inSty,
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    placeholder: "you@currencydeskos.com",
    autoFocus: true,
    autoComplete: "username"
  }), /*#__PURE__*/React.createElement("input", {
    style: inSty,
    type: "password",
    value: pw,
    onChange: e => setPw(e.target.value),
    placeholder: "Password",
    autoComplete: "current-password"
  }), err && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      fontSize: 12.5
    }
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...btn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy
  }, busy ? 'Checking…' : 'Continue')) : /*#__PURE__*/React.createElement("form", {
    onSubmit: submitCode,
    style: {
      display: 'grid',
      gap: 11
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...inSty,
      textAlign: 'center',
      fontFamily: MONO,
      fontSize: 20,
      letterSpacing: '0.3em'
    },
    value: code,
    onChange: e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6)),
    placeholder: "000000",
    inputMode: "numeric",
    autoFocus: true
  }), err && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      fontSize: 12.5
    }
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...btn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy
  }, busy ? 'Verifying…' : 'Verify & enter'), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setStep('pw');
      setCode('');
      setErr('');
    },
    style: {
      background: 'none',
      border: 'none',
      color: 'var(--mute)',
      fontSize: 12.5,
      cursor: 'pointer'
    }
  }, "\u2190 Back")))));
}

// ===================== SIDEBAR =====================
function Cog({
  s = 15
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  }));
}

/* The nav is the PAGES table and nothing else. Counts are the numbers that
   should make you click — things sitting on somebody — not totals for
   their own sake, so a page with nothing waiting shows no badge at all.

   The desk filters used to live down here, which meant Billing and
   Settings both had a "Status: Active / Trial / Suspended" list attached
   to them that did nothing. Filters belong to the list they filter. */
function Sidebar({
  counts,
  tab,
  health,
  onSettings
}) {
  const navItem = p => {
    const n = p.count ? counts[p.count] : null;
    const on = tab === p.id;
    return /*#__PURE__*/React.createElement("button", {
      key: p.id,
      onClick: () => goto('#/' + p.id),
      title: p.blurb,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        textAlign: 'left',
        padding: '9px 11px',
        borderRadius: 9,
        border: 'none',
        cursor: 'pointer',
        background: on ? 'var(--hover)' : 'transparent',
        color: on ? 'var(--text)' : 'var(--mute)',
        fontSize: 14,
        fontWeight: on ? 600 : 500
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }, p.label), n ? p.quiet ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: MONO,
        fontSize: 11.5,
        color: 'var(--faint)'
      }
    }, n) : /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 700,
        color: '#111',
        background: 'var(--amber)',
        borderRadius: 20,
        padding: '1px 7px'
      }
    }, n) : null);
  };
  const tone = health && health.state !== 'ok' ? health.state === 'down' ? 'var(--red)' : 'var(--amber)' : 'var(--green)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 232,
      flex: 'none',
      background: 'var(--sidebar)',
      borderRight: '1px solid var(--line)',
      height: '100vh',
      overflow: 'auto',
      padding: '18px 12px',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      padding: '4px 8px 18px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 9,
      background: '#1c1c20',
      display: 'grid',
      placeItems: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    w: 20
  })), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 700,
      fontSize: 14.5
    }
  }, "CurrencyDesk"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12,
      color: 'var(--mute)'
    }
  }, "Platform control"))), PAGES.map(navItem), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 20
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => goto('#/overview'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      width: '100%',
      textAlign: 'left',
      padding: '8px 11px',
      borderRadius: 9,
      border: 'none',
      background: 'transparent',
      color: 'var(--mute)',
      fontSize: 12.5,
      cursor: 'pointer'
    }
  }, dot(tone), /*#__PURE__*/React.createElement("span", null, !health ? 'Checking…' : health.state === 'ok' ? 'All systems fine' : health.state === 'down' ? 'Something is down' : 'Needs a look')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 4,
      borderTop: '1px solid var(--line2)',
      paddingTop: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onSettings,
    title: "Platform settings",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      flex: 1,
      textAlign: 'left',
      padding: '8px 11px',
      borderRadius: 9,
      border: 'none',
      cursor: 'pointer',
      background: tab === 'settings' ? 'var(--hover)' : 'transparent',
      color: tab === 'settings' ? 'var(--text)' : 'var(--mute)',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement(Cog, null), " Settings"), /*#__PURE__*/React.createElement("a", {
    href: "/",
    title: "Back to the OS",
    style: {
      padding: '8px 10px',
      color: 'var(--faint)',
      fontSize: 12.5,
      textDecoration: 'none'
    }
  }, "\u21A9")));
}

// ===================== STAT ROW =====================
function StatRow({
  ov
}) {
  if (!ov) return null;
  const tiles = [{
    k: 'Desks',
    v: ov.totals.desks,
    c: 'var(--text)'
  }, {
    k: 'Active',
    v: ov.byStatus.active,
    c: 'var(--green)'
  }, {
    k: 'On trial',
    v: ov.byStatus.trial,
    c: 'var(--amber)'
  }, {
    k: 'Suspended',
    v: ov.byStatus.suspended,
    c: 'var(--red)'
  }, {
    k: 'New · 7 days',
    v: ov.totals.recent7,
    c: 'var(--blue)'
  }, {
    k: 'People',
    v: ov.totals.people,
    c: 'var(--purple)'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
      gap: 10,
      marginBottom: 18
    }
  }, tiles.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.k,
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 12,
      padding: '13px 15px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: '0.08em',
      color: 'var(--mute)',
      textTransform: 'uppercase',
      marginBottom: 5
    }
  }, t.k), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 25,
      fontWeight: 800,
      color: t.c,
      lineHeight: 1
    }
  }, t.v))));
}

// ===================== OVERVIEW =====================
/* The page you open first, and the page you open when somebody says "it's
   not working".

   Ordered by what it is for: what is sitting on you, then whether anything
   is broken, then how the business is doing. Numbers last on purpose — a
   dashboard that leads with a revenue tile is a dashboard nobody opens on
   a Tuesday, because there is nothing to DO with it. */
const HEALTH_TONE = {
  ok: 'green',
  warn: 'amber',
  down: 'red',
  off: 'mute'
};
const HEALTH_WORD = {
  ok: 'Fine',
  warn: 'Look',
  down: 'Down',
  off: 'Not set up'
};
function OverviewPage({
  ov,
  health,
  counts
}) {
  const f = ov && ov.funnel || {};
  const [bill, setBill] = useState(null);
  useEffect(() => {
    api('/api/admin/billing').then(setBill).catch(() => setBill(null));
  }, []);

  /* Only things a person can act on, and only when there are any. An
     empty "needs you" list is the good outcome and should look like it,
     not like a card that failed to load. */
  const todo = [];
  if (f.waiting) todo.push({
    what: `${f.waiting} application${f.waiting === 1 ? '' : 's'} in review`,
    go: '#/applications',
    cta: 'Work the queue'
  });
  if (f.unread) todo.push({
    what: `${f.unread} unanswered message${f.unread === 1 ? '' : 's'}`,
    go: '#/inbox',
    cta: 'Read them'
  });
  if (bill && bill.failedCount) todo.push({
    what: `${bill.failedCount} failed payment${bill.failedCount === 1 ? '' : 's'}`,
    go: '#/billing',
    cta: 'Chase them'
  });
  for (const c of health ? health.checks : []) {
    if (c.state === 'down') todo.push({
      what: c.detail,
      go: c.href || '#/overview',
      cta: 'Fix'
    });
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: todo.length ? 'var(--card)' : 'transparent',
      border: '1px solid ' + (todo.length ? 'var(--line)' : 'var(--line2)'),
      borderRadius: 14,
      padding: todo.length ? 6 : 18
    }
  }, todo.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--mute)',
      fontSize: 13.5
    }
  }, "Nothing is waiting on you. Applications are answered, messages are read, and every check is green."), todo.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '11px 12px',
      borderTop: i ? '1px solid var(--line2)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 13.5
    }
  }, t.what), /*#__PURE__*/React.createElement("button", {
    onClick: () => goto(t.go),
    style: {
      padding: '6px 12px',
      borderRadius: 8,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--text)',
      fontSize: 12.5,
      fontWeight: 600,
      cursor: 'pointer'
    }
  }, t.cta)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1.3fr) minmax(280px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Is anything broken"
  }, !health && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--mute)',
      fontFamily: MONO,
      fontSize: 12
    }
  }, "Checking\u2026"), health && health.checks.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      padding: '10px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 92,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: HEALTH_TONE[c.state],
    dot: true
  }, HEALTH_WORD[c.state])), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 600,
      fontSize: 13
    }
  }, c.title), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.5,
      marginTop: 2
    }
  }, c.detail), c.fix && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12,
      color: 'var(--faint)',
      marginTop: 3
    }
  }, c.fix)), c.href && c.state !== 'ok' && /*#__PURE__*/React.createElement("button", {
    onClick: () => goto(c.href),
    style: {
      padding: '4px 9px',
      borderRadius: 7,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--mute)',
      fontSize: 11.5,
      cursor: 'pointer',
      flex: 'none'
    }
  }, "Open")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "The business"
  }, kv('Desks', counts.desks), kv('Paying', counts.active), kv('On trial', counts.trial), kv('Suspended', counts.suspended || '0'), kv('MRR', bill ? bill.connected ? '$' + K((bill.mrrCents || 0) / 100) : 'Stripe not connected' : '…')), /*#__PURE__*/React.createElement(Card, {
    title: "The funnel"
  }, kv('Applications', f.applications), kv('In review', f.byStatus ? f.byStatus.reviewing : null), kv('On hold', f.byStatus ? f.byStatus.hold : null), kv('Invited', f.byStatus ? f.byStatus.invited : null), kv('Open desks', f.byStatus ? f.byStatus.accepted : null)))));
}

// ===================== EMAILS =====================
/* What CurrencyDesk says to people, and whether it is actually saying it.

   This page exists because the emails were written, worked, and were
   invisible: no way to see what goes out, what fires it, or that sending
   had quietly fallen back to writing to a log file. That last one is the
   dangerous one at forty invitations. */
/* Put one in your own inbox.

   The list below renders every template, which answers "is the markup
   right" and not "what does this look like in Gmail on a phone". Those are
   different questions, and only the second catches what actually goes
   wrong — Outlook renders through Word, Gmail clips a long message, a
   dark-mode client inverts a cream background.

   Addresses are typed, never picked off a customer record, and the server
   turns away anybody who is actually in the system: sample data carries a
   made-up reference and a link that opens nothing, and an applicant
   receiving "You're in" out of the blue is a phone call you cannot take
   back. */
function SampleBox({
  delivery,
  template,
  label
}) {
  const [to, setTo] = useState(() => {
    try {
      return localStorage.getItem('cd_sample_to') || '';
    } catch (e) {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const addresses = to.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const ok = addresses.length > 0 && addresses.every(a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  const send = async () => {
    setBusy(true);
    setFlash(null);
    try {
      localStorage.setItem('cd_sample_to', to);
    } catch (e) {}
    try {
      const r = await api('/api/admin/comms/sample', {
        method: 'POST',
        body: JSON.stringify({
          to: addresses,
          template: template || undefined
        })
      });
      const n = r.sent.length;
      const bad = r.sent.filter(x => x.email === 'failed').length;
      setFlash({
        tone: bad ? 'red' : r.sent.some(x => x.email === 'simulated') ? 'amber' : 'green',
        text: bad ? bad + ' of ' + n + ' did not send.' : r.sent.some(x => x.email === 'simulated') ? n + ' written to the server log — email is not switched on, so nothing arrived.' : n + ' sent. Check ' + addresses.join(', ') + '.'
      });
    } catch (x) {
      setFlash({
        tone: 'red',
        text: x.body && x.body.detail || 'Could not send those.'
      });
    }
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: to,
    onChange: e => setTo(e.target.value),
    placeholder: "you@gmail.com, you@outlook.com",
    style: {
      flex: 1,
      minWidth: 220,
      padding: '9px 12px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      color: 'var(--text)',
      fontSize: 13,
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("button", {
    disabled: busy || !ok,
    onClick: send,
    style: {
      padding: '9px 15px',
      borderRadius: 9,
      border: 'none',
      fontWeight: 700,
      fontSize: 13,
      background: ok ? 'var(--text)' : 'var(--line)',
      color: ok ? '#111' : 'var(--faint)',
      cursor: busy || !ok ? 'default' : 'pointer'
    }
  }, busy ? 'Sending…' : label || 'Send me all of them')), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      marginTop: 7,
      lineHeight: 1.5
    }
  }, "Two or three of your own addresses, comma separated \u2014 a Gmail, an Outlook and an Apple Mail break different things.", !delivery?.live && ' Email is not switched on yet, so these go to the server log.'), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: '9px 12px',
      borderRadius: 9,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,' + toneColor(flash.tone) + ' 12%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(flash.tone) + ' 30%,transparent)'
    }
  }, flash.text));
}
function CommsPage() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api('/api/admin/comms').then(setD).catch(() => setD({
      error: true
    }));
  }, []);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  if (d.error) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--red)'
    }
  }, "Could not load this.");
  const AUD = {
    applicant: 'Applicant',
    operator: 'Desk owner',
    staff: 'Their staff',
    platform: 'Us'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '13px 16px',
      borderRadius: 12,
      fontSize: 13,
      lineHeight: 1.6,
      background: 'color-mix(in srgb,' + toneColor(d.delivery.live ? 'green' : 'amber') + ' 12%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(d.delivery.live ? 'green' : 'amber') + ' 30%,transparent)'
    }
  }, /*#__PURE__*/React.createElement("b", null, d.delivery.live ? 'Sending' : 'Not sending'), " \u2014 ", d.delivery.detail, d.delivery.fix && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--mute)',
      marginTop: 4
    }
  }, d.delivery.fix)), /*#__PURE__*/React.createElement(Card, {
    title: "Put them in your own inbox",
    help: "Renders below are a browser's idea of the email. A real client is the only place you find out what Outlook does to it, or how it looks on a phone at arm's length. These go through the same sender a customer's would."
  }, /*#__PURE__*/React.createElement(SampleBox, {
    delivery: d.delivery
  })), /*#__PURE__*/React.createElement(Card, {
    title: "What goes out",
    pad: 0
  }, d.dispatches.map(x => /*#__PURE__*/React.createElement("div", {
    key: x.id,
    style: {
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(open === x.id ? null : x.id),
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      width: '100%',
      textAlign: 'left',
      padding: '13px 16px',
      background: 'none',
      border: 'none',
      color: 'var(--text)',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 700,
      fontSize: 13.5
    }
  }, x.title), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12.5,
      color: 'var(--mute)',
      marginTop: 2
    }
  }, x.when)), /*#__PURE__*/React.createElement(Pill, {
    tone: "blue"
  }, AUD[x.audience]), /*#__PURE__*/React.createElement(Pill, {
    tone: x.automatic ? 'purple' : 'mute'
  }, x.automatic ? 'automatic' : 'you send it'), x.manual && /*#__PURE__*/React.createElement(Pill, {
    tone: "green"
  }, "on their page"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)',
      fontSize: 11
    }
  }, open === x.id ? '▲' : '▼')), open === x.id && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 16px'
    }
  }, x.manual ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, "Open anyone in Applications or the Inbox and you can send them this \u2014 under ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Send them an email"), ".", x.manual.needs.length > 0 && ' You write the ' + x.manual.needs.map(n => n.label.toLowerCase()).join(' and ') + '; everything else is filled in from their record.') : x.elsewhere ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12,
      padding: '9px 12px',
      borderRadius: 9,
      background: 'var(--sidebar)',
      border: '1px solid var(--line)'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Not sendable by hand."), " ", x.elsewhere) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)',
      marginBottom: 6
    }
  }, "SUBJECT"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      fontWeight: 600,
      marginBottom: 12
    }
  }, x.sample.subject), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)',
      marginBottom: 6
    }
  }, "BODY (sample)"), /*#__PURE__*/React.createElement("pre", {
    style: {
      whiteSpace: 'pre-wrap',
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.6,
      color: 'var(--mute)',
      margin: 0,
      background: 'var(--sidebar)',
      padding: 13,
      borderRadius: 10
    }
  }, x.sample.text), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      paddingTop: 14,
      borderTop: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement(SampleBox, {
    delivery: d.delivery,
    template: x.id,
    label: "Send me this one"
  })))))), /*#__PURE__*/React.createElement(Card, {
    title: "Where we say nothing, on purpose"
  }, d.silent.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.stage,
    style: {
      display: 'flex',
      gap: 12,
      padding: '9px 0',
      borderBottom: '1px solid var(--line2)',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 90,
      flex: 'none',
      textTransform: 'capitalize',
      fontWeight: 600
    }
  }, s.stage), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, s.why)))));
}

// ===================== START A DESK =====================
/* Adding a desk does not create a desk. It sends somebody the link to set
   one up. We fill in the handful of things we already know — the same ones
   the early-access form asks — and everything else is theirs to answer on
   their own screens. The desk exists at the end of that, not the start of
   this. */
function CreateModal({
  onClose,
  onCreated
}) {
  const [f, setF] = useState({
    businessName: '',
    ownerName: '',
    ownerEmail: '',
    slug: '',
    country: 'CA',
    website: ''
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [copied, setCopied] = useState(false);
  const set = (k, v) => setF(s => Object.assign({}, s, {
    [k]: k === 'slug' ? v.toLowerCase().replace(/[^a-z0-9-]/g, '') : v
  }));
  // Escape closes it. Clicking the backdrop already did, and a dialog where
  // one of the two ways out works is a dialog people feel stuck in.
  useEffect(() => {
    const on = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api('/api/admin/onboarding/invite', {
        method: 'POST',
        body: JSON.stringify(f)
      });
      setBusy(false);
      setDone(r);
      onCreated();
    } catch (x) {
      setBusy(false);
      setErr(x.body && x.body.detail || 'Could not send that invitation');
    }
  };
  const copy = () => {
    try {
      navigator.clipboard.writeText(done.link);
    } catch (e) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const inSty = {
    width: '100%',
    padding: '10px 12px',
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    borderRadius: 9,
    color: 'var(--text)',
    fontSize: 13.5,
    outline: 'none'
  };
  const lbl = {
    fontSize: 11.5,
    color: 'var(--mute)',
    marginBottom: 5,
    display: 'block'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      display: 'grid',
      placeItems: 'center',
      padding: 20,
      background: 'rgba(0,0,0,0.55)'
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement("form", {
    onClick: e => e.stopPropagation(),
    onSubmit: submit,
    style: {
      width: 440,
      maxWidth: '100%',
      background: 'var(--panel)',
      border: '1px solid var(--line)',
      borderRadius: 16,
      padding: '22px 24px',
      display: 'grid',
      gap: 12
    }
  }, done ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800
    }
  }, done.resent ? 'They already had one' : 'Their setup link is ready'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.5
    }
  }, done.resent ? done.detail : done.invite === 'sent' ? 'Emailed to ' + f.ownerEmail + '. They open it, answer the questions, and the desk opens at the end.' : 'No mail provider is configured, so nothing was sent — pass this link on yourself.'), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Reference"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...inSty,
      fontFamily: MONO,
      letterSpacing: '0.1em',
      fontWeight: 700
    }
  }, done.reference)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Link"), /*#__PURE__*/React.createElement("div", {
    style: {
      ...inSty,
      fontFamily: MONO,
      fontSize: 12,
      wordBreak: 'break-all',
      lineHeight: 1.5
    }
  }, done.link)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: copy,
    style: {
      flex: 1,
      padding: '10px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--text)',
      cursor: 'pointer',
      fontWeight: 600
    }
  }, copied ? 'Copied' : 'Copy link'), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    style: {
      flex: 1,
      padding: '10px',
      borderRadius: 9,
      border: 'none',
      background: 'var(--text)',
      color: '#111',
      cursor: 'pointer',
      fontWeight: 700
    }
  }, "Done"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 17,
      fontWeight: 800
    }
  }, "Start a desk"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.5
    }
  }, "This sends them a link to set their desk up. Fill in what you already know \u2014 they answer the rest themselves, and the desk opens when they finish."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Business name"), /*#__PURE__*/React.createElement("input", {
    style: inSty,
    value: f.businessName,
    onChange: e => set('businessName', e.target.value),
    placeholder: "Maple Currency Exchange",
    autoFocus: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Owner name"), /*#__PURE__*/React.createElement("input", {
    style: inSty,
    value: f.ownerName,
    onChange: e => set('ownerName', e.target.value),
    placeholder: "Dana Kim",
    required: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Desk address"), /*#__PURE__*/React.createElement("input", {
    style: {
      ...inSty,
      fontFamily: MONO
    },
    value: f.slug,
    onChange: e => set('slug', e.target.value),
    placeholder: "maplefx"
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Owner email"), /*#__PURE__*/React.createElement("input", {
    style: inSty,
    type: "email",
    value: f.ownerEmail,
    onChange: e => set('ownerEmail', e.target.value),
    placeholder: "owner@business.com",
    required: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Licensed in"), /*#__PURE__*/React.createElement("select", {
    style: inSty,
    value: f.country,
    onChange: e => set('country', e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "CA"
  }, "Canada"), /*#__PURE__*/React.createElement("option", {
    value: "US"
  }, "United States"), /*#__PURE__*/React.createElement("option", {
    value: "GB"
  }, "United Kingdom"), /*#__PURE__*/React.createElement("option", {
    value: "AU"
  }, "Australia"), /*#__PURE__*/React.createElement("option", {
    value: "AE"
  }, "United Arab Emirates"), /*#__PURE__*/React.createElement("option", {
    value: "EU"
  }, "European Union"), /*#__PURE__*/React.createElement("option", {
    value: "XX"
  }, "Somewhere else"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: lbl
  }, "Website (optional)"), /*#__PURE__*/React.createElement("input", {
    style: inSty,
    value: f.website,
    onChange: e => set('website', e.target.value),
    placeholder: "maplefx.ca"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, "No password here \u2014 they set their own on their own screen."), err && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      fontSize: 12.5
    }
  }, err), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    style: {
      flex: 1,
      padding: '10px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--mute)',
      cursor: 'pointer',
      fontWeight: 600
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    style: {
      flex: 2,
      padding: '10px',
      borderRadius: 9,
      border: 'none',
      background: 'var(--text)',
      color: '#111',
      cursor: 'pointer',
      fontWeight: 700,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy
  }, busy ? 'Sending…' : 'Send their setup link')))));
}

// ===================== PIPELINE =====================
// Everything the public site sends us. An application is not a message in an
// inbox — it is a thing somebody works — so this reads as a pipeline: what
// stage each one is at, what the applicant told us, and what it became.
/* ============================================================
   THE PANEL, DECLARED IN ONE PLACE

   Every page, in the order somebody works them, with the one thing that
   page is for. This table is why the nav, the headings, the routes and
   the buttons cannot disagree with each other — they are all read from
   it.

   `action` is the point. There used to be a single "Start a desk" button
   pinned to the top of every screen, which is how you end up able to
   start a desk from the billing page. An action belongs to the page it
   makes sense on: you invite people from Applications, you bill people
   from Billing, and Activity is a record so it has no action at all.
   ============================================================ */
const PAGES = [{
  id: 'overview',
  label: 'Overview',
  title: 'Overview',
  blurb: 'What needs you, what the business is doing, and whether anything is broken.'
}, {
  id: 'applications',
  label: 'Applications',
  title: 'Applications',
  count: 'waiting',
  blurb: 'Everyone who asked for a desk, and where you have got to with them. Approving sends their code and setup link.',
  action: {
    label: 'Invite a desk',
    kind: 'invite'
  }
}, {
  id: 'desks',
  label: 'Desks',
  title: 'Desks',
  count: 'desks',
  quiet: true,
  blurb: 'The customers. Open one to see their storefront, their people and their plan.',
  action: {
    label: 'Invite a desk',
    kind: 'invite'
  }
}, {
  id: 'billing',
  label: 'Billing',
  title: 'Billing',
  blurb: 'Subscriptions, invoices and what has actually been collected.',
  action: {
    label: 'Send an invoice',
    kind: 'invoice'
  }
}, {
  id: 'inbox',
  label: 'Inbox',
  title: 'Inbox',
  count: 'unread',
  blurb: 'Notes from the contact page. Each one was promised a straight answer, usually the same day.'
}, {
  id: 'comms',
  label: 'Emails',
  title: 'Emails',
  blurb: 'Everything CurrencyDesk says to anybody — what goes out, what fires it, and whether it is really sending.'
}, {
  id: 'activity',
  label: 'Activity',
  title: 'Activity',
  blurb: 'Every change anybody made, in order. Six years of it, because that is what the rulebook asks for.'
}];
const PAGE = id => PAGES.find(p => p.id === id) || PAGES[0];
/* One answer off an application, whichever shape the row is in. */
const det = (e, k) => {
  const v = (e && e.details || {})[k];
  return v == null || v === '' ? null : String(v);
};
/* The number, spaced for reading. Stored E.164 so it can be dialled; a
   fifteen-digit run with no gaps is unreadable to the person dialling it. */
const tel = e => {
  const raw = det(e, 'phone');
  if (!raw) return null;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : raw;
};
/* Settings is not in the list on purpose — it is the cogwheel at the
   bottom. You visit it when something needs configuring, not while you
   are working, and putting it in the run of daily pages made it look
   like one. */
const SETTINGS = {
  id: 'settings',
  title: 'Platform settings',
  blurb: 'Who runs CurrencyDesk, and how it is wired up.'
};
const STAGE_TONE = {
  new: 'mute',
  reviewing: 'amber',
  hold: 'blue',
  invited: 'purple',
  accepted: 'green',
  declined: 'mute'
};
/* Only a fallback, for the moment before the server's own list arrives. The
   real columns — their titles, the verb on each button, and which moves are
   legal from where — all come from the server, so the panel cannot drift
   from what a transition will actually accept. */
const STAGES = ['new', 'reviewing', 'hold', 'invited', 'accepted', 'declined'];
const stageTitle = (stages, id) => ((stages || []).find(s => s.id === id) || {}).title || id;
/* Each column, in more words than fit under its heading — what it means,
   what the applicant has been told, and what moving them out of it does.
   The one-liner under the title is the summary; this is the training. */
const STAGE_HELP = {
  new: 'Applications from before arrivals were acknowledged automatically. They have heard nothing from us. Nothing new lands here, and the column disappears once it is empty — so work these out and it goes.',
  reviewing: 'Where every application starts, the moment it arrives. They have already been emailed to say somebody is looking and that we will call. Nobody has to press anything to get them here.',
  hold: 'Worth keeping, not now. They are told nothing — this is a note to ourselves, not a decision they were given. You can approve straight from here without sending them back through review.',
  invited: 'Approved. Pressing Approve emailed them their reference and the link to set the desk up, and that link works for exactly as long as they sit in this column.',
  accepted: 'They finished setup and the desk exists. You cannot put an application here by hand — it arrives when they complete it, which is what keeps this board honest about the funnel.',
  declined: 'Not for us. Their code stops opening anything immediately. We send nothing automatically: a decline deserves a person writing to them.'
};
/* What each answer on the application is called here, and — where the name
   alone is not enough — what it means. The help text is the difference
   between a new starter guessing and a new starter knowing. */
const DETAIL_LABELS = {
  shopName: 'Shop name',
  businessName: 'Shop name',
  workspace: 'Workspace',
  website: 'Website',
  jurisdiction: 'Jurisdiction',
  role: 'Their role',
  employees: 'Team size',
  monthlyVolume: 'Monthly volume',
  branches: 'Locations',
  runningOn: 'Running on today',
  timeline: 'Wants to be live',
  topic: 'About',
  shop: 'Shop',
  city: 'City',
  message: 'Message',
  newsletter: 'Wants updates',
  phone: 'Mobile',
  bestTime: 'Best time to call',
  phoneUnparsed: 'Number as typed'
};
const DETAIL_HELP = {
  shopName: 'What they call the shop. It is the name on their charter card and the one every email greets them with, so it is worth reading back to them on the call rather than guessing from the address.',
  workspace: 'The web address they asked for. Their storefront will live at currencydeskos.com/sites/<this>, and it becomes the desk’s slug when they finish setup.',
  jurisdiction: 'Where they are licensed. It decides the regulator, the home currency and the reporting threshold their desk carries — so it is the one answer everything else follows from.',
  monthlyVolume: 'What they say they exchange in a month. Self-reported on the form, never verified — treat it as a sizing hint, not a fact.',
  runningOn: 'What they use today. “Spreadsheets & manual logs” usually means a quick, happy switch; “Legacy MSB software” usually means a data migration conversation.',
  timeline: 'How soon they want to be trading on it. Worth weighing against the queue — somebody who says “as soon as possible” and waits three weeks tends not to answer the phone.',
  branches: 'One shop or several. Multi-branch desks need a legal entity and branch set up per location, so they take longer to open.',
  phone: 'The number we ring after approving them. Collected on the application so nobody has to chase it — it is also the number they can sign in with later.',
  bestTime: 'When they said to call. Their local time, not yours.',
  phoneUnparsed: 'They typed something we could not read as a phone number, so it is kept exactly as written. Check it before dialling.'
};

/* ============================================================
   THE JOURNEY, ACROSS THE TOP

   Five columns of equal weight do not say what order anything happens
   in, and they especially do not say that two of them are places an
   application STOPS rather than passes through. So the path is drawn
   once, numbered, above the board: one, somebody looks at them. Two, we
   approve them. Three, they open a desk.

   The two ways out hang off the end, unnumbered, because they are exits
   and not steps. Somebody who has never seen this should be able to
   read the whole process off this one line.
   ============================================================ */
function Journey({
  stages,
  counts
}) {
  const path = (stages || []).filter(s => s.step).sort((a, b) => a.step - b.step);
  const exits = (stages || []).filter(s => s.exit);
  if (!path.length) return null;
  const pill = (s, n) => /*#__PURE__*/React.createElement("span", {
    key: s.id,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 22,
      borderRadius: '50%',
      display: 'grid',
      placeItems: 'center',
      flex: 'none',
      background: counts[s.id] ? 'var(--text)' : 'transparent',
      color: counts[s.id] ? '#111' : 'var(--faint)',
      border: '1px solid ' + (counts[s.id] ? 'var(--text)' : 'var(--line)'),
      fontFamily: MONO,
      fontSize: 11,
      fontWeight: 800
    }
  }, n), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 600
    }
  }, s.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, counts[s.id] || 0));
  const arrow = k => /*#__PURE__*/React.createElement("span", {
    key: 'a' + k,
    "aria-hidden": "true",
    style: {
      flex: '1 1 20px',
      minWidth: 16,
      height: 1,
      background: 'var(--line)'
    }
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 18,
      padding: '13px 16px',
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 13
    }
  }, path.map((s, k) => [k ? arrow(k) : null, pill(s, s.step)]).flat().filter(Boolean), exits.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 1,
      height: 22,
      background: 'var(--line)',
      margin: '0 4px',
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 9.5,
      letterSpacing: '0.12em',
      color: 'var(--faint)',
      textTransform: 'uppercase',
      flex: 'none'
    }
  }, "Or out"), exits.map(s => /*#__PURE__*/React.createElement("span", {
    key: s.id,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--mute)'
    }
  }, s.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, counts[s.id] || 0)))));
}

/* ============================================================
   THE INBOX

   A note from the contact page was being rendered through the
   applications board, so a message asking "do you support EUR?" sat in a
   column called In review with buttons offering to Approve & invite it,
   and a column called Open waiting for it to become a desk. None of that
   is true of a message.

   A message is answered or it is not. That is the whole model, so this is
   a list with one action, and the page shows the thing that actually
   matters: what they wrote, and how to write back.
   ============================================================ */
function Inbox({
  onChanged
}) {
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [thread, setThread] = useState(null); // { enquiry, replies } for openId
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState('');
  const [show, setShow] = useState('open'); // open | all
  const boxRef = useRef(null);
  const load = async () => {
    const r = await api('/api/admin/enquiries?kind=contact').catch(() => ({
      enquiries: []
    }));
    setRows(r.enquiries);
    // the nav badge counts unanswered messages; it moved
    if (onChanged) onChanged();
  };
  useEffect(() => {
    load();
  }, []);

  /* Opening a message loads its thread. Drafts are per-message and kept
     while you are in the panel — losing half a written reply because you
     clicked the wrong row is the kind of thing you only forgive once. */
  const drafts = useRef({});
  const openThread = async m => {
    if (openId === m.id) {
      setOpenId(null);
      setThread(null);
      return;
    }
    drafts.current[openId] = draft;
    setOpenId(m.id);
    setThread(null);
    setFlash('');
    setDraft(drafts.current[m.id] || '');
    try {
      setThread(await api('/api/admin/enquiries/' + m.id));
    } catch (e) {
      setThread({
        error: true
      });
    }
  };
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setFlash('');
    try {
      const r = await api('/api/admin/enquiries/' + openId + '/reply', {
        method: 'POST',
        body: JSON.stringify({
          body
        })
      });
      drafts.current[openId] = '';
      setDraft('');
      setFlash(r.email === 'sent' ? 'Sent.' : r.email === 'simulated' ? 'Written to the log — email is not switched on yet, so this did not reach them.' : 'That did not send. Nothing reached them; try again.');
      setThread(await api('/api/admin/enquiries/' + openId));
      await load();
      setTimeout(() => {
        if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
      }, 40);
    } catch (e) {
      setFlash(e.body && e.body.detail || 'That did not send.');
    }
    setSending(false);
  };
  if (!rows) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const unanswered = rows.filter(m => !m.handledAt);
  /* The conversation you are IN stays on screen. Answering moves a message
     out of "needs a reply", and without this the thread you had just
     written in disappeared the instant you sent — which reads as having
     lost it. No messaging app has ever closed the window you were typing
     in because the message became read. */
  const shown = show === 'open' ? rows.filter(m => !m.handledAt || m.id === openId) : rows;
  const tab = (id, label, n) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setShow(id),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 13px',
      borderRadius: 9,
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: show === id ? 700 : 500,
      border: '1px solid ' + (show === id ? 'var(--text)' : 'var(--line)'),
      background: show === id ? 'var(--hover)' : 'var(--card)',
      color: show === id ? 'var(--text)' : 'var(--mute)'
    }
  }, label, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, n));

  /* One turn in the conversation. Theirs on the left in the panel colour,
     ours on the right in ours — the oldest convention in messaging, and
     the reason you can tell at a glance who said what. */
  const bubble = (who, body, meta, mine) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: mine ? 'flex-end' : 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: '78%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '11px 14px',
      borderRadius: 13,
      fontSize: 13.5,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      background: mine ? 'var(--hover)' : 'var(--sidebar)',
      border: '1px solid var(--line2)',
      borderBottomRightRadius: mine ? 4 : 13,
      borderBottomLeftRadius: mine ? 13 : 4
    }
  }, body), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--faint)',
      marginTop: 4,
      textAlign: mine ? 'right' : 'left'
    }
  }, who, meta ? ' · ' + meta : '')));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 16,
      alignItems: 'center'
    }
  }, tab('open', 'Needs a reply', unanswered.length), tab('all', 'Everything', rows.length)), shown.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: 'center',
      color: 'var(--faint)',
      fontSize: 13.5,
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14
    }
  }, rows.length === 0 ? 'Nothing has come in yet.' : 'Every message has been answered.'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 10
    }
  }, shown.map(m => {
    const answered = !!m.handledAt;
    const isOpen = openId === m.id;
    const d = m.details || {};
    return /*#__PURE__*/React.createElement("div", {
      key: m.id,
      style: {
        background: 'var(--card)',
        border: '1px solid ' + (isOpen ? 'var(--text)' : answered ? 'var(--line2)' : 'var(--line)'),
        borderRadius: 13,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => openThread(m),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        textAlign: 'left',
        padding: '13px 15px',
        background: 'none',
        border: 'none',
        color: 'var(--text)',
        cursor: 'pointer'
      }
    }, !answered && /*#__PURE__*/React.createElement("span", {
      style: {
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'var(--amber)',
        flex: 'none'
      }
    }), /*#__PURE__*/React.createElement(Avatar, {
      name: m.name || m.email,
      size: 30
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: answered ? 600 : 800,
        fontSize: 14
      }
    }, m.name || m.email), d.topic && /*#__PURE__*/React.createElement(Pill, {
      tone: "blue"
    }, String(d.topic)), m.replyCount > 0 && /*#__PURE__*/React.createElement(Pill, {
      tone: "green"
    }, m.replyCount === 1 ? 'replied' : m.replyCount + ' replies')), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'block',
        fontSize: 12.5,
        color: 'var(--mute)',
        marginTop: 3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, d.message ? String(d.message) : /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--faint)'
      }
    }, "No message"))), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: MONO,
        fontSize: 11.5,
        color: 'var(--faint)',
        flex: 'none'
      }
    }, fmtDay(m.createdAt))), isOpen && /*#__PURE__*/React.createElement("div", {
      style: {
        borderTop: '1px solid var(--line2)'
      }
    }, !thread && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 20,
        color: 'var(--mute)',
        fontFamily: MONO,
        fontSize: 12
      }
    }, "Loading\u2026"), thread && thread.error && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 20,
        color: 'var(--red)'
      }
    }, "Could not load this conversation."), thread && !thread.error && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        padding: '11px 15px',
        background: 'var(--sidebar)',
        fontSize: 12,
        color: 'var(--mute)'
      }
    }, /*#__PURE__*/React.createElement("a", {
      href: 'mailto:' + m.email,
      style: {
        color: 'var(--blue)'
      }
    }, m.email), d.shop && /*#__PURE__*/React.createElement("span", null, String(d.shop)), d.city && /*#__PURE__*/React.createElement("span", null, String(d.city)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: MONO,
        color: 'var(--faint)'
      }
    }, m.reference), (d.newsletter === true || d.newsletter === 'true') && /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--faint)'
      }
    }, "wants updates")), /*#__PURE__*/React.createElement("div", {
      ref: boxRef,
      style: {
        padding: 15,
        display: 'grid',
        gap: 12,
        maxHeight: 420,
        overflowY: 'auto'
      }
    }, bubble(m.name || m.email, d.message ? String(d.message) : 'They sent no message.', fmtWhen(m.createdAt), false), (thread.replies || []).map(r => bubble('You', r.body, fmtWhen(r.createdAt) + (r.emailStatus === 'sent' ? '' : r.emailStatus === 'simulated' ? ' · not actually sent' : ' · failed to send'), true))), /*#__PURE__*/React.createElement("div", {
      style: {
        borderTop: '1px solid var(--line2)',
        padding: 13
      }
    }, flash && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10,
        fontSize: 12.5,
        color: 'var(--mute)'
      }
    }, flash), /*#__PURE__*/React.createElement("textarea", {
      value: draft,
      onChange: e => setDraft(e.target.value),
      onKeyDown: e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      },
      rows: 3,
      placeholder: 'Write back to ' + (m.name ? String(m.name).split(' ')[0] : 'them') + '…',
      style: {
        width: '100%',
        boxSizing: 'border-box',
        padding: 11,
        borderRadius: 10,
        border: '1px solid var(--line)',
        background: 'var(--sidebar)',
        color: 'var(--text)',
        fontSize: 13.5,
        lineHeight: 1.6,
        resize: 'vertical',
        outline: 'none',
        fontFamily: 'inherit'
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginTop: 9
      }
    }, /*#__PURE__*/React.createElement("button", {
      disabled: sending || !draft.trim(),
      onClick: send,
      style: {
        padding: '9px 17px',
        borderRadius: 9,
        border: 'none',
        fontWeight: 700,
        fontSize: 13,
        background: draft.trim() ? 'var(--text)' : 'var(--line)',
        color: draft.trim() ? '#111' : 'var(--faint)',
        cursor: sending || !draft.trim() ? 'default' : 'pointer'
      }
    }, sending ? 'Sending…' : 'Send reply'), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        color: 'var(--faint)'
      }
    }, "\u2318\u21B5 to send"), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1
      }
    }), /*#__PURE__*/React.createElement(Info, {
      title: "Where their answer goes"
    }, "Sending emails them and marks this answered. When they write back it goes to the reply-to inbox \u2014 a person reads it there, it does not appear in this thread. Nothing here receives email yet."))))));
  })));
}
function Pipeline({
  kind,
  onCounts
}) {
  const [rows, setRows] = useState(null);
  const [stage, setStage] = useState('all');
  /* Board or list. The board is for working the queue; the list is for
     finding one person. Remembered, because an operator has a preference
     and being asked again every morning is its own small insult. */
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('cdos_pipe_view') || 'board';
    } catch (e) {
      return 'board';
    }
  });
  const [stages, setStages] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  /* What is in the hand, and which column it is over.
      Two copies of the same thing on purpose. A drop only happens if a column
     called preventDefault() on a PRECEDING dragover — that is the browser's
     rule, not ours — so the answer to "can I take this?" has to be available
     synchronously, on the very first dragover, before React has re-rendered
     with the new state. The ref is what dragover reads; the state is what
     the columns are drawn from. Reading state in dragover looks fine when
     you move slowly and silently drops the card when you flick. */
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const accepts = id => {
    const d = dragRef.current;
    return !!d && d.next.includes(id);
  };
  const load = async () => {
    const r = await api('/api/admin/enquiries?kind=' + kind).catch(() => ({
      enquiries: []
    }));
    setRows(r.enquiries);
    if (r.stages) setStages(r.stages);
    if (onCounts) onCounts(r.enquiries);
  };
  useEffect(() => {
    load();
  }, [kind]);
  const pick = v => {
    setView(v);
    try {
      localStorage.setItem('cdos_pipe_view', v);
    } catch (e) {}
  };

  /* Moving a card is the same call the API makes from anywhere else, so the
     email that belongs to a stage follows without the board knowing which
     stages send anything. */
  const move = async (r, to) => {
    setBusy(r.id);
    setNote('');
    try {
      const res = await api('/api/admin/enquiries/' + r.id, {
        method: 'PATCH',
        body: JSON.stringify({
          status: to
        })
      });
      const sent = res.email;
      setNote((r.name || r.email) + ' → ' + stageTitle(stages, to) + (sent ? ' · email ' + sent : ''));
      await load();
    } catch (e) {
      setNote(e.body && e.body.detail || 'Could not move that one.');
    }
    setBusy(null);
    setTimeout(() => setNote(''), 6000);
  };
  if (!rows) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const BOARD = stages || STAGES.map(id => ({
    id,
    title: id,
    blurb: '',
    next: []
  }));
  const counts = BOARD.reduce((a, s) => (a[s.id] = rows.filter(r => r.status === s.id).length, a), {});
  /* A stage nothing lands in any more is not a column — it is clutter. It
     stays visible only while somebody is still sitting in it, so the eight
     applications that arrived before review was automatic can be worked out
     of it rather than silently disappearing from the board. */
  const columns = BOARD.filter(s => !s.legacy || counts[s.id] > 0);
  /* The three numbered stages are the path; the two exits are where an
     application stops. Drawn as two runs with a gap, so the eye reads the
     journey as a journey instead of five equal boxes. */
  const path = columns.filter(s => !s.exit);
  const exits = columns.filter(s => s.exit);
  const ordered = [...path, ...exits];

  /* OPEN KEEPS THE LAST FIVE.
      A desk that opens has left this board — it is a customer now, and it
     lives under Desks. But a column that is permanently empty teaches you
     to stop looking at it, and the most recent handful is the most
     encouraging thing on the page: proof the funnel came out the other
     end. So Open shows the five newest and says where the rest went. */
  const OPEN_KEEP = 5;
  const inColumn = id => {
    const all = rows.filter(r => r.status === id);
    if (id !== 'accepted') return all;
    return all.slice().sort((a, b) => new Date(b.decidedAt || b.createdAt) - new Date(a.decidedAt || a.createdAt)).slice(0, OPEN_KEEP);
  };
  const shown = stage === 'all' ? rows : rows.filter(r => r.status === stage);
  const th = {
    textAlign: 'left',
    fontSize: 11,
    color: 'var(--faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '0 16px 10px',
    fontWeight: 600
  };
  const td = {
    padding: '13px 16px',
    borderTop: '1px solid var(--line2)',
    fontSize: 14,
    verticalAlign: 'middle'
  };
  const chip = (id, label, n) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setStage(id),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '7px 13px',
      borderRadius: 9,
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: stage === id ? 700 : 500,
      border: '1px solid ' + (stage === id ? 'var(--text)' : 'var(--line)'),
      background: stage === id ? 'var(--hover)' : 'var(--card)',
      color: stage === id ? 'var(--text)' : 'var(--mute)',
      textTransform: 'capitalize'
    }
  }, label, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, n));

  /* A card. The same one on the board and, one day, anywhere else a single
     application needs to be shown small. */
  const card = r => {
    /* Exactly the moves the server will accept from here, named by what
       pressing them DOES. The approving one comes first and is the only one
       that looks like a decision, because approving is one click and the
       rest of it — the code, the email, the link — happens on its own. */
    const from = BOARD.find(s => s.id === r.status) || {};
    const onward = (from.next || []).map(id => BOARD.find(s => s.id === id)).filter(Boolean).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    /* Draggable only where there is somewhere to go. Picking up a card that
       cannot be put down anywhere is a promise the board cannot keep.
        The buttons stay. Drag is the fast way when you know where it goes;
       the buttons are the way that works on a phone, with a keyboard, and
       when you want to read what pressing the thing will actually do. */
    const canDrag = onward.length > 0;
    const lifted = drag && drag.row.id === r.id;
    /* minWidth:0 the whole way down, or one long address makes the card wider
       than its column and the board stops lining up. */
    return /*#__PURE__*/React.createElement("div", {
      key: r.id,
      draggable: canDrag,
      onDragStart: ev => {
        ev.dataTransfer.effectAllowed = 'move';
        // some browsers refuse to start a drag with nothing on the transfer
        ev.dataTransfer.setData('text/plain', r.reference);
        dragRef.current = {
          row: r,
          next: onward.map(s => s.id)
        };
        setDrag(dragRef.current);
      },
      onDragEnd: () => {
        dragRef.current = null;
        setDrag(null);
        setOver(null);
      },
      style: {
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 12,
        minWidth: 0,
        overflow: 'hidden',
        cursor: canDrag ? 'grab' : 'default',
        opacity: busy === r.id ? 0.5 : lifted ? 0.35 : 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => goto('#/applications/' + r.id),
      style: {
        cursor: 'pointer',
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: r.name || r.email,
      size: 26
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        minWidth: 0,
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'block',
        fontWeight: 700,
        fontSize: 13.5,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, r.name || '—'), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'block',
        fontFamily: MONO,
        fontSize: 10.5,
        color: 'var(--faint)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, r.email))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: MONO,
        fontSize: 10.5,
        color: 'var(--mute)',
        marginTop: 8
      }
    }, r.reference, r.charterNo ? ' · Nº ' + String(r.charterNo).padStart(4, '0') : ''), tel(r) && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: MONO,
        fontSize: 10.5,
        color: 'var(--mute)',
        marginTop: 3
      }
    }, "\u260F ", tel(r), det(r, 'bestTime') && det(r, 'bestTime') !== 'Any time' ? ' · ' + det(r, 'bestTime').toLowerCase() : ''), r.isDemo && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement(Pill, {
      tone: "purple"
    }, "walkthrough")), (r.labels || []).length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 5,
        flexWrap: 'wrap',
        marginTop: 8
      }
    }, (r.labels || []).map(l => /*#__PURE__*/React.createElement(Pill, {
      key: l,
      tone: "blue"
    }, l))), r.tenantName && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8
      }
    }, /*#__PURE__*/React.createElement(Pill, {
      tone: "green"
    }, r.tenantName))), onward.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 5,
        flexWrap: 'wrap',
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px solid var(--line2)'
      }
    }, onward.map(s => /*#__PURE__*/React.createElement("button", {
      key: s.id,
      disabled: busy === r.id,
      onClick: () => move(r, s.id),
      style: {
        padding: '4px 9px',
        borderRadius: 7,
        border: '1px solid ' + (s.primary ? 'transparent' : 'var(--line)'),
        background: s.primary ? 'var(--text)' : 'transparent',
        color: s.primary ? '#111' : 'var(--mute)',
        fontSize: 11,
        fontWeight: s.primary ? 800 : 600,
        cursor: 'pointer'
      }
    }, s.action || s.title))));
  };
  const toggle = (v, label) => /*#__PURE__*/React.createElement("button", {
    key: v,
    onClick: () => pick(v),
    style: {
      padding: '6px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 12.5,
      fontWeight: view === v ? 700 : 500,
      border: '1px solid ' + (view === v ? 'var(--text)' : 'var(--line)'),
      background: view === v ? 'var(--hover)' : 'transparent',
      color: view === v ? 'var(--text)' : 'var(--mute)'
    }
  }, label);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap',
      marginBottom: 16,
      alignItems: 'center'
    }
  }, view === 'list' && chip('all', 'Everything', rows.length), view === 'list' && columns.map(s => chip(s.id, s.title, counts[s.id])), view === 'board' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--faint)'
    }
  }, "Drag a card to move it, or use the buttons on it."), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, toggle('board', 'Board'), toggle('list', 'List'))), note && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12,
      padding: '9px 13px',
      borderRadius: 9,
      background: 'var(--hover)',
      border: '1px solid var(--line)',
      fontSize: 13
    }
  }, note), view === 'board' && /*#__PURE__*/React.createElement(Journey, {
    stages: BOARD,
    counts: counts
  }), view === 'board' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      overflowX: 'auto',
      paddingBottom: 8
    }
  }, ordered.map((s, ci) => {
    const inCol = inColumn(s.id);
    const hidden = s.id === 'accepted' ? counts[s.id] - inCol.length : 0;
    // the gap that separates the path from the ways out of it
    const gap = s.exit && ci === path.length ? 26 : 0;
    /* A column takes a card only if the server would accept the move.
       While something is in the hand the board says so plainly: the
       columns that can have it light up, the ones that cannot fade —
       so you find out before you let go rather than after. */
    const canDrop = !!drag && drag.next.includes(s.id);
    const refusing = !!drag && !canDrop;
    const hot = canDrop && over === s.id;
    return /*#__PURE__*/React.createElement("div", {
      key: s.id
      /* dragenter AND dragover. Cancelling only dragover is the classic
         half-fix: it works when you drift in slowly and enough dragover
         events fire, and drops the card on the floor when you move fast
         enough that the first event over the column is the only one. */,
      onDragEnter: ev => {
        if (!accepts(s.id)) return;
        ev.preventDefault();
        if (over !== s.id) setOver(s.id);
      },
      onDragOver: ev => {
        if (!accepts(s.id)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        if (over !== s.id) setOver(s.id);
      },
      onDragLeave: ev => {
        if (!ev.currentTarget.contains(ev.relatedTarget)) setOver(o => o === s.id ? null : o);
      },
      onDrop: ev => {
        ev.preventDefault();
        const d = dragRef.current;
        dragRef.current = null;
        setOver(null);
        setDrag(null);
        if (d && d.next.includes(s.id)) move(d.row, s.id);
      },
      style: {
        flex: '1 0 232px',
        minWidth: 232,
        maxWidth: 320,
        marginLeft: gap,
        opacity: refusing ? 0.4 : 1,
        transition: 'opacity .12s'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '0 2px 8px'
      }
    }, s.step && /*#__PURE__*/React.createElement("span", {
      style: {
        width: 17,
        height: 17,
        borderRadius: '50%',
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--hover)',
        border: '1px solid var(--line)',
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--mute)'
      }
    }, s.step), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 800
      }
    }, s.title), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: MONO,
        fontSize: 11,
        color: 'var(--faint)'
      }
    }, counts[s.id]), STAGE_HELP[s.id] && /*#__PURE__*/React.createElement(Info, {
      title: s.title
    }, STAGE_HELP[s.id])), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: 'var(--faint)',
        lineHeight: 1.45,
        padding: '0 2px 10px',
        minHeight: 30
      }
    }, s.blurb), /*#__PURE__*/React.createElement("div", {
      "data-stage": s.id,
      style: {
        display: 'grid',
        gap: 8,
        borderRadius: 13,
        padding: 8,
        minHeight: 90,
        transition: 'background .12s, box-shadow .12s',
        background: hot ? 'color-mix(in srgb,var(--text) 10%,var(--line2))' : 'var(--line2)',
        boxShadow: hot ? 'inset 0 0 0 2px var(--text)' : canDrop ? 'inset 0 0 0 1px var(--line)' : 'none'
      }
    }, inCol.map(card), hidden > 0 && /*#__PURE__*/React.createElement("button", {
      onClick: () => goto('#/desks'),
      style: {
        padding: '9px 8px',
        textAlign: 'center',
        fontSize: 11.5,
        color: 'var(--mute)',
        background: 'none',
        border: '1px dashed var(--line)',
        borderRadius: 10,
        cursor: 'pointer'
      }
    }, hidden, " more ", hidden === 1 ? 'desk' : 'desks', " \u2014 see them all under Desks \u2192"), hot && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '10px 8px',
        textAlign: 'center',
        fontSize: 11.5,
        fontWeight: 700
      }
    }, s.action ? s.action : 'Move here'), refusing && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '12px 10px',
        textAlign: 'center',
        fontSize: 11.5,
        lineHeight: 1.5,
        color: 'var(--mute)'
      }
    }, s.id === 'accepted' ? 'A desk opens when they finish setup — you cannot put one here.' : 'Not a move you can make from where that card is.'), inCol.length === 0 && !hot && !refusing && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '18px 10px',
        textAlign: 'center',
        color: 'var(--faint)',
        fontSize: 12,
        lineHeight: 1.5
      }
    }, s.id === 'accepted' ? 'Nobody has finished setting up yet. Desks arrive here on their own.' : 'Empty')));
  })), view === 'list' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      minWidth: 640
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...th,
      paddingTop: 14
    }
  }, kind === 'early_access' ? 'Applicant' : 'From'), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Stage"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, kind === 'early_access' ? 'Wants' : 'About'), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Became"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Received"))), /*#__PURE__*/React.createElement("tbody", null, shown.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id,
    onClick: () => goto('#/' + (kind === 'early_access' ? 'applications' : 'messages') + '/' + r.id),
    style: {
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: td
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: r.name || r.email
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 600
    }
  }, r.name || '—'), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)'
    }
  }, r.email)))), /*#__PURE__*/React.createElement("td", {
    style: td
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: STAGE_TONE[r.status],
    dot: true
  }, stageTitle(BOARD, r.status))), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--mute)',
      fontSize: 13
    }
  }, r.details && (r.details.workspace || r.details.topic) || '—'), /*#__PURE__*/React.createElement("td", {
    style: td
  }, r.tenantName ? /*#__PURE__*/React.createElement(Pill, {
    tone: "green"
  }, r.tenantName) : /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)'
    }
  }, "\u2014")), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      fontFamily: MONO,
      fontSize: 12.5,
      color: 'var(--mute)'
    }
  }, fmtDay(r.createdAt)))), shown.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 5,
    style: {
      ...td,
      textAlign: 'center',
      color: 'var(--faint)',
      padding: 40
    }
  }, rows.length === 0 ? 'Nothing has come in yet.' : 'Nothing at this stage.'))))))));
}

/* ===================== PLATFORM SETTINGS =====================
   Built for a team that does not exist yet, on purpose. The permission
   system has to be there before anybody is added to it — retro-fitting
   roles onto a panel where everyone had everything is how you end up
   auditing what your support contractor could reach. */
function SettingsPage() {
  const [d, setD] = useState(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    email: '',
    name: '',
    role: 'support'
  });
  const load = () => api('/api/admin/team').then(setD).catch(() => setFlash('Could not load the team.'));
  useEffect(() => {
    load();
  }, []);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const act = async (fn, ok) => {
    setBusy(true);
    setFlash('');
    try {
      await fn();
      setFlash(ok);
      await load();
    } catch (e) {
      setFlash(e.body && e.body.detail || 'That did not work.');
    }
    setBusy(false);
  };
  const inSty = {
    padding: '9px 11px',
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: 'var(--sidebar)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none'
  };
  const roleOf = id => d.roles.find(r => r.id === id) || {
    title: id,
    blurb: ''
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--mute)',
      fontSize: 13.5,
      margin: '0 0 16px',
      maxWidth: 640
    }
  }, "Who runs CurrencyDesk, and what each of them can reach."), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14,
      padding: '10px 14px',
      borderRadius: 10,
      fontSize: 13,
      background: 'var(--hover)',
      border: '1px solid var(--line)'
    }
  }, flash), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1.5fr) minmax(300px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Team"
  }, d.members.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.email,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      padding: '11px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: m.name || m.email,
    size: 32
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 700,
      fontSize: 13.5
    }
  }, m.name || m.email), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)'
    }
  }, m.email)), m.status === 'suspended' && /*#__PURE__*/React.createElement(Pill, {
    tone: "amber"
  }, "suspended"), m.role === 'owner' ? /*#__PURE__*/React.createElement(Pill, {
    tone: "purple"
  }, "Platform Owner") : d.canManage ? /*#__PURE__*/React.createElement("select", {
    disabled: busy,
    value: m.role,
    onChange: e => act(() => api('/api/admin/team/' + encodeURIComponent(m.email), {
      method: 'PATCH',
      body: JSON.stringify({
        role: e.target.value
      })
    }), m.email + ' is now ' + e.target.value + '.'),
    style: {
      ...inSty,
      fontSize: 12
    }
  }, d.roles.filter(r => r.id !== 'owner').map(r => /*#__PURE__*/React.createElement("option", {
    key: r.id,
    value: r.id
  }, r.title))) : /*#__PURE__*/React.createElement(Pill, {
    tone: "mute"
  }, roleOf(m.role).title), d.canManage && m.role !== 'owner' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    disabled: busy,
    onClick: () => act(() => api('/api/admin/team/' + encodeURIComponent(m.email), {
      method: 'PATCH',
      body: JSON.stringify({
        status: m.status === 'active' ? 'suspended' : 'active'
      })
    }), m.email + ' ' + (m.status === 'active' ? 'suspended' : 'restored') + '.'),
    style: {
      ...inSty,
      cursor: 'pointer',
      fontSize: 12
    }
  }, m.status === 'active' ? 'Suspend' : 'Restore'), /*#__PURE__*/React.createElement("button", {
    disabled: busy,
    onClick: () => act(() => api('/api/admin/team/' + encodeURIComponent(m.email), {
      method: 'DELETE'
    }), m.email + ' removed, and their sessions with them.'),
    style: {
      ...inSty,
      cursor: 'pointer',
      fontSize: 12,
      color: 'var(--red)'
    }
  }, "Remove")))), d.canManage && /*#__PURE__*/React.createElement("form", {
    onSubmit: ev => {
      ev.preventDefault();
      act(() => api('/api/admin/team', {
        method: 'POST',
        body: JSON.stringify(f)
      }), f.email + ' added as ' + f.role + '.');
      setF({
        email: '',
        name: '',
        role: 'support'
      });
    },
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 14,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("input", {
    required: true,
    type: "email",
    placeholder: "them@currencydeskos.com",
    value: f.email,
    onChange: e => setF({
      ...f,
      email: e.target.value
    }),
    style: {
      ...inSty,
      flex: 2,
      minWidth: 200
    }
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Name",
    value: f.name,
    onChange: e => setF({
      ...f,
      name: e.target.value
    }),
    style: {
      ...inSty,
      flex: 1,
      minWidth: 110
    }
  }), /*#__PURE__*/React.createElement("select", {
    value: f.role,
    onChange: e => setF({
      ...f,
      role: e.target.value
    }),
    style: inSty
  }, d.roles.filter(r => r.id !== 'owner').map(r => /*#__PURE__*/React.createElement("option", {
    key: r.id,
    value: r.id
  }, r.title))), /*#__PURE__*/React.createElement("button", {
    disabled: busy,
    style: {
      ...inSty,
      cursor: 'pointer',
      background: 'var(--text)',
      color: '#111',
      fontWeight: 700,
      border: 'none'
    }
  }, "Add")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      marginTop: 10,
      lineHeight: 1.5
    }
  }, "They sign in with this address. Adding somebody here grants the role; it does not create a login for them.")), /*#__PURE__*/React.createElement(Card, {
    title: "What each role can reach"
  }, d.roles.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      padding: '11px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 13.5
    }
  }, r.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 10.5,
      color: 'var(--faint)'
    }
  }, r.permissions.length, " permissions")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.5,
      marginTop: 3
    }
  }, r.blurb), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 4,
      flexWrap: 'wrap',
      marginTop: 7
    }
  }, r.permissions.map(p => /*#__PURE__*/React.createElement("span", {
    key: p,
    style: {
      fontFamily: MONO,
      fontSize: 10,
      padding: '2px 6px',
      borderRadius: 5,
      background: 'var(--hover)',
      color: 'var(--mute)'
    }
  }, p))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "You"
  }, kv('Signed in as', d.me.email), kv('Role', roleOf(d.me.role).title), d.me.isOwner && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px solid var(--line2)'
    }
  }, "Your account cannot be demoted, suspended or removed from here \u2014 not by anyone, including you. Full control has to survive a bad day, and locking yourself out of your own platform is one.")), /*#__PURE__*/React.createElement(Card, {
    title: "Still to build"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.6
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Security"), " \u2014 mandatory MFA on this account, device and session visibility, login history, and hardware keys. Not built yet.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Communications"), " \u2014 sending address, templates and delivery history. Emails send today; they are not editable from here.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Privacy & compliance"), " \u2014 retention, legal holds, privacy requests.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "Integrations"), " \u2014 Stripe is wired. KYC, SMS and accounting are not.")))));
}

/* ===================== BILLING ===================== */
function BillingPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/api/admin/billing').then(setD).catch(e => setErr(e.body && e.body.detail || 'Could not load billing.'));
  }, []);
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      padding: 20
    }
  }, err);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const cash = c => '$' + ((Number(c) || 0) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  /* Every money word on this page means one specific thing, and most of
     them are words people think they already know. MRR is not revenue,
     cash collected is not revenue either, and tax collected is not ours
     at all — so each tile says which it is. */
  const stat = (label, value, note, tone, help) => /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 13,
      padding: '14px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: '0.13em',
      textTransform: 'uppercase',
      color: 'var(--faint)',
      display: 'flex',
      alignItems: 'center'
    }
  }, label, help && /*#__PURE__*/React.createElement(Info, {
    title: label
  }, help)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 24,
      fontWeight: 800,
      marginTop: 6,
      color: tone || 'var(--text)'
    }
  }, value), note && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--mute)',
      marginTop: 3
    }
  }, note));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      margin: '0 0 6px'
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: d.connected ? 'green' : 'amber',
    dot: true
  }, d.connected ? 'Stripe connected' : 'Stripe not configured')), /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--mute)',
      fontSize: 13.5,
      margin: '0 0 16px',
      maxWidth: 640
    }
  }, "Stripe is the source of truth. These are the numbers its webhooks have told us."), !d.connected && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16,
      padding: '12px 15px',
      borderRadius: 11,
      border: '1px solid var(--line)',
      background: 'var(--hover)',
      fontSize: 13,
      lineHeight: 1.55
    }
  }, "No Stripe keys are set on this deployment, so every figure below is zero rather than wrong. Set them in the host's environment \u2014 never in here."), d.connected && !d.lastEventAt && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16,
      padding: '12px 15px',
      borderRadius: 11,
      border: '1px solid var(--amber)',
      fontSize: 13
    }
  }, "Stripe is configured but no webhook has ever arrived. Until one does, these numbers cannot move."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(178px,1fr))',
      gap: 12,
      marginBottom: 18
    }
  }, stat('MRR', cash(d.mrrCents), 'recurring, per month', null, 'Monthly recurring revenue: what every live subscription adds up to per month, with annual plans divided by twelve. It is a run rate, not money in the bank — nobody has paid you this figure.'), stat('ARR', cash(d.arrCents), 'MRR × 12', null, 'MRR multiplied by twelve. What a year would bring if nothing changed — no new desks, none lost. A shorthand for scale, not a forecast.'), stat('Paying desks', d.activePaying, d.trialing + ' on trial', null, 'Desks with a live paid subscription. Trials are counted separately underneath because they are not paying yet and some never will.'), stat('New this month', d.newThisMonth, null, null, 'Subscriptions that started since the 1st. A desk that started and cancelled in the same month still counts here — check Cancelled alongside it.'), stat('Cash collected', cash(d.cashCollectedThisMonthCents), 'this month, incl. tax', null, 'What Stripe actually took this month, tax included. NOT revenue: a desk paying a year up front hands over twelve months of cash today and earns one month of it.'), stat('Tax collected', cash(d.taxCollectedThisMonthCents), 'not yours', 'var(--mute)', 'Sales tax taken on your behalf and owed onward to the government. It sits inside Cash collected, and it was never income — subtract it before you think about what you earned.'), stat('Needs attention', d.needsAttention.length, 'unpaid or overdue', d.needsAttention.length ? 'var(--amber)' : null, 'Invoices Stripe could not collect. Usually an expired card. They do not fix themselves, and a desk here is one that keeps working while not paying.'), stat('Cancelled', d.cancelled, null, null, 'Subscriptions that have ended. Cancelling does not close their desk or delete anything — it stops the billing.')), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      marginBottom: 18,
      lineHeight: 1.55,
      maxWidth: 620
    }
  }, "Cash collected is not revenue. A desk paying a year up front hands over twelve months of cash today and earns one month of it \u2014 these are Stripe's cash and subscription figures, and accounting recognition is a different report."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1fr) minmax(300px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Needs attention",
    pad: 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 16px'
    }
  }, d.needsAttention.map(i => /*#__PURE__*/React.createElement("div", {
    key: i.invoiceId,
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'baseline',
      padding: '10px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontWeight: 600,
      fontSize: 13.5
    }
  }, i.tenantName), /*#__PURE__*/React.createElement(Pill, {
    tone: "amber"
  }, i.status), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12.5
    }
  }, cash(i.amountDueCents)), i.url && /*#__PURE__*/React.createElement("a", {
    href: i.url,
    target: "_blank",
    rel: "noopener",
    style: {
      fontSize: 12,
      color: 'var(--blue)'
    }
  }, "open"))), d.needsAttention.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: 'var(--faint)',
      textAlign: 'center'
    }
  }, "Nothing overdue."))), /*#__PURE__*/React.createElement(Card, {
    title: "Subscribers",
    pad: 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 16px'
    }
  }, d.subscribers.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.tenantId,
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'baseline',
      padding: '10px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontWeight: 600,
      fontSize: 13.5
    }
  }, s.tenantName), s.cancelAtPeriodEnd && /*#__PURE__*/React.createElement(Pill, {
    tone: "amber"
  }, "ending"), /*#__PURE__*/React.createElement(Pill, {
    tone: s.status === 'active' ? 'green' : 'mute'
  }, s.status), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12,
      color: 'var(--mute)'
    }
  }, s.plan || '—'), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12.5
    }
  }, cash(s.mrrCents)))), d.subscribers.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: 'var(--faint)',
      textAlign: 'center'
    }
  }, "Nobody is subscribed yet.")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "By plan"
  }, d.byPlan.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.plan,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '9px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      textTransform: 'capitalize',
      fontSize: 13.5
    }
  }, p.plan), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12,
      color: 'var(--faint)',
      marginRight: 9
    }
  }, p.subscribers), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 13
    }
  }, cash(p.mrrCents)))))), /*#__PURE__*/React.createElement(Card, {
    title: "Recent invoices",
    pad: 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 16px',
      maxHeight: 320,
      overflow: 'auto'
    }
  }, d.recent.map(i => /*#__PURE__*/React.createElement("div", {
    key: i.invoiceId,
    style: {
      display: 'flex',
      gap: 9,
      alignItems: 'baseline',
      padding: '9px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 12.5
    }
  }, i.tenantName), /*#__PURE__*/React.createElement(Pill, {
    tone: i.status === 'paid' ? 'green' : 'mute'
  }, i.status), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12
    }
  }, cash(i.amountPaidCents)))), d.recent.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: 'var(--faint)',
      textAlign: 'center'
    }
  }, "No invoices yet."))))));
}

// ===================== SHARED PAGE FURNITURE =====================
const money = (n, ccy) => {
  const v = Number(n) || 0;
  const s = v.toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return ccy ? s + ' ' + ccy : s;
};
const K = n => {
  const v = Number(n) || 0;
  return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(v);
};
const goto = h => {
  window.location.hash = h;
};
/* Records get their own URL. #/desks/tnt-x and #/applications/<id> are pages
   you can bookmark, reload and paste to someone — which a drawer never was. */
function parseHash(h) {
  const parts = String(h || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  let tab = parts[0] || 'overview';
  let id = parts[1] ? decodeURIComponent(parts[1]) : null;
  /* Old links keep working. `messages` is now `inbox`. `onboarding` was a
     staff-side copy of the customer's setup flow and is gone entirely, so
     those land on the applications list — its second part was a CD
     reference, which is not an application id, and carrying it through
     would only produce a not-found. */
  const MOVED = {
    messages: 'inbox',
    'early-access': 'applications'
  };
  if (tab === 'onboarding') {
    tab = 'applications';
    id = null;
  } else if (MOVED[tab]) tab = MOVED[tab];
  const known = PAGES.map(p => p.id).concat(['settings', 'people', 'compose']);
  /* Writing to somebody is a place, not a mode: #/compose/e/<application>
     or #/compose/s/<person>. A third part, because who you are writing to
     and which record they are do not fit in one. */
  return {
    tab: known.indexOf(tab) >= 0 ? tab : 'overview',
    id,
    sub: parts[2] ? decodeURIComponent(parts[2]) : null
  };
}
/* Where the "write to them" button on any record points. */
const composeTo = (kind, id) => '#/compose/' + kind + '/' + encodeURIComponent(id);
function PageHead({
  back,
  backTo,
  title,
  sub,
  pills,
  actions
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => goto(backTo),
    style: {
      background: 'none',
      border: 'none',
      color: 'var(--mute)',
      cursor: 'pointer',
      fontSize: 13,
      padding: 0,
      marginBottom: 12
    }
  }, "\u2190 ", back), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 26,
      fontWeight: 800,
      margin: 0
    }
  }, title), pills, /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 8
    }
  }, actions)), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 12,
      color: 'var(--faint)',
      marginTop: 6
    }
  }, sub));
}
/* ============================================================
   THE LITTLE ⓘ

   The bar this panel is held to: somebody who has never seen the system
   should be able to work it within a day. That means nothing on screen
   is allowed to be a word you have to already know — every label that
   could be read two ways carries the explanation next to it, one click
   away.

   Deliberately click rather than hover. Hover help does not exist on a
   phone, disappears the moment you move to read it, and cannot be left
   open next to the thing it describes while you decide.
   ============================================================ */
function Info({
  children,
  title
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const shut = e => {
      if (!e.target.closest || !e.target.closest('[data-info]')) setOpen(false);
    };
    const esc = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('click', shut);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('click', shut);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return /*#__PURE__*/React.createElement("span", {
    "data-info": true,
    style: {
      position: 'relative',
      display: 'inline-flex',
      verticalAlign: 'middle'
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": 'What is ' + (title || 'this') + '?',
    "aria-expanded": open,
    onClick: e => {
      e.stopPropagation();
      setOpen(o => !o);
    },
    style: {
      width: 15,
      height: 15,
      marginLeft: 6,
      borderRadius: '50%',
      border: '1px solid ' + (open ? 'var(--text)' : 'var(--line)'),
      background: open ? 'var(--text)' : 'transparent',
      color: open ? '#111' : 'var(--faint)',
      fontSize: 10,
      fontWeight: 800,
      lineHeight: 1,
      display: 'grid',
      placeItems: 'center',
      cursor: 'pointer',
      padding: 0,
      flex: 'none'
    }
  }, "i"), open && /*#__PURE__*/React.createElement("span", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      zIndex: 80,
      top: 22,
      left: -8,
      width: 290,
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 11,
      padding: '11px 13px',
      boxShadow: '0 18px 40px -12px rgba(0,0,0,0.6)',
      fontSize: 12.5,
      lineHeight: 1.6,
      color: 'var(--mute)',
      fontWeight: 400,
      letterSpacing: 0,
      textTransform: 'none',
      fontFamily: 'inherit',
      whiteSpace: 'normal',
      textAlign: 'left'
    }
  }, title && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 700,
      color: 'var(--text)',
      marginBottom: 4
    }
  }, title), children));
}
function Card({
  title,
  help,
  children,
  pad = 16,
  testId
}) {
  return /*#__PURE__*/React.createElement("div", {
    "data-testid": testId,
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14,
      overflow: 'hidden'
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '13px 16px',
      borderBottom: '1px solid var(--line2)',
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--faint)'
    }
  }, title, help && /*#__PURE__*/React.createElement(Info, {
    title: title
  }, help)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: pad
    }
  }, children));
}
function Tiles({
  items
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
      gap: 10,
      marginBottom: 18
    }
  }, items.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.k,
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 12,
      padding: '13px 15px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 9.5,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--faint)'
    }
  }, t.k), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800,
      marginTop: 5,
      color: t.c || 'var(--text)'
    }
  }, t.v), t.sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--mute)',
      marginTop: 2
    }
  }, t.sub))));
}
const kv = (k, v, help) => v == null || v === '' ? null : /*#__PURE__*/React.createElement("div", {
  key: k,
  style: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 14,
    padding: '8px 0',
    borderBottom: '1px solid var(--line2)',
    fontSize: 13
  }
}, /*#__PURE__*/React.createElement("span", {
  style: {
    color: 'var(--mute)',
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center'
  }
}, k, help && /*#__PURE__*/React.createElement(Info, {
  title: k
}, help)), /*#__PURE__*/React.createElement("span", {
  style: {
    fontWeight: 600,
    textAlign: 'right',
    wordBreak: 'break-word'
  }
}, v));

// ===================== DESK PAGE =====================
// The page you open when a customer rings. Who they are, how the desk is
// doing, what they last did, and the levers — on one screen.
function DeskPage({
  id,
  onChanged
}) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [ack, setAck] = useState(false);
  const load = () => {
    api('/api/admin/tenants/' + encodeURIComponent(id)).then(setD).catch(() => setErr('Could not load this desk.'));
  };
  useEffect(() => {
    setD(null);
    setErr('');
    load();
  }, [id]);
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      padding: 20
    }
  }, err);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const t = d.tenant,
    setup = t.setup || {},
    le = d.legalEntities[0] || {};
  const owner = d.staff.find(s => s.role === 'administrator');
  const suspended = t.suspended,
    book = d.book || {},
    ds = d.deskSettings || {};
  const act = async (fn, label) => {
    setBusy(label);
    setErr('');
    try {
      await fn();
      onChanged && onChanged();
      load();
    } catch (x) {
      setErr(x.body && x.body.detail || 'Action failed');
    }
    setBusy('');
  };
  const btn = (bg, col, extra) => Object.assign({
    padding: '9px 14px',
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: bg,
    color: col,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer'
  }, extra || {});
  const td = {
    padding: '11px 14px',
    borderTop: '1px solid var(--line2)',
    fontSize: 13,
    verticalAlign: 'middle'
  };
  const th = {
    textAlign: 'left',
    fontSize: 10,
    color: 'var(--faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '0 14px 9px',
    fontWeight: 600,
    fontFamily: MONO
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    back: "All desks",
    backTo: "#/desks",
    title: t.name,
    sub: t.slug + '  ·  ' + t.id + '  ·  joined ' + fmtDay(t.createdAt),
    pills: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Pill, {
      tone: suspended ? 'red' : t.plan === 'trial' ? 'amber' : 'green',
      dot: true
    }, suspended ? 'Suspended' : t.plan === 'trial' ? 'Trial' : 'Active'), /*#__PURE__*/React.createElement(Pill, {
      tone: PLAN_TONE[t.plan]
    }, t.plan)),
    actions: /*#__PURE__*/React.createElement(React.Fragment, null, owner && /*#__PURE__*/React.createElement("button", {
      onClick: () => goto(composeTo('s', owner.id)),
      style: btn('transparent', 'var(--text)')
    }, "Email owner"), /*#__PURE__*/React.createElement("button", {
      onClick: () => act(() => api('/api/admin/tenants/' + id, {
        method: 'PATCH',
        body: JSON.stringify({
          suspended: !suspended
        })
      }), 'suspend'),
      disabled: busy === 'suspend',
      style: btn(suspended ? 'color-mix(in srgb,var(--green) 14%,transparent)' : 'color-mix(in srgb,var(--amber) 14%,transparent)', suspended ? 'var(--green)' : 'var(--amber)')
    }, busy === 'suspend' ? '…' : suspended ? 'Unblock' : 'Block'))
  }), /*#__PURE__*/React.createElement(Tiles, {
    items: [{
      k: 'Transactions',
      v: book.transactions || 0
    }, {
      k: 'Volume in',
      v: '$' + K(book.volumeCad),
      sub: 'CAD, all time'
    }, {
      k: 'Fees earned',
      v: '$' + K(book.feesCad),
      c: 'var(--green)'
    }, {
      k: 'Clients',
      v: book.clients || 0
    }, {
      k: 'People',
      v: d.staff.length
    }, {
      k: 'Last trade',
      v: book.lastTradeAt ? String(book.lastTradeAt).slice(0, 10) : '—',
      c: book.lastTradeAt ? 'var(--text)' : 'var(--faint)'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1.7fr) minmax(280px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '13px 16px',
      borderBottom: '1px solid var(--line2)',
      fontFamily: MONO,
      fontSize: 10,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--faint)'
    }
  }, "Last five transactions"), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      minWidth: 560
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...th,
      paddingTop: 13
    }
  }, "Ref"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "When"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Type"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "In"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Out"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Fee"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Teller"))), /*#__PURE__*/React.createElement("tbody", null, (d.recentTransactions || []).map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: r.ref || i
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      fontFamily: MONO,
      fontSize: 12
    }
  }, r.ref || '—'), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--mute)',
      fontFamily: MONO,
      fontSize: 12
    }
  }, r.date, " ", r.time), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--mute)'
    }
  }, r.type || '—'), /*#__PURE__*/React.createElement("td", {
    style: td
  }, money(r.inAmt, r.inCcy)), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--green)'
    }
  }, money(r.outAmt, r.outCcy)), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      fontFamily: MONO,
      fontSize: 12
    }
  }, money(r.fee)), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--mute)'
    }
  }, r.teller || '—'))), (!d.recentTransactions || d.recentTransactions.length === 0) && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 7,
    style: {
      ...td,
      textAlign: 'center',
      color: 'var(--faint)',
      padding: 34
    }
  }, "This desk hasn't written a ticket yet.")))))), /*#__PURE__*/React.createElement(Card, {
    title: 'Recent activity',
    pad: 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 16px',
      maxHeight: 320,
      overflow: 'auto'
    }
  }, d.audit.slice(0, 20).map(e => /*#__PURE__*/React.createElement("div", {
    key: e.id,
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'baseline',
      padding: '9px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)',
      width: 120,
      flex: 'none'
    }
  }, fmtWhen(e.at)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12,
      fontWeight: 700,
      flex: 1
    }
  }, e.action), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--mute)'
    }
  }, e.actorId))), d.audit.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--faint)'
    }
  }, "Nothing yet.")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, d.publicSite && (() => {
    const p = d.publicSite;
    const live = p.hosted && p.published;
    const tone = live ? 'green' : p.hosted ? 'amber' : 'mute';
    return /*#__PURE__*/React.createElement(Card, {
      title: "Public rate board"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 'none',
        width: 8,
        height: 8,
        borderRadius: 999,
        marginTop: 6,
        background: live ? 'var(--green)' : p.hosted ? 'var(--amber)' : 'var(--line)'
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        lineHeight: 1.5
      }
    }, p.status)), kv('Address', p.path ? /*#__PURE__*/React.createElement("a", {
      href: p.path,
      target: "_blank",
      rel: "noopener",
      style: {
        fontFamily: MONO,
        fontSize: 12,
        color: 'var(--blue)'
      }
    }, p.path) : '—'), p.domain && kv('Their domain', p.domain), kv('Currencies shown', p.published ? String(p.currencies) : '—'), kv('Last published', p.publishedAt ? fmtWhen(p.publishedAt) : 'never'), p.publishedBy && kv('By', p.publishedBy), p.ratesEndpoint && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 12,
        paddingTop: 12,
        borderTop: '1px solid var(--line2)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: 'var(--mute)',
        marginBottom: 6
      }
    }, "What a visitor's browser asks for"), /*#__PURE__*/React.createElement("a", {
      href: p.ratesEndpoint,
      target: "_blank",
      rel: "noopener",
      style: {
        fontFamily: MONO,
        fontSize: 11.5,
        color: 'var(--blue)',
        wordBreak: 'break-all'
      }
    }, p.ratesEndpoint)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: 'var(--faint)',
        marginTop: 10,
        lineHeight: 1.5
      }
    }, tone === 'green' ? 'Their site reads this board directly, so what a customer sees is what the desk is trading at.' : tone === 'amber' ? 'Nothing will show on their site until somebody presses Publish on the rate board.' : 'A storefront has to be deployed for this address before rates can appear.'));
  })(), owner && /*#__PURE__*/React.createElement(Card, {
    title: "Owner"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: owner.name,
    size: 38
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontWeight: 700
    }
  }, owner.name), /*#__PURE__*/React.createElement("a", {
    href: 'mailto:' + owner.staffId,
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--blue)'
    }
  }, owner.staffId))), kv('Signed up', fmtDay(owner.createdAt))), d.application && /*#__PURE__*/React.createElement(Card, {
    title: "Came from"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 12.5,
      fontWeight: 700
    }
  }, d.application.reference), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12,
      color: 'var(--mute)',
      marginTop: 2
    }
  }, "applied ", fmtDay(d.application.createdAt))), /*#__PURE__*/React.createElement("button", {
    onClick: () => goto('#/applications/' + d.application.id),
    style: btn('transparent', 'var(--text)', {
      fontSize: 12
    })
  }, "Open"))), /*#__PURE__*/React.createElement(Card, {
    title: "Business"
  }, kv('Desk address', t.slug), kv('Public site', t.siteDomain), kv('Country', setup.country), kv('Regulator', setup.regulator || le.jurisdiction), kv('MSB number', setup.msbNumber || le.msbNumber), kv('Legal entity', le.name), kv('Branches', ds.branches || null), kv('Currencies priced', ds.currencies || null)), /*#__PURE__*/React.createElement(Card, {
    title: 'People (' + d.staff.length + ')'
  }, d.staff.map(s => /*#__PURE__*/React.createElement("button", {
    key: s.id,
    onClick: () => goto('#/people/' + s.id),
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      gap: 10,
      padding: '7px 0',
      background: 'none',
      border: 'none',
      color: 'var(--text)',
      cursor: 'pointer',
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: s.name,
    size: 28
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 13,
      fontWeight: 600
    }
  }, s.name, s.active === false && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--red)',
      fontWeight: 500
    }
  }, " \xB7 blocked")), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--mute)',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, s.cdId || s.staffId)), /*#__PURE__*/React.createElement(Pill, {
    tone: s.role === 'administrator' ? 'purple' : 'mute'
  }, s.role.replace('_', ' '))))), /*#__PURE__*/React.createElement(Card, {
    title: "Plan"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, ['basic', 'pro', 'premium'].map(p => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => act(() => api('/api/admin/tenants/' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        plan: p
      })
    }), 'plan'),
    disabled: busy === 'plan',
    style: btn(t.plan === p ? 'var(--hover)' : 'transparent', t.plan === p ? 'var(--text)' : 'var(--mute)', {
      textTransform: 'capitalize',
      fontSize: 12.5
    })
  }, p)))), /*#__PURE__*/React.createElement(Card, {
    title: "Retention"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, "Desks are ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "suspended, not deleted"), " \u2014 records must be kept ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, "6 years"), " (FINTRAC). Blocking takes a desk offline and keeps every record.", !suspended && ' To delete, block it first.'), suspended && /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--line2)',
      marginTop: 12,
      paddingTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: 'var(--red)',
      marginBottom: 8
    }
  }, "Permanently delete \u2014 last resort"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      gap: 8,
      fontSize: 12,
      color: 'var(--mute)',
      marginBottom: 10,
      cursor: 'pointer',
      lineHeight: 1.45
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: ack,
    onChange: e => setAck(e.target.checked),
    style: {
      marginTop: 2,
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", null, "I understand this destroys ", t.name, "'s records we are required to keep for 6 years, and cannot be undone.")), /*#__PURE__*/React.createElement("input", {
    value: confirmName,
    onChange: e => setConfirmName(e.target.value),
    placeholder: 'type ' + t.slug + ' to confirm',
    style: {
      width: '100%',
      padding: '9px 11px',
      background: 'var(--bg)',
      border: '1px solid var(--line)',
      borderRadius: 8,
      color: 'var(--text)',
      fontSize: 13,
      fontFamily: MONO,
      marginBottom: 9,
      outline: 'none',
      boxSizing: 'border-box'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => act(async () => {
      await api('/api/admin/tenants/' + id, {
        method: 'DELETE'
      });
      goto('#/desks');
    }, 'delete'),
    disabled: !ack || confirmName !== t.slug || busy === 'delete',
    style: {
      width: '100%',
      padding: 10,
      borderRadius: 9,
      border: 'none',
      cursor: ack && confirmName === t.slug ? 'pointer' : 'not-allowed',
      background: ack && confirmName === t.slug ? 'var(--red)' : 'rgba(248,113,113,0.18)',
      color: ack && confirmName === t.slug ? '#fff' : 'rgba(255,255,255,0.4)',
      fontWeight: 700,
      fontSize: 13
    }
  }, busy === 'delete' ? 'Deleting…' : 'Delete permanently'))))));
}

// ===================== PERSON PAGE =====================
// Support acts on people. Someone leaves, someone's laptop goes missing,
// someone can't get in — all of that is done from here.
function PersonPage({
  id,
  onChanged
}) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState(null);
  const load = () => api('/api/admin/staff/' + encodeURIComponent(id)).then(setD).catch(() => setErr('Could not load this person.'));
  useEffect(() => {
    setD(null);
    setErr('');
    setFlash(null);
    load();
  }, [id]);
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      padding: 20
    }
  }, err);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const p = d.person,
    desk = d.desk;
  const sent = s => s === 'sent' ? 'and emailed to them' : s === 'simulated' ? 'and the email is simulated here' : s === 'failed' ? 'but the email did not send' : 'but they have no email on file';
  const run = async (label, path, body, done) => {
    setBusy(label);
    setFlash(null);
    try {
      // the shared api() always sets a JSON content-type, and Fastify rejects
      // that with no body — so an action with nothing to say still says {}
      const r = await api(path, {
        method: body ? 'PATCH' : 'POST',
        body: JSON.stringify(body || {})
      });
      setFlash(done(r));
      await load();
      onChanged && onChanged();
    } catch (x) {
      setFlash({
        tone: 'red',
        text: x.body && x.body.detail || 'That did not work.'
      });
    }
    setBusy('');
  };
  const btn = (bg, col, extra) => Object.assign({
    padding: '9px 14px',
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: bg,
    color: col,
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'default' : 'pointer'
  }, extra || {});
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    back: desk ? desk.name : 'Desks',
    backTo: desk ? '#/desks/' + desk.id : '#/desks',
    title: p.name,
    sub: p.staffId + '  ·  joined ' + fmtDay(p.createdAt),
    pills: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Pill, {
      tone: p.active ? 'green' : 'red',
      dot: true
    }, p.active ? 'Active' : 'Blocked'), /*#__PURE__*/React.createElement(Pill, {
      tone: p.role === 'administrator' ? 'purple' : 'mute'
    }, p.role.replace('_', ' ')), p.mustChangePassword && /*#__PURE__*/React.createElement(Pill, {
      tone: "amber"
    }, "Must change password")),
    actions: /*#__PURE__*/React.createElement("button", {
      onClick: () => goto(composeTo('s', p.id)),
      style: btn('transparent', 'var(--text)')
    }, "Write to them")
  }), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16,
      padding: '11px 14px',
      borderRadius: 10,
      fontSize: 13,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,' + toneColor(flash.tone || 'blue') + ' 12%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(flash.tone || 'blue') + ' 30%,transparent)'
    }
  }, flash.text, flash.code && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 18,
      fontWeight: 700,
      letterSpacing: '0.08em',
      marginTop: 8
    }
  }, flash.code)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1.5fr) minmax(300px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "CurrencyDesk ID"
  }, p.cdId ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 26,
      fontWeight: 700,
      letterSpacing: '0.1em'
    }
  }, p.cdId) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, "None yet \u2014 they sign in as ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, p.staffId), "."), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--faint)',
      marginTop: 10,
      lineHeight: 1.55
    }
  }, "What they read out when they ring, and what they can sign in with. ", p.cdId ? 'Issuing a new one retires this one immediately.' : 'Issuing one does not take away their current sign-in.'), /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: () => run('cdid', '/api/admin/staff/' + p.id + '/cd-id', null, r => ({
      tone: 'green',
      text: (r.previous ? 'New ID issued — the old one no longer works, ' : 'ID issued, ') + sent(r.delivered) + '.',
      code: r.cdId
    })),
    style: {
      ...btn(p.cdId ? 'transparent' : 'var(--text)', p.cdId ? 'var(--text)' : '#111'),
      marginTop: 12
    }
  }, busy === 'cdid' ? 'Issuing…' : p.cdId ? 'Issue a new ID' : 'Issue an ID')), /*#__PURE__*/React.createElement(Card, {
    title: 'Their activity (' + d.events.length + ')',
    pad: 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 16px',
      maxHeight: 300,
      overflow: 'auto'
    }
  }, d.events.map(e => /*#__PURE__*/React.createElement("div", {
    key: e.id,
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'baseline',
      padding: '9px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)',
      width: 120,
      flex: 'none'
    }
  }, fmtWhen(e.at)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12,
      fontWeight: 700
    }
  }, e.action))), d.events.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--faint)'
    }
  }, "Nothing recorded yet.")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Account"
  }, kv('Signs in as', p.staffId), kv('Desk', desk ? /*#__PURE__*/React.createElement("button", {
    onClick: () => goto('#/desks/' + desk.id),
    style: {
      background: 'none',
      border: 'none',
      color: 'var(--blue)',
      cursor: 'pointer',
      padding: 0,
      fontSize: 13,
      fontWeight: 600
    }
  }, desk.name) : null), kv('Role', p.role.replace('_', ' ')), kv('Signed in now', d.sessions.live > 0 ? d.sessions.live + ' device' + (d.sessions.live === 1 ? '' : 's') : 'no'), kv('Last sign-in', d.sessions.lastSignInAt ? fmtWhen(d.sessions.lastSignInAt) : 'never'), kv('Password set', p.passwordUpdatedAt ? fmtWhen(p.passwordUpdatedAt) : 'at signup')), /*#__PURE__*/React.createElement(Card, {
    title: "Can't get in"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, "Issues a temporary password, signs every device out, and makes them pick their own before the desk opens."), /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: () => run('reset', '/api/admin/staff/' + p.id + '/reset-password', null, r => r.tempPassword ? {
      tone: 'amber',
      text: 'Password reset. They have no email on file, so read this to them — it is shown once.',
      code: r.tempPassword
    } : {
      tone: 'green',
      text: 'Password reset ' + sent(r.delivered) + '. Every device has been signed out.'
    }),
    style: {
      ...btn('transparent', 'var(--text)'),
      width: '100%'
    }
  }, busy === 'reset' ? 'Resetting…' : 'Reset their password')), /*#__PURE__*/React.createElement(Card, {
    title: "Till PIN"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, p.pinLockedUntil ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--amber)'
    }
  }, /*#__PURE__*/React.createElement("b", null, "The keypad is shut"), " after too many wrong tries \u2014 until ", fmtWhen(p.pinLockedUntil), ". Resetting the PIN opens it again straight away.") : p.pinMustChange ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--amber)'
    }
  }, /*#__PURE__*/React.createElement("b", null, "Still the one we issued"), " (", fmtWhen(p.pinSetAt), ") \u2014 so whoever read it out knows it. They set their own from Settings, or reset it themselves with their password.") : p.hasPin ? /*#__PURE__*/React.createElement(React.Fragment, null, "Four digits, asked for at the till, when switching accounts and when voiding. They chose it ", fmtWhen(p.pinSetAt), ". Nobody can read it back \u2014 not even us.") : /*#__PURE__*/React.createElement(React.Fragment, null, "No PIN set. Until there is one the desk falls back to its own check, which anyone can see. Issue one.")), /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: () => run('pin', '/api/admin/staff/' + p.id + '/reset-pin', null, r => ({
      tone: 'amber',
      text: 'New PIN. Read it to them — it is shown once and cannot be looked up again.',
      code: r.pin
    })),
    style: {
      ...btn(p.hasPin ? 'transparent' : 'var(--text)', p.hasPin ? 'var(--text)' : '#111'),
      width: '100%'
    }
  }, busy === 'pin' ? 'Setting…' : p.hasPin ? 'Reset their PIN' : 'Issue a PIN')), /*#__PURE__*/React.createElement(Card, {
    title: "Access"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, p.active ? 'Blocking signs them out everywhere at once and refuses any new sign-in. Their records stay exactly as they are.' : 'They are blocked: signed out everywhere and unable to sign in.'), /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: () => run('block', '/api/admin/staff/' + p.id, {
      active: !p.active
    }, () => ({
      tone: p.active ? 'amber' : 'green',
      text: p.active ? p.name + ' is blocked and signed out everywhere.' : p.name + ' can sign in again.'
    })),
    style: {
      ...btn(p.active ? 'color-mix(in srgb,var(--red) 14%,transparent)' : 'color-mix(in srgb,var(--green) 14%,transparent)', p.active ? 'var(--red)' : 'var(--green)'),
      width: '100%'
    }
  }, busy === 'block' ? '…' : p.active ? 'Block this person' : 'Unblock this person')))));
}

// ===================== APPLICATION PAGE =====================

/* Free-form on purpose. The moment you make an operator pick from a fixed
   list you have to guess the list, and they will want one you did not think
   of on their second day. What everyone has already used is offered back, so
   the vocabulary converges without being imposed. */
function LabelBox({
  enquiry,
  onSaved
}) {
  const [labels, setLabels] = useState(enquiry.labels || []);
  const [all, setAll] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLabels(enquiry.labels || []);
  }, [enquiry.id, (enquiry.labels || []).join(',')]);
  useEffect(() => {
    api('/api/admin/labels').then(r => setAll(r.labels || [])).catch(() => {});
  }, []);
  const put = async next => {
    setBusy(true);
    try {
      const r = await api('/api/admin/enquiries/' + enquiry.id + '/labels', {
        method: 'PUT',
        body: JSON.stringify({
          labels: next
        })
      });
      setLabels(r.labels);
      onSaved && onSaved();
    } catch (e) {}
    setBusy(false);
  };
  const add = l => {
    const v = String(l || '').trim().toLowerCase();
    if (!v || labels.includes(v)) return;
    setDraft('');
    put([...labels, v]);
  };
  const drop = l => put(labels.filter(x => x !== l));
  const unused = all.filter(a => !labels.includes(a.label)).slice(0, 8);
  return /*#__PURE__*/React.createElement(Card, {
    title: "Labels",
    help: "What an application is LIKE \u2014 'high volume', 'referred by jordan', 'toronto'. Free-form and unlimited, and they drive nothing on their own: they are for finding and sorting. Where an application IS in the process is its stage, and that is the column it sits in."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      marginBottom: labels.length ? 11 : 0
    }
  }, labels.map(l => /*#__PURE__*/React.createElement("button", {
    key: l,
    disabled: busy,
    onClick: () => drop(l),
    title: "Remove",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 9px',
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      border: '1px solid color-mix(in srgb,var(--blue) 34%,transparent)',
      background: 'color-mix(in srgb,var(--blue) 13%,transparent)',
      color: 'var(--text)'
    }
  }, l, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)'
    }
  }, "\xD7")))), /*#__PURE__*/React.createElement("form", {
    onSubmit: ev => {
      ev.preventDefault();
      add(draft);
    },
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: draft,
    onChange: ev => setDraft(ev.target.value),
    placeholder: "high volume, toronto, referred\u2026",
    maxLength: 32,
    style: {
      flex: 1,
      padding: '8px 11px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      color: 'var(--text)',
      fontSize: 13,
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("button", {
    disabled: busy || !draft.trim(),
    style: {
      padding: '8px 14px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--text)',
      fontSize: 13,
      fontWeight: 600,
      cursor: draft.trim() ? 'pointer' : 'default'
    }
  }, "Add")), unused.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5,
      flexWrap: 'wrap',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--faint)',
      alignSelf: 'center'
    }
  }, "Used before:"), unused.map(a => /*#__PURE__*/React.createElement("button", {
    key: a.label,
    disabled: busy,
    onClick: () => add(a.label),
    style: {
      padding: '3px 8px',
      borderRadius: 999,
      fontSize: 11.5,
      cursor: 'pointer',
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--mute)'
    }
  }, a.label))));
}

/* Send one of the written emails to this person.

   The Inbox reply is one email typed from scratch. This is the rest of
   them — the same templates the Emails page lists, sent to whoever is on
   the screen. Three rules it is built around:

   1. NOTHING ABOUT THEM IS TYPED. Their name, their address and their
      reference come off the record on the server. The only thing an
      operator supplies is the part a template genuinely cannot know, and
      most of them need nothing at all.
   2. YOU SEE WHAT WILL GO. The preview is the same render as the send,
      one branch earlier in the same route, so it cannot drift.
   3. THE ONES YOU CANNOT SEND SAY WHY. Four of these carry a live
      credential and there is no honest way to fake one, so they are
      listed with the reason and where the real send lives. An operator
      who cannot find an email should never have to wonder whether they
      are missing a permission or a menu. */
function SendEmail({
  to,
  endpoint,
  templates,
  delivery,
  onSent,
  title,
  open: startOn
}) {
  const [pick, setPick] = useState(startOn || '');
  const [fields, setFields] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const list = templates || [];
  const open = list.filter(t => t.action && !t.blocked);
  const shut = list.filter(t => !t.action || t.blocked);
  const chosen = list.find(t => t.id === pick) || null;
  const missing = chosen ? chosen.needs.filter(f => !(fields[f.id] || '').trim()) : [];
  useEffect(() => {
    setPick(startOn || '');
    setFields({});
    setPreview(null);
    setFlash(null);
  }, [to.id]);

  /* Re-render the preview a beat after the last keystroke. Debounced
     because every one of these is a round trip, and a preview that
     stutters is worse than one that arrives a moment late. */
  useEffect(() => {
    if (!chosen || missing.length) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          template: chosen.id,
          fields,
          preview: true
        })
      }).then(r => {
        if (live) setPreview(r);
      }).catch(() => {
        if (live) setPreview(null);
      });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [endpoint, pick, JSON.stringify(fields), missing.length]);
  const send = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          template: chosen.id,
          fields
        })
      });
      setFlash({
        tone: r.email === 'sent' ? 'green' : r.email === 'simulated' ? 'amber' : 'red',
        text: r.email === 'sent' ? 'Sent to ' + to.email + '.' : r.email === 'simulated' ? 'Written to the server log, not sent — email is not switched on yet.' : 'It did not send. Nothing reached them.'
      });
      setPick('');
      setFields({});
      setPreview(null);
      onSent && onSent();
    } catch (x) {
      setFlash({
        tone: 'red',
        text: x.body && x.body.detail || 'Could not send that.'
      });
    }
    setBusy(false);
  };
  const chip = on => ({
    padding: '7px 12px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: on ? 800 : 600,
    cursor: 'pointer',
    border: '1px solid ' + (on ? 'transparent' : 'var(--line)'),
    background: on ? 'var(--text)' : 'transparent',
    color: on ? '#111' : 'var(--mute)'
  });
  return /*#__PURE__*/React.createElement(Card, {
    title: title || 'Send them an email',
    help: "Write to them without leaving the panel: something of your own, or one of the emails we have already written. Their name, address and reference are filled in from their record \u2014 you never type those, so an email from here cannot go to the wrong person. You see exactly what will go before it goes, and it lands on their record afterwards."
  }, !to.email && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12,
      padding: '9px 12px',
      borderRadius: 9,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,var(--red) 12%,transparent)',
      border: '1px solid color-mix(in srgb,var(--red) 30%,transparent)'
    }
  }, /*#__PURE__*/React.createElement("b", null, "No address on file."), " They sign in with a name rather than an email address, so there is nowhere to send this."), !delivery?.live && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12,
      padding: '9px 12px',
      borderRadius: 9,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,var(--amber) 12%,transparent)',
      border: '1px solid color-mix(in srgb,var(--amber) 30%,transparent)'
    }
  }, /*#__PURE__*/React.createElement("b", null, "Email is not switched on."), " Anything you send here is written to the server log and reaches nobody.", delivery?.fix ? ' ' + delivery.fix : ''), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12,
      padding: '9px 12px',
      borderRadius: 9,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,' + toneColor(flash.tone) + ' 12%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(flash.tone) + ' 30%,transparent)'
    }
  }, flash.text), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap'
    }
  }, open.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => {
      setPick(pick === t.id ? '' : t.id);
      setFields({});
      setPreview(null);
    },
    style: chip(pick === t.id)
  }, t.title)), open.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--mute)'
    }
  }, "Nothing can be sent to them from here as they stand.")), chosen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--faint)',
      lineHeight: 1.5,
      marginBottom: 11
    }
  }, chosen.when), chosen.needs.map(f => /*#__PURE__*/React.createElement("div", {
    key: f.id,
    style: {
      marginBottom: 11
    }
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: 'send-' + f.id,
    style: {
      display: 'block',
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 5
    }
  }, f.label), f.lines > 1 ? /*#__PURE__*/React.createElement("textarea", {
    id: 'send-' + f.id,
    rows: f.lines,
    value: fields[f.id] || '',
    placeholder: f.placeholder || '',
    onChange: ev => setFields({
      ...fields,
      [f.id]: ev.target.value
    }),
    style: {
      width: '100%',
      padding: 11,
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      color: 'var(--text)',
      fontSize: 13.5,
      lineHeight: 1.55,
      resize: 'vertical',
      outline: 'none',
      boxSizing: 'border-box'
    }
  }) : /*#__PURE__*/React.createElement("input", {
    id: 'send-' + f.id,
    value: fields[f.id] || '',
    placeholder: f.placeholder || '',
    onChange: ev => setFields({
      ...fields,
      [f.id]: ev.target.value
    }),
    style: {
      width: '100%',
      padding: '9px 11px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      color: 'var(--text)',
      fontSize: 13.5,
      outline: 'none',
      boxSizing: 'border-box'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      marginTop: 5,
      lineHeight: 1.5
    }
  }, f.help))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 10,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '9px 12px',
      borderBottom: '1px solid var(--line)',
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, "To ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, to.email), preview && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text)'
    }
  }, preview.subject))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      fontSize: 12.5,
      lineHeight: 1.65,
      whiteSpace: 'pre-wrap',
      color: 'var(--mute)',
      maxHeight: 260,
      overflow: 'auto'
    }
  }, preview ? preview.text : missing.length ? missing[0].label + ' is empty — fill it in and this will show what goes.' : 'Working out what to send…')), /*#__PURE__*/React.createElement("button", {
    disabled: busy || !preview,
    onClick: send,
    style: {
      marginTop: 11,
      padding: '10px 16px',
      borderRadius: 9,
      border: 'none',
      width: '100%',
      background: preview ? 'var(--text)' : 'var(--line)',
      color: preview ? '#111' : 'var(--faint)',
      fontWeight: 800,
      fontSize: 13,
      cursor: busy || !preview ? 'default' : 'pointer'
    }
  }, busy ? 'Sending…' : (chosen.action || 'Send') + ' to ' + (to.name || to.email))), shut.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      paddingTop: 14,
      borderTop: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      fontWeight: 700,
      color: 'var(--faint)',
      marginBottom: 9,
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    }
  }, "Not from here"), shut.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'baseline',
      padding: '6px 0'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12.5,
      fontWeight: 600,
      width: 150,
      flex: 'none',
      color: 'var(--mute)'
    }
  }, t.title), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      lineHeight: 1.5,
      minWidth: 0
    }
  }, t.blocked)))));
}

/* Writing to somebody, as a place you go.

   Every "email them" button in this panel used to be a mailto: link. That
   is not a feature, it is a hand-off: the conversation leaves for whatever
   mail client happened to be installed, and what gets said is in the wrong
   voice, off the record, and invisible to whoever picks that customer up
   next. This is where those buttons go now.

   It works for both kinds of person the panel knows — somebody in the
   funnel and somebody who already runs a desk — because from here the
   difference is only which record their name is read from. */
function ComposePage({
  kind,
  id
}) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const staff = kind === 's';
  const url = staff ? '/api/admin/staff/' + encodeURIComponent(id) : '/api/admin/enquiries/' + encodeURIComponent(id);
  useEffect(() => {
    setD(null);
    setErr('');
    api(url).then(setD).catch(() => setErr('Could not load them.'));
  }, [url]);
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      padding: 20
    }
  }, err);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const who = staff ? {
    id: d.person.id,
    name: d.person.name,
    email: d.canEmail ? d.person.staffId : ''
  } : {
    id: d.enquiry.id,
    name: d.enquiry.name,
    email: d.enquiry.email
  };
  const back = staff ? {
    label: d.person.name,
    to: '#/people/' + d.person.id
  } : {
    label: d.enquiry.name || d.enquiry.email,
    to: '#/applications/' + d.enquiry.id
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    back: back.label,
    backTo: back.to,
    title: 'Write to ' + (who.name || who.email),
    sub: (who.email || 'no address on file') + (staff && d.desk ? '  ·  ' + d.desk.name : !staff ? '  ·  ' + d.enquiry.reference : '')
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 720
    }
  }, /*#__PURE__*/React.createElement(SendEmail, {
    to: who,
    endpoint: url + '/email',
    templates: d.templates,
    delivery: d.delivery,
    title: "What to send",
    open: "custom",
    onSent: () => {}
  })));
}

/* Their confirmation code, minted on the spot.

   Setup asks them to confirm their address before the desk is built, and
   normally they press the button on their own screen. On a call that is
   one instruction too many, and if their mail is slow it is a dead end.
   This issues the real one — same code, same ten-minute clock — and shows
   it here while nothing can actually be delivered. */
function VerifyCodeBox({
  enquiry,
  live
}) {
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState(null);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true);
    setErr('');
    setGot(null);
    try {
      setGot(await api('/api/admin/enquiries/' + enquiry.id + '/verify-code', {
        method: 'POST',
        body: '{}'
      }));
    } catch (x) {
      setErr(x.body && x.body.detail || 'Could not issue a code.');
    }
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement(Card, {
    title: "Their confirmation code",
    help: "Setup asks them to confirm their email address before the desk is built. They can do it themselves on their own screen \u2014 this is for when you are on the phone with them, or their mail is slow. It is the same code either way, and issuing a new one kills the last."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, "Sends a fresh six-digit code to whatever address their setup is working against, which is not always the one they applied with."), /*#__PURE__*/React.createElement("button", {
    disabled: busy,
    onClick: go,
    style: {
      width: '100%',
      padding: '9px 14px',
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'transparent',
      color: 'var(--text)',
      fontSize: 12.5,
      fontWeight: 600,
      cursor: busy ? 'default' : 'pointer'
    }
  }, busy ? 'Issuing…' : 'Send them a code'), err && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      fontSize: 12.5,
      color: 'var(--red)',
      lineHeight: 1.55
    }
  }, err), got && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      padding: '11px 13px',
      borderRadius: 10,
      fontSize: 12.5,
      lineHeight: 1.6,
      background: 'color-mix(in srgb,' + toneColor(got.email === 'sent' ? 'green' : 'amber') + ' 12%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(got.email === 'sent' ? 'green' : 'amber') + ' 30%,transparent)'
    }
  }, got.email === 'sent' ? /*#__PURE__*/React.createElement(React.Fragment, null, "Sent to ", /*#__PURE__*/React.createElement("b", null, got.sentTo), ". Good for ", got.expiresInMinutes, " minutes.") : /*#__PURE__*/React.createElement(React.Fragment, null, "Nothing was delivered \u2014 email is not switched on \u2014 so here it is. Read it to them; it is good for ", got.expiresInMinutes, " minutes."), got.code && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 26,
      fontWeight: 700,
      letterSpacing: '0.16em',
      marginTop: 9
    }
  }, got.code)));
}

/* Everything we have said to them, in the order it was said. Sends now
   come from three places — approving, the Inbox, and the card above — so
   the record of what they have already been told belongs on their page
   rather than only in the Inbox thread. */
function SentSoFar({
  replies
}) {
  if (!replies || replies.length === 0) return null;
  return /*#__PURE__*/React.createElement(Card, {
    title: 'What we have sent them (' + replies.length + ')',
    help: "Every email a person here sent them, newest last. The automatic ones \u2014 the acknowledgement, the invitation \u2014 are on the History card instead, because those follow from a stage rather than from somebody pressing send."
  }, replies.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      padding: '10px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'baseline',
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)'
    }
  }, fmtWhen(r.createdAt)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, r.sentBy), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(Pill, {
    tone: r.emailStatus === 'sent' ? 'green' : r.emailStatus === 'simulated' ? 'amber' : 'red'
  }, r.emailStatus === 'sent' ? 'delivered' : r.emailStatus === 'simulated' ? 'not actually sent' : 'failed')), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      lineHeight: 1.6,
      color: 'var(--mute)',
      whiteSpace: 'pre-wrap'
    }
  }, r.body))));
}

/* What the applicant said and what research inferred must remain two visible
   kinds of fact. This panel owns only the second kind, and every line here
   has a source link; the server will not store one without it. */
function GrowthPanel({
  enquiry
}) {
  const [growth, setGrowth] = useState(null);
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState(null);
  const load = () => api('/api/admin/enquiries/' + encodeURIComponent(enquiry.id) + '/growth').then(setGrowth).catch(x => setFlash({
    tone: 'red',
    text: x.body && x.body.detail || 'Could not load research.'
  }));
  useEffect(() => {
    setGrowth(null);
    setFlash(null);
    load();
  }, [enquiry.id]);
  const act = async (name, work, success) => {
    setBusy(name);
    setFlash(null);
    try {
      await work();
      setFlash({
        tone: 'green',
        text: success
      });
      await load();
    } catch (x) {
      setFlash({
        tone: 'red',
        text: x.body && x.body.detail || 'That did not work.'
      });
    }
    setBusy('');
  };
  const button = (primary, danger) => ({
    padding: '8px 12px',
    borderRadius: 8,
    border: danger ? '1px solid color-mix(in srgb,var(--red) 45%,transparent)' : primary ? '1px solid transparent' : '1px solid var(--line)',
    background: danger ? 'color-mix(in srgb,var(--red) 10%,transparent)' : primary ? 'var(--text)' : 'transparent',
    color: danger ? 'var(--red)' : primary ? '#111' : 'var(--mute)',
    fontSize: 12,
    fontWeight: 700,
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.65 : 1
  });
  if (!growth) return /*#__PURE__*/React.createElement(Card, {
    title: "What research inferred"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--faint)',
      fontFamily: MONO,
      fontSize: 12
    }
  }, "Loading research\u2026"));
  const latest = growth.research[0] || null;
  const latestComplete = growth.research.find(run => run.status === 'complete') || null;
  const caps = growth.capabilities || {};
  const callReady = caps.callingConfigured && caps.callingEnabled && growth.consent && latestComplete && !growth.doNotContact;
  const call = () => act('call', () => api('/api/admin/enquiries/' + enquiry.id + '/call', {
    method: 'POST',
    headers: {
      'idempotency-key': crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
    },
    body: '{}'
  }), 'The provider accepted one call. Its transcript will appear here when it finishes.');
  const run = () => act('research', () => api('/api/admin/enquiries/' + enquiry.id + '/research', {
    method: 'POST',
    body: '{}'
  }), latest ? 'A new research snapshot was added. The earlier one is unchanged.' : 'Research complete.');
  const review = () => latest && act('review', () => api('/api/admin/enquiries/' + enquiry.id + '/research/' + latest.id + '/review', {
    method: 'POST',
    body: '{}'
  }), 'Marked reviewed.');
  const stop = () => {
    if (!window.confirm('Permanently mark this applicant do not contact? Calling will be refused from now on.')) return;
    act('dnc', () => api('/api/admin/enquiries/' + enquiry.id + '/contact', {
      method: 'PATCH',
      body: JSON.stringify({
        doNotContact: true,
        reason: 'operator'
      })
    }), 'Do not contact is now permanent for this application.');
  };
  const switchCalling = () => act('switch', () => api('/api/admin/growth/calling', {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: !caps.callingEnabled
    })
  }), caps.callingEnabled ? 'All AI outbound calling is paused.' : 'AI outbound calling is enabled.');
  const facts = run => (run.facts || []).map(f => /*#__PURE__*/React.createElement("div", {
    key: f.id,
    style: {
      padding: '10px 0',
      borderTop: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 5,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 10.5,
      color: 'var(--purple)',
      textTransform: 'uppercase',
      letterSpacing: '0.05em'
    }
  }, String(f.key).replaceAll('_', ' ')), /*#__PURE__*/React.createElement(Pill, {
    tone: "purple"
  }, Math.round(Number(f.confidence) * 100), "% confidence"), /*#__PURE__*/React.createElement(Pill, {
    tone: "mute"
  }, String(f.method).replaceAll('_', ' '))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, f.value), /*#__PURE__*/React.createElement("a", {
    href: f.sourceUrl,
    target: "_blank",
    rel: "noopener",
    style: {
      display: 'inline-block',
      color: 'var(--blue)',
      fontSize: 11.5,
      marginTop: 5,
      overflowWrap: 'anywhere'
    }
  }, f.sourceUrl, " \u2197")));
  return /*#__PURE__*/React.createElement(Card, {
    title: "What research inferred",
    testId: "research-inferred",
    help: "Separate from their answers. This is sourced background for a caller, never something to quote as if the applicant said it."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      borderLeft: '3px solid var(--purple)',
      padding: '9px 11px',
      background: 'color-mix(in srgb,var(--purple) 8%,transparent)',
      borderRadius: '0 9px 9px 0',
      fontSize: 12,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 13
    }
  }, "Inferred by research \xB7 every finding below names its source. An unsourced finding is absent."), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12,
      padding: '9px 11px',
      borderRadius: 8,
      fontSize: 12,
      color: toneColor(flash.tone),
      background: 'color-mix(in srgb,' + toneColor(flash.tone) + ' 10%,transparent)',
      border: '1px solid color-mix(in srgb,' + toneColor(flash.tone) + ' 25%,transparent)'
    }
  }, flash.text), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap',
      marginBottom: 13
    }
  }, /*#__PURE__*/React.createElement("button", {
    disabled: !!busy || !caps.researchConfigured,
    onClick: run,
    style: button(!latest, false)
  }, busy === 'research' ? 'Researching…' : latest ? 'Run research again' : caps.researchConfigured ? 'Research this lead' : 'Research not configured'), latest && latest.status === 'complete' && !(latest.reviews || []).length && /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: review,
    style: button(false, false)
  }, "Mark reviewed"), /*#__PURE__*/React.createElement("button", {
    disabled: !!busy || !callReady,
    onClick: call,
    title: !growth.consent ? 'No consent record' : !caps.callingEnabled ? 'Outbound calling is paused' : !latest ? 'Research first' : growth.doNotContact ? 'Do not contact' : '',
    style: button(callReady, false)
  }, busy === 'call' ? 'Placing once…' : caps.callingConfigured ? 'Call now with AI' : 'ElevenLabs not configured'), !growth.doNotContact && /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: stop,
    style: button(false, true)
  }, "Do not contact")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap',
      marginBottom: 12,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: growth.doNotContact ? 'red' : growth.consent ? 'green' : 'amber'
  }, growth.doNotContact ? 'do not contact' : growth.consent ? 'consent recorded' : 'consent absent'), /*#__PURE__*/React.createElement(Pill, {
    tone: caps.callingEnabled ? 'green' : 'red'
  }, caps.callingEnabled ? 'AI calling on' : 'AI calling paused'), growth.consent && /*#__PURE__*/React.createElement("span", null, growth.consent.formVersion, " \xB7 ", growth.consent.timezone || 'timezone absent'), caps.canManageCalling && /*#__PURE__*/React.createElement("button", {
    disabled: !!busy,
    onClick: switchCalling,
    style: {
      ...button(false, caps.callingEnabled),
      marginLeft: 'auto'
    }
  }, caps.callingEnabled ? 'Emergency stop all calls' : 'Enable all calls')), !latest && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: 'var(--faint)',
      padding: '8px 0'
    }
  }, "No research has been run. Their stated answers remain in the card above."), growth.research.map((run, index) => /*#__PURE__*/React.createElement("details", {
    key: run.id,
    open: index === 0,
    style: {
      borderTop: '1px solid var(--line)',
      padding: '11px 0'
    }
  }, /*#__PURE__*/React.createElement("summary", {
    style: {
      cursor: 'pointer',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, run.status === 'complete' ? 'Research' : 'Failed attempt', " \xB7 ", fmtWhen(run.runAt), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)',
      fontWeight: 400
    }
  }, " \xB7 ", run.provider, run.costCents == null ? ' · cost not priced' : ' · $' + (run.costCents / 100).toFixed(2)), (run.reviews || []).length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 7
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: "green"
  }, "reviewed"))), run.summary && /*#__PURE__*/React.createElement("div", {
    style: {
      whiteSpace: 'pre-wrap',
      fontSize: 12.5,
      color: 'var(--text)',
      lineHeight: 1.6,
      padding: '11px 0'
    }
  }, run.summary), run.error && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      fontSize: 12,
      padding: '9px 0'
    }
  }, run.error), facts(run))), growth.calls.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 13,
      borderTop: '1px solid var(--line)',
      paddingTop: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 10.5,
      color: 'var(--faint)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 7
    }
  }, "Call history"), growth.calls.map(c => /*#__PURE__*/React.createElement("details", {
    key: c.id,
    style: {
      padding: '8px 0',
      borderTop: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("summary", {
    style: {
      cursor: 'pointer',
      fontSize: 12.5
    }
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: c.status === 'completed' ? 'green' : c.status === 'failed' ? 'red' : 'amber'
  }, c.status), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 7
    }
  }, fmtWhen(c.requestedAt), " \xB7 ", c.phone)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 0 0 4px',
      fontSize: 12,
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, c.summary && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 7
    }
  }, c.summary), c.outcome && /*#__PURE__*/React.createElement("div", null, "Outcome: ", c.outcome), c.durationSeconds != null && /*#__PURE__*/React.createElement("div", null, "Duration: ", c.durationSeconds, "s"), Array.isArray(c.transcript) && c.transcript.map((turn, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("b", null, turn.role || 'turn', ":"), " ", turn.message || turn.text || JSON.stringify(turn))), c.recordingUrl && /*#__PURE__*/React.createElement("a", {
    href: c.recordingUrl,
    target: "_blank",
    rel: "noopener",
    style: {
      color: 'var(--blue)'
    }
  }, "Recording \u2197"))))));
}
function ApplicationPage({
  id,
  onChanged
}) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState('');
  const load = () => api('/api/admin/enquiries/' + encodeURIComponent(id)).then(r => {
    setD(r);
    setNote(r.enquiry.notes || '');
  }).catch(() => setErr('Could not load this application.'));
  useEffect(() => {
    setD(null);
    setErr('');
    load();
  }, [id]);
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--red)',
      padding: 20
    }
  }, err);
  if (!d) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  const e = d.enquiry;
  const isApp = e.kind === 'early_access';
  /* The same stage list the board draws its columns from, so this page can
     never offer a move the board would not, or one the server would refuse. */
  const stages = d.stages || [];
  const onward = ((stages.find(s => s.id === e.status) || {}).next || []).map(id => stages.find(s => s.id === id)).filter(Boolean).sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  const save = async (body, label) => {
    setBusy(true);
    setFlash('');
    try {
      const r = await api('/api/admin/enquiries/' + e.id, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      if (r && r.invite) setFlash(r.invite === 'failed' ? 'Stage saved, but the invitation email did not send.' : r.invite === 'simulated' ? 'Invited. Email is simulated here — it will send for real once Resend is configured.' : 'Invited, and the invitation is on its way.');else if (label) setFlash(label);
      await load();
      onChanged && onChanged();
    } catch (x) {
      setFlash(x.body && x.body.detail || 'Could not save.');
    }
    setBusy(false);
  };
  const btn = (bg, col, extra) => Object.assign({
    padding: '9px 14px',
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: bg,
    color: col,
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'default' : 'pointer'
  }, extra || {});
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    back: isApp ? 'Applications' : 'Inbox',
    backTo: isApp ? '#/applications' : '#/inbox',
    title: e.name || e.email,
    sub: e.reference + '  ·  received ' + fmtWhen(e.createdAt),
    pills: /*#__PURE__*/React.createElement(Pill, {
      tone: STAGE_TONE[e.status],
      dot: true
    }, stageTitle(stages, e.status)),
    actions: /*#__PURE__*/React.createElement("button", {
      onClick: () => goto(composeTo('e', e.id)),
      style: btn('transparent', 'var(--text)')
    }, "Write to them")
  }), flash && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14,
      padding: '10px 14px',
      borderRadius: 10,
      fontSize: 13,
      background: 'color-mix(in srgb,var(--blue) 12%,transparent)',
      border: '1px solid color-mix(in srgb,var(--blue) 30%,transparent)'
    }
  }, flash), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,1.6fr) minmax(280px,1fr)',
      gap: 16,
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, isApp && /*#__PURE__*/React.createElement(Card, {
    title: "How to reach them",
    help: "Collected on the application so nobody has to chase it. The call is the promise the form makes \u2014 within a few minutes of approving, at the time they picked."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 19,
      fontWeight: 700,
      letterSpacing: '0.03em'
    }
  }, tel(e) || /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)',
      fontSize: 14,
      fontWeight: 400,
      letterSpacing: 0
    }
  }, "No number \u2014 they applied before we asked for one")), det(e, 'bestTime') && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 12.5,
      color: 'var(--mute)',
      marginTop: 3
    }
  }, "Best time: ", det(e, 'bestTime'))), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), tel(e) && /*#__PURE__*/React.createElement("a", {
    href: 'tel:' + tel(e).replace(/\s+/g, ''),
    style: {
      ...btn('var(--text)', '#111'),
      textDecoration: 'none',
      fontWeight: 700,
      border: 'none'
    }
  }, "Call them"), /*#__PURE__*/React.createElement("button", {
    onClick: () => goto(composeTo('e', e.id)),
    style: btn('transparent', 'var(--mute)', {
      fontSize: 12.5
    })
  }, "Email instead")), det(e, 'phoneUnparsed') && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 11,
      padding: '9px 12px',
      borderRadius: 9,
      fontSize: 12.5,
      lineHeight: 1.55,
      background: 'color-mix(in srgb,var(--amber) 12%,transparent)',
      border: '1px solid color-mix(in srgb,var(--amber) 30%,transparent)'
    }
  }, "We could not read this as a phone number. They typed ", /*#__PURE__*/React.createElement("b", {
    style: {
      fontFamily: MONO
    }
  }, det(e, 'phoneUnparsed')), " \u2014 check it before dialling."), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--faint)',
      marginTop: 10,
      lineHeight: 1.5
    }
  }, e.email)), /*#__PURE__*/React.createElement(Card, {
    title: isApp ? 'What they told us' : 'Their message',
    testId: isApp ? 'applicant-stated' : undefined,
    help: isApp ? 'Their own answers from the early-access form, exactly as given. Nothing here is verified — it is what they said about themselves.' : 'Sent from the contact page. They were promised a reply within a business day.'
  }, kv('Email', /*#__PURE__*/React.createElement("a", {
    href: 'mailto:' + e.email,
    style: {
      color: 'var(--blue)'
    }
  }, e.email), 'The address they applied with. Everything we send goes here, and it is the address their desk is opened against.'), Object.entries(e.details || {}).filter(([, v]) => v !== null && v !== '')
  /* the number has its own card above; repeating it here is noise */.filter(([k]) => !(isApp && (k === 'phone' || k === 'bestTime' || k === 'phoneUnparsed'))).map(([k, v]) => kv(DETAIL_LABELS[k] || k, String(v), DETAIL_HELP[k]))), isApp && /*#__PURE__*/React.createElement(GrowthPanel, {
    enquiry: e
  }), isApp && /*#__PURE__*/React.createElement(LabelBox, {
    enquiry: e,
    onSaved: load
  }), /*#__PURE__*/React.createElement(SendEmail, {
    to: {
      id: e.id,
      name: e.name,
      email: e.email
    },
    endpoint: '/api/admin/enquiries/' + e.id + '/email',
    templates: d.templates,
    delivery: d.delivery,
    onSent: () => {
      load();
      onChanged && onChanged();
    }
  }), /*#__PURE__*/React.createElement(SentSoFar, {
    replies: d.replies
  }), isApp && e.status === 'invited' && /*#__PURE__*/React.createElement(Card, {
    title: "Their setup",
    help: "Their sixteen-screen setup, on the link we emailed. There is no staff copy of it \u2014 this opens exactly what they are looking at, which is the thing to have in front of you when somebody rings up stuck."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--mute)',
      lineHeight: 1.6,
      marginBottom: 12
    }
  }, "Theirs to do, on the link we emailed them. This is the same page they are looking at, so it is the thing to open when somebody rings up stuck on a screen."), /*#__PURE__*/React.createElement("a", {
    href: '/onboarding/' + encodeURIComponent(e.reference),
    target: "_blank",
    rel: "noopener",
    style: {
      ...btn('transparent', 'var(--text)', {
        fontSize: 12.5
      }),
      textDecoration: 'none',
      display: 'inline-block'
    }
  }, "Open their setup page \u2197"), e.isDemo && /*#__PURE__*/React.createElement("button", {
    onClick: async () => {
      await api('/api/admin/walkthrough/reset', {
        method: 'POST',
        body: '{}'
      }).catch(() => {});
      load();
      setFlash('Walkthrough reset — it starts from the beginning again.');
    },
    style: {
      ...btn('transparent', 'var(--mute)', {
        fontSize: 12.5
      }),
      marginLeft: 8
    }
  }, "Start the rehearsal over")), /*#__PURE__*/React.createElement(Card, {
    title: "Your notes",
    help: "Anything the next person needs: what you learned on the call, what you promised, why you held them. The applicant never sees this. It stays on the record after their desk opens."
  }, /*#__PURE__*/React.createElement("textarea", {
    value: note,
    onChange: ev => setNote(ev.target.value),
    rows: 6,
    placeholder: "What you learned on the call, what you promised, anything the next person needs\u2026",
    style: {
      width: '100%',
      padding: 11,
      borderRadius: 9,
      border: '1px solid var(--line)',
      background: 'var(--sidebar)',
      color: 'var(--text)',
      fontSize: 13.5,
      lineHeight: 1.55,
      resize: 'vertical',
      outline: 'none',
      boxSizing: 'border-box'
    }
  }), /*#__PURE__*/React.createElement("button", {
    disabled: busy || note === (e.notes || ''),
    onClick: () => save({
      notes: note
    }, 'Note saved.'),
    style: {
      marginTop: 9,
      padding: '9px 16px',
      borderRadius: 9,
      border: 'none',
      background: note === (e.notes || '') ? 'var(--line)' : 'var(--text)',
      color: note === (e.notes || '') ? 'var(--faint)' : '#111',
      fontWeight: 700,
      fontSize: 13,
      cursor: busy || note === (e.notes || '') ? 'default' : 'pointer'
    }
  }, "Save note"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Move this along",
    help: "The stages this application can go to from where it is now. The server decides which are legal, so a button here always works. Approving is one press \u2014 it moves them to Invited, mints nothing new, and emails their existing code with the setup link."
  }, e.status === 'accepted' ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--mute)',
      lineHeight: 1.55
    }
  }, "They built their desk \u2014 this one is done.") : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap'
    }
  }, onward.map(s => /*#__PURE__*/React.createElement("button", {
    key: s.id,
    disabled: busy,
    onClick: () => save({
      status: s.id
    }, 'Moved to ' + s.title + '.'),
    style: btn(s.primary ? 'var(--text)' : 'transparent', s.primary ? '#111' : 'var(--mute)', {
      fontSize: 12.5,
      fontWeight: s.primary ? 800 : 600,
      border: s.primary ? '1px solid transparent' : '1px solid var(--line)'
    })
  }, s.action || s.title))), isApp && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--faint)',
      marginTop: 10,
      lineHeight: 1.5
    }
  }, "Approving emails them their reference and the link to set the desk up. Open happens on its own when they finish.", ' ', "Holding tells them nothing \u2014 it is a note to us that they are worth coming back to."))), isApp && e.status === 'invited' && /*#__PURE__*/React.createElement(VerifyCodeBox, {
    enquiry: e,
    live: d.delivery && d.delivery.live
  }), isApp && e.status === 'invited' && /*#__PURE__*/React.createElement(Card, {
    title: "Their code",
    help: "The reference they were given when they applied, printed on their charter card and in every email. Holding it is what opens their setup page \u2014 so it is a key, and it stops working the moment they are not Invited."
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 15,
      fontWeight: 700,
      letterSpacing: '0.08em',
      marginBottom: 8
    }
  }, e.reference), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: 'var(--mute)',
      lineHeight: 1.55,
      marginBottom: 12
    }
  }, "Live. This opens their setup. Any of the buttons above \u2014 back to review, on hold, or declined \u2014 stops it working straight away, and that is how you take a code back."), /*#__PURE__*/React.createElement("button", {
    disabled: busy,
    onClick: async () => {
      setBusy(true);
      setFlash('');
      try {
        const r = await api('/api/admin/enquiries/' + e.id + '/rotate', {
          method: 'POST',
          body: JSON.stringify({})
        });
        setFlash('New code ' + r.reference + '. The old one (' + r.was + ') is dead' + (r.email ? ', and the new one has been emailed.' : '.'));
        await load();
        onChanged && onChanged();
      } catch (x) {
        setFlash(x.body && x.body.detail || 'Could not issue a new code.');
      }
      setBusy(false);
    },
    style: btn('transparent', 'var(--text)', {
      fontSize: 12.5,
      width: '100%'
    })
  }, "Issue a different code"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: 'var(--faint)',
      marginTop: 8,
      lineHeight: 1.5
    }
  }, "For when this one has been seen by someone it should not have. The old code stops working and they are emailed the new one.")), /*#__PURE__*/React.createElement(Card, {
    title: "History",
    help: "Received is when the form arrived. First answered is when it first left the unacknowledged stage \u2014 automatic now, so it usually matches. Last moved is the most recent stage change and who made it; 'system' means nobody pressed anything."
  }, kv('Received', fmtWhen(e.createdAt)), kv('First answered', e.handledAt ? fmtWhen(e.handledAt) : null), kv('Last moved', e.decidedAt ? fmtWhen(e.decidedAt) : null), kv('By', e.decidedBy)), e.tenantName && /*#__PURE__*/React.createElement(Card, {
    title: "Became"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700
    }
  }, e.tenantName), /*#__PURE__*/React.createElement("button", {
    onClick: () => goto('#/desks/' + e.tenantId),
    style: btn('transparent', 'var(--text)', {
      fontSize: 12
    })
  }, "Open desk"))), d.alsoFrom.length > 0 && /*#__PURE__*/React.createElement(Card, {
    title: 'Also from this address (' + d.alsoFrom.length + ')'
  }, d.alsoFrom.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.id,
    onClick: () => goto('#/applications/' + o.id),
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '8px 0',
      background: 'none',
      border: 'none',
      borderBottom: '1px solid var(--line2)',
      color: 'var(--text)',
      cursor: 'pointer',
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 12
    }
  }, o.reference), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, o.kind === 'early_access' ? 'application' : 'message', " \xB7 ", fmtDay(o.createdAt))), /*#__PURE__*/React.createElement(Pill, {
    tone: STAGE_TONE[o.status]
  }, stageTitle(stages, o.status))))))));
}

// ===================== APP =====================
function App() {
  const [phase, setPhase] = useState('loading'); // loading | login | ready
  const [tenants, setTenants] = useState([]);
  const [ov, setOv] = useState(null);
  const [audit, setAudit] = useState(null);
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const tab = route.tab;
  const [statusFilter, setStatusFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('joined');
  const [creating, setCreating] = useState(false);
  const [health, setHealth] = useState(null);
  const loadAll = async () => {
    const [t, o] = await Promise.all([api('/api/admin/tenants'), api('/api/admin/overview').catch(() => null)]);
    setTenants(t.tenants);
    setOv(o);
  };
  const boot = async () => {
    try {
      const me = await api('/api/admin/me');
      if (!me.isAdmin) {
        setPhase('login');
        return;
      }
      await loadAll();
      setPhase('ready');
    } catch (x) {
      setPhase('login');
    }
  };
  useEffect(() => {
    boot();
  }, []);
  useEffect(() => {
    if (tab === 'activity' && !audit) api('/api/admin/audit?limit=150').then(r => setAudit(r.events)).catch(() => setAudit([]));
  }, [tab]);
  /* Health is checked once on the way in and then every couple of minutes,
     because the point of the light in the corner is that you did not have
     to go and ask. Failure to check is not itself reported as an outage —
     that way lies a panel that cries wolf whenever a request is slow. */
  useEffect(() => {
    if (phase !== 'ready') return;
    let live = true;
    const beat = () => api('/api/admin/health').then(h => {
      if (live) setHealth(h);
    }).catch(() => {});
    beat();
    const t = setInterval(beat, 120000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [phase]);
  if (phase === 'loading') return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026");
  if (phase === 'login') return /*#__PURE__*/React.createElement(Login, {
    onIn: () => {
      setPhase('loading');
      boot();
    }
  });
  const counts = {
    desks: tenants.length,
    active: tenants.filter(t => t.status === 'active').length,
    trial: tenants.filter(t => t.status === 'trial').length,
    suspended: tenants.filter(t => t.status === 'suspended').length,
    // what is sitting on somebody — the number worth a badge in the nav
    waiting: ov && ov.funnel ? ov.funnel.waiting : 0,
    unread: ov && ov.funnel ? ov.funnel.unread : 0
  };
  let rows = tenants.filter(t => (statusFilter === 'all' || t.status === statusFilter) && (planFilter === 'all' || t.plan === planFilter));
  const s = q.trim().toLowerCase();
  if (s) rows = rows.filter(t => [t.name, t.slug, t.owner && t.owner.name, t.owner && t.owner.staffId, t.country].some(v => (v || '').toLowerCase().includes(s)));
  rows = rows.slice().sort((a, b) => {
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'plan') return (a.plan || '').localeCompare(b.plan || '');
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  const th = {
    textAlign: 'left',
    fontSize: 11,
    color: 'var(--faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '0 16px 10px',
    fontWeight: 600
  };
  const td = {
    padding: '13px 16px',
    borderTop: '1px solid var(--line2)',
    fontSize: 14,
    verticalAlign: 'middle'
  };
  const ctrl = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    fontSize: 13,
    color: 'var(--mute)'
  };

  /* The head of every page: its name, what it is for, and the one action
     that belongs to it. Read from the PAGES table rather than written out
     per page, which is what stopped "Start a desk" turning up on Billing. */
  const page = tab === 'settings' ? SETTINGS : PAGE(tab);
  const act = page.action;
  const invoicing = act && act.kind === 'invoice';
  // Stripe is not wired up yet. Say so on the button rather than offering
  // an action that would quietly do nothing.
  const stripeOn = !!(health && (health.checks.find(c => c.id === 'stripe') || {}).state === 'ok');
  const doAction = () => {
    if (act.kind === 'invite') setCreating(true);else goto('#/billing');
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      minHeight: '100vh'
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    counts: counts,
    tab: tab,
    health: health,
    onSettings: () => goto('#/settings')
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      height: '100vh',
      overflow: 'auto',
      padding: '24px 30px'
    }
  }, !route.id && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 24,
      fontWeight: 800,
      margin: 0
    }
  }, page.title), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 9
    }
  }, act && /*#__PURE__*/React.createElement("button", {
    onClick: doAction,
    disabled: invoicing && !stripeOn,
    title: invoicing && !stripeOn ? 'Connect Stripe first — there is nothing to invoice through yet.' : '',
    style: {
      padding: '9px 15px',
      border: 'none',
      borderRadius: 10,
      fontWeight: 700,
      fontSize: 13,
      background: invoicing && !stripeOn ? 'var(--line)' : 'var(--text)',
      color: invoicing && !stripeOn ? 'var(--faint)' : '#111',
      cursor: invoicing && !stripeOn ? 'not-allowed' : 'pointer'
    }
  }, act.label))), page.blurb && /*#__PURE__*/React.createElement("p", {
    style: {
      color: 'var(--mute)',
      fontSize: 13.5,
      margin: '8px 0 0',
      maxWidth: 680,
      lineHeight: 1.55
    }
  }, page.blurb)), !route.id && tab === 'overview' && /*#__PURE__*/React.createElement(OverviewPage, {
    ov: ov,
    health: health,
    counts: counts
  }), !route.id && tab === 'comms' && /*#__PURE__*/React.createElement(CommsPage, null), !route.id && tab === 'billing' && /*#__PURE__*/React.createElement(BillingPage, null), !route.id && tab === 'settings' && /*#__PURE__*/React.createElement(SettingsPage, null), route.id && (tab === 'compose' ? /*#__PURE__*/React.createElement(ComposePage, {
    kind: route.id,
    id: route.sub
  }) : tab === 'desks' ? /*#__PURE__*/React.createElement(DeskPage, {
    id: route.id,
    onChanged: loadAll
  }) : tab === 'people' ? /*#__PURE__*/React.createElement(PersonPage, {
    id: route.id,
    onChanged: loadAll
  }) : /*#__PURE__*/React.createElement(ApplicationPage, {
    id: route.id,
    onChanged: loadAll
  })), !route.id && tab === 'desks' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(StatRow, {
    ov: ov
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginBottom: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "Search desks, owners, email\u2026",
    style: {
      flex: 1,
      minWidth: 220,
      padding: '9px 14px',
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 10,
      color: 'var(--text)',
      fontSize: 13.5,
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("label", {
    style: ctrl
  }, "Status ", /*#__PURE__*/React.createElement("select", {
    value: statusFilter,
    onChange: e => setStatusFilter(e.target.value),
    style: {
      background: 'transparent',
      border: 'none',
      color: 'var(--text)',
      fontSize: 13,
      outline: 'none',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All (", counts.desks, ")"), /*#__PURE__*/React.createElement("option", {
    value: "active"
  }, "Active (", counts.active, ")"), /*#__PURE__*/React.createElement("option", {
    value: "trial"
  }, "Trial (", counts.trial, ")"), /*#__PURE__*/React.createElement("option", {
    value: "suspended"
  }, "Suspended (", counts.suspended, ")"))), /*#__PURE__*/React.createElement("label", {
    style: ctrl
  }, "Plan ", /*#__PURE__*/React.createElement("select", {
    value: planFilter,
    onChange: e => setPlanFilter(e.target.value),
    style: {
      background: 'transparent',
      border: 'none',
      color: 'var(--text)',
      fontSize: 13,
      outline: 'none',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All plans"), /*#__PURE__*/React.createElement("option", {
    value: "basic"
  }, "Basic"), /*#__PURE__*/React.createElement("option", {
    value: "pro"
  }, "Pro"), /*#__PURE__*/React.createElement("option", {
    value: "premium"
  }, "Premium"))), /*#__PURE__*/React.createElement("label", {
    style: ctrl
  }, "Sort ", /*#__PURE__*/React.createElement("select", {
    value: sort,
    onChange: e => setSort(e.target.value),
    style: {
      background: 'transparent',
      border: 'none',
      color: 'var(--text)',
      fontSize: 13,
      outline: 'none',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "joined"
  }, "Newest"), /*#__PURE__*/React.createElement("option", {
    value: "name"
  }, "Name"), /*#__PURE__*/React.createElement("option", {
    value: "plan"
  }, "Plan")))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      minWidth: 720
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...th,
      paddingTop: 14
    }
  }, "Desk"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Status"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Plan"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Owner"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "People"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Country"), /*#__PURE__*/React.createElement("th", {
    style: th
  }, "Joined"))), /*#__PURE__*/React.createElement("tbody", null, rows.map(t => /*#__PURE__*/React.createElement("tr", {
    key: t.id,
    onClick: () => goto('#/desks/' + t.id),
    style: {
      cursor: 'pointer'
    },
    onMouseEnter: e => e.currentTarget.style.background = 'var(--hover)',
    onMouseLeave: e => e.currentTarget.style.background = 'transparent'
  }, /*#__PURE__*/React.createElement("td", {
    style: td
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, t.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)'
    }
  }, t.slug)), /*#__PURE__*/React.createElement("td", {
    style: td
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: STATUS_TONE[t.status],
    dot: true
  }, t.status)), /*#__PURE__*/React.createElement("td", {
    style: td
  }, /*#__PURE__*/React.createElement(Pill, {
    tone: PLAN_TONE[t.plan]
  }, t.plan)), /*#__PURE__*/React.createElement("td", {
    style: td
  }, t.owner ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: t.owner.name
  }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block'
    }
  }, t.owner.name), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'block',
      fontFamily: MONO,
      fontSize: 11,
      color: 'var(--faint)'
    }
  }, t.owner.staffId))) : /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)'
    }
  }, "\u2014")), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      fontFamily: MONO,
      color: 'var(--mute)'
    }
  }, t.staffCount), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      color: 'var(--mute)'
    }
  }, t.country || '—'), /*#__PURE__*/React.createElement("td", {
    style: {
      ...td,
      fontFamily: MONO,
      fontSize: 12.5,
      color: 'var(--mute)'
    }
  }, fmtDay(t.createdAt)))), rows.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 7,
    style: {
      ...td,
      textAlign: 'center',
      color: 'var(--faint)',
      padding: 40
    }
  }, "No desks match."))))))), !route.id && tab === 'applications' && /*#__PURE__*/React.createElement(Pipeline, {
    kind: "early_access",
    onCounts: () => loadAll()
  }), !route.id && tab === 'inbox' && /*#__PURE__*/React.createElement(Inbox, {
    onChanged: loadAll
  }), !route.id && tab === 'activity' && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--card)',
      border: '1px solid var(--line)',
      borderRadius: 14,
      padding: '4px 16px'
    }
  }, !audit && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--mute)',
      fontFamily: MONO
    }
  }, "Loading\u2026"), audit && audit.map(e => /*#__PURE__*/React.createElement("div", {
    key: e.id,
    style: {
      display: 'flex',
      gap: 14,
      alignItems: 'baseline',
      padding: '11px 0',
      borderBottom: '1px solid var(--line2)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 11.5,
      color: 'var(--faint)',
      width: 130,
      flex: 'none'
    }
  }, fmtWhen(e.at)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: MONO,
      fontSize: 12.5,
      fontWeight: 700,
      width: 190,
      flex: 'none',
      color: e.action.indexOf('deleted') >= 0 || e.action.indexOf('suspend') >= 0 ? 'var(--amber)' : 'var(--text)'
    }
  }, e.action), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      flex: 1
    }
  }, e.tenantName, e.actorId && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--faint)'
    }
  }, " \xB7 ", e.actorId)))), audit && audit.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      color: 'var(--faint)'
    }
  }, "No activity yet."))), creating && /*#__PURE__*/React.createElement(CreateModal, {
    onClose: () => setCreating(false),
    onCreated: loadAll
  }));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));