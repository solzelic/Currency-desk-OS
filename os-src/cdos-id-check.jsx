/* Counter ID check. Notice, consent, in person, returning client,
   the one-time link, the badge, the masked number, and the reveal.
   The words come from the server. Sandbox only. No price and no charge. */
(function () {
  const { useState, useEffect } = React;
  const { CD } = window.CDOS;
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const REVEAL = { supervisor: true, branch_manager: true, compliance_officer: true, administrator: true };
  const REASONS = [
    ["fintrac_request", "FINTRAC request"],
    ["report_filing", "Report filing"],
    ["id_mismatch", "ID mismatch"],
    ["client_request", "Client request"],
  ];
  const REASON_LABEL = { fintrac_request: "FINTRAC request", report_filing: "Report filing", id_mismatch: "ID mismatch", client_request: "Client request" };
  const api = () => (window.CDOS.Backend && window.CDOS.Backend.IdCheck) || null;
  const card = { background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 };
  const inputStyle = { border: `1px solid ${CD.line}`, borderRadius: 8, background: "var(--cd-panel)", color: CD.ink, width: "100%" };
  const btnStyle = (disabled) => ({
    flex: "1 1 160px", minHeight: 44, borderRadius: 8, border: `1px solid ${CD.line}`,
    background: disabled ? "var(--cd-disabled)" : CD.ink, color: disabled ? CD.faint : "var(--cd-on-ink)",
    fontSize: 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
  });
  const ghost = { flex: "1 1 160px", minHeight: 44, borderRadius: 8, border: `1px solid ${CD.line}`, background: "transparent", color: CD.ink, fontSize: 13, fontWeight: 600 };

  function linesOf(text) { return String(text || "").split("\n").filter(Boolean); }
  function inquiryLine(status) {
    if (status === "Check passed" || status === "Check passed (test)") return status;
    if (status === "starting" || status === "in progress") return "ID check in progress";
    if (status === "needs review") return "This needs review. Your compliance officer will review this.";
    if (status === "declined") return "Check not passed. Check the ID at the counter.";
    if (status === "failed" || status === "expired") return "Method not completed. Check the ID at the counter.";
    return "";
  }
  function badgeOf(record) {
    if (!record) return { primary: "", secondary: "" };
    const primary = record.statusLine || record.line || "";
    const secondary = record.line && record.line !== primary ? record.line : "";
    return { primary, secondary };
  }
  function idChoices() {
    try {
      return window.CDOS.acceptedHere(window.CDOS.idTypes().pickerLabels("person"));
    } catch (e) {
      return ["Passport", "Driver's Licence"];
    }
  }

  function CopyBlock({ text, testid }) {
    const parts = linesOf(text);
    return (<div data-testid={testid} className="space-y-2 text-[13px]" style={{ color: CD.ink, lineHeight: 1.45 }}>
      {parts.map((part, i) => {
        const cut = part.indexOf(": ");
        if (i === 0) return <div key={i} className="text-sm font-semibold">{part}</div>;
        if (cut > 0 && cut < 42) return <p key={i}><b>{part.slice(0, cut + 1)}</b> {part.slice(cut + 2)}</p>;
        return <p key={i}>{part}</p>;
      })}
    </div>);
  }

  function Flow({ clientId, dealId, onClose, onDone }) {
    const [step, setStep] = useState("chooser");
    const [copy, setCopy] = useState(null);
    const [pack, setPack] = useState(null);
    const [tier, setTier] = useState("");
    const [agreed, setAgreed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [linkUrl, setLinkUrl] = useState("");
    const [inquiryId, setInquiryId] = useState("");
    const [consentId, setConsentId] = useState("");
    const [databaseMessage, setDatabaseMessage] = useState("");
    const [counterLine, setCounterLine] = useState("");
    const [record, setRecord] = useState(null);
    const [form, setForm] = useState({ nameOnId: "", documentType: "", documentNumber: "", issuingJurisdiction: "", issuingCountry: "CA", expiryDate: "", attested: false });
    const [ret, setRet] = useState({ noDoubts: false, detailsChanged: false, doubtReason: "", pep: "" });

    useEffect(() => {
      const client = api();
      if (!client) return undefined;
      let live = true;
      client.copy().then((body) => { if (live) setCopy(body); }).catch((err) => { if (live) setError(err.message || "The notice could not be read."); });
      client.checks(clientId).then((body) => { if (live) setPack(body); }).catch(() => {});
      return () => { live = false; };
    }, [clientId]);

    useEffect(() => {
      if (step !== "link" || !inquiryId) return undefined;
      let live = true;
      let timer = 0;
      const pull = () => {
        const client = api();
        if (!client) return;
        client.checks(clientId).then((body) => {
          if (!live) return;
          const found = (body.records || []).find((item) => item.personaInquiryId === inquiryId);
          if (!found) { timer = window.setTimeout(pull, 2000); return; }
          const finish = () => {
            setRecord(found);
            setPack(body);
            if (found.result === "method_not_completed") setStep("incomplete");
            else setStep("done");
            if (onDone) onDone(found);
          };
          if (dealId) client.linkDeal(found.recordId, dealId).then(finish).catch(finish);
          else finish();
        }).catch(() => { if (live) timer = window.setTimeout(pull, 2000); });
      };
      timer = window.setTimeout(pull, 600);
      return () => { live = false; window.clearTimeout(timer); };
    }, [step, inquiryId, clientId, dealId, onDone]);

    const counter = !!(copy && copy.counterOnly);
    const pick = (next) => {
      setError("");
      setTier(next);
      if (next === "1") setStep("inperson");
      else if (next === "2") {
        if (!pack) { setError("Reading the earlier check."); return; }
        const full = (pack.records || []).some((item) => item.result === "pass" && item.method !== "returning_client");
        setStep(pack.due || !full ? "blocked" : "returning");
      } else setStep("notice");
    };
    const agree = async () => {
      const client = api();
      if (!client || busy || !agreed) return;
      setBusy(true);
      setError("");
      try {
        const started = await client.start(clientId, tier);
        if (started && started.connected === false) { setError(started.message || "Identity checks are not connected."); setBusy(false); return; }
        const saved = await client.consent({ clientId, choice: "agreed", language: "en", inquiryId: started.providerRef });
        const link = await client.link(started.providerRef);
        setInquiryId(started.providerRef);
        setConsentId(saved.consentId);
        setLinkUrl(link.url);
        setDatabaseMessage(started.message || "");
        setStep("link");
      } catch (err) {
        if (err && (err.code === "COUNTER_ONLY" || /Inspect the original ID/.test(err.message || ""))) {
          setCounterLine(err.message || "");
          setStep("chooser");
        } else setError((err && err.message) || "The ID check could not be started.");
      }
      setBusy(false);
    };
    const noThanks = async () => {
      const client = api();
      if (!client || busy) return;
      setBusy(true);
      setError("");
      try {
        const saved = await client.consent({ clientId, choice: "counter_check", language: "en", inquiryId: null });
        setConsentId(saved.consentId);
        setCounterLine(saved.tellerLine || "Customer chose the counter check. Inspect the original ID.");
        setStep("nothanks");
      } catch (err) {
        setError((err && err.message) || "The choice could not be saved.");
      }
      setBusy(false);
    };
    const savePerson = async () => {
      const client = api();
      if (!client || busy) return;
      setBusy(true);
      setError("");
      try {
        const saved = await client.inPerson({
          clientId, nameOnId: form.nameOnId, documentType: form.documentType, documentNumber: form.documentNumber,
          issuingJurisdiction: form.issuingJurisdiction, issuingCountry: form.issuingCountry,
          expiryDate: form.expiryDate || undefined, attested: form.attested === true,
          dealId: dealId || undefined, consentId: consentId || undefined,
        });
        const body = await client.checks(clientId);
        const found = (body.records || []).find((item) => item.recordId === saved.recordId) || { recordId: saved.recordId, statusLine: "ID checked", line: "ID checked", maskedNumber: saved.maskedNumber, photoLine: saved.photoLine, result: "pass", method: "in_person" };
        setRecord(found);
        setPack(body);
        setStep("done");
        if (onDone) onDone(found);
      } catch (err) {
        setError((err && err.message) || "The ID record could not be saved.");
      }
      setBusy(false);
    };
    const saveReturning = async () => {
      const client = api();
      if (!client || busy || ret.pep !== "yes" && ret.pep !== "no") return;
      setBusy(true);
      setError("");
      try {
        const saved = await client.returning({
          clientId, noDoubts: ret.noDoubts === true, detailsChanged: ret.detailsChanged === true,
          doubtReason: ret.doubtReason || undefined, dealId: dealId || undefined, pepAnswer: ret.pep === "yes",
        });
        const body = await client.checks(clientId);
        const found = (body.records || []).find((item) => item.recordId === saved.recordId);
        setPack(body);
        setRecord(found || null);
        setStep("done");
        if (found && onDone) onDone(found);
      } catch (err) {
        setError((err && err.message) || "Returning client could not be recorded.");
        setStep("blocked");
      }
      setBusy(false);
    };
    const setField = (key, value) => setForm((cur) => ({ ...cur, [key]: value }));
    const shell = (testid, title, body) => (
      <Portal>
        <div data-testid="id-check-flow" className="fixed inset-0 overflow-auto" style={{ background: CD.paper, zIndex: 9400 }}>
          <div className="mx-auto w-full px-4 py-4" style={{ maxWidth: 640 }}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: "Space Mono, monospace" }}>{title}</div>
              <button type="button" onClick={onClose} className="text-[12px] font-medium px-2.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>Close</button>
            </div>
            <div data-testid={testid} className="p-3.5" style={card}>{body}</div>
            {error && <div role="alert" data-testid="id-check-storage" className="text-[13px] mt-3" style={{ color: CD.ink }}>{error}</div>}
          </div>
        </div>
      </Portal>
    );

    if (!copy) return shell("id-check-loading", "ID check", <div className="text-[12.5px]" style={{ color: CD.mute }}>Reading the notice.</div>);

    if (step === "chooser") {
      const tiers = counter ? [["1", "In person", "Staff inspect the original ID. No photo is taken."]] : [
        ["1", "In person", "Staff inspect the original ID. No photo is taken."],
        ["2", "Returning client", "This shop already holds a full ID check. No new provider check."],
        ["3", "ID and selfie", "Document check and a selfie, in the sandbox."],
        ["4", "ID, selfie and database", "The database step is not on yet. This check runs ID and selfie."],
      ];
      return shell(counter ? (copy.quebec ? "id-check-quebec" : "id-check-counter") : "id-check-chooser", "Choose the check", (<div className="space-y-2">
        {(counterLine || (counter && copy.counterLine)) && <div data-testid="id-check-counter-line" className="text-[13px]" style={{ color: CD.ink }}>{counterLine || copy.counterLine}</div>}
        {tiers.map(([id, label, note]) => (
          <button key={id} type="button" onClick={() => pick(id)} className="w-full text-left px-3 py-2.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: "transparent" }}>
            <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{label}</div>
            <div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>{note}</div>
          </button>
        ))}
      </div>));
    }
    if (step === "notice") return shell("id-check-notice", "Before we check your ID", (<div>
      <CopyBlock text={copy.notice} />
      <div className="mt-3"><button type="button" onClick={() => { setAgreed(false); setStep("consent"); }} style={btnStyle(false)}>Continue</button></div>
    </div>));
    if (step === "consent") return shell("id-check-consent", "Optional face match", (<div>
      <CopyBlock text={copy.selfieConsent} />
      <label className="flex items-start gap-2 mt-3 text-[13px]" style={{ color: CD.ink }}>
        <input data-testid="id-check-agree-box" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I agree to the face match.</span>
      </label>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" disabled={!agreed || busy} onClick={agree} style={btnStyle(!agreed || busy)}>{busy ? "Starting" : "I agree"}</button>
        <button type="button" disabled={busy} onClick={noThanks} style={ghost}>No thanks, check my ID at the counter</button>
      </div>
    </div>));
    if (step === "nothanks") return shell("id-check-no-thanks", "Counter check", (<div>
      <div className="text-[13px]" style={{ color: CD.ink }}>{counterLine}</div>
      <div className="mt-3"><button type="button" onClick={() => setStep("inperson")} style={btnStyle(false)}>Enter the ID</button></div>
    </div>));
    if (step === "link") return shell("id-check-link", tier === "4" ? "ID, selfie and database" : "ID and selfie", (<div className="space-y-2">
      {tier === "4" && <div className="text-[13px]" style={{ color: CD.ink }}>{databaseMessage || "The database step is not on yet. This check runs ID and selfie."}</div>}
      <div className="text-[13px]" style={{ color: CD.ink }}>Hand the counter device to the customer. The sandbox check opens at this link.</div>
      <a data-testid="id-check-link-url" href={linkUrl} target="_blank" rel="noopener noreferrer" className="text-[12.5px] break-all" style={{ color: CD.ink }}>{linkUrl}</a>
      <div className="text-[12px]" style={{ color: CD.mute }}>Waiting for the check to finish.</div>
    </div>));
    if (step === "incomplete") return shell("id-check-incomplete", "Method not completed", (<div>
      <div className="text-[13px]" style={{ color: CD.ink }}>Method not completed. Check the ID at the counter.</div>
      <div className="text-[12px] mt-1.5" style={{ color: CD.mute }}>Shows the check done on this date. Not a guarantee of identity.</div>
      <div className="mt-3"><button type="button" onClick={() => setStep("inperson")} style={btnStyle(false)}>Check the ID at the counter</button></div>
    </div>));
    if (step === "blocked") return shell("id-check-returning-blocked", "Returning client", (<div className="space-y-2">
      <div className="text-[13px]" style={{ color: CD.ink }}>{error || (pack && pack.due) || "Returning client needs an earlier ID check at this shop."}</div>
      {pack && pack.due && <div className="text-[12.5px]" style={{ color: CD.mute }}>{pack.due}</div>}
      <div className="text-[12.5px]" style={{ color: CD.mute }}>Offer a full check instead.</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => pick("3")} style={btnStyle(false)}>ID and selfie</button>
        <button type="button" onClick={() => pick("1")} style={ghost}>In person</button>
      </div>
    </div>));
    if (step === "returning") {
      const earlier = (pack && pack.records || []).find((item) => item.result === "pass" && item.method !== "returning_client");
      return shell("id-check-returning", "Returning client", (<div className="space-y-2">
        <div className="text-[13px]" style={{ color: CD.ink }}>{earlier ? `Earlier check: ${earlier.line}` : "No photo on file"}</div>
        <div data-testid="id-check-no-photo" className="text-[12.5px]" style={{ color: CD.mute }}>{earlier && earlier.photoOnFile ? "A small photo from the ID is on file." : "No photo on file"}</div>
        {pack && pack.advice && <div className="text-[12.5px]" style={{ color: CD.ink }}>{pack.advice}</div>}
        <label className="flex items-start gap-2 text-[13px]" style={{ color: CD.ink }}><input type="checkbox" checked={ret.noDoubts} onChange={(e) => setRet((cur) => ({ ...cur, noDoubts: e.target.checked }))} /><span>I have no doubts this is the same person. Name and date of birth match.</span></label>
        <label className="flex items-start gap-2 text-[13px]" style={{ color: CD.ink }}><input type="checkbox" checked={ret.detailsChanged} onChange={(e) => setRet((cur) => ({ ...cur, detailsChanged: e.target.checked }))} /><span>Identifying details have changed.</span></label>
        {(!ret.noDoubts || ret.detailsChanged) && <input value={ret.doubtReason} onChange={(e) => setRet((cur) => ({ ...cur, doubtReason: e.target.value }))} placeholder="Reason, if there is a doubt" className="text-sm px-2.5 py-2 outline-none" style={inputStyle} />}
        <div className="text-[13px]" style={{ color: CD.ink }}>The client says they are a politically exposed person.</div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setRet((cur) => ({ ...cur, pep: "yes" }))} style={{ ...ghost, flex: 1, background: ret.pep === "yes" ? CD.ink : "transparent", color: ret.pep === "yes" ? "var(--cd-on-ink)" : CD.ink }}>Yes</button>
          <button type="button" onClick={() => setRet((cur) => ({ ...cur, pep: "no" }))} style={{ ...ghost, flex: 1, background: ret.pep === "no" ? CD.ink : "transparent", color: ret.pep === "no" ? "var(--cd-on-ink)" : CD.ink }}>No</button>
        </div>
        <button type="button" disabled={busy || (ret.pep !== "yes" && ret.pep !== "no")} onClick={saveReturning} style={btnStyle(busy || (ret.pep !== "yes" && ret.pep !== "no"))}>{busy ? "Saving" : "Record returning client"}</button>
      </div>));
    }
    if (step === "inperson") return shell("id-check-in-person", "In person", (<div className="space-y-2">
      <div className="text-[12.5px]" style={{ color: CD.mute }}>Inspect the original ID. No photo or copy is taken.</div>
      <label className="block text-[12px]" style={{ color: CD.mute }}>Name on the ID<input value={form.nameOnId} onChange={(e) => setField("nameOnId", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px]" style={{ color: CD.mute }}>Document type<select value={form.documentType} onChange={(e) => setField("documentType", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle}><option value="">Choose</option>{idChoices().map((label) => <option key={label}>{label}</option>)}</select></label>
      <label className="block text-[12px]" style={{ color: CD.mute }}>Document number<input value={form.documentNumber} onChange={(e) => setField("documentNumber", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px]" style={{ color: CD.mute }}>Issuer<input value={form.issuingJurisdiction} onChange={(e) => setField("issuingJurisdiction", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
        <label className="block text-[12px]" style={{ color: CD.mute }}>Country<input value={form.issuingCountry} onChange={(e) => setField("issuingCountry", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      </div>
      <label className="block text-[12px]" style={{ color: CD.mute }}>Expiry<input value={form.expiryDate} onChange={(e) => setField("expiryDate", e.target.value)} placeholder="YYYY-MM-DD" className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="flex items-start gap-2 text-[13px]" style={{ color: CD.ink }}><input type="checkbox" checked={form.attested} onChange={(e) => setField("attested", e.target.checked)} /><span>I inspected the original ID. It looked authentic, valid, and not expired, and the face matched.</span></label>
      <button type="button" disabled={busy || !form.attested} onClick={savePerson} style={btnStyle(busy || !form.attested)}>{busy ? "Saving" : "Save the ID record"}</button>
    </div>));
    const shown = record ? badgeOf(record) : { primary: "", secondary: "" };
    return shell("id-check-done", "ID check", (<div className="space-y-1.5">
      <div className="text-[13px]" style={{ color: CD.ink }}>{shown.primary}</div>
      {shown.secondary && <div className="text-[12.5px]" style={{ color: CD.ink }}>{shown.secondary}</div>}
      <div className="text-[12px]" style={{ color: CD.mute }}>{(pack && pack.detail) || "Shows the check done on this date. Not a guarantee of identity."}</div>
      {record && record.maskedNumber && <div className="text-[13px]" style={{ color: CD.ink, fontFamily: "Space Mono, monospace" }}>{record.maskedNumber}</div>}
      {record && record.photoLine && <div className="text-[12.5px]" style={{ color: CD.mute }}>{record.photoLine}</div>}
      <div className="mt-2"><button type="button" onClick={onClose} style={btnStyle(false)}>Done</button></div>
    </div>));
  }

  function Reveal({ record, onClose }) {
    const [reason, setReason] = useState("");
    const [note, setNote] = useState("");
    const [number, setNumber] = useState("");
    const [rows, setRows] = useState([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const load = () => {
      const client = api();
      if (!client) return;
      client.reveals(record.recordId).then((body) => setRows(body.reveals || [])).catch(() => {});
    };
    useEffect(() => { load(); }, [record.recordId]);
    const show = async () => {
      const client = api();
      if (!client || !reason || busy) return;
      setBusy(true);
      setError("");
      try {
        const body = await client.reveal(record.recordId, { reason, note: note.trim() || undefined });
        setNumber(body.number || "");
        load();
      } catch (err) {
        setError((err && err.message) || "The number could not be shown.");
      }
      setBusy(false);
    };
    return (<Portal>
      <div className="fixed inset-0 overflow-auto" style={{ background: "rgba(0,0,0,.45)", zIndex: 9600 }} onClick={onClose}>
        <div data-testid="id-check-reveal" className="mx-auto my-8 p-4" style={{ ...card, maxWidth: 480, background: CD.paper }} onClick={(e) => e.stopPropagation()}>
          <div className="text-sm font-semibold mb-2" style={{ color: CD.ink }}>Show the document number</div>
          <div className="text-[12.5px] mb-2" style={{ color: CD.mute }}>The last 4 are already on the file. The full number is written to the audit, never the number itself.</div>
          <label className="block text-[12px] mb-2" style={{ color: CD.mute }}>Reason<select data-testid="id-check-reveal-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle}><option value="">Choose</option>{REASONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="block text-[12px] mb-2" style={{ color: CD.mute }}>Note, optional<input value={note} onChange={(e) => setNote(e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!reason || busy} onClick={show} style={btnStyle(!reason || busy)}>{busy ? "Showing" : "Show number"}</button>
            <button type="button" onClick={onClose} style={ghost}>Close</button>
          </div>
          {error && <div className="text-[12.5px] mt-2" style={{ color: CD.flag }}>{error}</div>}
          {number && <div data-testid="id-check-revealed" className="text-[14px] mt-3" style={{ color: CD.ink, fontFamily: "Space Mono, monospace" }}>{number}</div>}
          <div data-testid="id-check-audit" className="mt-3">
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: CD.faint, fontFamily: "Space Mono, monospace" }}>Who looked at this number</div>
            {rows.length ? rows.map((row) => (
              <div key={row.revealId} className="text-[12px] py-1" style={{ color: CD.ink, borderTop: `1px solid ${CD.lineSoft}` }}>{REASON_LABEL[row.reason] || row.reason} · {row.role} · {row.date}, {row.time}{row.note ? ` · ${row.note}` : ""}</div>
            )) : <div className="text-[12px]" style={{ color: CD.mute }}>Nobody has looked at the full number.</div>}
          </div>
        </div>
      </div>
    </Portal>);
  }

  function Panel({ clientId, canEdit, dealId }) {
    const [pack, setPack] = useState(null);
    const [status, setStatus] = useState("");
    const [checksOn, setChecksOn] = useState(false);
    const [role, setRole] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [open, setOpen] = useState(false);
    const [reveal, setReveal] = useState(false);
    const [photo, setPhoto] = useState("");
    const [note, setNote] = useState("");
    const [tick, setTick] = useState(0);
    useEffect(() => {
      let live = true;
      fetch("/api/auth/me", { credentials: "same-origin" }).then((res) => res.json()).then((body) => { if (live) setRole((body && body.user && body.user.role) || ""); }).catch(() => {});
      return () => { live = false; };
    }, []);
    useEffect(() => {
      const client = api();
      if (!client || !clientId) return undefined;
      let live = true;
      setLoaded(false);
      Promise.all([
        client.checks(clientId).catch(() => null),
        (window.CDOS.Backend.Clients && window.CDOS.Backend.Clients.idvStatus) ? window.CDOS.Backend.Clients.idvStatus(clientId).catch(() => null) : Promise.resolve(null),
      ]).then(([checks, inquiry]) => {
        if (!live) return;
        setPack(checks);
        setStatus(inquiry && typeof inquiry.status === "string" ? inquiry.status : "");
        setChecksOn(!!(inquiry && inquiry.checksEnabled));
        setLoaded(true);
      });
      return () => { live = false; };
    }, [clientId, tick]);
    const records = (pack && pack.records) || [];
    const latest = records[0] || null;
    const badge = latest ? badgeOf(latest) : { primary: "", secondary: "" };
    const fromInquiry = inquiryLine(status);
    let primary = badge.primary || fromInquiry || (loaded ? "No ID check on file" : "Reading the identity check.");
    let secondary = badge.secondary;
    /* A sandbox key says "Check passed (test)". Any other pass says "Check passed".
       The record line stays underneath either way. */
    if (latest && latest.result === "pass" && (fromInquiry === "Check passed" || fromInquiry === "Check passed (test)") && badge.primary && badge.primary.indexOf(fromInquiry) < 0) {
      secondary = badge.secondary || badge.primary;
      primary = fromInquiry;
    }
    const stale = !!(pack && pack.due) || String(primary).indexOf("Expired") === 0;
    const passed = !stale && (primary === "Check passed" || primary === "Check passed (test)" || (latest && (latest.result === "pass" || latest.result === "returning_confirmed")));
    const canReveal = !!REVEAL[role];
    const showPhoto = async () => {
      const client = api();
      if (!client || !latest) return;
      setNote("");
      try {
        const body = await client.face(latest.recordId, { reason: "eye_comparison" });
        setPhoto(`data:${body.contentType || "image/png"};base64,${body.dataBase64}`);
      } catch (err) {
        setNote((err && err.message) || "No photo on file");
      }
    };
    return (<div data-testid="identity-check" className="mb-3 p-3.5" style={card}>
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: "Space Mono, monospace" }}>Identity check</div>
      <div data-testid="id-check-badge" className="text-[12.5px]" style={{ color: CD.ink }}>{primary}</div>
      {secondary && <div data-testid="id-check-record-line" className="text-[12.5px] mt-1" style={{ color: CD.ink }}>{secondary}</div>}
      {pack && pack.detail && latest && <div className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>{pack.detail}</div>}
      {pack && pack.advice && <div data-testid="id-check-advice" className="text-[12.5px] mt-1.5" style={{ color: CD.ink }}>{pack.advice}</div>}
      {pack && pack.due && <div data-testid="id-check-due" className="text-[12.5px] mt-1.5" style={{ color: CD.ink }}>{pack.due}</div>}
      {latest && latest.maskedNumber && <div data-testid="id-check-masked" className="text-[13px] mt-1.5" style={{ color: CD.ink, fontFamily: "Space Mono, monospace" }}>{latest.maskedNumber}</div>}
      {latest && <div data-testid="id-check-photo-line" className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>{latest.photoOnFile ? "Small photo from the ID, for comparison by eye." : (latest.photoLine || "No photo on file")}</div>}
      {photo && <img alt="Small photo from the ID" src={photo} width={96} height={96} className="mt-2" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />}
      <div className="flex flex-wrap gap-2 mt-2">
        {role !== "auditor" && !passed && <button type="button" data-testid="id-check-start" onClick={() => setOpen(true)} className="text-[12px] font-medium px-2.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: "transparent" }}>{checksOn ? "Check ID" : "Check ID in person"}</button>}
        {canReveal && latest && latest.maskedNumber && <button type="button" data-testid="id-check-reveal-open" onClick={() => setReveal(true)} className="text-[12px] font-medium px-2.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: "transparent" }}>Show number</button>}
        {role && role !== "auditor" && latest && latest.photoOnFile && <button type="button" onClick={showPhoto} className="text-[12px] font-medium px-2.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: "transparent" }}>Show the photo</button>}
      </div>
      {note && <div className="text-[11.5px] mt-1.5" style={{ color: CD.flag }}>{note}</div>}
      <div className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>ID details from a finished check are kept on the server. This screen shows the last 4 of the number.</div>
      <div className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>Persona's ID photo and selfie are not copied to this desk.</div>
      {open && <Flow clientId={clientId} dealId={dealId} onClose={() => { setOpen(false); setTick((n) => n + 1); }} onDone={() => setTick((n) => n + 1)} />}
      {reveal && latest && <Reveal record={latest} onClose={() => setReveal(false)} />}
    </div>);
  }

  function DealBar({ clientId, dealId, onLinked }) {
    const [pack, setPack] = useState(null);
    const [open, setOpen] = useState(false);
    const [tick, setTick] = useState(0);
    useEffect(() => {
      const client = api();
      if (!client || !clientId) return undefined;
      let live = true;
      client.checks(clientId).then((body) => { if (live) setPack(body); }).catch(() => {});
      return () => { live = false; };
    }, [clientId, tick, dealId]);
    const hit = ((pack && pack.records) || []).find((item) => (dealId && ((item.deals || []).indexOf(dealId) >= 0 || item.dealId === dealId))) || null;
    const badge = hit ? badgeOf(hit) : null;
    return (<div data-testid="deal-id-check" className="p-3.5" style={card}>
      <div className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: CD.faint, fontFamily: "Space Mono, monospace" }}>ID check</div>
      {badge ? <div data-testid="deal-id-link" className="text-[12.5px]" style={{ color: CD.ink }}>{badge.primary}{badge.secondary ? `. ${badge.secondary}` : ""}</div> : <div className="text-[12.5px]" style={{ color: CD.mute }}>No ID check linked to this deal.</div>}
      <button type="button" data-testid="deal-check-id" onClick={() => setOpen(true)} className="text-[12px] font-medium px-2.5 py-1 mt-2" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: "transparent" }}>Check ID for this deal</button>
      {open && <Flow clientId={clientId} dealId={dealId} onClose={() => { setOpen(false); setTick((n) => n + 1); }} onDone={(record) => { if (onLinked) onLinked(record); setTick((n) => n + 1); }} />}
    </div>);
  }

  function Settings() {
    const [row, setRow] = useState(null);
    const [note, setNote] = useState("");
    const [saved, setSaved] = useState(false);
    useEffect(() => {
      const client = api();
      if (!client) return undefined;
      let live = true;
      client.settings().then((body) => { if (live) setRow(body); }).catch(() => { if (live) setRow(null); });
      return () => { live = false; };
    }, []);
    if (!row) return null;
    const set = (key, value) => setRow((cur) => ({ ...cur, [key]: value }));
    const save = async () => {
      const client = api();
      if (!client) return;
      setNote("");
      setSaved(false);
      const payload = {
        checksEnabled: row.checksEnabled === true,
        faceCropEnabled: row.faceCropEnabled !== false,
        privacyContact: row.privacyContact || null,
        privacyEmail: row.privacyEmail || null,
        privacyPhone: row.privacyPhone || null,
        privacyPolicyUrl: row.privacyPolicyUrl || null,
      };
      if (row.templateId) payload.templateId = row.templateId;
      if (row.apiKeyRef) payload.apiKeyRef = row.apiKeyRef;
      try {
        const body = await client.saveSettings(payload);
        setRow(body);
        setSaved(true);
      } catch (err) {
        setNote((err && err.message) || "The identity check settings could not be saved.");
      }
    };
    return (<div data-testid="id-check-settings" className="mb-4 p-3.5" style={card}>
      <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>Identity check</div>
      <div className="text-[11.5px] mt-1 mb-2" style={{ color: CD.mute }}>Sandbox only. A small photo from the ID is kept for comparison by eye. It is on unless you turn it off.</div>
      <label className="flex items-center justify-between gap-3 py-1.5 text-[13px]" style={{ color: CD.ink }}><span>Identity checks</span><input type="checkbox" checked={row.checksEnabled === true} onChange={(e) => set("checksEnabled", e.target.checked)} /></label>
      <label className="flex items-center justify-between gap-3 py-1.5 text-[13px]" style={{ color: CD.ink }}><span>Small photo from the ID</span><input data-testid="id-check-crop-switch" type="checkbox" checked={row.faceCropEnabled !== false} onChange={(e) => set("faceCropEnabled", e.target.checked)} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy contact<input value={row.privacyContact || ""} onChange={(e) => set("privacyContact", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy email<input value={row.privacyEmail || ""} onChange={(e) => set("privacyEmail", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy phone<input value={row.privacyPhone || ""} onChange={(e) => set("privacyPhone", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy policy link<input value={row.privacyPolicyUrl || ""} onChange={(e) => set("privacyPolicyUrl", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Sandbox template id<input value={row.templateId || ""} onChange={(e) => set("templateId", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <button type="button" onClick={save} className="text-[12px] font-medium px-2.5 py-1 mt-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink }}>Save identity check settings</button>
      {saved && <div className="text-[12px] mt-1.5" style={{ color: CD.mute }}>Saved.</div>}
      {note && <div className="text-[12px] mt-1.5" style={{ color: CD.flag }}>{note}</div>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { IdCheck: { Panel, Flow, DealBar, Settings } });
})();
