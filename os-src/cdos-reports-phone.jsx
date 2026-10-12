/* ============================================================
   Phone Reports. Mounted only at 430px and under.

   The desk launcher stays the wide-window screen. The end-of-day
   figures are the server's close-of-day snapshot. This file does
   not add them up. Saving posts that snapshot; it is not kept
   only in localStorage.

   A figure the book did not answer is a word. A day with no deals
   is a zero the book did answer: the money tiles show 0.00 in the
   home currency, with "No deals yet" under the number. The drawer
   stays "Not counted yet", because nobody has counted it.

   TODO: switch the four tiles and the check rows to SummaryList
   once #126 is green. It does not fit yet: the tiles need a
   caption under the amount, and a check row needs its note under
   the title with the count on the right. SummaryList is a label
   and a value. Stack is the foundation, then #125, then #126.
   This file does not declare that name.

   Saved reports is written when the cashier taps save, not when
   a report is opened. The print stays in this tab (window.print
   on a node already on the page). A phone blocks window.open.
   The sheet button says "Save end of day". It does not say PDF.
   The file is the server's, fetched as a document, and the print
   view in this tab is the same snapshot so an A4 page is not blank.

   TODO: switch ReportRow to NavRow once Settings merges.
   The not-counted choice is a bottom sheet. FullScreenSheet is
   not in this foundation, and the shell's task and confirm
   sheets are a different shape, so this one uses the phone
   tokens. TODO: switch the saved note to Toast once Settings
   merges. This file does not declare those names.
   ============================================================ */
(function () {
  const { useState, useEffect, useLayoutEffect, useRef } = React;
  const HKEY = 'cdos_report_history_v1';
  const Ic = () => window.CDOS.Ic;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  /* The shell's formatter is the one phone amount. The code is split
     off so the card can draw it smaller than the number. */
  const phoneMoney = (n, ccy) => {
    const format = window.CDOS.formatPhoneMoney;
    if (!format) throw new Error('Phone money format did not load.');
    const formatted = format(n, ccy);
    if (!formatted) return null;
    const cut = formatted.lastIndexOf(' ');
    return { text: formatted.slice(0, cut), ccy: formatted.slice(cut + 1), full: formatted };
  };
  const shown = (n, ccy) => { const m = phoneMoney(n, ccy); return m ? m.full : ''; };
  /* A reporting line is a whole amount. 10,000.00 CAD is 10,000 CAD. */
  const wholeMoney = (n, ccy) => {
    const raw = typeof n === 'number' ? n : Number(String(n == null ? '' : n).replace(/,/g, ''));
    if (!Number.isFinite(raw)) return '';
    const full = shown(Math.round(raw), ccy);
    return full ? full.replace(/\.00(?=\s)/, '') : '';
  };
  /* The shared clock. 15:02 is 3:02 PM. A wall clock needs no zone.
     An instant needs the branch zone; a blank is not Toronto, and
     the formatter answers with an em dash, which this helper drops. */
  const phoneClock = (format, value, zone) => {
    const formatted = format(value, zone || undefined);
    if (!formatted || formatted === '\u2014') return '';
    return formatted;
  };
  const phoneTime = (value, zone) => {
    const format = window.CDOS.formatPhoneTime;
    if (typeof format !== 'function') throw new Error('Phone time format did not load.');
    return phoneClock(format, value, zone);
  };
  const phoneDate = (value, zone) => {
    const format = window.CDOS.formatPhoneDate;
    if (typeof format !== 'function') throw new Error('Phone date format did not load.');
    return phoneClock(format, value, zone);
  };
  const zoneOf = (p) => (p.settings && p.settings.timezone) || undefined;
  const money = (n, ccy) => { const m = phoneMoney(n, ccy); return m ? { text: m.text, ccy: m.ccy } : words('Not loaded'); };
  const words = (s) => ({ words: s });
  const rowAmount = (v) => !v ? '' : (v.words || (v.text + (v.ccy ? ' ' + v.ccy : '')));
  /* The name the desk already shows for this drawer. b01t3 and
     till-01 are ids. A missing name is left off the subtitle. */
  function tillName(p) {
    const station = p.station;
    if (!station || !station.tillId) return '';
    const branch = (p.branches || []).find(b => b && b.id === station.branchId);
    const till = branch && (branch.tills || []).find(t => t && t.id === station.tillId);
    const name = till && till.name ? String(till.name).replace(/\s+—.*/, '').trim() : '';
    return name && name !== station.tillId ? name : '';
  }
  /* The entity's pack. getRegime() is not a source: it fills in
     FINTRAC when the desk has not named a regulator. */
  function regulatorOf() {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    return pack && pack.regulator ? String(pack.regulator).trim() : '';
  }
  const keptSentence = (regulator) => 'Kept in Saved reports. Not sent to ' + (regulator || 'the regulator') + '.';
  const Caret = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>);

  function readHist() {
    const raw = localStorage.getItem(HKEY);
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('Saved reports could not be read.'); }
    return Array.isArray(parsed) ? parsed : [];
  }
  function writeHist(entry) {
    const hist = readHist();
    try { localStorage.setItem(HKEY, JSON.stringify([entry, ...hist].slice(0, 500))); }
    catch (e) { throw new Error('Saved reports is full. The sheet was not kept.'); }
  }

  /* The close-of-day snapshot, signed or still a preview. The screen
     does not add these figures up. A missing snapshot is not a zero. */
  function snapshotOf(p) {
    const close = p.closeDay || {};
    return (close.signoff && close.signoff.snapshot) || close.preview || null;
  }

  /* One description of today's card, shared by the home, the sheet,
     and the print view, so those three cannot disagree. */
  function todayModel(p, last) {
    const close = p.closeDay || { loading: true };
    const snap = snapshotOf(p);
    const home = (snap && snap.homeCurrency) || p.homeCcy || 'CAD';
    const canClose = !!p.canClose && !close.forbidden;
    const session = p.tillDay.session;
    const noSession = !p.tillDay.loading && !session && (p.dayBook.error === 'no till session' || !p.tillDay.error);
    const loadingDeals = !!(p.dayBook.loading || p.tillDay.loading || close.loading);
    const loadingDrawer = loadingDeals;
    const failed = !noSession && !!(p.dayBook.error || p.held.error || p.tillDay.error || close.error);
    const stale = !loadingDeals && !snap && last.current;
    const book = snap || (stale ? last.current.snap : null);
    const zone = (book && book.timeZone) || zoneOf(p);
    const sheetDate = (book && book.businessDate) || (session && session.businessDate) || '';
    const branch = (p.station && p.branches && (p.branches.find(b => b.id === p.station.branchId) || {}).name)
      || (p.settings && (p.settings.operatingName || p.settings.bizName)) || '';
    const till = tillName(p);
    const regulator = regulatorOf();
    const posted = book ? Number(book.posted) : null;
    const empty = posted === 0;
    let deals = null, taken = null, earned = null, drawer = null;
    if (!loadingDeals) {
      if (noSession) {
        deals = words('Open the till'); taken = words('Open the till'); earned = canClose ? words('Open the till') : null; drawer = words('Open the till');
      } else if (!book) {
        deals = words('Not loaded'); taken = words('Not loaded'); earned = canClose ? words('Not loaded') : null;
      } else {
        const voided = Number(book.reversed) || 0;
        deals = { text: String(posted), sub: voided ? (voided + ' voided') : 'None voided' };
        const noDeals = () => Object.assign(money(0, home), { sub: 'No deals yet' });
        if (empty) taken = noDeals();
        else if (book.volumeHome == null) taken = words('Not loaded');
        else {
          const parts = (book.volumeByCurrency || []).map(row => shown(row.amount, row.currency)).filter(Boolean);
          taken = Object.assign(money(book.volumeHome, home), { sub: 'in ' + home + (parts.length ? ' · ' + parts.join(', ') : '') });
        }
        if (canClose) {
          if (empty) earned = noDeals();
          else if (book.earningsHome == null) earned = words('Not loaded');
          else earned = Object.assign(money(book.earningsHome, home), { sub: book.realizedPnlHome != null ? 'Fees + margin' : 'Fees' });
        }
        if (book.notCounted) drawer = words('Not counted yet');
        else if (book.drawerHome == null) drawer = words('Not loaded');
        else drawer = Object.assign(money(book.drawerHome, home), { sub: 'Counted' });
      }
    }
    const currencies = ((book && book.drawerCurrencies) || []).map(row => {
      const off = row.variance != null && Math.abs(Number(row.variance)) >= 0.005;
      return {
        ccy: row.currency,
        amount: row.counted == null ? words('Not counted') : money(row.counted, row.currency),
        badge: row.counted == null ? null : (off ? 'Off' : 'Balanced'),
        tone: row.counted == null ? '' : (off ? 'neg' : 'pos'),
        variance: row.counted != null && off ? ((Number(row.variance) > 0 ? '+' : '') + shown(row.variance, row.currency)) : '',
        expected: row.expected != null ? ('Expected ' + shown(row.expected, row.currency)) : '',
      };
    });
    const line = book && book.reportingLine ? wholeMoney(book.reportingLine, book.reportingCurrency || home) : '';
    const large = !book ? words('Not loaded') : (line
      ? { text: book.singleDeals == null ? '' : String(book.singleDeals), sub: line + ' or more' }
      : words('No reporting line'));
    const countedFull = !!(book && !book.notCounted);
    return {
      loadingDeals, loadingDrawer, failed, stale, staleAt: stale ? last.current.at : null,
      date: phoneDate(sheetDate, zone), branch, till, who: (p.me && p.me.name) || '',
      shop: (book && book.shopName) || '',
      kept: keptSentence(regulator),
      deals, taken, earned, drawer,
      badge: loadingDrawer || !book ? null : (book.notCounted ? 'Not counted yet' : 'Drawer counted'),
      countedFull, notCounted: !!(book && book.notCounted),
      currencies, large,
      largeMeta: line ? ('Deals of ' + line + ' or more') : 'You file',
      singleTitle: line ? ('Single deals of ' + line + ' or more') : 'Single deals',
      singleDeals: book && book.singleDeals != null ? String(book.singleDeals) : '',
      lctr: book && book.lctrCustomers != null ? String(book.lctrCustomers) : '',
      gaps: book ? String(book.clientsMissingId) : '',
      requireCount: !!(p.settings && p.settings.requireCountOnClose),
      canClose, sessionOpen: !!session && !noSession, alreadySigned: !!(close.signoff),
      home, snap: book, zone,
    };
  }

  function Val({ v }) {
    if (!v) return <span className="sk sk-val" />;
    if (v.words) return <span className="words">{v.words}</span>;
    if (v.ccy) return <span className="num">{v.text}<span className="ccy">{v.ccy}</span></span>;
    return <span className="num">{v.text}</span>;
  }
  function Stat({ label, v }) {
    return (<div className="stat"><div className="lbl">{label}</div><div className="val"><Val v={v} /></div>{v && v.sub ? <div className="sub">{v.sub}</div> : (v ? null : <span className="sk sk-sub" />)}</div>);
  }
  /* TODO: switch to NavRow once Settings merges. */
  function ReportRow({ icon, title, meta, value, onClick }) {
    const Icon = Ic();
    return (
      <button type="button" className="nrow" onClick={onClick}>
        <span className="ic" aria-hidden="true"><Icon n={icon} s={20} /></span>
        <span className="tx"><span className="t">{title}</span><span className="d">{meta}</span></span>
        {value != null && value !== '' ? <span className="v">{value}</span> : <span />}
        <span className="cv"><Caret /></span>
      </button>
    );
  }

  const ROWS = [
    { id: 'register', title: 'All deals', meta: 'Every deal, voided ones too', icon: 'scroll' },
    { id: 'summary', title: 'Period summary', meta: 'Volume, fees and earnings', icon: 'bars' },
    { id: 'fintrac', title: 'Large cash report', icon: 'shield' },
    { id: 'pnl', title: 'Profit and loss', meta: 'Revenue and sales tax estimate', icon: 'coins' },
    { id: 'revenue', title: 'Earnings by teller', meta: 'Who earned what', icon: 'coins' },
    { id: 'kyc', title: 'Clients and ID', meta: 'Each client and their ID status', icon: 'id' },
  ];
  const RANGES = [['today', 'Today'], ['7d', 'Past 7 days'], ['30d', 'Past 30 days'], ['90d', 'This quarter'], ['365d', 'This year'], ['all', 'All time']];

  /* The print view is the server snapshot, so a phone-width page and
     the A4 page say the same thing. Teller and Owner are separate
     blocks: one row clips the second name. */
  function printSheet(m) {
    const snap = m.snap || {};
    const figure = (v) => !v ? '' : (v.words || (v.text + (v.ccy ? ' ' + v.ccy : '') + (v.sub ? ' · ' + v.sub : '')));
    const line = (label, v) => '<div class="ln"><b>' + esc(label) + '</b><span>' + esc(figure(v)) + '</span></div>';
    const rows = m.currencies.map(c => '<div class="ln"><b>' + esc(c.ccy) + '</b><span>'
      + esc(c.amount.words || (c.amount.text + ' ' + c.amount.ccy))
      + (c.badge ? ' · ' + esc(c.badge) : '')
      + (c.variance ? ' ' + esc(c.variance) : '')
      + (c.expected ? ' · ' + esc(c.expected) : '') + '</span></div>').join('');
    const when = [m.date, snap.signedAt ? phoneTime(snap.signedAt, snap.timeZone || m.zone) : ''].filter(Boolean).join(', ');
    const volumes = (snap.volumeByCurrency || []).map(row => '<div class="ln"><b>' + esc(row.currency) + '</b><span>'
      + esc(shown(row.amount, row.currency) || (row.amount + ' ' + row.currency)) + '</span></div>').join('');
    return '<h1>' + esc(m.shop || 'End of day') + '</h1><p>End of day</p><p>'
      + esc([when, m.till, m.who].filter(Boolean).join(' · ')) + '</p>'
      + line('Deals', m.deals) + line('Taken in', m.taken) + volumes
      + (m.canClose ? line('Earned', m.earned) : '')
      + line('In the drawer', m.drawer)
      + '<h2>Drawer at close</h2>' + rows
      + '<h2>Checks at close</h2>'
      + '<div class="ln"><b>' + esc(m.singleTitle) + '</b><span>' + esc(m.singleDeals) + '</span></div>'
      + '<div class="ln"><b>LCTR, 24-hour total</b><span>' + esc(m.lctr) + '</span></div>'
      + '<div class="ln"><b>Clients missing ID</b><span>' + esc(m.gaps) + '</span></div>'
      + '<p class="fine">' + esc(m.kept) + '</p>'
      + '<div class="sign"><b>Teller</b><span>________________________________</span></div>'
      + '<div class="sign"><b>Owner</b><span>________________________________</span></div>';
  }

  function PhoneReports(p) {
    const [view, setView] = useState('home');
    const [docId, setDocId] = useState(null);
    const [gate, setGate] = useState(false);
    const [phase, setPhase] = useState('idle');
    const [toast, setToast] = useState('');
    const [saveError, setSaveError] = useState('');
    const swiped = useRef(false);
    const [slow, setSlow] = useState(false);
    const [savedView, setSavedView] = useState(null);
    const [histTick, setHistTick] = useState(0);
    const last = useRef(null);
    const lock = useRef(false);
    const signKey = useRef('');
    const scroll = useRef(0);
    const sessionId = (p.tillDay.session && p.tillDay.session.sessionId) || '';
    const m = todayModel(p, last);
    if (!m.loadingDeals && !m.loadingDrawer && !m.failed && m.snap) {
      last.current = { snap: m.snap, at: new Date() };
    }
    const loading = m.loadingDeals || m.loadingDrawer;
    useEffect(() => {
      if (!loading) { setSlow(false); return; }
      const t = setTimeout(() => setSlow(true), 3000);
      return () => clearTimeout(t);
    }, [loading]);
    useEffect(() => {
      if (p.openSignal && p.openSignal.id === 'endofday' && (p.allowed || []).includes('endofday')) setView('sheet');
    }, [p.openSignal && p.openSignal.n]);
    useEffect(() => { lock.current = false; setPhase('idle'); }, [view]);
    useEffect(() => { signKey.current = ''; }, [sessionId]);
    /* Other reports are built with 10px captions. The phone sweep
       wants 12px. This runs before paint, on the document only. */
    useLayoutEffect(() => {
      if (view !== 'doc') return;
      const root = document.getElementById('cdos-phone-doc');
      if (!root) return;
      root.querySelectorAll('*').forEach(el => {
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px > 0 && px < 12) el.style.fontSize = '12px';
      });
    }, [view, docId, p.range]);
    useEffect(() => {
      if (!toast) return;
      const t = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(t);
    }, [toast]);

    const body = () => { const n = document.querySelector('#desktop .win.show.active .win-body'); return n || null; };
    const go = (next) => {
      const b = body();
      if (b && view === 'home') scroll.current = b.scrollTop;
      setView(next);
      if (next === 'home') requestAnimationFrame(() => { const b2 = body(); if (b2) b2.scrollTop = scroll.current; });
    };
    const openDoc = (id) => { p.setRange('today'); setDocId(id); go('doc'); };
    const openCount = () => {
      setGate(false);
      if (p.onOpenTill) p.onOpenTill();
    };
    /* The grab is the only drag handle. A pointer capture on the
       whole sheet steals the click from the buttons under it.
       The release is heard on the window: once the pointer leaves
       the handle, the handle itself never sees pointerup. */
    const onSheetDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const startY = e.clientY;
      swiped.current = false;
      const finish = (ev) => {
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('mouseup', finish, true);
        const y = ev.clientY;
        if (typeof y === 'number' && y - startY > 48) {
          swiped.current = true;
          setGate(false);
        }
      };
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('mouseup', finish, true);
    };

    function remember(kind, html) {
      const now = Date.now();
      writeHist({
        key: 'R' + now.toString(36), ms: now, type: kind, title: kind === 'endofday' ? 'End of day' : ((ROWS.find(r => r.id === kind) || {}).title || kind),
        icon: 'receipt', tone: '#46506B', range: p.range || 'today', rangeLabel: 'Today',
        at: phoneTime(new Date(), zoneOf(p)), n: m.deals && m.deals.text ? Number(m.deals.text) : 0, html,
      });
      const node = document.getElementById('phone-rep-print');
      if (!node) throw new Error('The print view is not on this screen.');
      node.innerHTML = html;
      setHistTick(t => t + 1);
    }
    function finishSave(kind) {
      setPhase('saved');
      setToast(kind === 'endofday' ? 'End of day saved. Find it in Saved reports.' : 'Saved. Find it in Saved reports.');
      setGate(false);
      try { window.print(); }
      catch (err) { setSaveError('Saved. The print view did not open. ' + (err && err.message ? err.message : '')); }
    }
    /* lock is set before the first await. Two clicks in the same
       turn both see it; taking it off sends the form twice. */
    function save(kind) {
      if (lock.current || loading || m.failed) return;
      if (kind === 'endofday') {
        if (!m.canClose || !m.sessionOpen || m.alreadySigned) return;
        if (m.notCounted && !gate) { setGate(true); return; }
      }
      lock.current = true;
      setPhase('saving');
      setSaveError('');
      if (kind !== 'endofday') {
        try {
          const html = (document.getElementById('cdos-phone-doc') || {}).innerHTML || '';
          if (!html) throw new Error('Nothing to save yet.');
          remember(kind, html);
          finishSave(kind);
        } catch (err) {
          lock.current = false;
          setPhase('idle');
          setSaveError(err && err.message ? err.message : 'Could not save.');
        }
        return;
      }
      const backend = window.CDOS.Backend;
      if (!backend || !backend.saveCloseOfDay) {
        lock.current = false;
        setPhase('idle');
        setSaveError('The desk is not signed in.');
        return;
      }
      if (!signKey.current) signKey.current = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sign-' + Date.now());
      backend.saveCloseOfDay({ idempotencyKey: signKey.current, notCounted: !!m.notCounted })
        .then(saved => {
          if (p.onSigned) p.onSigned(saved);
          const signed = saved && saved.snapshot ? Object.assign({}, m, {
            snap: saved.snapshot,
            shop: saved.snapshot.shopName || m.shop,
            date: phoneDate(saved.snapshot.businessDate, saved.snapshot.timeZone),
            notCounted: !!saved.snapshot.notCounted,
            drawer: saved.snapshot.notCounted ? words('Not counted yet') : m.drawer,
          }) : m;
          remember('endofday', printSheet(signed));
          finishSave('endofday');
        })
        .catch(err => {
          lock.current = false;
          setPhase('idle');
          setSaveError(err && err.message ? err.message : 'Could not save.');
        });
    }

    let hist = [], histError = '';
    try { hist = readHist(); } catch (e) { histError = e.message; }
    void histTick;
    const allowed = p.allowed || [];
    const visible = ROWS.filter(r => allowed.includes(r.id));
    const hidden = ROWS.length - visible.length + (allowed.includes('endofday') ? 0 : 1);
    const showSavedRow = allowed.length > 2;
    const ready = !loading && !m.failed;
    const uncounted = !!m.notCounted;
    const endOfDay = view === 'home' || view === 'sheet';
    const showSave = !endOfDay || p.tillDay.loading || (p.closeDay && p.closeDay.loading) || (m.sessionOpen && m.canClose);
    const signed = m.alreadySigned || phase === 'saved';
    const buttonLabel = phase === 'saving' ? 'Saving...' : (signed ? 'Saved' : (view === 'sheet' ? 'Save end of day' : (view === 'doc' ? 'Save and print' : "Save today's end of day")));
    const reason = loading ? "Ready once today's figures load." : (m.failed ? 'Could not load today\'s figures.' : (saveError || ''));
    const Phone = window.CDOS.Phone;
    if (!Phone || !Phone.ListRow || !Phone.ListSection || !Phone.StickyAction) throw new Error('Phone shell did not load.');
    const Row = Phone.ListRow;
    const Section = Phone.ListSection;
    const blocked = !ready || phase !== 'idle' || gate || (endOfDay && m.alreadySigned);

    return (
      <div className="phone-reports" data-phone-reports data-app="reports" data-state={loading ? 'loading' : (m.failed ? 'error' : 'ready')} data-view={view}>
        {view !== 'home' && (
          <button type="button" className="crumb" onClick={() => { setGate(false); if (view === 'saved-one') { setView('saved'); return; } setSavedView(null); go('home'); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
            Reports
          </button>
        )}
        {view === 'home' && (
          <button type="button" className="crumb" onClick={() => p.onShowMore && p.onShowMore()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
            More
          </button>
        )}
        {slow && loading && (
          <div className="banner info" role="status"><div><b>Waking the server</b>This can take up to a minute. Keep this screen open.</div></div>
        )}
        {m.failed && (
          <div className="banner err" role="alert"><div><b>Could not load today's figures. Check the connection and try again.</b>
            {m.staleAt ? <span className="sub">Last loaded {phoneTime(m.staleAt, zoneOf(p))}</span> : null}
          </div></div>
        )}
        {saveError && <div className="banner err" role="alert">{saveError}</div>}
        {histError && <div className="banner err" role="alert">{histError}</div>}

        {view === 'home' && (
          <div data-reports-home>
            <h1>Reports</h1>
            <p className="page-sub">Today, {m.date}{m.branch ? ' · ' + m.branch : ''}</p>
            <section className="card eod" aria-label="Today's end of day">
              <div className="eod-h"><h2>Today's end of day</h2>{m.badge ? <span className={'badge ' + (m.badge === 'Drawer counted' ? 'pos' : 'warn')}>{m.badge}</span> : <span className="sk sk-badge" />}</div>
              <div className="stats four">
                <Stat label="Deals" v={m.deals} />
                <Stat label="Taken in" v={m.taken} />
                {m.canClose || loading ? <Stat label="Earned" v={m.earned} /> : null}
                <Stat label="In the drawer" v={m.drawer} />
              </div>
              <button type="button" className="open" onClick={() => go('sheet')}>See the full sheet<Caret /></button>
            </section>
            <div className="sec-label">Other reports</div>
            <section className="list">
              {visible.map(r => (
                <ReportRow key={r.id} icon={r.icon} title={r.title} meta={r.id === 'fintrac' ? m.largeMeta : r.meta} onClick={() => openDoc(r.id)} />
              ))}
              {showSavedRow && <ReportRow icon="scroll" title="Saved reports" meta="Every report you saved" value={histError ? '' : String(hist.length)} onClick={() => go('saved')} />}
            </section>
            {hidden > 0 && <p className="ask">Ask an owner for other reports</p>}
            {m.failed && <button type="button" className="btn btn-secondary" onClick={() => p.onRetry && p.onRetry()}>Try again</button>}
          </div>
        )}

        {view === 'sheet' && (
          <div data-reports-sheet>
            <h1>End of day</h1>
            <p className="page-sub">Today, {m.date}{m.till ? ' · ' + m.till : ''}{m.who ? ' · ' + m.who : ''}</p>
            <section className="stats four">
              <Stat label="Deals" v={m.deals} />
              <Stat label="Taken in" v={m.taken} />
              {m.canClose || loading ? <Stat label="Earned" v={m.earned} /> : null}
              <Stat label="Large cash deals" v={loading ? null : m.large} />
            </section>
            <div className="phone-shell">
              <section className="phone-section">
                <div className="phone-sec rep-drawer-sec">
                  <span>{uncounted ? 'Drawer at close · Not counted yet' : 'Drawer at close'}</span>
                  {uncounted
                    ? <button type="button" className="rep-count-now" onClick={openCount}>Count now</button>
                    : (m.drawer && m.drawer.sub ? <span className="phone-sec-meta">{m.drawer.sub}</span> : null)}
                </div>
                <div className="phone-list">
                  {m.currencies.length === 0 && <p className="empty-line">{loading ? 'Reading the drawer…' : 'Not counted yet'}</p>}
                  {m.currencies.map(c => (
                    <Row key={c.ccy} title={c.ccy} subtitle={[c.variance, c.expected].filter(Boolean).join(' · ') || undefined} amount={rowAmount(c.amount)} badge={c.badge ? { label: c.badge, tone: c.tone } : undefined} />
                  ))}
                </div>
              </section>
              <Section title="Checks at close" meta="This till">
                <Row className="rep-check" title={m.singleTitle} subtitle="One deal, this till" amount={loading ? '' : m.singleDeals} />
                <Row className="rep-check" title="LCTR, 24-hour total" subtitle="Same customer, same day" amount={loading ? '' : m.lctr} />
                <Row className="rep-check" title="Clients missing ID" subtitle="Clients who dealt today" amount={loading ? '' : m.gaps} />
              </Section>
            </div>
          </div>
        )}

        {view === 'doc' && (
          <div data-reports-doc>
            <h1>{(ROWS.find(r => r.id === docId) || {}).title || 'Report'}</h1>
            <div className="chips" role="tablist">
              {RANGES.map(([id, label]) => (
                <button type="button" key={id} className={'chip' + (p.range === id ? ' on' : '')} onClick={() => p.setRange(id)}>{label}</button>
              ))}
            </div>
            <div className="phone-rep-doc" id="cdos-phone-doc">{p.renderDoc(docId)}</div>
          </div>
        )}

        {view === 'saved' && (
          <div data-reports-saved>
            <h1>Saved reports</h1>
            {hist.length === 0 && <p className="empty-line">Nothing saved yet. A sheet is kept when you tap save.</p>}
            <section className="list">
              {hist.map(e => (
                <ReportRow key={e.key} icon="receipt" title={e.title || 'Report'} meta={e.at || ''} onClick={() => { setSavedView(e); go('saved-one'); }} />
              ))}
            </section>
          </div>
        )}
        {view === 'saved-one' && savedView && (
          <div className="phone-rep-doc" dangerouslySetInnerHTML={{ __html: savedView.html || '' }} />
        )}

        {gate && ReactDOM.createPortal(
          <div
            className="rep-scrim"
            data-reports-uncounted
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setGate(false); }}
          >
            <div
              className="rep-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rep-count-title"
              onMouseDown={(e) => e.stopPropagation()}
              onClickCapture={(e) => { if (!swiped.current) return; swiped.current = false; e.preventDefault(); e.stopPropagation(); }}
            >
              <div className="rep-grab-hit" onPointerDown={onSheetDown}>
                <div className="rep-grab" aria-hidden="true" />
              </div>
              <h2 id="rep-count-title">The drawer is not counted yet</h2>
              <p>{m.requireCount ? 'Count it first. This desk requires a count before closing the day.' : 'Count it first, or save without a count.'}</p>
              <button type="button" className="phone-sticky-btn" onClick={openCount}>Count the drawer</button>
              {!m.requireCount && <button type="button" className="btn btn-secondary" onClick={() => save('endofday')}>Save without a count</button>}
            </div>
          </div>,
          document.body
        )}

        {view !== 'saved' && view !== 'saved-one' && (
          <div className="rep-cta">
            {toast && (
              /* TODO: switch this note to Toast once Settings merges. */
              <div className="rep-toast" role="status" data-reports-toast>
                <span>{toast}</span>
                <button type="button" onClick={() => { setToast(''); go('saved'); }}>View</button>
              </div>
            )}
            {showSave ? (
              <div data-reports-save>
                <Phone.StickyAction label={buttonLabel} disabled={blocked} disabledReason={blocked && !signed ? reason : ''} onClick={() => save(view === 'doc' ? docId : 'endofday')} />
              </div>
            ) : (endOfDay && !loading ? <p className="note">{m.canClose ? 'Open the till before saving the day.' : 'Ask an owner to close the day.'}</p> : null)}
            {view === 'sheet' && ready && <p className="note">{m.kept}</p>}
          </div>
        )}
        <div id="phone-rep-print" className="phone-rep-print" />
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneReports });
})();
