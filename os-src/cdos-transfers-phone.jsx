/* Phone Transfers. The list, and the record a row opens.
   The cash step stays the existing New transfer sheet.
   Saved beneficiaries come in a later PR.
   A tracking PIN, a receipt, and an EFT report stay off this screen.
   A status note that claims a partner moved the money is not shown. */
(function () {
  const { useState, useEffect } = React;

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

  function homeCode() {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    const limit = window.CDOS.reportingLimit && window.CDOS.reportingLimit(null);
    return (pack && pack.homeCurrency) || (limit && limit.currency) || '';
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

  function stamp() {
    return new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
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
        {items.map((row) => <div key={row.k}><span>{row.k}</span><b>{row.v}</b></div>)}
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

  function RecordDetail({ t, beneficiaries, corridors, clients, me, log, setTransfers, onBack }) {
    const { Phone, T, money, time } = shell();
    const ben = beneficiaries.find((b) => b.id === t.beneficiaryId);
    const cor = corridors.find((c) => c.id === t.corridor) || {};
    const home = homeCode();
    const payCode = t.direction === 'send' ? home : t.ccy;
    const recvCode = t.direction === 'send' ? t.ccy : home;
    const pay = shown(money(t.payAmt, payCode));
    const recv = shown(money(t.recvAmt, recvCode));
    const fee = shown(money(t.fee, home));
    const idx = T.FLOW.indexOf(t.status);
    const nextKey = idx >= 0 && idx < T.FLOW.length - 1 ? T.FLOW[idx + 1] : null;
    const terminal = t.status === 'paid' || t.status === 'cancelled';
    const advance = (to, note) => {
      if (!me || !me.name) throw new Error('Phone transfers: cannot record who set the status.');
      setTransfers((list) => list.map((x) => x.id === t.id ? { ...x, status: to, timeline: [...(x.timeline || []), { status: to, ts: stamp(), by: me.name, note: note }] } : x));
      if (log) log('Transfer ' + T.statusLabel(to, t.direction).toLowerCase(), t.ref + ' \u00b7 ' + (cor.country || ''));
    };
    const mark = (key) => {
      const label = T.statusLabel(key, t.direction);
      return 'Mark ' + label.charAt(0).toLowerCase() + label.slice(1);
    };
    const who = t.direction === 'send' ? (ben ? ben.name : (cor.country || '')) : t.senderName;
    let sticky = null;
    if (!terminal) {
      sticky = (
        <div className="phone-sticky phone-xfer-actions">
          {t.status === 'hold'
            ? <button type="button" className="phone-sticky-btn" onClick={() => advance('sent', 'Released after review')}>Release</button>
            : (
              <>
                <button type="button" className="phone-secondary" onClick={() => advance('hold', 'Placed on hold')}>Put on hold</button>
                {nextKey ? <button type="button" className="phone-sticky-btn" onClick={() => advance(nextKey)}>{mark(nextKey)}</button> : null}
              </>
            )}
        </div>
      );
    }
    return (
      <Phone.Screen app="transfers" className="phone-drill" sticky={sticky}>
        <Crumb onBack={onBack} />
        <div className="phone-detail-title">
          <div>
            <h1>{t.senderName + ' to ' + who}</h1>
            <p className="phone-detail-ref">{t.ref}</p>
          </div>
          <span className={'phone-badge tone-' + toneOf(t.status)}>{T.statusLabel(t.status, t.direction)}</span>
        </div>
        <section className="phone-card"><h2>Sender</h2><Kv rows={[{ k: 'Name', v: t.senderName }, { k: 'ID', v: idLine(clients && clients[t.senderName]) }]} /></section>
        <section className="phone-card">
          <h2>Beneficiary</h2>
          <Kv rows={[
            { k: 'Name', v: ben ? ben.name + (ben.relationship ? ', ' + ben.relationship : '') : '' },
            { k: 'Destination', v: cor.country || '' },
            { k: 'Payout', v: T.methodLabel(t.method) + (t.partner ? ', ' + t.partner : '') },
            { k: 'Pickup city', v: ben && ben.method === 'cash' ? ben.pickupCity : '' },
            { k: 'Account', v: ben && ben.method === 'bank' ? ben.account : '' },
            { k: 'Wallet', v: ben && ben.method === 'wallet' ? ben.walletId : '' },
          ]} />
        </section>
        <section className="phone-card"><h2>Why and from where</h2><Kv rows={[{ k: 'Purpose', v: t.purpose || '' }, { k: 'Source of funds', v: t.sourceOfFunds || '' }]} /></section>
        <section className="phone-card">
          <h2>Status, set by hand</h2>
          <ul className="phone-tl">
            {(t.timeline || []).map((evt, i) => {
              const when = shown(time(evt.ts));
              const who = evt.by && evt.by !== 'System' ? evt.by : '';
              return <li key={evt.status + i}><span>{T.statusLabel(evt.status, t.direction)}</span><span>{[when, who].filter(Boolean).join(', ')}</span></li>;
            })}
          </ul>
        </section>
        <details className="phone-card phone-money">
          <summary><span>Amounts</span><span>{pay && recv ? pay + ' to ' + recv : ''}</span></summary>
          <Kv rows={[
            { k: t.direction === 'send' ? 'Customer pays' : 'Amount in', v: pay },
            { k: 'Fee', v: fee },
            { k: 'Rate', v: t.rate ? String(t.rate) : '' },
            { k: t.direction === 'send' ? 'Beneficiary gets' : 'Customer gets', v: recv },
          ]} />
        </details>
      </Phone.Screen>
    );
  }

  function PhoneTransfers({ transfers, beneficiaries, corridors, clients, me, log, setTransfers, onNew, onOpen, openId, onOpened, timeZone }) {
    const { Phone, T, time } = shell();
    const [q, setQ] = useState('');
    const [filter, setFilter] = useState('active');
    const [detailId, setDetailId] = useState(null);
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
      return <RecordDetail t={detail} beneficiaries={beneficiaries} corridors={corridors} clients={clients} me={me} log={log} setTransfers={setTransfers} onBack={() => setDetailId(null)} />;
    }
    const emptyCopy = filter === 'hold' ? 'Nothing is on hold.' : filter === 'paid' ? 'Nothing has been paid out.' : filter === 'all' ? 'No transfers yet.' : 'Nothing is in progress.';
    const empty = needle
      ? <Phone.EmptyState title="No records" message="Nothing matches that search." />
      : <Phone.EmptyState title="No transfers here" message={emptyCopy} />;
    return (
      <Phone.Screen app="transfers" title="Transfers" sticky={<Phone.StickyAction label="+ New transfer record" onClick={() => { if (onNew) onNew(); }} />}>
        <Phone.Search value={q} onChange={setQ} placeholder="Sender, beneficiary or TR number" label="Sender, beneficiary or TR number" />
        <Phone.FilterChips value={filter} onChange={setFilter} chips={[
          { id: 'active', label: 'In progress', count: counts.active },
          { id: 'hold', label: 'On hold', count: counts.hold },
          { id: 'paid', label: 'Paid out', count: counts.paid },
          { id: 'all', label: 'All', count: counts.all },
        ]} />
        {groups.length ? groups.map((g, i) => (
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
        )) : empty}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTransfers: PhoneTransfers });
})();
