/* ============================================================
   CurrencyDesk OS — quick search palette

   The box itself. Matching lives in cdos-palette.js so a test can
   run it without painting. This file draws that result, takes the
   keys, and asks the shell to open whatever was chosen.

   Typing waits a short beat before the list moves, and before any
   request goes out. The page does not reload. A desk with a server
   session asks the client list and the transaction list (the same
   routes the screens already use) and prefers that answer, because
   it is already limited to this desk and this person. If those
   routes are not there, the book on screen is the search.
   ============================================================ */
(function () {
  const { useState, useEffect, useMemo, useRef } = React;
  const { Ic } = window.CDOS;
  const P = window.CDOS_PALETTE;

  function shortcutLabel() {
    var mac = false;
    try {
      mac = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '');
    } catch (e) {}
    return mac ? 'Cmd K' : 'Ctrl K';
  }

  function QuickSearch({ open, onOpen, onClose, blocked, clients, rows, canOpen, serverBacked, onChoose }) {
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [index, setIndex] = useState(0);
    const [recent, setRecent] = useState(function () { return P.readRecent(window.localStorage); });
    const [serverClients, setServerClients] = useState(null);
    const [serverRows, setServerRows] = useState(null);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);
    const listRef = useRef(null);
    const seq = useRef(0);
    const chord = shortcutLabel();

    useEffect(function () {
      var t = setTimeout(function () { setDebounced(query); }, 140);
      return function () { clearTimeout(t); };
    }, [query]);

    useEffect(function () {
      if (!open) return undefined;
      setQuery('');
      setDebounced('');
      setIndex(0);
      setServerClients(null);
      setServerRows(null);
      setBusy(false);
      setRecent(P.readRecent(window.localStorage));
      var frame = requestAnimationFrame(function () {
        if (inputRef.current) inputRef.current.focus();
      });
      return function () { cancelAnimationFrame(frame); };
    }, [open]);

    useEffect(function () {
      if (!open || !serverBacked) return undefined;
      var q = debounced.trim();
      if (!q) {
        setServerClients(null);
        setServerRows(null);
        setBusy(false);
        return undefined;
      }
      var token = ++seq.current;
      var cancelled = false;
      setBusy(true);
      (async function () {
        var api = window.CDOS.Backend;
        var nextClients = null;
        var nextRows = null;
        if (api && api.Clients && api.Clients.list) {
          try {
            var listed = await api.Clients.list(q);
            nextClients = (listed && listed.clients) || [];
          } catch (e) { /* the screen's own copy is the fallback */ }
        }
        if (api && api.searchDeals) {
          try { nextRows = await api.searchDeals(q); } catch (e) {}
        }
        if (cancelled || token !== seq.current) return;
        setServerClients(nextClients);
        setServerRows(nextRows);
        setBusy(false);
      })();
      return function () { cancelled = true; };
    }, [open, debounced, serverBacked]);

    const result = useMemo(function () {
      return P.query({
        query: debounced,
        clients: serverClients != null ? serverClients : clients,
        rows: rows,
        serverRows: serverRows || [],
        recent: recent,
        canOpen: canOpen,
        makeSearch: window.CDOS.makeSearch,
      });
    }, [debounced, clients, rows, serverClients, serverRows, recent, canOpen]);

    useEffect(function () { setIndex(0); }, [debounced, result.items.length]);

    useEffect(function () {
      if (!open || !listRef.current) return;
      var selected = listRef.current.querySelector('[aria-selected="true"]');
      if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
    }, [open, index]);

    function choose(item) {
      if (!item) return;
      var next = P.remember(window.localStorage, item);
      setRecent(next);
      onClose();
      if (onChoose) onChoose(item);
    }

    useEffect(function () {
      function onKey(e) {
        /* Capture, and stop the event cold. The first-run tour also
           listens for Escape, on the bubble. Stopping here means the
           palette closes and the tour does not skip out from under it. */
        function take(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        }
        if (P.isPaletteChord(e)) {
          if (blocked) return;
          take(e);
          if (open) onClose();
          else onOpen();
          return;
        }
        if (!open) return;
        if (e.key === 'Escape') {
          take(e);
          onClose();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          take(e);
          setIndex(function (i) {
            return P.moveIndex(i, e.key === 'ArrowUp' ? 'up' : 'down', result.items.length);
          });
          return;
        }
        if (e.key === 'Enter') {
          var item = result.items[index];
          if (!item) return;
          take(e);
          choose(item);
        }
      }
      window.addEventListener('keydown', onKey, true);
      return function () { window.removeEventListener('keydown', onKey, true); };
    }, [open, blocked, result, index, onOpen, onClose]);

    if (!open) return null;

    var shown = result.items;
    var active = shown[index] || null;

    return ReactDOM.createPortal(
      <div className="cd-palette-scrim" onMouseDown={onClose}>
        <div
          className="cd-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Quick search"
          onMouseDown={function (e) { e.stopPropagation(); }}
        >
          <div className="cd-palette-field">
            <Ic n="search" s={16} c="var(--mute, rgba(10,10,10,0.55))" />
            <input
              ref={inputRef}
              className="cd-palette-input"
              value={query}
              aria-label="Search the desk"
              aria-controls="cd-palette-list"
              aria-activedescendant={active ? 'cd-palette-opt-' + index : undefined}
              placeholder="Clients, deals, files, or a screen"
              onChange={function (e) { setQuery(e.target.value); }}
              autoComplete="off"
              spellCheck="false"
            />
            {query
              ? <button type="button" className="cd-palette-clear" aria-label="Clear search" onClick={function () { setQuery(''); if (inputRef.current) inputRef.current.focus(); }}>
                  <Ic n="x" s={13} />
                </button>
              : <span className="cd-palette-kbd">{chord}</span>}
          </div>
          <div className="cd-palette-list" id="cd-palette-list" role="listbox" aria-label="Search results" ref={listRef}>
            {shown.length === 0 ? (
              <div className="cd-palette-empty">{debounced.trim() ? 'Nothing matches.' : 'Nothing recent yet.'}</div>
            ) : result.groups.map(function (group) {
              var start = 0;
              result.groups.some(function (g) {
                if (g === group) return true;
                start += g.items.length;
                return false;
              });
              return (
                <div key={group.id} className="cd-palette-group">
                  <div className="cd-palette-label">{group.label}</div>
                  {group.items.map(function (item, i) {
                    var at = start + i;
                    var on = at === index;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        id={'cd-palette-opt-' + at}
                        role="option"
                        aria-selected={on}
                        data-palette-kind={item.kind}
                        className={'cd-palette-row' + (on ? ' is-on' : '')}
                        onMouseEnter={function () { setIndex(at); }}
                        onClick={function () { choose(item); }}
                      >
                        <span className="cd-palette-ico"><Ic n={item.icon || 'search'} s={15} /></span>
                        <span className="cd-palette-copy">
                          <span className="cd-palette-title">{item.title}</span>
                          {item.subtitle ? <span className="cd-palette-sub">{item.subtitle}</span> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="cd-palette-foot">
            <span>Arrows to move</span>
            <span>Enter to open</span>
            <span>Esc to close</span>
            {busy ? <span className="cd-palette-busy">Looking</span> : null}
          </div>
        </div>
      </div>,
      document.body
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, { QuickSearch: QuickSearch });
})();
