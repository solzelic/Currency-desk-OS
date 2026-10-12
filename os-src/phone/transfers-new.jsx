/* New transfer, phone only. The list stays in transfers.jsx.
   This sheet is the three steps. It uses the shared ChoiceTiles,
   AmountField, SummaryList, and StepHeader. It does not copy them. */
(function () {
  const { useState, useEffect, useMemo, useRef } = React;
  const money = (amount, currency) => {
    const format = window.CDOS.formatPhoneMoney;
    if (typeof format !== "function") throw new Error("formatPhoneMoney is not loaded.");
    return format(amount, currency);
  };
  const T = () => window.CDOS._transfers;

  function rateLine(quote, direction, recvCcy) {
    const rate = quote.pricing && quote.pricing.rate;
    if (!rate) return "Rate unavailable";
    const shown = Number(rate).toFixed(4);
    return direction === "send"
      ? "1 " + quote.home + " = " + shown + " " + recvCcy
      : "1 " + recvCcy + " = " + shown + " " + quote.home;
  }

  function reportSentence(quote) {
    if (!quote || quote.ruling.reportable !== true) return "";
    const who = (quote.packNow && quote.packNow.regulator) || "the regulator";
    const line = money(quote.limit.amount, quote.limit.currency);
    const head = line ? line + " or more: " : "";
    return head + "this needs an EFT report to " + who + ". You file it from Compliance.";
  }

  function Wizard(p) {
    const { ChoiceTiles, AmountField, SummaryList, StepHeader } = window.CDOS;
    const BenModal = T().BeneficiaryModal;
    const [step, setStep] = useState(1);
    const [direction, setDirection] = useState("send");
    const [senderName, setSenderName] = useState("");
    const [benId, setBenId] = useState("");
    const [addBen, setAddBen] = useState(false);
    const [corridorId, setCorridorId] = useState("PH");
    const [method, setMethod] = useState("cash");
    const [partner, setPartner] = useState("");
    const [payAmt, setPayAmt] = useState("");
    const [fee, setFee] = useState(p.settings && p.settings.defaultFee ? String(p.settings.defaultFee) : "9.99");
    const [feeOpen, setFeeOpen] = useState(false);
    const [purpose, setPurpose] = useState("");
    const [sourceOfFunds, setSourceOfFunds] = useState("");
    const [receiveName, setReceiveName] = useState("");
    const [receiveAddress, setReceiveAddress] = useState("");
    const [busy, setBusy] = useState(false);
    const [postError, setPostError] = useState(null);
    const lock = useRef(false);
    const attempt = useRef("");
    const attemptKey = () => {
      if (!attempt.current) attempt.current = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("k" + Date.now().toString(36));
      return attempt.current;
    };
    const ben = (p.beneficiaries || []).find((b) => b.id === benId) || null;
    const cor = (p.corridors || []).find((c) => c.id === corridorId) || (p.corridors || [])[0] || { ccy: "", country: "", partners: [] };
    useEffect(() => {
      if (!ben) return;
      setCorridorId(ben.corridor);
      setMethod(ben.method);
      setPartner(ben.partner);
    }, [benId]);
    useEffect(() => {
      if (ben) return;
      const list = [];
      (cor.partners || []).forEach((partnerRow) => {
        (partnerRow.methods || []).forEach((m) => list.push({ method: m, partner: partnerRow.name }));
      });
      if (!list.some((pill) => pill.method === method && pill.partner === partner) && list[0]) {
        setMethod(list[0].method);
        setPartner(list[0].partner);
      }
    }, [corridorId, benId]);
    const recvCcy = cor.ccy;
    const names = useMemo(() => {
      const set = new Set(Object.keys(p.clients || {}));
      (p.rows || []).forEach((r) => { if (r.customer) set.add(r.customer); });
      return Array.from(set).sort();
    }, [p.clients, p.rows]);
    const matches = names.filter((n) => !senderName || n.toLowerCase().indexOf(senderName.toLowerCase()) >= 0).slice(0, 8);
    const mine = (p.beneficiaries || []).filter((b) => direction === "send" && senderName && b.sender === senderName);
    const pills = [];
    (cor.partners || []).forEach((partnerRow) => {
      (partnerRow.methods || []).forEach((m) => pills.push({ method: m, partner: partnerRow.name, label: T().methodLabel(m) + ", " + partnerRow.name }));
    });
    const quote = T().quoteTransfer({ direction, payAmt, fee, recvCcy, settings: p.settings, senderName, clients: p.clients });
    const blocked = T().transferBlock(quote, { direction, partner, ben, senderName, purpose, sourceOfFunds });
    const hands = quote.ruling.homeAmount;
    const first = (ben && ben.name.split(/\s+/)[0]) || "They";
    const report = reportSentence(quote);
    const stepTitle = step === 1 ? "who" : step === 2 ? "amount and payout" : "check and create";

    const create = async () => {
      setPostError(null);
      setBusy(true);
      const result = await T().submitTransfer({
        // The lock inside submitTransfer is what makes a double tap one post.
        direction, senderName, ben, benId, corridorId, partner, method, payAmt, fee, purpose, sourceOfFunds,
        recvCcy, receiveBeneficiaryName: receiveName, receiveBeneficiaryAddress: receiveAddress,
        corridors: p.corridors, clients: p.clients, setClients: p.setClients, settings: p.settings, me: p.me, log: p.log,
        rows: p.rows, setRows: p.setRows, transfers: p.transfers, setTransfers: p.setTransfers,
        serverBacked: p.serverBacked, onServerPosted: p.onTillChanged, lock, attemptKey,
      });
      if (result.ignored) return;
      setBusy(false);
      if (!result.ok) { setPostError(result.error || new Error("The transfer was not created.")); return; }
      p.onCreated(result.transfer);
    };

    const saveBen = (b) => {
      p.setBeneficiaries((list) => { const ex = list.find((x) => x.id === b.id); return ex ? list.map((x) => x.id === b.id ? b : x) : [b].concat(list); });
      setBenId(b.id);
      setAddBen(false);
      p.log && p.log("Beneficiary saved", b.name + " · " + b.partner);
    };

    const who = direction === "send"
      ? (senderName || "The customer") + " sends to"
      : (senderName || "The customer") + " receives";
    const whoName = direction === "send"
      ? ((ben && ben.name) || "Choose a receiver") + (cor.country ? ", " + cor.country : "")
      : (cor.country || "Choose a country");

    /* The window sits under the phone bar. A sheet drawn inside it
       cannot cover that bar, so Next lands under the More icon.
       The body portal is the same escape the desk lock uses. */
    return ReactDOM.createPortal(
      <div className="ph-sheet" data-app="transfers" role="dialog" aria-label="New transfer">
        <div className="ph-sheet-h">
          <button type="button" className="ph-back" aria-label={step === 1 ? "Close" : "Back"} onClick={() => step === 1 ? p.onClose() : setStep(step - 1)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 2 6 12 16 22" /></svg>
          </button>
          <h2>New transfer</h2>
          <button type="button" className="lnk" onClick={p.onClose}>Cancel</button>
        </div>
        <div className="ph-sheet-b">
          <StepHeader step={step} total={3} label={stepTitle} />
          {step > 1 && (
            <div className="ph-who">
              <span><span className="muted">{who}</span><b>{whoName}</b></span>
              <button type="button" className="lnk" onClick={() => setStep(1)}>Change</button>
            </div>
          )}
          {step === 1 && (
            <>
              <ChoiceTiles
                label="Direction"
                value={direction}
                onChange={(id) => { setDirection(id); setBenId(""); }}
                options={[{ id: "send", label: "Send out" }, { id: "receive", label: "Receive in" }]}
              />
              <label className="ph-field">Customer
                <input aria-label="Customer" placeholder="Find a customer" value={senderName} onChange={(e) => { setSenderName(e.target.value); setBenId(""); }} />
              </label>
              <div className="ph-picks">
                {matches.map((n) => (
                  <button type="button" key={n} className={"ph-pick" + (senderName === n ? " on" : "")} onClick={() => { setSenderName(n); setBenId(""); }}>{n}</button>
                ))}
              </div>
              {direction === "send" && senderName && (
                <>
                  <div className="ph-label">Receivers on file</div>
                  <div className="ph-picks">
                    {mine.map((b) => {
                      const bc = (p.corridors || []).find((c) => c.id === b.corridor);
                      return (
                        <button type="button" key={b.id} className={"ph-pick" + (benId === b.id ? " on" : "")} onClick={() => setBenId(b.id)}>
                          <b>{b.name}</b>
                          <small>{(bc && bc.country) || ""} · {T().methodLabel(b.method)} · {b.partner}</small>
                        </button>
                      );
                    })}
                    {!mine.length && <p className="ph-hint">No receiver saved for {senderName} yet.</p>}
                    <button type="button" className="ph-pick" onClick={() => setAddBen(true)}>Add a new receiver</button>
                  </div>
                </>
              )}
              {direction === "receive" && (
                <label className="ph-field">Country
                  <select aria-label="Country" value={corridorId} onChange={(e) => setCorridorId(e.target.value)}>
                    {(p.corridors || []).filter((c) => c.active !== false).map((c) => <option key={c.id} value={c.id}>{c.country}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <AmountField
                label={direction === "send" ? "Customer pays" : "Amount received"}
                value={payAmt}
                currency={direction === "send" ? quote.home : recvCcy}
                autoFocus
                feeLabel={"Fee " + money(fee || "0", quote.home) + ". Tap to change the fee."}
                onFee={() => setFeeOpen((v) => !v)}
                onChange={setPayAmt}
              />
              {feeOpen && (
                <label className="ph-field">Fee ({quote.home})
                  <input aria-label="Fee" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
                </label>
              )}
              <SummaryList rows={[
                { label: direction === "send" ? first + " gets" : "Customer gets", value: quote.recvAmt ? money(quote.recvAmt, direction === "send" ? recvCcy : quote.home) : "", big: true, mark: "transfer-gets" },
                { label: "Rate", value: rateLine(quote, direction, recvCcy), mark: "transfer-rate" },
                { label: direction === "send" ? "Customer hands you" : "You pay out", value: hands ? money(hands, quote.home) : "", mark: "transfer-hands" },
              ]} />
              <div className="ph-label">{direction === "send" ? "How " + first + " gets it" : "How they get it"}</div>
              <div className="ph-pills" role="group" aria-label="Payout">
                {pills.map((pill) => {
                  const on = pill.method === method && pill.partner === partner;
                  return (
                    <button type="button" key={pill.method + pill.partner} className={on ? "on" : ""} aria-pressed={on} onClick={() => { setMethod(pill.method); setPartner(pill.partner); }}>
                      {pill.label}
                    </button>
                  );
                })}
              </div>
              <label className="ph-field">Why is it being sent?
                <select aria-label="Why is it being sent?" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  <option value="">{quote.requirePurpose ? "Choose a purpose" : "Purpose"}</option>
                  {T().PURPOSES.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              {report && <p className="ph-warn" role="status">{report}</p>}
              {quote.ruling.reportable === true && (
                <label className="ph-field">Source of funds
                  <input aria-label="Source of funds" value={sourceOfFunds} placeholder="Salary, savings, property sale" onChange={(e) => setSourceOfFunds(e.target.value)} />
                </label>
              )}
              {quote.ruling.idRequired && (
                <p className={quote.kyc === "ok" ? "ph-ok" : "ph-warn"} role="status">
                  {quote.kyc === "ok" ? "ID is on file for this customer." : "This transfer needs ID on file. The customer's ID is " + quote.kyc + "."}
                </p>
              )}
              {direction === "receive" && quote.packNow && quote.packNow.packId === "pack-ca-v2" && (
                <>
                  <label className="ph-field">Beneficiary name<input aria-label="Beneficiary name" value={receiveName} onChange={(e) => setReceiveName(e.target.value)} /></label>
                  <label className="ph-field">Beneficiary address<input aria-label="Beneficiary address" value={receiveAddress} onChange={(e) => setReceiveAddress(e.target.value)} /></label>
                </>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <SummaryList rows={[
                { label: "Customer", value: senderName },
                { label: direction === "send" ? "Receiver" : "Country", value: direction === "send" ? (ben && ben.name) : cor.country },
                { label: "To", value: cor.country },
                { label: "How", value: T().methodLabel(method) + ", " + partner },
                { label: "Customer pays", value: money(payAmt, direction === "send" ? quote.home : recvCcy) },
                { label: "Fee", value: money(fee || "0", quote.home) },
                { label: direction === "send" ? (first + " gets") : "Customer gets", value: quote.recvAmt ? money(quote.recvAmt, direction === "send" ? recvCcy : quote.home) : "", big: true, mark: "transfer-gets" },
                { label: direction === "send" ? "Customer hands you" : "You pay out", value: hands ? money(hands, quote.home) : "" },
                { label: "Purpose", value: purpose },
                report ? { label: "Report", value: report } : null,
                sourceOfFunds ? { label: "Source of funds", value: sourceOfFunds } : null,
              ].filter(Boolean)} />
              <p className="ph-info"><span>Creating this records the cash. It does not send the money to the partner. You update the status by hand.</span></p>
              {postError && (
                <div className="ph-fault" role="alert">
                  <b>The transfer was not created. Nothing was charged.</b>
                  <p>{postError.message}</p>
                  <p>Try again.</p>
                </div>
              )}
            </>
          )}
        </div>
        <div className="ph-sheet-f">
          {step < 3 ? (
            <button
              type="button"
              className="ph-btn"
              disabled={step === 1 ? !(senderName && (direction === "receive" || benId)) : !!blocked}
              onClick={() => setStep(step + 1)}
            >{step === 2 ? "Next: check and create" : "Next"}</button>
          ) : (
            <button type="button" className="ph-btn" data-testid="transfer-create" disabled={!!blocked || busy} onClick={create}>
              {busy ? "Creating…" : "Create transfer"}
            </button>
          )}
        </div>
        {addBen && <BenModal sender={senderName} lockSender corridors={p.corridors} onClose={() => setAddBen(false)} onSave={saveBen} />}
      </div>,
      document.body
    );
  }


  /* Not opened. The detail's Cancel button stays disabled until
     docs/TRANSFER_CANCEL.md. `refund` is the server's stored amount,
     already formatted. This sheet does not estimate it. */
  function cancelSheetCopy(refund) {
    return {
      title: "Cancel this transfer?",
      body: "This reverses it in the ledger and the drawer. Give the customer back " + refund + ".",
      toast: "Transfer cancelled. Give back " + refund + ".",
    };
  }
  function CancelConfirm({ refund, onStay }) {
    const copy = cancelSheetCopy(refund);
    return (
      <div className="ph-confirm" role="alertdialog" aria-labelledby="ph-cancel-title">
        <div className="ph-confirm-card">
          <h2 id="ph-cancel-title">{copy.title}</h2>
          <p>{copy.body}</p>
          <button type="button" className="ph-btn" disabled>Cancel is being fixed</button>
          <button type="button" className="ph-btn quiet" onClick={onStay}>Keep the transfer</button>
        </div>
      </div>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTransferWizard: Wizard, CancelConfirm });
})();
