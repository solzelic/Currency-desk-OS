/* Phone Cheques. Mounted only at 430px and under.
   The desktop Cheques screen is the other return in cdos-cheques-app.jsx.

   The list, the two cards, the chips and the Cash a cheque button are
   the shared phone shell (docs/PHONE_SHELL.md). Amounts go through
   formatPhoneMoney. The fee and the cash to hand over are what feeFor
   already computes; the book stores those amounts and the toast reads
   the net the book sent back. A name comes from the client list, which
   is loaded before the row is labelled. One idempotency key lives for as long as
   this form is open, so a second tap is the same cashing.
   See docs/CHEQUE_CASHING.md. */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;
  const K = function () { return window.CDOS._cheques; };
  const money = function (amount, currency) { return window.CDOS.formatPhoneMoney(amount, currency); };
  const Toast = window.CDOS.Toast;
  const Toggle = window.CDOS.Toggle;
  const home = function () { return (window.CDOS.deskHomeCcy && window.CDOS.deskHomeCcy()) || 'CAD'; };

  function usePhoneLayout() {
    const query = '(max-width: 430px)';
    const [on, setOn] = useState(function () { return window.matchMedia(query).matches; });
    useEffect(function () {
      const media = window.matchMedia(query);
      const apply = function () { setOn(media.matches); };
      apply();
      media.addEventListener('change', apply);
      return function () { media.removeEventListener('change', apply); };
    }, []);
    return on;
  }

  const NOT_FOUND = 'Client not found';

  function humanName(value) {
    if (!value || value === 'Customer' || value === NOT_FOUND) return false;
    if (/^(cus|cust|usr|chq|tx)_/i.test(value)) return false;
    if (/^[0-9a-f-]{16,}$/i.test(value)) return false;
    return true;
  }

  /* The Clients screen is what used to load this list. A cheque window
     can open before that screen has mounted, so the store is still
     unknown. Load first, then decide the name. Same order as the
     phone deal's Record the ID (#106). */
  function inDirectory(name, dir) {
    if (!name) return false;
    if (dir.shared && dir.shared.byName && dir.shared.byName(name).length) return true;
    const key = String(name).trim().toLowerCase();
    return Object.keys(dir.projected || {}).some(function (entry) {
      return entry.trim().toLowerCase() === key;
    });
  }

  async function clientDirectory(clients) {
    const shared = window.CDOS.ClientRecords;
    let loaded = false;
    let trouble = '';
    let projected = clients || {};
    if (shared && shared.load) {
      try {
        await shared.load(true);
      } catch (error) {
        trouble = error && error.message ? error.message : 'The client list did not load.';
      }
      if (!trouble && shared.trouble && shared.trouble()) trouble = shared.trouble();
      if (!trouble && shared.serverBacked && shared.serverBacked()) {
        loaded = true;
        projected = shared.project(clients || {});
      }
    }
    const byId = {};
    Object.keys(projected || {}).forEach(function (name) {
      const id = projected[name] && projected[name].ledgerCustomerId;
      if (id && humanName(name)) byId[id] = name;
    });
    const ledgerNames = {};
    const request = window.CDOS.Backend && window.CDOS.Backend.request;
    if (request) {
      try {
        const body = await request('/api/ledger/customers');
        (body.customers || []).forEach(function (customer) {
          if (customer && customer.customerId && humanName(customer.name)) ledgerNames[customer.customerId] = customer.name;
        });
      } catch (error) {
        if (!trouble) trouble = error && error.message ? error.message : 'The client list did not load.';
      }
    }
    return { loaded: loaded, trouble: trouble, projected: projected, byId: byId, ledgerNames: ledgerNames, shared: loaded ? shared : null };
  }

  function resolveCustomer(row, dir, cached) {
    if (dir.byId[row.customerId]) return dir.byId[row.customerId];
    const ledgerName = dir.ledgerNames[row.customerId];
    if (dir.shared && ledgerName && dir.shared.byName) {
      const matches = dir.shared.byName(ledgerName);
      if (matches && matches.length && humanName(matches[0].legalName)) return matches[0].legalName;
    }
    if (ledgerName && inDirectory(ledgerName, dir)) {
      const key = ledgerName.trim().toLowerCase();
      const hit = Object.keys(dir.projected).find(function (name) { return name.trim().toLowerCase() === key; });
      if (hit) return hit;
    }
    if (humanName(cached) && (!dir.loaded || inDirectory(cached, dir))) return cached;
    /* The till already stored this person's name. An empty client file
       is not a deletion. Client not found is an id that neither the
       client list nor the book can name, after the list has loaded. */
    if (humanName(ledgerName)) return ledgerName;
    if (dir.loaded) return NOT_FOUND;
    if (humanName(cached)) return cached;
    return '';
  }

  function shownName(cheque) {
    if (!cheque) return '';
    if (cheque.customer === NOT_FOUND) return NOT_FOUND;
    if (humanName(cheque.customer)) return cheque.customer;
    return '';
  }

  /* The calendar day in the string. A local midnight run through
     toISOString moves the hold back one day east of UTC. */
  function shortDay(iso) {
    const day = String(iso || '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match) return day;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function returnMonth(cheque) {
    const event = (cheque.timeline || []).find(function (entry) { return entry.status === 'returned'; });
    return String((event && event.ts) || cheque.receivedDate || '').slice(0, 7);
  }

  function metaLine(cheque) {
    const kind = cheque.typeLabel || 'Cheque';
    if (cheque.status === 'held') return kind + ', held to ' + shortDay(cheque.holdUntil);
    if (cheque.status === 'returned') return kind + ', bounced';
    if (cheque.status === 'reversed') return kind + ', reversed';
    return kind;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function idLine(clients, name) {
    const record = clients && clients[name];
    if (!record || !record.idType || !record.idNum) return 'No ID on file';
    if (record.idExpiry && record.idExpiry < window.CDOS.TODAY) return 'ID expired';
    return 'ID on file';
  }

  function newKey() {
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ('k' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  function keepImage(chequeId, dataUrl) {
    if (!chequeId || !dataUrl) return;
    const all = JSON.parse(localStorage.getItem(K().IKEY) || '{}') || {};
    all[chequeId] = dataUrl;
    localStorage.setItem(K().IKEY, JSON.stringify(all));
  }

  function PhoneCheques({ rows, setRows, clients, setClients, settings, me, log, cheques, setCheques, schedule, captureSignal, onTillChanged }) {
    const P = window.CDOS.Phone;
    if (!P || !P.Screen || !window.CDOS.formatPhoneMoney) {
      throw new Error('Phone Cheques: the phone shell did not load.');
    }
    const ccy = home();
    const book = K().ledger();
    const [phase, setPhase] = useState(book ? 'loading' : 'ready');
    const [loadErr, setLoadErr] = useState('');
    const [nameNote, setNameNote] = useState('');
    const [filter, setFilter] = useState('all');
    const [q, setQ] = useState('');
    const [flow, setFlow] = useState(false);
    const [step, setStep] = useState(1);
    const [customer, setCustomer] = useState('');
    const [custQ, setCustQ] = useState('');
    const [typeId, setTypeId] = useState('');
    const [amount, setAmount] = useState('');
    const [chequeNumber, setChequeNumber] = useState('');
    const [maker, setMaker] = useState('');
    const [bank, setBank] = useState('');
    const [endorsed, setEndorsed] = useState(false);
    const [image, setImage] = useState(null);
    const [imgErr, setImgErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [errDetail, setErrDetail] = useState('');
    const [toast, setToast] = useState('');
    const [detailId, setDetailId] = useState(null);
    const [ask, setAsk] = useState('');
    const [why, setWhy] = useState('');
    const attempt = useRef(null);
    const posting = useRef(false);
    const actKey = useRef('');
    const gen = useRef(0);
    const clientsRef = useRef(clients);
    const namesByCheque = useRef({});
    clientsRef.current = clients;

    const reload = async function () {
      const live = K().ledger();
      if (!live) { setPhase('ready'); return; }
      const ticket = ++gen.current;
      setPhase('loading');
      setLoadErr('');
      setNameNote('');
      try {
        const answer = await live.loadCheques();
        const dir = await clientDirectory(clientsRef.current);
        if (ticket !== gen.current) return;
        if (dir.trouble) {
          setNameNote(dir.trouble);
          log && log('Cheque names unavailable', dir.trouble);
        }
        if (dir.loaded && setClients && dir.shared) {
          const shared = dir.shared;
          setClients(function (previous) { return shared.project(previous || {}); });
        }
        setCheques(function (prev) {
          const kept = {};
          (prev || []).forEach(function (cheque) {
            if (cheque && cheque.chequeId && humanName(cheque.customer)) kept[cheque.chequeId] = cheque.customer;
          });
          return (answer.cheques || []).map(function (raw) {
            const row = K().fromServer(raw);
            const named = resolveCustomer(row, dir, kept[row.chequeId] || namesByCheque.current[row.chequeId]);
            if (humanName(named)) {
              row.customer = named;
              namesByCheque.current[row.chequeId] = named;
            } else row.customer = named === NOT_FOUND ? NOT_FOUND : '';
            return row;
          });
        });
        setPhase('ready');
      } catch (error) {
        if (ticket !== gen.current) return;
        setPhase('error');
        setLoadErr(error && error.message ? error.message : 'The cheque list did not load.');
      }
    };

    useEffect(function () { reload(); }, []);

    const openFlow = function () {
      attempt.current = null;
      posting.current = false;
      setStep(1); setCustomer(''); setCustQ(''); setTypeId(''); setAmount('');
      setChequeNumber(''); setMaker(''); setBank(''); setEndorsed(false);
      setImage(null); setImgErr(''); setErr(''); setErrDetail(''); setBusy(false);
      setFlow(true);
    };
    const openRef = useRef(openFlow);
    openRef.current = openFlow;
    const seen = useRef(0);
    useEffect(function () {
      if (captureSignal && captureSignal !== seen.current) {
        seen.current = captureSignal;
        openRef.current();
      }
    }, [captureSignal]);

    const names = useMemo(function () {
      const set = new Set(Object.keys(clients || {}));
      (rows || []).forEach(function (row) { if (row.customer) set.add(row.customer); });
      return Array.from(set).sort();
    }, [clients, rows]);

    const month = String(window.CDOS.TODAY || '').slice(0, 7);
    /* A real desk never shows the sample set. Those rows are not
       stamped by the ledger. */
    const listAll = (cheques || []).filter(function (c) { return !book || c.server; });
    const sample = !book;
    const held = listAll.filter(function (c) { return c.status === 'held'; });
    const bounced = listAll.filter(function (c) { return c.status === 'returned' && returnMonth(c) === month; });
    const exposure = held.reduce(function (sum, c) { return sum + Number(c.netCad || 0); }, 0);
    const losses = bounced.reduce(function (sum, c) { return sum + Number(c.netCad || 0); }, 0);
    const counts = {
      all: listAll.length,
      held: held.length,
      cleared: listAll.filter(function (c) { return c.status === 'cleared'; }).length,
      returned: listAll.filter(function (c) { return c.status === 'returned'; }).length,
    };
    const needle = q.trim().toLowerCase();
    const shown = listAll.filter(function (c) {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!needle) return true;
      return [c.customer, c.maker, c.ref, c.chequeNumber].join(' ').toLowerCase().indexOf(needle) >= 0;
    }).sort(function (a, b) { return String(b.receivedDate + b.ref).localeCompare(String(a.receivedDate + a.ref)); });

    const type = (schedule || []).find(function (item) { return item.id === typeId; }) || null;
    const amtN = parseFloat(String(amount).replace(/,/g, ''));
    const amtOk = isFinite(amtN) && amtN > 0;
    const fee = type && amtOk ? +K().feeFor(amtN, type).toFixed(2) : 0;
    const net = amtOk ? +(amtN - fee).toFixed(2) : 0;
    const minHold = Math.max(0, +((settings && settings.chequeMinHoldDays) || 0));
    const holdDays = type ? Math.max(minHold, +type.holdDays || 0) : minHold;
    const photoRequired = !!(settings && settings.chequeRequirePhoto);
    const canStep1 = !!(customer.trim() && type && amtOk && net >= 0);
    const canStep2 = !!(chequeNumber.trim() && maker.trim() && endorsed && (!photoRequired || image));
    const tiles = (schedule || []).map(function (item) {
      const days = +item.holdDays || 0;
      const hold = days === 0 ? 'no hold' : (days === 1 ? '1 day hold' : days + ' day hold');
      return { id: item.id, label: item.label, detail: Number(item.feePct).toFixed(1) + '%, ' + hold };
    });
    const pctFee = type && amtOk ? amtN * (+type.feePct || 0) / 100 : 0;
    const minApplies = !!(type && (+type.feeMin || 0) > 0 && (+type.feeMin) >= pctFee);
    const feeLabel = !type ? 'Our fee' : (minApplies ? 'Our fee (minimum)' : 'Our fee (' + Number(type.feePct).toFixed(1) + '%)');
    const matches = names.filter(function (name) {
      return !custQ.trim() || name.toLowerCase().indexOf(custQ.trim().toLowerCase()) >= 0;
    }).slice(0, 8);
    const typed = custQ.trim();
    const exact = names.some(function (name) { return name.toLowerCase() === typed.toLowerCase(); });
    const give = amtOk && type && net >= 0 ? money(net, ccy) : '';
    const heldFigure = held.length ? (money(exposure, ccy) || 'Amount unavailable') : 'Nothing out';
    const heldSub = held.length === 0 ? 'No cheques on hold' : (held.length === 1 ? '1 cheque on hold' : held.length + ' cheques on hold');
    const lossFigure = bounced.length ? (money(losses, ccy) || 'Amount unavailable') : 'None';
    const lossSub = bounced.length === 0 ? 'No cheques bounced' : (bounced.length === 1 ? '1 cheque' : bounced.length + ' cheques');
    const BADGE = { held: ['warn', 'On hold'], cleared: ['pos', 'Cleared'], returned: ['neg', 'Returned'], reversed: ['neutral', 'Reversed'] };
    const StepHeader = window.CDOS.StepHeader;
    const ChoiceTiles = window.CDOS.ChoiceTiles;
    const AmountField = window.CDOS.AmountField;
    const SummaryList = window.CDOS.SummaryList;

    const detail = detailId ? listAll.find(function (c) { return c.id === detailId || c.chequeId === detailId; }) : null;
    const act = async function (kind, call, done) {
      if (posting.current || !detail) return;
      const live = K().ledger();
      if (!live) {
        setErr('Nothing was saved. This desk has no ledger to post to.');
        return;
      }
      posting.current = true;
      setBusy(true);
      setErr('');
      try {
        if (!actKey.current) actKey.current = newKey();
        const answer = await call(live, 'web-chq-' + kind + ':' + actKey.current);
        const refreshed = await live.loadCheques();
        const dir = await clientDirectory(clientsRef.current);
        if (dir.trouble) {
          setNameNote(dir.trouble);
          log && log('Cheque names unavailable', dir.trouble);
        }
        gen.current += 1;
        setCheques(function (prev) {
          const kept = {};
          (prev || []).forEach(function (cheque) {
            if (cheque && cheque.chequeId && humanName(cheque.customer)) kept[cheque.chequeId] = cheque.customer;
          });
          return (refreshed.cheques || []).map(function (raw) {
            const row = K().fromServer(raw);
            const named = resolveCustomer(row, dir, kept[row.chequeId] || namesByCheque.current[row.chequeId]);
            if (humanName(named)) {
              row.customer = named;
              namesByCheque.current[row.chequeId] = named;
            } else row.customer = named === NOT_FOUND ? NOT_FOUND : '';
            return row;
          });
        });
        if (answer && answer.balances) onTillChanged && onTillChanged(answer.balances);
        log && log(done, detail.ref);
        setDetailId(null);
        setAsk('');
        setWhy('');
        actKey.current = '';
        setToast(done);
      } catch (error) {
        const sentence = K().deskSentence(error && error.message);
        setErr(sentence || 'Nothing was posted.');
      } finally {
        posting.current = false;
        setBusy(false);
      }
    };

    const face = function (c) {
      if (c.amount == null || !isFinite(Number(c.amount))) return '';
      return money(c.amount, c.ccy || ccy);
    };
    const paidLine = function (c) {
      if (c.netCad == null || !isFinite(Number(c.netCad))) return '';
      const figure = money(c.netCad, c.ccy || ccy);
      return figure ? ('Paid ' + figure) : '';
    };

    return (
      <>
        <P.Screen
          app="cheques"
          title="Cheques"
          sticky={<P.StickyAction label="Cash a cheque" onClick={openFlow} />}
        >
          {phase === 'loading' && <P.LoadingState label="Loading cheques" />}
          {phase === 'error' && <P.ErrorState message={loadErr || 'The cheque list did not load.'} onRetry={reload} />}
          {phase === 'ready' && (
            <>
              <P.SummaryCards columns={2} cards={[
                { id: 'held', label: 'Paid, not cleared yet', value: heldFigure, caption: heldSub, onClick: function () { setFilter('held'); } },
                { id: 'bounced', label: 'Bounced this month', value: lossFigure, caption: lossSub, onClick: function () { setFilter('returned'); } },
              ]} />
              <P.Search value={q} onChange={setQ} placeholder="Find a name or cheque number" label="Find a name or cheque number" />
              <P.FilterChips
                value={filter}
                onChange={setFilter}
                chips={[
                  { id: 'all', label: 'All', count: counts.all },
                  { id: 'held', label: 'On hold', count: counts.held },
                  { id: 'cleared', label: 'Cleared', count: counts.cleared },
                  { id: 'returned', label: 'Returned', count: counts.returned },
                ]}
              />
              {sample && <p className="phq-demo" role="status" data-phone-cheque="sample">Sample cheques. This is not the desk's book.</p>}
              {nameNote && <p className="phq-warn" role="status">The client list did not load. {nameNote}</p>}
              {!listAll.length && (
                <div data-phone-cheque="empty">
                  <P.EmptyState title="No cheques yet" message="Cash a cheque to start tracking it." />
                </div>
              )}
              {!!listAll.length && !shown.length && <p className="phq-note">No cheque matches that.</p>}
              {!!shown.length && (
                <div className="phone-list">
                  {shown.map(function (c) {
                    const badge = BADGE[c.status] || BADGE.held;
                    return (
                      <P.ListRow
                        key={c.chequeId || c.id}
                        className="phq-row"
                        title={shownName(c)}
                        subtitle={metaLine(c)}
                        note={c.ref || ''}
                        amount={face(c) ? ('Cheque ' + face(c)) : ''}
                        meta={paidLine(c)}
                        badge={{ label: badge[1], tone: badge[0] }}
                        onClick={function () { actKey.current = ''; setAsk(''); setWhy(''); setErr(''); setDetailId(c.chequeId || c.id); }}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </P.Screen>
        <Toast text={toast} onDone={function () { setToast(''); }} />
        {detail && ReactDOM.createPortal(
          <div className="phq-sheet" role="dialog" aria-label={detail.ref} data-app="cheques">
            <div className="phq-sheet-h">
              <button type="button" onClick={function () { setDetailId(null); setAsk(''); setErr(''); }}>Close</button>
              <h2>{detail.ref}</h2>
              <span />
            </div>
            <div className="phq-sheet-b">
              <SummaryList rows={[
                { label: 'Customer', value: shownName(detail) },
                { label: 'Status', value: (BADGE[detail.status] || BADGE.held)[1] },
                { label: 'Cheque amount', value: money(detail.amount, detail.ccy || ccy) },
                { label: 'Fee kept', value: money(detail.feeCad, detail.ccy || ccy) },
                { label: 'Cash handed over', value: money(detail.netCad, detail.ccy || ccy), big: true },
                { label: 'Who wrote it', value: detail.maker },
                { label: 'Number', value: detail.chequeNumber },
                detail.draweeBank ? { label: 'Bank', value: detail.draweeBank } : null,
                { label: 'Hold', value: detail.holdUntil ? shortDay(detail.holdUntil) : 'No hold' },
              ].filter(Boolean)} />
              <h3 className="phq-label">What happened</h3>
              <ul className="phq-time">
                {(detail.timeline || []).map(function (event, index) {
                  const label = (K().STATUS[event.status] && K().STATUS[event.status].label) || event.status;
                  const when = event.at ? K().historyTime(event.at) : (event.ts || '');
                  return <li key={index}><b>{label}</b><span>{when} · {event.by || 'the desk'}{event.note ? ' — ' + event.note : ''}</span></li>;
                })}
              </ul>
              {detail.status === 'held' && ask === '' && (
                <>
                  <button type="button" className="phq-btn" disabled={busy} onClick={function () { act('clear', function (live, key) { return live.clearCheque(detail.chequeId, { idempotencyKey: key }); }, 'Marked cleared'); }}>Mark cleared</button>
                  <button type="button" className="phq-btn phq-btn-ghost" disabled={busy} onClick={function () { setAsk('bounce'); setWhy(''); }}>Bounced</button>
                  {me && me.role !== 'Cashier' && me.role !== 'Trainee' && <button type="button" className="phq-btn phq-btn-ghost" disabled={busy} onClick={function () { setAsk('reverse'); setWhy(''); }}>Reverse</button>}
                </>
              )}
              {ask === 'bounce' && (
                <label className="phq-field"><span>Why did it bounce?</span>
                  <input value={why} onChange={function (e) { setWhy(e.target.value); }} aria-label="Why did it bounce?" />
                  <button type="button" className="phq-btn" disabled={busy || !why.trim()} onClick={function () { act('nsf', function (live, key) { return live.returnCheque(detail.chequeId, { idempotencyKey: key, reason: why.trim(), nsf: true }); }, 'Recorded as bounced'); }}>Record the bounce</button>
                </label>
              )}
              {ask === 'reverse' && (
                <label className="phq-field"><span>Why reverse this cashing?</span>
                  <input value={why} onChange={function (e) { setWhy(e.target.value); }} aria-label="Why reverse this cashing?" />
                  <p className="phq-note">The cash goes back into the drawer and the fee is refunded.</p>
                  <button type="button" className="phq-btn" disabled={busy || !why.trim()} onClick={function () { act('reverse', function (live, key) { return live.reverseCheque(detail.chequeId, { idempotencyKey: key, reason: why.trim() }); }, 'Cashing reversed'); }}>Reverse the cashing</button>
                </label>
              )}
              {err && <p className="phq-err" role="alert">{err}</p>}
            </div>
          </div>, document.body)}
      </>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { usePhoneLayout: usePhoneLayout, PhoneCheques: PhoneCheques });
})();
