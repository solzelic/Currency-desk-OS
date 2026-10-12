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

  function PhoneTransfers({ transfers, beneficiaries, corridors, onNew, onOpen }) {
    const { Phone, T, time, day, group } = shell();
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
        {list.length ? (
          <Phone.ListSection title={shown(group(book, book)) || 'Records'} meta="Sender to beneficiary">
            {list.map((t) => {
              const ben = benOf(t.beneficiaryId);
              const who = t.direction === 'send' ? (ben ? ben.name : (corOf(t.corridor).country || '')) : t.senderName;
              const how = [ben && ben.relationship, corOf(t.corridor).country, T.methodLabel(t.method) + (t.partner ? ', ' + t.partner : '')].filter(Boolean).join(' \u00b7 ');
              const meta = book && t.date === book ? shown(time(handStamp(t))) : shown(day(t.date));
              return (
                <Phone.ListRow
                  key={t.id}
                  className="phone-xfer-row"
                  title={t.senderName + ' to ' + who}
                  subtitle={how}
                  note={t.ref}
                  meta={meta}
                  badge={{ label: T.statusLabel(t.status, t.direction), tone: toneOf(t.status) }}
                  onClick={onOpen ? () => onOpen(t.id) : undefined}
                />
              );
            })}
          </Phone.ListSection>
        ) : empty}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTransfers: PhoneTransfers });
})();
