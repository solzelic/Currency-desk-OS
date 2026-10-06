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
  const { CD, Ic, fmt, num, TODAY, crossRate, counterCashIn } = window.CDOS;
  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const home = (amount, ccy) => ccy === 'CAD' ? (Number(amount) || 0) : (Number(amount) || 0) / (crossRate('CAD', ccy) || 1);
  /** What the deal was FOR, in home money. A size, not a cash movement. */
  const cadIn = (r) => home(r.inAmt, r.inCcy);
  /* What the customer actually put on the counter, in home money — zero
     where they put nothing there. The large-cash report is a report
     about cash RECEIVED, and `cadIn` is not that: on a remittance
     receive it is the foreign sum a sender abroad dispatched, and on a
     cheque cashing it is the face of a cheque. See COUNTER_CASH in
     cdos-base.jsx, which mirrors the server's own `cash_in_home`. */
  const cashIn = (r) => { const c = counterCashIn(r); return c ? home(c.amount, c.ccy) : 0; };
  const dt = (r) => new Date(r.date + 'T' + (r.time || '00:00'));

  /* ============================================================
     WHERE THIS DESK STANDS AGAINST ITS MANDATE

     A desk may ask more of itself than its regulator does. It may never
     ask less. Those two facts are not symmetrical and this file used to
     treat them as though they were:

       tighter than the mandate   a deliberate decision, usually because a
                                  bank or an auditor wanted it. Not a
                                  fault. Stated plainly, no red, no bell.
       looser than the mandate    the desk failing to report things it is
                                  legally obliged to report. Unmissable.
       following the pack         the normal case. Name the number and
                                  where it came from, and say nothing else.

     And it judged against REGIMES below — a two-entry table holding
     FINTRAC and FinCEN — while the ledger ships six packs. A desk in
     Dubai was measured against Canada's numbers, and the threshold check
     only ran at all when `settings.baseCurrency` happened to equal the
     regime's currency, so it fell silent on every desk whose books are
     not kept in Canadian or American dollars. That is the failure mode
     that matters: the check whose job is to catch a non-compliant desk
     quietly not running.

     So the mandate now comes from the desk's REAL pack — the one the
     ledger resolved, in the pack's own currency, with the desk's own
     overrides already applied and each one already labelled. REGIMES
     stands in only where there is no server to ask: the standalone build,
     and the moment before the first answer lands.
     ============================================================ */

  /* One line's standing, in the shape the screens render. `standing` is
     the server's posture where there is one; `note` is the sentence a
     human reads, and it is deliberately different in tone for each. */
  function postureOf(line, opts) {
    if (!line) return null;
    const money = !!opts.money;
    const show = (v) => v == null ? '—' : money ? fmt(+v, opts.currency) : `${v}${opts.unit || ''}`;
    const standing = line.posture || 'unknown';
    const note =
      standing === 'stricter'
        ? (opts.stricter || `Stricter than ${opts.authority} requires (${show(line.packValue)}).`)
        : standing === 'looser'
          ? (opts.looser || `${show(line.effective)} — ${opts.authority} requires ${opts.direction === 'atMost' ? 'no more than' : 'at least'} ${show(line.packValue)}.`)
          : standing === 'matching'
            ? `The ${opts.authority} figure, set by hand.`
            : standing === 'following'
              ? (opts.following || `Following ${opts.authority} (${show(line.packValue)}).`)
              : (opts.unknown || `No ${opts.authority} figure is installed for this, so nothing can say where you stand.`);
    return {
      field: opts.field,
      label: opts.label,
      standing,
      authority: opts.authority,
      value: line.effective,
      mandate: line.packValue,
      deskChoice: line.deskChoice,
      currency: money ? opts.currency : null,
      note,
      /* what the old violation list said, kept word-for-word in shape so
         the bell and Settings keep working — see jurisdictionViolations */
      detail: note,
    };
  }

  /* Every line, judged. Reads the ledger's answer when there is one and
     falls back to the browser's regime table when there is not. */
  function loadedPack() {
    return (window.CDOS && window.CDOS.deskPack) ? window.CDOS.deskPack() : null;
  }
  function isBaselinePack(pack) {
    return !!(pack && (pack.baseline === true || pack.kind === 'baseline'));
  }
  /* A baseline desk, or one whose setup already said so and whose pack
     has not arrived yet. Either way Canada's names are not an answer. */
  function baselineDesk(settings) {
    const pack = loadedPack();
    if (isBaselinePack(pack)) return true;
    return !!(settings && settings.baselineRules && !pack);
  }
  /* The converted home amount, with the USD figure it came from. A missing
     rate has no home amount: identification is required on every deal.

     `effective` is the line this desk operates at. `packValue` is the
     baseline after the server converted it into home currency — the same
     number on a following or matching desk, and a different one when the
     owner chose a stricter or looser line. The US-dollar source belongs
     on that converted baseline. Putting it next to the owner's lower
     figure would say a £5,000 line is 10,000 USD. */
  function baselineMoneyCopy(key, line) {
    const pack = loadedPack();
    if (!isBaselinePack(pack)) return null;
    const homeAmount = line && line.effective != null && +line.effective > 0 ? +line.effective : null;
    if (homeAmount == null) {
      return {
        unknown: key === 'idThreshold'
          ? 'Identification is required on every deal.'
          : 'Purpose and source of funds are required on every deal.',
      };
    }
    const raw = key === 'idThreshold' ? pack.idThreshold : pack.reportThreshold;
    const usd = Number(String(raw == null ? '' : raw).replace(/,/g, ''));
    const src = String(pack.reportCurrency || 'USD').trim().toUpperCase() || 'USD';
    const desk = window.CDOS.deskThresholds ? window.CDOS.deskThresholds() : null;
    const home = (desk && desk.currency) || pack.homeCurrency;
    const yours = fmt(homeAmount, home);
    const packAmount = line && line.packValue != null && +line.packValue > 0 ? +line.packValue : null;
    const baseline = packAmount == null ? null : fmt(packAmount, home);
    const source = baseline && Number.isFinite(usd) && usd > 0 && src !== String(home || '').toUpperCase()
      ? `, which is ${usd.toLocaleString('en-CA', { maximumFractionDigits: 2 })} ${src} at today's market rate`
      : '';
    const baselineClause = baseline ? `${baseline}${source}` : yours;
    return {
      following: `Following the international baseline: ${baselineClause}.`,
      matching: `The international baseline figure, set by hand: ${baselineClause}.`,
      stricter: baseline
        ? `Stricter than the international baseline. Your line is ${yours}. The baseline is ${baselineClause}.`
        : `Stricter than the international baseline. Your line is ${yours}.`,
      /* The mandate here is packValue, already converted into home
         currency. The raw 10,000 USD must not stand in for it. */
      looser: baseline
        ? `${yours} — the international baseline requires no more than ${baseline}.`
        : `${yours} — the international baseline has no converted figure for this line.`,
    };
  }

  function jurisdictionPosture(settings) {
    if (window.CDOS && window.CDOS.rulesMissing && window.CDOS.rulesMissing(settings)) return [];
    const server = (window.CDOS && window.CDOS.deskThresholds) ? window.CDOS.deskThresholds() : null;
    const pack = loadedPack();
    /* No server answer yet. A loaded pack, and a baseline desk, wait.
       Inventing FINTRAC for them is how a Belgrade desk was told it
       files an LCTR. The two-country table is only for the standalone
       build, which has no ledger to ask. */
    if (!server && (pack || baselineDesk(settings))) return [];
    const REG = (settings && settings.regime && REGIMES[settings.regime]) || REGIMES.FINTRAC;
    /* No server answer yet. Build the same shape out of what the browser
       holds so the screens have one code path — and mark every line
       "following", because a desk we have not asked about is not a desk
       we may accuse of anything. */
    const local = () => {
      if (!REG) return null;
      const line = (effective, mandate) => ({
        effective, deskChoice: null, packValue: mandate,
        posture: effective == null || mandate == null ? 'unknown' : 'following',
      });
      const cur = (settings && settings.baseCurrency) || REG.currency;
      return { currency: cur, authority: REG.authority, lines: {
        reportThreshold: line(+((settings && settings.threshold)) || REG.threshold, REG.threshold),
        idThreshold: line(+((settings && settings.idRequiredOver)) || REG.idAt, REG.idAt),
        aggregationHours: line(+((settings && settings.aggHours)) || REG.aggHours, REG.aggHours),
        retentionYears: line(+((settings && settings.retentionYears)) || REG.retentionYears || 5, REG.retentionYears || 5),
      } };
    };
    const baseline = isBaselinePack(pack);
    const source = server
      ? {
          currency: server.currency,
          authority: baseline ? 'the international baseline' : (server.regulator || (pack && pack.regulator) || ''),
          lines: server,
        }
      : local();
    if (!source || !source.lines) return [];
    const L = source.lines;
    const common = { currency: source.currency, authority: source.authority };
    const reportCopy = baselineMoneyCopy('reportThreshold', L.reportThreshold);
    const idCopy = baselineMoneyCopy('idThreshold', L.idThreshold);
    return [
      postureOf(L.reportThreshold, { ...common, ...reportCopy, field: 'threshold', label: 'Reporting threshold', money: true, direction: 'atMost' }),
      postureOf(L.idThreshold, { ...common, ...idCopy, field: 'idRequiredOver', label: 'Identification threshold', money: true, direction: 'atMost' }),
      postureOf(L.aggregationHours, { ...common, field: 'aggHours', label: 'Aggregation window', unit: 'h', direction: 'atLeast' }),
      postureOf(L.retentionYears, { ...common, field: 'retentionYears', label: 'Record retention', unit: ' years', direction: 'atLeast' }),
    ].filter(Boolean);
  }

  /* The desk breaking its regulator's hard rule — looser than the
     mandate, and nothing else. A tighter line is NOT in here and must
     never be: it is a decision somebody made on purpose, and putting it
     in the notification bell would train an owner to ignore the bell.

     Returns [] when the desk is compliant. The shape is unchanged —
     { id, field, label, detail, authority } — because the top-bar bell in
     cdos-os.jsx consumes it and this file does not get to move that. */
  function jurisdictionViolations(settings) {
    return jurisdictionPosture(settings)
      .filter(p => p.standing === 'looser')
      .map(p => ({ id: 'jv_' + p.field, field: p.field, label: p.label, detail: p.detail, authority: p.authority }));
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
  /* The engine's view of the rules in force, which every screen reads.

     The browser's own pack is the SHAPE — report codes, watchlists,
     terminology — and the numbers on it are the pilot's two countries.
     Where the ledger has answered, its figures win: they are the desk's
     own choices resolved against its real pack, and they are what the
     posting path will actually enforce. A screen warning a teller at
     3,000 while the server refuses at 1,000 is worse than either number
     on its own, because it teaches the teller the warning is wrong.

     Below that, the owner's saved settings, which is all the standalone
     build has. */
  function lineAmount(line) {
    return (line && line.effective != null && +line.effective > 0) ? +line.effective : null;
  }
  /* The reports a baseline desk actually has. Plain names, not Canada's. */
  const BASELINE_REPORTS = [
    { code: 'CASH-RECORD', name: 'Large cash record' },
    { code: 'SUSPICIOUS', name: 'Suspicious transaction' },
    { code: 'SANCTIONS-STOP', name: 'Terrorist or sanctioned property' },
  ];
  function regimeFromPack(pack, settings) {
    const desk = (window.CDOS && window.CDOS.deskThresholds) ? window.CDOS.deskThresholds() : null;
    const reports = (window.CDOS && window.CDOS.deskReports) ? (window.CDOS.deskReports() || []) : [];
    const baseline = isBaselinePack(pack);
    const listed = reports.length ? reports : (baseline ? BASELINE_REPORTS : []);
    const byCode = (code) => listed.find(r => r && r.code === code) || null;
    const large = listed.find(r => r && (r.kind === 'large_cash' || r.code === (pack.reportName || 'CASH-RECORD'))) || byCode('CASH-RECORD');
    const suspicious = byCode('SUSPICIOUS') || listed.find(r => r && r.kind === 'suspicious');
    const sanctions = byCode('SANCTIONS-STOP');
    const wire = listed.find(r => r && (r.kind === 'wire' || r.kind === 'eft'));
    return {
      id: pack.packId || null,
      authority: baseline ? "Your country's financial intelligence unit" : (pack.regulator || ''),
      country: baseline ? 'International baseline' : (pack.name || ''),
      flag: baseline ? '🌐' : '',
      currency: (desk && desk.currency) || pack.homeCurrency || (settings && settings.baseCurrency) || null,
      threshold: desk && desk.reportThreshold ? lineAmount(desk.reportThreshold) : null,
      idAt: desk && desk.idThreshold ? lineAmount(desk.idThreshold) : null,
      aggHours: desk && desk.aggregationHours ? lineAmount(desk.aggregationHours) : null,
      retentionYears: desk && desk.retentionYears ? lineAmount(desk.retentionYears) : null,
      largeCode: (large && large.code) || pack.reportName || '',
      largeLabel: (large && large.name) || (baseline ? 'Large cash record' : ''),
      wireCode: wire ? wire.code : '',
      wireLabel: wire ? (wire.name || '') : '',
      strCode: suspicious ? suspicious.code : '',
      strLabel: suspicious ? (suspicious.name || '') : '',
      sanctionsCode: sanctions ? sanctions.code : (baseline ? 'SANCTIONS-STOP' : ''),
      sanctionsLabel: sanctions ? (sanctions.name || '') : (baseline ? 'Terrorist or sanctioned property' : ''),
      fileFormat: null,
      watchlists: [],
      baseline,
      reports: listed,
    };
  }

  function getRegime(settings) {
    const pack = loadedPack();
    /* No pack for this country. Do not fill the gap with Canada's rules. */
    if (window.CDOS && window.CDOS.rulesMissing && window.CDOS.rulesMissing(settings)) {
      return {
        id: null, authority: null, country: null,
        currency: (pack && pack.homeCurrency) || (settings && settings.baseCurrency) || null,
        threshold: null, aggHours: null, idAt: null, retentionYears: null,
        largeCode: '', largeLabel: '', wireCode: '', wireLabel: '',
        strCode: '', strLabel: '', fileFormat: null, watchlists: [], baseline: false, reports: [],
      };
    }
    if (pack && pack.packId) return regimeFromPack(pack, settings);
    if (settings && settings.baselineRules) {
      return regimeFromPack({
        packId: 'pack-intl-v1', baseline: true, kind: 'baseline',
        name: 'International baseline', regulator: '', reportName: 'CASH-RECORD',
        homeCurrency: (settings && settings.baseCurrency) || 'USD', reportCurrency: 'USD',
        reportThreshold: '10000', idThreshold: '3000',
      }, settings);
    }
    /* Standalone build, no ledger. The two-country table is all it has. */
    const base = (settings && settings.regime && REGIMES[settings.regime]) || REGIMES.FINTRAC;
    const r = Object.assign({ baseline: false, reports: [] }, base);
    if (settings && +settings.threshold) r.threshold = +settings.threshold;
    if (settings && +settings.idRequiredOver) r.idAt = +settings.idRequiredOver;
    if (settings && +settings.aggHours) r.aggHours = +settings.aggHours;
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
  /* A short, stable fingerprint of a transaction SET.

     An aggregate used to be identified by who and which day and nothing
     else, so a report filed over four cash-ins silently absorbed the fifth:
     the same person on the same day produced the same cluster id, that id
     was already marked filed, and the card went on reading "6 cash-ins ·
     $16,600 · ✓ filed FWR-AGG-RC-0001" over a sealed copy that covered
     $14,100. There was no File button and no warning — the desk did not
     merely miss a report, it asserted compliance over an under-report.

     Folding the set into the identity makes a changed set a DIFFERENT
     obligation, which is what it is. The who-and-when identity survives
     alongside it as `groupId`, so the new obligation can find what was
     already filed over the same person's day and link to it rather than
     arriving as an unrelated report that says nothing about the four deals
     already covered. */
  function setFingerprint(ids) {
    const s = (ids || []).map(String).sort().join('|');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36).toUpperCase().padStart(6, '0').slice(-6);
  }

  /* The large-cash report on this pack, when it says to add every
     amount. Absent on pack-ca-v1 and on an EFTR, which still leave a
     single already at the line out of the aggregate and file it alone.
     FINTRAC's 24-hour guidance (updated 2023-10-23) is the split:
     LCTR and LVCTR include every amount; EFTR does not, until its new
     form exists. */
  function largePolicy(regime) {
    const report = (regime && regime.reports || []).find(r => r && r.kind === 'large_cash');
    if (!report || !report.aggregateAllAmounts) return null;
    const axes = (report.aggregationAxes && report.aggregationAxes.length)
      ? report.aggregationAxes
      : ['conductor', 'on_behalf_of', 'beneficiary'];
    return { includeAll: true, axes: axes };
  }
  function reportByKind(regime, kind) {
    return (regime && regime.reports || []).find(r => r && r.kind === kind) || null;
  }

  // Events: { id, ref, date, time, t:Date, amt, customer, beneficiary, onBehalfOf }.
  // `kind` is the report code stamped on each cluster.
  // `policy` null keeps the older rule (drop a single already at the
  // line; conductor and beneficiary only). A policy with includeAll
  // keeps every amount, and uses the axes the pack named.
  function aggregateEvents(events, regime, settings, kind, policy) {
    const TH = regime.threshold, H = regime.aggHours || 24;
    /* No threshold means no aggregate. A missing number is not zero, and
       it is not Canada's 10,000. */
    if (!(TH > 0)) return [];
    const includeAll = !!(policy && policy.includeAll);
    const axisFns = {
      conductor: e => e.customer,
      on_behalf_of: e => e.onBehalfOf,
      beneficiary: e => e.beneficiary,
    };
    const axes = includeAll
      ? (policy.axes || ['conductor', 'on_behalf_of', 'beneficiary'])
      : ['conductor', 'beneficiary'];
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
        evs.forEach(e => {
          /* Older rule: a receipt already at the line is its own report
             and is not also added into the cluster. includeAll is the
             opposite: 12,000 plus 1,000 is one report of 13,000. */
          if (!includeAll && e.amt >= TH) return;
          const k = keyFn(e); if (!k) return; (groups[k] = groups[k] || []).push(e);
        });
        return Object.keys(groups).map(subject => {
          const txs = groups[subject].slice().sort((a, b) => a.t - b.t);
          const total = txs.reduce((s, o) => s + o.amt, 0);
          /* One transaction, however large, stays a single report.
             Two or more, of any amount, become one report once the
             total reaches the line. */
          if (txs.length < 2 || total < TH) return null;
          const endRow = txs[txs.length - 1];
          const groupId = 'AGG-' + kind + '-' + basis.charAt(0).toUpperCase() + '-' + String(subject).replace(/\s+/g, '_') + '-' + dayKey;
          return { id: groupId + '-' + setFingerprint(txs.map(t => t.id)), groupId, kind, basis, subject, customer: subject, txs, total, end: endRow.date + ' ' + (endRow.time || ''), endRow, windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(), windowLabel };
        }).filter(Boolean);
      };
      /* The same set of transactions on two axes is one report.
         A partial overlap is two reports. Conductor is emitted first
         so it keeps the identical set. */
      const sig = (c) => c.txs.map(t => t.id).sort().join(',');
      const seen = new Set();
      axes.forEach(axis => {
        const keyFn = axisFns[axis];
        if (!keyFn) return;
        mk(axis, keyFn).forEach(cluster => {
          const mark = sig(cluster);
          if (seen.has(mark)) return;
          seen.add(mark);
          out.push(cluster);
        });
      });
    });
    return out.sort((a, b) => b.total - a.total);
  }
  function eventFromRow(r) {
    return {
      id: r.id, ref: r.ref, date: r.date, time: r.time, t: dt(r),
      amt: cashIn(r), customer: r.customer, beneficiary: r.beneficiary,
      onBehalfOf: (r.capture && r.capture.thirdPartyName) || r.thirdPartyName || '',
    };
  }
  // LCTR: cash received. The policy comes from the large-cash report.
  function aggClusters(rows, regime, settings) {
    const events = (rows || []).filter(r => r.status !== 'void' && cashIn(r) > 0).map(eventFromRow);
    return aggregateEvents(events, regime, settings, regime.largeCode, largePolicy(regime));
  }
  /* Receipts already inside an include-all cluster are not also filed
     as their own large-cash report. A lone receipt at the line is not
     in a cluster, so it stays a single. */
  function includeAllCoveredRefs(rows, regime, settings) {
    if (!largePolicy(regime)) return [];
    const refs = [];
    aggClusters(rows, regime, settings).forEach(c => c.txs.forEach(t => refs.push(t.ref)));
    return refs;
  }
  /* LVCTR. Same window as a large cash report, over rows the book
     marked as virtual currency received. The counter does not book
     that instrument yet, so this returns nothing until one exists. */
  function aggClustersVc(rows, regime, settings) {
    const report = reportByKind(regime, 'virtual_currency');
    if (!report || !report.aggregateAllAmounts) return [];
    const threshold = report.triggerThreshold != null ? +report.triggerThreshold : regime.threshold;
    const events = (rows || []).filter(r => r.status !== 'void' && r.receivedInstrument === 'virtual_currency').map(r => {
      const base = eventFromRow(r);
      const amt = cashIn(r) > 0 ? cashIn(r) : home(r.inAmt, r.inCcy);
      return Object.assign({}, base, { amt: amt });
    }).filter(e => e.amt > 0);
    return aggregateEvents(events, Object.assign({}, regime, { threshold: threshold }), settings, report.code || 'LVCTR', {
      includeAll: true,
      axes: (report.aggregationAxes && report.aggregationAxes.length) ? report.aggregationAxes : ['conductor', 'on_behalf_of', 'beneficiary'],
    });
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
    _compliance: { REGIMES, getRegime, WATCHLISTS, LIST_TONE, screen, matchScore, STAT, aggClusters, aggClustersEFT, aggClustersVc, includeAllCoveredRefs, largePolicy, cadIn, cashIn, dt, setFingerprint },
    getRegime,
    jurisdictionViolations,
    jurisdictionPosture,
  });
})();
