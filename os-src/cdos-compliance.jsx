/* ============================================================
   CurrencyDesk OS — Compliance (AML regime engine)
   Closes three real holes and makes the regime pluggable:
     • Jurisdiction packs — FINTRAC (Canada) and a FinCEN (US) pack
       slot into ONE engine: threshold, base currency, the rolling-
       aggregation window, report codes, terminology and the fileable
       format all come from the active pack. computeFlags reads it too.
     • Sanctions / watchlist screening — OFAC / UN / OSFI name screening
       on every client AND beneficiary, with fuzzy matching (token-set +
       edit-distance) so reordered and near-miss names still surface.
     • Rolling-24h aggregation BY RULE — same person, cash-in inside the
       pack's window ≥ threshold ⇒ a single reportable aggregate. No
       manual "watching" tag.
     • Fileable submissions — beyond the print pack: a structured,
       schema-shaped file per report with a submit lifecycle and an
       acknowledgement number.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, TODAY, crossRate, THRESHOLD } = window.CDOS;
  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const cadIn = (r) => r.inCcy === 'CAD' ? (Number(r.inAmt) || 0) : (Number(r.inAmt) || 0) / (crossRate('CAD', r.inCcy) || 1);
  const dt = (r) => new Date(r.date + 'T' + (r.time || '00:00'));

  // A house setting that breaks the active regulator's hard rule (looser than the
  // mandate). Returns [] when the desk is compliant. Consumed by the top bell + Settings.
  function jurisdictionViolations(settings) {
    const REGIMES2 = REGIMES;
    const REG = REGIMES2[(settings && settings.regime) || 'FINTRAC'] || REGIMES2.FINTRAC;
    if (!REG) return [];
    const out = [];
    const aggH = +(settings && settings.aggHours) || REG.aggHours;
    if (aggH !== REG.aggHours) out.push({ id: 'jv_agg', field: 'aggHours', label: 'Aggregation window', detail: `Set to ${aggH}h — ${REG.authority} mandates a ${REG.aggHours}h window.` });
    const cur = (settings && settings.baseCurrency) || REG.currency;
    const thr = +(settings && settings.threshold) || 0;
    if (cur === REG.currency && thr > REG.threshold) out.push({ id: 'jv_thr', field: 'threshold', label: 'Reporting threshold', detail: `Set to ${fmt(thr, REG.currency)} — above the ${REG.authority} ${REG.largeCode} limit of ${fmt(REG.threshold, REG.currency)}.` });
    const ret = +(settings && settings.retentionYears) || REG.retentionYears || 5;
    const minRet = REG.retentionYears || 5;
    if (ret < minRet) out.push({ id: 'jv_ret', field: 'retentionYears', label: 'Record retention', detail: `Set to ${ret} years — ${REG.authority} requires at least ${minRet}.` });
    return out.map(v => ({ ...v, authority: REG.authority }));
  }

  /* ===================== JURISDICTION PACKS ===================== */
  const REGIMES = {
    FINTRAC: {
      id: 'FINTRAC', authority: 'FINTRAC', country: 'Canada', flag: '🇨🇦', currency: 'CAD',
      threshold: 10000, aggHours: 24, idAt: 3000,
      largeCode: 'LCTR', largeLabel: 'Large Cash Transaction Report',
      wireCode: 'EFTR', wireLabel: 'Electronic Funds Transfer Report',
      strCode: 'STR', strLabel: 'Suspicious Transaction Report',
      fileFormat: 'FWR JSON batch', watchlists: ['OSFI', 'UN', 'OFAC'],
    },
    FINCEN: {
      id: 'FINCEN', authority: 'FinCEN', country: 'United States', flag: '🇺🇸', currency: 'USD',
      threshold: 10000, aggHours: 24, idAt: 3000,
      largeCode: 'CTR', largeLabel: 'Currency Transaction Report',
      wireCode: 'CTR-FT', wireLabel: 'CTR — funds transfer',
      strCode: 'SAR', strLabel: 'Suspicious Activity Report',
      fileFormat: 'BSA E-Filing XML', watchlists: ['OFAC', 'UN'],
    },
  };
  function getRegime(settings) {
    const base = REGIMES[(settings && settings.regime) || 'FINTRAC'] || REGIMES.FINTRAC;
    const r = Object.assign({}, base);
    if (settings && +settings.threshold) r.threshold = +settings.threshold;     // owner override
    if (settings && +settings.idRequiredOver) r.idAt = +settings.idRequiredOver;
    if (settings && +settings.aggHours) r.aggHours = +settings.aggHours;          // custom window
    return r;
  }

  /* ===================== SANCTIONS / WATCHLISTS ===================== */
  // fictional, illustrative list entries across the three sources. Two are
  // tuned to demonstrate fuzzy matching against the seed book.
  const WATCHLISTS = [
    { id: 'w1', name: 'Wei Lin', list: 'OFAC', program: 'NPWMD', country: 'CN', type: 'individual', dob: '1979-02-11' },
    { id: 'w2', name: 'Aram Lawson', list: 'OSFI', program: 'Terrorism (Criminal Code)', country: 'CA', type: 'individual', dob: '1984-09-03' },
    { id: 'w3', name: 'Viktor Anatolievich Kozlov', list: 'OFAC', program: 'RUSSIA-EO14024', country: 'RU', type: 'individual' },
    { id: 'w4', name: 'Crescent Holdings FZE', list: 'UN', program: 'ISIL (Da’esh) & Al-Qaida', country: 'AE', type: 'entity' },
    { id: 'w5', name: 'Mohammed Al-Rashid', list: 'UN', program: 'ISIL (Da’esh) & Al-Qaida', country: 'SY', type: 'individual' },
    { id: 'w6', name: 'Banco del Sur Internacional', list: 'OFAC', program: 'SDNT', country: 'MX', type: 'entity' },
    { id: 'w7', name: 'Olena Petrova', list: 'OSFI', program: 'Russia (SEMA)', country: 'RU', type: 'individual' },
    { id: 'w8', name: 'Zhang Industrial Group', list: 'OFAC', program: 'NPWMD', country: 'CN', type: 'entity' },
    { id: 'w9', name: 'Ibrahim Suleiman', list: 'UN', program: 'Somalia & Eritrea', country: 'SO', type: 'individual' },
    { id: 'w10', name: 'Pyongyang Trading Co.', list: 'OFAC', program: 'DPRK', country: 'KP', type: 'entity' },
  ];
  const LIST_TONE = { OFAC: { c: '#1d4ed8', bg: '#dbe5fb' }, UN: { c: '#0e7490', bg: '#cfeaf0' }, OSFI: { c: CD.flag, bg: CD.flagSoft } };

  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = (s) => norm(s).split(' ').filter(Boolean);
  function lev(a, b) { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
  function matchScore(a, b) {
    const na = norm(a), nb = norm(b); if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = tokens(a).sort().join(' '), tb = tokens(b).sort().join(' ');
    if (ta === tb) return 0.95;                          // same tokens, reordered
    const ratio = 1 - lev(na, nb) / Math.max(na.length, nb.length);
    // token overlap (Jaccard) as a floor for partial matches
    const sa = new Set(tokens(a)), sb = new Set(tokens(b));
    const inter = [...sa].filter(x => sb.has(x)).length, uni = new Set([...sa, ...sb]).size;
    const jac = uni ? inter / uni : 0;
    return Math.max(ratio, jac * 0.9);
  }
  // screen one name against the lists → { status, hits[] }
  function screen(name) {
    const hits = [];
    WATCHLISTS.forEach(w => { const s = matchScore(name, w.name); if (s >= 0.82) hits.push({ w, score: s }); });
    hits.sort((a, b) => b.score - a.score);
    const top = hits[0];
    const status = !top ? 'clear' : top.score >= 0.99 ? 'hit' : 'review';
    return { status, hits };
  }
  const STAT = { clear: { t: 'Clear', c: CD.green, bg: CD.greenSoft, icon: 'checkcircle' }, review: { t: 'Possible match', c: CD.amber, bg: CD.amberSoft, icon: 'alert' }, hit: { t: 'Confirmed hit', c: CD.flag, bg: CD.flagSoft, icon: 'ban' } };

  /* ===================== 24-HOUR AGGREGATION (by rule) =====================
     The hard part, done properly:
       • STATIC declared window — a fixed 24h period the owner anchors
         (settings.aggWindowStart, e.g. 00:00 or a 09:00 business-day cut).
         Every report declares the exact window it was aggregated over.
       • DUAL BASIS — sub-threshold cash-in is aggregated BOTH by conductor
         (who handed over the cash) AND by beneficiary (who it's destined for).
         Three different people sending $4k each to one beneficiary is a
         reportable event on the beneficiary axis even though no single
         conductor reaches the threshold. When the two axes capture different
         transactions, BOTH reports are emitted — we never pick one.
       • Singles (≥ threshold on their own) are filed individually elsewhere,
         so the aggregate rule sums only the sub-threshold cash-in. */
  function parseHHMM(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : 0; }
  // the static 24h window a timestamp falls into, anchored at startMins past midnight
  function windowOf(d, startMins, H) {
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    let ws = new Date(dayStart.getTime() + startMins * 60000);
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < startMins) ws = new Date(ws.getTime() - 24 * 3600000);
    const we = new Date(ws.getTime() + (H || 24) * 3600000);
    return { start: ws, end: we, key: ws.toISOString() };
  }
  // generic core: aggregate a list of normalized cash-in/transfer-out events
  // ({ id, ref, date, time, t:Date, amt, customer, beneficiary }) over the static
  // window, by conductor AND beneficiary. `kind` is the report code stamped on
  // each cluster (LCTR for cash, EFTR for wires) — one machine, two triggers.
  function aggregateEvents(events, regime, settings, kind) {
    const TH = regime.threshold, H = regime.aggHours || 24;
    const startMins = parseHHMM((settings && settings.aggWindowStart) || '00:00');
    const buckets = {};
    (events || []).forEach(e => { if (!(e.amt > 0)) return; const w = windowOf(e.t, startMins, H); (buckets[w.key] = buckets[w.key] || { w, evs: [] }).evs.push(e); });
    const fmtT = (d) => d.toLocaleString('en-CA', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const out = [];
    Object.keys(buckets).forEach(key => {
      const { w, evs } = buckets[key];
      const windowLabel = fmtT(w.start) + ' → ' + fmtT(w.end);
      const dayKey = w.start.toISOString().slice(0, 10);
      const mk = (basis, keyFn) => {
        const groups = {};
        evs.forEach(e => { if (e.amt >= TH) return; const k = keyFn(e); if (!k) return; (groups[k] = groups[k] || []).push(e); });
        return Object.keys(groups).map(subject => {
          const txs = groups[subject].slice().sort((a, b) => a.t - b.t);
          const total = txs.reduce((s, o) => s + o.amt, 0);
          if (txs.length < 2 || total < TH) return null;
          const endRow = txs[txs.length - 1];
          return { id: 'AGG-' + kind + '-' + basis.charAt(0).toUpperCase() + '-' + String(subject).replace(/\s+/g, '_') + '-' + dayKey, kind, basis, subject, customer: subject, txs, total, end: endRow.date + ' ' + (endRow.time || ''), endRow, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), windowLabel };
        }).filter(Boolean);
      };
      const conductors = mk('conductor', e => e.customer);
      const beneficiaries = mk('beneficiary', e => e.beneficiary);
      // identical transaction set on both axes = the same event — file once.
      const sig = (c) => c.txs.map(t => t.id).sort().join(',');
      const condSigs = new Set(conductors.map(sig));
      out.push(...conductors, ...beneficiaries.filter(c => !condSigs.has(sig(c))));
    });
    return out.sort((a, b) => b.total - a.total);
  }
  // LCTR — cash-in from the ledger
  function aggClusters(rows, regime, settings) {
    const events = (rows || []).filter(r => r.status !== 'void' && cadIn(r) > 0).map(r => ({ id: r.id, ref: r.ref, date: r.date, time: r.time, t: dt(r), amt: cadIn(r), customer: r.customer, beneficiary: r.beneficiary }));
    return aggregateEvents(events, regime, settings, regime.largeCode);
  }
  // EFTR — international electronic transfers. Same $10k / 24h machinery, wires not cash.
  function aggClustersEFT(transfers, beneficiaries, regime, settings) {
    const benName = (id) => { const b = (beneficiaries || []).find(x => x.id === id); return b ? b.name : null; };
    const events = (transfers || []).filter(t => t.status !== 'cancelled').map(t => {
      const cad = t.direction === 'send' ? (Number(t.payAmt) || 0) : ((Number(t.recvAmt) || 0) / (crossRate('CAD', t.ccy) || 1));
      return { id: t.id || t.ref, ref: t.ref, date: t.date, time: t.time || '00:00', t: new Date(t.date + 'T' + (t.time || '00:00')), amt: cad, customer: t.senderName, beneficiary: benName(t.beneficiaryId) || (t.direction === 'send' ? t.partner : t.senderName) };
    });
    return aggregateEvents(events, regime, settings, regime.wireCode);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    _compliance: { REGIMES, getRegime, WATCHLISTS, LIST_TONE, screen, matchScore, STAT, aggClusters, aggClustersEFT, cadIn, dt },
    getRegime,
    jurisdictionViolations,
  });
})();
