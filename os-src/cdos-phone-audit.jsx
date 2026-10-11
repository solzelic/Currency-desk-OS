/* Phone audit trail. Read-only. This list is the on-device log. */
(function () {
  const { useState } = React;
  const { LongTailScreen } = window.CDOS.LongTail;

  /* ---- Audit trail (read-only) --------------------------------------- */

  const AUDIT_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'deals', label: 'Deals' },
    { id: 'cash', label: 'Cash' },
    { id: 'sign', label: 'Sign-ins' },
    { id: 'settings', label: 'Settings' },
    { id: 'staff', label: 'Staff' },
  ];
  const PLAIN = {
    'transaction.post': 'Deal posted',
    'transaction.reverse': 'Deal reversed',
    'vault.run': 'Vault run',
    'compliance.jurisdiction_pack.adopt': 'Rules updated',
  };

  function plainAction(action) {
    if (!action) return 'Recorded';
    if (PLAIN[action]) return PLAIN[action];
    /* A dotted internal code is not a name a person can read. */
    if (/^[a-z0-9_.]+$/.test(action) && action.indexOf('.') !== -1) {
      const last = action.split('.').pop().replace(/_/g, ' ');
      return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return action;
  }

  function auditGroup(action) {
    const a = String(action || '').toLowerCase();
    if (/sign/.test(a)) return 'sign';
    if (/setting|rate|permission|threshold|rule/.test(a)) return 'settings';
    if (/staff|kyc|employee|role/.test(a)) return 'staff';
    if (/float|cash|vault|till|order|cheque|drawer/.test(a)) return 'cash';
    if (/deal|transaction|posted|void|tag/.test(a)) return 'deals';
    return 'other';
  }

  function localDay(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function signedName(row) {
    const cut = String((row && row.detail) || '').split('·')[0].trim();
    return cut || (row && row.user) || '';
  }

  function PhoneAudit({ audit, settings, onOpenRef }) {
    const Phone = window.CDOS.Phone;
    const [q, setQ] = useState('');
    const [chip, setChip] = useState('all');
    const [open, setOpen] = useState(null);
    const items = (audit || []).map((a, i) => {
      const m = /(\d{4}-\d{2}-\d{2})/.exec(a.ts || '');
      const date = m ? m[1] : String(a.ts || '').slice(0, 10);
      const signIn = /^signed in\b/i.test(String(a.action || ''));
      const who = signIn ? signedName(a) : (a.user || '');
      const title = signIn ? ((who || 'Someone') + ' signed in') : plainAction(a.action);
      return { ...a, i, date, time: window.CDOS.formatPhoneTime(a.ts || ''), who, title, group: auditGroup(a.action) };
    });
    const needle = q.trim().toLowerCase();
    const filtered = items.filter(a => {
      if (chip !== 'all' && a.group !== chip) return false;
      if (!needle) return true;
      const hay = (a.title + ' ' + a.action + ' ' + a.detail + ' ' + a.user + ' ' + a.ts).toLowerCase();
      return hay.includes(needle);
    });
    const today = localDay(new Date());
    const yestDate = new Date(); yestDate.setDate(yestDate.getDate() - 1);
    const yesterday = localDay(yestDate);
    const dayName = (d) => d === today ? 'Today' : d === yesterday ? 'Yesterday' : (window.CDOS.formatPhoneDate(d) || d);
    const groups = [];
    filtered.forEach(a => {
      const last = groups[groups.length - 1];
      if (!last || last.date !== a.date) groups.push({ date: a.date, label: dayName(a.date), rows: [a] });
      else last.rows.push(a);
    });
    const refOf = (detail) => {
      const m = /\b([A-Z]{2,4}-\d[\w-]*)/.exec(detail || '');
      return m ? m[1] : '';
    };
    const state = !audit ? 'loading' : (items.length === 0 ? 'empty' : 'ready');
    return (
      <LongTailScreen
        app="audit" title="Audit trail" state={state}
        subtitle="Actions on this device. The full audit trail is on a computer."
        loadingText="Reading the trail…"
        errorText="The audit trail did not load. Try again."
        emptyText="Nothing is on the trail yet."
        chips={AUDIT_CHIPS} chip={chip} onChip={setChip}
        search={q} onSearch={setQ} searchPlaceholder="Find an action, name or number"
        sheet={open && (
          <div className="phone-sheet" role="dialog" aria-label="Audit detail">
            <div className="phone-sheet-h"><span /><h2>{open.title}</h2><button type="button" className="phone-sheet-x" onClick={() => setOpen(null)}>Close</button></div>
            <div className="phone-sheet-b">
              <div className="phone-kv"><span>When</span><b>{[window.CDOS.formatPhoneDate(open.date), open.time].filter(Boolean).join(', ')}</b></div>
              <div className="phone-kv"><span>Who</span><b>{open.who || open.user}</b></div>
              <div className="phone-kv"><span>What</span><b>{open.title}</b></div>
              {open.detail && <div className="phone-kv"><span>Detail</span><b>{open.detail}</b></div>}
              {refOf(open.detail) && onOpenRef && (
                <button type="button" className="phone-sticky-btn" onClick={() => onOpenRef([refOf(open.detail)], refOf(open.detail))}>Open {refOf(open.detail)}</button>
              )}
            </div>
          </div>
        )}
      >
        {filtered.length === 0 && <p className="phone-miss">Nothing matches that search.</p>}
        {groups.map(g => (
          <Phone.ListSection key={g.date} title={g.label}>
            {g.rows.map(a => (
              <Phone.ListRow key={a.i} title={a.title} subtitle={[a.time, a.who].filter(Boolean).join(' · ')} onClick={() => setOpen(a)} />
            ))}
          </Phone.ListSection>
        ))}
      </LongTailScreen>
    );
  }


  window.CDOS.LongTail.PhoneAudit = PhoneAudit;
})();
