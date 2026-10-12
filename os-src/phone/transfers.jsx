/* Phone Transfers, only at 430px. The desktop pipeline is not restyled.
   Partners are not connected. Creating a transfer records the cash.
   It does not send anything to the partner. */
(function () {
  const { useState, useEffect, useMemo, useRef } = React;
  /* The foundation formatter. A missing one is a broken shell, not a
     second formatter invented here. */
  const money = (amount, currency) => {
    const format = window.CDOS.formatPhoneMoney;
    if (typeof format !== "function") throw new Error("formatPhoneMoney is not loaded.");
    return format(amount, currency);
  };
  const T = () => window.CDOS._transfers;

  const stamp = () => new Date().toLocaleString("en-CA", { hour12: false }).replace(",", "");

  function readTransfers() {
    const key = T().TKEY;
    let raw;
    try { raw = localStorage.getItem(key); }
    catch (error) { return { ok: false, error }; }
    if (raw == null) return { ok: true, list: T().defaultTransfers() };
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return { ok: false, error: new Error("The saved transfer list is not a list.") };
      return { ok: true, list };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error("The saved transfer list could not be read.") };
    }
  }

  /* Stored stamps are "2026-06-18 10:12". The phone reads
     "Jun 18, 2026, 10:12 AM". A stamp this cannot read is left off
     the line, so an ISO date never reaches the screen. */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function historyWhen(ts) {
    const match = String(ts || "").match(/(\d{4})-(\d{2})-(\d{2})(?:[ T,]+)(\d{1,2}):(\d{2})/);
    if (!match) return "";
    let hour = Number(match[4]);
    const ap = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    return MONTHS[Number(match[2]) - 1] + " " + Number(match[3]) + ", " + match[1] + ", " + hour + ":" + match[5] + " " + ap;
  }

  const PROGRESS = { created: 1, sent: 1, transit: 1 };
  function inProgress(t) { return !!PROGRESS[t.status]; }

  /* Release goes back to the status before the hold. A fresh hold
     remembers that status. An older hold, with nothing remembered,
     uses the last history line that is not itself a hold. */
  function priorStatus(t) {
    const held = t.heldFrom;
    if (held && held !== "hold" && held !== "cancelled") return held;
    const line = t.timeline || [];
    for (let i = line.length - 1; i >= 0; i--) {
      const status = line[i] && line[i].status;
      if (status && status !== "hold" && status !== "cancelled") return status;
    }
    return "created";
  }

  function nextStatus(t) {
    if (!t) return null;
    if (t.status === "hold") return priorStatus(t);
    const flow = T().FLOW;
    const at = flow.indexOf(t.status);
    return at >= 0 && at < flow.length - 1 ? flow[at + 1] : null;
  }

  /* "Funded" is the receive name of the send key. A receive is marked
     Ready for pickup, then Paid to customer — the same list, no new key. */
  function advanceKey(t) {
    const next = nextStatus(t);
    if (t && t.direction === "receive" && t.status !== "hold" && next === "sent") return "transit";
    return next;
  }

  function actionLabel(t) {
    const next = advanceKey(t);
    if (!next) return "";
    if (t.status === "hold") return "Release";
    if (t.direction === "receive") return "Mark " + T().statusLabel(next, "receive").toLowerCase();
    if (next === "sent") return "Mark as sent";
    if (next === "transit") return "Mark in transit";
    if (next === "paid") return "Mark paid out";
    return "Mark as " + T().statusLabel(next, t.direction);
  }

  /* The total is the stored amount plus the stored fee, in cents,
     then formatted. It is not priced again from the board. */
  function homeTotal(pay, fee) {
    const amount = Number(pay);
    const extra = Number(fee);
    if (!Number.isFinite(amount) || !Number.isFinite(extra)) return "";
    return (Math.round(amount * 100) + Math.round(extra * 100)) / 100;
  }

  /* The rate on the sheet is the one that multiplies back to the
     gross, to the cent. The server keeps rates at 12 places. Show
     the shortest of those that still hits, so a rounded rate never
     makes Amount × Rate miss the row beside it. A receive's target
     is the gross the book stored: payout plus the fee the partner
     owes. A send's target is the foreign payout. */
  function rateShown(amount, targetCents) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0 || !Number.isFinite(targetCents)) return "";
    const exact = targetCents / (amt * 100);
    for (let digits = 0; digits <= 12; digits++) {
      const shown = exact.toFixed(digits);
      if (Math.round(amt * Number(shown) * 100) === targetCents) return shown;
    }
    return exact.toFixed(12);
  }

  function detailRows(t, home) {
    const send = t.direction === "send";
    const method = T().methodLabel(t.method) || "";
    const tail = [
      { label: "Method", value: method },
      { label: "Partner", value: t.partner || "" },
    ];
    if (send) {
      const total = homeTotal(t.payAmt, t.fee);
      const foreign = Math.round(Number(t.recvAmt) * 100);
      const rate = rateShown(t.payAmt, foreign);
      return [
        { label: "Amount sent", value: money(t.payAmt, home) },
        { label: "Fee", value: money(t.fee, home) },
        { label: "Total paid", value: total === "" ? "" : money(total, home) },
        { label: "Rate", value: rate ? rate + " " + t.ccy + "/" + home : "" },
      ].concat(tail);
    }
    /* recvAmt leaves the drawer. The fee stays in the proceeds.
       payAmt is what the sender paid, in the foreign currency. */
    const payout = Math.round(Number(t.recvAmt) * 100);
    const fee = Math.round(Number(t.fee) * 100);
    const grossCents = Number.isFinite(payout) && Number.isFinite(fee) ? payout + fee : NaN;
    const rate = rateShown(t.payAmt, grossCents);
    return [
      { label: "Sender paid", value: money(t.payAmt, t.ccy) },
      { label: "Rate", value: rate ? rate + " " + home + "/" + t.ccy : "" },
      { label: "Gross", value: Number.isFinite(grossCents) ? money(grossCents / 100, home) : "" },
      { label: "Fee", value: Number.isFinite(fee) ? money(-fee / 100, home) : "" },
      { label: "Customer receives", value: money(t.recvAmt, home), mark: "transfer-hand" },
    ].concat(tail);
  }

  /* `pin` is minted in the browser. A partner PIN is `partnerPin`, typed by staff. */
  function typedPartnerPin(t) {
    const typed = String((t && t.partnerPin) || "").trim();
    if (!typed || typed === String((t && t.pin) || "").trim()) return "";
    return typed;
  }

  function toneOf(status) {
    if (status === "transit") return "buy";
    if (status === "hold") return "warn";
    if (status === "paid") return "pos";
    if (status === "cancelled") return "neg";
    return "neutral";
  }



  function PhoneTransfers(props) {
    const Wizard = window.CDOS.PhoneTransferWizard;
    const { rows, setRows, clients, setClients, settings, me, log, beneficiaries, setBeneficiaries, corridors, serverBacked, onTillChanged } = props;
    const [phase, setPhase] = useState("loading");
    const [loadError, setLoadError] = useState(null);
    const [saveError, setSaveError] = useState(null);
    const [transfers, setTransfers] = useState([]);
    const [q, setQ] = useState("");
    const [filter, setFilter] = useState("all");
    const [view, setView] = useState("list");
    const [detailId, setDetailId] = useState(null);
    const [toast, setToast] = useState("");

    const reload = () => {
      const read = readTransfers();
      if (!read.ok) { setLoadError(read.error); setPhase("error"); return; }
      setTransfers(read.list);
      setLoadError(null);
      setPhase("ready");
    };
    useEffect(() => { reload(); }, []);
    useEffect(() => {
      if (phase !== "ready") return;
      try {
        localStorage.setItem(T().TKEY, JSON.stringify(transfers));
        setSaveError(null);
      } catch (error) {
        setSaveError(error instanceof Error ? error : new Error("The transfer list could not be saved on this till."));
      }
    }, [transfers, phase]);

    const advance = (t, to, note) => {
      setTransfers((list) => list.map((x) => {
        if (x.id !== t.id) return x;
        const heldFrom = to === "hold" ? (x.status === "hold" ? x.heldFrom : x.status) : undefined;
        return {
          ...x,
          status: to,
          heldFrom,
          timeline: (x.timeline || []).concat([{ status: to, ts: stamp(), by: me.name, note: note || "" }]),
        };
      }));
      log && log("Transfer " + T().statusLabel(to, t.direction).toLowerCase(), t.ref + " · updated by hand");
    };

    const openNew = () => { setToast(""); setView("new"); };
    const detail = detailId ? transfers.find((t) => t.id === detailId) : null;

    return (
      <div className="ph-xfer" data-phone="transfers" style={{ "--brand-primary": "#1F7269" }}>
        {view === "new" && (Wizard ? (
          <Wizard
            {...{ rows, setRows, clients, setClients, settings, me, log, beneficiaries, setBeneficiaries, corridors, transfers, setTransfers, serverBacked, onTillChanged }}
            onClose={() => setView("list")}
            onCreated={(transfer) => {
              setDetailId(transfer.id);
              setToast("Transfer created. " + transfer.ref + ".");
              setView("detail");
            }}
          />
        ) : <p className="ph-fault" role="alert">The new-transfer sheet did not load.</p>)}
        {view === "detail" && detail && (
          <Detail t={detail} me={me} beneficiaries={beneficiaries} corridors={corridors} toast={toast} onAdvance={advance} onClose={() => { setView("list"); setToast(""); }} />
        )}
        {view === "list" && (
          <List
            phase={phase} loadError={loadError} saveError={saveError} onRetry={reload}
            transfers={transfers} beneficiaries={beneficiaries} corridors={corridors}
            q={q} setQ={setQ} filter={filter} setFilter={setFilter}
            onOpen={(t) => { setDetailId(t.id); setToast(""); setView("detail"); }}
            onNew={openNew}
          />
        )}
      </div>
    );
  }

  function List(p) {
    const Phone = window.CDOS.Phone;
    if (!Phone || !Phone.Screen) {
      return <p className="ph-fault" role="alert">The phone shell did not load. Transfers cannot be shown.</p>;
    }
    const { Screen, Search, FilterChips, ListRow, StickyAction, EmptyState, LoadingState, ErrorState } = Phone;
    const benName = (id) => { const b = (p.beneficiaries || []).find((x) => x.id === id); return b ? b.name : ""; };
    const country = (id) => { const c = (p.corridors || []).find((x) => x.id === id); return c ? c.country : ""; };
    const home = () => { const pack = window.CDOS.deskPack && window.CDOS.deskPack(); return (pack && pack.homeCurrency) || "CAD"; };
    const searched = (p.transfers || []).filter((t) => {
      const needle = p.q.trim().toLowerCase();
      if (!needle) return true;
      const hay = [t.senderName, benName(t.beneficiaryId), t.ref, t.pin].join(" ").toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
    const counts = {
      all: searched.length,
      progress: searched.filter(inProgress).length,
      hold: searched.filter((t) => t.status === "hold").length,
      paid: searched.filter((t) => t.status === "paid").length,
    };
    const shown = searched.filter((t) => {
      if (p.filter === "progress") return inProgress(t);
      if (p.filter === "hold") return t.status === "hold";
      if (p.filter === "paid") return t.status === "paid";
      return true;
    });
    const chips = [
      { id: "all", label: "All", count: counts.all },
      { id: "progress", label: "In progress", count: counts.progress },
      { id: "hold", label: "On hold", count: counts.hold },
      { id: "paid", label: "Paid out", count: counts.paid },
    ];
    const empty = p.phase === "ready" && !shown.length && !p.transfers.length && !p.q;
    const none = p.phase === "ready" && !shown.length && (p.q || p.transfers.length > 0);
    return (
      <Screen
        app="transfers"
        title="Transfers"
        banner={(
          <>
            <Search value={p.q} onChange={p.setQ} placeholder="Find a name or TR number" label="Find a name or TR number" />
            <FilterChips chips={chips} value={p.filter} onChange={p.setFilter} />
            <p className="ph-info">Payout partners are not connected. You change the status by hand when the partner confirms.</p>
          </>
        )}
        sticky={<StickyAction label="New transfer" onClick={p.onNew} />}
      >
        {p.saveError && <p className="ph-fault" role="alert">{p.saveError.message}</p>}
        {p.phase === "loading" && <LoadingState label="Loading transfers" />}
        {p.phase === "error" && <ErrorState message={(p.loadError && p.loadError.message) || "The transfer list could not be read."} onRetry={p.onRetry} />}
        {empty && <EmptyState title="No transfers yet." message="Tap New transfer to send money for a customer." />}
        {none && <p className="ph-state">{p.q ? "No transfer matches \"" + p.q + "\"." : "Nothing in this filter."}</p>}
        {p.phase === "ready" && shown.length > 0 && (
          <div className="phone-list">
            {shown.map((t) => {
              const amount = t.direction === "send" ? t.payAmt : t.recvAmt;
              const place = country(t.corridor);
              const method = T().methodLabel(t.method) || "";
              return (
                <ListRow
                  key={t.id}
                  className="ph-xfer-row"
                  title={t.senderName}
                  subtitle={[place, method].filter(Boolean).join(" · ")}
                  amount={money(amount, home())}
                  badge={{ label: T().statusLabel(t.status, t.direction), tone: toneOf(t.status) }}
                  onClick={() => p.onOpen(t)}
                />
              );
            })}
          </div>
        )}
      </Screen>
    );
  }

  function Detail({ t, me, beneficiaries, corridors, toast, onAdvance, onClose }) {
    const ben = (beneficiaries || []).find((b) => b.id === t.beneficiaryId);
    const who = ben && ben.name ? ben.name : t.senderName;
    const label = actionLabel(t);
    const SummaryList = window.CDOS.SummaryList;
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    const home = (pack && pack.homeCurrency) || "CAD";
    const canCancel = !!(me && (me.role === "Owner" || me.role === "Manager" || me.role === "Senior teller"));
    const receive = t.direction === "receive";
    const open = t.status !== "paid" && t.status !== "cancelled";
    const partnerPin = typedPartnerPin(t);
    const [copyError, setCopyError] = useState(null);
    const [copied, setCopied] = useState(false);
    const copyPin = async () => {
      try {
        await navigator.clipboard.writeText(partnerPin);
        setCopied(true);
        setCopyError(null);
      } catch (error) {
        setCopyError(error instanceof Error ? error : new Error("The PIN could not be copied."));
      }
    };
    return ReactDOM.createPortal(
      <div className="ph-sheet" data-app="transfers" role="dialog" aria-label={who}>
        {toast && <div className="ph-toast" role="status"><span className="ok" aria-hidden="true">✓</span><b>{toast}</b></div>}
        <div className="ph-sheet-h">
          <button type="button" className="ph-back" aria-label="Back" onClick={onClose}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 2 6 12 16 22" /></svg>
          </button>
          <div className="ph-sheet-title">
            <h2>{who}</h2>
            <p>{t.ref}</p>
          </div>
          <span />
        </div>
        <div className="ph-sheet-b">
          <div className="ph-sum-who">
            <b>{t.senderName} to {ben && ben.name ? ben.name : "the receiver"}</b>
            <span className={"phone-badge tone-" + toneOf(t.status)}>{T().statusLabel(t.status, t.direction)}</span>
          </div>
          {SummaryList && <SummaryList rows={detailRows(t, home)} />}
          {t.direction !== "send" && <p className="ph-hist">The fee is kept from the proceeds. It does not leave the drawer.</p>}
          {SummaryList && <SummaryList rows={[{ label: "Desk reference", value: t.ref || "" }]} />}
          <p className="ph-hist">Our own reference. Not a partner pickup code.</p>
          {partnerPin && SummaryList && (
            <div className="ph-pin-row">
              <SummaryList rows={[{ label: "Partner PIN (typed in by staff)", value: partnerPin, mark: "transfer-pin" }]} />
              <button type="button" onClick={copyPin}>{copied ? "Copied" : "Copy"}</button>
            </div>
          )}
          {copyError && <p className="ph-fault" role="alert">{copyError.message}</p>}
          <div className="ph-label">History</div>
          <p className="ph-hist">Updated by staff, not by the partner.</p>
          <ul className="ph-time">
            {(t.timeline || []).map((event, i) => {
              const line = [T().statusLabel(event.status, t.direction), event.by, historyWhen(event.ts)].filter(Boolean).join(" · ");
              return <li key={i}>{line}</li>;
            })}
          </ul>
        </div>
        {open && (
          <div className="ph-sheet-f">
            {label && <button type="button" className="ph-btn" onClick={() => onAdvance(t, advanceKey(t), "marked by hand")}>{label}</button>}
            {(t.status !== "hold" || (!receive && canCancel)) && (
              <div className="ph-secondary">
                {t.status !== "hold" && <button type="button" onClick={() => onAdvance(t, "hold", "marked by hand")}>Hold</button>}
                {!receive && canCancel && <button type="button" className="is-cancel" disabled>Cancel is being fixed</button>}
              </div>
            )}
            {receive
              ? <p className="ph-cancel-note">A received transfer can't be cancelled here. Ask a manager.</p>
              : !canCancel && <p className="ph-cancel-note">Only a manager can cancel a transfer that took cash. Ask a manager to cancel.</p>}
          </div>
        )}
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { PhoneTransfers });
})();
