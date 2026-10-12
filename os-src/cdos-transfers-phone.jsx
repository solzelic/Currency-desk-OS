/* Phone Transfers. The list, the record, and saved beneficiaries.
   The cash step stays the existing New transfer sheet.
   A tracking PIN, a receipt, and an EFT report stay off this screen.
   A status note that claims a partner moved the money is not shown. */
(function () {
  const { useState, useEffect, useRef } = React;

  function shell() {
    const C = window.CDOS || {};
    const Phone = C.Phone;
    const T = C._transfers;
    if (!Phone || !T || typeof C.formatPhoneMoney !== 'function' || typeof C.formatPhoneTime !== 'function' || typeof C.formatPhoneDate !== 'function' || typeof C.formatPhoneListGroup !== 'function') {
      throw new Error('Phone transfers: the phone shell did not load.');
    }
    return { Phone: Phone, T: T, money: C.formatPhoneMoney, time: C.formatPhoneTime, day: C.formatPhoneDate, group: C.formatPhoneListGroup, Ic: C.Ic };
  }

  function shown(text) {
    if (!text || text === '\u2014' || text === '\u2013') return '';
    return text;
  }

  function today() {
    const fn = window.CDOS && window.CDOS.businessDate;
    return typeof fn === 'function' ? fn() : '';
  }

  function toneOf(status) {
    if (status === 'paid') return 'pos';
    if (status === 'hold') return 'warn';
    if (status === 'cancelled') return 'neg';
    return 'neutral';
  }

  function handStamp(t) {
    const events = t.timeline || [];
    let pick = null;
    events.forEach((evt) => { if (evt && evt.by && evt.by !== 'System') pick = evt; });
    return pick ? pick.ts : (events[0] ? events[0].ts : '');
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function shiftDay(iso, delta) {
    const y = Number(String(iso).slice(0, 4));
    const m = Number(String(iso).slice(5, 7));
    const d = Number(String(iso).slice(8, 10));
    if (!y || !m || !d) return '';
    const utc = new Date(Date.UTC(y, m - 1, d + delta));
    return utc.getUTCFullYear() + '-' + String(utc.getUTCMonth() + 1).padStart(2, '0') + '-' + String(utc.getUTCDate()).padStart(2, '0');
  }

  /* The heading is that record's day. Today and Yesterday are words.
     Any other day is the month and the day, as in Jun 18. */
  function dayHeading(date, book) {
    const text = String(date || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    if (book && text === book) return 'Today';
    if (book && text === shiftDay(book, -1)) return 'Yesterday';
    const month = Number(text.slice(5, 7));
    const dayNum = Number(text.slice(8, 10));
    if (month < 1 || month > 12) return '';
    return MONTHS[month - 1] + ' ' + dayNum;
  }

  function idLine(client) {
    if (!client || !client.idType || !client.idNum) return 'Not on file';
    const { day } = shell();
    const expiry = client.idExpiry ? String(client.idExpiry).slice(0, 10) : '';
    const when = expiry ? shown(day(expiry)) : '';
    const expired = !!(expiry && today() && expiry < today());
    return client.idType + (when ? ', exp. ' + when : '') + (expired ? ', expired' : '');
  }

  function Kv({ rows }) {
    const items = (rows || []).filter((row) => row && row.v);
    if (!items.length) return null;
    return (
      <div className="phone-kv">
        {items.map((row) => (
          <div key={row.k}>
            <span>{row.k}</span>
            <b data-ledger={row.kind || undefined} data-stored={row.raw == null ? undefined : String(row.raw)}>{row.v}</b>
          </div>
        ))}
      </div>
    );
  }

  function Crumb({ onBack }) {
    const { Ic } = shell();
    return (
      <button type="button" className="phone-crumb" onClick={onBack}>
        {Ic ? <Ic n="arrowleft" s={16} /> : null} Transfers
      </button>
    );
  }

  /* Figures are copied off the ledger row and the obligation.
     Nothing here multiplies a rate, invents a gross, or reads the
     browser record's pay, fee, or receive amount. */
  function RecordDetail({ t, beneficiaries, corridors, clients, timeZone, onBack }) {
    const { Phone, T, money, time } = shell();
    const ben = beneficiaries.find((b) => b.id === t.beneficiaryId);
    const cor = corridors.find((c) => c.id === t.corridor) || {};
    const [book, setBook] = useState(() => (t.serverTransactionId ? null : { absent: true }));
    useEffect(() => {
      let gone = false;
      const id = t.serverTransactionId;
      if (!id) {
        setBook({ absent: true });
        return undefined;
      }
      setBook(null);
      const backend = window.CDOS.Backend;
      if (!backend || typeof backend.request !== 'function') {
        setBook({ absent: true, label: 'The ledger is not on this desk. No amount is shown.' });
        return undefined;
      }
      Promise.all([
        backend.request('/api/ledger/transactions?limit=100'),
        backend.request('/api/ledger/obligations?limit=200'),
      ]).then((pair) => {
        if (gone) return;
        const tx = (pair[0].transactions || []).find((row) => row && row.transactionId === id) || null;
        const ob = (pair[1].obligations || []).find((row) => row && (row.transactionId === id || (t.serverObligationId && row.obligationId === t.serverObligationId))) || null;
        setBook(tx ? { tx: tx, obligation: ob } : { absent: true });
      }).catch((error) => {
        if (gone) return;
        const offline = error && error.code === 'NETWORK_ERROR';
        const denied = error && (error.status === 401 || error.code === 'AUTHENTICATION_REQUIRED');
        setBook({
          absent: true,
          label: offline ? 'Offline. No amount is shown.' : (denied ? 'Sign in again. No amount is shown.' : 'The ledger refused this record. No amount is shown.'),
        });
      });
      return () => { gone = true; };
    }, [t.id, t.serverTransactionId, t.serverObligationId]);
    const asMoney = (amount, code) => {
      if (amount == null || String(amount).trim() === '') return '';
      return shown(money(String(amount).trim(), code));
    };
    let rows = null;
    if (book && book.tx) {
      const tx = book.tx;
      const ob = book.obligation;
      const home = ob && ob.homeCurrency;
      rows = [{ k: t.direction === 'send' ? 'Customer pays' : 'Amount in', v: asMoney(tx.inputAmount, tx.from), raw: tx.inputAmount, kind: 'input' }];
      if (tx.feeCad != null && String(tx.feeCad).trim() !== '') {
        rows.push({ k: 'Fee', v: home ? asMoney(tx.feeCad, home) : String(tx.feeCad).trim(), raw: tx.feeCad, kind: 'fee' });
      }
      if (tx.rate != null && String(tx.rate).trim() !== '') {
        rows.push({ k: 'Rate', v: String(tx.rate).trim(), raw: String(tx.rate).trim(), kind: 'rate' });
      }
      if (ob && ob.faceAmount != null && String(ob.faceAmount).trim() !== '') {
        rows.push({ k: 'Receiver gets', v: asMoney(ob.faceAmount, ob.faceCurrency), raw: ob.faceAmount, kind: 'face' });
      }
    }
    const paid = rows && rows[0] ? rows[0].v : '';
    const face = rows ? rows.filter((row) => row.kind === 'face')[0] : null;
    const country = cor.country || '';
    const who = t.direction === 'send' ? (ben ? ben.name : country) : t.senderName;
    const amountNote = book == null ? 'Reading the ledger.' : ((book && book.label) || 'Not on the ledger.');
    return (
      <Phone.Screen app="transfers" className="phone-drill">
        <Crumb onBack={onBack} />
        <div className="phone-detail-title">
          <div>
            <h1>{t.senderName + ' to ' + who}</h1>
            <p className="phone-detail-ref">{t.ref}</p>
            {t.sample ? <p className="phone-demo">Demo</p> : null}
          </div>
          <span className={'phone-badge tone-' + toneOf(t.status)}>{T.statusLabel(t.status, t.direction)}</span>
        </div>
        <section className="phone-card"><h2>Sender</h2><Kv rows={[{ k: 'Name', v: t.senderName }, { k: 'ID', v: idLine(clients && clients[t.senderName]) }]} /></section>
        <section className="phone-card">
          <h2>Beneficiary</h2>
          <Kv rows={[
            { k: 'Name', v: ben ? ben.name + (ben.relationship ? ', ' + ben.relationship : '') : '' },
            { k: 'Destination', v: who === country ? '' : country },
            { k: 'Payout', v: T.methodLabel(t.method) + (t.partner ? ', ' + t.partner : '') },
            { k: 'Pickup city', v: ben && ben.method === 'cash' ? ben.pickupCity : '' },
            { k: 'Account', v: ben && ben.method === 'bank' ? ben.account : '' },
            { k: 'Wallet', v: ben && ben.method === 'wallet' ? ben.walletId : '' },
          ]} />
        </section>
        <section className="phone-card"><h2>Why and from where</h2><Kv rows={[{ k: 'Purpose', v: t.purpose || '' }, { k: 'Source of funds', v: t.sourceOfFunds || '' }]} /></section>
        <section className="phone-card">
          <h2>Status</h2>
          <p className="phone-absent">View only. This phone does not change it.</p>
          <ul className="phone-tl">
            {(t.timeline || []).map((evt, i) => {
              const when = shown(time(evt.ts, timeZone));
              const actor = evt.by && evt.by !== 'System' ? evt.by : '';
              return <li key={evt.status + i}><span>{T.statusLabel(evt.status, t.direction)}</span><span>{[when, actor].filter(Boolean).join(', ')}</span></li>;
            })}
          </ul>
        </section>
        {rows ? (
          <details className="phone-card phone-money">
            <summary><span>Amounts</span><span>{paid && face ? paid + ' to ' + face.v : ''}</span></summary>
            <Kv rows={rows} />
          </details>
        ) : (
          <section className="phone-card phone-money">
            <h2>Amounts</h2>
            <p className="phone-absent" role={book && book.label ? 'status' : undefined}>{amountNote}</p>
          </section>
        )}
      </Phone.Screen>
    );
  }

  function needsAddress() {
    const { T } = shell();
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    if (typeof T.addressRequiredOverIdLine !== 'function') {
      throw new Error('Phone transfers: the address rule did not load.');
    }
    return T.addressRequiredOverIdLine(pack);
  }

  function maskId(num) {
    const s = String(num || '').replace(/\s+/g, '');
    if (!s) return '';
    if (s.length <= 4) return '\u2022\u2022\u2022\u2022' + s.slice(-2);
    return s.slice(0, Math.min(5, s.length - 4)) + '\u2022\u2022\u2022' + s.slice(-2);
  }

  function idFacts(client) {
    if (!client || !client.idType || !client.idNum) return null;
    const { day } = shell();
    const expiry = client.idExpiry ? String(client.idExpiry).slice(0, 10) : '';
    const expired = !!(expiry && today() && expiry < today());
    return { type: client.idType, number: maskId(client.idNum), expiry: expiry ? shown(day(expiry)) : '', current: !expired };
  }

  function payoutBits(b) {
    const { T } = shell();
    const how = T.methodLabel(b.method) + (b.partner ? ', ' + b.partner : '');
    if (b.method === 'cash' && b.pickupCity) return how + ' \u00b7 ' + b.pickupCity;
    if (b.method === 'bank' && b.account) return how + ' \u00b7 acct ' + b.account;
    if (b.method === 'wallet' && b.walletId) return how + ' \u00b7 ' + b.walletId;
    return how;
  }

  function BenSheet({ sender, lockSender, corridors, onClose, onSave, saveError, busy }) {
    const { T, Ic } = shell();
    const [, setPackTick] = useState(0);
    useEffect(() => {
      const bump = () => setPackTick((n) => n + 1);
      window.addEventListener('cdos-jurisdiction', bump);
      return () => window.removeEventListener('cdos-jurisdiction', bump);
    }, []);
    const first = corridors.find((c) => c.active) || corridors[0];
    const [b, setB] = useState(() => ({
      id: 'b' + Date.now(), name: '', relationship: 'Parent', sender: sender || '',
      corridor: first ? first.id : '', method: 'cash', partner: '', pickupCity: '', phone: '',
      address: '', bank: '', branch: '', account: '', walletId: '',
    }));
    const cor = corridors.find((c) => c.id === b.corridor) || first || { partners: [] };
    const methods = T.METHODS.filter((m) => (cor.partners || []).some((p) => p.methods.includes(m[0])));
    const partners = (cor.partners || []).filter((p) => p.methods.includes(b.method));
    const set = (k, v) => setB((s) => ({ ...s, [k]: v }));
    useEffect(() => {
      if (!methods.find((m) => m[0] === b.method) && methods[0]) setB((s) => ({ ...s, method: methods[0][0] }));
    }, [b.corridor]);
    useEffect(() => {
      if (!partners.find((p) => p.name === b.partner)) setB((s) => ({ ...s, partner: partners[0] ? partners[0].name : '' }));
    }, [b.corridor, b.method]);
    if (!first) throw new Error('Phone transfers: this desk has no corridors.');
    const large = needsAddress();
    const missing = [];
    if (!b.name.trim()) missing.push('Full name');
    if (!b.partner) missing.push('Payout partner');
    if (large && !String(b.address || '').trim()) missing.push('Address');
    const valid = !!(b.name.trim() && b.partner);
    const why = !b.name.trim() ? 'Add the full name to save.' : (!b.partner ? 'Choose a payout partner to save.' : '');
    const short = { bank: 'Bank', cash: 'Cash pickup', wallet: 'Wallet' };
    const count = missing.length === 1 ? '1 thing missing: ' : missing.length + ' things missing: ';
    return ReactDOM.createPortal(
      <div className="phone-task phone-ben-sheet fixed inset-0" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }}>
        <div role="dialog" aria-label="New beneficiary" className="phone-task-sheet" onMouseDown={(e) => e.stopPropagation()}>
          <div className="phone-task-head phone-ben-head">
            <button type="button" className="phone-ben-cancel" onClick={onClose}>Cancel</button>
            <h2>New beneficiary</h2>
            <span />
          </div>
          <div className="phone-task-body">
            {missing.length ? <div className="phone-miss" role="alert">{count + missing.join(', ')}</div> : null}
            <label className="phone-field"><span className="phone-flabel">Sender</span>
              {lockSender
                ? <div className="phone-input is-locked">{Ic ? <Ic n="users" s={18} /> : null} {b.sender}</div>
                : <input value={b.sender} onChange={(e) => set('sender', e.target.value)} placeholder="Who sends to this person" />}
            </label>
            <label className="phone-field"><span className="phone-flabel">Full name <span className="phone-req">Required</span></span>
              <input className={!b.name.trim() ? 'is-err' : ''} value={b.name} onChange={(e) => set('name', e.target.value)} placeholder="Receiver's name" aria-invalid={!b.name.trim()} />
              {!b.name.trim() ? <span className="phone-errtx">Type the name as it is on their ID.</span> : null}
            </label>
            <label className="phone-field"><span className="phone-flabel">Relationship to sender</span>
              <select value={b.relationship} onChange={(e) => set('relationship', e.target.value)}>{T.RELATIONSHIPS.map((r) => <option key={r}>{r}</option>)}</select>
            </label>
            <label className="phone-field"><span className="phone-flabel">Destination</span>
              <select value={b.corridor} onChange={(e) => set('corridor', e.target.value)}>{corridors.map((c) => <option key={c.id} value={c.id}>{c.country + ' \u00b7 ' + c.ccy}</option>)}</select>
            </label>
            <div className="phone-field"><span className="phone-flabel">Payout method</span>
              <div className="phone-segm" role="group" aria-label="Payout method">
                {methods.map((m) => <button key={m[0]} type="button" className={b.method === m[0] ? 'on' : ''} aria-pressed={b.method === m[0]} onClick={() => set('method', m[0])}>{short[m[0]] || m[1]}</button>)}
              </div>
            </div>
            <label className="phone-field"><span className="phone-flabel">Payout partner <span className="phone-req">Required</span></span>
              <select className={!b.partner ? 'is-err' : ''} value={b.partner} onChange={(e) => set('partner', e.target.value)} aria-invalid={!b.partner}>
                {partners.map((p) => <option key={p.name}>{p.name}</option>)}
                {!partners.length ? <option value="">No partner for this method</option> : null}
              </select>
            </label>
            <label className="phone-field"><span className="phone-flabel">Address {large ? <span className="phone-req">Needed for large transfers</span> : <span className="phone-opt">Optional</span>}</span>
              <input className={large && !String(b.address || '').trim() ? 'is-err' : ''} value={b.address || ''} onChange={(e) => set('address', e.target.value)} placeholder="Street, city, country" />
            </label>
            {b.method === 'bank' ? <label className="phone-field"><span className="phone-flabel">Account number <span className="phone-opt">Optional</span></span><input value={b.account} onChange={(e) => set('account', e.target.value)} /></label> : null}
            {b.method === 'cash' ? <label className="phone-field"><span className="phone-flabel">Pickup city <span className="phone-opt">Optional</span></span><input value={b.pickupCity} onChange={(e) => set('pickupCity', e.target.value)} /></label> : null}
            {b.method === 'wallet' ? <label className="phone-field"><span className="phone-flabel">Wallet ID / number <span className="phone-opt">Optional</span></span><input value={b.walletId} onChange={(e) => set('walletId', e.target.value)} /></label> : null}
            <label className="phone-field"><span className="phone-flabel">Phone <span className="phone-opt">Optional</span></span><input value={b.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></label>
          </div>
          <div className="phone-task-foot">
            <button type="button" className="phone-task-go" disabled={!valid || !!busy} onClick={() => onSave({ ...b, createdAt: new Date().toISOString() })}>Save beneficiary</button>
            {saveError ? <p className="phone-sticky-why" role="alert">{saveError}</p> : null}
            {why ? <p className="phone-sticky-why">{why}</p> : null}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  function SenderFile({ name, clients, beneficiaries, corridors, onBack, onUse, onAdd, onNew }) {
    const { Phone, Ic } = shell();
    const facts = idFacts(clients && clients[name]);
    const mine = beneficiaries.filter((b) => b.sender === name);
    const corOf = (id) => corridors.find((c) => c.id === id) || {};
    const first = String(name || '').trim().split(/\s+/)[0] || name;
    return (
      <Phone.Screen app="transfers" className="phone-drill" sticky={<Phone.StickyAction label={'New record for ' + first} onClick={() => onNew({ sender: name })} />}>
        <Crumb onBack={onBack} />
        <h1 className="phone-drill-title">{name}</h1>
        <section className="phone-card">
          <h2>Sender ID on file</h2>
          {facts ? (
            <>
              <Kv rows={[{ k: 'ID type', v: facts.type }, { k: 'Number', v: facts.number }, { k: 'Expires', v: facts.expiry }]} />
              <span className={'phone-badge tone-' + (facts.current ? 'pos' : 'neg')}>{facts.current ? 'ID current' : 'ID expired'}</span>
            </>
          ) : <p className="phone-absent">Not on file</p>}
        </section>
        {mine.length ? (
          <Phone.ListSection title="Saved beneficiaries" meta={mine.length + ' on file'}>
            {mine.map((b) => (
              <div key={b.id} className="phone-ben">
                <div>
                  <b>{b.name}</b>
                  <small>{[b.relationship, corOf(b.corridor).country].filter(Boolean).join(' \u00b7 ')}</small>
                  <small>{payoutBits(b)}{b.sample ? ' \u00b7 Demo' : ''}</small>
                </div>
                <button type="button" aria-label={'Use ' + b.name} onClick={() => onUse(b)}>Use</button>
              </div>
            ))}
          </Phone.ListSection>
        ) : <Phone.EmptyState title="No saved beneficiaries" message={'No one is saved for ' + first + ' yet.'} />}
        <button type="button" className="phone-secondary phone-block" onClick={onAdd}>{Ic ? <Ic n="plus" s={18} /> : null} Add a beneficiary</button>
      </Phone.Screen>
    );
  }

  function PhoneTransfers({ transfers, beneficiaries, corridors, clients, me, log, setTransfers, setBeneficiaries, onNew, onOpen, openId, onOpened, timeZone }) {
    const { Phone, T, time } = shell();
    const [tab, setTab] = useState('records');
    const [q, setQ] = useState('');
    const [filter, setFilter] = useState('active');
    const [detailId, setDetailId] = useState(null);
    const [sender, setSender] = useState('');
    const [sheet, setSheet] = useState(null);
    const [saveError, setSaveError] = useState('');
    const saveLock = useRef(false);
    useEffect(() => {
      if (!openId) return;
      setDetailId(openId);
      if (onOpened) onOpened();
    }, [openId]);
    const benOf = (id) => beneficiaries.find((b) => b.id === id);
    const corOf = (id) => corridors.find((c) => c.id === id) || {};
    const counts = { active: 0, hold: 0, paid: 0, all: transfers.length };
    transfers.forEach((t) => {
      if (t.status === 'hold') counts.hold += 1;
      else if (t.status === 'paid') counts.paid += 1;
      else if (t.status !== 'cancelled') counts.active += 1;
    });
    const needle = q.trim().toLowerCase();
    const list = transfers.filter((t) => {
      if (filter === 'hold') return t.status === 'hold';
      if (filter === 'paid') return t.status === 'paid';
      if (filter === 'all') return true;
      return t.status !== 'paid' && t.status !== 'cancelled' && t.status !== 'hold';
    }).filter((t) => {
      if (!needle) return true;
      const ben = benOf(t.beneficiaryId);
      return (t.senderName + ' ' + (ben ? ben.name : '') + ' ' + t.ref).toLowerCase().indexOf(needle) >= 0;
    }).sort((a, b) => (b.date + b.ref).localeCompare(a.date + a.ref));
    const book = today();
    const groups = [];
    list.forEach((t) => {
      const key = String(t.date || '').slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(t);
      else groups.push({ key: key, title: dayHeading(key, book) || 'Records', rows: [t] });
    });
    const open = (id) => {
      setDetailId(id);
      if (onOpen) onOpen(id);
    };
    const people = beneficiaries.filter((b) => !needle || (b.name + ' ' + b.sender + ' ' + b.partner).toLowerCase().indexOf(needle) >= 0);
    const saveBen = (b) => {
      if (saveLock.current) return;
      saveLock.current = true;
      setSaveError('');
      const key = T.BKEY;
      if (!key || !setBeneficiaries) {
        saveLock.current = false;
        throw new Error('Phone transfers: cannot store a beneficiary.');
      }
      let next;
      try {
        const raw = localStorage.getItem(key);
        const rows = raw ? JSON.parse(raw) : beneficiaries.slice();
        if (!Array.isArray(rows)) throw new Error('Phone transfers: the beneficiary store is not a list.');
        const ex = rows.find((x) => x && x.id === b.id);
        next = ex ? rows.map((x) => x.id === b.id ? b : x) : [b, ...rows];
        localStorage.setItem(key, JSON.stringify(next));
      } catch (error) {
        saveLock.current = false;
        setSaveError('Could not save. Nothing was kept.');
        return;
      }
      setBeneficiaries(next);
      if (log) log('Beneficiary saved', b.name + ' \u00b7 ' + b.partner);
      setSheet(null);
    };
    const openSheet = (next) => {
      saveLock.current = false;
      setSaveError('');
      setSheet(next);
    };
    const detail = detailId ? transfers.find((t) => t.id === detailId) : null;
    if (detailId) {
      if (!detail) {
        return (
          <Phone.Screen app="transfers" className="phone-drill">
            <Crumb onBack={() => setDetailId(null)} />
            <Phone.EmptyState title="Record not on this desk" message="It is not in the transfers kept on this browser." />
          </Phone.Screen>
        );
      }
      return <RecordDetail t={detail} beneficiaries={beneficiaries} corridors={corridors} clients={clients} timeZone={timeZone} onBack={() => setDetailId(null)} />;
    }
    if (sender) {
      return (
        <>
          <SenderFile
            name={sender}
            clients={clients}
            beneficiaries={beneficiaries}
            corridors={corridors}
            onBack={() => setSender('')}
            onUse={(b) => { if (onNew) onNew({ sender: sender, benId: b.id }); }}
            onAdd={() => openSheet({ sender: sender, lock: true })}
            onNew={onNew}
          />
          {sheet ? <BenSheet sender={sheet.sender} lockSender={!!sheet.lock} corridors={corridors} onClose={() => setSheet(null)} onSave={saveBen} saveError={saveError} busy={saveLock.current} /> : null}
        </>
      );
    }
    const emptyCopy = filter === 'hold' ? 'Nothing is on hold.' : filter === 'paid' ? 'Nothing has been paid out.' : filter === 'all' ? 'No transfers yet.' : 'Nothing is in progress.';
    const empty = needle
      ? <Phone.EmptyState title="No records" message="Nothing matches that search." />
      : <Phone.EmptyState title="No transfers here" message={emptyCopy} />;
    const sticky = tab === 'records'
      ? <Phone.StickyAction label="+ New transfer record" onClick={() => { if (onNew) onNew(true); }} />
      : <Phone.StickyAction label="Add a beneficiary" onClick={() => openSheet({ sender: '', lock: false })} />;
    return (
      <Phone.Screen app="transfers" title="Transfers" sticky={sticky}>
        <div className="phone-seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'records'} className={'phone-seg-btn' + (tab === 'records' ? ' on' : '')} onClick={() => { setTab('records'); setQ(''); }}>Records</button>
          <button type="button" role="tab" aria-selected={tab === 'people'} className={'phone-seg-btn' + (tab === 'people' ? ' on' : '')} onClick={() => { setTab('people'); setQ(''); }}>Saved beneficiaries</button>
        </div>
        <Phone.Search value={q} onChange={setQ} placeholder={tab === 'records' ? 'Sender, beneficiary or TR number' : 'Name, sender or partner'} label={tab === 'records' ? 'Sender, beneficiary or TR number' : 'Name, sender or partner'} />
        {tab === 'people' ? (
          people.length ? (
            <Phone.ListSection title="Saved beneficiaries" meta={people.length + ' on file'}>
              {people.map((b) => (
                <Phone.ListRow
                  key={b.id}
                  title={b.name}
                  subtitle={[b.relationship, corOf(b.corridor).country, b.sender].filter(Boolean).join(' \u00b7 ')}
                  note={b.sample ? payoutBits(b) + ' \u00b7 Demo' : payoutBits(b)}
                  onClick={() => { if (b.sender) setSender(b.sender); }}
                />
              ))}
            </Phone.ListSection>
          ) : <Phone.EmptyState title="No saved beneficiaries" message={needle ? 'Nothing matches that search.' : 'Save a person from a sender file.'} />
        ) : null}
        {tab === 'records' ? <Phone.FilterChips value={filter} onChange={setFilter} chips={[
          { id: 'active', label: 'In progress', count: counts.active },
          { id: 'hold', label: 'On hold', count: counts.hold },
          { id: 'paid', label: 'Paid out', count: counts.paid },
          { id: 'all', label: 'All', count: counts.all },
          ]} /> : null}
        {tab === 'records' && groups.length ? groups.map((g, i) => (
          <Phone.ListSection key={g.key || String(i)} title={g.title} meta={i === 0 ? 'Sender to beneficiary' : null}>
            {g.rows.map((t) => {
              const ben = benOf(t.beneficiaryId);
              const country = corOf(t.corridor).country || '';
              const who = t.direction === 'send' ? (ben ? ben.name : country) : t.senderName;
              const how = [ben && ben.relationship, who === country ? '' : country, T.methodLabel(t.method) + (t.partner ? ', ' + t.partner : '')].filter(Boolean).join(' \u00b7 ');
              return (
                <Phone.ListRow
                  key={t.id}
                  className="phone-xfer-row"
                  title={t.senderName + ' to ' + who}
                  subtitle={how}
                  note={t.sample ? t.ref + ' \u00b7 Demo' : t.ref}
                  meta={shown(time(handStamp(t), timeZone))}
                  badge={{ label: T.statusLabel(t.status, t.direction), tone: toneOf(t.status) }}
                  onClick={() => open(t.id)}
                />
              );
            })}
          </Phone.ListSection>
        )) : null}
        {tab === 'records' && !groups.length ? empty : null}
        {sheet ? <BenSheet sender={sheet.sender} lockSender={!!sheet.lock} corridors={corridors} onClose={() => setSheet(null)} onSave={saveBen} saveError={saveError} busy={saveLock.current} /> : null}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTransfers: PhoneTransfers });
})();
