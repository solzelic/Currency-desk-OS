/* ============================================================
   Phone Rates — the cashier's board.

   A customer at the counter asks one question: what do I get?
   One row per currency, a quote when the row is tapped, and
   Start this deal hands that quote to the existing New
   transaction. Feed, margins and publish stay on the desktop
   Rate Board and in Pricing.

   The column, the search, the rows, the sticky button, the
   loading / empty / error states, and the money line are the
   shared phone shell (docs/PHONE_SHELL.md). This file does not
   copy them. The quote sheet is screen-local: the shell does
   not have one yet.

   Phone only. The OS mounts this under 430px. Wider than that,
   the Rate Board iframe is what the window still draws.
   ============================================================ */
(function () {
  const { useState, useEffect, useMemo, useRef } = React;
  const HOME_FALLBACK = 'CAD';
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  /* Named by the desk, and also any unit priced under 0.10 of home,
     which is the same rule the board uses for a small currency. */
  const PER_HUNDRED = { INR: true, PHP: true, MXN: true };

  function homeCode() {
    const fn = window.CDOS && window.CDOS.deskHomeCcy;
    const code = fn ? fn() : HOME_FALLBACK;
    return code || HOME_FALLBACK;
  }

  /* Money uses the shared formatter. A rate is not money: it stays
     four decimals, and the code is written on the quote line. */
  function amountLine(value, code) {
    const shared = window.CDOS && window.CDOS.formatPhoneMoney;
    if (typeof shared === 'function') return shared(value, code) || '—';
    if (value == null || !isFinite(+value)) return '—';
    const text = (+value).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return text + ' ' + (code || HOME_FALLBACK);
  }

  /* The shared clock. 15:02 is "3:02 pm". A calendar day would
     go through formatPhoneDate and read "Oct 11, 2026". This
     screen names a time only. An instant uses the branch zone,
     which defaults to America/Toronto. */
  function clock12(ms) {
    const fn = window.CDOS && window.CDOS.formatPhoneTime;
    if (typeof fn !== 'function' || !ms) return '';
    return fn(new Date(ms)) || '';
  }

  /* Live only when a real provider snapshot is fresh. A locked board,
     a stale pull, and the built-in rates each say so in words. */
  function statusOf(feed, locked) {
    if (locked) {
      let at = null;
      try { at = localStorage.getItem('yorkfx_rates_locked_at'); } catch (e) { at = null; }
      const time = at && !isNaN(+at) ? clock12(+at) : '';
      return { tone: 'locked', text: time ? 'Rates locked at ' + time : 'Rates locked' };
    }
    const provider = feed && feed.provider;
    const at = feed && Number(feed.fetchedAt);
    const live = provider === 'openexchangerates.org' || provider === 'open.er-api.com';
    if (live && at > 0) {
      const time = clock12(at);
      if (Date.now() - at <= TWO_HOURS) return { tone: 'live', text: 'Live, updated ' + time };
      return { tone: 'stale', text: 'Rates not updated since ' + time + '. Ask the owner.' };
    }
    return { tone: 'saved', text: 'Last updated — not a live feed' };
  }

  function currencyName(code) {
    const row = (typeof CUR !== 'undefined') ? CUR.find(c => c.code === code) : null;
    return (row && row.name) || code;
  }

  /* x100 follows the CAD board: the named small units, and any
     currency whose CAD mid is under 0.10. The mark is display-only. */
  function perHundred(code, cadMid) {
    return !!PER_HUNDRED[code] || (cadMid > 0 && cadMid < 0.1);
  }

  /* Home currency for 1 unit, from the same buy and sell priceDeal
     uses. On a Canada desk the home leg is 1, so this is buyUnitCad
     or sellUnitCad. Another desk gets that currency per unit. A CAD
     figure is not relabelled as the home currency. */
  function homePerOne(code, settings, which) {
    const home = homeCode();
    const leg = which === 'sell' ? window.CDOS.sellUnitCad(code, settings) : window.CDOS.buyUnitCad(code, settings);
    const homeLeg = which === 'sell' ? window.CDOS.buyUnitCad(home, settings) : window.CDOS.sellUnitCad(home, settings);
    if (!(leg > 0) || !(homeLeg > 0)) return 0;
    return leg / homeLeg;
  }

  function rateText(unit, hundred) {
    const n = hundred ? unit * 100 : unit;
    return (Math.round((n + Number.EPSILON) * 10000) / 10000).toFixed(4);
  }

  /* The same buy and sell the Calculator FX mode prices with.
     A zero is not a rate: the row is left out. */
  function buildRows(settings) {
    const home = homeCode();
    const order = (typeof CUR !== 'undefined' ? CUR : [])
      .map(c => c.code)
      .filter(c => c && c !== home);
    let board = null;
    try { board = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || 'null'); } catch (e) { board = null; }
    const rowsOf = (board && board.rows) || {};
    const visible = [];
    order.forEach(code => {
      const published = rowsOf[code];
      if (published && published.show === false) return;
      const buy = homePerOne(code, settings, 'buy');
      const sell = homePerOne(code, settings, 'sell');
      if (!(buy > 0) || !(sell > 0)) return;
      const cadMid = window.CDOS.unitCadMid ? window.CDOS.unitCadMid(code) : 0;
      const hundred = perHundred(code, cadMid);
      visible.push({
        code,
        name: currencyName(code),
        hundred,
        buy: rateText(buy, hundred),
        sell: rateText(sell, hundred),
      });
    });
    const top = visible.slice(0, 6);
    const rest = visible.slice(6).sort((a, b) => a.code.localeCompare(b.code));
    return top.concat(rest);
  }

  function quoteOf(side, code, amount, settings) {
    const home = homeCode();
    const amt = parseFloat(amount);
    const feeRaw = settings && settings.defaultFee != null && settings.defaultFee !== '' ? +settings.defaultFee : 0;
    const fee = isFinite(feeRaw) ? feeRaw : 0;
    const unit = homePerOne(code, settings, side === 'buys' ? 'sell' : 'buy');
    const cadMid = window.CDOS.unitCadMid ? window.CDOS.unitCadMid(code) : 0;
    const hundred = perHundred(code, cadMid);
    if (!(amt > 0) || !(unit > 0)) {
      return { home, fee, unit, hundred, gets: null, getsCcy: side === 'buys' ? code : home };
    }
    const deal = side === 'buys'
      ? window.CDOS.priceDeal({ inCcy: home, outCcy: code, inAmt: amt, settings })
      : window.CDOS.priceDeal({ inCcy: code, outCcy: home, inAmt: amt, settings });
    return { home, fee, unit, hundred, gets: deal.outAmt, getsCcy: side === 'buys' ? code : home };
  }

  function PhoneRates({ settings, role, locked, rateVersion, onNewDeal, onQuoteDeal, onEditPricing }) {
    const Phone = window.CDOS.Phone;
    const [phase, setPhase] = useState('loading');
    const [feed, setFeed] = useState(null);
    const [query, setQuery] = useState('');
    const [quote, setQuote] = useState(null);
    const [side, setSide] = useState('sells');
    const [amount, setAmount] = useState('');
    const [picking, setPicking] = useState(false);
    const [homeTick, setHomeTick] = useState(0);
    const amountRef = useRef(null);
    const canEdit = role === 'Owner' || role === 'Manager';

    const load = () => {
      setPhase('loading');
      fetch('/api/rates/market', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error('GET /api/rates/market answered ' + r.status);
          return r.json();
        })
        .then(data => { setFeed(data || null); setPhase('ready'); })
        .catch(err => {
          console.error('Rates did not load', err);
          setFeed(null);
          setPhase('error');
        });
    };
    useEffect(() => { load(); }, []);
    useEffect(() => {
      const sync = () => setHomeTick(n => n + 1);
      window.addEventListener('cdos-jurisdiction', sync);
      return () => window.removeEventListener('cdos-jurisdiction', sync);
    }, []);
    useEffect(() => {
      if (quote && amountRef.current) amountRef.current.focus();
    }, [quote && quote.code]);

    const rows = useMemo(() => (phase === 'ready' ? buildRows(settings) : []), [phase, settings, rateVersion, feed, homeTick]);
    const q = query.trim().toLowerCase();
    const shown = rows.filter(r => !q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    const status = statusOf(feed, locked);
    const home = homeCode();
    const priced = quote ? quoteOf(side, quote.code, amount, settings) : null;
    const canStart = !!(priced && priced.gets != null);

    const openQuote = (row) => { setSide('sells'); setAmount(''); setPicking(false); setQuote(row); };
    const startDeal = () => {
      if (!canStart || !onQuoteDeal) return;
      onQuoteDeal({
        side: side === 'buys' ? 'customer-buys' : 'customer-sells',
        currency: quote.code,
        amount,
        rate: priced.unit,
      });
      setQuote(null);
    };
    const typeAmount = (raw) => {
      const cleaned = String(raw || '').replace(/[^0-9.]/g, '');
      const parts = cleaned.split('.');
      setAmount(parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : cleaned);
    };

    const edit = canEdit
      ? <button type="button" className="phone-rates-edit" onClick={onEditPricing}>Edit</button>
      : null;
    const banner = (
      <div data-phone-rates={phase}>
        <p className={'phone-rates-status is-' + status.tone} data-phone-rates-status={status.tone}><i aria-hidden="true" />{status.text}</p>
        <Phone.Search value={query} onChange={setQuery} placeholder="Find a currency" label="Find a currency" />
      </div>
    );

    return (
      <Phone.Screen
        app="rates"
        className="phone-rates"
        title="Rates"
        action={edit}
        banner={banner}
        sticky={phase === 'ready' ? <Phone.StickyAction label="New deal" onClick={onNewDeal} /> : null}
      >
        {phase === 'ready' && (
          <p className="phone-rates-explain">Prices in {home} for 1 unit (x100: for 100 units). <b className="is-buy">We buy</b>: the customer gives us that currency. <b className="is-sell">We sell</b>: the customer takes it.</p>
        )}
        {phase === 'loading' && <Phone.LoadingState rows={6} label="Loading rates" />}
        {phase === 'error' && <Phone.ErrorState message="Rates did not load. Try again." onRetry={load} />}
        {phase === 'ready' && rows.length === 0 && <Phone.EmptyState title="No rates yet" message="The desk has no currency to quote." />}
        {phase === 'ready' && rows.length > 0 && (
          <div>
            <div className="phone-rates-head"><span>Currency</span><span>We buy</span><span>We sell</span></div>
            <div className="phone-list">
              {shown.length === 0 && <Phone.EmptyState title="No currency matches." />}
              {shown.map(row => (
                <Phone.ListRow
                  key={row.code}
                  className={'phone-rate code-' + row.code}
                  title={row.hundred ? row.code + ' x100' : row.code}
                  subtitle={row.name}
                  amount={row.buy}
                  meta={row.sell}
                  onClick={() => openQuote(row)}
                />
              ))}
            </div>
          </div>
        )}
        {quote && priced && ReactDOM.createPortal(
          <div className="phone-quote" role="dialog" aria-label={'Quote ' + quote.name}>
            <div className="phone-quote-bar">
              <button type="button" onClick={() => { setQuote(null); setPicking(false); }}>Cancel</button>
              <h2>Quote {quote.name}</h2>
              <span />
            </div>
            <div className="phone-quote-body">
              <div className="phone-quote-seg" role="tablist">
                <button type="button" role="tab" aria-selected={side === 'sells'} className={side === 'sells' ? 'is-on' : ''} onClick={() => setSide('sells')}>Customer sells</button>
                <button type="button" role="tab" aria-selected={side === 'buys'} className={side === 'buys' ? 'is-on' : ''} onClick={() => setSide('buys')}>Customer buys</button>
              </div>
              <div className="phone-quote-amt">
                <span className="k">Customer gives</span>
                <span className="v">
                  <input ref={amountRef} value={amount} onChange={e => typeAmount(e.target.value)} inputMode="decimal" aria-label="Customer gives" placeholder="0.00" />
                  <button type="button" className="c" onClick={() => setPicking(true)} aria-label={'Change currency, now ' + quote.code}>{side === 'buys' ? home : quote.code}</button>
                </span>
              </div>
              <div className="phone-quote-gets">
                <span className="k">Customer gets</span>
                <b aria-live="polite">{priced.gets == null ? '—' : amountLine(priced.gets, priced.getsCcy)}</b>
              </div>
              <div className="phone-quote-kv">
                <div><span>{priced.hundred ? 'Our rate (we ' + (side === 'buys' ? 'sell' : 'buy') + ', for 100)' : 'Our rate (we ' + (side === 'buys' ? 'sell' : 'buy') + ')'}</span><b className={side === 'buys' ? 'is-sell' : 'is-buy'}>{rateText(priced.unit, priced.hundred)} {priced.home}</b></div>
                <div><span>Fee</span><b>{amountLine(priced.fee, home)}</b></div>
              </div>
              <p className="phone-quote-note">The fee is set in Pricing. The deal uses the rate showing when you post it.</p>
              {picking && (
                <div className="phone-quote-pick" role="listbox" aria-label="Currencies">
                  {rows.map(row => (
                    <button key={row.code} type="button" role="option" aria-selected={row.code === quote.code} onClick={() => { setQuote(row); setPicking(false); }}>
                      <b>{row.code}</b><span>{row.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="phone-quote-foot">
              <Phone.StickyAction label="Start this deal" onClick={startDeal} disabled={!canStart} disabledReason={canStart ? '' : 'Type what the customer gives.'} />
            </div>
          </div>,
          document.body)}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneRates });
})();
