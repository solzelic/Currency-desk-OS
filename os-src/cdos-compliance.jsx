/* ============================================================
   CurrencyDesk OS — Compliance (AML regime engine)
   Closes three real holes and makes the regime pluggable:
     • Jurisdiction packs — FINTRAC (Canada) and a FinCEN (US) pack
       slot into ONE engine: threshold, base currency, the rolling-
       aggregation window, report codes, terminology and the fileable
       format all come from the active pack. computeFlags reads it too.
     • Sanctions screening is not connected. No pack ships a list,
       and the desk does not match names. The owner checks the
       official lists themselves.
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
    const reports = (window.CDOS && window.CDOS.deskReports) ? (window.CDOS.deskReports() || []) : [];
    const large = reports.find(r => r && r.kind === 'large_cash');
    /* Australia does not add threshold transactions together. The pack
       column still holds 24 because that column cannot be empty. The
       report row is the rule, and the sentence has to say so.
       India files a calendar month, not a count of hours. The
       Philippines stores a banking day, not a count of hours. Naming a
       missing hour figure "Aggregation window" would tell the desk the
       rule is 24 hours. */
    const monthCash = !!(large && large.windowKind === 'calendar_month');
    const bankingDay = !!(large && large.windowKind === 'banking_day');
    /* An LCTR is 24 hours. A stored hour count is not a posture. */
    const lctr = !!(large && large.code === 'LCTR');
    const aggregation = (monthCash || bankingDay || lctr)
      ? null
      : large && large.windowKind === 'none'
      ? {
          field: 'aggHours',
          label: 'Aggregation window',
          standing: 'following',
          authority: source.authority,
          value: null,
          mandate: null,
          deskChoice: null,
          currency: null,
          note: `Following ${source.authority}. A threshold transaction is one transaction. Deals are not added together.`,
          detail: `Following ${source.authority}. A threshold transaction is one transaction. Deals are not added together.`,
        }
      : postureOf(L.aggregationHours, { ...common, field: 'aggHours', label: 'Aggregation window', unit: 'h', direction: 'atLeast' });
    return [
      postureOf(L.reportThreshold, { ...common, ...reportCopy, field: 'threshold', label: 'Reporting threshold', money: true, direction: 'atMost' }),
      postureOf(L.idThreshold, { ...common, ...idCopy, field: 'idRequiredOver', label: 'Identification threshold', money: true, direction: 'atMost' }),
      aggregation,
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
      fileFormat: 'FWR JSON batch', watchlists: [],
    },
    FINCEN: {
      id: 'FINCEN', authority: 'FinCEN', country: 'United States', flag: '🇺🇸', currency: 'USD',
      threshold: 10000, aggHours: 24, idAt: 3000,
      largeCode: 'CTR', largeLabel: 'Currency Transaction Report',
      wireCode: 'CTR-FT', wireLabel: 'CTR — funds transfer',
      strCode: 'SAR', strLabel: 'Suspicious Activity Report',
      fileFormat: 'BSA E-Filing XML', watchlists: [],
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
    /* A suspicious report is not a large-cash report, even when its code
       is the only name the pack printed. Match the kind. */
    const large = listed.find(r => r && r.kind === 'large_cash')
      || (baseline ? byCode('CASH-RECORD') : null);
    const suspicious = byCode('SUSPICIOUS') || listed.find(r => r && r.kind === 'suspicious');
    const idLines = (window.CDOS && window.CDOS.deskIdThresholds) ? (window.CDOS.deskIdThresholds() || []) : [];
    const fxLine = idLines.find(r => r && r.dealKind === 'fx');
    const sanctions = byCode('SANCTIONS-STOP');
    const wire = listed.find(r => r && (r.kind === 'wire' || r.kind === 'eft'));
    const noCashWindow = !!(large && large.windowKind === 'none');
    const wireEvery = !!(wire && (wire.triggerThreshold == null || wire.triggerThreshold === ''));
    return {
      id: pack.packId || null,
      authority: baseline ? "Your country's financial intelligence unit" : (pack.regulator || ''),
      country: baseline ? 'International baseline' : (pack.name || ''),
      flag: baseline ? '🌐' : (pack.jurisdiction === 'AU' ? '🇦🇺' : ''),
      currency: (desk && desk.currency) || pack.homeCurrency || (settings && settings.baseCurrency) || null,
      threshold: desk && desk.reportThreshold ? lineAmount(desk.reportThreshold) : null,
      idAt: desk && desk.idThreshold ? lineAmount(desk.idThreshold) : null,
      /* A 'none' window means do not add deals together. Falling back to
         24 here is how a country that forbids aggregation was shown a
         24 hour rule. A calendar month is not an hour count either.
         India keeps that month on windowKind and leaves aggHours empty.
         A banking day is not an hour count either. The Philippines
         keeps that day on windowKind and leaves aggHours empty. */
      aggregate: !noCashWindow,
      largeDirection: (large && large.direction) || 'in',
      windowKind: (large && large.windowKind) || null,
      comparator: (large && large.comparator) || 'gte',
      idComparator: (fxLine && fxLine.comparator) || 'gte',
      /* LCTR is 24 hours. desk.aggregationHours is stored and is not applied. */
      aggHours: (noCashWindow || (large && large.windowKind === 'calendar_month') || (large && large.windowKind === 'banking_day'))
        ? null
        : (large && large.code === 'LCTR')
          ? 24
          : (desk && desk.aggregationHours ? lineAmount(desk.aggregationHours) : null),
      wireEvery,
      wireTrigger: wire && wire.triggerThreshold != null && +wire.triggerThreshold > 0 ? +wire.triggerThreshold : null,
      wireAggregate: !(wire && wire.windowKind === 'none'),
      retentionYears: desk && desk.retentionYears ? lineAmount(desk.retentionYears) : null,
      largeCode: (large && large.code) || (baseline ? (pack.reportName || '') : ''),
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
    /* LCTR stays 24. A stored aggHours does not move it. */
    if (r.largeCode === 'LCTR') r.aggHours = 24;
    else if (settings && +settings.aggHours) r.aggHours = +settings.aggHours;
    return r;
  }

  /* ===================== SANCTIONS / WATCHLISTS =====================
     No list is loaded. A sample of ten names used to stand in for
     official sanctions lists, and a Canada desk showed those names
     as hits. They were fiction. The screen says screening is not
     connected. It does not name a list, it does not show a count,
     and it does not present a seeded subject as a result.

     sanctionsListShips is false for every pack, including the
     Philippines (pack-ph-v1), Singapore (pack-sg-v1) and Hong Kong
     (pack-hk-v1). `pack` is read so a later feed can return true for
     one id without each screen growing its own pack check. */
  const WATCHLISTS = [];
  const NOT_CONNECTED = "Sanctions screening is not connected yet. Check clients against your government's official lists yourself.";
  /* The duty those three packs already state, after the sentence above.
     The sentence does not name a sanctions list. */
  const PACK_DUTY = {
    'pack-ph-v1': 'Philippine law requires the owner to screen clients and counterparties, including against the ATC list. On a match, freeze without delay, tell the AMLC the same day, and file an STR. The owner does this outside the desk for now.',
    'pack-sg-v1': 'Singapore law requires the owner to screen every customer against the MAS lists outside this desk for now. PSN01 paragraphs 7.51 to 7.53. This screen does not match names.',
    'pack-hk-v1': 'Hong Kong law requires the owner to screen against designated persons under the local sanctions ordinances (Cap. 537 and Cap. 575). The owner does this outside the desk. This screen does not match names.',
  };
  function sanctionsListShips(pack) {
    const id = pack && (pack.packId || pack.id);
    if (id === 'pack-ph-v1' || id === 'pack-sg-v1' || id === 'pack-hk-v1') return false;
    /* Canada and the other packs used to show the sample. They do not. */
    return false;
  }
  function screeningNote(pack) {
    const id = pack && (pack.packId || pack.id);
    const duty = id && PACK_DUTY[id];
    return duty ? NOT_CONNECTED + ' ' + duty : NOT_CONNECTED;
  }
  /* Nothing to match. Callers that used to treat "clear" as a finished
     screen must read sanctionsListShips first. "unavailable" is not a hit
     and it is not a clear. */
  function screen() {
    return { status: 'unavailable', hits: [] };
  }
  const LIST_TONE = {};
  const STAT = { unavailable: { t: 'Not connected', c: CD.mute, bg: CD.lineSoft, icon: 'shield' } };

  /* ===================== 24-HOUR AGGREGATION (by rule) =====================
     The hard part, done properly:
       • The rolling 24 hours, measured back from each deal on
         the branch clock (shared/rolling-24h.js). A stored anchor
         (settings.aggWindowStart) is not applied. The total does not
         reset at midnight. Every report declares that lookback.
       • DUAL BASIS. Sub-threshold cash-in is aggregated both by conductor
         (who handed over the cash) and by beneficiary (who it is destined
         for). Three different people sending $4k each to one beneficiary
         is a reportable event on the beneficiary axis even though no
         single conductor reaches the threshold. When the two axes capture
         different transactions, both reports are emitted.
       • Singles (at or over the threshold on their own) are filed
         individually elsewhere, so the older aggregate rule sums only
         the sub-threshold cash-in. LCTR and LVCTR include every amount. */
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
    /* A calendar-month pack is not this 24-hour engine. A single cash
       amount over the line is flagged on the deal. Connected deals in
       the month are not summed here. indiaCtrFindings can group them,
       and nothing calls it yet. A banking day is not this engine
       either. The Philippines flags one deal and does not add the day. */
    if (regime && (regime.windowKind === 'calendar_month' || regime.windowKind === 'banking_day')) return [];
    const TH = regime.threshold;
    /* An LCTR is 24 hours. regime.aggHours and the stored settings
       (aggregationHours, aggHours, aggWindowStart) do not move it. */
    const lctrWindow = kind === 'LCTR' || (regime && regime.largeCode === 'LCTR' && kind === regime.largeCode);
    const H = lctrWindow ? 24 : (regime.aggHours || 24);
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
    /* settings.aggWindowStart is stored and is not applied. */
    void settings;
    const zone = (window.CDOS.branchZone && window.CDOS.branchZone()) || 'America/Toronto';
    const wall = window.CDOS.wallInstant;
    const inside = window.CDOS.inRollingWindow;
    const spanOf = window.CDOS.rollingWindow;
    const instantOf = (e) => {
      if (wall && e.date) {
        const at = wall(e.date, e.time || '00:00', zone);
        if (at) return at;
      }
      const fallback = e.t instanceof Date ? e.t : new Date(e.t);
      return fallback && !isNaN(fallback.getTime()) ? fallback : null;
    };
    const rows = [];
    (events || []).forEach(e => {
      if (!(e.amt > 0)) return;
      const at = instantOf(e);
      if (!at) return;
      rows.push(Object.assign({}, e, { at: at }));
    });
    const fmtT = (d) => {
      const format = (window.CDOS.deskFormat && window.CDOS.deskFormat()) || '12h';
      const day = window.CDOS.deskDay(d, zone);
      const time = window.CDOS.deskTime(d, format, zone);
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
      return (m ? mon[+m[2] - 1] + ' ' + (+m[3]) : day) + ' ' + time;
    };
    const inWindow = (earlier, later) => {
      if (inside) return inside(earlier, later, H);
      const start = later.getTime() - H * 3600000;
      const t = earlier.getTime();
      return t >= start && t <= later.getTime();
    };
    const out = [];
    const mk = (basis, keyFn) => {
      const groups = {};
      rows.forEach(e => {
        /* Older rule: a receipt already at the line is its own report
           and is not also added into the cluster. includeAll is the
           opposite: 12,000 plus 1,000 is one report of 13,000. */
        if (!includeAll && e.amt >= TH) return;
        const k = keyFn(e); if (!k) return; (groups[k] = groups[k] || []).push(e);
      });
      const found = [];
      Object.keys(groups).forEach(subject => {
        const txs = groups[subject].slice().sort((a, b) => a.at - b.at);
        const hits = [];
        txs.forEach(endRow => {
          const set = txs.filter(e => inWindow(e.at, endRow.at));
          const total = set.reduce((s, o) => s + o.amt, 0);
          /* One transaction, however large, stays a single report.
             Two or more, of any amount, become one report once the
             total reaches the line. */
          if (set.length < 2 || total < TH) return;
          hits.push({ endRow: endRow, set: set, total: total });
        });
        hits.forEach((item, index) => {
          /* A later lookback that already contains this set is the
             report. An earlier window that is not inside that later
             set stays its own report. */
          const coveredLater = hits.slice(index + 1).some(later => {
            const ids = {};
            later.set.forEach(t => { ids[t.id] = true; });
            return item.set.every(t => ids[t.id]);
          });
          if (coveredLater) return;
          const ordered = item.set.slice().sort((a, b) => a.at - b.at);
          const earliest = ordered[0];
          const span = (spanOf && spanOf(item.endRow.at, H)) || {
            start: new Date(item.endRow.at.getTime() - H * 3600000),
            end: item.endRow.at,
          };
          const groupId = 'AGG-' + kind + '-' + basis.charAt(0).toUpperCase() + '-' + String(subject).replace(/\s+/g, '_') + '-' + String(earliest.at.getTime());
          const endRow = item.endRow;
          found.push({
            id: groupId + '-' + setFingerprint(ordered.map(t => t.id)),
            groupId: groupId, kind: kind, basis: basis, subject: subject, customer: subject,
            txs: ordered, total: item.total,
            end: endRow.date + ' ' + (endRow.time || ''), endRow: endRow,
            windowStart: span.start.toISOString(), windowEnd: span.end.toISOString(),
            windowLabel: fmtT(span.start) + ' → ' + fmtT(span.end),
          });
        });
      });
      return found;
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
    return out.sort((a, b) => b.total - a.total);
  }
  function eventFromRow(r) {
    return {
      id: r.id, ref: r.ref, date: r.date, time: r.time, t: dt(r),
      amt: cashIn(r), customer: r.customer, beneficiary: r.beneficiary,
      onBehalfOf: (r.capture && r.capture.thirdPartyName) || r.thirdPartyName || '',
      status: r.status, voidReason: r.voidReason || '',
    };
  }
  // LCTR: cash received. The policy comes from the large-cash report.
  function countsForLctr(row) {
    const rule = window.CDOS.lctrReversal;
    return !row || row.status !== 'void' || !!(rule && rule.countsTowardLctr(row.voidReason));
  }
  function branchWhen(raw, zone) {
    const text = raw == null ? '' : String(raw).trim();
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shape = (day, time) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
      return m && time ? (+m[3]) + ' ' + mon[+m[2] - 1] + ' ' + m[1] + ', ' + time : '';
    };
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && window.CDOS.deskDay && window.CDOS.deskTime) {
      const when = new Date(text);
      if (isNaN(when.getTime())) return '';
      return shape(window.CDOS.deskDay(when, zone), window.CDOS.deskTime(when, '12h', zone));
    }
    const stamped = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2} [ap]m)$/i.exec(text);
    return stamped ? shape(stamped[1], stamped[2].toLowerCase()) : text;
  }
  function noticeOf(r, rule, zone, settings) {
    const name = rule.staffDisplayName(r.voidBy, (settings && settings.employees) || [], r.voidByName);
    const clock = branchWhen(r.voidAt, zone);
    return { line: rule.LEFT_OUT_LINE, by: name, at: clock, setBy: name && clock ? rule.setByLine(name, clock) : '', ref: r.ref };
  }
  /* A booking error in the 24 hours before a kept deal, even when no cluster remains. */
  function lctrLeftOut(rows, regime, settings) {
    const rule = window.CDOS.lctrReversal;
    if (!rule || (regime && regime.aggregate === false)) return [];
    const zone = (window.CDOS.branchZone && window.CDOS.branchZone()) || 'America/Toronto';
    const wall = window.CDOS.wallInstant;
    const inside = window.CDOS.inRollingWindow;
    const atOf = (row) => (wall && row.date ? wall(row.date, row.time || '00:00', zone) : null);
    const kept = (rows || []).filter(row => countsForLctr(row) && cashIn(row) > 0);
    return (rows || []).filter(row => row.status === 'void' && rule.isBookingErrorReason(row.voidReason) && cashIn(row) > 0).filter(row => {
      const at = atOf(row);
      return !!at && kept.some(k => {
        const end = atOf(k);
        return (k.customer || '') === (row.customer || '') && end && inside && inside(at, end, 24);
      });
    }).map(row => noticeOf(row, rule, zone, settings));
  }
  function aggClusters(rows, regime, settings) {
    if (regime && regime.aggregate === false) return [];
    const events = (rows || []).filter(r => countsForLctr(r) && cashIn(r) > 0).map(eventFromRow);
    const clusters = aggregateEvents(events, regime, settings, regime.largeCode, largePolicy(regime));
    const notices = lctrLeftOut(rows, regime, settings);
    const zone = (window.CDOS.branchZone && window.CDOS.branchZone()) || 'America/Toronto';
    clusters.forEach(c => {
      const start = Date.parse(c.windowStart), end = Date.parse(c.windowEnd);
      c.leftOut = notices.filter(item => {
        const row = (rows || []).find(r => r.ref === item.ref);
        if (!row || (c.basis === 'beneficiary' ? row.beneficiary : c.basis === 'on_behalf_of' ? ((row.capture && row.capture.thirdPartyName) || row.thirdPartyName || '') : row.customer) !== c.subject) return false;
        const at = window.CDOS.wallInstant && row.date ? window.CDOS.wallInstant(row.date, row.time || '00:00', zone) : null;
        return !!at && at.getTime() >= start && at.getTime() <= end;
      });
    });
    return clusters;
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
  // EFTR — international electronic transfers. Same machinery, wires not cash.
  // A wire window of 'none' means each transfer stands on its own.
  function aggClustersEFT(transfers, beneficiaries, regime, settings) {
    if (regime && regime.wireAggregate === false) return [];
    const benName = (id) => { const b = (beneficiaries || []).find(x => x.id === id); return b ? b.name : null; };
    const events = (transfers || []).filter(t => t.status !== 'cancelled').map(t => {
      const cad = t.direction === 'send' ? (Number(t.payAmt) || 0) : ((Number(t.recvAmt) || 0) / (crossRate('CAD', t.ccy) || 1));
      return { id: t.id || t.ref, ref: t.ref, date: t.date, time: t.time || '00:00', t: new Date(t.date + 'T' + (t.time || '00:00')), amt: cad, customer: t.senderName, beneficiary: benName(t.beneficiaryId) || (t.direction === 'send' ? t.partner : t.senderName) };
    });
    return aggregateEvents(events, regime, settings, regime.wireCode);
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    _compliance: { REGIMES, getRegime, WATCHLISTS, LIST_TONE, screen, STAT, aggClusters, lctrLeftOut, aggClustersEFT, aggClustersVc, includeAllCoveredRefs, largePolicy, cadIn, cashIn, dt, setFingerprint, sanctionsListShips, screeningNote, NOT_CONNECTED },
    getRegime,
    jurisdictionViolations,
    jurisdictionPosture,
  });
})();
