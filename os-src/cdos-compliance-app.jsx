/* ============================================================
   CurrencyDesk OS — Compliance app shell
   Screening · Aggregation · Submissions · Regime.
   Reads the engine from window.CDOS._compliance.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num, TODAY } = window.CDOS;
  const C = window.CDOS._compliance;
  const { REGIMES, getRegime, WATCHLISTS, LIST_TONE, screen, STAT, aggClusters, aggClustersEFT, cadIn, cashIn } = C;
  const computeFlags = window.CDOS.computeFlags;
  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const SUBKEY = 'cdos_submissions_v1';
  const HKEY = 'cdos_report_history_v1';
  const loadSubs = () => { try { return JSON.parse(localStorage.getItem(SUBKEY) || '{}') || {}; } catch (e) { return {}; } };
  const loadTransfers = () => { try { return JSON.parse(localStorage.getItem('cdos_transfers_v1') || '[]') || []; } catch (e) { return []; } };

  /* ===================== WHERE A FILED REPORT LIVES =====================
     On the ledger. `cdos_submissions_v1` is a cache of it.

     It used to be the record, and that was four separate incidents waiting
     to happen. The store dies with the browser profile — "clear site data",
     a private window, a new machine — while the sealed PDF printed over it
     says "Retain ≥ 5 years per FINTRAC record-keeping". Two tills held two
     disjoint sets of the same entity's filings. The copy is unencrypted
     name, date of birth, address and document number sitting in a shared
     counter browser. And the store is bounded: each filing embeds its own
     sealed HTML at about 9.5 KB, five hundred of them is around the typical
     localStorage quota, and the write was wrapped in a catch that swallowed
     QuotaExceededError — so a busy desk would eventually see "sealed" on a
     filing that was never written anywhere.

     So the seal goes to the server first and the local copy is written
     afterwards. If the server refuses, NOTHING is sealed and the worksheet
     says why, because a sealed copy the regulator's record does not know
     about is the defect, not the fallback.

     A desk with no ledger — the plan does not include it, or this is a
     demonstration — still gets the worksheet, but the Filings page says out
     loud that what it is holding is a browser copy and not a record. */
  const filingsApi = () => (window.CDOS.Backend && window.CDOS.Backend.loadReportFilings ? window.CDOS.Backend : null);

  /* One server filing, in the shape the screen already speaks. `sealed` is
     deliberately absent: the list response leaves the payload out, and the
     sealed copy is fetched from the ledger the moment somebody asks to see
     it — which is also what proves it survived the browser. */
  function subFromFiling(f) {
    return {
      status: 'submitted',
      ackNo: f.acknowledgementRef || '',
      submittedAt: (f.filedAt || '').replace('T', ' ').slice(0, 19),
      kind: f.reportCode,
      by: f.filedBy || '',
      channel: 'FWR',
      filingId: f.filingId,
      amendsFilingId: f.amendsFilingId || null,
      amendedByFilingId: f.amendedByFilingId || null,
      groupId: f.obligationGroupId || null,
      refs: f.transactionRefs || [],
      subject: f.subjectName || '',
      amount: f.reportedAmount == null ? 0 : Number(f.reportedAmount),
      server: true,
    };
  }

  /* What has already been filed over this obligation's GROUP — the same
     person, the same report, the same day — and which of its transactions
     those filings covered.

     This is what stops a filed aggregate absorbing a later deal. The
     obligation id now carries a fingerprint of its transaction set, so six
     cash-ins are not the four that were filed; the group id is what they
     still share, and it is how the screen can say "4 of these 6 were filed
     under FWR-AGG-RC-0001, 2 still need filing" instead of either lying or
     minting a fresh report that mentions neither.

     Filings sealed before any of this existed were keyed by the group id
     itself, so that is accepted as a match — a desk upgrading mid-week does
     not want its week's work to reappear as unfiled. */
  function filedCoverage(groupId, subs) {
    const filings = [];
    const refs = new Set();
    Object.keys(subs || {}).forEach(id => {
      const s = subs[id];
      if (!s || s.status !== 'submitted') return;
      const g = s.groupId || (s.sealed && s.sealed.groupId) || id;
      if (g !== groupId) return;
      filings.push(Object.assign({ obligationId: id }, s));
      ((s.sealed && s.sealed.refs) || s.refs || []).forEach(r => refs.add(r));
    });
    filings.sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
    return { filings, refs };
  }

  /* ===================== THE HISTORY TAB, WHICH IS ALSO A CACHE =====================
     Two things were wrong with the way a filing landed here.

     It deleted the previous one. `hist.filter(e => !(e.filing && e.ref ===
     reportRef))` was written to keep the list tidy, and what it actually did
     was destroy the sealed copy of a report that had already been submitted
     to the regulator — so an STR filed, then corrected, left the desk with
     one record of two submissions carrying two different acknowledgement
     numbers. A correction is a new report. It goes beside the original.

     And the write could not fail out loud. Each entry embeds its own sealed
     HTML at roughly 9.5 KB, five hundred of those is about a browser's whole
     localStorage quota, and the whole write sat inside `catch (e) {}` — so
     the desk that hit the quota saw "sealed" on a filing that was never
     written anywhere. Now: the ledger already holds the copy, so the local
     one is allowed to be evicted; the eviction happens deliberately, oldest
     sealed HTML first, and the entry keeps its metadata and a line saying
     where the real copy is. Only a desk with no ledger at all can lose
     anything here, and that desk is told. */
  function historyFallbackHTML(entry) {
    return '<div style="font-family:Archivo,system-ui,sans-serif">'
      + '<div style="font-size:18px;font-weight:700">' + entry.title + '</div>'
      + '<div style="font-size:12px;color:#555;margin-top:6px">Report ' + entry.ref + ' · acknowledgement ' + entry.ack + ' · filed ' + entry.at + '</div>'
      + '<div style="font-size:12.5px;margin-top:14px;line-height:1.5">The sealed copy of this filing is held on the ledger. Open it from '
      + '<b>Compliance ▸ Filings</b>, where it is fetched from the record rather than from this browser.</div></div>';
  }
  function pushFilingHistory({ filing, kindLabel, regime, ctx, serverBacked, log }) {
    let hist = [];
    try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]') || []; } catch (e) {}
    const nowMs = Date.now();
    const entry = {
      key: 'F' + nowMs.toString(36) + Math.random().toString(36).slice(2, 5),
      ms: nowMs, type: filing.kind, title: `${kindLabel} · ${filing.subject}`,
      icon: 'lock', tone: filing.kind === regime.wireCode ? '#1d4ed8' : CD.flag,
      at: filing.filedAt, ref: filing.reportRef, ack: filing.fwrReceipt,
      subject: filing.subject, amount: filing.amount, filing: true,
    };
    try { entry.fullHTML = window.CDOS.LCTR.sealedHTML(filing, ctx); } catch (e) {}
    entry.html = historyFallbackHTML(entry);
    // newest first, and NOTHING is filtered out — a correction sits beside
    // the report it corrects, because both were really submitted
    let next = [entry, ...hist];
    for (let attempt = 0; attempt < 40; attempt++) {
      try { localStorage.setItem(HKEY, JSON.stringify(next.slice(0, 500))); return; }
      catch (e) {
        // drop the heaviest thing first: the sealed HTML of the oldest
        // filing that still carries one. Its metadata and its pointer at
        // the ledger's copy stay.
        let dropped = false;
        for (let i = next.length - 1; i > 0; i--) {
          if (next[i].fullHTML) { next[i] = { ...next[i], fullHTML: null }; dropped = true; break; }
        }
        if (!dropped) next = next.slice(0, Math.max(1, next.length - 20));
      }
    }
    /* Still would not fit. On a desk with the ledger behind it that costs a
       cache entry and nothing else; on one without, it is the loss the
       swallowed catch used to hide, and it is said out loud. */
    log && log('Report history full',
      serverBacked
        ? `${filing.reportRef} is filed on the ledger; this browser could not keep a local copy of it.`
        : `${filing.reportRef} could not be written to this browser and this desk has no ledger copy. Save the sealed PDF yourself.`);
  }

  /* ===================== CANONICAL REPORTABLE OBLIGATIONS =====================
     The single source of truth for "what must be filed": individual + 24h-aggregate
     reportables, cash (LCTR) and wire (EFTR). Both the Compliance ▸ Filings page AND
     the OS menu-bar compliance badge derive from this, so they can never disagree.
     STRs are discretionary and appended separately by the Filings page. */
  function reportRefFor(kind, id) { return `${kind}-${(TODAY || '').slice(0, 4)}-${refHash(id)}`; }
  function computeReportables(rows, clients, settings, beneficiaries, subs) {
    const regime = getRegime(settings);
    const flags = computeFlags(rows, clients, settings);
    const transfers = loadTransfers();
    const xr = (ccy) => window.CDOS.crossRate('CAD', ccy) || 1;
    const out = [];
    // single cash transactions at/over threshold (filed individually)
    /* `cashIn`, not `cadIn` — the figure on a large-CASH report is the
       cash the customer put on the counter. `f.single` is raised from
       the same number, so a deal that took no cash never reaches here. */
    rows.filter(r => r.status !== 'void').forEach(r => { const f = flags[r.id] || {}; if (f.single) out.push({ id: 'L-' + r.ref, groupId: 'L-' + r.ref, kind: regime.largeCode, subject: r.customer, beneficiary: r.beneficiary, amount: cashIn(r), detail: `${r.type} · ${num(r.inAmt)} ${r.inCcy}`, date: r.date, refs: [r.ref] }); });
    // LCTR 24h aggregates (cash)
    aggClusters(rows, regime, settings).forEach(c => out.push({ id: c.id, groupId: c.groupId, kind: c.kind, subject: c.subject, amount: c.total, detail: `${c.txs.length}-deal ${regime.aggHours}h aggregate · by ${c.basis}`, date: c.endRow.date, refs: c.txs.map(t => t.ref), basis: c.basis, window: c.windowLabel, windowStart: c.windowStart, windowEnd: c.windowEnd }));
    // single international transfers at/over threshold
    transfers.filter(t => t.status !== 'cancelled').forEach(t => { const cad = t.direction === 'send' ? t.payAmt : (t.recvAmt / xr(t.ccy)); if (cad >= regime.threshold) out.push({ id: 'E-' + t.ref, groupId: 'E-' + t.ref, kind: regime.wireCode, subject: t.senderName, amount: cad, detail: `Cross-border to ${t.corridor} · ${t.partner}`, date: t.date, refs: [t.ref] }); });
    // EFTR 24h aggregates (wires) — same engine, different trigger
    aggClustersEFT(transfers, beneficiaries, regime, settings).forEach(c => out.push({ id: c.id, groupId: c.groupId, kind: c.kind, subject: c.subject, amount: c.total, detail: `${c.txs.length}-transfer ${regime.aggHours}h aggregate · by ${c.basis}`, date: c.endRow.date, refs: c.txs.map(t => t.ref), basis: c.basis, window: c.windowLabel, windowStart: c.windowStart, windowEnd: c.windowEnd }));
    return out.map(r => annotateCoverage({ ...r, reportRef: reportRefFor(r.kind, r.id) }, subs));
  }
  /* Which of this obligation's transactions a prior filing already covered.
     An obligation whose set has grown is a NEW obligation — that is what the
     fingerprint in its id says — but it is not an unrelated one, and the
     screen has to be able to say which deals are already reported and under
     which acknowledgement. */
  function annotateCoverage(o, subs) {
    const cov = filedCoverage(o.groupId || o.id, subs);
    const refs = o.refs || [];
    const covered = refs.filter(r => cov.refs.has(r));
    return {
      ...o,
      priorFilings: cov.filings,
      coveredRefs: covered,
      newRefs: refs.filter(r => !cov.refs.has(r)),
      // the filing a correction of this obligation would amend: the newest
      // one over the same person, report and day
      amendsFilingId: (cov.filings.length && cov.filings[cov.filings.length - 1].filingId) || null,
    };
  }
  // open = canonical obligations minus anything already sealed into a submitted filing
  function openReportables(rows, clients, settings, beneficiaries, subs) {
    return computeReportables(rows, clients, settings, beneficiaries, subs)
      .filter(o => !(subs && subs[o.id] && subs[o.id].status === 'submitted'));
  }
  /* "4 of these 6 were filed under FWR-AGG-RC-0001 · 2 still need filing" —
     the sentence a desk needed and did not get. Null when nothing about this
     obligation has been filed before, which is the ordinary case. */
  function coverageNote(o) {
    if (!o.priorFilings || !o.priorFilings.length || !o.coveredRefs.length) return null;
    const acks = o.priorFilings.map(f => f.ackNo).filter(Boolean);
    const total = (o.refs || []).length;
    return `${o.coveredRefs.length} of these ${total} ${total === 1 ? 'was' : 'were'} already filed under ${acks.join(' · ') || 'an earlier report'} · ${o.newRefs.length} still need${o.newRefs.length === 1 ? 's' : ''} filing`;
  }

  function Pill({ s, small }) { const c = STAT[s] || STAT.clear; return <span className="inline-flex items-center gap-1.5 font-semibold" style={{ background: c.bg, color: c.c, borderRadius: 999, fontSize: small ? 10 : 11, padding: small ? '2px 8px' : '3px 10px' }}><Ic n={c.icon} s={small ? 10 : 12} c={c.c} />{c.t}</span>; }
  function ListTag({ list }) { const t = LIST_TONE[list] || { c: CD.mute, bg: CD.lineSoft }; return <span className="text-[10px] px-1.5 py-0.5 font-semibold" style={{ background: t.bg, color: t.c, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>{list}</span>; }

  /* ===================== SCREENING ===================== */
  function Screening({ clients, setClients, beneficiaries, me, settings, onOpenSettings }) {
    const [q, setQ] = useState('');
    const [only, setOnly] = useState('flagged');
    const [picker, setPicker] = useState(false);
    const [verify, setVerify] = useState(null);   // { name, kind, rec }
    const KYC = window.CDOS.KYC;
    const kycStats = KYC ? KYC.summary() : { monthCount: 0, monthSpend: 0 };
    const subjects = useMemo(() => {
      const out = [];
      Object.keys(clients || {}).forEach(name => out.push({ name, kind: (clients[name].kind === 'corporate' ? 'Business' : 'Client'), ref: name }));
      (beneficiaries || []).forEach(b => out.push({ name: b.name, kind: 'Beneficiary', ref: 'of ' + b.sender }));
      return out.map(s => ({ ...s, ...screen(s.name) }));
    }, [clients, beneficiaries]);
    const counts = useMemo(() => ({ all: subjects.length, hit: subjects.filter(s => s.status === 'hit').length, review: subjects.filter(s => s.status === 'review').length, clear: subjects.filter(s => s.status === 'clear').length }), [subjects]);
    const shown = subjects.filter(s => (only === 'flagged' ? s.status !== 'clear' : only === 'all' ? true : s.status === only) && (!q || s.name.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => (b.hits[0] ? b.hits[0].score : 0) - (a.hits[0] ? a.hits[0].score : 0));

    // Settings → Compliance · sanctions screening switch gates the whole queue
    if (settings && settings.screenSanctions === false) return (<div className="p-4">
      <div className="flex flex-col items-center justify-center text-center py-16 px-6" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12 }}>
        <span className="grid place-items-center" style={{ width: 44, height: 44, borderRadius: '50%', background: CD.lineSoft }}><Ic n="shield" s={22} c={CD.faint} /></span>
        <div className="mt-3 text-sm font-semibold" style={{ color: CD.ink }}>Sanctions screening is switched off</div>
        <div className="mt-1 text-[12px] max-w-sm" style={{ color: CD.mute }}>No client or beneficiary names are being matched against the OFAC / UN / OSFI lists. Most regulators expect this to stay on.</div>
        <button onClick={() => onOpenSettings && onOpenSettings()} className="mt-4 flex items-center gap-1.5 px-3.5 py-2 text-[12.5px] font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}><Ic n="gear" s={14} c="var(--cd-on-ink)" /> Turn on in Settings</button>
      </div>
    </div>);

    return (<div className="p-4">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div><div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>Sanctions & watchlist screening <window.CDOS.InfoTip title="Sanctions screening" body="Every client and beneficiary name is matched against government watchlists. A hit (or possible match) must be reviewed before you transact with them." lines={[{k:'OFAC',v:'US Treasury sanctions list'},{k:'UN',v:'United Nations consolidated list'},{k:'OSFI',v:'Canada’s terrorist-financing list'}]} /></div><div className="text-[11px]" style={{ color: CD.mute }}>Every client and beneficiary screened against OFAC, UN and OSFI lists.</div></div>
        <div className="flex items-center gap-2 flex-none">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="search" s={15} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name…" className="outline-none text-sm bg-transparent" style={{ width: 130 }} /></div>
          {KYC && <button onClick={() => setPicker(true)} className="flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="id" s={15} c="var(--cd-on-ink)" /> New KYC check</button>}
        </div>
      </div>

      {KYC && <div className="flex items-center gap-2 mb-3 px-3 py-2" style={{ background: CD.brassSoft, border: `1px solid color-mix(in srgb, ${CD.brass} 20%, transparent)`, borderRadius: 9 }}>
        <Ic n="id" s={14} c={CD.brass} />
        <span className="text-[11.5px]" style={{ color: 'var(--cd-brass-text)' }}>Run a background check or ID verification on any subject through <b>Persona</b> — results attach to the contact and the History log.</span>
        <span className="ml-auto text-[11px] font-semibold flex-none" style={{ color: 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace' }}>{kycStats.monthCount} this month · ${kycStats.monthSpend.toFixed(2)}</span>
      </div>}

      <div className="grid grid-cols-4 gap-2 mb-3">
        {[['Subjects', counts.all, CD.ink], ['Confirmed hits', counts.hit, CD.flag], ['Possible matches', counts.review, CD.amber], ['Clear', counts.clear, CD.green]].map(([l, v, c], i) => (
          <div key={i} className="p-3" style={{ background: CD.panel, border: `1px solid ${i && v ? c : CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-xl font-bold" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
      </div>

      <div className="flex gap-1.5 mb-3">
        {[['flagged', 'Needs review'], ['hit', 'Hits'], ['review', 'Possible'], ['clear', 'Clear'], ['all', 'All']].map(([id, l]) => <button key={id} onClick={() => setOnly(id)} className="px-3 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${only === id ? 'transparent' : CD.line}`, background: only === id ? CD.ink : 'transparent', color: only === id ? 'var(--cd-on-ink)' : CD.mute }}>{l}</button>)}
      </div>

      <div className="space-y-2">
        {shown.map((s, i) => (
          <div key={i} className="p-3" style={{ background: CD.panel, border: `1px solid ${s.status === 'hit' ? CD.flag : CD.line}`, borderRadius: 11 }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: CD.lineSoft }}><Ic n={s.kind === 'Business' ? 'building' : s.kind === 'Beneficiary' ? 'send' : 'users'} s={16} c={CD.mute} /></span>
                <div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{s.name}</div><div className="text-[11px]" style={{ color: CD.mute }}>{s.kind} · {s.ref}</div></div>
              </div>
              <div className="flex items-center gap-2">
                <Pill s={s.status} />
                {KYC && <button onClick={() => setVerify({ name: s.name, kind: s.kind === 'Business' ? 'corporate' : 'individual', rec: (clients && clients[s.name]) || {} })} title={`Send ${s.name} for KYC verification`} className="flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: CD.panel }}><Ic n="id" s={12} c={CD.mute} /> Verify</button>}
              </div>
            </div>
            {s.hits.length > 0 && <div className="mt-2 pt-2 space-y-1" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              {s.hits.slice(0, 2).map((h, j) => (
                <div key={j} className="flex items-center justify-between text-[11.5px]">
                  <span className="flex items-center gap-1.5" style={{ color: CD.ink }}><ListTag list={h.w.list} /> {h.w.name} <span style={{ color: CD.faint }}>· {h.w.program} · {h.w.country}</span></span>
                  <span style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{Math.round(h.score * 100)}% match</span>
                </div>))}
            </div>}
          </div>))}
        {!shown.length && <div className="text-center py-12" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="shield" s={24} c={CD.green} /><div className="mt-2 text-[13px]">No subjects need review — all clear.</div></div>}
      </div>
      {picker && KYC && <KYC.PickerModal clients={clients} setClients={setClients} beneficiaries={beneficiaries} by={me && me.name} onClose={() => setPicker(false)} />}
      {verify && KYC && <KYC.SendModal subject={verify.name} kind={verify.kind} rec={verify.rec} by={me && me.name} onClose={() => setVerify(null)} />}
    </div>);
  }

  /* ===================== AGGREGATION (24h rule) ===================== */
  function Aggregation({ rows, settings, subs, fileReport, beneficiaries, onOpenTransaction, onOpenClient, onOpenRefs, onOpenTransfers }) {
    const regime = getRegime(settings);
    const clusters = useMemo(() => [...aggClusters(rows, regime, settings), ...aggClustersEFT(loadTransfers(), beneficiaries, regime, settings)].sort((a, b) => b.total - a.total), [rows, settings, beneficiaries]);
    const total = clusters.reduce((s, c) => s + c.total, 0);
    const winStart = (settings && settings.aggWindowStart) || '00:00';
    const benCount = clusters.filter(c => c.basis === 'beneficiary').length;
    const eftCount = clusters.filter(c => c.kind === regime.wireCode).length;
    const basisPill = (b) => b === 'beneficiary'
      ? <span className="text-[9.5px] px-1.5 py-0.5 font-semibold" style={{ background: '#dbe5fb', color: '#1d4ed8', borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>BY BENEFICIARY</span>
      : <span className="text-[9.5px] px-1.5 py-0.5 font-semibold" style={{ background: CD.lineSoft, color: CD.ink, borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>BY CONDUCTOR</span>;
    const kindPill = (k) => <span className="text-[9.5px] px-1.5 py-0.5 font-semibold" style={{ background: k === regime.wireCode ? '#e7e0f7' : '#f1e3df', color: k === regime.wireCode ? '#6d28d9' : CD.flag, borderRadius: 5, fontFamily: 'Space Mono, monospace' }}>{k}</span>;
    return (<div className="p-4">
      <div className="mb-3"><div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>The 24-hour rule, handled for you <window.CDOS.InfoTip title="The 24-hour rule" body="Several smaller deals from the same person in one day are added up. Once the running total crosses the reporting threshold, it must be reported as if it were one large transaction." lines={[{k:'By conductor',v:'totals what one person brings in'},{k:'By beneficiary',v:'totals what one person is paid — even via different senders'}]} /></div><div className="text-[11px]" style={{ color: CD.mute }}>Someone can stay under the <b style={{ color: CD.ink }}>{fmt(regime.threshold, regime.currency)}</b> reporting line by breaking one big deal into a few smaller ones. So we add up every smaller amount the same person brings in — or sends to the same recipient — across each day (your day runs {regime.aggHours} hours starting <b style={{ color: CD.ink }}>{winStart}</b>). The moment the total reaches {fmt(regime.threshold, regime.currency)}, it has to be reported — and we file it for you: an <b style={{ color: CD.ink }}>{regime.largeCode}</b> for cash, an <b style={{ color: CD.ink }}>{regime.wireCode}</b> for wires. We watch both sides — who paid in <i>and</i> who's being paid — so even three different people quietly funding the same person gets caught.</div></div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-3" style={{ background: clusters.length ? CD.amberSoft : CD.panel, border: `1px solid ${clusters.length ? CD.amber : CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace' }}>Reportable events</div><div className="text-xl font-bold" style={{ color: 'var(--cd-brass-text)' }}>{clusters.length}</div></div>
        <div className="p-3" style={{ background: benCount ? '#eaf0fc' : CD.panel, border: `1px solid ${benCount ? '#1d4ed8' : CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: '#1d4ed8', fontFamily: 'Space Mono, monospace' }}>Caught by beneficiary</div><div className="text-xl font-bold" style={{ color: '#1d4ed8' }}>{benCount}</div></div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Aggregate value</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(total, regime.currency)}</div></div>
      </div>
      <div className="space-y-2">
        {clusters.map(c => {
          const filed = subs[c.id] && subs[c.id].status === 'submitted';
          const isEft = c.kind === regime.wireCode;
          /* What an earlier report over this person's day already covered.
             A filed four-deal aggregate that has since taken a fifth deal
             is NOT filed — it is a new obligation that has to say so, name
             the acknowledgement the first four went under, and offer to
             file the correction. Saying "✓ filed" here over a sealed copy
             that never mentioned the fifth deal is the defect this replaces. */
          const cov = filedCoverage(c.groupId, subs);
          const newRefs = c.txs.filter(t => !cov.refs.has(t.ref));
          const partly = !filed && cov.filings.length > 0 && newRefs.length < c.txs.length;
          const priorAcks = cov.filings.map(f => f.ackNo).filter(Boolean).join(' · ');
          const report = { id: c.id, groupId: c.groupId, kind: c.kind, subject: c.subject, amount: c.total, detail: `${c.txs.length}-deal ${regime.aggHours}h aggregate · by ${c.basis}`, refs: c.txs.map(t => t.ref), basis: c.basis, window: c.windowLabel, windowStart: c.windowStart, windowEnd: c.windowEnd, amendsFilingId: (cov.filings.length && cov.filings[cov.filings.length - 1].filingId) || null, priorAck: priorAcks || null };
          return (
          <div key={c.id} onClick={() => onOpenRefs && onOpenRefs(c.txs.map(t => t.ref), `${c.subject} · ${c.kind}`)} title="Open these records in the Ledger" className="p-3" style={{ background: CD.panel, border: `1px solid ${partly ? CD.flag : c.basis === 'beneficiary' ? '#1d4ed8' : CD.line}`, borderRadius: 11, cursor: 'pointer', transition: 'box-shadow .12s' }} onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 12px var(--cd-hover)'} onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
            <div className="flex items-center justify-between mb-2">
              <div><div className="flex items-center gap-2 flex-wrap"><button onClick={e => { e.stopPropagation(); onOpenClient && onOpenClient(c.subject); }} className="text-[13px] font-semibold text-left hover:underline" style={{ color: CD.ink }} title={`Open ${c.subject}'s profile`}>{c.subject}</button>{kindPill(c.kind)}{basisPill(c.basis)}</div><div className="text-[11px]" style={{ color: CD.mute }}>{c.txs.length} {isEft ? 'transfers' : 'cash-ins'} · window {c.windowLabel}</div></div>
              <div className="text-right"><div className="text-[15px] font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.total, regime.currency)}</div>
                {filed ? <span className="text-[10px] font-semibold" style={{ color: CD.green }}>✓ filed {subs[c.id].ackNo}</span> : <button onClick={e => { e.stopPropagation(); fileReport(report); }} className="text-[11px] font-semibold px-2 py-0.5 mt-0.5" style={{ background: partly ? CD.flag : CD.ink, color: 'var(--cd-on-ink)', borderRadius: 6 }}>File {partly ? 'amended ' : ''}{c.kind} →</button>}
              </div>
            </div>
            {partly && <div className="flex items-start gap-1.5 mb-2 px-2 py-1.5 text-[11px]" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 8, color: CD.flag }}>
              <Ic n="alert" s={13} c={CD.flag} />
              <span><b>{c.txs.length - newRefs.length} of these {c.txs.length}</b> were filed under <b style={{ fontFamily: 'Space Mono, monospace' }}>{priorAcks || 'an earlier report'}</b>. {newRefs.length === 1 ? 'One later deal is' : `${newRefs.length} later deals are`} not on that report — the aggregate now stands at {fmt(c.total, regime.currency)} and needs a correction filed against it.</span>
            </div>}
            {/* a deal already named on an earlier filing is marked, so the
                two new ones in a six-deal cluster are visible at a glance */}
            <div className="flex flex-wrap gap-1.5">{c.txs.map(t => { const done = cov.refs.has(t.ref); return <button key={t.id} onClick={e => { e.stopPropagation(); if (isEft) { onOpenTransfers && onOpenTransfers(); } else { onOpenTransaction && onOpenTransaction(t.id); } }} title={done ? 'Already named on an earlier filing' : (isEft ? 'Open in Transfers' : 'Open this record in the Ledger')} className="text-[10.5px] px-2 py-0.5" style={{ background: done ? CD.greenSoft : 'var(--cd-chip)', borderRadius: 6, color: done ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace', cursor: 'pointer', border: 'none' }}>{done ? '✓ ' : ''}{t.ref} · {num(t.amt)} {settings.baseCurrency || regime.currency} · {t.time}{c.basis === 'beneficiary' ? ' · ' + t.customer : ''}</button>; })}</div>
          </div>); })}
        {!clusters.length && <div className="text-center py-12" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="checkcircle" s={24} c={CD.green} /><div className="mt-2 text-[13px]">No {regime.aggHours}-hour aggregates over {fmt(regime.threshold, regime.currency)}.</div></div>}
      </div>
    </div>);
  }

  /* ===================== STRUCTURING WATCH ===================== */
  /* The 24h rule catches deals that DO cross the line. Structuring is the
     opposite tell: many deals deliberately kept JUST under it. We surface the
     pattern per person so the owner can review it and, where it looks
     deliberate, escalate to a suspicious-transaction report. */
  function StructuringWatch({ rows, setRows, clients, settings, me, log, subs, fileReport, onOpenRefs, onOpenClient }) {
    const regime = getRegime(settings);
    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    const win = (settings && +settings.structuringDays) || 7;
    const stamp2 = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');

    // group every structuring-flagged row by customer into one watch case
    const cases = useMemo(() => {
      const m = new Map();
      rows.forEach(r => {
        const f = flags[r.id]; if (!f || f.void || !f.str) return;
        const e = m.get(r.customer) || { customer: r.customer, txs: [], agg: 0, open: 0, lastDate: '' };
        e.txs.push(r); e.agg = Math.max(e.agg, f.agg || 0);
        if (!r.ackStr) e.open += 1;
        if ((r.date || '') > e.lastDate) e.lastDate = r.date || '';
        m.set(r.customer, e);
      });
      return [...m.values()].map(e => ({
        ...e,
        /* Structuring is splitting CASH to stay under the cash line, so
           these totals count cash and not deal size — same rule as the
           `str` flag they are describing. */
        sum: e.txs.reduce((s, t) => s + cashIn(t), 0),
        avg: e.txs.length ? e.txs.reduce((s, t) => s + cashIn(t), 0) / e.txs.length : 0,
        pct: regime.threshold ? (e.txs.reduce((s, t) => s + cashIn(t), 0) / e.txs.length) / regime.threshold : 0,
        acked: e.open === 0,
      })).sort((a, b) => (a.acked - b.acked) || (b.agg - a.agg));
    }, [rows, flags, regime]);

    const openCases = cases.filter(c => !c.acked);
    /* An STR is about a PATTERN, and a pattern that has taken on two more
       deals is a different pattern. The obligation used to be identified by
       the customer's name alone, so a second, larger case about the same
       person landed on top of the first report and deleted it — two
       submissions to the regulator, two acknowledgement numbers, one local
       record. The person is what the two share, so the person is the group
       and the deals in the pattern are the identity. */
    const strGroup = (cust) => 'STR-' + cust;
    const strId = (c) => strGroup(c.customer) + '-' + C.setFingerprint(c.txs.map(t => t.ref));
    const fileStr = (c) => {
      const cov = filedCoverage(strGroup(c.customer), subs);
      return fileReport && fileReport({ id: strId(c), groupId: strGroup(c.customer), kind: regime.strCode, subject: c.customer, amount: c.sum, detail: `${c.txs.length}-deal structuring pattern`, refs: c.txs.map(t => t.ref), basis: 'structuring', amendsFilingId: (cov.filings.length && cov.filings[cov.filings.length - 1].filingId) || null });
    };
    const ackCustomer = (cust) => { setRows(rs => rs.map(r => (r.customer === cust && (flags[r.id] || {}).str && !r.ackStr) ? { ...r, ackStr: true, ackStrInfo: { by: me.name, at: stamp2() } } : r)); log && log('Structuring reviewed', `${cust} cleared in Structuring Watch`); };
    const reopenCustomer = (cust) => { setRows(rs => rs.map(r => (r.customer === cust && (flags[r.id] || {}).str && r.ackStr) ? { ...r, ackStr: false, ackStrInfo: null } : r)); log && log('Structuring watch reopened', `${cust}`); };

    return (<div className="p-4">
      <div className="mb-3"><div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: CD.ink }}>Structuring watch <window.CDOS.InfoTip title="What is structuring?" body="Structuring is breaking one big transaction into several smaller ones to stay under the reporting line. No single deal is reportable on its own — the pattern is the red flag. Review each case; where it looks deliberate, file a suspicious-transaction report." lines={[{k:'Window',v:`${win}-day rolling`},{k:'Line',v:fmt(regime.threshold, regime.currency)},{k:'Escalate to',v:regime.strCode}]} /></div><div className="text-[11px]" style={{ color: CD.mute, maxWidth: 600 }}>People who keep landing <i>just under</i> {fmt(regime.threshold, regime.currency)} — many small cash deals over a {win}-day window that add up past the line without any one tripping it. This isn't an automatic filing; it's a <b style={{ color: CD.ink }}>judgement call</b>. Review each case, then either clear it or escalate to a <b style={{ color: CD.ink }}>{regime.strCode}</b>.</div></div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-3" style={{ background: openCases.length ? CD.amberSoft : CD.panel, border: `1px solid ${openCases.length ? CD.amber : CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--cd-brass-text)', fontFamily: 'Space Mono, monospace' }}>Open cases</div><div className="text-xl font-bold" style={{ color: 'var(--cd-brass-text)' }}>{openCases.length}</div></div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>People watched</div><div className="text-xl font-bold" style={{ color: CD.ink }}>{cases.length}</div></div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Window</div><div className="text-xl font-bold" style={{ color: CD.ink }}>{win}<span className="text-[12px] font-medium" style={{ color: CD.mute }}> days</span></div></div>
      </div>

      <div className="space-y-2">
        {cases.map(c => (
          <div key={c.customer} className="p-3" style={{ background: CD.panel, border: `1px solid ${c.acked ? CD.line : CD.amber}`, borderRadius: 11 }}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: c.acked ? CD.lineSoft : CD.amberSoft }}><Ic n={c.acked ? 'check' : 'alert'} s={16} c={c.acked ? CD.mute : CD.amber} /></span>
                <div className="min-w-0"><button onClick={() => onOpenClient && onOpenClient(c.customer)} className="text-[13px] font-semibold text-left hover:underline truncate" style={{ color: CD.ink }} title={`Open ${c.customer}'s profile`}>{c.customer}</button><div className="text-[11px]" style={{ color: CD.mute }}>{c.txs.length} just-under deals · avg {Math.round(c.pct * 100)}% of line · last {c.lastDate}</div></div>
              </div>
              <div className="text-right flex-none"><div className="text-[15px] font-bold" style={{ color: c.acked ? CD.mute : 'var(--cd-brass-text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(c.agg, regime.currency)}</div><div className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{win}-day total</div></div>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2">
              {c.txs.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(t => (
                <span key={t.id} className="text-[10.5px] px-2 py-0.5" style={{ background: 'var(--cd-chip)', borderRadius: 6, color: CD.mute, fontFamily: 'Space Mono, monospace' }} title={`${t.ref} · ${t.type}`}>{t.date.slice(5)} · {num(t.inAmt)} {t.inCcy}</span>))}
            </div>

            <div className="flex items-center gap-2 pt-2" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              {(() => {
                const sub = subs && subs[strId(c)];
                const filed = sub && sub.status === 'submitted';
                // an earlier STR about this person, over a smaller pattern
                const prior = filed ? null : filedCoverage(strGroup(c.customer), subs).filings.slice(-1)[0];
                return (<>
                {filed
                  ? <span className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: CD.flag }}><Ic n="lock" s={13} c={CD.flag} /> {regime.strCode} filed · {sub.ackNo}</span>
                  : prior
                    ? <span className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: CD.flag }}><Ic n="alert" s={13} c={CD.flag} /> {regime.strCode} {prior.ackNo} covered an earlier, smaller pattern — this one needs a correction filed</span>
                  : c.acked
                    ? <span className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: CD.green }}><Ic n="check" s={13} c={CD.green} /> Reviewed — no STR filed</span>
                    : <span className="text-[11px] font-medium" style={{ color: 'var(--cd-brass-text)' }}>{c.open} of {c.txs.length} deal{c.txs.length === 1 ? '' : 's'} unreviewed</span>}
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => onOpenRefs && onOpenRefs(c.txs.map(t => t.ref), `${c.customer} · structuring`)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: CD.panel }}><Ic n="search" s={12} c={CD.mute} /> View records</button>
                  {!filed && (c.acked
                    ? <button onClick={() => reopenCustomer(c.customer)} className="px-2.5 py-1.5 text-[11.5px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.mute, background: CD.panel }}>Reopen</button>
                    : <button onClick={() => ackCustomer(c.customer)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: CD.panel }}><Ic n="check" s={12} c={CD.mute} /> Mark reviewed</button>)}
                  {/* "Re-file" was the wrong word and the wrong act: it
                      replaced the sealed copy. A correction is filed as a
                      new, linked report and the original stays retrievable. */}
                  <window.CDOS.CommitBtn onCommit={() => fileStr(c)} stage delay={520} icon="filetext" label={`File ${filed || prior ? 'amended ' : ''}${regime.strCode} →`} armLabel="Filing…" doneLabel="Opening…" title={filed || prior ? `File a correction to ${regime.strCode} ${(sub || prior).ackNo}, linked to it` : `Generate a ${regime.strLabel} for ${c.customer}`} style={{ padding: '0.4rem 0.85rem', fontSize: '11.5px', borderRadius: 7 }} />
                </div>
              </>); })()}
            </div>
          </div>))}
        {!cases.length && <div className="text-center py-12" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="checkcircle" s={24} c={CD.green} /><div className="mt-2 text-[13px]">No structuring patterns detected — no one is sitting just under {fmt(regime.threshold, regime.currency)}.</div></div>}
      </div>
    </div>);
  }

  /* ===================== SUBMISSIONS (worksheet → sealed filing) ===================== */
  function refHash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; } return h.toString(36).toUpperCase().padStart(5, '0').slice(-5); }
  function Submissions({ rows, clients, settings, me, log, subs, beneficiaries, openWorksheet, mkReport, store, openFilingCopy }) {
    const regime = getRegime(settings);
    const flags = useMemo(() => computeFlags(rows, clients, settings), [rows, clients, settings]);
    const ctx = useMemo(() => ({ settings, clients, rows, regime }), [settings, clients, rows]);

    const reportables = useMemo(() => {
      // canonical single + 24h-aggregate obligations (cash & wire) — shared with the OS badge
      const out = computeReportables(rows, clients, settings, beneficiaries, subs);
      /* Filings the obligation list cannot rebuild: discretionary STRs, and
         anything filed on a day whose transactions this browser has not
         loaded — which is every filing made at the other till. They are
         still filings, so they belong on this page. */
      Object.keys(subs || {}).forEach(id => { const s = subs[id]; if (s && s.status === 'submitted' && !out.some(o => o.id === id)) { const seal = s.sealed || {}; out.push({ id, groupId: s.groupId || id, kind: s.kind || regime.strCode, subject: seal.subject || s.subject || id.replace(/^STR-/, '').replace(/-[0-9A-Z]{6}$/, ''), amount: seal.amount != null ? seal.amount : (s.amount || 0), detail: s.kind === regime.strCode ? 'Suspicious transaction report' : 'Filed report', date: (s.submittedAt || '').slice(0, 10), refs: seal.refs || s.refs || [], basis: 'structuring', reportRef: (seal.reportRef) || reportRefFor(s.kind || regime.strCode, id) }); } });
      return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }, [rows, clients, settings, beneficiaries, subs]);

    const drafts = reportables.filter(r => !(subs[r.id] && subs[r.id].status === 'submitted'));
    const filedAll = reportables.filter(r => subs[r.id] && subs[r.id].status === 'submitted');
    // Filed records stay on this page for 30 days, then archive to Compliance ▸ History (where they live permanently).
    const ageDays = (s) => { try { const d = window.CDOS.dDiff(((s && s.submittedAt) || '').slice(0, 10), TODAY); return isNaN(d) ? 0 : d; } catch (e) { return 0; } };
    const filed = filedAll.filter(r => ageDays(subs[r.id]) <= 30);
    const archivedCount = filedAll.length - filed.length;

    const reopen = (r) => { const sub = subs[r.id]; openWorksheet({ ...r, prompts: (sub && sub.prompts) || {}, ticks: (sub && sub.ticks) || {} }); };
    /* The sealed copy. The ledger's version is preferred over this browser's
       cached one, because the ledger's is the record and because that is what
       makes a filing readable on a machine that was not the one it was filed
       from. Only a filing this desk has no server copy of falls back to
       reconstructing the form from today's records — and a reconstruction is
       not the report that was filed, which is why it is the last resort. */
    const viewSealed = (r) => {
      const sub = subs[r.id];
      if (sub && sub.filingId && openFilingCopy) { openFilingCopy(sub, ctx); return; }
      if (sub && sub.sealed) { window.CDOS.LCTR.openSealed(sub.sealed, ctx); return; }
      const blocks = window.CDOS.LCTR.buildMap(r, ctx);
      const prompts = (sub && sub.prompts) || {};
      const map = blocks.map(b => ({ ...b, instances: b.instances.map((inst, ii) => ({ ...inst, fields: (inst.fields || []).map(f => f.divider ? f : (f.prompt ? { ...f, value: (prompts[`${b.key}.${ii}.${f.id}`] || '').trim(), filledByTeller: true } : f)) })) }));
      const filing = { reportId: r.id, kind: r.kind, kindLabel: window.CDOS.LCTR.kindLabelOf(r.kind, regime), reportRef: r.reportRef, subject: r.subject, amount: r.amount, refs: r.refs, basis: r.basis || null, fwrReceipt: (sub && sub.ackNo) || '—', filedBy: (sub && sub.by) || '—', filedAt: (sub && sub.submittedAt) || '—', map };
      window.CDOS.LCTR.openSealed(filing, ctx);
    };
    const KindTag = ({ k }) => <span className="text-[10px] px-1.5 py-0.5 font-semibold" style={{ background: k === regime.wireCode ? '#dbe5fb' : (k === regime.strCode ? CD.amberSoft : CD.flagSoft), color: k === regime.wireCode ? '#1d4ed8' : (k === regime.strCode ? 'var(--cd-brass-text)' : CD.flag), borderRadius: 4, fontFamily: 'Space Mono' }}>{k}</span>;

    return (<div className="p-4">
      <div className="mb-4">
        <div className="text-sm font-semibold" style={{ color: CD.ink }}>Filings</div>
        <div className="text-[11px]" style={{ color: CD.mute, maxWidth: 560 }}>Each reportable opens a <b style={{ color: CD.ink }}>filing worksheet</b> — every FWR field in form order, pre-filled, with only the point-of-sale questions left blank. Key it into your own FWR login, paste the acknowledgement back, and it <b style={{ color: CD.ink }}>seals into an immutable filed copy</b> welded to the records that triggered it.</div>
      </div>

      {/* Where the sealed copies actually are. Stated rather than assumed:
          a five-year record held in one browser is not a record, and a desk
          is entitled to know which of the two it has before it files. */}
      {store === 'server' && <div className="flex items-center gap-2 mb-3 px-3 py-2 text-[11.5px]" style={{ background: CD.greenSoft, border: `1px solid ${CD.green}`, borderRadius: 9, color: CD.green }}>
        <Ic n="lock" s={14} c={CD.green} />
        <span>Filed copies are held on the ledger, for this business — every till sees the same set, and they survive this browser.</span>
      </div>}
      {store === 'local' && <div className="flex items-start gap-2 mb-3 px-3 py-2 text-[11.5px]" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 9, color: CD.flag }}>
        <Ic n="alert" s={14} c={CD.flag} />
        <span><b>This desk has no ledger connection, so a sealed copy is held in this browser only.</b> Clearing site data, a private window or a different machine loses it, and the other till has its own separate set — keep your own copy of anything you file until the ledger is connected.</span>
      </div>}

      {/* NEEDS FILING */}
      <div className="flex items-center gap-2 mb-2"><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Needs filing</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: drafts.length ? CD.amber : CD.lineSoft, color: drafts.length ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 999, fontFamily: 'Space Mono' }}>{drafts.length}</span></div>
      <div className="space-y-1.5 mb-5">
        {drafts.map(r => { const note = coverageNote(r); return (
          <div key={r.id} className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${note ? CD.flag : CD.line}`, borderRadius: 11 }}>
            <div className="flex-1 min-w-0"><div className="flex items-center gap-2"><KindTag k={r.kind} /><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{r.subject}</span><span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>{r.reportRef}</span></div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>{r.detail} · {fmt(r.amount, regime.currency)}</div>
              {/* the sentence a desk needed and did not get */}
              {note && <div className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: CD.flag }}><Ic n="alert" s={11} c={CD.flag} /> {note}</div>}
            </div>
            <button onClick={() => reopen(r)} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold text-white flex-none" style={{ background: note ? CD.flag : CD.ink, borderRadius: 8 }}><Ic n="filetext" s={14} c="var(--cd-on-ink)" /> {note ? 'Open correction' : 'Open worksheet'}</button>
          </div>); })}
        {!drafts.length && <div className="text-center py-8 text-[12px]" style={{ border: `1px dashed ${CD.line}`, borderRadius: 11, color: CD.faint }}>Nothing awaiting filing.</div>}
      </div>

      {/* FILED RECORDS */}
      <div className="flex items-center gap-2 mb-2"><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Filed records</span><span className="text-[10px] px-1.5 py-0.5" style={{ background: filed.length ? CD.green : CD.lineSoft, color: filed.length ? 'var(--cd-on-ink)' : CD.mute, borderRadius: 999, fontFamily: 'Space Mono' }}>{filed.length}</span><span className="text-[10.5px]" style={{ color: CD.faint }}>last 30 days</span><window.CDOS.InfoTip title="Filed records" body="Sealed filings stay here for 30 days for quick access, then move to Compliance ▸ History where they’re kept permanently. Nothing is ever deleted." />{archivedCount > 0 && <span className="text-[10.5px] flex items-center gap-1 ml-auto" style={{ color: CD.mute }}><Ic n="scroll" s={12} c={CD.mute} /> {archivedCount} older filing{archivedCount === 1 ? '' : 's'} archived to History</span>}</div>
      <div className="space-y-1.5">
        {filed.map(r => { const sub = subs[r.id]; return (
          <div key={r.id} className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${CD.greenSoft}`, borderRadius: 11 }}>
            <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: CD.greenSoft }}><Ic n="lock" s={14} c={CD.green} /></span>
            <div className="flex-1 min-w-0"><div className="flex items-center gap-2"><KindTag k={r.kind} /><span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{r.subject}</span><span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>{r.reportRef}</span>{sub.amendsFilingId && <span className="text-[9px] px-1.5 py-0.5 font-semibold" style={{ background: CD.amberSoft, color: 'var(--cd-brass-text)', borderRadius: 4, fontFamily: 'Space Mono' }}>CORRECTION</span>}{sub.amendedByFilingId && <span className="text-[9px] px-1.5 py-0.5 font-semibold" style={{ background: CD.lineSoft, color: CD.mute, borderRadius: 4, fontFamily: 'Space Mono' }}>SUPERSEDED</span>}</div><div className="text-[11px] mt-0.5" style={{ color: CD.mute }}>Sealed · FWR <b style={{ color: CD.green, fontFamily: 'Space Mono' }}>{sub.ackNo}</b> · {sub.by} · {sub.submittedAt}</div></div>
            <button onClick={() => viewSealed(r)} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}><Ic n="printer" s={14} /> Sealed PDF</button>
          </div>); })}
        {!filed.length && <div className="text-center py-8 text-[12px]" style={{ border: `1px dashed ${CD.line}`, borderRadius: 11, color: CD.faint }}>No filed records yet — they appear here, sealed, once you file.</div>}
      </div>
    </div>);
  }

  /* ===================== JURISDICTION (read-only — set in owner Settings) ===================== */
  function Regime({ settings, me, onOpenSettings }) {
    const active = (settings && settings.regime) || 'FINTRAC';
    const isOwner = me && me.role === 'Owner';
    return (<div className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Active jurisdiction</div><div className="text-[11px]" style={{ color: CD.mute, maxWidth: 460 }}>Thresholds, the aggregation window, report types, terminology and the fileable format all follow your regulator. This is set once when the business is configured — the desk only reads it here.</div></div>
        <button onClick={() => onOpenSettings && onOpenSettings()} className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="gear" s={14} /> {isOwner ? 'Change in Settings' : 'View in Settings'}</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-2.5">
        {Object.values(REGIMES).map(r => { const on = active === r.id; return (
          <div key={r.id} className="text-left p-3.5" style={{ background: on ? 'var(--cd-chip)' : CD.panel, border: `1px solid ${on ? CD.ink : CD.line}`, borderRadius: 12, opacity: on ? 1 : 0.55 }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2"><span style={{ fontSize: 22 }}>{r.flag}</span><div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{r.authority}</div><div className="text-[11px]" style={{ color: CD.mute }}>{r.country}</div></div></div>
              {on ? <span className="text-[10px] px-2 py-0.5 font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 999 }}>ACTIVE</span> : <span className="text-[10px] px-2 py-0.5" style={{ border: `1px solid ${CD.line}`, color: CD.faint, borderRadius: 999 }}>not active</span>}
            </div>
            <div className="grid grid-cols-2 gap-y-1 text-[11.5px]" style={{ color: CD.mute }}>
              <span>Threshold</span><span className="text-right" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.threshold, r.currency)}</span>
              <span>Aggregation</span><span className="text-right" style={{ color: CD.ink }}>{r.aggHours}h rolling</span>
              <span>Large cash</span><span className="text-right" style={{ color: CD.ink }}>{r.largeCode}</span>
              <span>Wire</span><span className="text-right" style={{ color: CD.ink }}>{r.wireCode}</span>
              <span>Suspicious</span><span className="text-right" style={{ color: CD.ink }}>{r.strCode}</span>
              <span>Watchlists</span><span className="text-right" style={{ color: CD.ink }}>{r.watchlists.join(' · ')}</span>
              <span>Fileable</span><span className="text-right" style={{ color: CD.ink }}>{r.fileFormat}</span>
            </div>
          </div>); })}
      </div>
      <div className="mt-3 p-3 text-[11px] flex items-start gap-2" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 9 }}><Ic n="lock" s={13} c={CD.brass} /><span>Locked configuration. Switching regulator re-bases the entire AML engine, so it lives in <b>Settings ▸ Compliance &amp; jurisdiction</b> and is owner-only.</span></div>
    </div>);
  }

  /* ===================== ROOT ===================== */
  function Compliance({ rows, setRows, clients, setClients, beneficiaries, settings, setSettings, me, log, baseline, receipts, day, station, branches, onOpenSettings, onOpenTransaction, onOpenClient, onOpenRefs, onOpenTransfers, fileSignal, subs: subsProp, setSubs: setSubsProp }) {
    const [tab, setTab] = useState('screening');
    // Sealed filings (subs) are owned by the OS shell when present, so the menu-bar
    // compliance badge updates the instant a report seals here. Falls back to local
    // state + persistence when Compliance is mounted on its own.
    const [subsLocal, setSubsLocal] = useState(loadSubs);
    const subs = subsProp || subsLocal;
    const setSubs = setSubsProp || setSubsLocal;
    const [worksheet, setWorksheet] = useState(null);
    const lastFileSig = useRef(0);
    useEffect(() => { if (!setSubsProp) { try { localStorage.setItem(SUBKEY, JSON.stringify(subs)); } catch (e) {} } }, [subs, setSubsProp]);
    const regime = getRegime(settings);
    const ctx = useMemo(() => ({ settings, clients, rows, regime }), [settings, clients, rows]);

    const refHash2 = (id) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36).toUpperCase().padStart(5, '0').slice(-5); };
    // open the filing worksheet for a report (from Aggregation or Submissions)
    const openWorksheet = (r) => { const reportRef = r.reportRef || `${r.kind}-${(TODAY || '').slice(0, 4)}-${refHash2(r.id)}`; setWorksheet({ ...r, reportRef }); setTab('submissions'); };
    // external request (from the Ledger's File-LCTR buttons) to open the worksheet
    useEffect(() => { if (fileSignal && fileSignal.n && fileSignal.n !== lastFileSig.current) { lastFileSig.current = fileSignal.n; const rep = fileSignal.report; const sub = subs[rep.id]; openWorksheet({ ...rep, prompts: (sub && sub.prompts) || {}, ticks: (sub && sub.ticks) || {} }); } }, [fileSignal]);

    /* Which of the two stores this desk is on. Probed once by asking the
       ledger for its filings: an answer means the ledger is the record and
       the local map is a cache of it; a refusal (no ledger on this plan, no
       ledger at all in a demonstration) means the browser is all there is,
       and the Filings page says so rather than letting the sealed PDF's
       "retain 5 years" stand over a copy nobody can retain. */
    const [store, setStore] = useState('unknown');
    useEffect(() => {
      const api = filingsApi();
      if (!api) { setStore('local'); return; }
      let cancelled = false;
      api.loadReportFilings()
        .then(result => {
          if (cancelled) return;
          setStore('server');
          const seen = {};
          // newest first from the server, so the first sighting of an
          // obligation is its current filing and later ones are its history
          (result.filings || []).forEach(f => {
            const key = f.obligationId || f.filingId;
            if (!seen[key]) seen[key] = subFromFiling(f);
          });
          setSubs(s => {
            const next = { ...s };
            Object.keys(seen).forEach(key => {
              // keep the local sealed snapshot and worksheet answers where
              // this browser filed it — the ledger holds the payload too,
              // but the cached copy opens without a round trip
              next[key] = Object.assign({}, next[key], seen[key]);
            });
            return next;
          });
        })
        .catch(() => { if (!cancelled) setStore('local'); });
      return () => { cancelled = true; };
    }, []);

    /* Seal a filled worksheet into a filed record.
       The ledger first: if it refuses, nothing is sealed and the worksheet
       says why. A local "sealed" copy the record does not know about is the
       defect, not the fallback. */
    const onSeal = async ({ map, prompts, ticks, fwrReceipt }) => {
      const r = worksheet;
      const kindLabel = window.CDOS.LCTR.kindLabelOf(r.kind, regime);
      /* What this report corrects, printed on the sealed copy itself. An
         examiner holding two reports about the same person on the same day
         should not have to work out which is which from the timestamps. */
      const priorAck = r.priorAck || ((r.priorFilings || []).map(f => f.ackNo).filter(Boolean).join(' · ')) || null;
      const filing = { reportId: r.id, groupId: r.groupId || r.id, kind: r.kind, kindLabel, reportRef: r.reportRef, subject: r.subject, amount: r.amount, refs: r.refs, basis: r.basis || null, amendsAck: priorAck, fwrReceipt, filedBy: me.name, filedAt: stamp(), map };
      let filingId = null, amendsFilingId = r.amendsFilingId || null, amendedBy = null;

      const api = filingsApi();
      if (api && store !== 'local') {
        const sealed = await api.fileReport({
          reportCode: r.kind,
          obligationId: r.id,
          obligationGroupId: r.groupId || r.id,
          reportRef: r.reportRef,
          subjectName: r.subject,
          reportedAmount: r.amount == null ? null : Number(r.amount).toFixed(2),
          reportedCurrency: regime.currency,
          transactionRefs: r.refs || [],
          aggregationBasis: r.basis || null,
          windowStart: r.windowStart || null,
          windowEnd: r.windowEnd || null,
          acknowledgementRef: fwrReceipt,
          // every field AS SUBMITTED, plus the answers behind it, so the
          // ledger's copy can be re-opened without this browser
          payload: { filing, prompts, ticks },
          amendsFilingId: amendsFilingId,
        });
        filingId = sealed.filingId;
        amendsFilingId = sealed.amendsFilingId || null;
        amendedBy = sealed.amendedByFilingId || null;
      }

      setSubs(s => ({ ...s, [r.id]: { status: 'submitted', ackNo: fwrReceipt, submittedAt: stamp(), kind: r.kind, by: me.name, channel: 'FWR', sealed: filing, prompts, ticks, filingId, amendsFilingId, amendedByFilingId: amendedBy, groupId: r.groupId || r.id, refs: r.refs || [], subject: r.subject, amount: r.amount, server: !!filingId } }));
      // and into the universal report History, which is a cache too
      pushFilingHistory({ filing, kindLabel, regime, ctx, serverBacked: !!filingId, log });
      log && log(`${r.kind} filed & sealed`, `${r.subject} · FWR ${fwrReceipt} · ${r.reportRef}${amendsFilingId ? ' · correction, linked to the earlier filing' : ''}`);
      setWorksheet(null);
    };

    /* Open a filed copy. Preferring the ledger's payload over the cached one
       is what makes a filing readable from a machine that never filed it —
       and is the assertion worth making out loud, because the previous
       design could not do it at all. */
    const openFilingCopy = (sub, viewCtx) => {
      const api = filingsApi();
      if (!api || !sub.filingId) { if (sub.sealed) window.CDOS.LCTR.openSealed(sub.sealed, viewCtx); return; }
      api.loadReportFiling(sub.filingId)
        .then(f => {
          const held = (f.payload && f.payload.filing) || null;
          window.CDOS.LCTR.openSealed(held || sub.sealed, viewCtx);
        })
        .catch(error => {
          log && log('Filed copy unavailable', error.message || 'The ledger did not return that filing');
          if (sub.sealed) window.CDOS.LCTR.openSealed(sub.sealed, viewCtx);
        });
    };

    // header counts
    const screenFlagged = useMemo(() => { if (settings && settings.screenSanctions === false) return 0; let n = 0; Object.keys(clients || {}).forEach(name => { if (screen(name).status !== 'clear') n++; }); (beneficiaries || []).forEach(b => { if (screen(b.name).status !== 'clear') n++; }); return n; }, [clients, beneficiaries, settings]);
    const aggN = useMemo(() => aggClusters(rows, regime, settings).length + aggClustersEFT(loadTransfers(), beneficiaries, regime, settings).length, [rows, settings, beneficiaries]);
    const draftN = useMemo(() => openReportables(rows, clients, settings, beneficiaries, subs).length, [rows, clients, settings, beneficiaries, subs]);

    const strN = useMemo(() => { const flags = computeFlags(rows, clients, settings); const s = new Set(); rows.forEach(r => { const f = flags[r.id] || {}; if (f.str && !f.void && !r.ackStr) s.add(r.customer); }); return s.size; }, [rows, clients, settings]);

    const TABS = [['screening', 'Screening', 'shield', screenFlagged], ['aggregation', `${regime.aggHours}h aggregation`, 'clock', aggN], ['submissions', 'Filings', 'filetext', draftN], ['structuring', 'Structuring watch', 'alert', strN], ['reports', 'Reports', 'bars', 0], ['history', 'History', 'scroll', 0], ['regime', 'Jurisdiction', 'globe', 0]];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="complianceshield" s={16} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Compliance</div><div className="text-[11px]" style={{ color: CD.mute }}>{regime.flag} {regime.authority} · {fmt(regime.threshold, regime.currency)} threshold</div></div>
          </div>
        </div>
        {/* headline risk trio — mirrors the Dashboard's Compliance tiles so the two never disagree */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          {[['Reportable', draftN, 'Filings due', 'submissions', CD.flag], ['Structuring', strN, 'Patterns to watch', 'structuring', CD.amber], ['Screening', screenFlagged, 'Sanctions hits', 'screening', CD.flag]].map(([l, v, sub, go, warn]) => { const bad = v > 0; const col = bad ? warn : CD.green; return (
            <button key={l} onClick={() => setTab(go)} className="text-left px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${bad ? col : CD.line}`, borderRadius: 11, transition: 'border-color .12s, box-shadow .12s' }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 6px 16px -12px var(--cd-shade)'; }} onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; }}>
              <div className="flex items-center justify-between"><span className="text-[9.5px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</span><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} /></div>
              <div className="font-bold" style={{ color: col, fontVariantNumeric: 'tabular-nums', fontSize: 24, lineHeight: 1.15 }}>{v}</div>
              <div className="text-[10.5px]" style={{ color: CD.mute }}>{sub}</div>
            </button>); })}
        </div>
        <div className="fld-bar" style={{ '--ft': '#6B2E54', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic, badge]) => (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: id === 'screening' ? CD.flag : CD.amber, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'screening' && <Screening clients={clients} setClients={setClients} beneficiaries={beneficiaries} me={me} settings={settings} onOpenSettings={onOpenSettings} />}
        {tab === 'aggregation' && <Aggregation rows={rows} settings={settings} subs={subs} fileReport={openWorksheet} beneficiaries={beneficiaries} onOpenTransaction={onOpenTransaction} onOpenClient={onOpenClient} onOpenRefs={onOpenRefs} onOpenTransfers={onOpenTransfers} />}
        {tab === 'submissions' && <Submissions rows={rows} clients={clients} settings={settings} me={me} log={log} subs={subs} beneficiaries={beneficiaries} openWorksheet={openWorksheet} store={store} openFilingCopy={openFilingCopy} />}
        {tab === 'structuring' && <StructuringWatch rows={rows} setRows={setRows} clients={clients} settings={settings} me={me} log={log} subs={subs} fileReport={openWorksheet} onOpenRefs={onOpenRefs} onOpenClient={onOpenClient} />}
        {tab === 'reports' && (window.CDOS.Reports ? <window.CDOS.Reports rows={rows} clients={clients} settings={settings} me={me} baseline={baseline} receipts={receipts} day={day} station={station} branches={branches} /> : null)}
        {tab === 'history' && (window.CDOS.ReportHistory ? <window.CDOS.ReportHistory /> : null)}
        {tab === 'regime' && <Regime settings={settings} me={me} onOpenSettings={onOpenSettings} />}
      </div>
      {worksheet && <window.CDOS.LCTR.Worksheet report={worksheet} ctx={ctx} onFile={onSeal} onClose={() => setWorksheet(null)} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Compliance, computeReportables, openReportables });
})();
