/* ============================================================
   CurrencyDesk OS — quick search

   Cmd K / Ctrl K, and the header button, ask one question: what
   on this desk matches? The answer is assembled here, not in a
   second search engine.

   Deals go through `makeSearch` (os-src/cdos-search.jsx), the same
   matcher the Ledger screen already runs over the book. Clients
   and files use the fields the client list already returns: name,
   the id the server minted, phone, and a file's label or name.
   The same fields are what `GET /api/clients?q=` and
   `GET /api/ledger/transactions?q=` narrow by. Those routes stay
   scoped to the signed-in desk and the permission the person
   already has. This file only arranges what those calls return,
   plus the screens this person can already open.

   An empty box is not a search. It shows the last few things they
   opened from here, then the screens.
   ============================================================ */
(function () {
  /* The five jumps the palette offers. Titles are the words a teller
     says, which is why the till is "Till" even though the window
     title is "Cash Drawer". */
  var JUMPS = [
    { app: 'till', title: 'Till', hint: 'Cash drawer', icon: 'coins' },
    { app: 'ledger', title: 'Ledger', hint: 'The book', icon: 'ledgerbook' },
    { app: 'clients', title: 'Clients', hint: 'Customer files', icon: 'users' },
    { app: 'settings', title: 'Settings', hint: 'Desk setup', icon: 'gear' },
    { app: 'rates', title: 'Rate board', hint: 'Live rates', icon: 'rateboard' },
  ];

  var RECENT_KEY = 'cdos_palette_recent_v1';
  var LIMIT = 8;

  /* Cmd K on a Mac, Ctrl K everywhere else. Shift and Alt are left
     alone so they can keep meaning something else. Held keys repeat,
     and a repeat would open and shut the palette in one gesture. */
  function isPaletteChord(e) {
    if (!e || e.altKey || e.shiftKey || e.repeat) return false;
    var key = e.key;
    if (key !== 'k' && key !== 'K') return false;
    return !!(e.metaKey || e.ctrlKey);
  }

  function includes(hay, needle) {
    return String(hay == null ? '' : hay).toLowerCase().indexOf(needle) !== -1;
  }

  function digits(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
  }

  function papersOf(rec) {
    if (!rec) return [];
    return [].concat(rec.docs || [], rec.files || []);
  }

  /* Name, minted id, phone. A phone typed with spaces or dashes still
     matches the number on the file once both sides are digits. Three
     digits is the floor so "1" does not hit every North American number. */
  function clientHit(name, rec, needle) {
    rec = rec || {};
    if (includes(name, needle) || includes(rec.legalName, needle)) return true;
    if (includes(rec.clientId, needle) || includes(rec.phone, needle)) return true;
    var typed = digits(needle);
    if (typed.length >= 3 && digits(rec.phone).indexOf(typed) !== -1) return true;
    var aliases = rec.aliases || [];
    for (var i = 0; i < aliases.length; i++) {
      var alias = aliases[i];
      var text = typeof alias === 'string' ? alias : (alias && alias.alias);
      if (includes(text, needle)) return true;
    }
    return false;
  }

  function peopleFrom(clients) {
    var list = [];
    if (!clients) return list;
    if (Array.isArray(clients)) {
      clients.forEach(function (rec) {
        if (!rec) return;
        list.push({ name: rec.legalName || rec.name || 'Client', rec: rec });
      });
      return list;
    }
    Object.keys(clients).forEach(function (name) {
      list.push({ name: name, rec: clients[name] || {} });
    });
    return list;
  }

  function screensFor(canOpen, needle) {
    var out = [];
    JUMPS.forEach(function (jump) {
      if (typeof canOpen === 'function' && !canOpen(jump.app)) return;
      if (needle && !includes(jump.title, needle) && !includes(jump.hint, needle) && !includes(jump.app, needle)) return;
      out.push({
        kind: 'screen',
        id: 'screen:' + jump.app,
        app: jump.app,
        title: jump.title,
        subtitle: jump.hint,
        icon: jump.icon,
      });
    });
    return out;
  }

  function dealSubtitle(row) {
    var parts = [];
    if (row.customer) parts.push(String(row.customer));
    if (row.inAmt !== '' && row.inAmt != null) {
      parts.push(String(row.inAmt) + (row.inCcy ? ' ' + row.inCcy : ''));
    }
    return parts.join(' · ');
  }

  /* Local rows are the book the ledger screen is already showing.
     Server rows are the same list endpoint, narrowed by q, for a
     receipt that has scrolled off that window. Both are judged by
     makeSearch so a deal the ledger would hide is not offered here. */
  function dealRows(localRows, serverRows, query, makeSearch) {
    var search = (typeof makeSearch === 'function' ? makeSearch : function () {
      return { active: false, match: function () { return false; } };
    })(query);
    if (!search || !search.active) return [];
    var seen = {};
    var out = [];
    function consider(row) {
      if (!row) return;
      var key = String(row.serverTransactionId || row.id || row.ref || '');
      if (!key || seen[key]) return;
      var hit = false;
      try { hit = !!search.match(row); } catch (e) { hit = false; }
      if (!hit) return;
      seen[key] = true;
      out.push(row);
    }
    (localRows || []).forEach(consider);
    (serverRows || []).forEach(consider);
    return out;
  }

  function flatten(groups) {
    var items = [];
    groups.forEach(function (group) {
      (group.items || []).forEach(function (item) { items.push(item); });
    });
    return items;
  }

  function query(opts) {
    opts = opts || {};
    var q = String(opts.query || '').trim();
    var needle = q.toLowerCase();
    var canOpen = opts.canOpen;
    var groups = [];

    if (!needle) {
      var recent = (opts.recent || []).filter(function (item) {
        if (!item || !item.kind || !item.title) return false;
        if (item.kind === 'screen') return typeof canOpen !== 'function' || !!canOpen(item.app);
        return true;
      }).slice(0, 6);
      if (recent.length) groups.push({ id: 'recent', label: 'Recent', items: recent });
      var home = screensFor(canOpen, '');
      if (home.length) groups.push({ id: 'screens', label: 'Screens', items: home });
      return { query: q, groups: groups, items: flatten(groups) };
    }

    var screens = screensFor(canOpen, needle).slice(0, LIMIT);
    if (screens.length) groups.push({ id: 'screens', label: 'Screens', items: screens });

    var people = [];
    var files = [];
    peopleFrom(opts.clients).forEach(function (person) {
      var rec = person.rec || {};
      if (clientHit(person.name, rec, needle)) {
        var id = rec.clientId || '';
        var phone = rec.phone || '';
        var bits = [];
        if (id) bits.push(id);
        if (phone) bits.push(phone);
        people.push({
          kind: 'client',
          id: 'client:' + (id || person.name),
          title: person.name,
          subtitle: bits.join(' · ') || 'Client',
          name: person.name,
          icon: 'users',
        });
      }
      papersOf(rec).forEach(function (doc, i) {
        if (!doc) return;
        var label = doc.label || '';
        var fileName = doc.fileName || doc.file_name || '';
        if (!includes(label, needle) && !includes(fileName, needle)) return;
        var fileId = doc.fileId || doc.image_id || null;
        files.push({
          kind: 'file',
          id: 'file:' + (fileId || (person.name + ':' + i)),
          title: label || fileName || 'File',
          subtitle: person.name + (fileName && label ? ' · ' + fileName : ''),
          name: person.name,
          fileId: fileId,
          icon: 'scroll',
        });
      });
    });
    if (people.length) groups.push({ id: 'clients', label: 'Clients', items: people.slice(0, LIMIT) });

    var deals = dealRows(opts.rows, opts.serverRows, q, opts.makeSearch).slice(0, LIMIT).map(function (row) {
      return {
        kind: 'deal',
        id: 'deal:' + (row.id || row.ref),
        title: row.ref || 'Deal',
        subtitle: dealSubtitle(row) || 'Deal',
        rowId: row.id,
        ref: row.ref || '',
        row: row,
        icon: 'receipt',
      };
    });
    if (deals.length) groups.push({ id: 'deals', label: 'Deals', items: deals });
    if (files.length) groups.push({ id: 'files', label: 'Files', items: files.slice(0, LIMIT) });

    return { query: q, groups: groups, items: flatten(groups) };
  }

  /* Arrow keys wrap, the way a short list expects. An empty list stays
     on 0 so the next result has somewhere to land. */
  function moveIndex(index, dir, count) {
    if (!count) return 0;
    var next = (index || 0) + (dir === 'up' ? -1 : 1);
    if (next < 0) return count - 1;
    if (next >= count) return 0;
    return next;
  }

  function readRecent(storage) {
    if (!storage || typeof storage.getItem !== 'function') return [];
    try {
      var parsed = JSON.parse(storage.getItem(RECENT_KEY) || 'null');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  /* Newest first, one row per id, capped so the empty state stays a
     short list and not a second history. */
  function remember(storage, item) {
    var current = readRecent(storage).filter(function (row) {
      return row && row.id !== item.id;
    });
    var next = [{
      kind: item.kind,
      id: item.id,
      title: item.title,
      subtitle: item.subtitle || '',
      app: item.app || null,
      name: item.name || null,
      rowId: item.rowId != null ? item.rowId : null,
      ref: item.ref || null,
      fileId: item.fileId || null,
      icon: item.icon || null,
    }].concat(current).slice(0, 8);
    try { storage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  window.CDOS_PALETTE = {
    JUMPS: JUMPS,
    RECENT_KEY: RECENT_KEY,
    isPaletteChord: isPaletteChord,
    clientHit: clientHit,
    query: query,
    moveIndex: moveIndex,
    readRecent: readRecent,
    remember: remember,
  };
})();
