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
   - Detail views are phone lists. The filing worksheet says to open
     it on a computer. A selected chip stays gray-900.
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

  /* Dates read "Oct 11, 2026". Times read "2:05 PM". An ISO day or a
     24-hour clock never reaches the screen. */
  function asDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    const text = String(value || '');
    if (!text) return null;
    const day = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (text.indexOf('T') !== -1 || text.indexOf(':') !== -1) {
      const parsed = new Date(text);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function phoneDate(value) {
    const date = asDate(value);
    if (!date) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function phoneClock(value) {
    const date = value instanceof Date ? asDate(value) : null;
    let hour = null;
    let minute = null;
    if (date) {
      hour = date.getHours();
      minute = date.getMinutes();
    } else {
      const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
      if (!match) return '';
      hour = Number(match[1]);
      minute = Number(match[2]);
      if (hour > 23 || minute > 59) return '';
    }
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const face = hour % 12 || 12;
    return face + ':' + (minute < 10 ? '0' : '') + minute + ' ' + suffix;
  }

  function windowWords(start, end) {
    const from = asDate(start);
    const to = asDate(end);
    if (!from) return '';
    const left = phoneDate(from) + ', ' + phoneClock(from);
    if (!to) return left;
    const sameDay = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth() && from.getDate() === to.getDate();
    const right = sameDay ? phoneClock(to) : phoneDate(to) + ', ' + phoneClock(to);
    return left + ' to ' + right;
  }

  function kindWords(regime, kind) {
    if (regime && kind && kind === regime.largeCode) return 'Large cash';
    if (regime && kind && kind === regime.wireCode) return 'Wire';
    if (regime && kind && kind === regime.strCode) return 'Suspicious activity';
    return 'Report';
  }

  function backControl(label, onClick) {
    const Ic = window.CDOS.Ic;
    return (
      <button type="button" className="cph-back" onClick={onClick}>
        {Ic ? <Ic n="arrowleft" s={18} /> : null}
        <span>{label}</span>
      </button>
    );
  }

  function splitCases(rows, clients, settings) {
    const flags = window.CDOS.computeFlags(rows, clients, settings);
    const cashIn = window.CDOS._compliance && window.CDOS._compliance.cashIn;
    const grouped = new Map();
    (rows || []).forEach((row) => {
      const flag = flags[row.id];
      if (!flag || flag.void || !flag.str) return;
      const item = grouped.get(row.customer) || { customer: row.customer, txs: [], lastDate: '' };
      item.txs.push(row);
      if ((row.date || '') > item.lastDate) item.lastDate = row.date || '';
      grouped.set(row.customer, item);
    });
    return [...grouped.values()].map((item) => {
      let sum = 0;
      let seen = false;
      item.txs.forEach((row) => {
        const amount = cashIn ? cashIn(row) : null;
        if (typeof amount === 'number' && isFinite(amount)) { sum += amount; seen = true; }
      });
      return { customer: item.customer, txs: item.txs, lastDate: item.lastDate, sum: seen ? sum : null };
    });
  }

  function PhoneCompliance({
    regime, rows, clients, settings, beneficiaries, subs, clusters,
    reportable, structuring, aggregates,
    countsState, loadedAt, onRetry, onLeave, onOpenClients, onOpenClient,
    pane, detail, onOpen, onBack, computer, onCloseComputer,
  }) {
    const Phone = window.CDOS.Phone;
    const [section, setSection] = useState('screening');
    const [drill, setDrill] = useState(null);
    const [form, setForm] = useState(false);
    useEffect(() => { setDrill(null); setForm(false); }, [pane, detail]);
    const people = useMemo(() => missingId(rows, clients, settings), [rows, clients, settings]);
    const splits = useMemo(() => splitCases(rows, clients, settings), [rows, clients, settings]);
    const reportables = useMemo(() => {
      const build = window.CDOS.computeReportables;
      if (typeof build !== 'function') return [];
      return build(rows, clients, settings, beneficiaries, subs) || [];
    }, [rows, clients, settings, beneficiaries, subs]);
    const summed = regime && regime.aggregate !== false && regime.windowKind !== 'banking_day' && regime.windowKind !== 'calendar_month';
    const ready = countsState === 'ready';
    const failed = countsState === 'error';
    const loading = countsState === 'loading';
    const empty = ready && !reportable && !structuring && !people.length && (!summed || !aggregates);
    const philippines = regime && regime.id === 'pack-ph-v1';
    const showComputer = form || !!computer;
    const sub = regime && regime.threshold != null && regime.currency
      ? officeLine(regime) + ' · Reporting threshold ' + phoneMoney(regime.threshold, regime.currency)
      : officeLine(regime) + ' · No large-cash amount is set on this pack.';
    const notConnected = (window.CDOS._compliance && window.CDOS._compliance.NOT_CONNECTED)
      || "Sanctions screening is not connected yet. Check clients against your government's official lists yourself.";
    const screeningCopy = notConnected + ' No list provider is connected yet. Clients are not checked against any sanctions or watchlist.';
    const loadedLine = loadedAt ? 'Last loaded ' + phoneClock(loadedAt) : 'Not loaded yet';
    const fileLine = "You file in the regulator's portal. This desk does not send the report.";
    const titles = { submissions: 'What you would file', structuring: 'Possible split deals', aggregation: windowLabel(regime), screening: 'Sanctions screening', missing: 'Clients missing ID' };
    const viewKey = pane === 'missing' ? 'missing' : detail;
    let title = 'Compliance';
    let subtitle = sub;
    let backLabel = 'More';
    let back = onLeave;
    if (showComputer) {
      title = 'Filing form';
      subtitle = '';
      backLabel = 'Compliance';
      back = () => { setForm(false); if (onCloseComputer) onCloseComputer(); };
    } else if (drill) {
      title = drill.title;
      subtitle = drill.note || '';
      backLabel = 'Compliance';
      back = () => setDrill(null);
    } else if (pane !== 'home') {
      title = titles[viewKey] || 'Compliance';
      subtitle = viewKey === 'missing' ? 'ID is required on a deal and is not on the client file.'
        : viewKey === 'structuring' ? 'Warnings only. The desk does not stop the deal.'
        : viewKey === 'submissions' && reportables.length ? fileLine
        : viewKey === 'aggregation' && summed && clusters && clusters.length ? 'Cash in one static window. ' + fileLine
        : '';
      backLabel = 'Compliance';
      back = onBack;
    }

    const dealList = (list, note) => (
      <div data-testid="compliance-detail-deals">
        <p className="cph-note">{note}</p>
        {!list.length && <Phone.EmptyState title="No deals in this list" message="Nothing in this list can be shown." />}
        {!!list.length && (
          <Phone.ListSection title="Deals">
            {list.map((deal) => (
              <Phone.ListRow key={deal.id} title={deal.title} subtitle={deal.subtitle} amount={deal.amount} />
            ))}
          </Phone.ListSection>
        )}
      </div>
    );

    const openDeals = (heading, note, txs, amountOf) => setDrill({
      title: heading,
      note,
      rows: (txs || []).map((tx, index) => ({
        id: tx.id || tx.ref || index,
        title: phoneDate(tx.date) || 'Deal',
        subtitle: phoneClock(tx.time),
        amount: amountOf(tx),
      })),
    });

    return (
      <Phone.Screen
        app="compliance"
        title={title}
        subtitle={subtitle}
        top={backControl(backLabel, back)}
        sticky={failed && pane === 'home' && !showComputer ? <Phone.StickyAction label="Try again" onClick={onRetry} /> : null}
      >
        {showComputer && (
          <div data-testid="compliance-open-computer">
            <Phone.EmptyState title="Open this on a computer" message="The filing worksheet is the regulator's form, field by field. This phone does not show that form, and this desk does not send the report." />
          </div>
        )}
        {!showComputer && drill && dealList(drill.rows, drill.note)}
        {!showComputer && !drill && pane === 'missing' && (
          <div data-testid="compliance-detail-missing">
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
        {!showComputer && !drill && pane === 'detail' && viewKey === 'screening' && (
          <div data-testid="compliance-not-connected">
            <Phone.EmptyState title="Not connected" message={screeningCopy} />
          </div>
        )}
        {!showComputer && !drill && pane === 'detail' && viewKey === 'submissions' && (
          <div data-testid="compliance-detail-filings">
            {philippines && <Phone.EmptyState title="Not filed here" message={'The owner files in the regulator\'s portal. ' + fileLine} />}
            {!philippines && !reportables.length && (
              <Phone.EmptyState title="Nothing to file" message={fileLine} actionLabel="Open this on a computer" onAction={() => setForm(true)} />
            )}
            {!philippines && !!reportables.length && (
              <Phone.ListSection title="Reports">
                {reportables.map((report) => {
                  const filed = subs && subs[report.id] && subs[report.id].status === 'submitted';
                  return (
                    <Phone.ListRow
                      key={report.id}
                      title={report.subject || 'Unnamed client'}
                      subtitle={[kindWords(regime, report.kind), phoneDate(report.date)].filter(Boolean).join(' · ')}
                      amount={regime && regime.currency ? phoneMoney(report.amount, regime.currency) : ''}
                      badge={{ label: filed ? 'Filed' : 'You file', tone: filed ? 'pos' : 'neutral' }}
                      chevron
                      onClick={() => setForm(true)}
                    />
                  );
                })}
              </Phone.ListSection>
            )}
          </div>
        )}
        {!showComputer && !drill && pane === 'detail' && viewKey === 'structuring' && (
          <div data-testid="compliance-detail-structuring">
            {!splits.length && <Phone.EmptyState title="No patterns to watch" message="No one is sitting just under the reporting line. The desk does not stop a deal." />}
            {!!splits.length && (
              <Phone.ListSection title="Warnings only">
                {splits.map((item) => (
                  <Phone.ListRow
                    key={item.customer}
                    title={item.customer}
                    subtitle={[item.txs.length + ' just-under deals', phoneDate(item.lastDate)].filter(Boolean).join(' · ')}
                    amount={item.sum != null && regime && regime.currency ? phoneMoney(item.sum, regime.currency) : ''}
                    badge={{ label: 'Warnings only', tone: 'warn' }}
                    chevron
                    onClick={() => openDeals(item.customer, 'Warnings only. The desk does not stop the deal.', item.txs, (tx) => {
                      const cashIn = window.CDOS._compliance && window.CDOS._compliance.cashIn;
                      const amount = cashIn ? cashIn(tx) : null;
                      return amount != null && regime && regime.currency ? phoneMoney(amount, regime.currency) : '';
                    })}
                  />
                ))}
              </Phone.ListSection>
            )}
          </div>
        )}
        {!showComputer && !drill && pane === 'detail' && viewKey === 'aggregation' && (
          <div data-testid="compliance-detail-aggregation">
            {!summed && <Phone.EmptyState title="Deals are not added together" message={regime && regime.threshold != null && regime.currency ? 'A single amount of ' + phoneMoney(regime.threshold, regime.currency) + ' or more stands on its own. ' + fileLine : 'No large-cash amount is set on this pack. ' + fileLine} />}
            {summed && !(clusters && clusters.length) && <Phone.EmptyState title="Nothing to add up" message={'No total in this window is over the line. ' + fileLine} />}
            {summed && !!(clusters && clusters.length) && (
              <Phone.ListSection title="In this window">
                {clusters.map((cluster) => (
                  <Phone.ListRow
                    key={cluster.id}
                    title={cluster.subject || 'Large cash'}
                    subtitle={[
                      (cluster.txs ? cluster.txs.length : 0) + (cluster.kind === (regime && regime.wireCode) ? ' transfers' : ' cash-ins'),
                      windowWords(cluster.windowStart, cluster.windowEnd),
                    ].filter(Boolean).join(' · ')}
                    amount={regime && regime.currency ? phoneMoney(cluster.total, regime.currency) : ''}
                    badge={{ label: 'You file', tone: 'neutral' }}
                    chevron
                    onClick={() => openDeals(cluster.subject || 'Large cash', fileLine, cluster.txs, (tx) => (
                      tx.amt != null && regime && regime.currency ? phoneMoney(tx.amt, regime.currency) : ''
                    ))}
                  />
                ))}
              </Phone.ListSection>
            )}
          </div>
        )}
        {pane === 'home' && !showComputer && !drill && (
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
            {ready && <p className="cph-note">{fileLine}</p>}
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
