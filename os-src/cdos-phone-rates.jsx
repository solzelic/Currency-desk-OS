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
  /* The market sync republishes on the hour unless a desk sets
     RATES_SYNC_MINUTES. The line says that cadence, and the dot
     turns amber only once a snapshot is older than it. */
  const HOUR = 60 * 60 * 1000;
  /* Named by the desk, and also any unit priced under 0.10 of home,
     which is the same rule the board uses for a small currency. */
  const PER_HUNDRED = { INR: true, PHP: true, MXN: true };
  let names = null;
  let quoteCustomerId = '';

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

  /* The shared clock. 15:02 is "3:02 PM". A calendar day would
     go through formatPhoneDate and read "Oct 11, 2026". This
     screen names a time only. An instant uses the branch zone,
     which defaults to America/Toronto. */
  function clock12(ms) {
    const fn = window.CDOS && window.CDOS.formatPhoneTime;
    if (typeof fn !== 'function' || !ms) return '';
    return fn(new Date(ms)) || '';
  }

  /* A lock names its own moment. Everything else names the snapshot
     we actually have: the provider pull when one exists, otherwise
     the published board. No time means we do not invent one. */
  function stampOf(feed, boardAt) {
    const market = feed && Number(feed.fetchedAt);
    if (market > 0) return market;
    const published = Number(boardAt);
    return published > 0 ? published : 0;
  }

  function statusOf(feed, boardAt, locked) {
    if (locked) {
      let at = null;
      try { at = localStorage.getItem('yorkfx_rates_locked_at'); } catch (e) { at = null; }
      const time = at && !isNaN(+at) ? clock12(+at) : '';
      return { tone: 'locked', text: time ? 'Rates locked at ' + time : 'Rates locked' };
    }
    const at = stampOf(feed, boardAt);
    const time = at ? clock12(at) : '';
    if (!time || Date.now() - at > HOUR) return { tone: 'aged', text: 'Rates may be out of date' };
    return { tone: 'fresh', text: 'Updated ' + time + ' · refreshes hourly' };
  }

  /* Sentence case, from the same Intl.DisplayNames the rate catalog
     uses ("US dollar", "Swiss franc"). The app table is the fallback
     when that lookup is missing. */
  function currencyName(code) {
    try {
      if (!names) names = new Intl.DisplayNames(['en'], { type: 'currency' });
      const spoken = names.of(code);
      if (spoken && spoken !== code) return spoken;
    } catch (e) { /* the table below */ }
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

  /* The quote row stores the customer rate at 12 places. Showing it
     with the trailing zeros stripped is the rate that was multiplied.
     A 4-decimal round is a different number. */
  function formatServerRate(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return '';
    return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  function moneyInput(raw) {
    const text = String(raw || '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{0,2})?$/.test(text)) return '';
    const n = Number(text);
    if (!(n > 0)) return '';
    return n.toFixed(2);
  }

  function feeInput(settings) {
    const feeRaw = settings && settings.defaultFee != null && settings.defaultFee !== '' ? +settings.defaultFee : 0;
    const fee = isFinite(feeRaw) && feeRaw > 0 ? feeRaw : 0;
    return fee.toFixed(2);
  }

  /* POST /api/quotes is the amount the ledger posts. This screen does
     not multiply a rate of its own. The endpoint requires a customer,
     so the request uses one already on the desk; the follow-up, once
     os-src/quote-terms.js lands, is to preview with that module and
     create the quote for the customer the cashier actually picks. */
  async function deskCustomerId() {
    if (quoteCustomerId) return quoteCustomerId;
    const B = window.CDOS && window.CDOS.Backend;
    if (!B) return '';
    const body = await B.request('/api/ledger/customers');
    const id = body && body.customers && body.customers[0] && body.customers[0].customerId;
    if (id) quoteCustomerId = id;
    return id || '';
  }

  function cancelQuote(id) {
    const B = window.CDOS && window.CDOS.Backend;
    if (!B || !id) return;
    B.request('/api/quotes/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' }).catch(() => {});
  }

  async function requestServerQuote(spec) {
    const B = window.CDOS && window.CDOS.Backend;
    if (!B) return null;
    const customerId = await deskCustomerId();
    if (!customerId) return null;
    return B.createQuote({
      customerId,
      from: spec.from,
      to: spec.to,
      inputAmount: spec.inputAmount,
      feeCad: spec.feeCad,
      direction: spec.direction,
    });
  }

  function PhoneRates({ settings, role, locked, rateVersion, onNewDeal, onQuoteDeal, onEditPricing }) {
    const Phone = window.CDOS.Phone;
    const [phase, setPhase] = useState('loading');
    const [feed, setFeed] = useState(null);
    const [boardAt, setBoardAt] = useState(null);
    const [query, setQuery] = useState('');
    const [quote, setQuote] = useState(null);
    const [side, setSide] = useState('sells');
    const [amount, setAmount] = useState('');
    const [picking, setPicking] = useState(false);
    const [serverQuote, setServerQuote] = useState(null);
    const [quoteNote, setQuoteNote] = useState('');
    const [homeTick, setHomeTick] = useState(0);
    const amountRef = useRef(null);
    const heldQuote = useRef('');
    const canEdit = role === 'Owner' || role === 'Manager';

    const load = () => {
      setPhase('loading');
      fetch('/api/rates/market', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => {
          if (!r.ok) throw new Error('GET /api/rates/market answered ' + r.status);
          return r.json();
        })
        .then(data => {
          setFeed(data || null);
          return fetch('/api/rates', { credentials: 'same-origin', cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
        })
        .then(board => {
          const at = board && board.board && board.board.publishedAt;
          setBoardAt(at || null);
          setPhase('ready');
        })
        .catch(err => {
          console.error('Rates did not load', err);
          setFeed(null);
          setBoardAt(null);
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

    const feeCad = feeInput(settings);
    useEffect(() => {
      if (!quote) return undefined;
      const inputAmount = moneyInput(amount);
      const home = homeCode();
      const from = side === 'buys' ? home : quote.code;
      const to = side === 'buys' ? quote.code : home;
      const direction = from === home ? 'customer_buy_foreign' : 'customer_sell_foreign';
      if (!inputAmount || from === to) {
        setServerQuote(null);
        setQuoteNote('');
        return undefined;
      }
      let dropped = false;
      const timer = setTimeout(() => {
        requestServerQuote({ from, to, inputAmount, feeCad, direction })
          .then(result => {
            if (dropped) {
              if (result && result.quoteId) cancelQuote(result.quoteId);
              return;
            }
            if (!result || !result.outputAmount || !result.quoteId) {
              setServerQuote(null);
              setQuoteNote('The server did not quote this amount.');
              return;
            }
            if (heldQuote.current && heldQuote.current !== result.quoteId) cancelQuote(heldQuote.current);
            heldQuote.current = result.quoteId;
            setServerQuote(result);
            setQuoteNote('');
          })
          .catch(err => {
            if (dropped) return;
            console.error('The server did not quote this amount', err);
            setServerQuote(null);
            setQuoteNote('The server did not quote this amount.');
          });
      }, 200);
      return () => {
        dropped = true;
        clearTimeout(timer);
        if (heldQuote.current) {
          cancelQuote(heldQuote.current);
          heldQuote.current = '';
        }
        setServerQuote(null);
      };
    }, [quote && quote.code, side, amount, feeCad, homeTick]);

    const rows = useMemo(() => (phase === 'ready' ? buildRows(settings) : []), [phase, settings, rateVersion, feed, homeTick]);
    const q = query.trim().toLowerCase();
    const shown = rows.filter(r => !q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    const status = phase === 'loading' ? { tone: 'fresh', text: '' } : statusOf(feed, boardAt, locked);
    const home = homeCode();
    const canStart = !!(serverQuote && serverQuote.outputAmount && serverQuote.quoteId);

    const openQuote = (row) => { setSide('sells'); setAmount(''); setPicking(false); setServerQuote(null); setQuoteNote(''); setQuote(row); };
    const startDeal = () => {
      if (!canStart || !onQuoteDeal) return;
      /* Leave this quote active. Closing the sheet would cancel it,
         and the deal posts this one. */
      heldQuote.current = '';
      onQuoteDeal({
        side: side === 'buys' ? 'customer-buys' : 'customer-sells',
        currency: quote.code,
        amount,
        from: serverQuote.from,
        to: serverQuote.to,
        outputAmount: serverQuote.outputAmount,
        customerRate: serverQuote.customerRate,
        quoteId: serverQuote.quoteId,
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
        {status.text ? <p className={'phone-rates-status is-' + status.tone} data-phone-rates-status={status.tone}><i aria-hidden="true" />{status.text}</p> : null}
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
        {quote && ReactDOM.createPortal(
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
                <b aria-live="polite" data-server-quote={serverQuote ? serverQuote.quoteId : ''} data-server-output={serverQuote ? serverQuote.outputAmount : ''}>{serverQuote ? amountLine(serverQuote.outputAmount, serverQuote.to) : '—'}</b>
              </div>
              <div className="phone-quote-kv">
                <div><span>{'Our rate (we ' + (side === 'buys' ? 'sell' : 'buy') + ')'}</span><b className={side === 'buys' ? 'is-sell' : 'is-buy'} data-server-rate={serverQuote ? formatServerRate(serverQuote.customerRate) : ''}>{serverQuote ? formatServerRate(serverQuote.customerRate) + ' ' + serverQuote.to : '—'}</b></div>
                <div><span>Fee</span><b>{amountLine(serverQuote ? serverQuote.feeCad : feeCad, home)}</b></div>
              </div>
              <p className="phone-quote-note">{quoteNote || 'The fee is set in Pricing. Customer gets is the server quote, and posting uses that amount.'}</p>
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
