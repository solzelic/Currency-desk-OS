/* Phone Rates editor. Margins, spot, per-row spread, order, and
   whether a currency is on the board. Tellers get the read-only
   list. Public preview and Publish are later slices. Desktop Rates
   stays the Rate Board iframe. */
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
    const [openCode, setOpenCode] = useState(null);
    const [spotText, setSpotText] = useState("");
    const [spreadText, setSpreadText] = useState(null);
    const [clampNote, setClampNote] = useState("");

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
      if (!board || !board.order.length) {
        setLoadError("There are no currencies on this board.");
        setPhase("error");
        return;
      }
      setPublished(board);
      setDraft(board);
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

    const when = rates.clockLabel(published && published.publishedAt, zone);
    const who = publisherName(published && published.publishedBy, me, settings, srvUser);
    const stamp = when ? (who ? when + ", " + who : when) : "";
    let status = "Not published yet";
    if (!can) status = published ? ("Published " + (stamp || "earlier") + " · Ask a manager to change rates") : "Not published yet. Ask a manager to change rates";
    else if (published) status = stamp ? "Published " + stamp : "Published";
    const home = draft.order.slice(0, 6);
    const rest = draft.order.slice(6);

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

    const body = (
      <>
        {can ? (
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
        ) : null}
        <div className="phone-rate-lock">
          <p><i />{status}</p>
          {can ? <button type="button" className="phone-rate-lockbtn" aria-pressed={!!locked} aria-label={locked ? "Rates locked in this browser" : "Lock rates in this browser"} onClick={onToggleLock}>{locked ? "Locked" : "Lock"}</button> : null}
        </div>
        {feedNote ? <p className="phone-rate-banner" role="alert">{feedNote}</p> : null}
        {list(home, "On your homepage, top 6", can ? "Drag to reorder" : "")}
        {rest.length ? list(rest, "Rate board page only", "") : null}
      </>
    );

    return (
      <div className="phone-rates" data-phone-rates="" data-can-publish={can ? "yes" : "no"}>
        <shell.Screen app="rates" title="Rates">{body}</shell.Screen>
      </div>
    );
  }

  window.CDOS.PhoneRates = PhoneRates;
})();
