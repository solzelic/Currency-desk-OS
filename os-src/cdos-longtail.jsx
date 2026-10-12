/* ============================================================
   Long-tail phone template.

   One screen for the apps under More. It is the phone shell's
   Screen, cards, chips, search, rows, and one sticky button.
   Read-only apps omit the button.

   Phone only. usePhone() is false above 430px, and the caller
   does not mount this tree there. The shop header and the bottom
   bar belong to the shell. This file is the content between them.

   Amounts go through window.CDOS.formatPhoneMoney, which the
   phone shell installs. A figure it will not format stays absent
   and the screen says "No rate yet". Never a bare zero.

   See docs/PHONE_SHELL.md.
   ============================================================ */
(function () {
  const { useState, useEffect, useRef } = React;
  const QUERY = '(max-width: 430px)';

  function usePhone() {
    const [on, setOn] = useState(() => window.matchMedia(QUERY).matches);
    useEffect(() => {
      const mq = window.matchMedia(QUERY);
      const go = () => setOn(mq.matches);
      go();
      mq.addEventListener('change', go);
      return () => mq.removeEventListener('change', go);
    }, []);
    return on;
  }

  /* '' from the formatter means there is no figure. A real zero is "0.00 CAD". */
  function money(amount, code) {
    const text = window.CDOS.formatPhoneMoney(amount, code);
    return text || null;
  }

  /* The last word of a currency name is a common noun. DisplayNames
     here returns title case ("Canadian Dollar", "US Dollar"). Sentence
     case keeps the proper words and a short capital ("US dollar").
     Pricing is moving to this same DisplayNames source. */
  const CURRENCY_NOUN = {
    dollar: 1, dollars: 1, pound: 1, pounds: 1, peso: 1, pesos: 1,
    yuan: 1, dirham: 1, rupee: 1, rupees: 1, franc: 1, francs: 1,
    krone: 1, krona: 1, kroner: 1, yen: 1, won: 1, rand: 1,
    baht: 1, forint: 1, shekel: 1, lira: 1, riyal: 1, dinar: 1,
  };

  function sentenceCurrencyName(raw) {
    return String(raw || '').split(/\s+/).filter(Boolean).map((word, i) => {
      if (word.length <= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      const lower = word.toLowerCase();
      if (CURRENCY_NOUN[lower]) return lower;
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
  }

  function ccyName(code) {
    const raw = String(code || '').toUpperCase();
    try {
      const named = new Intl.DisplayNames(['en'], { type: 'currency' }).of(raw);
      if (named && named !== raw) return sentenceCurrencyName(named);
    } catch (e) {
      /* An unknown code has no English name. The code itself is the label. */
    }
    return raw;
  }

  /* The shared back control is a foundation follow-up. This is the
     same link on every long-tail screen until that lands: a 24px
     chevron and the word More, back to the More list. */
  function backToMore() {
    const tab = document.querySelector('#phonebar [data-phone-app="more"]');
    if (tab) tab.click();
  }

  function BackLink() {
    return (
      <button type="button" className="phone-back" onClick={backToMore}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18 9 12 15 6" />
        </svg>
        More
      </button>
    );
  }

  function Segments({ items, value, onChange }) {
    return (
      <div className="phone-seg" role="tablist">
        {items.map(s => (
          <button key={s.id} type="button" role="tab" aria-selected={value === s.id} className={value === s.id ? 'is-on' : ''} onClick={() => onChange(s.id)}>{s.label}</button>
        ))}
      </div>
    );
  }

  function LongTailScreen(props) {
    const Phone = window.CDOS.Phone;
    const ready = props.state == null || props.state === 'ready';
    const showAction = props.action && props.state !== 'loading' && props.state !== 'error';
    const cards = (props.summary || []).map(card => ({
      label: card.label,
      value: card.value == null ? 'No rate yet' : card.value,
      caption: card.sub,
    }));
    const filters = ready && props.segments && props.segments.length >= 2 && props.segments.length <= 4
      ? <Segments items={props.segments} value={props.segment} onChange={props.onSegment} />
      : (ready && props.chips ? <Phone.FilterChips chips={props.chips} value={props.chip} onChange={props.onChip} /> : null);
    return (
      <Phone.Screen
        app={props.app}
        className="longtail"
        title={props.title}
        subtitle={props.subtitle}
        action={<BackLink />}
        sticky={showAction ? <Phone.StickyAction label={props.action} onClick={props.onAction} /> : null}
        top={<>
          {props.toast ? <div className="phone-toast" role="status">{props.toast}</div> : null}
          {props.sheet || null}
        </>}
      >
        {props.state === 'loading' && (
          <div>
            <p className="phone-note">{props.loadingText || 'Loading…'}</p>
            <Phone.LoadingState rows={6} label={props.loadingText || 'Loading'} />
          </div>
        )}
        {props.state === 'error' && (
          <div>
            <Phone.ErrorState message={props.errorText} onRetry={props.onRetry} />
            {props.errorDetail && props.errorDetail !== props.errorText ? <p className="phone-error-detail">{props.errorDetail}</p> : null}
          </div>
        )}
        {props.state === 'empty' && (
          <Phone.EmptyState title={props.emptyText} actionLabel={props.emptyAction} onAction={props.onEmpty} />
        )}
        {ready && cards.length > 0 && <Phone.SummaryCards columns={cards.length > 1 ? 2 : 3} cards={cards} />}
        {filters}
        {ready && (
          <Phone.Search value={props.search || ''} onChange={props.onSearch} placeholder={props.searchPlaceholder || 'Search'} label={props.searchPlaceholder || 'Search'} />
        )}
        {ready ? props.children : null}
      </Phone.Screen>
    );
  }

  window.CDOS.LongTail = { usePhone, LongTailScreen, money, ccyName, BackLink, backToMore };
})();
