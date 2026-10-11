/* Phone shell. Shared layout for every phone screen.
   Props and names are the contract in docs/PHONE_SHELL.md.
   Time, date, and money come from os-src/phone/format.js. */
(function () {
  const { useState } = React;
  const Ic = window.CDOS && window.CDOS.Ic;
  if (!Ic) throw new Error('Phone shell: icons did not load.');
  const formatPhoneMoney = window.CDOS && window.CDOS.formatPhoneMoney;
  const formatPhoneTime = window.CDOS && window.CDOS.formatPhoneTime;
  const formatPhoneDate = window.CDOS && window.CDOS.formatPhoneDate;
  const formatPhoneListGroup = window.CDOS && window.CDOS.formatPhoneListGroup;
  if (typeof formatPhoneMoney !== 'function' || typeof formatPhoneTime !== 'function' || typeof formatPhoneDate !== 'function' || typeof formatPhoneListGroup !== 'function') {
    throw new Error('Phone shell: formatters did not load.');
  }

  function svg(path) {
    return React.createElement('svg', {
      width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: path },
    });
  }

  const TAB_SVG = {
    rates: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15l3-3 3 2 4-5"/></svg>',
    ledger: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14"/></svg>',
    clients: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/></svg>',
    till: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 11h18M7 15h4"/></svg>',
    more: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
  };

  function TabIcon({ name }) {
    const html = TAB_SVG[name] || '';
    return <span className="phone-tab-ico" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  /* The desk name is cut first. The till name is next. The status
     is the last segment and stays whole, so "Till closed" never wraps.
     Every gap is the same " · ", including a caller that omitted the spaces. */
  const TILL_GAP = ' · ';

  function deskLine(desk) {
    const parts = String(desk || '').trim().split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last === 'Till open' || last === 'Till closed') {
      return { parts: parts.slice(0, -1), status: last };
    }
    return { parts, status: '' };
  }

  function PhoneTopBar({ shop, desk, tillOpen, unread, onBell, avatar }) {
    const line = deskLine(desk);
    const segments = [];
    line.parts.forEach((part, i) => {
      if (i > 0) segments.push(<span key={'gap-' + i} className="phone-till-sep">{TILL_GAP}</span>);
      segments.push(
        <span key={'part-' + i} className={'phone-till-part' + (i === 0 ? ' is-desk' : '')}>
          <span className="phone-till-where">{part}</span>
        </span>,
      );
    });
    if (line.status) {
      if (segments.length) segments.push(<span key="gap-status" className="phone-till-sep">{TILL_GAP}</span>);
      segments.push(<span key="status" className="phone-till-state">{line.status}</span>);
    }
    return (
      <header className="phone-head">
        <div className="phone-shop"><i className="phone-appdot" aria-hidden="true" /><span className="phone-shop-name">{shop}</span></div>
        <div className={'phone-till' + (tillOpen ? '' : ' is-closed')}>
          <i className="phone-till-dot" />
          <span className="phone-till-line">{segments}</span>
        </div>
        <button type="button" className="phone-bell" aria-label={unread == null ? 'Alerts' : (unread ? 'Alerts' : 'No alerts')} onClick={onBell}>
          {svg('<path d="M6 9a6 6 0 0 1 12 0c0 7 2 7 2 9H4c0-2 2-2 2-9"/><path d="M10 20a2 2 0 0 0 4 0"/>')}
          {unread ? <span className="phone-bell-dot" /> : null}
        </button>
        {avatar}
      </header>
    );
  }

  function PhoneTitle({ title, subtitle, action }) {
    return (
      <div className="phone-title">
        <div>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action || null}
      </div>
    );
  }

  function SummaryCards({ cards, columns }) {
    const cols = columns === 2 ? 2 : 3;
    return (
      <div className={'phone-stats cols-' + cols}>
        {(cards || []).map((card, i) => {
          const button = !!(card.onClick || card.disabled);
          const Tag = button ? 'button' : 'div';
          return (
            <Tag key={card.id || i} type={button ? 'button' : undefined} className="phone-stat" disabled={card.disabled ? true : undefined} onClick={card.disabled ? undefined : card.onClick}>
              <span className="phone-stat-label">{card.label}</span>
              <span className="phone-stat-value num">{card.value}</span>
              {card.caption ? <span className="phone-stat-cap">{card.caption}</span> : null}
            </Tag>
          );
        })}
      </div>
    );
  }

  function PhoneSearch({ value, onChange, placeholder, label }) {
    return (
      <div className="phone-search">
        <span className="phone-search-ico">{svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}</span>
        <input type="text" value={value || ''} aria-label={label || placeholder || 'Search'} placeholder={placeholder || 'Search'} onChange={(e) => onChange(e.target.value)} />
        {value ? (
          <button type="button" className="phone-search-clear" aria-label="Clear search" onClick={() => onChange('')}>
            {svg('<path d="M6 6l12 12M18 6 6 18"/>')}
          </button>
        ) : null}
      </div>
    );
  }

  function FilterChips({ chips, value, onChange }) {
    return (
      <div className="phone-chips" role="tablist">
        {(chips || []).map((chip) => (
          <button key={chip.id} type="button" role="tab" aria-selected={value === chip.id} className={'phone-chip' + (value === chip.id ? ' is-on' : '')} onClick={() => onChange(chip.id)}>
            <span>{chip.label}{chip.count != null ? ' ' + chip.count : ''}</span>
          </button>
        ))}
      </div>
    );
  }

  function AppGlyph({ icon, accent }) {
    return (
      <span className="phone-appic" style={{ color: accent || '#17140F' }}>
        <Ic n={icon || 'grid4'} s={22} />
      </span>
    );
  }

  function ListRow({ title, subtitle, note, amount, meta, leading, badge, chevron, onClick, danger, className, appId, disabled }) {
    const Tag = onClick ? 'button' : 'div';
    const cls = ['phone-row', note ? 'has-note' : '', appId ? 'phone-more-row' : '', danger ? 'is-danger' : '', disabled ? 'is-disabled' : '', className || ''].filter(Boolean).join(' ');
    const tone = badge && badge.tone ? badge.tone : 'neutral';
    return (
      <Tag
        type={onClick ? 'button' : undefined}
        className={cls}
        data-phone-app={appId || undefined}
        disabled={onClick && disabled ? true : undefined}
        aria-disabled={disabled ? true : undefined}
        onClick={disabled ? undefined : onClick}
      >
        {leading || null}
        <span className="phone-row-main">
          <span className={appId ? 'phone-more-name' : 'phone-row-title'}>{title}</span>
          {subtitle ? <span className="phone-row-sub">{subtitle}</span> : null}
          {note ? <span className="phone-row-note">{note}</span> : null}
        </span>
        {(amount || meta || badge) ? (
          <span className="phone-row-end">
            {badge && badge.label ? <span className={'phone-badge tone-' + tone}>{badge.label}</span> : null}
            {amount ? <span className="phone-row-amt num">{amount}</span> : null}
            {meta ? <span className="phone-row-meta">{meta}</span> : null}
          </span>
        ) : null}
        {chevron ? <span className="phone-row-chev"><Ic n="chev" s={16} /></span> : null}
      </Tag>
    );
  }

  function ListSection({ title, meta, children }) {
    return (
      <section className="phone-section">
        <div className="phone-sec"><span>{title}</span>{meta ? <span className="phone-sec-meta">{meta}</span> : null}</div>
        <div className="phone-list">{children}</div>
      </section>
    );
  }

  /* A task covers the tab bar. The footer belongs to the sheet.
     The close control is 44px. ConfirmSheet is the small
     question that stays above the bar. */
  function TaskSheet({ title, subtitle, onClose, actionLabel, onAction, actionDisabled, children }) {
    return (
      <div className="phone-task fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }} onMouseDown={onClose}>
        <div role="dialog" aria-label={title} className="phone-task-sheet w-full flex flex-col" style={{ maxWidth: 520, maxHeight: 'calc(100vh - 32px)', background: 'var(--cd-paper, #fff)', borderRadius: 16, overflow: 'hidden' }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="phone-task-head flex items-center justify-between gap-2 px-4 py-2">
            <div className="min-w-0">
              <div className="font-semibold leading-tight" style={{ color: 'var(--color-text, #161513)' }}>{title}</div>
              {subtitle ? <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted, #6B6760)' }}>{subtitle}</div> : null}
            </div>
            <button type="button" className="phone-task-close" aria-label="Close" onClick={onClose}><Ic n="x" s={18} /></button>
          </div>
          <div className="phone-task-body px-4 py-3">{children}</div>
          {actionLabel ? (
            <div className="phone-task-foot px-4 py-3">
              <button type="button" className="phone-task-go w-full font-semibold" disabled={!!actionDisabled} onClick={onAction}>{actionLabel}</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function ConfirmSheet({ title, message, confirmLabel, onConfirm, cancelLabel, onCancel }) {
    return (
      <div className="phone-confirm" style={{ background: 'var(--cd-scrim)' }} onMouseDown={onCancel}>
        <div role="dialog" aria-label={title} className="phone-confirm-sheet" style={{ background: 'var(--cd-panel, #fff)', borderRadius: '16px 16px 0 0', padding: '20px 16px 16px' }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="phone-confirm-title">{title}</div>
          {message ? <div className="phone-confirm-copy">{message}</div> : null}
          <button type="button" className="phone-confirm-yes" onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" className="phone-confirm-no" onClick={onCancel}>{cancelLabel || 'Keep editing'}</button>
        </div>
      </div>
    );
  }

  function StickyAction({ label, onClick, disabled, disabledReason }) {
    return (
      <div className="phone-sticky">
        <button type="button" className="phone-sticky-btn" disabled={!!disabled} onClick={onClick}>{label}</button>
        {disabled && disabledReason ? <p className="phone-sticky-why">{disabledReason}</p> : null}
      </div>
    );
  }

  function EmptyState({ title, message, actionLabel, onAction, icon }) {
    const mark = typeof icon === 'string' ? <Ic n={icon} s={28} /> : icon;
    return (
      <div className="phone-empty">
        {mark ? <span className="phone-empty-ico" aria-hidden="true">{mark}</span> : null}
        <h2>{title}</h2>
        {message ? <p>{message}</p> : null}
        {actionLabel && onAction ? <button type="button" className="phone-text-btn" onClick={onAction}>{actionLabel}</button> : null}
      </div>
    );
  }

  function LoadingState({ rows, label }) {
    const n = rows || 4;
    const items = [];
    for (let i = 0; i < n; i++) items.push(<div key={i} className="phone-skel" />);
    const text = label || 'Loading';
    return <div className="phone-loading" role="status" aria-label={text}><p className="phone-loading-label">{text}</p>{items}</div>;
  }

  function ErrorState({ message, onRetry }) {
    const copy = message || 'Something went wrong. Try again.';
    return (
      <div className="phone-error" role="alert">
        <p>{copy}</p>
        {onRetry ? <button type="button" className="phone-text-btn" onClick={onRetry}>Try again</button> : null}
      </div>
    );
  }

  function PhoneScreen({ app, title, subtitle, action, top, banner, tabs, sticky, children, className }) {
    const cls = ['phone-shell', sticky ? 'has-sticky' : '', className || ''].filter(Boolean).join(' ');
    return (
      <div className={cls} data-phone-shell="" data-app={app || undefined}>
        {top || null}
        {(title || subtitle || action) ? <PhoneTitle title={title} subtitle={subtitle} action={action} /> : null}
        {banner ? <div className="phone-banner">{banner}</div> : null}
        <div className="phone-scroll">{children}</div>
        {sticky || null}
        {tabs || null}
      </div>
    );
  }

  /* Branches and Assistant are front-end mocks, so they are not in
     this catalog. Texts is, and the desk only passes it when Twilio
     is set up. Search words sit beside the purpose line so "cash"
     finds Cheques, Vault, Compliance, and Till. */
  const GROUPS = [
    { title: 'Money', ids: ['transfers', 'cheques', 'vault'] },
    { title: 'Checks', ids: ['compliance', 'tagged', 'audit'] },
    { title: 'Numbers', ids: ['reports', 'dashboard'] },
    { title: 'Tools', ids: ['telegraph', 'calc', 'loan'] },
    { title: 'Shop setup', ids: ['pricing', 'store', 'settings'] },
  ];
  const CATALOG = {
    transfers: { title: 'Transfers', detail: 'Send money abroad, track it', words: 'remit wire send payout', icon: 'transferarrows' },
    cheques: { title: 'Cheques', detail: 'Cash a cheque, see holds', words: 'cash check cheque hold', icon: 'cheque' },
    vault: { title: 'Vault', detail: 'Cash in the safe, floats', words: 'cash safe float', icon: 'vaultsafe' },
    compliance: { title: 'Compliance', detail: 'Reports to file, warnings', words: 'cash str lctr alert flag', icon: 'complianceshield' },
    tagged: { title: 'Tagged deals', detail: 'Deals marked to check again', words: 'flag review', icon: 'taggedbookmark' },
    audit: { title: 'Audit trail', detail: 'Who did what, and when', words: 'log history', icon: 'audittrail' },
    reports: { title: 'Reports', detail: 'End of day, sales by currency', words: 'eod sales', icon: 'reportsdoc' },
    dashboard: { title: 'Dashboard', detail: 'Today at a glance', words: 'today summary', icon: 'dashboardgrid' },
    telegraph: { title: 'Texts', detail: 'Quote requests by text', words: 'sms message', icon: 'telegraphbubble' },
    calc: { title: 'Calculator', detail: 'Add up, convert, margin', words: 'fx convert', icon: 'calcdevice' },
    loan: { title: 'Loan calculator', detail: 'Monthly loan payment', words: 'payment interest', icon: 'loancentre' },
    pricing: { title: 'Pricing', detail: 'Spreads, fees, publish rates', words: 'spread fee rate', icon: 'pricingpercent' },
    store: { title: 'Apps', detail: 'Add or remove apps', words: 'store install', icon: 'storefront' },
    settings: { title: 'Settings', detail: 'Desk, staff, your PIN', words: 'pin staff', icon: 'gearsettings' },
  };
  const BAR = [
    { id: 'rates', title: 'Rates', detail: 'Buy and sell prices', words: 'fx board quote', icon: 'rateboard' },
    { id: 'ledger', title: 'Ledger', detail: "Today's deals", words: 'transactions deals', icon: 'ledgerbook' },
    { id: 'clients', title: 'Clients', detail: 'Find a customer', words: 'kyc customer', icon: 'clientskyc' },
    { id: 'till', title: 'Till', detail: 'Count the drawer, close the day', words: 'cash drawer count', icon: 'tilldrawer' },
  ];

  function matches(item, query) {
    const hay = (item.title + ' ' + item.detail + ' ' + item.words).toLowerCase();
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every((token) => hay.indexOf(token) >= 0);
  }

  function PhoneMore({ allowed, accent, onOpen, onLock, onHandover, onSignOut }) {
    const [query, setQuery] = useState('');
    const [armSignOut, setArmSignOut] = useState(false);
    const allow = {};
    (allowed || []).forEach((id) => { allow[id] = true; });
    const q = query.trim();
    const pick = (id) => {
      if (!allow[id] || !CATALOG[id]) return null;
      const item = CATALOG[id];
      if (q && !matches(item, q)) return null;
      return { id, ...item };
    };
    const row = (item) => (
      <ListRow
        key={item.id}
        appId={item.id}
        title={item.title}
        subtitle={item.detail}
        leading={<AppGlyph icon={item.icon} accent={(accent && accent[item.id]) || '#17140F'} />}
        chevron
        onClick={() => onOpen && onOpen(item.id)}
      />
    );
    let body;
    if (!q) {
      body = GROUPS.map((group) => {
        const items = group.ids.map(pick).filter(Boolean);
        if (!items.length) return null;
        return <ListSection key={group.title} title={group.title}>{items.map(row)}</ListSection>;
      });
    } else {
      const found = [];
      GROUPS.forEach((group) => group.ids.forEach((id) => { const item = pick(id); if (item) found.push(item); }));
      const bar = BAR.filter((item) => matches(item, q));
      body = (
        <>
          {found.length || bar.length ? <div className="phone-sec">Results for "{q}"</div> : null}
          {found.length ? <div className="phone-list">{found.map(row)}</div> : null}
          {bar.length ? (
            <ListSection title="On the bottom bar">
              {bar.map((item) => row(item))}
            </ListSection>
          ) : null}
          {!found.length && !bar.length ? <EmptyState title="No matches" message={'Nothing matches "' + q + '".'} /> : null}
          <p className="phone-search-hint">Search looks at app names and what each app does.</p>
        </>
      );
    }
    const sticky = !q && armSignOut
      ? <StickyAction label="Sign out" onClick={onSignOut} />
      : null;
    return (
      <PhoneScreen
        app="more"
        sticky={sticky}
        banner={<PhoneSearch value={query} onChange={(next) => { setQuery(next); if (next) setArmSignOut(false); }} placeholder="Search" label="Search apps" />}
      >
        {body}
        {q ? null : (
          <ListSection title="Your session">
            <ListRow className="phone-session-row" title="Lock the desk" subtitle="Step away, PIN to return" leading={<AppGlyph icon="lock" accent="#17140F" />} chevron onClick={onLock} />
            <ListRow className="phone-session-row" title="Hand over the desk" subtitle="Another cashier takes over" leading={<AppGlyph icon="users" accent="#17140F" />} chevron onClick={onHandover} />
            <ListRow className="phone-session-row" danger title="Sign out" subtitle="Asks first, till stays open" leading={<AppGlyph icon="logout" accent="#B42318" />} chevron onClick={() => setArmSignOut(true)} />
          </ListSection>
        )}
      </PhoneScreen>
    );
  }

  const Phone = {
    TopBar: PhoneTopBar,
    Title: PhoneTitle,
    SummaryCards,
    Search: PhoneSearch,
    FilterChips,
    ListRow,
    ListSection,
    StickyAction,
    TaskSheet,
    ConfirmSheet,
    EmptyState,
    LoadingState,
    ErrorState,
    Screen: PhoneScreen,
    More: PhoneMore,
    TabIcon,
    formatMoney: formatPhoneMoney,
    formatTime: formatPhoneTime,
    formatDate: formatPhoneDate,
    formatListGroup: formatPhoneListGroup,
  };
  window.CDOS = Object.assign(window.CDOS || {}, { formatPhoneMoney, formatPhoneTime, formatPhoneDate, formatPhoneListGroup, Phone });
})();
