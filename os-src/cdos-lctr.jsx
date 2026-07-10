/* ============================================================
   CurrencyDesk OS — LCTR / EFTR filing
   Two faces of one immutable record:
     • FACE 1 — Filing Worksheet: every FWR field in form order,
       pre-filled from CONFIG (set once) · LEDGER (the transaction)
       · KYC (the client) · ENGINE (aggregation type, the static
       24h window, the unique reference numbers). The only blanks
       are the handful of point-of-sale PROMPTs. Copy-to-clipboard
       on each field — a teleprompter the owner reads down into
       their own FWR login.
     • FACE 2 — Filed Record: the moment it's marked filed and the
       FWR acknowledgement is pasted back, the worksheet freezes
       into a sealed PDF — every field as submitted, stamped with
       the report reference, submission timestamp, who filed it,
       the FWR receipt, and a link back to the ledger record(s)
       and client(s) that triggered it. Immutable. The 5-year copy.

   Two format traps hard-coded:
     1. time = HH:MM:SS±ZZ:ZZ (UTC offset) everywhere.
     2. foreign cash reported in ORIGINAL currency on the action
        amounts — CAD conversion is used only to test the $10k line.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt, num } = window.CDOS;
  const C = window.CDOS._compliance;
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  /* ---------- format helpers ---------- */
  // UTC-offset string for a business timezone, e.g. "-05:00"
  function tzOffset(d, tz) {
    try {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Toronto', timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value;
      const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(s);
      if (!m) return '+00:00';
      return `${m[1]}${String(+m[2]).padStart(2, '0')}:${m[3] || '00'}`;
    } catch (e) {
      const o = -d.getTimezoneOffset(), sign = o >= 0 ? '+' : '-', a = Math.abs(o);
      return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    }
  }
  // FWR datetime: "YYYY-MM-DD HH:MM:SS±ZZ:ZZ"
  function fmtDateTime(date, time, tz) {
    const t = (time || '00:00').length === 5 ? (time + ':00') : (time || '00:00:00');
    const d = new Date((date || '') + 'T' + ((time || '00:00').length === 5 ? time : (time || '00:00')) + ':00');
    return `${date} ${t}${tzOffset(isNaN(d) ? new Date() : d, tz)}`;
  }
  function fmtWindowEdge(iso, tz) {
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tzOffset(d, tz)}`;
  }
  // surname / given / other from a single stored name
  function nameParts(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { surname: '', given: '', other: '' };
    if (parts.length === 1) return { surname: parts[0], given: 'XXX', other: '' };
    return { surname: parts[parts.length - 1], given: parts[0], other: parts.slice(1, -1).join(' ') };
  }
  const fullAddr = (rec) => [rec.address, rec.city, rec.province, rec.postal, (rec.country && rec.country !== 'Canada') ? rec.country : ''].filter(Boolean).join(', ');

  /* ---------- field map (FWR form order) ----------
     Returns ordered blocks; each block has instances (1, or repeat per txn);
     each field: { id, label, cat, source, value, prompt, hint, missing } */
  // human label for a report kind under the active regime
  function kindLabelOf(kind, regime) {
    if (kind === regime.largeCode) return regime.largeLabel;
    if (kind === regime.wireCode) return regime.wireLabel;
    if (kind === regime.strCode) return regime.strLabel;
    return kind;
  }

  function buildMap(report, ctx) {
    const { settings, clients, rows, regime } = ctx;
    const tz = (settings && settings.timezone) || 'America/Toronto';
    const TH = regime.threshold;
    const cur = regime.currency;
    const isWire = report.kind === regime.wireCode;
    // resolve source records (cash transactions). Transfers degrade gracefully.
    const txns = (report.refs || []).map(ref => (rows || []).find(r => r.ref === ref)).filter(Boolean);
    const cadIn = (r) => r.inCcy === cur ? (Number(r.inAmt) || 0) : (Number(r.inAmt) || 0) / (window.CDOS.crossRate(cur, r.inCcy) || 1);

    const F = (id, label, cat, source, value, opts = {}) => {
      const has = value != null && String(value).trim() !== '';
      // only a mandatory (*) / mandatory-for-processing (‡) empty blocks filing
      const missing = !opts.prompt && source !== 'ENGINE' && !has && (cat === '*' || cat === '‡');
      return { id, label, cat, source, value: has ? String(value) : '', prompt: !!opts.prompt, hint: opts.hint || '', missing };
    };
    const partyName = (name) => (clients && clients[name]) || {};

    /* ---- STR / SAR — suspicious-transaction report. Same worksheet machinery,
       but the heart of it is the narrative: who, what pattern, why it's
       suspicious, what you did. Identity + the deals are pre-filled; the
       grounds-for-suspicion section is yours to write. ---- */
    if (report.kind === regime.strCode) {
      const subj = partyName(report.subject);
      const sp = nameParts(report.subject);
      const subjJur = subj.province ? `${subj.province}, ${subj.country || 'Canada'}` : (subj.country || '');
      const win = (settings && +settings.structuringDays) || 7;
      const strContact = [settings.fintracContactName, settings.bizPhone, settings.bizEmail].filter(Boolean).join(' · ');
      const strGeneral = [
        F('re_num', 'Reporting entity number', '*', 'CONFIG', settings.reportingEntityNumber, { hint: '7-digit FINTRAC ID' }),
        F('report_ref', 'Report reference number', '‡', 'ENGINE', report.reportRef),
        F('sector', 'Activity sector', '*', 'CONFIG', settings.activitySector, { hint: 'e.g. "Money services business — currency exchange"' }),
        F('contact', 'Compliance contact (name · phone · email)', '*', 'CONFIG', strContact, { hint: 'Compliance contact name · phone · email' }),
        F('str_type', 'Type of report', '‡', 'ENGINE', regime.strLabel),
        F('str_reason', 'Reason for suspicion (category)', '‡', 'PROMPT', '', { prompt: true, hint: 'e.g. "Possible structuring — deposits kept just under threshold"' }),
      ];
      const subject = [
        F('su_surname', 'Surname', '*', 'KYC', sp.surname),
        F('su_given', 'Given name', '*', 'KYC', sp.given),
        F('su_other', 'Other / middle name', '', 'KYC', sp.other),
        F('su_addr', 'Address', '*', 'KYC', fullAddr(subj), { hint: 'No PO box / suite-only' }),
        F('su_dob', 'Date of birth', '*', 'KYC', subj.dob, { hint: 'YYYY-MM-DD' }),
        F('su_occ', 'Occupation (descriptive)', '*', 'KYC', subj.occupation, { hint: 'e.g. "retail store manager"' }),
        F('su_employer', 'Name of employer', '', 'KYC', subj.employer),
        F('su_idtype', 'Identifier type', '*', 'KYC', subj.idType, { hint: 'Never a SIN' }),
        F('su_idnum', 'Identifier number', '*', 'KYC', subj.idNum, { hint: 'Document number — never a SIN' }),
        F('su_idjur', 'Identifier jurisdiction', '*', 'KYC', subjJur, { hint: 'Province / state + country that issued the ID' }),
        F('su_tel', 'Telephone', '', 'KYC', subj.phone),
        F('su_rel', 'Relationship to your business', '', 'PROMPT', '', { prompt: true, hint: 'e.g. "walk-in since 2023, regular FX customer"' }),
      ];
      const strTxns = txns.map((r, i) => ({
        label: `${r.ref} · ${r.date} ${r.time}`,
        fields: [
          F('st_dt', 'Date and time', '†', 'LEDGER', fmtDateTime(r.date, r.time, tz)),
          F('st_type', 'Transaction type', '*', 'LEDGER', r.type),
          F('st_amount', 'Amount in', '*', 'LEDGER', `${num(r.inAmt)} ${r.inCcy}`),
          F('st_cad', `${cur}-equivalent`, '', 'ENGINE', fmt(cadIn(r), cur)),
          F('st_disp', 'Disposition', '†', 'LEDGER', r.type === 'Cheque Cashing' ? 'Cheque cashed' : `Paid out ${num(r.outAmt)} ${r.outCcy}`),
        ],
      }));
      const grounds = [{
        label: null,
        fields: [
          F('gr_pattern', 'Pattern observed', '‡', 'ENGINE', `${txns.length} cash deals over ${win} days totalling ${fmt(report.amount, cur)} — each kept under the ${fmt(TH, cur)} line`),
          F('gr_desc', 'Description of suspicious activity (narrative)', '‡', 'PROMPT', '', { prompt: true, hint: 'Plain-language account: what you saw, how the deals relate, why it looks deliberate' }),
          F('gr_indicators', 'ML/TF indicators present', '*', 'PROMPT', '', { prompt: true, hint: 'e.g. "amounts just under threshold; reluctance to provide ID; frequent visits"' }),
          F('gr_action', 'Action taken by your business', '*', 'PROMPT', '', { prompt: true, hint: 'e.g. "transactions completed; enhanced monitoring applied; STR filed"' }),
          F('gr_notip', 'Confirm the subject was NOT tipped off (Y/N)', '‡', 'PROMPT', '', { prompt: true, hint: 'Tipping off is an offence — must be Y' }),
        ],
      }];
      return [
        { key: 's1', title: 'Section 1 — General information', note: 'Set once per business + computed by the desk. Nothing to key.', instances: [{ label: null, fields: strGeneral }] },
        { key: 's2', title: 'Section 2 — Subject of the report', note: 'The person the suspicion is about — pulled from their KYC profile.', instances: [{ label: report.subject, fields: subject }] },
        { key: 's3', title: 'Section 3 — Transactions involved', note: 'The deals that make up the pattern.', repeat: true, instances: strTxns },
        { key: 's4', title: 'Section 4 — Grounds for suspicion', note: 'The heart of the report. Write what you saw and why it looks deliberate.', instances: grounds },
      ];
    }

    /* Section 1 — General information */
    const contact = [settings.fintracContactName, settings.bizPhone, settings.bizEmail].filter(Boolean).join(' · ');
    const aggType = report.basis === 'beneficiary' ? 'beneficiary' : report.basis === 'conductor' ? 'conductor' : 'Not applicable';
    const winStart = report.windowStart, winEnd = report.windowEnd;
    const general = [
      F('re_num', 'Reporting entity number', '*', 'CONFIG', settings.reportingEntityNumber, { hint: '7-digit FINTRAC ID' }),
      F('report_ref', 'Report reference number', '‡', 'ENGINE', report.reportRef),
      F('sector', 'Activity sector', '*', 'CONFIG', settings.activitySector, { hint: 'e.g. "Money services business — currency exchange"' }),
      F('contact', 'FINTRAC contact (name · phone · email)', '*', 'CONFIG', contact, { hint: 'Compliance contact name · phone · email' }),
      F('agg_type', 'Aggregation type', '‡', 'ENGINE', aggType),
      F('win_start', '24-hour period — start', '‡', 'ENGINE', winStart ? fmtWindowEdge(winStart, tz) : 'Not applicable'),
      F('win_end', '24-hour period — end', '‡', 'ENGINE', winEnd ? fmtWindowEdge(winEnd, tz) : 'Not applicable'),
      F('directive', 'Ministerial directive', '†', 'CONFIG', '', { hint: 'Blank unless under directive' }),
    ];

    /* per-transaction blocks */
    const txInstances = [];      // Section 2
    const startInstances = [];   // Section 3 (starting action + conductor)
    const completeInstances = [];// Section 4 (completing action + beneficiary)
    txns.forEach((r, i) => {
      const cad = cadIn(r);
      const above = cad >= TH;
      const method = r.type === 'Cheque Cashing' ? 'Cheque' : 'Cash';
      const cap = r.capture || null;   // point-of-sale capture pre-fills the prompts
      txInstances.push({
        label: `${r.ref}`,
        fields: [
          F('tx_dt', 'Date and time of transaction', '†', 'LEDGER', fmtDateTime(r.date, r.time, tz)),
          F('tx_method', 'Method of transaction', '*', 'LEDGER', method),
          F('tx_method_other', 'If "Other," specify', '†', 'LEDGER', '', { hint: 'Only if method = Other' }),
          F('tx_threshold', 'Threshold indicator', '‡', 'LEDGER', above ? 'above' : 'below'),
          F('tx_ref', 'Transaction reference number', '‡', 'ENGINE', r.ref),
          F('tx_purpose', 'Purpose of transaction', '', cap && cap.purpose ? 'LEDGER' : 'PROMPT', cap && cap.purpose ? cap.purpose : '', cap && cap.purpose ? {} : { prompt: true, hint: 'e.g. "GBP for vacation"' }),
          F('tx_location', 'Reporting entity location number', '*', 'CONFIG', settings.locationNumber, { hint: 'Your branch / location ID on file with FINTRAC' }),
        ],
      });
      // Section 3 — starting action + conductor (the cash in)
      const cond = partyName(r.customer);
      const np = nameParts(r.customer);
      const idJur = cond.province ? `${cond.province}, ${cond.country || 'Canada'}` : (cond.country || '');
      startInstances.push({
        label: `${r.ref} · cash in`,
        fields: [
          F('sa_amount', 'Amount (starting action)', '*', 'LEDGER', num(r.inAmt)),
          F('sa_currency', 'Currency — report ORIGINAL, do not convert', '*', 'LEDGER', r.inCcy),
          F('sa_cadtest', `${cur}-equivalent (threshold test only)`, '', 'ENGINE', fmt(cad, cur)),
          F('sa_obtained', 'How was the cash obtained?', '', cap && cap.source ? 'LEDGER' : 'PROMPT', cap && cap.source ? cap.source : '', cap && cap.source ? {} : { prompt: true, hint: 'Employment / asset sale / gift, if known' }),
          F('sa_source', 'Source-of-cash info obtained? (Y/N)', '‡', cap ? 'LEDGER' : 'PROMPT', cap ? (cap.source ? 'Y' : 'N') : '', cap ? {} : { prompt: true, hint: 'Y if you have the source person/entity' }),
          F('sa_deposit', 'Deposit to a business account? (Y/N)', '‡', 'LEDGER', 'No'),
          { divider: 'Conductor — who physically did it' },
          F('cd_surname', 'Surname', '*', 'KYC', np.surname),
          F('cd_given', 'Given name', '*', 'KYC', np.given),
          F('cd_other', 'Other / middle name', '', 'KYC', np.other),
          F('cd_addr', 'Address', '*', 'KYC', fullAddr(cond), { hint: 'No PO box / suite-only' }),
          F('cd_dob', 'Date of birth', '*', 'KYC', cond.dob, { hint: 'YYYY-MM-DD' }),
          F('cd_occ', 'Occupation (descriptive)', '*', 'KYC', cond.occupation, { hint: 'e.g. "retail store manager"' }),
          F('cd_employer', 'Name of employer', '', 'KYC', cond.employer),
          F('cd_idtype', 'Identifier type', '*', 'KYC', cond.idType, { hint: 'Never a SIN' }),
          F('cd_idnum', 'Identifier number', '*', 'KYC', cond.idNum, { hint: 'Document number — never a SIN' }),
          F('cd_idjur', 'Identifier jurisdiction', '*', 'KYC', idJur, { hint: 'Province / state + country that issued the ID' }),
          F('cd_tel', 'Telephone', '', 'KYC', cond.phone),
          { divider: 'Third party — acting on behalf of someone else?' },
          F('tp_det', 'Third-party determination made? (Y/N)', '†', cap ? 'LEDGER' : 'PROMPT', cap ? (cap.thirdParty ? 'Yes' : 'No') : '', cap ? {} : { prompt: true, hint: 'Did you ask if they act for another?' }),
          F('tp_who', 'If yes — name of that person/entity', '†', cap && cap.thirdPartyName ? 'LEDGER' : 'PROMPT', cap && cap.thirdPartyName ? cap.thirdPartyName : '', cap && cap.thirdPartyName ? {} : { prompt: true, hint: 'Then capture their identity too' }),
        ],
      });
      // Section 4 — completing action (value out) + beneficiary
      const benName = report.basis === 'beneficiary' ? report.subject : (r.beneficiary || report.beneficiary || '');
      completeInstances.push({
        label: `${r.ref} · value out`,
        fields: [
          F('ca_detail', 'Details of disposition', '*', 'LEDGER', isWire ? 'Outgoing electronic funds transfer' : (r.type === 'Cheque Cashing' ? 'Cheque cashed' : `Currency exchange — paid out ${r.outCcy}`)),
          F('ca_amount', 'Amount disposed', '*', 'LEDGER', num(r.outAmt)),
          F('ca_currency', 'Currency — report ORIGINAL', '*', 'LEDGER', r.outCcy),
          F('ca_account', 'Account / reference info', '†', 'LEDGER', '', { hint: 'N/A for over-the-counter exchange' }),
          F('be_name', 'Beneficiary — who received the value', '†', benName ? 'LEDGER' : 'PROMPT', benName, { prompt: !benName, hint: 'Who the value is destined for' }),
          F('be_other', 'Other person/entity in completing action', '†', 'PROMPT', '', { prompt: true, hint: 'If anyone else involved' }),
        ],
      });
    });

    const blocks = [
      { key: 's1', title: 'Section 1 — General information', note: 'Set once per business + computed by the desk. Nothing to key.', instances: [{ label: null, fields: general }] },
      { key: 's2', title: 'Section 2 — Transaction information', note: 'One block per transaction in this report.', repeat: true, instances: txInstances },
      { key: 's3', title: 'Section 3 — Starting action (cash in) + conductor', note: 'How the cash came in, and who handed it over.', repeat: true, instances: startInstances },
      { key: 's4', title: 'Section 4 — Completing action (value out) + beneficiary', note: 'How the value left, and who received it.', repeat: true, instances: completeInstances },
    ];
    return blocks;
  }

  // companion obligations CDOS auto-flags alongside the LCTR
  function companions(report, ctx) {
    const { regime } = ctx;
    const out = [];
    if (report.kind === regime.strCode) {
      out.push({ code: regime.largeCode, when: 'If any single cash deal in the pattern also hit the threshold', also: true });
      out.push({ code: 'No tipping-off', when: 'Never tell the subject a report was made — it is a separate offence', also: true });
      out.push({ code: 'Record-keeping', when: `Keep a copy of every filed ${regime.strCode} for ≥ ${(ctx.settings && ctx.settings.retentionYears) || 5} years`, also: false });
      return out;
    }
    out.push({ code: regime.wireCode, when: 'If a disposition is a reportable international electronic transfer', also: true });
    out.push({ code: regime.strCode, when: 'If there are grounds to suspect ML/TF', also: true });
    out.push({ code: 'Record-keeping', when: `Keep a copy of every filed ${regime.largeCode} for ≥ ${(ctx.settings && ctx.settings.retentionYears) || 5} years`, also: false });
    return out;
  }

  /* ---------- count prompts / readiness ---------- */
  function promptKeys(blocks) {
    const keys = [];
    blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (f.prompt) keys.push(`${b.key}.${ii}.${f.id}`); })));
    return keys;
  }
  // the prompts that genuinely gate filing (mandatory-for-processing or mandatory)
  function requiredPromptKeys(blocks) {
    const keys = [];
    blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (f.prompt && (f.cat === '‡' || f.cat === '*')) keys.push(`${b.key}.${ii}.${f.id}`); })));
    return keys;
  }
  // every field the owner can type into the worksheet: point-of-sale PROMPTs + any
  // mandatory CONFIG/KYC field that came back empty (a gap to patch right here).
  function fillKeys(blocks) {
    const keys = [];
    blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (f.prompt || f.missing) keys.push(`${b.key}.${ii}.${f.id}`); })));
    return keys;
  }
  // the subset of fillable fields that GATE the filing: required prompts + every missing mandatory field
  function requiredFillKeys(blocks) {
    const keys = [];
    blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => {
      if (f.prompt && (f.cat === '‡' || f.cat === '*')) keys.push(`${b.key}.${ii}.${f.id}`);
      else if (f.missing) keys.push(`${b.key}.${ii}.${f.id}`);
    })));
    return keys;
  }

  /* ====================================================================
     FACE 1 — FILING WORKSHEET
  ==================================================================== */
  function Worksheet({ report, ctx, onFile, onClose }) {
    const blocks = useMemo(() => buildMap(report, ctx), [report, ctx]);
    const comps = useMemo(() => companions(report, ctx), [report, ctx]);
    const { regime } = ctx;
    // `vals` overrides EVERY field (pre-filled values are editable); `ticks` marks a field keyed into FWR.
    const [vals, setVals] = useState(report.prompts || {});
    const [ticks, setTicks] = useState(report.ticks || {});
    const [focused, setFocused] = useState(null);
    const [copied, setCopied] = useState(null);
    const [flash, setFlash] = useState(null);        // briefly highlight a jumped-to field
    const [helpFor, setHelpFor] = useState(null);    // which field's info popover is open
    const bodyRef = useRef(null);
    const inputRefs = useRef({});
    const [filing, setFiling] = useState(false);     // showing the mark-filed step
    const [receipt, setReceipt] = useState('');
    const [shown, setShown] = useState(false);
    useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);

    // effective value of a field = the owner's override if present, else the desk's pre-fill
    const evOf = (f, k) => (k in vals) ? vals[k] : (f.value || '');
    const isMandatory = (f) => (f.cat === '*' || f.cat === '‡') && f.source !== 'ENGINE';

    // every editable (non-divider) field key, in order
    const allKeys = useMemo(() => { const a = []; blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (!f.divider) a.push(`${b.key}.${ii}.${f.id}`); }))); return a; }, [blocks]);
    const fieldByKey = useMemo(() => { const m = {}; blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (!f.divider) m[`${b.key}.${ii}.${f.id}`] = f; }))); return m; }, [blocks]);
    // a field can only be "keyed into FWR" once it actually has a value — you can't tick a blank
    const valueKeys = allKeys.filter(k => { const f = fieldByKey[k]; return f && String(evOf(f, k)).trim(); });
    const ticked = valueKeys.filter(k => ticks[k]).length;
    const allTicked = valueKeys.length > 0 && ticked === valueKeys.length;
    // mandatory fields still blank (block the seal)
    const reqLeft = useMemo(() => { let n = 0; blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (!f.divider && isMandatory(f) && !String(evOf(f, `${b.key}.${ii}.${f.id}`)).trim()) n++; }))); return n; }, [blocks, vals]);
    // un-patched CONFIG/KYC gaps (drives the red banner)
    const missingLeft = useMemo(() => { let n = 0; blocks.forEach(b => b.instances.forEach((inst, ii) => (inst.fields || []).forEach(f => { if (f.missing && !String(evOf(f, `${b.key}.${ii}.${f.id}`)).trim()) n++; }))); return n; }, [blocks, vals]);
    const fk = fillKeys(blocks);

    const copy = (key, val) => { try { const p = navigator.clipboard && navigator.clipboard.writeText(val); if (p && p.catch) p.catch(() => {}); } catch (e) {} setCopied(key); setTimeout(() => setCopied(c => c === key ? null : c), 1100); };
    const setVal = (k, v) => setVals(p => ({ ...p, [k]: v }));
    const toggleTick = (k) => { const f = fieldByKey[k]; if (!f || !String(evOf(f, k)).trim()) return; setTicks(m => ({ ...m, [k]: !m[k] })); };
    const tickAll = () => { if (reqLeft > 0) return; setTicks(() => { const m = {}; valueKeys.forEach(k => { m[k] = true; }); return m; }); };
    const clearTicks = () => setTicks({});
    // the next field that still needs a value (mandatory first, then any blank)
    const nextEmptyKey = () => allKeys.find(k => { const f = fieldByKey[k]; return f && isMandatory(f) && !String(evOf(f, k)).trim(); })
      || allKeys.find(k => { const f = fieldByKey[k]; return f && (f.prompt || f.missing) && !String(evOf(f, k)).trim(); });
    // scroll a field into view inside the worksheet body and focus it (no scrollIntoView)
    const focusField = (k) => {
      const el = inputRefs.current[k], cont = bodyRef.current;
      if (el && cont) { const er = el.getBoundingClientRect(), cr = cont.getBoundingClientRect(); cont.scrollTo({ top: cont.scrollTop + (er.top - cr.top) - 90, behavior: 'smooth' }); }
      setFlash(k); setTimeout(() => { if (el) try { el.focus({ preventScroll: true }); } catch (e) {} }, 260);
      setTimeout(() => setFlash(f => f === k ? null : f), 1500);
    };
    // primary action of the progress button: jump to the next gap, or tick everything once filled
    const onProgressAction = () => { if (reqLeft > 0) { const k = nextEmptyKey(); if (k) focusField(k); return; } allTicked ? clearTicks() : tickAll(); };

    // resolve a snapshot with every edit + patched gap baked in (for the seal)
    const resolve = () => blocks.map(b => ({ ...b, instances: b.instances.map((inst, ii) => ({ ...inst, fields: (inst.fields || []).map(f => {
      if (f.divider) return f;
      const k = `${b.key}.${ii}.${f.id}`;
      const v = String(evOf(f, k)).trim();
      const edited = (k in vals) && v !== String(f.value || '').trim();
      return { ...f, value: v, missing: f.missing && !v, filledByTeller: f.prompt || f.missing || edited };
    }) })) }));

    const doFile = () => {
      if (!receipt.trim()) return;
      onFile({ map: resolve(), prompts: vals, ticks, fwrReceipt: receipt.trim() });
    };

    const SourceTag = ({ s }) => {
      const tone = { CONFIG: { c: '#3f6212', bg: '#ecf5d9' }, LEDGER: { c: '#1d4ed8', bg: '#dbe5fb' }, KYC: { c: '#6d28d9', bg: '#e7e0f7' }, ENGINE: { c: CD.mute, bg: CD.lineSoft }, PROMPT: { c: 'var(--cd-brass-text)', bg: CD.brassSoft } }[s] || { c: CD.mute, bg: CD.lineSoft };
      return <span className="text-[8.5px] px-1 py-0.5 font-semibold flex-none" style={{ background: tone.bg, color: tone.c, borderRadius: 3, fontFamily: 'Space Mono, monospace', letterSpacing: '.02em' }}>{s}</span>;
    };
    const catColor = (c) => c === '‡' ? CD.flag : c === '*' ? CD.ink : c === '†' ? CD.amber : CD.faint;
    // per-field guidance for the info popover — where the value comes from + whether it's required + an example
    const SRC_HELP = {
      CONFIG: ['Comes straight from your business Settings — set once, reused on every filing.', 'gear'],
      LEDGER: ['Pulled from the transaction that triggered this report.', 'scroll'],
      KYC: ['Pulled from the customer’s KYC profile on file.', 'id'],
      ENGINE: ['Worked out automatically by the desk — you normally don’t touch it.', 'clock'],
      PROMPT: ['Not on file — ask the customer at the counter and type it in.', 'users']
    };
    const fieldHelp = (f) => {
      const [src, srcIcon] = SRC_HELP[f.source] || ['', 'info'];
      const req = f.cat === '‡' ? 'Required — FWR rejects the whole report without it.' : f.cat === '*' ? 'Mandatory field.' : f.cat === '†' ? 'Only needed when it applies to this deal.' : 'Optional — include it if you have it.';
      const reqTone = f.cat === '‡' ? '#ff9b8a' : f.cat === '*' ? '#e7d9b0' : '#c2bdb0';
      return { what: f.help || '', src, srcIcon, req, reqTone };
    };

    const renderField = (f, fk, ki) => {
      if (f.divider) return <div key={ki} className="text-[10px] uppercase tracking-widest mt-2 mb-0.5 pt-2 pl-7" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', borderTop: `1px dashed ${CD.line}` }}>{f.divider}</div>;
      const dv = String(evOf(f, fk));
      const isCopied = copied === fk;
      const isFocused = focused === fk;
      const done = !!ticks[fk];
      const mandatory = isMandatory(f);
      const gap = mandatory && !dv.trim();
      const canTick = !!dv.trim();
      const isFlash = flash === fk;
      let bg = CD.panel, bd = CD.line, col = CD.ink;
      if (done) { bg = CD.greenSoft; bd = CD.green; col = CD.green; }
      else if (gap) { bg = CD.flagSoft; bd = CD.flag; }
      else if (isFocused) { bg = CD.panel; bd = CD.ink; }
      else if ((f.prompt || f.missing) && !dv.trim()) { bg = CD.brassSoft; bd = CD.brass; }
      return (<div key={ki} className="py-1.5" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[9px] font-bold flex-none" style={{ color: catColor(f.cat), fontFamily: 'Space Mono, monospace', width: 8 }}>{f.cat}</span>
          <span className="text-[11.5px] font-medium truncate" style={{ color: done ? CD.faint : CD.ink, textDecoration: done ? 'line-through' : 'none' }}>{f.label}</span>
          <SourceTag s={f.source} />
          {gap && <span className="text-[8.5px] px-1 py-0.5 font-semibold flex-none" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 3, fontFamily: 'Space Mono, monospace' }}>FILL IN</span>}
          <span className="relative flex-none" style={{ lineHeight: 0 }} onMouseEnter={() => setHelpFor(fk)} onMouseLeave={() => setHelpFor(c => c === fk ? null : c)}>
            <button type="button" title="What goes here?" className="grid place-items-center" style={{ width: 16, height: 16, borderRadius: '50%', border: `1px solid ${helpFor === fk ? CD.ink : CD.line}`, background: helpFor === fk ? CD.ink : 'transparent', cursor: 'help', transition: 'background .12s, border-color .12s' }}>
              <Ic n="info" s={10} c={helpFor === fk ? 'var(--cd-on-ink)' : CD.faint} />
            </button>
            {helpFor === fk && (() => { const h = fieldHelp(f); return (
              <div className="absolute" style={{ top: '100%', left: -6, paddingTop: 8, width: 260, zIndex: 50 }}>
                <div className="text-left" style={{ position: 'relative', background: '#16150f', color: '#ffffff', borderRadius: 10, boxShadow: '0 14px 34px -10px rgba(0,0,0,0.5)', lineHeight: 1.45, padding: '10px 11px' }}>
                  <span style={{ position: 'absolute', top: -5, left: 16, width: 10, height: 10, background: '#16150f', transform: 'rotate(45deg)', borderRadius: 1 }} />
                  <div className="text-[11.5px] font-semibold mb-1.5">{f.label}</div>
                  {h.what && <div className="text-[11px] mb-2" style={{ color: '#dcd9d1' }}>{h.what}</div>}
                  {h.src && <div className="flex items-start gap-1.5 text-[10.5px]" style={{ color: '#c2bdb0' }}><Ic n={h.srcIcon} s={11} c="#c2bdb0" /><span className="flex-1">{h.src}</span></div>}
                  <div className="flex items-center gap-1.5 text-[10.5px] mt-1.5"><span style={{ width: 6, height: 6, borderRadius: '50%', background: h.reqTone, flex: 'none' }} /><span style={{ color: h.reqTone }}>{h.req}</span></div>
                  {f.hint && <div className="text-[10.5px] px-1.5 py-1 mt-2" style={{ background: 'rgba(255,255,255,0.14)', borderRadius: 6, fontFamily: 'Space Mono, monospace', color: '#f0eee7' }}>e.g.&nbsp;{f.hint}</div>}
                </div>
              </div>); })()}
          </span>
        </div>
        <div className="flex items-stretch">
          <input ref={el => { if (el) inputRefs.current[fk] = el; }} value={dv} onChange={e => setVal(fk, e.target.value)} onFocus={() => { setFocused(fk); setHelpFor(null); }} onBlur={() => setFocused(c => c === fk ? null : c)} placeholder={f.hint || (f.prompt ? 'Ask at the counter…' : f.missing ? 'Enter to complete the report…' : '—')} className="flex-1 min-w-0 text-[12.5px] px-2 py-1.5 outline-none" style={{ background: bg, borderTop: `1px solid ${bd}`, borderBottom: `1px solid ${bd}`, borderLeft: `1px solid ${bd}`, borderRight: 'none', borderRadius: '7px 0 0 7px', fontFamily: 'Space Mono, monospace', color: col, transition: 'background .12s, border-color .12s, box-shadow .12s', boxShadow: isFlash ? `0 0 0 3px color-mix(in srgb, ${CD.flag} 33%, transparent)` : 'none' }} />
          <button onClick={() => { if (!dv.trim()) return; copy(fk, dv); toggleTick(fk); }} disabled={!dv.trim()} title={!dv.trim() ? 'Fill this field first' : done ? 'Keyed into FWR — click to undo' : 'Copy value & mark it keyed'} className="flex-none grid place-items-center" style={{ width: 34, borderRadius: '0 7px 7px 0', border: `1px solid ${(done || isCopied) ? CD.green : bd}`, background: (done || isCopied) ? CD.greenSoft : 'var(--cd-panel)', opacity: dv.trim() ? 1 : 0.4, cursor: dv.trim() ? 'pointer' : 'default', transition: 'background .15s, border-color .15s' }}>
            <Ic n={(done || isCopied) ? 'check' : 'copy'} s={14} c={(done || isCopied) ? CD.green : CD.mute} />
          </button>
        </div>
        {gap && f.missing && <div className="text-[10px] mt-1 ml-0.5" style={{ color: CD.faint }}>Normally pulled from {f.source === 'CONFIG' ? 'Settings' : 'the client profile'} — fill it here and it’s captured on the sealed copy.</div>}
        {f.hint && !f.prompt && !f.missing && dv.trim() && isFocused && <div className="text-[9.5px] mt-0.5 ml-0.5" style={{ color: CD.faint }}>{f.hint}</div>}
      </div>);
    };

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-3 md:p-6" style={{ background: 'var(--cd-scrim)', zIndex: 9000, opacity: shown ? 1 : 0, transition: 'opacity .18s' }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 760, height: '94%', background: CD.paper, borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 80px -20px var(--cd-scrim)', transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'transform .2s' }}>
        {/* header */}
        <div className="flex items-start gap-3 px-5 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 9 }}><Ic n="filetext" s={18} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2"><span className="text-[15px] font-bold" style={{ color: CD.ink }}>{kindLabelOf(report.kind, regime)}</span><span className="text-[10px] px-1.5 py-0.5 font-semibold" style={{ background: CD.brassSoft, color: 'var(--cd-brass-text)', borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>FILING WORKSHEET</span></div>
            <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{report.subject} · {fmt(report.amount, regime.currency)} · ref <b style={{ color: CD.ink, fontFamily: 'Space Mono, monospace' }}>{report.reportRef}</b></div>
          </div>
          <button onClick={onClose} className="flex-none grid place-items-center" style={{ width: 32, height: 32, borderRadius: 8 }}><Ic n="x" s={18} c={CD.mute} /></button>
        </div>

        {/* teleprompter intro + progress */}
        <div className="px-5 py-2.5 flex-none flex items-center gap-3" style={{ background: CD.brassSoft, borderBottom: `1px solid ${CD.brass}` }}>
          <Ic n="info" s={15} c={CD.brass} />
          <div className="text-[11.5px] flex-1" style={{ color: 'var(--cd-brass-text)' }}>Every field is editable — click any value to correct it. Read down, paste each into your FWR login, and <b>tick it off</b> as you go.{missingLeft ? ` ${missingLeft} highlighted field${missingLeft === 1 ? '' : 's'} still need${missingLeft === 1 ? 's' : ''} a value.` : ''}</div>
          <button onClick={onProgressAction} title={reqLeft > 0 ? 'Jump to the next field that needs a value' : ''} className="text-[10.5px] font-semibold flex-none px-2 py-1 flex items-center gap-1" style={{ background: reqLeft > 0 ? CD.flag : 'var(--cd-panel)', borderRadius: 7, color: reqLeft > 0 ? 'var(--cd-on-ink)' : CD.mute, border: `1px solid ${reqLeft > 0 ? CD.flag : CD.brass}`, cursor: 'pointer' }}>{reqLeft > 0 ? <>Fill next <Ic n="arrowdown" s={11} c="var(--cd-on-ink)" /></> : (allTicked ? 'Clear ticks' : 'Tick all')}</button>
          <div className="text-[11px] font-semibold flex-none px-2 py-1" style={{ background: 'var(--cd-panel)', borderRadius: 999, color: allTicked ? CD.green : CD.mute, fontFamily: 'Space Mono, monospace' }}>{ticked}/{valueKeys.length} keyed</div>
        </div>

        {/* body */}
        <div ref={bodyRef} className="flex-1 overflow-auto px-5 py-4">
          {missingLeft > 0 && <div className="mb-3 px-3 py-2 flex items-center gap-2 text-[11.5px]" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 9, color: CD.flag }}><Ic n="alert" s={14} c={CD.flag} /><span>{missingLeft} mandatory {missingLeft === 1 ? 'field' : 'fields'} normally from CONFIG / KYC came back empty — type {missingLeft === 1 ? 'it' : 'them'} into the highlighted {missingLeft === 1 ? 'box' : 'boxes'} below to complete the report. FWR rejects the filing without {missingLeft === 1 ? 'it' : 'them'}.</span></div>}
          {blocks.map(b => (
            <div key={b.key} className="mb-4">
              <div className="flex items-baseline gap-2 mb-1"><span className="text-[12.5px] font-bold" style={{ color: CD.ink }}>{b.title}</span></div>
              <div className="text-[10.5px] mb-2" style={{ color: CD.faint }}>{b.note}</div>
              {b.instances.length === 0 && <div className="text-[11px] px-3 py-2" style={{ color: CD.faint, border: `1px dashed ${CD.line}`, borderRadius: 8 }}>No items.</div>}
              {b.instances.map((inst, ii) => (
                <div key={ii} className="mb-2 p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
                  {inst.label && <div className="text-[10px] font-semibold mb-1" style={{ color: CD.mute, fontFamily: 'Space Mono, monospace' }}>{inst.label}</div>}
                  <div>{(inst.fields || []).map((f, fi) => renderField(f, `${b.key}.${ii}.${f.id}`, fi))}</div>
                </div>
              ))}
            </div>
          ))}

          {/* companion obligations */}
          <div className="mb-2 p-3" style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.line}`, borderRadius: 11 }}>
            <div className="flex items-center gap-1.5 mb-2"><span className="text-[12.5px] font-bold" style={{ color: CD.ink }}>Companion obligations</span><window.CDOS.InfoTip title="Companion obligations" body="Filing one report can trigger a second, related one. The desk flags those here so nothing is missed — a red code means you must file it too." example="A reportable wire alongside the cash deal needs an EFTR" /></div>
            {comps.map((c, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 text-[11.5px]" style={{ borderTop: i ? `1px solid ${CD.lineSoft}` : 'none' }}>
                <span className="text-[9.5px] px-1.5 py-0.5 font-semibold flex-none" style={{ background: c.also ? CD.flagSoft : CD.lineSoft, color: c.also ? CD.flag : CD.mute, borderRadius: 4, fontFamily: 'Space Mono, monospace' }}>{c.code}</span>
                <span style={{ color: CD.mute }}>{c.when}{c.also ? <b style={{ color: CD.ink }}> — file it too.</b> : '.'}</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] flex items-center gap-3 px-1 pb-2" style={{ color: CD.faint }}>
            <span><b style={{ color: catColor('‡') }}>‡</b> rejected without it</span>
            <span><b style={{ color: catColor('*') }}>*</b> mandatory</span>
            <span><b style={{ color: catColor('†') }}>†</b> if applicable</span>
            <span className="ml-auto" style={{ fontFamily: 'Space Mono, monospace' }}>CONFIG · LEDGER · KYC · ENGINE · PROMPT</span>
          </div>
        </div>

        {/* footer — mark filed */}
        <div className="flex-none px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}>
          {!filing ? (
            <div className="flex items-center gap-3">
              <div className="text-[11.5px] flex-1" style={{ color: reqLeft ? CD.flag : CD.mute }}>{reqLeft ? `${reqLeft} required field${reqLeft === 1 ? '' : 's'} still blank` : `All required fields complete · ${ticked}/${allKeys.length} keyed into FWR. Seal the filed copy once submitted.`}</div>
              <button onClick={() => setFiling(true)} disabled={reqLeft > 0} className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white flex-none" style={{ background: (reqLeft > 0) ? 'var(--cd-disabled)' : CD.ink, borderRadius: 9, cursor: (reqLeft > 0) ? 'not-allowed' : 'pointer' }}><Ic n="lock" s={15} c="var(--cd-on-ink)" /> Mark filed & seal</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-none text-[11.5px] font-medium" style={{ color: CD.ink }}>FWR acknowledgement #</div>
              <input value={receipt} onChange={e => setReceipt(e.target.value)} autoFocus placeholder="Paste the FWR receipt number…" className="flex-1 text-[13px] px-2.5 py-2 outline-none" style={{ border: `1px solid ${CD.ink}`, borderRadius: 8, fontFamily: 'Space Mono, monospace' }} onKeyDown={e => { if (e.key === 'Enter') doFile(); }} />
              <button onClick={() => setFiling(false)} className="px-3 py-2 text-[12px] font-medium flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute }}>Back</button>
              <button onClick={doFile} disabled={!receipt.trim()} className="px-4 py-2 text-sm font-semibold text-white flex-none" style={{ background: receipt.trim() ? CD.green : 'var(--cd-disabled)', borderRadius: 8, cursor: receipt.trim() ? 'pointer' : 'not-allowed' }}>Seal filed copy</button>
            </div>
          )}
        </div>
      </div>
    </div></Portal>);
  }

  /* ====================================================================
     FACE 2 — SEALED FILED RECORD (immutable PDF)
  ==================================================================== */
  function sealedHTML(filing, ctx) {
    const { settings, regime } = ctx;
    const op = settings.operatingName || settings.bizName || 'CurrencyDesk OS';
    const fieldRows = (inst) => (inst.fields || []).map(f => f.divider
      ? `<tr><td class="dv" colspan="3">${esc(f.divider)}</td></tr>`
      : `<tr><td class="cat">${esc(f.cat || '')}</td><td class="lbl">${esc(f.label)}${f.filledByTeller ? ' <span class="pr">prompt</span>' : ''}</td><td class="val${f.value ? '' : ' empty'}">${esc(f.value || '—')}</td></tr>`).join('');
    const blockHTML = (b) => `<div class="blk"><div class="bt">${esc(b.title)}</div>${b.instances.map(inst => `<div class="inst">${inst.label ? `<div class="il">${esc(inst.label)}</div>` : ''}<table class="ft">${fieldRows(inst)}</table></div>`).join('')}</div>`;
    const links = (filing.refs || []).map(r => `<span class="lk">${esc(r)}</span>`).join(' ');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(filing.kind)} ${esc(filing.reportRef)} — filed copy</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:34px 40px;color:#0a0a0a;background:#fff;}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0a0a0a;padding-bottom:14px;margin-bottom:16px;}
.bd{display:flex;align-items:center;gap:10px;}.logo{width:32px;height:32px;background:#0a0a0a;color:#fff;border-radius:8px;display:grid;place-items:center;font-family:'Space Mono';font-weight:700;font-size:13px;}
.wm{font-family:'Space Mono';font-size:11px;letter-spacing:.16em;color:#777;}
.h1{font-size:22px;font-weight:800;margin-top:6px;}.sub{font-size:12px;color:#555;}
.meta{text-align:right;font-size:11px;color:#555;}
.seal{display:inline-flex;align-items:center;gap:6px;border:2px solid #1f8a5b;color:#1f8a5b;border-radius:8px;padding:5px 12px;font-family:'Space Mono';font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;transform:rotate(-1.5deg);}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e4e2da;border:1px solid #e4e2da;border-radius:9px;overflow:hidden;margin-bottom:18px;}
.kpi{background:#faf9f6;padding:9px 12px;}.kpi .l{font-family:'Space Mono';font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#888;}.kpi .v{font-size:13px;font-weight:700;margin-top:2px;}
.blk{margin-bottom:14px;break-inside:avoid;}.bt{font-size:13px;font-weight:700;border-bottom:1px solid #0a0a0a;padding-bottom:4px;margin-bottom:6px;}
.inst{margin-bottom:8px;}.il{font-family:'Space Mono';font-size:10px;color:#777;margin-bottom:2px;}
.ft{width:100%;border-collapse:collapse;font-size:11.5px;}
.ft td{padding:3px 6px;border-bottom:1px solid #eee;vertical-align:top;}
.ft .cat{width:14px;font-family:'Space Mono';font-weight:700;color:#999;}
.ft .lbl{width:46%;color:#444;}.ft .pr{font-family:'Space Mono';font-size:8px;background:#f3e7c8;color:#6b5119;padding:1px 4px;border-radius:3px;}
.ft .val{font-family:'Space Mono';color:#0a0a0a;}.ft .val.empty{color:#bbb;}
.ft .dv{font-family:'Space Mono';font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding-top:7px;}
.lnk{margin-top:10px;padding:10px 12px;background:#faf9f6;border:1px solid #e4e2da;border-radius:9px;font-size:11px;}
.lk{font-family:'Space Mono';font-size:10.5px;background:#0a0a0a;color:#fff;border-radius:5px;padding:2px 7px;margin-right:4px;display:inline-block;}
.ft2{margin-top:14px;font-size:10px;color:#888;border-top:1px solid #e4e2da;padding-top:10px;}
@media print{body{padding:0;}}
</style></head><body>
<div class="hd">
  <div><div class="bd"><span class="logo">CD</span><span class="wm">CURRENCYDESK OS</span></div>
    <div class="h1">${esc(filing.kindLabel || filing.kind)}</div>
    <div class="sub">${esc(op)} · ${esc(regime.authority)} · filed copy of record</div></div>
  <div class="meta"><div class="seal">● Filed &amp; sealed</div>
    <div style="margin-top:8px;">Report ref <b style="color:#0a0a0a;font-family:'Space Mono'">${esc(filing.reportRef)}</b></div>
    <div>FWR receipt <b style="color:#0a0a0a;font-family:'Space Mono'">${esc(filing.fwrReceipt)}</b></div></div>
</div>
<div class="kpis">
  <div class="kpi"><div class="l">Subject</div><div class="v">${esc(filing.subject)}</div></div>
  <div class="kpi"><div class="l">Amount</div><div class="v">${esc(fmt(filing.amount, regime.currency))}</div></div>
  <div class="kpi"><div class="l">Filed by</div><div class="v">${esc(filing.filedBy)}</div></div>
  <div class="kpi"><div class="l">Filed at</div><div class="v" style="font-size:11px;">${esc(filing.filedAt)}</div></div>
</div>
${(filing.map || []).map(blockHTML).join('')}
<div class="lnk"><b>Linked records</b> — this filing was triggered by, and is welded to: ${links || '—'}${filing.subject ? ` · client <b>${esc(filing.subject)}</b>` : ''}</div>
<div class="ft2">Immutable filed copy. A correction is filed as a new linked report — this record is never edited. Retain ≥ ${(settings && settings.retentionYears) || 5} years per ${esc(regime.authority)} record-keeping. Times in ${esc((settings && settings.timezone) || 'America/Toronto')} with UTC offset. Foreign amounts shown in original currency; ${esc(regime.currency)} equivalents are threshold-test references only.</div>
</body></html>`;
  }
  function openSealed(filing, ctx) {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) return;
    w.document.write(sealedHTML(filing, ctx));
    w.document.close();
  }

  window.CDOS = Object.assign(window.CDOS || {}, { LCTR: { buildMap, companions, Worksheet, sealedHTML, openSealed, fmtDateTime, promptKeys, requiredPromptKeys, fillKeys, requiredFillKeys, kindLabelOf } });
})();
