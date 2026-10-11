/* Phone Clients. Only mounted at 430px and under.
   The desktop list in cdos-clients.jsx is not this tree.

   A cashier with someone at the counter has one job: find the
   person, see whether the ID on file is Missing ID, Expired, or
   Identified, and open the file. Search is first. Add client is
   the StickyAction. There is no centre plus and no floating
   New transaction on this screen.

   Layout, rows, chips, and money come from the shared phone shell
   (docs/PHONE_SHELL.md). This file does not draw a second one. */
(function () {
  const { useState, useEffect, useMemo } = React;

  /* 430px is the phone shell. Wider than that, the desktop list paints
     and this hook is false, so none of the markup below is mounted. */
  function usePhoneWidth() {
    const query = "(max-width: 430px)";
    const [on, setOn] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
      const mq = window.matchMedia(query);
      const apply = () => setOn(mq.matches);
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }, []);
    return on;
  }

  /* The shell owns the formatter. Absent is an empty string, never
     "0.00 CAD" for a deal the book could not value. */
  function phoneMoney(amount, currency) {
    const format = window.CDOS && (window.CDOS.formatPhoneMoney || (window.CDOS.Phone && window.CDOS.Phone.formatMoney));
    if (typeof format !== "function") return "";
    return format(amount, currency) || "";
  }

  /* TODO: PR #100's displayIdStanding is the shared helper. Call it
     when it is on this branch. Until then the same rule, locally:
     type, number, and expiry on the document. The stored
     verification word is ignored — ID checks are not connected, and
     migration 019 copied "ID on file" into "verified". */
  function phoneIdStanding(record, today) {
    if (window.CDOS && typeof window.CDOS.displayIdStanding === "function") {
      return window.CDOS.displayIdStanding(record, today);
    }
    record = record || {};
    const type = String(record.idType || "").trim();
    const num = String(record.idNum || "").trim();
    let day = today ? String(today).slice(0, 10) : "";
    if (!day) {
      try { day = String(window.CDOS.businessDate()).slice(0, 10); } catch (e) { day = ""; }
    }
    if (!type || !num) return { status: "missing", label: "Missing ID", tone: "warn" };
    const expiry = record.idExpiry ? String(record.idExpiry).slice(0, 10) : "";
    if (expiry && day && expiry < day) return { status: "expired", label: "Expired", tone: "warn" };
    return { status: "identified", label: "Identified", tone: "pos" };
  }

  function shell() {
    const phone = window.CDOS && window.CDOS.Phone;
    if (!phone || typeof phone.Screen !== "function") {
      throw new Error("Phone Clients needs the shared phone shell (docs/PHONE_SHELL.md).");
    }
    return phone;
  }

  function shiftDay(ymd, delta) {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(y, m - 1, d + delta);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return dt.getFullYear() + "-" + mm + "-" + dd;
  }

  function seenWords(date, today) {
    const day = String(date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
    if (!today) return day;
    if (day === today) return "Today";
    if (day === shiftDay(today, -1)) return "Yesterday";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [, mo, dd] = day.split("-").map(Number);
    return months[mo - 1] + " " + dd;
  }

  function initials(name) {
    return (name || "?").split(/[\s.]+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2).toUpperCase();
  }

  function homeCurrency() {
    try {
      const pack = window.CDOS.deskPack && window.CDOS.deskPack();
      return (pack && pack.homeCurrency) || null;
    } catch (e) { return null; }
  }

  function tradingDay() {
    try { return String(window.CDOS.businessDate()).slice(0, 10); } catch (e) { return ""; }
  }

  /* The last posted deal, not a lifetime total. The amount is the
     home-currency leg when the book has one, otherwise the leg that
     exists, with its own code. No leg means no figure. */
  function lastDeal(rows, name, home, today) {
    const mine = (rows || []).filter(row => row.customer === name && row.status !== "void");
    if (!mine.length) return { amount: "", meta: "No deals yet", when: "", key: "" };
    mine.sort((a, b) => ((b.date || "") + " " + (b.time || "")).localeCompare((a.date || "") + " " + (a.time || "")));
    const last = mine[0];
    let amount = "";
    if (home && last.inCcy === home && last.inAmt != null && last.inAmt !== "") amount = phoneMoney(last.inAmt, home);
    else if (home && last.outCcy === home && last.outAmt != null && last.outAmt !== "") amount = phoneMoney(last.outAmt, home);
    else if (last.inCcy && last.inAmt != null && last.inAmt !== "") amount = phoneMoney(last.inAmt, last.inCcy);
    else if (last.outCcy && last.outAmt != null && last.outAmt !== "") amount = phoneMoney(last.outAmt, last.outCcy);
    const when = seenWords(last.date, today);
    const deals = mine.length === 1 ? "1 deal" : mine.length + " deals";
    return { amount, meta: when ? deals + " · " + when : deals, when, key: (last.date || "") + " " + (last.time || "") };
  }

  function peopleOf(rows, clients, store) {
    const mode = store.mode();
    if (mode === "unknown" || store.trouble()) return [];
    const api = window.CDOS.Backend && window.CDOS.Backend.Clients;
    const out = [];
    const seen = {};
    if (mode === "server") {
      store.all().forEach(record => {
        const name = record.legalName;
        if (!name || seen[name]) return;
        seen[name] = true;
        const desk = api ? api.toDeskRecord(record, (clients || {})[name] || {}) : ((clients || {})[name] || {});
        out.push({ name, rec: desk });
      });
    } else {
      Object.keys(clients || {}).forEach(name => {
        if (seen[name]) return;
        seen[name] = true;
        out.push({ name, rec: clients[name] || {} });
      });
    }
    (rows || []).forEach(row => {
      const name = row.customer;
      if (!name || name === "—" || row.status === "void" || seen[name]) return;
      seen[name] = true;
      out.push({ name, rec: (clients || {})[name] || {} });
    });
    return out;
  }

  function PhoneClients({ rows, clients, canEdit, store, reload, onOpen, onAdd, saveErr }) {
    const Phone = shell();
    const [q, setQ] = useState("");
    const [filter, setFilter] = useState("all");
    const [retryErr, setRetryErr] = useState("");
    const today = tradingDay();
    const home = homeCurrency();
    const mode = store.mode();
    const trouble = store.trouble();
    const loading = mode === "unknown";
    const failed = !!(trouble || retryErr || saveErr);

    const people = useMemo(() => peopleOf(rows, clients, store).map(person => {
      const standing = phoneIdStanding(person.rec, today);
      const deal = lastDeal(rows, person.name, home, today);
      return Object.assign({}, person, { standing, deal });
    }), [rows, clients, store, mode, today, home]);

    const matched = useMemo(() => {
      const needle = q.trim().toLowerCase();
      return people.filter(person => {
        if (!needle) return true;
        const rec = person.rec || {};
        const blob = [person.name, rec.phone, rec.email, rec.idNum].join(" ").toLowerCase();
        return blob.includes(needle);
      });
    }, [people, q]);

    const counts = useMemo(() => {
      const tally = { all: matched.length, missing: 0, expired: 0, identified: 0 };
      matched.forEach(person => { if (tally[person.standing.status] != null) tally[person.standing.status] += 1; });
      return tally;
    }, [matched]);

    const shown = useMemo(() => {
      const list = filter === "all" ? matched : matched.filter(person => person.standing.status === filter);
      return list.slice().sort((a, b) => (b.deal.key || "").localeCompare(a.deal.key || "") || a.name.localeCompare(b.name));
    }, [matched, filter]);

    const chips = [
      { id: "all", label: "All", count: counts.all },
      { id: "missing", label: "Missing ID", count: counts.missing },
      { id: "expired", label: "Expired", count: counts.expired },
      { id: "identified", label: "Identified", count: counts.identified },
    ];

    let state = "list";
    if (loading) state = "loading";
    else if (failed && mode !== "server") state = "error";
    else if (!q && filter === "all" && people.length === 0) state = "empty";
    else if (shown.length === 0) state = "nomatch";

    const retry = async () => {
      setRetryErr("");
      try { await reload(true); }
      catch (e) { setRetryErr((e && e.message) || "CurrencyDesk could not load clients."); }
    };

    const fault = trouble || retryErr || saveErr;
    const sticky = canEdit && state !== "loading" && state !== "empty"
      ? <Phone.StickyAction label="Add client" onClick={onAdd} />
      : null;

    return (
      <Phone.Screen
        app="clients"
        title="Clients"
        className="phone-clients"
        sticky={sticky}
        banner={(
          <>
            <Phone.Search value={q} onChange={setQ} placeholder="Search name, phone or ID" label="Search clients" />
            {state !== "loading" && state !== "empty" && (
              <Phone.FilterChips chips={chips} value={filter} onChange={setFilter} />
            )}
          </>
        )}
      >
        <span className="phone-clients-state" data-phone-state={state} hidden />
        {state === "loading" && <Phone.LoadingState rows={4} label="Loading clients" />}
        {state === "error" && <Phone.ErrorState message={fault || "CurrencyDesk could not load clients."} onRetry={retry} />}
        {state === "empty" && (
          <Phone.EmptyState
            title="No clients yet"
            message="Add a client the first time they deal with you. Their ID stays on their file for next time."
            actionLabel={canEdit ? "Add client" : undefined}
            onAction={canEdit ? onAdd : undefined}
          />
        )}
        {fault && state !== "error" && state !== "loading" && (
          <Phone.ErrorState message={fault} onRetry={retry} />
        )}
        {state === "nomatch" && (
          <Phone.EmptyState
            title={q.trim() ? "No match for " + q.trim() : "No one in this filter"}
            message={q.trim() ? "Nothing in this list has that name, phone, or ID." : "Nothing in this list is in that group."}
            actionLabel={q.trim() ? "Clear search" : undefined}
            onAction={q.trim() ? () => setQ("") : undefined}
          />
        )}
        {state === "list" && (
          <Phone.ListSection title={shown.length === 1 ? "1 contact" : shown.length + " contacts"} meta="Last deal">
            {shown.map(person => (
              <Phone.ListRow
                key={person.name}
                className={"phone-client-row id-" + person.standing.status}
                title={person.name}
                subtitle={person.rec.kind === "corporate" ? "Business" : "Individual"}
                amount={person.deal.amount || undefined}
                meta={person.deal.meta}
                badge={{ tone: person.standing.tone === "pos" ? "pos" : "warn", label: person.standing.label }}
                leading={<span className="phone-ini" aria-hidden="true">{initials(person.name)}</span>}
                onClick={() => onOpen(person.name)}
              />
            ))}
          </Phone.ListSection>
        )}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    usePhoneWidth, phoneIdStanding, PhoneClients,
  });
})();
