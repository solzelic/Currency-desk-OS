/* ============================================================
   Phone Compliance. Desktop Compliance does not render this.

   The layout is the shared phone shell (docs/PHONE_SHELL.md).
   Amounts go through formatPhoneMoney, so a threshold reads
   "10,000.00 CAD" and never a bare "$".

   Honesty, on purpose:
   - Sanctions screening is not connected. The tile has no count.
   - Automatic ID checks are not connected.
   - The desk does not file. The owner files in the regulator's portal.
   - Possible split deals are warnings. Nothing here is blocked.
   - A failed load shows "Not loaded", not a stale zero.
   ============================================================ */
(function () {
  const { useState, useEffect, useMemo } = React;

  /* 430px is the phone shell. A wider window keeps the desktop tree. */
  function usePhoneWidth() {
    const query = '(max-width: 430px)';
    const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
    useEffect(() => {
      const mq = matchMedia(query);
      const apply = () => setOn(mq.matches);
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }, []);
    return on;
  }

  function phoneMoneyFn() {
    const root = window.CDOS || {};
    return root.formatPhoneMoney || (root.Phone && root.Phone.formatMoney) || null;
  }

  function phoneMoney(amount, currency) {
    const fn = phoneMoneyFn();
    if (typeof fn !== 'function') throw new Error('formatPhoneMoney is not loaded');
    const text = fn(amount, currency);
    if (typeof text !== 'string' || text.indexOf('$') !== -1) {
      throw new Error('Phone money must put the currency code after the amount');
    }
    return text;
  }

  /* Acronyms the packs store as the regulator. Spell the office once. */
  const OFFICE = {
    FINTRAC: "FINTRAC, Canada's financial intelligence unit",
    FinCEN: 'FinCEN, the US financial intelligence unit',
    HMRC: 'HMRC, the UK supervisor',
    AMLD: 'the EU anti-money-laundering rules',
    AUSTRAC: "AUSTRAC, Australia's financial intelligence unit",
    CBUAE: 'the Central Bank of the UAE',
    'National FIU': 'the national financial intelligence unit',
    'RBI / FIU-IND': "the Reserve Bank of India and FIU-IND, India's financial intelligence unit",
    'BSP / AMLC': "the Bangko Sentral and the AMLC, the Philippines' financial intelligence unit",
    'NBS / APML': "the National Bank of Serbia and APML, the financial intelligence unit",
  };

  function officeLine(regime) {
    const authority = (regime && regime.authority) || '';
    if (OFFICE[authority]) return OFFICE[authority];
    if (authority && regime.country) return authority + ' · ' + regime.country;
    return authority || (regime && regime.country) || 'Your reporting office';
  }

  function windowLabel(regime) {
    if (!regime) return 'Large cash';
    if (regime.windowKind === 'calendar_month') return 'This month';
    if (regime.windowKind === 'banking_day') return 'Banking day';
    if (regime.aggregate === false) return 'Large cash';
    if (regime.aggHours) return regime.aggHours + 'h aggregation';
    return 'Aggregation';
  }

  /* Same people the bell already lists: ID is required on a deal and is not ok. */
  function missingId(rows, clients, settings) {
    const flags = window.CDOS.computeFlags(rows, clients, settings);
    const seen = new Set();
    const out = [];
    (rows || []).forEach((row) => {
      const flag = flags[row.id];
      if (!flag || flag.void || flag.kyc === 'ok' || !flag.idNeeded || seen.has(row.customer)) return;
      seen.add(row.customer);
      out.push({ name: row.customer, reason: flag.kyc });
    });
    return out;
  }

  function clock(date) {
    if (!date) return null;
    return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function backButton(label, onClick) {
    return (
      <button type="button" onClick={onClick} style={{ minHeight: 44, padding: 0, border: 0, background: 'transparent', color: '#6B2E54', fontWeight: 600, fontSize: 13 }}>
        {label}
      </button>
    );
  }

  function PhoneCompliance({
    regime, rows, clients, settings,
    reportable, structuring, aggregates,
    countsState, loadedAt, onRetry, onLeave, onOpenClients, onOpenClient,
    pane, detail, onOpen, onBack, children,
  }) {
    const Phone = window.CDOS.Phone;
    const [section, setSection] = useState('screening');
    const people = useMemo(() => missingId(rows, clients, settings), [rows, clients, settings]);
    const summed = regime && regime.aggregate !== false && regime.windowKind !== 'banking_day' && regime.windowKind !== 'calendar_month';
    const ready = countsState === 'ready';
    const failed = countsState === 'error';
    const loading = countsState === 'loading';
    const empty = ready && !reportable && !structuring && !people.length && (!summed || !aggregates);
    const sub = regime && regime.threshold != null && regime.currency
      ? officeLine(regime) + ' · Reporting threshold ' + phoneMoney(regime.threshold, regime.currency)
      : officeLine(regime) + ' · No large-cash amount is set on this pack.';
    const notConnected = (window.CDOS._compliance && window.CDOS._compliance.NOT_CONNECTED)
      || "Sanctions screening is not connected yet. Check clients against your government's official lists yourself.";
    const loadedLine = clock(loadedAt) ? 'Last loaded ' + clock(loadedAt) : 'Not loaded yet';
    const titles = { submissions: 'What you would file', structuring: 'Possible split deals', aggregation: windowLabel(regime), screening: 'Sanctions screening', missing: 'Clients missing ID' };
    const title = pane === 'home' ? 'Compliance' : (titles[pane === 'missing' ? 'missing' : detail] || 'Compliance');

    return (
      <Phone.Screen
        app="compliance"
        title={title}
        subtitle={pane === 'home' ? sub : pane === 'missing' ? 'ID is required on a deal and is not on the client file.' : ''}
        action={backButton(pane === 'home' ? 'More' : 'Compliance', pane === 'home' ? onLeave : onBack)}
        sticky={failed ? <Phone.StickyAction label="Try again" onClick={onRetry} /> : null}
      >
        {pane === 'missing' && (
          <div data-testid="compliance-detail">
            {!people.length && <Phone.EmptyState title="No one is missing ID" message="No one is missing ID on a deal." />}
            {!!people.length && (
              <Phone.ListSection title="Check in person">
                {people.map((person) => (
                  <Phone.ListRow key={person.name} title={person.name} subtitle={person.reason} chevron onClick={() => onOpenClient && onOpenClient(person.name)} />
                ))}
              </Phone.ListSection>
            )}
          </div>
        )}
        {pane === 'detail' && <div className="cph-detail" data-testid="compliance-detail">{children}</div>}
        {pane === 'home' && (
          <div data-testid="compliance-phone-home" data-state={countsState} data-empty={empty ? 'true' : 'false'}>
            {failed && (
              <div data-testid="compliance-error">
                <Phone.ErrorState message="Could not load compliance counts. Check your connection, then try again. Your ledger is not affected." />
              </div>
            )}
            {loading && (
              <div data-testid="compliance-loading">
                <Phone.LoadingState rows={3} label="Loading compliance" />
              </div>
            )}
            {!loading && (
              <Phone.SummaryCards columns={2} cards={[
                {
                  id: 'reportable',
                  label: 'Reportable',
                  value: !ready ? 'Not loaded' : (regime && regime.id === 'pack-ph-v1') ? 'Not filed here' : String(reportable),
                  caption: !ready ? loadedLine : (regime && regime.id === 'pack-ph-v1') ? 'You file' : (reportable ? 'You file' : 'Nothing to file'),
                  onClick: ready ? () => onOpen('submissions') : undefined,
                },
                {
                  id: 'structuring',
                  label: 'Structuring',
                  value: ready ? String(structuring) : 'Not loaded',
                  caption: !ready ? loadedLine : (structuring ? 'Warnings only' : 'No patterns to watch'),
                  onClick: ready ? () => onOpen('structuring') : undefined,
                },
              ]} />
            )}
            {ready && <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: '20px', color: '#3D3A35' }}>You file in the regulator's portal. This desk does not send the report.</p>}
            {ready && empty && <Phone.EmptyState title="Nothing needs attention" message="Nothing to file, no split-deal pattern, and no one is missing ID on a deal." />}
            {ready && (
              <Phone.FilterChips
                value={section}
                onChange={setSection}
                chips={[{ id: 'aggregation', label: windowLabel(regime) }, { id: 'screening', label: 'Screening' }]}
              />
            )}
            {ready && section === 'aggregation' && (
              <Phone.ListSection title="Today">
                <Phone.ListRow title="Large cash" subtitle={summed ? (aggregates ? aggregates + ' to review' : 'Nothing to add up') : 'Deals are not added together'} chevron onClick={() => onOpen('aggregation')} />
                <Phone.ListRow title="Possible split deals" subtitle={structuring ? 'Warnings only. The desk does not stop the deal.' : 'No patterns to watch'} chevron onClick={() => onOpen('structuring')} />
                <Phone.ListRow title="Clients missing ID" subtitle={people.length ? people.length + ' to check in person' : 'No one is missing ID on a deal'} chevron onClick={() => onOpen('missing')} />
              </Phone.ListSection>
            )}
            {ready && section === 'screening' && (
              <Phone.ListSection title="Checks">
                <div data-testid="sanctions-screening-tile">
                  <Phone.ListRow
                    title="Sanctions screening"
                    subtitle={notConnected + ' No list provider is connected yet. Clients are not checked against any sanctions or watchlist.'}
                    badge={{ label: 'Not connected', tone: 'neutral' }}
                    chevron
                    onClick={() => onOpen('screening')}
                  />
                </div>
                <Phone.ListRow
                  title="Automatic ID checks"
                  subtitle="Not available yet. Check ID in person and keep it on the client file."
                  badge={{ label: 'Not connected', tone: 'neutral' }}
                />
                <Phone.ListRow title="Open Clients" subtitle="Check ID in person and keep it on the client file." chevron onClick={onOpenClients} />
              </Phone.ListSection>
            )}
          </div>
        )}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { usePhoneWidth, phoneMoneyFn, PhoneCompliance });
})();
