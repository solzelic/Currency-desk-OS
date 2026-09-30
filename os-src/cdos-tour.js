/* ============================================================
   CurrencyDesk OS — first-run tour

   The first time a person reaches the desk, a short walk-through
   opens the screens they will actually use and says what each one
   is for. It is not a second dashboard and it does not invent a
   screen to have something to point at.

   TWO TOURS, CHOSEN BY ROLE

   The OS role is the one the shell already uses (`Owner`, `Manager`,
   `Senior teller`, `Cashier`, `Trainee`). The server's `administrator`
   has already been mapped to `Owner` by the time this runs.

     Owner     the shop, then the client book, then the file folder
               on a customer record: identification standing, the
               papers filed there, and search inside that folder.
     Everyone  the cash drawer they actually work: the till, then
     else      the count. Reconcile and close is not a step. That
               panel is the close itself, and with no count saved it
               shows an error. The tour does not count, post, or
               close cash to clear that error, so the step is left out.

   A step whose app is not on this person's dock is dropped. The
   cash drawer is gated on the same permissions as the dock
   (`canViewReports` or `canCloseDay`), so a cashier or a trainee
   is not walked into a window the desk has not given them. There
   is no substitute tour for that case — a made-up path would be
   the thing this file exists to avoid.

   The folder steps need a real customer to open. With none on the
   book, those steps are dropped and the tour stops at the client
   list. Search inside the folder only exists once a customer has
   a paper; the screen drops that control, and the shell drops the
   step when the anchor is not in the document (`dropUnplaced`).

   WHAT "DONE" IS STORED AS

   Operator preferences already live in the desk document: every
   `cdos_*` key in localStorage is loaded on sign-in and written
   back by `cdos-persist.js` (`GET`/`PUT /api/tenant/state`). A
   flag that lived only in `sessionStorage`, or in a `cdos_*` key
   the catalogue did not know, would vanish on the refresh that
   puts the rest of the desk back.

   So the choice is one preference key, `cdos_tour_v1`, a map from
   staff id to `{ status, tour }`. Staff id, not the person's name:
   names collide and get edited. The document is per desk, so the
   map is what keeps one person's skip from dismissing a colleague.

   The known limit of that document applies here too. A save is
   merged per key, and this is one key. Two people finishing in the
   same moment, on two browsers, can lose one of the two entries.
   The next sign-in shows the tour once more to whoever lost. That
   is the same limit as app order, and it is not a reason to put a
   screen preference in its own table.

   This file does not file a paper and does not write a client.
   Identification standing is read by the screen the tour points
   at; nothing here changes it.
   ============================================================ */
(function () {
  /* The localStorage key. Also the key inside the tenant document.
     The catalogue in server/src/state/shape.ts has to name it — a
     test reads the sources and fails when a new key is not listed. */
  var KEY = 'cdos_tour_v1';

  /* Anchors are `data-tour` attributes on the real screens. `app`
     is the dock id; if it is not in the list the shell passes, the
     step is not offered. `needsClient` steps open a real customer
     record first. The shell does not draw the card until that
     anchor is on a window that has actually opened. */
  var OWNER_STEPS = [
    {
      id: 'shop',
      tour: 'owner',
      app: 'dashboard',
      anchor: 'shop',
      title: 'The shop',
      body: 'This is the shop. Earnings, cash, and what the book holds, for the period you choose. The figures are the ledger’s.',
    },
    {
      id: 'clients',
      tour: 'owner',
      app: 'clients',
      anchor: 'clients',
      title: 'Clients',
      body: 'Customers live here. Search by name, by phone, or by a paper filed on their record.',
    },
    {
      id: 'standing',
      tour: 'owner',
      app: 'clients',
      anchor: 'identification',
      needsClient: true,
      title: 'Identification',
      body: 'Where this customer stands. Identified, expired, or not yet. A paper in the folder does not move it.',
    },
    {
      id: 'folder',
      tour: 'owner',
      app: 'clients',
      anchor: 'file-folder',
      needsClient: true,
      title: 'The file folder',
      body: 'Papers filed on this customer — proof of address, source of funds, corporate filings. They stay with the record.',
    },
    {
      id: 'search',
      tour: 'owner',
      app: 'clients',
      anchor: 'file-search',
      needsClient: true,
      title: 'Search the folder',
      body: 'Find a paper by the label or the file name the desk gave it.',
    },
  ];

  var EMPLOYEE_STEPS = [
    {
      id: 'till',
      tour: 'employee',
      app: 'till',
      anchor: 'till',
      title: 'The till',
      body: 'This is the till. The drawer, the session, and the cash the ledger says is in it.',
    },
    {
      id: 'count',
      tour: 'employee',
      app: 'till',
      anchor: 'till-count',
      title: 'The count',
      body: 'Count the drawer here, bill and coin. A count is not on the book until you save it.',
    },
  ];

  function kindForRole(role) {
    return role === 'Owner' ? 'owner' : 'employee';
  }

  function hasApp(apps, id) {
    if (!apps) return true; // caller did not restrict the dock
    return apps.indexOf(id) !== -1;
  }

  /* The steps this person can be shown. `apps` is the dock they
     actually have. `hasClient` is whether the book has someone to
     open — the folder is a panel on a customer, not its own app. */
  function stepsFor(opts) {
    opts = opts || {};
    var kind = kindForRole(opts.role);
    var source = kind === 'owner' ? OWNER_STEPS : EMPLOYEE_STEPS;
    var out = [];
    for (var i = 0; i < source.length; i++) {
      var step = source[i];
      if (!hasApp(opts.apps, step.app)) continue;
      if (step.needsClient && !opts.hasClient) continue;
      out.push(step);
    }
    return out;
  }

  /* A customer to open the folder on. Prefer one who already has
     a paper, so the search field — which the screen only draws
     when there is something to search — is on the page. */
  function clientForTour(clients) {
    if (!clients || typeof clients !== 'object') return null;
    var names = Object.keys(clients).filter(function (n) {
      return clients[n] && typeof clients[n] === 'object';
    });
    if (!names.length) return null;
    for (var i = 0; i < names.length; i++) {
      var docs = clients[names[i]].docs;
      if (Array.isArray(docs) && docs.length) return names[i];
    }
    return names[0];
  }

  function hasClient(clients) {
    return clientForTour(clients) != null;
  }

  /* The shell calls this when it has looked for an anchor and the
     screen did not render it. The step is removed; the rest stand.
     Used for the folder search (no papers, no field) and for any
     step whose screen is not actually in the running app. */
  function dropUnplaced(steps, missingAnchors) {
    var missing = {};
    (missingAnchors || []).forEach(function (a) { if (a) missing[a] = 1; });
    return (steps || []).filter(function (s) { return !s.anchor || !missing[s.anchor]; });
  }

  function staffKey(id) {
    var s = String(id == null ? '' : id).trim().toLowerCase();
    return s || null;
  }

  function read(storage) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    var raw;
    try { raw = storage.getItem(KEY); } catch (e) { return {}; }
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (e) {
      return {};
    }
  }

  /* `skipped` and `finished` both mean do not show it again.
     Anything else (a half-written row, a future status) shows the
     tour, which is the safe side of a bad read. */
  function outcome(book, id) {
    var key = staffKey(id);
    if (!key || !book) return null;
    var row = book[key];
    if (!row) return null;
    if (row.status === 'skipped' || row.status === 'finished') return row.status;
    return null;
  }

  function shouldShow(book, id) {
    if (!staffKey(id)) return false;
    return outcome(book, id) == null;
  }

  /* Writes this person's row and leaves every other person alone.
     `now` is injectable so a test does not depend on the clock. */
  function record(storage, id, status, tour, now) {
    var book = read(storage);
    var key = staffKey(id);
    if (!key) return book;
    if (status !== 'skipped' && status !== 'finished') return book;
    var kind = tour === 'owner' ? 'owner' : 'employee';
    book[key] = {
      status: status,
      tour: kind,
      at: now || new Date().toISOString(),
    };
    try { storage.setItem(KEY, JSON.stringify(book)); } catch (e) {}
    return book;
  }

  window.CDOS_TOUR = {
    KEY: KEY,
    kindForRole: kindForRole,
    stepsFor: stepsFor,
    clientForTour: clientForTour,
    hasClient: hasClient,
    dropUnplaced: dropUnplaced,
    staffKey: staffKey,
    read: read,
    outcome: outcome,
    shouldShow: shouldShow,
    record: record,
  };
})();
