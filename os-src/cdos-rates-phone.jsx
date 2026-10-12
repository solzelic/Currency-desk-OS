/* Phone Rates. The desk editor for the public board: margins, spot,
   per-row spread, order, and one Publish. Tellers get the read-only
   list. Fee, floor, rounding, and the deal simulator stay on the
   computer Pricing screen. Desktop Rates stays the Rate Board iframe. */
(function () {
  const { useEffect, useState } = React;
  const R = () => window.CDOS.phoneRates;
  const Phone = () => window.CDOS.Phone;

  function publisherName(id, me, settings, srvUser) {
    if (!id || id === "seed") return "";
    const people = (settings && settings.employees) || [];
    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      if (person && (person.staffId === id || person.code === id || person.name === id)) return person.name || "";
    }
    if (srvUser && srvUser.staffId === id && srvUser.name) return srvUser.name;
    if (me && me.name && (me.code === id || me.name === id)) return me.name;
    return "";
  }

  function patchRow(draft, code, patch) {
    const row = draft.rows[code];
    if (!row) return draft;
    return { ...draft, rows: { ...draft.rows, [code]: { ...row, ...patch } } };
  }

  function PhoneRates({ me, srvUser, settings, locked, onToggleLock }) {
    const rates = R();
    const shell = Phone();
    const can = rates.canChangeRates(srvUser && srvUser.role);
    const zone = settings && settings.timezone;
    const [phase, setPhase] = useState("load");
    const [loadError, setLoadError] = useState("");
    const [feedNote, setFeedNote] = useState("");
    const [published, setPublished] = useState(null);
    const [draft, setDraft] = useState(null);
    const [feed, setFeed] = useState({});
    const [mode, setMode] = useState("edit");
    const [openCode, setOpenCode] = useState(null);
    const [spotText, setSpotText] = useState("");
    const [spreadText, setSpreadText] = useState(null);
    const [clampNote, setClampNote] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [publishError, setPublishError] = useState("");

    async function load() {
      setPhase("load");
      setLoadError("");
      setFeedNote("");
      let response;
      try {
        response = await fetch("/api/rates", { credentials: "same-origin" });
      } catch (error) {
        setLoadError("Could not reach the server. The rate board did not load.");
        setPhase("error");
        return;
      }
      if (!response.ok) {
        setLoadError("The rate board did not load (" + response.status + ").");
        setPhase("error");
        return;
      }
      let data;
      try {
        data = await response.json();
      } catch (error) {
        setLoadError("The rate board came back in a form this screen cannot read.");
        setPhase("error");
        return;
      }
      let mids = {};
      try {
        const market = await fetch("/api/rates/market", { credentials: "same-origin" });
        if (!market.ok) {
          setFeedNote("The feed did not load (" + market.status + "). A hand-set spot cannot be checked against it.");
        } else {
          const body = await market.json();
          if (body && body.mids && typeof body.mids === "object") mids = body.mids;
        }
      } catch (error) {
        setFeedNote("The feed did not load. A hand-set spot cannot be checked against it.");
      }
      const board = data && data.board ? rates.copyBoard(data.board) : null;
      const next = board || rates.factoryBoard();
      if (!next.order.length) {
        setLoadError("There are no currencies on this board.");
        setPhase("error");
        return;
      }
      setPublished(board);
      setDraft(next);
      setFeed(mids);
      setPhase("ready");
    }

    useEffect(() => { load(); }, []);

    function commitSpot(code) {
      const parsed = parseFloat(String(spotText).replace(/,/g, ""));
      const held = rates.clampSpot(parsed, feed[code]);
      if (!held.ok) return;
      setDraft((current) => patchRow(current, code, { mid: held.value, manual: true }));
      setSpotText(rates.formatSpot(held.value));
      setClampNote(held.clamped ? "Held within 2% of the feed." : "");
    }

    function applySpread(code, raw) {
      setSpreadText(raw);
      if (String(raw).trim() === "") {
        setDraft((current) => patchRow(current, code, { spread: null }));
        return;
      }
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed)) return;
      const fraction = Math.max(0, Math.min(0.2, parsed / 100));
      setDraft((current) => patchRow(current, code, { spread: fraction }));
    }

    function onGrip(event, code) {
      event.preventDefault();
      function move(ev) {
        const node = document.elementFromPoint(ev.clientX, ev.clientY);
        const over = node && node.closest ? node.closest("[data-code]") : null;
        const overCode = over && over.getAttribute("data-code");
        if (!overCode || overCode === code) return;
        setDraft((current) => {
          const order = current.order.slice();
          const from = order.indexOf(code);
          const to = order.indexOf(overCode);
          if (from < 0 || to < 0 || from === to) return current;
          order.splice(from, 1);
          order.splice(to, 0, code);
          return { ...current, order: order };
        });
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    async function publishNow() {
      if (publishing) return;
      setPublishing(true);
      setPublishError("");
      const body = rates.publishBody(draft);
      let response;
      try {
        response = await fetch("/api/rates/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
      } catch (error) {
        setPublishing(false);
        setPublishError("Could not reach the server. Nothing was published.");
        return;
      }
      let payload = null;
      try { payload = await response.json(); } catch (error) { payload = null; }
      if (!response.ok || !payload || !payload.board) {
        setPublishing(false);
        setPublishError(!response.ok
          ? rates.plainPublishError(response.status, payload)
          : "The server did not return the board. Check Rates before trying again.");
        return;
      }
      try {
        const saved = JSON.stringify(payload.board);
        localStorage.setItem("yorkfx_rates_v1", saved);
        if (payload.board.order) localStorage.setItem("yorkfx_board_order", JSON.stringify(payload.board.order));
        if (window.applyBoardOrder) window.applyBoardOrder();
        if (window.applyRateConfig) window.applyRateConfig();
        window.dispatchEvent(new StorageEvent("storage", { key: "yorkfx_rates_v1", newValue: saved }));
      } catch (error) {
        setPublishError("Published. This browser could not save its copy of the board.");
      }
      const next = rates.copyBoard(payload.board);
      setPublished(next);
      setDraft(next);
      setConfirm(false);
      setOpenCode(null);
      setPublishing(false);
    }

    if (!shell) return <p role="alert">The phone shell did not load.</p>;
    if (phase === "load") {
      return <div className="phone-rates" data-phone-rates=""><shell.Screen app="rates" title="Rates"><shell.LoadingState label="Loading rates" /></shell.Screen></div>;
    }
    if (phase === "error" || !draft) {
      return (
        <div className="phone-rates" data-phone-rates="">
          <shell.Screen app="rates" title="Rates">
            <shell.ErrorState message={loadError || "The rate board did not load."} onRetry={load} />
          </shell.Screen>
        </div>
      );
    }

    const diff = rates.changes(published, draft);
    const when = rates.clockLabel(published && published.publishedAt, zone);
    const who = publisherName(published && published.publishedBy, me, settings, srvUser);
    const stamp = when ? (who ? when + ", " + who : when) : "";
    let status = "Not published yet";
    if (!can) status = published ? ("Published " + (stamp || "earlier") + " · Ask a manager to change rates") : "Not published yet. Ask a manager to change rates";
    else if (diff.count > 0) status = diff.count + (diff.count === 1 ? " change" : " changes") + " not published" + (stamp ? " · last " + stamp : "");
    else if (published) status = stamp ? "Published " + stamp : "Published";
    const home = draft.order.slice(0, 6);
    const rest = draft.order.slice(6);
    const publishLabel = "Publish " + diff.count + (diff.count === 1 ? " change" : " changes");

    function prices(code) {
      const row = draft.rows[code];
      return rates.boardQuote(code, row.mid, row.spread, draft.buyMargin, draft.sellMargin);
    }

    function rowView(code) {
      const row = draft.rows[code];
      if (!row) return null;
      const quote = prices(code);
      if (can && openCode === code) {
        const spreadShown = spreadText != null ? spreadText : rates.percentNumber(row.spread != null ? row.spread : draft.buyMargin);
        const feedMid = feed[code];
        return (
          <div key={code} className="phone-rate-edit" data-code={code}>
            <div className="phone-rate-edit-h">
              <b>{code}, {rates.currencyName(code)}</b>
              <button type="button" className="phone-rate-done" onClick={() => { commitSpot(code); setOpenCode(null); setSpreadText(null); }}>Done</button>
            </div>
            <div className="phone-rate-two">
              <label>Spot, CAD per 1{row.manual ? <span className="phone-rate-pin">Set by hand</span> : null}
                <input inputMode="decimal" aria-label={"Spot for " + code} value={spotText} onChange={(e) => setSpotText(e.target.value)} onBlur={() => commitSpot(code)} />
              </label>
              <label>Spread for {code}
                <span className="phone-rate-pct"><input inputMode="decimal" aria-label={"Spread for " + code} value={spreadShown} onChange={(e) => applySpread(code, e.target.value)} /><span>%</span></span>
              </label>
            </div>
            <div className="phone-rate-res">
              <span className="is-buy">We buy {quote.buy} CAD</span>
              <span className="is-sell">We sell {quote.sell} CAD</span>
            </div>
            <p className="phone-rate-hint">
              {feedMid > 0 ? "Spot set by hand stays within 2% of the feed." : "No feed rate is loaded, so this spot is not checked against one."}
              {clampNote ? " " + clampNote : ""}
              {feedMid > 0 ? <button type="button" className="phone-rate-feed" onClick={() => { setDraft((current) => patchRow(current, code, { mid: rates.clampSpot(feedMid, feedMid).value, manual: false })); setSpotText(rates.formatSpot(feedMid)); setClampNote(""); }}>Use feed spot</button> : null}
            </p>
          </div>
        );
      }
      return (
        <div key={code} className={"phone-rate-row" + (row.show === false ? " is-off" : "")} data-code={code}>
          {can ? <button type="button" className="phone-rate-grip" aria-label={"Drag " + code + " to reorder"} onPointerDown={(e) => onGrip(e, code)}>⠿</button> : null}
          {can ? (
            <button type="button" className="phone-rate-main" onClick={() => { setOpenCode(code); setSpotText(rates.formatSpot(row.mid)); setSpreadText(null); setClampNote(""); }}>
              <b>{quote.label}</b>
              <small>{rates.currencyName(code)} · spot {quote.spot}</small>
            </button>
          ) : (
            <span className="phone-rate-main">
              <b>{quote.label}</b>
              <small>{rates.currencyName(code)} · spot {quote.spot}</small>
            </span>
          )}
          <span className="phone-rate-px"><span className="is-buy">Buy {quote.buy}</span><span className="is-sell">Sell {quote.sell}</span></span>
          {can ? <button type="button" className={"phone-rate-tg" + (row.show === false ? " is-off" : "")} role="switch" aria-checked={row.show !== false} aria-label={code + " on the board"} onClick={() => setDraft((current) => patchRow(current, code, { show: row.show === false }))}><i /></button> : null}
        </div>
      );
    }

    const list = (codes, title, meta) => (
      <section className="phone-rate-sec">
        <div className="phone-rate-sec-h"><span>{title}</span>{meta ? <span>{meta}</span> : null}</div>
        <div className="phone-rate-list">{codes.map(rowView)}</div>
      </section>
    );

    let body;
    if (!can || mode === "edit") {
      body = (
        <>
          {can ? (
            <>
              <div className="phone-seg" role="tablist">
                <button type="button" className={mode === "edit" ? "phone-seg-btn on" : "phone-seg-btn"} onClick={() => setMode("edit")}>Edit</button>
                <button type="button" className={mode === "preview" ? "phone-seg-btn on" : "phone-seg-btn"} onClick={() => setMode("preview")}>Public preview</button>
              </div>
              <div className="phone-rate-mg">
                {[["buyMargin", "Buy margin, under spot"], ["sellMargin", "Sell margin, over spot"]].map(([key, label]) => (
                  <div key={key} className="phone-rate-box">
                    <div className="phone-rate-k">{label}</div>
                    <div className="phone-rate-step">
                      <button type="button" aria-label={"Lower " + label} onClick={() => setDraft((current) => ({ ...current, [key]: rates.stepMargin(current[key], -1) }))}>−</button>
                      <b>{rates.formatPercent(draft[key])}</b>
                      <button type="button" aria-label={"Raise " + label} onClick={() => setDraft((current) => ({ ...current, [key]: rates.stepMargin(current[key], 1) }))}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <div className="phone-rate-lock">
            <p className={diff.count > 0 && can ? "is-warn" : ""}><i />{status}</p>
            {can ? <button type="button" className="phone-rate-lockbtn" aria-pressed={!!locked} aria-label={locked ? "Rates locked in this browser" : "Lock rates in this browser"} onClick={onToggleLock}>{locked ? "Locked" : "Lock"}</button> : null}
          </div>
          {feedNote ? <p className="phone-rate-banner" role="alert">{feedNote}</p> : null}
          {publishError && !confirm ? <p className="phone-rate-banner" role="alert">{publishError}</p> : null}
          {list(home, "On your homepage, top 6", can ? "Drag to reorder" : "")}
          {rest.length ? list(rest, "Rate board page only", "") : null}
        </>
      );
    } else {
      const six = rates.homeSix(draft.rows, draft.order);
      const note = rates.previewNote(draft.rows, draft.order);
      body = (
        <>
          <div className="phone-seg" role="tablist">
            <button type="button" className="phone-seg-btn" onClick={() => setMode("edit")}>Edit</button>
            <button type="button" className="phone-seg-btn on" onClick={() => setMode("preview")}>Public preview</button>
          </div>
          <p className="phone-rate-hint">What your homepage will show after you publish. Not live yet.</p>
          <div className="phone-rate-board">
            <h3><span>TODAY'S RATES</span><span>CAD</span></h3>
            <div className="phone-rate-board-r is-hd"><span /><span>We buy</span><span>We sell</span></div>
            {six.map((code) => {
              const quote = prices(code);
              return <div key={code} className="phone-rate-board-r"><b>{quote.label}</b><span>{quote.buy}</span><span>{quote.sell}</span></div>;
            })}
            {note ? <p>{note}</p> : null}
          </div>
        </>
      );
    }

    const sticky = can ? <shell.StickyAction label={publishLabel} disabled={diff.count === 0 || publishing} disabledReason={diff.count === 0 ? "Nothing new to publish." : ""} onClick={() => { setPublishError(""); setConfirm(true); }} /> : null;

    return (
      <div className="phone-rates" data-phone-rates="" data-can-publish={can ? "yes" : "no"}>
        <shell.Screen app="rates" title="Rates" sticky={sticky}>{body}</shell.Screen>
        {confirm ? ReactDOM.createPortal(
          <div className="phone-task fixed inset-0" data-app="rates" style={{ background: "var(--cd-scrim)", zIndex: 9200 }}>
            <div role="dialog" aria-label="Publish rates?" className="phone-task-sheet phone-rate-sheet">
              <div className="phone-rate-sheet-h">
                <button type="button" className="phone-rate-back" onClick={() => { if (!publishing) setConfirm(false); }}>Back</button>
                <h2>Publish rates?</h2>
                <span />
              </div>
              <div className="phone-task-body">
                <p>These go to your website and rate board. Customers see them within about a minute.</p>
                <ul className="phone-rate-chg">
                  {diff.lines.map((line) => <li key={line.label}><span>{line.label}</span><b>{line.detail}</b></li>)}
                </ul>
                <p className="phone-rate-hint">Publishing is saved with your name and the time. Only managers and admins can publish.</p>
                {publishError ? <p className="phone-rate-banner" role="alert">{publishError}</p> : null}
              </div>
              <div className="phone-task-foot">
                <button type="button" className="phone-task-go" disabled={publishing} onClick={publishNow}>{publishing ? "Publishing" : "Publish now"}</button>
              </div>
            </div>
          </div>,
          document.body
        ) : null}
      </div>
    );
  }

  window.CDOS.PhoneRates = PhoneRates;
})();
