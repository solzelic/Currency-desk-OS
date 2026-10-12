/* Phone Transfers list. Who sent to whom, and where it stands.
   The cash step stays the existing New transfer sheet.
   Saved beneficiaries and the record page come in later PRs.
   A tracking PIN, a receipt, and an EFT report stay off this screen. */
(function () {
  const { useState } = React;

  function shell() {
    const C = window.CDOS || {};
    const Phone = C.Phone;
    const T = C._transfers;
    if (!Phone || !T || typeof C.formatPhoneTime !== 'function' || typeof C.formatPhoneDate !== 'function' || typeof C.formatPhoneListGroup !== 'function') {
      throw new Error('Phone transfers: the phone shell did not load.');
    }
    return { Phone: Phone, T: T, time: C.formatPhoneTime, day: C.formatPhoneDate, group: C.formatPhoneListGroup };
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

  /* The last time a person moved the record. A System stamp is not that. */
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

  function PhoneTransfers({ transfers, beneficiaries, corridors, onNew, onOpen }) {
    const { Phone, T, time } = shell();
    const [q, setQ] = useState('');
    const [filter, setFilter] = useState('active');
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
              const who = t.direction === 'send' ? (ben ? ben.name : (corOf(t.corridor).country || '')) : t.senderName;
              const how = [ben && ben.relationship, corOf(t.corridor).country, T.methodLabel(t.method) + (t.partner ? ', ' + t.partner : '')].filter(Boolean).join(' \u00b7 ');
              return (
                <Phone.ListRow
                  key={t.id}
                  className="phone-xfer-row"
                  title={t.senderName + ' to ' + who}
                  subtitle={how}
                  note={t.ref}
                  meta={shown(time(handStamp(t)))}
                  badge={{ label: T.statusLabel(t.status, t.direction), tone: toneOf(t.status) }}
                  onClick={onOpen ? () => onOpen(t.id) : undefined}
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
