/* Phone Clients. Only mounted at 430px and under.
   The desktop list in cdos-clients.jsx is not this tree.

   A cashier with someone at the counter has one job: find the
   person, see whether the ID on file is Missing ID, Expired, or
   Identified, and open the file. Search is first. Add client is
   the StickyAction. There is no centre plus and no floating
   New transaction on this screen.

   Layout, rows, chips, and money come from the shared phone shell
   (docs/PHONE_SHELL.md). This file does not draw a second one.

   The list is the server's client file. Ledger rows are not clients.
   A document that exists only in this browser does not identify
   anyone. /api/clients does not return a deal count or a last-deal
   date, so the row does not invent either. */
(function () {
  const { useState, useEffect, useMemo } = React;
  const BRANCH_ZONE = "America/Toronto";

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

  /* Calendar day in the branch zone. A YYYY-MM-DD string is never
     parsed with Date: that parse is UTC midnight, which is the
     previous evening in Toronto. toISOString() is the UTC day, so
     9 PM in Toronto would already be tomorrow. */
  function phoneBranchDay(at) {
    const when = at instanceof Date ? at : new Date(at || Date.now());
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BRANCH_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(when);
    const pick = (type) => {
      const found = parts.find(part => part.type === type);
      return found ? found.value : "";
    };
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    if (!year || !month || !day) return "";
    return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }

  function shiftDay(ymd, delta) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    if (!match) return "";
    const utc = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    utc.setUTCDate(utc.getUTCDate() + delta);
    return utc.toISOString().slice(0, 10);
  }

  /* `today` is already a branch calendar day. The word is Today,
     Yesterday, or Mon D. It is not a clock. */
  function seenWords(date, today) {
    const day = String(date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))) return "";
    if (day === today) return "Today";
    if (day === shiftDay(today, -1)) return "Yesterday";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [, mo, dd] = day.split("-").map(Number);
    return months[mo - 1] + " " + dd;
  }

  /* Day word for a calendar date, judged on the branch day of `at`.
     PR #128's session business date replaces the wall clock once that
     branch is underneath this one. Until then the branch zone is
     America/Toronto, not the machine zone and not UTC. */
  function phoneDayWord(date, at) {
    return seenWords(date, phoneBranchDay(at));
  }

  function tradingDay() {
    return phoneBranchDay(new Date());
  }

  function isHealthCard(type) {
    return /health\s*card/i.test(String(type || ""));
  }

  /* #100's displayIdStanding is the shared label. `ok` is the green
     tone that helper uses; this screen's badge paints green as `pos`.
     Until that helper is on the branch, the same outcomes live here:
     a health card is not ID, a blank number is not ID, a blank expiry
     is not current, and the expiry date itself is still current.
     A record the server did not return is Missing ID even when this
     browser is holding a document for the name. */
  function paintStanding(standing) {
    standing = standing || {};
    const tone = standing.tone === "ok" || standing.tone === "pos" ? "pos" : "warn";
    const reason = standing.reason || standing.detail || "";
    return Object.assign({}, standing, { tone: tone, reason: reason });
  }

  function localStanding(record, today) {
    record = record || {};
    const type = String(record.idType || "").trim();
    const num = String(record.idNum || "").trim();
    let day = today ? String(today).slice(0, 10) : "";
    if (!day) day = tradingDay();
    if (!type) return { status: "missing", label: "Missing ID", reason: "No ID on file", tone: "warn" };
    if (isHealthCard(type)) return { status: "missing", label: "Missing ID", reason: "Health cards can't be used as ID", tone: "warn" };
    if (!num) return { status: "missing", label: "Missing ID", reason: "No ID number", tone: "warn" };
    const expiry = record.idExpiry ? String(record.idExpiry).slice(0, 10) : "";
    if (!expiry) return { status: "missing", label: "Missing ID", reason: "ID has no expiry date", tone: "warn" };
    if (!day) return { status: "missing", label: "Missing ID", reason: "No ID on file", tone: "warn" };
    if (expiry < day) {
      return { status: "expired", label: "Expired", reason: "Past its expiry", tone: "warn" };
    }
    return { status: "identified", label: "Identified", reason: "", tone: "pos" };
  }

  function phoneIdStanding(record, today) {
    record = record || {};
    if (!record.clientId && !record.serverBacked) {
      return { status: "missing", label: "Missing ID", reason: "No ID on file", tone: "warn" };
    }
    if (window.CDOS && typeof window.CDOS.displayIdStanding === "function") {
      return paintStanding(window.CDOS.displayIdStanding(record, today));
    }
    return paintStanding(localStanding(record, today));
  }

  function shell() {
    const phone = window.CDOS && window.CDOS.Phone;
    if (!phone || typeof phone.Screen !== "function") {
      throw new Error("Phone Clients needs the shared phone shell (docs/PHONE_SHELL.md).");
    }
    return phone;
  }

  function initials(name) {
    return (name || "?").split(/[\s.]+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2).toUpperCase();
  }

  /* Line 2 is the ID, not a deal count. The client API does not
     return how many deals someone has done or when the last one was,
     and counting ledger rows would pretend the loaded window is the
     whole book. A business says Business in front. */
  function rowSubtitle(person) {
    const standing = person.standing || {};
    const business = person.rec.kind === "corporate" || person.rec.kind === "business";
    let line = "";
    if (standing.status === "missing") line = standing.reason || "No ID on file";
    else if (standing.status === "expired") line = standing.reason || "Past its expiry";
    else if (person.rec.idType && !isHealthCard(person.rec.idType)) line = String(person.rec.idType);
    if (business) return line ? "Business · " + line : "Business";
    return line;
  }

  function peopleOf(clients, store) {
    const mode = store.mode();
    if (mode === "unknown") return [];
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
      return out;
    }
    /* A failed load may show the copy this phone already held. It
       does not invent people from ledger rows. */
    Object.keys(clients || {}).forEach(name => {
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push({ name, rec: clients[name] || {} });
    });
    return out;
  }

  function fold(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  /* Digits only. A leading 1 on an 11-digit number is the country
     code, so 1-416-555-0199 and (416) 555-0199 are the same phone. */
  function phoneDigits(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
    return digits;
  }

  function idNumbers(rec) {
    const out = [];
    const push = (type, num) => {
      if (!num || isHealthCard(type)) return;
      out.push(String(num));
    };
    push(rec.idType, rec.idNum);
    (rec.ids || []).forEach(doc => push(doc.type, doc.num));
    (rec.documents || []).forEach(doc => push(doc.docType || doc.type, doc.docNumber || doc.num));
    return out;
  }

  /* A phone query is digits, with the punctuation people type in a
     number. An ID that also contains a digit is not a phone, so those
     digits are not compared to every number on file. */
  function queryIsPhone(needle) {
    const compact = String(needle || "").replace(/[\s().+-]/g, "");
    return compact.length >= 3 && /^\d+$/.test(compact);
  }

  function matchesQuery(person, needle) {
    const rec = person.rec || {};
    const folded = fold(needle);
    if (!folded) return true;
    if (fold(person.name).indexOf(folded) !== -1) return true;
    if (fold(rec.email).indexOf(folded) !== -1) return true;
    if (queryIsPhone(needle)) {
      const want = phoneDigits(needle);
      if (want && phoneDigits(rec.phone).indexOf(want) !== -1) return true;
    }
    return idNumbers(rec).some(num => fold(num).indexOf(folded) !== -1);
  }

  function PhoneClients({ clients, canEdit, store, reload, onOpen, onRecordId, onAdd, saveErr }) {
    const Phone = shell();
    const [q, setQ] = useState("");
    const [filter, setFilter] = useState("all");
    const [retryErr, setRetryErr] = useState("");
    const [online, setOnline] = useState(() => navigator.onLine !== false);
    const [slow, setSlow] = useState(false);
    const today = tradingDay();
    const mode = store.mode();
    const loading = mode === "unknown";
    /* Anything that is not the server's list is a failed load: offline,
       a 401, a network error, a 5xx. A desk that never got an answer
       is still loading, and it is not a list. */
    const loadFailed = !loading && mode !== "server";
    const canWrite = mode === "server" && online && !retryErr;

    useEffect(() => {
      const up = () => setOnline(true);
      const down = () => setOnline(false);
      window.addEventListener("online", up);
      window.addEventListener("offline", down);
      return () => {
        window.removeEventListener("online", up);
        window.removeEventListener("offline", down);
      };
    }, []);

    useEffect(() => {
      if (!loading) { setSlow(false); return undefined; }
      const timer = setTimeout(() => setSlow(true), 20000);
      return () => clearTimeout(timer);
    }, [loading]);

    const people = useMemo(() => peopleOf(clients, store).map(person => {
      const standing = phoneIdStanding(person.rec, today);
      return Object.assign({}, person, { standing: standing });
    }), [clients, store, mode, today]);

    const matched = useMemo(() => {
      const needle = q.trim();
      return people.filter(person => matchesQuery(person, needle));
    }, [people, q]);

    const counts = useMemo(() => {
      const tally = { all: matched.length, missing: 0, expired: 0, identified: 0 };
      matched.forEach(person => { if (tally[person.standing.status] != null) tally[person.standing.status] += 1; });
      return tally;
    }, [matched]);

    const shown = useMemo(() => {
      const list = filter === "all" ? matched : matched.filter(person => person.standing.status === filter);
      return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    }, [matched, filter]);

    /* A failed load has no trustworthy counts. "All 0" would read as
       an empty book. The words stay; the numbers wait for the server. */
    const chips = [
      { id: "all", label: "All", count: loadFailed ? undefined : counts.all },
      { id: "missing", label: "Missing ID", count: loadFailed ? undefined : counts.missing },
      { id: "expired", label: "Expired", count: loadFailed ? undefined : counts.expired },
      { id: "identified", label: "Identified", count: loadFailed ? undefined : counts.identified },
    ];

    const showingLocal = loadFailed && people.length > 0;
    const wentOffline = mode === "server" && !online;
    const blockedReason = wentOffline
      ? "Offline. Showing the last loaded list."
      : "Couldn't load clients. Try again before adding someone.";

    let state = "list";
    if (loading) state = "loading";
    else if (loadFailed && people.length === 0) state = "error";
    else if (!q && filter === "all" && people.length === 0) state = "empty";
    else if (shown.length === 0) state = "nomatch";

    const retry = async () => {
      setRetryErr("");
      try { await reload(true); }
      catch (e) { setRetryErr((e && e.message) || "Couldn't load clients."); }
    };

    const addClient = () => { if (canWrite) onAdd(); };
    const recordId = (name) => { if (canWrite && typeof onRecordId === "function") onRecordId(name); };
    const sticky = canEdit && state !== "empty"
      ? <Phone.StickyAction label="Add client" onClick={addClient} disabled={!canWrite} disabledReason={!canWrite ? blockedReason : ""} />
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
        {state === "loading" && (
          <>
            <Phone.LoadingState rows={4} label="Loading clients" />
            {slow ? <p className="phone-slow" role="status">Waking the server up, this can take a minute.</p> : null}
          </>
        )}
        {state === "error" && (
          <div className="phone-state-card" role="alert">
            <Phone.EmptyState
              title="Couldn't load clients"
              message="Check the connection and try again."
              actionLabel="Try again"
              onAction={retry}
            />
          </div>
        )}
        {state === "empty" && (
          <div className="phone-state-card">
            <div className="phone-sec"><span>0 contacts</span></div>
            <Phone.EmptyState
              title="No clients yet"
              message="Add a client the first time they deal with you. Their ID stays on their file for next time."
              actionLabel={canEdit && canWrite ? "Add client" : undefined}
              onAction={canEdit && canWrite ? addClient : undefined}
            />
          </div>
        )}
        {wentOffline && (
          <p className="phone-stale" role="status">Offline. Showing the last loaded list.</p>
        )}
        {showingLocal && (
          <p className="phone-stale" role="status">Showing the copy on this phone. It may be out of date.</p>
        )}
        {saveErr && state !== "loading" && (
          <p className="phone-stale" role="alert">{saveErr}</p>
        )}
        {retryErr && state !== "loading" && (
          <p className="phone-stale" role="alert">{retryErr}</p>
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
          <Phone.ListSection title={shown.length === 1 ? "1 contact" : shown.length + " contacts"} meta="Identified">
            {shown.map(person => {
              const needsId = person.standing.status === "missing" || person.standing.status === "expired";
              const fixId = needsId && canEdit && canWrite && typeof onRecordId === "function";
              return (
                <Phone.ListRow
                  key={person.name}
                  className={"phone-client-row id-" + person.standing.status + (fixId ? " has-chevron" : "")}
                  title={person.name}
                  subtitle={rowSubtitle(person)}
                  badge={{ tone: person.standing.tone === "ok" || person.standing.tone === "pos" ? "pos" : "warn", label: person.standing.label }}
                  leading={<span className="phone-ini" aria-hidden="true">{initials(person.name)}</span>}
                  chevron={fixId}
                  onClick={() => (fixId ? recordId(person.name) : onOpen(person.name))}
                />
              );
            })}
          </Phone.ListSection>
        )}
      </Phone.Screen>
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    usePhoneWidth, phoneIdStanding, phoneDayWord, phoneBranchDay, PhoneClients,
  });
})();
