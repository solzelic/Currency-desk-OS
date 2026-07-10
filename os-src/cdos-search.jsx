/* ============================================================
   CurrencyDesk OS — Ledger search engine
   Turns a free-form query into a structured matcher over the book.
   Supports natural language the way a teller or owner would type:

     payout php                 → pay-out side is Philippine pesos
     received usd               → pay-in side is US dollars
     philippine dollars         → either side is PHP (denomination word ignored)
     remittance send aran       → Remittance-Send for customer Brooke
     fee > 50                   → fee over $50
     payout > 5000              → pay-out amount over 5000
     amount 1000..5000          → either amount between 1k and 5k
     reportable unfiled         → LCTR-reportable and not yet filed
     date 2026-06-18            → on that day   (also today / yesterday)
     customer:"aran voss"       → exact-ish field qualifier
     teller singh · void · cheque · structuring · tagged …

   Every bare term AND-combines. Returns { match, chips, wantsVoid, active }.
   ============================================================ */
(function () {
  const TODAY = (window.CDOS && window.CDOS.TODAY) || '2026-06-18';

  // country / name / code → currency code(s)
  const CCY_ALIASES = {
    CAD: ['cad', 'canadian', 'canada', 'loonie', 'loonies'],
    USD: ['usd', 'us', 'american', 'greenback', 'greenbacks'],
    EUR: ['eur', 'euro', 'euros', 'europe', 'european'],
    GBP: ['gbp', 'sterling', 'british', 'uk', 'quid', 'pound', 'pounds'],
    INR: ['inr', 'rupee', 'rupees', 'india', 'indian'],
    PHP: ['php', 'philippine', 'philippines', 'filipino', 'filipina', 'pinoy'],
    CNY: ['cny', 'yuan', 'renminbi', 'rmb', 'china', 'chinese'],
    MXN: ['mxn', 'mexican', 'mexico'],
    AED: ['aed', 'dirham', 'dirhams', 'emirati', 'uae', 'emirates'],
  };
  // ambiguous denomination words → candidate codes (matches EITHER)
  const SHARED = { peso: ['PHP', 'MXN'], pesos: ['PHP', 'MXN'], dollar: ['USD', 'CAD'], dollars: ['USD', 'CAD'] };
  // generic denomination words consumed after a country word (philippine [dollars])
  const DENOM = ['dollar', 'dollars', 'peso', 'pesos', 'rupee', 'rupees', 'yuan', 'dirham', 'dirhams', 'pound', 'pounds', 'euro', 'euros', 'franc', 'francs'];

  const SIDE_IN = ['received', 'receiving', 'incoming', 'deposit', 'deposits', 'takein'];
  const SIDE_OUT = ['paid', 'outgoing', 'disbursed', 'disburse', 'payingout'];
  // bare words that act as a field key when followed by a value (no colon needed)
  const FIELD_WORDS = new Set(['customer', 'cust', 'name', 'client', 'teller', 'staff', 'by', 'clerk', 'agent', 'ref', 'reference', 'note', 'notes', 'memo', 'type', 'ccy', 'currency', 'curr', 'in', 'out', 'payin', 'payout', 'inccy', 'outccy', 'amount', 'amt', 'value', 'fee', 'fees', 'rate', 'date', 'on', 'day', 'after', 'since', 'before', 'until', 'status', 'flag']);
  const OP_ONLY = /^(>=|<=|>|<|=)$/;
  // pull the value that follows a bare field word (handles spaced operators)
  function consumeValue(tokens, i) {
    const n1 = tokens[i + 1];
    if (!n1 || n1.k !== undefined) return null;
    if (OP_ONLY.test(n1.t)) { const n2 = tokens[i + 2]; if (n2 && n2.t !== undefined && /^\d/.test(n2.t)) return { value: n1.t + n2.t, consumed: 2 }; return { value: n1.t, consumed: 1 }; }
    // swallow a trailing denomination word when the value is a currency (payout philippine dollars)
    if (ccyCodes(n1.t)) { const n2 = tokens[i + 2]; if (n2 && n2.t !== undefined && DENOM.includes(String(n2.t).toLowerCase())) return { value: n1.t, consumed: 2 }; }
    return { value: n1.t, consumed: 1 };
  }

  function ccyCodes(token) {
    const t = String(token).toLowerCase();
    if (/^[a-z]{3}$/.test(t) && CCY_ALIASES[t.toUpperCase()]) return [t.toUpperCase()];
    const set = new Set();
    for (const code in CCY_ALIASES) if (CCY_ALIASES[code].includes(t)) set.add(code);
    if (SHARED[t]) SHARED[t].forEach(c => set.add(c));
    return set.size ? [...set] : null;
  }
  const ccyTest = (codes, side) => { const s = new Set(codes); return (r) => side === 'in' ? s.has(r.inCcy) : side === 'out' ? s.has(r.outCcy) : (s.has(r.inCcy) || s.has(r.outCcy)); };

  const TYPE_MAP = [
    [['exchange', 'fx', 'convert', 'conversion', 'exchanges'], 'Currency Exchange'],
    [['send', 'sending', 'outbound'], 'Remittance — Send'],
    [['receive', 'receiving', 'inbound', 'pickup'], 'Remittance — Receive'],
    [['remittance', 'remit', 'remittances', 'transfer', 'wire'], /^Remittance/],
    [['cheque', 'check', 'cheques', 'checks', 'cashing'], 'Cheque Cashing'],
    [['moneyorder', 'money', 'order', 'orders'], 'Money Order'],
    [['bill', 'bills', 'utility'], 'Bill Payment'],
  ];
  function typeMatch(w) {
    for (const [aliases, target] of TYPE_MAP) {
      if (aliases.includes(w)) {
        const test = target instanceof RegExp ? (r) => target.test(r.type) : (r) => r.type === target;
        const label = target instanceof RegExp ? 'Remittance' : target;
        return { test, label: 'Type · ' + label };
      }
    }
    return null;
  }

  // status & compliance words → test(record, flag)
  function statusFlag(w) {
    const F = {
      void: [(r) => r.status === 'void', 'Voided', true],
      voided: [(r) => r.status === 'void', 'Voided', true],
      cancelled: [(r) => r.status === 'void', 'Voided', true],
      canceled: [(r) => r.status === 'void', 'Voided', true],
      reversed: [(r) => r.status === 'void', 'Voided', true],
      posted: [(r) => r.status !== 'void', 'Posted'],
      active: [(r) => r.status !== 'void', 'Posted'],
      reportable: [(r, f) => !!(f && f.single), 'Reportable ≥ $10k'],
      lctr: [(r, f) => !!(f && f.single), 'Reportable ≥ $10k'],
      large: [(r, f) => !!(f && f.single), 'Reportable ≥ $10k'],
      filed: [(r) => !!r.filed, 'Filed'],
      unfiled: [(r, f) => !!(f && f.single) && !r.filed, 'Unfiled report'],
      structuring: [(r, f) => !!(f && f.str), 'Structuring watch'],
      smurfing: [(r, f) => !!(f && f.str), 'Structuring watch'],
      kyc: [(r, f) => !!(f && f.kyc && f.kyc !== 'ok'), 'KYC / ID issue'],
      unverified: [(r, f) => !!(f && f.kyc && f.kyc !== 'ok'), 'KYC / ID issue'],
      noid: [(r, f) => !!(f && f.kyc && f.kyc !== 'ok'), 'KYC / ID issue'],
      tagged: [(r) => !!r.tagged, 'Tagged'],
      flagged: [(r, f) => !!(f && (f.single || f.str || (f.kyc && f.kyc !== 'ok'))), 'Flagged'],
      compliance: [(r, f) => !!(f && (f.single || f.str || (f.kyc && f.kyc !== 'ok'))), 'Flagged'],
      clean: [(r, f) => !(f && (f.single || f.str || (f.kyc && f.kyc !== 'ok'))) && r.status !== 'void', 'Clean'],
      all: [() => true, 'All records', true],
      everything: [() => true, 'All records', true],
    };
    const e = F[w];
    if (!e) return null;
    return { test: e[0], label: e[1], wantsVoid: !!e[2] };
  }

  // numeric predicate: >50  <=100  1000..5000  =0  250
  function numPred(v) {
    v = String(v).replace(/[$,\s]/g, '');
    let m;
    if ((m = v.match(/^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/))) { const lo = +m[1], hi = +m[2]; return { fn: n => n >= lo && n <= hi, label: lo + '–' + hi }; }
    if ((m = v.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/))) { const op = m[1] || '=', x = +m[2]; const fn = op === '>' ? n => n > x : op === '<' ? n => n < x : op === '>=' ? n => n >= x : op === '<=' ? n => n <= x : n => Math.abs(n - x) < 0.005; return { fn, label: (op === '=' ? '' : op + ' ') + x }; }
    return null;
  }
  // date predicate: 2026-06-18  2026-06  >2026-06-01  a..b  today  yesterday
  function datePred(v) {
    v = String(v).toLowerCase().trim();
    const shift = (d, n) => { const t = new Date(d); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
    if (v === 'today') v = TODAY; else if (v === 'yesterday') v = shift(TODAY, -1);
    let m;
    if ((m = v.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/))) return { fn: d => d >= m[1] && d <= m[2], label: m[1] + '→' + m[2] };
    if ((m = v.match(/^(>=|<=|>|<)(\d{4}-\d{2}(?:-\d{2})?)$/))) { const op = m[1], x = m[2]; const fn = op === '>' ? d => d > x : op === '<' ? d => d < x : op === '>=' ? d => d >= x : d => d <= x; return { fn, label: op + ' ' + x }; }
    if (/^\d{4}(-\d{2}){0,2}$/.test(v)) return { fn: d => d.startsWith(v), label: v };
    return null;
  }

  const textTest = (s) => { const t = String(s).toLowerCase(); return (r) => (`${r.ref} ${r.customer} ${r.teller} ${r.notes || ''} ${r.type} ${r.inCcy} ${r.outCcy} ${r.date} ${r.time} ${(r.thread || []).map(n => n.text).join(' ')}`).toLowerCase().includes(t); };
  const fieldContains = (get, s) => { const t = String(s).toLowerCase(); return (r) => String(get(r) || '').toLowerCase().includes(t); };

  // field:value qualifiers
  function fieldClause(k, v) {
    k = k.toLowerCase();
    const codes = ccyCodes(v);
    const np = numPred(v);
    const lower = String(v).toLowerCase();
    switch (k) {
      case 'customer': case 'cust': case 'name': case 'client': return { test: fieldContains(r => r.customer, v), label: 'Customer · ' + v };
      case 'teller': case 'staff': case 'by': case 'clerk': case 'agent': return { test: fieldContains(r => r.teller, v), label: 'Teller · ' + v };
      case 'ref': case 'reference': return { test: fieldContains(r => r.ref, v), label: 'Ref · ' + v };
      case 'note': case 'notes': case 'memo': return { test: (r) => (`${r.notes || ''} ${(r.thread || []).map(n => n.text).join(' ')}`).toLowerCase().includes(lower), label: 'Note · ' + v };
      case 'type': { const tm = typeMatch(lower); return tm ? { test: tm.test, label: tm.label } : { test: fieldContains(r => r.type, v), label: 'Type · ' + v }; }
      case 'ccy': case 'currency': case 'curr': return codes ? { test: ccyTest(codes, 'any'), label: codes.join('/') } : { test: textTest(v), label: v };
      case 'in': case 'payin': case 'inccy': return codes ? { test: ccyTest(codes, 'in'), label: 'Pay-in ' + codes.join('/') } : (np ? { test: r => np.fn(+r.inAmt || 0), label: 'Pay-in ' + np.label } : null);
      case 'out': case 'payout': case 'outccy': return codes ? { test: ccyTest(codes, 'out'), label: 'Pay-out ' + codes.join('/') } : (np ? { test: r => np.fn(+r.outAmt || 0), label: 'Pay-out ' + np.label } : null);
      case 'amount': case 'amt': case 'value': return np ? { test: r => np.fn(+r.inAmt || 0) || np.fn(+r.outAmt || 0), label: 'Amount ' + np.label } : null;
      case 'fee': case 'fees': return np ? { test: r => np.fn(+r.fee || 0), label: 'Fee ' + np.label } : null;
      case 'rate': return np ? { test: r => np.fn(+r.rate || 0), label: 'Rate ' + np.label } : null;
      case 'date': case 'on': case 'day': { const dp = datePred(v); return dp ? { test: r => dp.fn(r.date), label: 'Date ' + dp.label } : null; }
      case 'after': case 'since': { const dp = datePred('>' + v); return dp ? { test: r => dp.fn(r.date), label: 'After ' + v } : null; }
      case 'before': case 'until': { const dp = datePred('<' + v); return dp ? { test: r => dp.fn(r.date), label: 'Before ' + v } : null; }
      case 'status': case 'flag': { const sf = statusFlag(lower); return sf ? { test: sf.test, label: sf.label, wantsVoid: sf.wantsVoid } : null; }
      default: return null;
    }
  }

  function tokenize(q) {
    const out = [];
    const re = /([a-z_]+):"([^"]*)"|([a-z_]+):(\S+)|"([^"]*)"|(\S+)/gi;
    let m;
    while ((m = re.exec(q))) {
      if (m[1] !== undefined) out.push({ k: m[1], v: m[2] });
      else if (m[3] !== undefined) out.push({ k: m[3], v: m[4] });
      else if (m[5] !== undefined) out.push({ t: m[5] });
      else out.push({ t: m[6] });
    }
    return out;
  }

  function makeSearch(query) {
    const q = (query || '').trim();
    if (!q) return { match: () => true, chips: [], wantsVoid: false, active: false };
    const tokens = tokenize(q);
    const clauses = [], chips = [];
    let wantsVoid = false;
    const push = (test, label, wv) => { if (!test) return; clauses.push(test); if (label) chips.push(label); if (wv) wantsVoid = true; };

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.k !== undefined) {
        const fc = fieldClause(tk.k, tk.v);
        if (fc) push(fc.test, fc.label, fc.wantsVoid);
        else push(textTest(tk.k + ':' + tk.v), tk.k + ':' + tk.v);
        continue;
      }
      const w = String(tk.t).toLowerCase();
      // bare field word followed by a value (customer aran · fee > 50 · date today)
      if (FIELD_WORDS.has(w)) {
        const cv = consumeValue(tokens, i);
        if (cv) {
          const fc = fieldClause(w, cv.value);
          if (fc) { push(fc.test, fc.label, fc.wantsVoid); i += cv.consumed; continue; }
        }
        // couldn't resolve — fall through and treat as plain text
      }
      // side word immediately followed by a currency → side-scoped currency
      if (SIDE_IN.includes(w) || SIDE_OUT.includes(w)) {
        const nxt = tokens[i + 1];
        const codes = nxt && nxt.t ? ccyCodes(nxt.t) : null;
        if (codes) {
          const side = SIDE_IN.includes(w) ? 'in' : 'out';
          push(ccyTest(codes, side), (side === 'in' ? 'Pay-in ' : 'Pay-out ') + codes.join('/'));
          i++;
          if (tokens[i + 1] && tokens[i + 1].t && DENOM.includes(String(tokens[i + 1].t).toLowerCase())) i++;
          continue;
        }
        // side word + numeric predicate (e.g. "payout >5000")
        if (nxt && nxt.t && /^(>=|<=|>|<|=)?\d/.test(nxt.t)) {
          const np = numPred(nxt.t);
          if (np) { const side = SIDE_IN.includes(w) ? 'in' : 'out'; push(r => np.fn(+(side === 'in' ? r.inAmt : r.outAmt) || 0), (side === 'in' ? 'Pay-in ' : 'Pay-out ') + np.label); i++; continue; }
        }
      }
      // currency word (consume trailing denomination)
      const codes = ccyCodes(w);
      if (codes) {
        if (tokens[i + 1] && tokens[i + 1].t && DENOM.includes(String(tokens[i + 1].t).toLowerCase())) i++;
        push(ccyTest(codes, 'any'), codes.join('/'));
        continue;
      }
      // transaction type
      const ty = typeMatch(w);
      if (ty) { push(ty.test, ty.label); continue; }
      // status / compliance
      const sf = statusFlag(w);
      if (sf) { push(sf.test, sf.label, sf.wantsVoid); continue; }
      // bare numeric predicate → amount on either side
      if (/^(>=|<=|>|<)\d/.test(w) || /^\d+(\.\d+)?\.\.\d/.test(w)) {
        const np = numPred(w);
        if (np) { push(r => np.fn(+r.inAmt || 0) || np.fn(+r.outAmt || 0), 'Amount ' + np.label); continue; }
      }
      // plain number → amount OR text (so ref numbers still match)
      if (/^\d+(\.\d+)?$/.test(w)) {
        const x = +w;
        push(r => Math.abs((+r.inAmt || 0) - x) < 0.005 || Math.abs((+r.outAmt || 0) - x) < 0.005 || textTest(w)(r), '“' + tk.t + '”');
        continue;
      }
      // free text
      push(textTest(tk.t), '“' + tk.t + '”');
    }

    const match = (r, f) => clauses.every(c => c(r, f));
    return { match, chips, wantsVoid, active: true };
  }

  // a few example searches shown in the help popover
  const SEARCH_EXAMPLES = [
    ['payout php', 'paid out in Philippine pesos'],
    ['received usd', 'paid in with US dollars'],
    ['remittance send', 'outbound remittances'],
    ['fee > 50', 'fee over $50'],
    ['amount 1000..10000', 'amount between 1k–10k'],
    ['reportable unfiled', 'LCTR-reportable, not yet filed'],
    ['structuring', 'structuring watch list'],
    ['customer aran', 'a specific customer'],
    ['cheque', 'cheque cashing only'],
    ['date 2026-06-18', 'on a specific day'],
    ['voided', 'voided records'],
  ];

  window.CDOS = Object.assign(window.CDOS || {}, { makeSearch, SEARCH_EXAMPLES });
})();
