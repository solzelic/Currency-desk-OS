/* Counter ID check. Notice, consent, in person, returning client,
   the one-time link, the badge, the masked number, and the reveal.
   The words come from the server. Sandbox only. No price and no charge. */
(function () {
  const { useState, useEffect, useRef } = React;
  const { CD } = window.CDOS;
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const REVEAL = { supervisor: true, branch_manager: true, compliance_officer: true, administrator: true };
  const CROP = { teller: true, supervisor: true, branch_manager: true, compliance_officer: true, administrator: true };
  function safePersonaLink(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return "";
      if (url.username || url.password) return "";
      if (url.port && url.port !== "443") return "";
      const host = url.hostname.toLowerCase();
      if (host !== "withpersona.com" && !host.endsWith(".withpersona.com")) return "";
      return url.toString();
    } catch (e) {
      return "";
    }
  }
  function safeDiditLink(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:") return "";
      if (url.username || url.password) return "";
      if (url.port && url.port !== "443") return "";
      if (url.hostname.toLowerCase() !== "verify.didit.me") return "";
      return url.toString();
    } catch (e) {
      return "";
    }
  }
  function safeCheckLink(value) {
    return safePersonaLink(value) || safeDiditLink(value);
  }
  const REASONS = [
    ["fintrac_request", "FINTRAC request"],
    ["report_filing", "Report filing"],
    ["id_mismatch", "ID mismatch"],
    ["client_request", "Client request"],
  ];
  const REASON_LABEL = { fintrac_request: "FINTRAC request", report_filing: "Report filing", id_mismatch: "ID mismatch", client_request: "Client request" };
  const ROLE_LABEL = { teller: "Teller", supervisor: "Supervisor", branch_manager: "Branch manager", compliance_officer: "Compliance officer", administrator: "Administrator", auditor: "Auditor" };
  const quietBtn = { minHeight: 44, padding: "0 16px", border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: "transparent", fontFamily: '"Archivo", system-ui, sans-serif' };
  const api = () => (window.CDOS.Backend && window.CDOS.Backend.IdCheck) || null;
  const card = { background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12 };
  const inputStyle = { border: `1px solid ${CD.line}`, borderRadius: 8, background: "var(--cd-panel)", color: CD.ink, width: "100%", fontFamily: '"Archivo", system-ui, sans-serif', minHeight: 44, padding: "0 12px" };
  const btnStyle = (disabled) => ({
    flex: "1 1 160px", minHeight: 44, padding: "0 16px", borderRadius: 8, border: "0",
    background: disabled ? "var(--cd-disabled)" : CD.ink, color: disabled ? "var(--cd-mute)" : "var(--cd-on-ink)",
    fontFamily: '"Archivo", system-ui, sans-serif', fontSize: 14, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  });
  const ghost = {
    flex: "1 1 160px", minHeight: 44, padding: "0 16px", borderRadius: 8, border: `1px solid ${CD.line}`,
    background: CD.paper, color: CD.ink, fontFamily: '"Archivo", system-ui, sans-serif', fontSize: 14, fontWeight: 600,
  };
  const BUTTON_FEEDBACK_MS = 2000;
  function shownLabel(shown, longest) {
    return (
      <span style={{ display: "grid" }}>
        <span data-sizer="true" aria-hidden="true" style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "nowrap" }}>{longest}</span>
        <span data-label="true" style={{ gridArea: "1 / 1", whiteSpace: "nowrap" }}>{shown}</span>
      </span>
    );
  }

  function linesOf(text) { return String(text || "").split("\n").filter(Boolean); }
  /* The cashier reads which provider this shop uses, and what to do.
     ready comes from GET /api/idv/clients/:id and from the consent read.
     A missing shop is not "off": the desk has not heard yet. */
  function idvProviderCopy(shop) {
    if (!shop) return "The identity check status is not available.";
    const didit = shop.provider === "didit";
    const name = didit ? "Didit" : "Persona";
    if (shop.ready === "off") return "Automatic ID checks are off. Check the ID in person instead.";
    if (shop.ready === "privacy_missing") return "Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC.";
    if (shop.ready === "not_configured" || shop.ready === "not_test_shop") {
      return "Automatic ID check with " + name + " is not available for this shop. Check the ID in person instead.";
    }
    if (didit) return "Automatic ID check uses Didit (test).";
    if (shop.sandbox) return "Automatic ID check uses Persona (test).";
    return "Automatic ID check uses Persona.";
  }
  function stopLine(err) {
    const code = err && err.code;
    const message = (err && err.message) || "";
    if (code === "IDV_OFF") return "Identity checks are off for this shop. The owner turns them on in Settings, Clients and KYC.";
    if (code === "PRIVACY_CONTACT") return message || "Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC.";
    if (err && err.status === 503 && (err.reason === "not_available" || code === "not_available")) return "Automatic ID check with Didit is not available for this shop. Check the ID in person instead.";
    if (code === "IDV_PROVIDER" || code === "IDV_KEY" || code === "IDV_CAP" || code === "IDV_TIER") {
      return message || "The ID check did not finish. Try again, or check the ID in person.";
    }
    return "The ID check did not finish. Try again, or check the ID in person.";
  }
  function inquiryLine(status) {
    if (status === "Check passed" || status === "Check passed (test)") return status;
    if (status === "starting" || status === "in progress") return "ID check in progress";
    if (status === "needs review") return "This needs review. A supervisor will help.";
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

  /* Didit only. The teller reads what the customer does.
     A Persona shop and a counter only shop do not show this. */
  const CUSTOMER_STEPS = [
    "The link goes to the customer by email, or you copy a text. The counter device is never handed over.",
    "The customer reads the notice and chooses whether to go ahead. If they say no, check the ID at the counter.",
    "The customer scans their ID and takes a selfie with Didit.",
    "The result comes back to this screen.",
  ];
  const CUSTOMER_BILLING = "Your shop is not billed for a check that is declined, abandoned or expired.";
  function shopFromLine(shop) {
    const name = String(shop || "").trim();
    return /[.!?]$/.test(name) ? "This email comes from " + name : "This email comes from " + name + ".";
  }
  function customerSteps(copy, counter, panel) {
    if (!copy || copy.provider !== "didit" || counter) return null;
    const closed = !!(panel && panel.closed);
    return (
      <div data-testid="id-check-customer-steps" className="min-w-0 w-full" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: "var(--cd-paper-soft)", padding: "12px 14px", boxSizing: "border-box", maxWidth: "100%" }}>
        {panel && panel.onToggle
          ? <button type="button" data-testid="id-check-steps-toggle" aria-expanded={!closed} onClick={panel.onToggle} className="text-[13px] font-semibold w-full text-left" style={{ color: CD.ink, background: "transparent", border: 0, padding: 0, minHeight: 44 }}>What the customer does</button>
          : <div className="text-[13px] font-semibold" style={{ color: CD.ink }}>What the customer does</div>}
        {!closed && <ol className="m-0 mt-2 space-y-1.5" style={{ listStyle: "none", padding: 0 }}>
          {CUSTOMER_STEPS.map((line, i) => (
            <li key={line} className="id-check-step flex items-start gap-2 min-w-0 text-[13px]" style={{ color: CD.ink, lineHeight: 1.45 }}>
              <span className="flex-none" style={{ width: 18, color: CD.mute, fontFamily: '"Space Mono", ui-monospace, monospace', fontSize: 12, lineHeight: 1.45 }}>{i + 1}.</span>
              <span className="id-check-step-text min-w-0 flex-1">{line}</span>
            </li>
          ))}
        </ol>}
        {!closed && <div data-testid="id-check-customer-billing" className="text-[12px] mt-2" style={{ color: CD.mute, lineHeight: 1.45 }}>{CUSTOMER_BILLING}</div>}
      </div>
    );
  }

  function holdSheet() {
    const count = Number(document.body.dataset.idCheckCount || "0") + 1;
    document.body.dataset.idCheckCount = String(count);
    document.body.setAttribute("data-id-check", "open");
    return () => {
      const next = Number(document.body.dataset.idCheckCount || "1") - 1;
      if (next <= 0) {
        delete document.body.dataset.idCheckCount;
        document.body.removeAttribute("data-id-check");
      } else document.body.dataset.idCheckCount = String(next);
    };
  }

  function linkLabel(url, before) {
    if (/Privacy policy:\s*$/.test(before)) return "Privacy policy";
    if (/Persona's privacy notice:\s*$/.test(before)) return "Persona's privacy notice";
    return "Link";
  }
  function linkedParts(part) {
    const re = /https:\/\/[^\s)]+/g;
    const out = [];
    let last = 0;
    let match = re.exec(part);
    while (match) {
      let before = part.slice(last, match.index);
      const raw = match[0];
      const url = raw.replace(/[.,]$/, "");
      const trail = raw.slice(url.length);
      if (!url.startsWith("https://")) {
        if (before) out.push(before);
        out.push(raw);
        last = match.index + raw.length;
        match = re.exec(part);
        continue;
      }
      const label = linkLabel(url, before);
      if (label === "Privacy policy") before = before.replace(/Privacy policy:\s*$/, "");
      if (label === "Persona's privacy notice") before = before.replace(/Persona's privacy notice:\s*$/, "");
      if (before) out.push(before);
      out.push(<a key={url + match.index} href={url} target="_blank" rel="noopener noreferrer" style={{ color: CD.ink, textDecoration: "underline" }}>{label}</a>);
      if (trail) out.push(trail);
      last = match.index + raw.length;
      match = re.exec(part);
    }
    if (last < part.length) out.push(part.slice(last));
    return out.length ? out : [part];
  }
  function CopyBlock({ text, testid, omit }) {
    const skip = omit || [];
    const parts = linesOf(text).filter((part) => skip.indexOf(part) < 0);
    return (<div data-testid={testid} className="space-y-2 text-[13px]" style={{ color: CD.ink, lineHeight: 1.45, fontFamily: '"Archivo", system-ui, sans-serif' }}>
      {parts.map((part, i) => {
        const cut = part.indexOf(": ");
        const body = linkedParts(part);
        if (i === 0) return <div key={i} className="text-sm font-semibold">{body}</div>;
        if (cut > 0 && cut < 42 && !/https?:/.test(part)) return <p key={i}><b>{part.slice(0, cut + 1)}</b> {linkedParts(part.slice(cut + 2))}</p>;
        return <p key={i}>{body}</p>;
      })}
    </div>);
  }

  function Skel({ width }) {
    return <div className="id-check-skel" style={{ width: width || "100%" }} />;
  }
  function Flow({ clientId, dealId, onClose, onDone, initialStep }) {
    const [step, setStep] = useState(initialStep || "chooser");
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
    const [moreOpen, setMoreOpen] = useState(false);
    const [sendTo, setSendTo] = useState("");
    const [sendNote, setSendNote] = useState("");
    const [sendError, setSendError] = useState("");
    const [stepsOpen, setStepsOpen] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const [textCopied, setTextCopied] = useState(false);
    const [liveMessage, setLiveMessage] = useState("");
    const feedbackTimers = useRef({ send: 0, link: 0, text: 0 });
    const mounted = useRef(true);
    const sendBtn = useRef(null);
    const linkBtn = useRef(null);
    const textBtn = useRef(null);
    const clearFeedbackTimer = (key) => {
      const id = feedbackTimers.current[key];
      if (id) window.clearTimeout(id);
      feedbackTimers.current[key] = 0;
    };
    const armFeedback = (key, message, hide) => {
      clearFeedbackTimer(key);
      setLiveMessage(message);
      feedbackTimers.current[key] = window.setTimeout(() => {
        feedbackTimers.current[key] = 0;
        if (!mounted.current) return;
        hide();
        setLiveMessage((cur) => (cur === message ? "" : cur));
      }, BUTTON_FEEDBACK_MS);
    };
    useEffect(() => () => {
      mounted.current = false;
      clearFeedbackTimer("send");
      clearFeedbackTimer("link");
      clearFeedbackTimer("text");
    }, []);
    useEffect(() => {
      if (sendNote === "Email sent." && !busy && sendBtn.current) sendBtn.current.focus();
    }, [sendNote, busy]);
    useEffect(() => {
      if (linkCopied && linkBtn.current) linkBtn.current.focus();
    }, [linkCopied]);
    useEffect(() => {
      if (textCopied && textBtn.current) textBtn.current.focus();
    }, [textCopied]);

    useEffect(() => holdSheet(), []);
    useEffect(() => {
      const client = api();
      if (!client) return undefined;
      let live = true;
      client.copy().then((body) => { if (live) setCopy(body); }).catch((err) => { if (live) setError(err.message || "The notice could not be read."); });
      client.checks(clientId).then((body) => { if (live) setPack(body); }).catch(() => {});
      const clients = window.CDOS.Backend && window.CDOS.Backend.Clients;
      if (clients && clients.get) {
        clients.get(clientId).then((body) => {
          if (live && body && body.email) setSendTo((cur) => cur || String(body.email));
        }).catch(() => {});
      }
      return () => { live = false; };
    }, [clientId]);

    useEffect(() => {
      if (step !== "link" || !inquiryId) return undefined;
      let live = true;
      let timer = 0;
      const waitMs = (window.CDOS && window.CDOS.idCheckWaitMs) || 90000;
      const giveUpTimer = window.setTimeout(() => { if (live) setStep("failed"); }, waitMs);
      const onGiveUp = () => { if (live) setStep("failed"); };
      window.addEventListener("cdos-id-check-give-up", onGiveUp);
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
            if (found.result === "method_not_completed") setStep("failed");
            else setStep("done");
            if (onDone) onDone(found);
          };
          if (dealId) client.linkDeal(found.recordId, dealId).then(finish).catch(finish);
          else finish();
        }).catch(() => { if (live) timer = window.setTimeout(pull, 2000); });
      };
      timer = window.setTimeout(pull, 600);
      return () => { live = false; window.clearTimeout(timer); window.clearTimeout(giveUpTimer); window.removeEventListener("cdos-id-check-give-up", onGiveUp); };
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
      } else if (next === "4") return;
      else setStep("notice");
    };
    useEffect(() => {
      const onKey = (event) => {
        if (event.key === "Escape") { onClose(); return; }
        if (event.key !== "Enter" || step !== "chooser") return;
        const target = event.target;
        if (target && target.closest && target.closest("button, a, input, select, textarea")) return;
        event.preventDefault();
        pick(counter ? "1" : "3");
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [step, counter, onClose, pack]);
    const agree = async () => {
      const client = api();
      if (!client || busy || !agreed) return;
      setBusy(true);
      setError("");
      setStep("opening");
      try {
        const started = await client.start(clientId, tier);
        if (started && started.connected === false) {
          setError(started.message || "Identity checks are not connected.");
          setStep("consent");
          setBusy(false);
          return;
        }
        const saved = await client.consent({
          clientId, choice: "agreed", language: "en", inquiryId: started.providerRef,
          copyVersion: copy && copy.version, faceCropShown: !!(copy && copy.faceCrop),
        });
        const link = await client.link(started.providerRef);
        setInquiryId(started.providerRef);
        setConsentId(saved.consentId);
        setLinkUrl(safeCheckLink(link.url));
        setDatabaseMessage(started.message || "");
        setStep("link");
      } catch (err) {
        if (err && (err.code === "consent_copy_changed" || /notice changed/i.test((err && err.message) || ""))) {
          const fresh = await client.copy().catch(() => null);
          if (fresh) setCopy(fresh);
          setAgreed(false);
          setStep("notice");
          setError((err && err.message) || "The notice changed. Read it again before you choose.");
        } else if (err && (err.code === "COUNTER_ONLY" || /Inspect the original ID/.test(err.message || ""))) {
          setCounterLine(err.message || "");
          setStep("chooser");
        } else {
          setError(stopLine(err));
          setStep("failed");
        }
      }
      setBusy(false);
    };
    const noThanks = async () => {
      const client = api();
      if (!client || busy) return;
      setBusy(true);
      setError("");
      try {
        const saved = await client.consent({
          clientId, choice: "counter_check", language: "en", inquiryId: null,
          copyVersion: copy && copy.version, faceCropShown: !!(copy && copy.faceCrop),
        });
        setConsentId(saved.consentId);
        setCounterLine(saved.tellerLine || "Customer chose the counter check. Inspect the original ID.");
        setStep("nothanks");
      } catch (err) {
        if (err && (err.code === "consent_copy_changed" || /notice changed/i.test((err && err.message) || ""))) {
          const fresh = await client.copy().catch(() => null);
          if (fresh) setCopy(fresh);
          setAgreed(false);
          setStep("notice");
          setError((err && err.message) || "The notice changed. Read it again before you choose.");
        } else setError((err && err.message) || "The choice could not be saved.");
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
        const found = (body.records || []).find((item) => item.recordId === saved.recordId) || { recordId: saved.recordId, statusLine: "Not checked", line: "Not checked", maskedNumber: null, photoLine: "No photo on file", result: "method_not_completed", method: "in_person" };
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
          doubtReason: ret.doubtReason || undefined, dealId: dealId || undefined, pepAnswer: ret.pep,
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
    const linkMessage = (shop, url, contact) => `${shop} sent you this link to complete your ID check:\n${url}\n\nIf you did not ask for this, you can ignore it, or contact ${shop} at ${contact}.`;
    const emailOk = (value) => {
      const email = String(value || "").trim();
      return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    };
    const emailBad = sendTo.trim().length > 0 && !emailOk(sendTo);
    const copyValue = async (value) => {
      setSendError("");
      await navigator.clipboard.writeText(value);
    };
    const sendEmailLink = async () => {
      const client = api();
      if (!client || !inquiryId || busy || !emailOk(sendTo)) return;
      clearFeedbackTimer("send");
      setBusy(true);
      setSendError("");
      setSendNote("");
      setLiveMessage((cur) => (cur === "Email sent." ? "" : cur));
      try {
        await client.sendLink(inquiryId, { email: sendTo.trim() });
        setSendNote("Email sent.");
        armFeedback("send", "Email sent.", () => setSendNote(""));
      } catch (err) {
        setSendNote("");
        setSendError((err && err.message) || "The email didn't go. Try again, or use Copy link.");
      }
      setBusy(false);
    };
    const copyLink = async () => {
      const client = api();
      if (!client || !inquiryId || !linkUrl) return;
      clearFeedbackTimer("link");
      setLinkCopied(false);
      setSendError("");
      setLiveMessage((cur) => (cur === "Link copied." ? "" : cur));
      try {
        await client.noteLink(inquiryId, { kind: "link" });
        await copyValue(linkUrl);
        setLinkCopied(true);
        armFeedback("link", "Link copied.", () => setLinkCopied(false));
      } catch (err) {
        setLinkCopied(false);
        setSendError((err && err.message) || "The link was not copied. Try again.");
      }
    };
    const copyText = async () => {
      const client = api();
      if (!client || !inquiryId || !linkUrl) return;
      clearFeedbackTimer("text");
      setTextCopied(false);
      setSendError("");
      setLiveMessage((cur) => (cur === "Text copied." ? "" : cur));
      try {
        const noted = await client.noteLink(inquiryId, { kind: "text" });
        const shop = noted && noted.shop;
        const contact = noted && noted.contact;
        const text = (noted && noted.text) || (shop && contact ? linkMessage(shop, linkUrl, contact) : "");
        if (!text) {
          setTextCopied(false);
          setSendError("The text was not copied. Try again.");
          return;
        }
        await copyValue(text);
        setTextCopied(true);
        armFeedback("text", "Text copied.", () => setTextCopied(false));
      } catch (err) {
        setTextCopied(false);
        setSendError((err && err.message) || "The text was not copied. Try again.");
      }
    };
    const shell = (testid, title, body) => (
      <Portal>
        <div data-testid="id-check-flow" tabIndex={-1} className="fixed inset-0 flex items-center justify-center overflow-auto p-3 md:p-6" style={{ background: "var(--cd-scrim)", zIndex: 9400 }}>
          <div className="id-check-sheet w-full" style={{ maxWidth: 560, background: CD.paper, border: `1px solid ${CD.line}`, borderRadius: 16, boxShadow: "0 30px 70px -20px var(--cd-scrim)", fontFamily: '"Archivo", system-ui, sans-serif', color: CD.ink }}>
            <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
              <div className="id-check-kicker text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: '"Space Mono", monospace' }}>{title}</div>
              <button type="button" data-testid="id-check-close" onClick={onClose} className="text-[13px] font-medium" style={{ minHeight: 44, padding: "0 16px", border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.ink, background: CD.paper, fontFamily: '"Archivo", system-ui, sans-serif' }}>Close</button>
            </div>
            <div data-testid={testid} className="px-5 py-4">{body}</div>
            {error && step !== "failed" && step !== "incomplete" && <div role="alert" data-testid="id-check-storage" className="text-[13px] px-5 pb-4" style={{ color: CD.ink }}>{error}</div>}
          </div>
        </div>
      </Portal>
    );

    if (!copy) return shell("id-check-loading", "ID check", (<div data-testid="id-check-loading" className="space-y-3" aria-busy="true"><Skel /><Skel width="70%" /><Skel width="46%" /></div>));

    if (step === "chooser") {
      const records = (pack && pack.records) || [];
      const full = records.some((item) => item.result === "pass" && item.method !== "returning_client");
      const primary = counter
        ? { id: "1", label: "In person", note: "Staff inspect the original ID. No photo is taken." }
        : { id: "3", label: "ID and selfie", note: "Document check and a selfie." };
      const more = [];
      if (!counter && primary.id !== "1") more.push({ id: "1", label: "In person", note: "Staff inspect the original ID. No photo is taken." });
      if (!counter && full) more.push({ id: "2", label: "Returning client", note: "Reuse the check on file." });
      const tier4Off = !counter && copy.tier4 === "unavailable";
      return shell(counter ? (copy.quebec ? "id-check-quebec" : "id-check-counter") : "id-check-chooser", "Choose the check", (<div className="space-y-3" style={{ paddingBottom: 16 }}>
        {(counterLine || (counter && copy.counterLine)) && <div data-testid="id-check-counter-line" className="text-[13px]" style={{ color: CD.ink }}>{counterLine || copy.counterLine}</div>}
        <button data-testid="id-check-primary" type="button" onClick={() => pick(primary.id)} className="w-full text-left" style={{ ...btnStyle(false), flex: "none", minHeight: 72, padding: "14px 16px", borderRadius: 12 }}>
          <div className="text-[16px] font-semibold">{primary.label}</div>
          <div className="text-[13px] mt-1" style={{ color: "var(--cd-on-ink)", opacity: 0.82 }}>{primary.note}</div>
        </button>
        {customerSteps(copy, counter)}
        {(more.length > 0 || tier4Off) && <div data-testid="id-check-more">
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)} className="w-full" style={{ minHeight: 44, padding: "0 16px", borderRadius: 10, border: `1px solid ${CD.line}`, background: "transparent", color: CD.ink, display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: '"Archivo", system-ui, sans-serif', fontSize: 14, fontWeight: 600 }}>
            <span>More options</span>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" style={{ flex: "none", transform: moreOpen ? "rotate(180deg)" : "none" }}><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {moreOpen && <div data-testid="id-check-more-list" className="space-y-2 mt-2" style={{ height: "auto", overflow: "visible" }}>
            {more.map((item) => (
              <button key={item.id} type="button" data-testid={"id-check-more-" + item.id} onClick={() => pick(item.id)} className="w-full min-w-0 text-left px-4 py-2.5" style={{ minHeight: 44, height: "auto", overflow: "visible", boxSizing: "border-box", border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.paper, color: CD.ink, whiteSpace: "normal" }}>
                <div className="text-[14px] font-semibold">{item.label}</div>
                <div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>{item.note}</div>
              </button>
            ))}
            {tier4Off && <div data-testid="id-check-tier4" aria-disabled="true" className="w-full min-w-0 text-left px-4 py-2.5" style={{ minHeight: 44, height: "auto", overflow: "visible", boxSizing: "border-box", border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.paper, color: CD.mute, whiteSpace: "normal", cursor: "default" }}>
              <div className="text-[14px] font-semibold" style={{ color: CD.mute }}>ID, selfie and database</div>
              <div className="text-[12px] mt-0.5" style={{ color: CD.mute }}>ID, selfie and database checks are not available yet.</div>
            </div>}
          </div>}
        </div>}
      </div>));
    }
    if (step === "opening") return shell("id-check-opening", "ID and selfie", (<div data-testid="id-check-loading" className="space-y-3" aria-busy="true"><Skel /><Skel width="78%" /><Skel width="42%" /></div>));
    if (step === "notice") return shell("id-check-notice", "Before we check your ID", (<div>
      <CopyBlock text={copy.notice} />
      <div className="mt-3"><button type="button" onClick={() => { setAgreed(false); setStep("consent"); }} style={btnStyle(false)}>Continue</button></div>
    </div>));
    if (step === "consent") return shell("id-check-consent", "Optional face match", (<div>
      <CopyBlock text={copy.selfieConsent} omit={["I agree to the face match."]} />
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
    if (step === "link") {
      const narrow = typeof window !== "undefined" && window.innerWidth <= 430;
      const emailFailed = sendError === "The email didn't go. Try again, or use Copy link.";
      return shell("id-check-link", tier === "4" ? "ID, selfie and database" : "ID and selfie", (<div className="space-y-2">
      {tier === "4" && <div className="text-[13px]" style={{ color: CD.ink }}>{databaseMessage || "The database step is not on yet. This check runs ID and selfie."}</div>}
      {customerSteps(copy, counter, { closed: narrow && !stepsOpen, onToggle: () => setStepsOpen((open) => !open) })}
      {copy && copy.provider === "didit" && linkUrl && <div data-testid="id-check-send" className="space-y-2 min-w-0">
        {copy.shopName ? <div data-testid="id-check-from-shop" className="text-[13px]" style={{ color: CD.ink }}>{shopFromLine(copy.shopName)}</div> : null}
        <label className="block text-[12px]" style={{ color: CD.mute }}>Email
          <input data-testid="id-check-send-email" value={sendTo} disabled={busy} onChange={(e) => { setSendTo(e.target.value); setSendNote(""); }} aria-invalid={emailBad} className="text-sm px-2.5 py-2 outline-none mt-1" style={{ ...inputStyle, border: emailBad ? `1px solid ${CD.flag}` : inputStyle.border }} />
        </label>
        {emailBad && <div data-testid="id-check-email-invalid" className="text-[13px]" style={{ color: CD.flag }}>That email is not valid.</div>}
        <div className="flex flex-wrap gap-2">
          <button ref={sendBtn} type="button" data-testid="id-check-send-email-btn" disabled={busy || !emailOk(sendTo)} onClick={sendEmailLink} style={btnStyle(busy || !emailOk(sendTo))}>{shownLabel(busy ? "Sending" : sendNote === "Email sent." ? "Email sent." : "Send", "Email sent.")}</button>
          <button ref={linkBtn} type="button" data-testid="id-check-copy-link" onClick={copyLink} style={ghost}>{shownLabel(linkCopied ? "Link copied." : "Copy link", "Link copied.")}</button>
          <button ref={textBtn} type="button" data-testid="id-check-copy-text" onClick={copyText} style={ghost}>{shownLabel(textCopied ? "Text copied." : "Copy text", "Text copied.")}</button>
        </div>
        <div role="status" aria-live="polite" data-testid="id-check-confirm" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>{liveMessage}</div>
        {emailFailed && <div data-testid="id-check-send-error" className="space-y-2">
          <div className="text-[13px]" style={{ color: CD.flag }}>The email didn't go. Try again, or use Copy link.</div>
          <button type="button" data-testid="id-check-try-again" onClick={sendEmailLink} style={ghost}>Try again</button>
        </div>}
        {sendError && !emailFailed && <div data-testid="id-check-send-error" className="text-[13px]" style={{ color: CD.ink }}>{sendError}</div>}
      </div>}
      {linkUrl
        ? <a data-testid="id-check-link-url" href={linkUrl} target="_blank" rel="noopener noreferrer" className="id-check-figure text-[12.5px] break-all" style={{ color: CD.ink }}>{linkUrl}</a>
        : <div data-testid="id-check-link-url" className="text-[13px]" style={{ color: CD.ink }}>The ID check link could not be opened.</div>}
      <div data-testid="id-check-result-wait" className="space-y-2 mt-3" aria-busy="true">
        <div className="text-[13px]" style={{ color: CD.ink }}>Waiting for the customer</div>
        <Skel width="58%" /><Skel width="36%" /><Skel width="24%" />
      </div>
    </div>));
    }
    if (step === "attest") {
      const words = window.CDOS.faceMatchAttestation.statement;
      return shell("id-check-attest", "Compare the face", (<div className="space-y-3">
        <label className="flex items-start gap-2 text-[13px]" style={{ color: CD.ink }}>
          <input data-testid="id-check-attest-box" type="checkbox" />
          <span>{words}</span>
        </label>
      </div>));
    }
    if (step === "failed" || step === "incomplete") return shell("id-check-incomplete", "ID check", (<div data-testid="id-check-error" className="space-y-3">
      <div className="text-[13px]" style={{ color: CD.ink }}>{error || "The ID check did not finish. Try again, or check the ID in person."}</div>
      <button type="button" data-testid="id-check-error-in-person" onClick={() => { setError(""); setStep("inperson"); }} style={btnStyle(false)}>Check the ID in person</button>
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
        <div className="text-[13px]" style={{ color: CD.ink }}>Is this person, or a family member or close associate, a politically exposed person or the head of an international organization?</div>
        <div className="flex gap-2">
          {[["yes", "Yes"], ["no", "No"], ["not_asked", "Not asked"]].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setRet((cur) => ({ ...cur, pep: id }))} style={{ ...ghost, flex: 1, background: ret.pep === id ? CD.ink : "transparent", color: ret.pep === id ? "var(--cd-on-ink)" : CD.ink }}>{label}</button>
          ))}
        </div>
        <button type="button" disabled={busy || (ret.pep !== "yes" && ret.pep !== "no" && ret.pep !== "not_asked")} onClick={saveReturning} style={btnStyle(busy || (ret.pep !== "yes" && ret.pep !== "no" && ret.pep !== "not_asked"))}>{busy ? "Saving" : "Record returning client"}</button>
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
      <label className="block text-[12px]" style={{ color: CD.mute }}>Expiry date<input type="date" value={form.expiryDate} onChange={(e) => setField("expiryDate", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="id-check-attest flex w-full min-w-0 max-w-full items-start gap-2 text-[13px]" style={{ color: CD.ink }}><input className="flex-none" type="checkbox" checked={form.attested} onChange={(e) => setField("attested", e.target.checked)} /><span className="min-w-0 flex-1" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>I inspected the original ID. It looked authentic, valid, and not expired, and the face matched.</span></label>
      <button type="button" disabled={busy || !form.attested} onClick={savePerson} style={btnStyle(busy || !form.attested)}>{busy ? "Saving" : "Save the ID record"}</button>
    </div>));
    const shown = record ? badgeOf(record) : { primary: "", secondary: "" };
    return shell("id-check-done", "ID check", (<div className="space-y-1.5">
      <div className="text-[13px]" style={{ color: CD.ink }}>{shown.primary}</div>
      {shown.secondary && <div className="text-[12.5px]" style={{ color: CD.ink }}>{shown.secondary}</div>}
      <div className="text-[12px]" style={{ color: CD.mute }}>{(pack && pack.detail) || "Shows the check done on this date. Not a guarantee of identity."}</div>
      {record && record.maskedNumber && <div className="id-check-figure text-[13px]" style={{ color: CD.ink, fontFamily: "Space Mono, monospace" }}>{record.maskedNumber}</div>}
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
    useEffect(() => {
      setNumber("");
      setReason("");
      setNote("");
      setError("");
      setRows([]);
      load();
    }, [record.recordId]);
    useEffect(() => holdSheet(), []);
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
          <div className="text-[12.5px] mb-2" style={{ color: CD.mute }}>Each time someone shows the full number, it is written to the audit. The number itself is never written there.</div>
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
              <div key={row.revealId} className="text-[12px] py-1" style={{ color: CD.ink, borderTop: `1px solid ${CD.lineSoft}` }}>{REASON_LABEL[row.reason] || row.reason} · {ROLE_LABEL[row.role] || row.role} · {row.date}, {row.time}{row.note ? ` · ${row.note}` : ""}</div>
            )) : <div className="text-[12px]" style={{ color: CD.mute }}>Nobody has looked at the full number.</div>}
          </div>
        </div>
      </div>
    </Portal>);
  }

  function retentionSentence(latest, typedOnly) {
    if (!latest) {
      return typedOnly ? "ID typed by hand, not checked. Check the ID to record it." : "";
    }
    if (latest.numberUnavailable) return "No ID number was recorded for this check.";
    if (latest.method === "in_person" && latest.maskedNumber) {
      return "The ID number is stored encrypted. Only the last 4 are shown.";
    }
    if (latest.maskedNumber) {
      return "ID details from this check are kept on the server. Only the last 4 of the number are shown.";
    }
    if (latest.method === "id_and_selfie" || latest.method === "id_selfie_database") {
      return "ID scanned. No ID number stored.";
    }
    return "No ID number was recorded for this check.";
  }

  function Panel({ clientId, canEdit, dealId }) {
    const [pack, setPack] = useState(null);
    const [status, setStatus] = useState("");
    const [checksOn, setChecksOn] = useState(false);
    const [role, setRole] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [open, setOpen] = useState(false);
    const [startAt, setStartAt] = useState("chooser");
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
      const onOpen = (event) => {
        if (!event.detail || event.detail.clientId !== clientId) return;
        setStartAt("inperson");
        setOpen(true);
      };
      window.addEventListener("cdos-open-in-person", onOpen);
      return () => window.removeEventListener("cdos-open-in-person", onOpen);
    }, [clientId]);
    useEffect(() => {
      setPhoto("");
      setReveal(false);
      setNote("");
    }, [clientId]);
    useEffect(() => {
      const client = api();
      if (!client || !clientId) return undefined;
      let live = true;
      setPhoto("");
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
    const roster = (window.CDOS && window.CDOS.clientRoster) || {};
    const typedOnly = !latest && Object.keys(roster).some((key) => {
      const rec = roster[key];
      return rec && rec.clientId === clientId && rec.idType && rec.idNum;
    });
    let primary = badge.primary || fromInquiry || (loaded ? (typedOnly ? "ID typed by hand, not checked" : "No ID check on file") : "Reading the identity check.");
    let secondary = badge.secondary;
    /* A sandbox key says "Check passed (test)". Any other pass says "Check passed".
       The record line stays underneath either way. */
    if (latest && latest.result === "pass" && (fromInquiry === "Check passed" || fromInquiry === "Check passed (test)") && badge.primary && badge.primary.indexOf(fromInquiry) < 0 && String(badge.primary).indexOf("ID checked") === 0) {
      secondary = badge.secondary || badge.primary;
      primary = fromInquiry;
    }
    const stale = !!(pack && pack.due) || String(primary).indexOf("Expired") === 0;
    const advised = !!(pack && pack.advice);
    const passed = !stale && !advised && (primary === "Check passed" || primary === "Check passed (test)" || (latest && (latest.result === "pass" || latest.result === "returning_confirmed")));
    const sentence = loaded ? retentionSentence(latest, typedOnly) : "";
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
      {latest && latest.maskedNumber && <div data-testid="id-check-masked" className="id-check-figure text-[13px] mt-1.5" style={{ color: CD.ink, fontFamily: "Space Mono, monospace" }}>{latest.maskedNumber}</div>}
      {latest && !photo && <div data-testid="id-check-photo-line" className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>{latest.photoOnFile ? "Photo from ID, for comparison by eye" : (latest.photoLine || "No photo on file")}</div>}
      {photo && <figure className="mt-2">
        <img data-testid="id-check-photo" alt="Photo from ID, for comparison by eye" src={photo} width={96} height={96} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, background: "#E4E1D8" }} />
        <figcaption className="text-[11px] mt-1" style={{ color: CD.mute, fontFamily: '"Space Mono", monospace' }}>Photo from ID, for comparison by eye</figcaption>
      </figure>}
      <div className="flex flex-wrap gap-2 mt-2">
        {role !== "auditor" && !passed && <button type="button" data-testid="id-check-start" onClick={() => { setStartAt("chooser"); setOpen(true); }} className="text-[12px] font-medium" style={quietBtn}>{checksOn ? "Check ID" : "Check ID in person"}</button>}
        {canReveal && latest && latest.maskedNumber && <button type="button" data-testid="id-check-reveal-open" onClick={() => setReveal(true)} className="text-[12px] font-medium" style={quietBtn}>Show number</button>}
        {CROP[role] && latest && latest.photoOnFile && <button type="button" onClick={showPhoto} className="text-[12px] font-medium" style={quietBtn}>Show the photo</button>}
      </div>
      {note && <div className="text-[11.5px] mt-1.5" style={{ color: CD.flag }}>{note}</div>}
      {sentence ? <div data-testid="id-check-retention" className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>{sentence}</div> : null}
      {latest && latest.photoOnFile && <div className="text-[11.5px] mt-1.5" style={{ color: CD.mute }}>Persona's full ID images and selfie are not copied to this desk. Only a small photo from the ID is kept, for comparison by eye.</div>}
      {open && <Flow clientId={clientId} dealId={dealId} initialStep={startAt} onClose={() => { setOpen(false); setTick((n) => n + 1); }} onDone={() => { window.dispatchEvent(new CustomEvent("cdos-id-standing", { detail: { clientId } })); setTick((n) => n + 1); }} />}
      {reveal && latest && <Reveal record={latest} onClose={() => setReveal(false)} />}
    </div>);
  }

  function DealBar({ clientId, dealId, onLinked }) {
    const [pack, setPack] = useState(null);
    const [open, setOpen] = useState(false);
    const [startAt, setStartAt] = useState("chooser");
    const [tick, setTick] = useState(0);
    useEffect(() => {
      const onOpen = (event) => {
        if (!event.detail || event.detail.clientId !== clientId) return;
        setStartAt("inperson");
        setOpen(true);
      };
      window.addEventListener("cdos-open-in-person", onOpen);
      return () => window.removeEventListener("cdos-open-in-person", onOpen);
    }, [clientId]);
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
      <button type="button" data-testid="deal-check-id" onClick={() => { setStartAt("chooser"); setOpen(true); }} className="text-[12px] font-medium mt-2" style={quietBtn}>Check ID for this deal</button>
      {open && <Flow clientId={clientId} dealId={dealId} initialStep={startAt} onClose={() => { setOpen(false); setTick((n) => n + 1); }} onDone={(record) => { if (onLinked) onLinked(record); window.dispatchEvent(new CustomEvent("cdos-id-standing", { detail: { clientId } })); setTick((n) => n + 1); }} />}
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
      if (row.diditSelectable === true && row.provider) payload.provider = row.provider;
      if (row.provider !== "didit" && row.templateId) payload.templateId = row.templateId;
      if (row.provider !== "didit" && row.apiKeyRef) payload.apiKeyRef = row.apiKeyRef;
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
      {row.diditSelectable === true && <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Identity provider<select data-testid="id-check-provider" value={row.provider === "didit" ? "didit" : "persona"} onChange={(e) => set("provider", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle}><option value="persona">Persona</option><option value="didit">Didit</option></select></label>}
      {row.diditSelectable === true && <div className="text-[11.5px] mt-1" style={{ color: CD.mute }}>Didit is only for a staging test shop.</div>}
      <div className="text-[11.5px] mt-1 mb-2" style={{ color: CD.mute }}>A small photo from the ID is kept for comparison by eye. It is on unless you turn it off.</div>
      <div className="flex items-center justify-between gap-3 py-1.5 text-[13px]" style={{ color: CD.ink }}><span>Identity checks</span><button type="button" role="switch" aria-checked={row.checksEnabled === true} aria-label="Identity checks" onClick={() => set("checksEnabled", row.checksEnabled !== true)} className="w-11 h-6 relative flex-none" style={{ background: row.checksEnabled === true ? CD.ink : "var(--cd-disabled)", borderRadius: 999, border: "none", padding: 0 }}><span className="absolute top-0.5 w-5 h-5" style={{ left: row.checksEnabled === true ? 22 : 2, background: "var(--cd-panel)", borderRadius: 999 }} /></button></div>
      <div className="flex items-center justify-between gap-3 py-1.5 text-[13px]" style={{ color: CD.ink }}><span>Small photo from the ID</span><button type="button" role="switch" data-testid="id-check-crop-switch" aria-checked={row.faceCropEnabled !== false} aria-label="Small photo from the ID" onClick={() => set("faceCropEnabled", row.faceCropEnabled === false)} className="w-11 h-6 relative flex-none" style={{ background: row.faceCropEnabled !== false ? CD.ink : "var(--cd-disabled)", borderRadius: 999, border: "none", padding: 0 }}><span className="absolute top-0.5 w-5 h-5" style={{ left: row.faceCropEnabled !== false ? 22 : 2, background: "var(--cd-panel)", borderRadius: 999 }} /></button></div>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy contact<input value={row.privacyContact || ""} onChange={(e) => set("privacyContact", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy email<input value={row.privacyEmail || ""} onChange={(e) => set("privacyEmail", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy phone<input value={row.privacyPhone || ""} onChange={(e) => set("privacyPhone", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <label className="block text-[12px] mt-2" style={{ color: CD.mute }}>Privacy policy link<input value={row.privacyPolicyUrl || ""} onChange={(e) => set("privacyPolicyUrl", e.target.value)} className="text-sm px-2.5 py-2 outline-none mt-1" style={inputStyle} /></label>
      <button type="button" onClick={save} className="text-[12px] font-medium mt-3" style={quietBtn}>Save identity check settings</button>
      {saved && <div className="text-[12px] mt-1.5" style={{ color: CD.mute }}>Saved.</div>}
      {note && <div className="text-[12px] mt-1.5" style={{ color: CD.flag }}>{note}</div>}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { idvProviderCopy, IdCheck: { Panel, Flow, DealBar, Settings, customerSteps, shopFromLine, buttonFeedbackMs: BUTTON_FEEDBACK_MS, stopLine } });
})();
