/* ============================================================
   CurrencyDesk OS — KYC / identity verification
   A paid, partner-powered verification rail. The desk sends a
   subject (client, business or beneficiary) off to the verification
   provider (Persona) for ID + biometric + database checks. Each
   verification is billed to the exchange house's account — this is
   a revenue line for CurrencyDesk.

   One self-contained module, used in two places:
     • Clients ▸ contact profile  → SubjectPanel at the bottom
     • Compliance ▸ Screening      → PickerModal + per-row Verify

   Persona is not connected. A control may say "ID checks not
   connected yet". It must not start a check, finish one on a timer,
   file a Persona result, or mark the file verified.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect, useRef } = React;
  const { CD, Ic, fmt } = window.CDOS;
  const KYC_BLUE = '#2B50E2';   // brand accent for recommendations / selection
  const TIER_META = {
    quick: { tag: 'Keeps files current', best: 'walk-ins & already-verified clients' },
    verify: { tag: 'The standard', best: 'every first-time client' },
    plus: { tag: 'Most protection', best: 'large deals & high-risk profiles' },
  };
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);

  const KKEY = 'cdos_kyc_v1';
  const HKEY = 'cdos_report_history_v1';
  const PKEY = 'cdos_kyc_provider';
  // The verification provider is swappable — defaults to Persona, set from Settings.
  let PROVIDER = (() => { try { return localStorage.getItem(PKEY) || 'Persona'; } catch (e) { return 'Persona'; } })();
  // Buried “partner authorization code” → lifetime margin adjustment on every check.
  // Sold to founding desks as a perk; stored quietly, applied to all KYC pricing.
  const RKEY = 'cdos_kyc_partner_rate';
  const PARTNER_CODES = { 'YFX-FOUNDER': 0.10, 'YFX-PARTNER': 0.07, 'YFX-INTRO': 0.05 };
  let RATE_ADJ = (() => { try { return Math.min(0.5, Math.max(0, +localStorage.getItem(RKEY) || 0)); } catch (e) { return 0; } })();
  const net = (p) => Math.round(((+p || 0) * (1 - RATE_ADJ)) * 100) / 100;
  function applyPartnerCode(code) {
    const adj = PARTNER_CODES[String(code || '').trim().toUpperCase()];
    if (adj == null) return { ok: false };
    RATE_ADJ = adj; try { localStorage.setItem(RKEY, String(adj)); } catch (e) {} listeners.forEach(l => l());
    return { ok: true, pct: Math.round(adj * 100) };
  }
  const getPartnerRate = () => RATE_ADJ;
  const stampNow = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const money = (n) => '$' + (+n || 0).toFixed(2);
  // house default risk for brand-new contacts (Settings → Clients · KYC)
  const storedSettings = () => { try { return JSON.parse(localStorage.getItem('cdos_settings') || '{}') || {}; } catch (e) { return {}; } };
  const houseRisk = () => storedSettings().defaultClientRisk || 'Normal';
  const refHash = (id) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36).toUpperCase().padStart(5, '0').slice(-5); };

  // Tier ids a later provider can reuse. None of them run, and none of
  // them are priced here: ID checks are not connected, so the desk does
  // not quote a fee or send a customer off to photograph an ID.
  const TEMPLATES = [
    { id: 'quick', label: 'Quick check', tagline: 'Persona is not connected yet. This does not screen the name against a sanctions list.', price: 0, channel: 'instant', icon: 'search', idv: false, bio: false, db: true, smart: false },
    { id: 'verify', label: 'Verified', tagline: 'Persona is not connected yet. This does not authenticate an ID or screen a sanctions list.', price: 0, channel: 'link', icon: 'id', idv: true, bio: false, db: true, smart: false },
    { id: 'plus', label: 'Verified Plus', tagline: 'Persona is not connected yet. This does not run a biometric or a database inquiry.', price: 0, channel: 'link', icon: 'shield', idv: true, bio: true, db: true, smart: false }
  ];
  const tmpl = (id) => TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
  const DURATION = { instant: 5200, link: 9000, records: 600 };
  // do we already hold a verified ID for this subject? (a prior approved document check)
  function onFileVerified(subject) {
    return Object.values(STORE).some(c => c.subject === subject && c.status === 'completed' && c.result && c.result.decision === 'approved' && (c.result.idCheck === 'pass' || c.result.idCheck === 'on file'));
  }

  /* ---------------- store (module singleton + pub/sub) ---------------- */
  const listeners = new Set();
  const load = () => { try { return JSON.parse(localStorage.getItem(KKEY) || '{}') || {}; } catch (e) { return {}; } };
  let STORE = load();
  const persist = () => { try { localStorage.setItem(KKEY, JSON.stringify(STORE)); } catch (e) {} listeners.forEach(l => l()); };
  /* Every check this key has ever held was written here, and this file
     has never sent one to a provider. Leaving them on screen shows a
     verification, an ID read, or a sanctions result that did not happen. */
  if (STORE && Object.keys(STORE).length) { STORE = {}; persist(); }
  const useStore = () => { const [, force] = useState(0); useEffect(() => { const l = () => force(x => x + 1); listeners.add(l); return () => listeners.delete(l); }, []); return STORE; };

  const screenOf = (name) => { try { return window.CDOS._compliance.screen(name); } catch (e) { return { status: 'clear', hits: [] }; } };

  /* extractIdentity used to live here. It hashed the customer's name
     into a street, a city, a date of birth and an ID number, and the
     new-contact flow wrote that onto the file as if a provider had
     read a document. A check does not know those facts. Identity is
     what staff type. See NewContactFlow below. */

  /* A sent check used to resolve here into an approved Persona result:
     document pass, biometric pass, a PSA- reference, and a history
     certificate. Nothing calls this. It does not return that result. */
  function resolve() {
    return null;
  }

  const decisionMeta = (d) => d === 'approved'
    ? { label: 'Verified', c: CD.green, bg: CD.greenSoft, icon: 'checkcircle' }
    : d === 'declined'
      ? { label: 'Declined', c: CD.flag, bg: CD.flagSoft, icon: 'ban' }
      : { label: 'Needs review', c: CD.amber, bg: CD.amberSoft, icon: 'alert' };

  // phase shown while a check is live or done
  function phaseMeta(check) {
    if (check.status === 'completed') return decisionMeta(check.result.decision);
    return { label: check.channel === 'instant' ? 'Running checks…' : 'Awaiting customer…', c: CD.brass, bg: CD.brassSoft, icon: 'clock' };
  }

  /* ---------------- history bridge ---------------- */
  function logToHistory() {
    /* A finished check used to be appended to report history as a
       sealed certificate ("verified via Persona", PSA- reference).
       Persona is not connected, so this writes nothing. */
    return;
  }

  /* ---------------- no invented result ---------------- */
  /* The contact sink used to replay every finished check's generated
     identity onto the client list. It is kept so an older caller does
     not throw, and it does not write a date of birth, an address, or
     an ID number. */
  let contactSink = null;
  function setContactSink(fn) {
    contactSink = fn;
  }
  /* A timer used to sit here. Every 1200ms it took a check still
     marked processing, called resolve(), and filed the answer as a
     finished Persona result — a PSA- reference, document pass,
     biometric pass — then the profile read that as verified. Persona
     is not connected. This does not complete a check, and it does not
     write history. */
  function reconcile() {}

  /* ============================================================
     THE DEMO KYC HISTORY IS GONE, AND THIS IS ITS HEADSTONE

     `seedDemo()` stood here and ran on module load. It fabricated eleven
     COMPLETED identity verifications against named people — Jakob Miller,
     Ashley Turner, Maple Leaf Logistics Inc. and eight more — each with a
     provider reference number ("PSA-…"), each recorded as approved with
     document authenticity, biometric and database screening all passed,
     and each pushed into the report history as a sealed certificate
     footed "retained as a KYC record under the PCMLTFA".

     No provider ever ran those checks. It also reached into the client
     store and EDITED two real contacts to make the demo look better:
     blanking Brooke Lawson's ID fields and back-dating Marcus Reed's
     expiry to 2026-05-15.

     A verification record is the desk's evidence that it identified a
     customer before moving their money. Inventing eleven of them, with
     reference numbers, is not a demo fixture — it is the exact artifact a
     regulator asks for, manufactured. It is gone, and the panel now shows
     what this desk has actually run, which for a new desk is nothing.

     See docs/GENERATED_DOCUMENTS.md: nothing this application presents as
     a record of something having happened may be manufactured in the
     browser.
     ============================================================ */

  function setProvider(name) { PROVIDER = (name || 'Persona').trim() || 'Persona'; try { localStorage.setItem(PKEY, PROVIDER); } catch (e) {} listeners.forEach(l => l()); }
  const getProvider = () => PROVIDER;
  /* The chooser names Persona. Nothing is sent. The phone sheet hides
     the paid verify while this is false. */
  const personaConnected = () => false;

  /* Persona is not connected. A check is not started, not completed,
     and not stored. Callers that still reach this get null and write
     nothing — including the old instant "matched on file" pass. */
  function checksConnected() { return false; }
  function createCheck() {
    return null;
  }
  const checksFor = (name) => Object.values(STORE).filter(c => c.subject === name).sort((a, b) => b.ms - a.ms);
  function summary() {
    /* Spend and counts come from checks this browser invented. Until
       a provider is connected they are not a bill and not a tally. */
    if (!checksConnected()) return { total: 0, monthCount: 0, monthSpend: 0 };
    const all = Object.values(STORE);
    const now = new Date(); const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const month = all.filter(c => (c.requestedAt || '').slice(0, 7) === ym);
    return { total: all.length, monthCount: month.length, monthSpend: month.reduce((s, c) => s + (+c.price || 0), 0) };
  }

  /* ---------------- sealed KYC certificate (opened from History) ---------------- */
  function certHTML(check, settings) {
    settings = settings || storedSettings();
    /* Whose desk, and under whose law. This certificate named "York
       Currency Exchange (MSB)" and cited the PCMLTFA on every desk in
       every country that generated one. Both belong to the desk's own
       settings and its jurisdiction pack; where the pack cannot say, the
       sentence states the fact it has (a verification was performed) and
       does not cite a statute it cannot name. */
    const pack = window.CDOS.deskPack();
    const bizName = (settings && (settings.operatingName || settings.bizName)) || (pack && pack.name ? pack.name + ' desk' : 'this desk');
    const authority = (pack && pack.regulator) || null;
    const r = check.result || {}; const t = tmpl(check.template); const dm = decisionMeta(r.decision);
    const P = { ink: '#262216', mute: '#6f6857', faint: '#9a927e', line: '#e4e0d5', soft: '#f1efe7' };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const rowChk = (l, v) => `<tr><td style="color:${P.mute};font-size:12.5px;padding:6px 0;width:48%;">${esc(l)}</td><td style="font-size:12.5px;padding:6px 0;font-family:'Space Mono',monospace;color:${P.ink};text-transform:capitalize;">${esc(v)}</td></tr>`;
    const wl = (r.watchlist || []).length
      ? `<table style="width:100%;border-collapse:collapse;margin-top:6px;">${r.watchlist.map(h => `<tr><td style="font-size:12px;padding:5px 0;border-bottom:1px solid ${P.soft};">${esc(h.name)} <span style="color:${P.mute};">· ${esc(h.list)} · ${esc(h.program || '')}</span></td><td style="font-size:12px;text-align:right;font-family:'Space Mono',monospace;color:${P.mute};">${h.score}%</td></tr>`).join('')}</table>`
      : `<div style="font-size:12px;color:${P.mute};margin-top:4px;">No database matches returned.</div>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>KYC ${esc(r.reportRef || '')}</title>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
      <style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:40px 46px;color:${P.ink};}@page{margin:14mm;}</style></head>
      <body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${P.ink};padding-bottom:16px;margin-bottom:22px;">
          <div><div style="font-family:'Space Mono',monospace;font-weight:700;font-size:12.5px;letter-spacing:.04em;">CURRENCYDESK OS · KYC</div><div style="font-size:24px;font-weight:800;margin-top:10px;">Identity Verification</div><div style="font-size:12.5px;color:${P.mute};margin-top:2px;">${esc(t.label)} · verified via ${PROVIDER}</div></div>
          <div style="text-align:right;font-size:11px;color:${P.mute};line-height:1.8;"><div style="display:inline-flex;align-items:center;gap:6px;background:${dm.bg};color:${dm.c};font-family:'Space Mono',monospace;font-weight:700;padding:4px 11px;border-radius:6px;">● ${esc(dm.label.toUpperCase())}</div><div style="margin-top:6px;">Ref <b style="color:${P.ink};font-family:'Space Mono',monospace;">${esc(r.reportRef || '')}</b></div><div>${esc(r.completedAt || '')}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:${P.line};border:1px solid ${P.line};margin-bottom:20px;">
          ${[['Subject', check.subject], ['Type', check.kind], ['Requested by', check.by], ['Billed', money(check.price)]].map(k => `<div style="background:#fff;padding:13px 15px;"><div style="font-size:10.5px;color:${P.mute};text-transform:uppercase;letter-spacing:.06em;">${esc(k[0])}</div><div style="font-size:15px;font-weight:700;margin-top:3px;">${esc(k[1])}</div></div>`).join('')}
        </div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${P.faint};font-family:'Space Mono',monospace;margin-bottom:6px;">Checks performed</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
          ${rowChk('Document authenticity', r.idCheck)}${rowChk('Biometric / liveness', r.biometric)}${rowChk('Database screening', r.database)}${rowChk('PEP / adverse media', r.pep)}
        </table>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:${P.faint};font-family:'Space Mono',monospace;margin-bottom:2px;">Database matches</div>
        ${wl}
        <div style="margin-top:22px;font-size:11px;color:${P.faint};line-height:1.6;">Verification performed by ${PROVIDER} on behalf of ${esc(bizName)} and retained as a KYC record${authority ? ` under ${esc(authority)} record-keeping requirements` : ''}. This certificate reflects the provider's automated determination; manual review may be required where matches are returned.</div>
      </body></html>`;
  }
  function openWindow(html) { const w = window.open('', '_blank', 'width=900,height=1100'); if (!w) return; w.document.write(html); w.document.close(); setTimeout(() => w.focus(), 200); }

  /* ====================================================================
     RECORD AN ID — the panel New Transaction opens

     This used to price three checks and offer to text the customer a
     link, and the in-person path said the scanned ID was checked on
     the spot. None of that can run. Staff type the ID.
     ==================================================================== */
  function SendModal({ subject, kind, rec, by, onClose, initialTpl, setClients }) {
    /* Callers still pass the teller and the tier they would have run.
       Neither starts a check. */
    void by;
    void initialTpl;
    rec = rec || {};
    const types = kind === 'corporate' ? BUSINESS_ID_TYPES : PERSON_ID_TYPES;
    const openedType = window.CDOS.displayIdType(rec.idType || '');
    const offered = types.indexOf(openedType) >= 0 && !(window.CDOS.idTypeRefused && window.CDOS.idTypeRefused(openedType));
    const [idType, setIdType] = useState(offered ? openedType : '');
    const openedAside = !!(window.CDOS.idTypeNotAccepted && window.CDOS.idTypeNotAccepted(rec.idType));
    const [idNum, setIdNum] = useState(openedAside ? '' : (rec.idNum || ''));
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState('');
    const fieldStyle = { border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', width: '100%', minWidth: 0, boxSizing: 'border-box' };
    const canSave = !!idType.trim() && !!idNum.trim() && !saving;

    const saveId = async () => {
      const type = idType.trim();
      const num = idNum.trim();
      if (!type || !num || saving) return;
      if (window.CDOS.idTypeRefused && window.CDOS.idTypeRefused(type)) {
        setSaveErr("Health cards can't be used as ID");
        return;
      }
      setSaving(true);
      setSaveErr('');
      const shared = window.CDOS.ClientRecords;
      const clientId = rec.clientId;
      const onServer = !!(shared && shared.serverBacked() && clientId);
      try {
        if (onServer) await shared.record(clientId, { idType: type, idNum: num, source: 'staff' });
        if (setClients && subject) {
          setClients(c => ({ ...c, [subject]: { ...(c[subject] || {}), idType: type, idNum: num, source: 'staff' } }));
        } else if (!onServer) {
          setSaveErr('Could not save this ID. Nothing was saved.');
          return;
        }
      } catch (err) {
        setSaveErr((err && err.message) || 'Could not save this ID. Nothing was saved.');
        return;
      } finally {
        setSaving(false);
      }
      onClose();
    };

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-3" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 520, maxHeight: '92%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="flex items-start gap-3 px-4 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 10 }}><Ic n="id" s={19} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>Record {subject}'s ID</div>
            <div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>ID checks aren't connected. Type the ID type and number from the document.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-4">
          <label className="block mb-3">
            <div className="text-[11px] mb-1" style={{ color: CD.mute }}>{kind === 'corporate' ? 'Document type' : 'ID type'}</div>
            <select autoFocus value={idType} onChange={e => setIdType(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle}>
              <option value="">Choose…</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block">
            <div className="text-[11px] mb-1" style={{ color: CD.mute }}>{kind === 'corporate' ? 'Document number' : 'ID number'}</div>
            <input value={idNum} onChange={e => setIdNum(e.target.value)} placeholder="Number on the document" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...fieldStyle, fontFamily: 'Space Mono, monospace' }} />
          </label>
          {saveErr && <div role="alert" className="mt-3 text-[12.5px]" style={{ color: CD.flag }}>{saveErr}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: CD.panel }}>
          <button type="button" onClick={onClose} className="px-3.5 py-2.5 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute }}>Cancel</button>
          <div className="flex-1" style={{ minWidth: 8 }} />
          <button type="button" onClick={saveId} disabled={!canSave} className="px-4 py-2.5 text-sm font-semibold text-white flex-none" style={{ background: canSave ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: canSave ? 'pointer' : 'not-allowed' }}>{saving ? 'Saving…' : 'Save this ID'}</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ---------------- a single check row ---------------- */
  function CheckRow({ check }) {
    const pm = phaseMeta(check); const t = tmpl(check.template); const live = check.status !== 'completed';
    return (<div className="flex items-center gap-3 px-3 py-2.5" style={{ background: CD.panel, border: `1px solid ${live ? CD.brass : CD.line}`, borderRadius: 11 }}>
      <span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: 9, background: pm.bg }}><Ic n={live ? 'clock' : pm.icon} s={16} c={pm.c} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2"><span className="text-[12.5px] font-semibold" style={{ color: CD.ink }}>{t.label}</span><span className="text-[11px] font-semibold" style={{ color: pm.c }}>{pm.label}</span></div>
        <div className="text-[11px] flex items-center gap-1.5 flex-wrap" style={{ color: CD.mute }}>
          <span>{check.requestedAt}</span><span style={{ color: CD.faint }}>·</span><span>{money(check.price)}</span>
          {check.status === 'completed' && check.result.reportRef && <><span style={{ color: CD.faint }}>·</span><span style={{ fontFamily: 'Space Mono, monospace' }}>{check.result.reportRef}</span></>}
        </div>
      </div>
      {check.status === 'completed'
        ? <button onClick={() => openWindow(certHTML(check))} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.panel }}><Ic n="filetext" s={13} c={CD.mute} /> Certificate</button>
        : <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium flex-none" style={{ color: CD.brass }}><span className="kyc-spin" style={{ width: 12, height: 12, border: `2px solid ${CD.brass}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} /> live</span>}
    </div>);
  }

  /* ====================================================================
     VERIFICATION NUDGE — the occasional “run a quick check” recommendation.
     Two levels:
       • reco  (dismissible) — it has been ≥ recheckDays (default 180) since the
         last provider check, or the subject has never been screened. A gentle
         prompt to run a quick check so the file stays current.
       • force (not dismissible) — the ID on file has EXPIRED. Pushes a full
         re-verify. This is the forcing function.
     Shown on the contact profile and inside the New-Transaction modal. Returns
     null on a healthy, recently-checked file, so it never nags without cause.
     ==================================================================== */
  function daysAgo(ms) { return Math.floor((Date.now() - ms) / 86400000); }
  const NUDGE_CTA = { quick: { label: 'Run quick check', ic: 'search' }, verify: { label: 'Run verify check', ic: 'id' }, plus: { label: 'Run Verify Plus', ic: 'shield' } };
  function VerificationNudge({ name, rec, settings, onRun, onRecordId, demoChecks, amountCad, idRequired }) {
    useStore();
    const [dismissed, setDismissed] = useState(false);
    if (!name) return null;
    const RECO_DAYS = (settings && +settings.recheckDays) || 180;      // periodic quick-screen cadence
    const REVERIFY_DAYS = (settings && +settings.reverifyDays) || 365;  // full re-verification cadence
    /* Live, not a snapshot taken at page load — an ID that expires at
       midnight has expired at 00:01, including on a desk left open. */
    const first = String(name).split(/\s+/)[0];
    const standing = window.CDOS.displayIdStanding(rec, window.CDOS.businessDate());
    const idOk = standing.tone !== 'warning';
    const idExpired = standing.label === 'Expired';
    const riskLvl = (window.CDOS && window.CDOS.normalizeRisk) ? window.CDOS.normalizeRisk(rec && (rec.risk || rec.riskRating)) : (/high|enhanced/i.test(String((rec && (rec.risk || rec.riskRating)) || '')) ? 'High' : 'Normal');
    const highRisk = riskLvl === 'High';
    const done = (demoChecks || checksFor(name)).filter(c => c.status === 'completed' && c.result && c.result.decision === 'approved');
    const lastAny = done.length ? done.reduce((m, c) => (c.ms > m.ms ? c : m)) : null;
    const full = done.filter(c => c.template === 'verify' || c.template === 'plus');
    const lastFull = full.length ? full.reduce((m, c) => (c.ms > m.ms ? c : m)) : null;
    const ageAny = lastAny ? daysAgo(lastAny.ms) : null;
    const ageFull = lastFull ? daysAgo(lastFull.ms) : null;
    // pick the recommended tier from the file's state + house parameters
    /* THE LINE THIS DESK TRADES UNDER, not ten thousand Canadian dollars.
       A desk with no reporting line has no "large transaction" to mandate a
       check on, and the honest answer is to raise no mandate rather than to
       apply another country's number silently — the same reasoning as
       reportingLimit() in cdos-base.jsx and docs/ABSENT_FIGURES.md. */
    const houseLimit = window.CDOS.reportingLimit(settings);
    const TH = houseLimit.amount;
    const THLabel = houseLimit.label;
    const bigDeal = TH != null && amountCad != null && amountCad >= TH;
    const policy = (settings && settings.largeTxCheck) || 'off';   // off | quick | verify | plus — mandatory check on large deals
    const TIER_NAME = { quick: 'Quick', verify: 'Verified', plus: 'Verified Plus' };
    let level = null, tier = 'quick', title = '', reason = '';
    if (idExpired) { level = 'force'; tier = 'verify'; title = 'Re-verification required'; reason = standing.reason || standing.detail; }
    // house mandate outranks the soft recommendation: a set policy is a hard stop on every large deal
    else if (bigDeal && policy !== 'off') { level = 'force'; tier = (!lastFull && policy === 'quick') ? 'verify' : policy; title = 'Check required — large transaction'; reason = `House policy: every deal at or above ${THLabel} requires a ${TIER_NAME[policy]} check — even on a verified profile.` + ((!lastFull && policy === 'quick') ? ` ${first} has never been fully verified, so this first check runs at the Verified tier.` : ''); }
    else if (bigDeal && !lastFull) { level = 'reco'; tier = 'plus'; title = 'Verified Plus recommended'; reason = `First large transaction — this deal is at or above ${THLabel} and ${first} has never been verified. Run the full enhanced check.`; }
    else if (!lastFull) { level = 'reco'; tier = 'verify'; title = 'Verification recommended'; reason = !idOk ? (standing.reason || standing.label) : `${first} has an ID on file but has never been fully verified.`; }
    else if (ageAny != null && ageAny >= RECO_DAYS) { level = 'reco'; tier = 'quick'; title = 'Quick check recommended'; reason = ageAny >= REVERIFY_DAYS ? `${first} was last screened ${ageAny} days ago — over a year. A quick check keeps the file current.` : `Last screened ${ageAny} days ago — a quick check keeps ${first}'s file current.`; }
    else { return null; }
    // house rule: a high-risk subject escalates any identity check to the deepest tier
    // (owner-configurable in Settings → Compliance · Identity verification policy; on by default)
    const ESCALATE_HIGH_RISK = !settings || settings.escalateHighRisk !== false;
    const escalateRisk = highRisk || (riskLvl === 'Medium' && !!(settings && settings.escalateMediumRisk));
    if (ESCALATE_HIGH_RISK && escalateRisk && tier === 'verify') { tier = 'plus'; title = 'Enhanced ' + title.charAt(0).toLowerCase() + title.slice(1); reason += ` ${first} is flagged ${riskLvl.toLowerCase()}-risk — enhanced (Verified Plus) recommended.`; }
    // this deal legally needs a verified ID and the file isn't verified yet → hard stop, not a suggestion
    if (idRequired && !lastFull && level !== 'force') { level = 'force'; title = !idOk ? standing.label : 'Verification required for this deal'; reason = !idOk ? (standing.reason || standing.label) : `This deal needs a verified ID — ${reason.charAt(0).toLowerCase() + reason.slice(1)}`; }
    if (dismissed && level !== 'force') return null;
    const force = level === 'force';
    const BLUE = '#2B50E2';
    const c = force ? CD.flag : BLUE;
    const cta = NUDGE_CTA[tier];
    /* No provider is connected, so this card must not ask for a check.
       A missing or expired ID is recorded by hand. Anything else would
       only repeat the one line on the identity panel. The paid card
       keeps cd-tx-nudge so a phone can hide it while Persona is off. */
    if (!checksConnected()) {
      if (idOk) return null;
      const handTitle = standing.label;
      const handReason = `${standing.reason || standing.detail || standing.label}. Check the client's ID in person and record it on their file.`;
      const canRecord = typeof onRecordId === 'function';
      const hardStop = idExpired || idRequired;
      return (<div className="flex items-start gap-2.5 p-3 mb-2" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 11 }}>
        <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--cd-paper)' }}><Ic n="id" s={15} c={CD.flag} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold" style={{ color: CD.flag }}>{handTitle}</div>
          <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{handReason}</div>
          {(canRecord || !hardStop) && <div className="flex flex-wrap items-center gap-2 mt-2">
            {canRecord && <button type="button" onClick={onRecordId} className="px-2.5 py-1.5 text-[12px] font-semibold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 8 }}>Record the ID</button>}
            {!hardStop && <button type="button" onClick={() => setDismissed(true)} className="px-2 py-1.5 text-[12px] font-medium" style={{ color: CD.mute }}>Not now</button>}
          </div>}
        </div>
      </div>);
    }
    return (<div className="cd-tx-nudge flex items-start gap-2.5 p-3 mb-2" style={{ background: force ? CD.flagSoft : 'rgba(43,80,226,.07)', border: `1px solid ${force ? CD.flag : 'rgba(43,80,226,.32)'}`, borderRadius: 11 }}>
      <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--cd-paper)' }}><Ic n={force ? 'alert' : cta.ic} s={15} c={c} /></span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold" style={{ color: force ? CD.flag : BLUE }}>{title}</div>
        <div className="text-[11.5px] mt-0.5" style={{ color: CD.mute }}>{reason}</div>
        <div className="flex items-center gap-2 mt-2">
          <button type="button" onClick={() => onRun && onRun(tier)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold" style={{ background: c, color: 'var(--cd-on-ink)', borderRadius: 8 }}><Ic n={cta.ic} s={13} c="var(--cd-on-ink)" /> {cta.label}</button>
          {!force && <button onClick={() => setDismissed(true)} className="px-2 py-1.5 text-[12px] font-medium" style={{ color: CD.mute }}>Not now</button>}
        </div>
      </div>
    </div>);
  }

  /* ====================================================================
     SUBJECT PANEL — embedded at the bottom of a contact profile
     ==================================================================== */
  function SubjectPanel({ name, kind, rec, by, setClients, settings, onRecordId }) {
    useStore();
    const [send, setSend] = useState(false);
    const [sendTpl, setSendTpl] = useState('verify');
    const checks = checksConnected() ? checksFor(name) : [];
    const latest = checks[0];
    /* A completed check in this browser is not a provider result, so
       it does not earn verified, verified+, or screened. */
    const isVerPlus = false;
    const isVer = false;
    const isScreened = false;

    return (<div className="p-4" data-testid="client-identity" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 }}>
      <VerificationNudge name={name} rec={rec} settings={settings} onRecordId={onRecordId} onRun={() => { /* A run would open the sender. Persona is not connected, so it does not. */ }} />
      <div className="flex flex-col gap-1 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid place-items-center flex-none" style={{ width: 28, height: 28, borderRadius: 8, background: CD.lineSoft }}><Ic n="id" s={15} c={CD.mute} /></span>
          <div className="min-w-0">
            <div className="text-sm font-semibold flex items-center gap-2" style={{ color: CD.ink }}>Identity verification <window.CDOS.InfoTip title="Identity verification" body="Persona is not connected yet, so this desk does not run a background check or an ID verification. Sanctions screening is not connected yet. Check clients against your government's official lists yourself." /> {isVer ? <span className="text-[10px] px-1.5 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.greenSoft, color: CD.green, borderRadius: 5 }}><Ic n="checkcircle" s={11} c={CD.green} /> {isVerPlus ? PROVIDER + ' verified+' : PROVIDER + ' verified'}</span> : isScreened ? <span className="text-[10px] px-1.5 py-0.5 font-semibold flex items-center gap-1" style={{ background: CD.amberSoft, color: CD.amber, borderRadius: 5 }}><Ic n="search" s={11} c={CD.amber} /> Screened only</span> : null}</div>
            <div className="text-[11px]" data-testid="persona-not-connected" style={{ color: CD.mute }}>Persona is not connected yet.</div>
          </div>
        </div>
        {!checksConnected() && (() => {
          const standing = window.CDOS.displayIdStanding(rec);
          return (<div className="text-[12px] leading-snug" data-testid="kyc-stored-standing" style={{ color: CD.faint }}>{`ID checks not connected yet. ${standing.label}. ${standing.detail}`}</div>);
        })()}
      </div>

      {/* completed-result detail for the latest finished check */}
      {latest && latest.status === 'completed' && (() => { const r = latest.result; const dm = decisionMeta(r.decision); const cell = (l, v) => (
        <div><div className="text-[10px] uppercase tracking-wide" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[12.5px] font-medium capitalize" style={{ color: v === 'pass' ? CD.green : (v === 'hit' || v === 'possible') ? CD.flag : CD.ink }}>{v}</div></div>); return (
        <div className="mb-3 p-3" style={{ background: CD.paper, border: `1px solid ${dm.c}33`, borderRadius: 11 }}>
          <div className="flex items-center gap-2 mb-2.5"><Ic n={dm.icon} s={16} c={dm.c} /><span className="text-[13px] font-semibold" style={{ color: dm.c }}>{dm.label}</span><span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{r.reportRef}</span></div>
          <div className="grid grid-cols-4 gap-2">{cell('Document', r.idCheck)}{cell('Biometric', r.biometric)}{cell('Database', r.database)}{cell('PEP', r.pep === 'None found' ? 'clear' : 'flag')}</div>
          {r.watchlist.length > 0 && <div className="mt-2 pt-2 text-[11.5px]" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.flag }}>{r.watchlist.length} database match{r.watchlist.length === 1 ? '' : 'es'} — {r.watchlist.map(h => h.name).join(', ')}</div>}
        </div>); })()}

      {checks.length ? <div className="space-y-1.5">{checks.map(c => <CheckRow key={c.id} check={c} />)}</div>
        : checksConnected() ? <div className="text-center py-6 text-[12px]" style={{ color: CD.mute }}>No checks on this file yet.</div> : null}

      {send && <SendModal subject={name} kind={kind} rec={rec} by={by} initialTpl={sendTpl} setClients={setClients} onClose={() => setSend(false)} />}
    </div>);
  }

  /* ====================================================================
     PICKER MODAL — Compliance: pick a subject, then send (whole flow)
     ==================================================================== */
  /* ====================================================================
     NEW CONTACT — staff type the ID

     This used to photograph a document, wait on a timer, and write a
     generated address, date of birth and ID number onto the file.
     That generator is gone. ID scanning isn't connected yet, and the
     form says so. A name can be saved on its own. An ID is saved only
     when staff typed both the type and the number.
     ==================================================================== */
  const PERSON_ID_TYPES = ["Passport", "Driver's Licence", "Driver's License", "Provincial ID", "Permanent Resident Card", "Citizenship certificate (2012 or later, no photo)", "Canadian citizenship card (pre-2012)", "Secure Certificate of Indian Status", "Birth certificate"];
  const BUSINESS_ID_TYPES = ["Business Number", "Incorporation Certificate", "Master Business Licence", "Articles of Incorporation"];

  function NewContactFlow({ initialName, by, setClients, onClose, onDone, requireId }) {
    /* `by` is the teller the callers already pass. This form does not
       attribute a provider check to them — there is no check. */
    void by;
    const [name, setName] = useState(initialName || '');
    const [kind, setKind] = useState('individual');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [dob, setDob] = useState('');
    const [address, setAddress] = useState('');
    const [city, setCity] = useState('');
    const [province, setProvince] = useState('');
    const [postal, setPostal] = useState('');
    const [idType, setIdType] = useState('');
    const [idNum, setIdNum] = useState('');
    const [idIssued, setIdIssued] = useState('');
    const [idExpiry, setIdExpiry] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState('');
    const publishedId = useRef(null);
    const types = kind === 'corporate' ? BUSINESS_ID_TYPES : PERSON_ID_TYPES;
    const fieldStyle = { border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', width: '100%', minWidth: 0, boxSizing: 'border-box' };
    const idBits = () => {
      const type = idType.trim();
      const num = idNum.trim();
      return { type, num, started: !!(type || num || idIssued || idExpiry) };
    };

    const writeContact = (nm, extra) => {
      if (!setClients) return;
      setClients(c => ({ ...c, [nm]: {
        ...(c[nm] || {}),
        kind,
        phone: phone.trim(),
        email: email.trim(),
        risk: (c[nm] && c[nm].risk) || houseRisk(),
        createdAt: (c[nm] && c[nm].createdAt) || new Date().toISOString().slice(0, 10),
        ...extra,
      } }));
    };

    /* Returned, not swallowed. The save button is the one caller, and
       it leaves the form open with the server's sentence when this
       rejects. A desk with no server still resolves, so the local
       write below is the file. */
    const publishContact = (nm, extra) => {
      const shared = window.CDOS.ClientRecords;
      if (!shared || !shared.serverBacked()) return Promise.resolve(null);
      const details = Object.assign({
        kind,
        phone: phone.trim(),
        email: email.trim(),
        dob: dob.trim(),
        address: address.trim(),
        city: city.trim(),
        province: province.trim(),
        postal: postal.trim(),
      }, extra || {});
      if (publishedId.current) return shared.record(publishedId.current, details);
      return shared.open(nm, details).then(created => {
        if (created) publishedId.current = created.clientId;
        return created;
      });
    };

    const saveClient = async () => {
      const nm = name.trim();
      if (!nm || saving) return;
      const id = idBits();
      const refused = "Type the ID type and number yourself. ID scanning is not connected, so a record with no staff entry is refused.";
      if (requireId && (!id.type || !id.num)) { setSaveErr(refused); return; }
      if (id.started && (!id.type || !id.num)) {
        setSaveErr("Type both the ID type and the number, or leave both blank. A half-entered ID is not saved.");
        return;
      }
      const extra = {
        dob: dob.trim(),
        address: address.trim(),
        city: city.trim(),
        province: province.trim(),
        postal: postal.trim(),
      };
      if (id.type && window.CDOS.idTypeRefused && window.CDOS.idTypeRefused(id.type)) {
        setSaveErr("Health cards can't be used as ID");
        return;
      }
      if (id.type && id.num) {
        extra.idType = id.type;
        extra.idNum = id.num;
        extra.idIssued = idIssued.trim();
        extra.idExpiry = idExpiry.trim();
        /* applyDocument files a document only when this is "staff". */
        extra.source = 'staff';
      }
      setSaving(true);
      setSaveErr('');
      const shared = window.CDOS.ClientRecords;
      const onServer = !!(shared && shared.serverBacked());
      try {
        if (onServer) {
          const saved = await publishContact(nm, extra);
          if (!saved && !publishedId.current) {
            setSaveErr('Could not save this client. Nothing was saved.');
            return;
          }
        }
      } catch (err) {
        if (err && err.clientId) publishedId.current = err.clientId;
        setSaveErr((err && err.message) || 'Could not save this client. Nothing was saved.');
        return;
      } finally {
        setSaving(false);
      }
      writeContact(nm, extra);
      if (onDone) onDone(nm);
      onClose();
    };

    const Label = ({ children }) => <div className="text-[11px] mb-1" style={{ color: CD.mute }}>{children}</div>;
    const canSave = !!name.trim() && !saving && (!requireId || (idType.trim() && idNum.trim()));

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-3" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 520, maxHeight: '92%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="flex items-start gap-3 px-4 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, background: CD.ink, borderRadius: 10 }}><Ic n="userplus" s={18} c="var(--cd-on-ink)" /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>Add a client</div>
            <div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>ID scanning isn't connected yet. Type the name and the ID from the document.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-4">
          <div className="inline-flex mb-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, overflow: 'hidden' }}>{['individual', 'corporate'].map(k => <button key={k} type="button" onClick={() => { setKind(k); setIdType(''); }} className="px-3.5 py-2 text-[12.5px]" style={{ background: kind === k ? CD.ink : 'transparent', color: kind === k ? 'var(--cd-on-ink)' : CD.mute }}>{k === 'corporate' ? 'Business' : 'Person'}</button>)}</div>
          <label className="block mb-3"><Label>{kind === 'corporate' ? 'Business name' : 'Full name'}</Label><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'corporate' ? 'Acme Imports Ltd.' : 'Jane Doe'} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
          <div className="flex flex-col gap-3">
            <label className="block"><Label>Phone number</Label><input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(416) 555-0100" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...fieldStyle, fontFamily: 'Space Mono, monospace' }} /></label>
            <label className="block"><Label>Email</Label><input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@email.com" className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            {kind !== 'corporate' && <label className="block"><Label>Date of birth</Label><input type="date" value={dob} onChange={e => setDob(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>}
            <label className="block"><Label>Street address</Label><input value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St" className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            <label className="block"><Label>City</Label><input value={city} onChange={e => setCity(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            <label className="block"><Label>Province / region</Label><input value={province} onChange={e => setProvince(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            <label className="block"><Label>Postal code</Label><input value={postal} onChange={e => setPostal(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            <label className="block"><Label>{kind === 'corporate' ? 'Document type' : 'ID type'}</Label>
              <select value={idType} onChange={e => setIdType(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle}>
                <option value="">Choose…</option>
                {types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block"><Label>{kind === 'corporate' ? 'Document number' : 'ID number'}</Label><input value={idNum} onChange={e => setIdNum(e.target.value)} placeholder="Number on the document" className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...fieldStyle, fontFamily: 'Space Mono, monospace' }} /></label>
            <label className="block"><Label>Issued</Label><input type="date" value={idIssued} onChange={e => setIdIssued(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
            <label className="block"><Label>Expiry</Label><input type="date" value={idExpiry} onChange={e => setIdExpiry(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={fieldStyle} /></label>
          </div>
          {saveErr && <div role="alert" className="mt-3 text-[12.5px]" style={{ color: CD.flag }}>{saveErr}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 flex-none" style={{ borderTop: `1px solid ${CD.line}`, background: CD.panel }}>
          <button type="button" onClick={onClose} className="px-3.5 py-2.5 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.mute }}>Cancel</button>
          <div className="flex-1" style={{ minWidth: 8 }} />
          <button type="button" onClick={saveClient} disabled={!canSave} className="px-4 py-2.5 text-sm font-semibold text-white flex-none" style={{ background: canSave ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: canSave ? 'pointer' : 'not-allowed' }}>{saving ? 'Saving…' : 'Save client'}</button>
        </div>
      </div>
    </div></Portal>);
  }

  function PickerModal({ clients, beneficiaries, by, onClose, setClients, onOpenContact }) {
    const [q, setQ] = useState('');
    const [picked, setPicked] = useState(null);   // { name, kind, rec }
    const [adding, setAdding] = useState(false);
    const subjects = useMemo(() => {
      const out = [];
      Object.keys(clients || {}).forEach(n => out.push({ name: n, kind: clients[n].kind === 'corporate' ? 'corporate' : 'individual', rec: clients[n], sub: clients[n].kind === 'corporate' ? 'Business' : 'Individual' }));
      (beneficiaries || []).forEach(b => { if (!out.some(o => o.name === b.name)) out.push({ name: b.name, kind: 'individual', rec: { phone: b.phone }, sub: 'Beneficiary · of ' + b.sender }); });
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }, [clients, beneficiaries]);
    const shown = subjects.filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase()));

    if (adding) return <NewContactFlow initialName={q.trim()} by={by} setClients={setClients} onClose={onClose} requireId={true} />;
    if (picked) return <SendModal subject={picked.name} kind={picked.kind} rec={picked.rec} by={by} setClients={setClients} onClose={onClose} />;

    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9000 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full flex flex-col" style={{ maxWidth: 460, maxHeight: '82%', background: CD.paper, borderRadius: 16, boxShadow: '0 30px 70px -20px var(--cd-scrim)', overflow: 'hidden' }}>
        <div className="flex items-center gap-3 px-5 py-4 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 36, height: 36, background: CD.ink, borderRadius: 10 }}><Ic n="id" s={18} c="var(--cd-on-ink)" /></span>
          <div className="flex-1"><div className="text-[15px] font-semibold leading-tight" style={{ color: CD.ink }}>New KYC verification</div><div className="text-[11.5px]" style={{ color: CD.mute }}>Add someone new, or pick an existing contact · via {PROVIDER}</div></div>
          <button onClick={onClose} className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, color: CD.mute }}><Ic n="x" s={16} /></button>
        </div>

        {/* add new — pinned at the top */}
        <div className="px-3 pt-3 flex-none">
          <button onClick={() => setAdding(true)} className="w-full flex items-center gap-3 px-2.5 py-2.5 text-left" style={{ borderRadius: 11, border: `1.5px solid ${CD.ink}`, background: 'var(--cd-chip)' }}>
            <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: CD.ink }}><Ic n="userplus" s={16} c="var(--cd-on-ink)" /></span>
            <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>Add a new contact</div><div className="text-[11px]" style={{ color: CD.mute }}>Type their name and ID. ID scanning isn't connected yet.</div></div>
            <Ic n="chev" s={15} c={CD.mute} />
          </button>
        </div>

        <div className="px-3 pt-3 pb-1 flex-none">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 9 }}><Ic n="search" s={15} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Or search existing clients & beneficiaries…" className="outline-none text-sm bg-transparent flex-1" /></div>
        </div>
        <div className="flex-1 overflow-auto px-3 pb-3">
          {shown.map(s => (
            <button key={s.name} onClick={() => setPicked(s)} className="w-full flex items-center gap-3 px-2.5 py-2.5 text-left" style={{ borderRadius: 10 }} onMouseEnter={e => e.currentTarget.style.background = CD.panel} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span className="grid place-items-center flex-none" style={{ width: 32, height: 32, borderRadius: s.kind === 'corporate' ? 8 : '50%', background: CD.lineSoft }}><Ic n={s.kind === 'corporate' ? 'building' : 'users'} s={15} c={CD.mute} /></span>
              <div className="flex-1 min-w-0"><div className="text-[13px] font-medium truncate" style={{ color: CD.ink }}>{s.name}</div><div className="text-[11px]" style={{ color: CD.faint }}>{s.sub}</div></div>
              <Ic n="chev" s={14} c={CD.faint} />
            </button>))}
          {!shown.length && (
            <div className="text-center px-4 pt-6 pb-3" style={{ color: CD.faint }}>
              <div className="text-[12.5px]" style={{ color: CD.mute }}>{q ? `No existing contact matches “${q.trim()}”.` : 'No contacts yet.'}</div>
              <div className="text-[11.5px] mt-0.5">Use “Add a new contact” above to onboard them.</div>
            </div>
          )}
        </div>
      </div>
    </div></Portal>);
  }

  // tiny spinner keyframes (once)
  if (!document.getElementById('kyc-spin-kf')) { const st = document.createElement('style'); st.id = 'kyc-spin-kf'; st.textContent = '@keyframes kycspin{to{transform:rotate(360deg)}}.kyc-spin{animation:kycspin .8s linear infinite}'; document.head.appendChild(st); }

  window.CDOS = Object.assign(window.CDOS || {}, { KYC: { TEMPLATES, summary, checksFor, checksConnected, setContactSink, setProvider, getProvider, personaConnected, applyPartnerCode, getPartnerRate, SendModal, SubjectPanel, PickerModal, NewContactFlow, VerificationNudge, decisionMeta, phaseMeta } });
})();
