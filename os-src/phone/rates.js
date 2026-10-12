/* Phone rate board. The screen in cdos-rates-phone.jsx calls these.
   Buy and sell match the desk editor: spot times (1 - spread, or the
   buy margin) and (1 + spread, or the sell margin). Names come from
   yorkfx-converter.js BY[code].name. Who may publish is the server
   role that holds rates:change in server/src/auth/permissions.ts.
   The post is still refused there. This file does not decide it. */
(function () {
  const CAN_CHANGE = { branch_manager: true, administrator: true };

  function canChangeRates(role) {
    return !!CAN_CHANGE[role];
  }

  function currencyName(code) {
    const book = (typeof BY !== "undefined" && BY) || {};
    const row = book[code];
    return row && row.name ? row.name : code;
  }

  function round(value, places) {
    const scale = Math.pow(10, places);
    return Math.round(value * scale) / scale;
  }

  function formatSpot(value) {
    if (typeof value !== "number" || !(value > 0) || !Number.isFinite(value)) return "";
    return value.toFixed(Math.abs(value) >= 0.0001 ? 4 : 6);
  }

  function formatPercent(fraction) {
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "";
    return (fraction * 100).toFixed(2) + "%";
  }

  function percentNumber(fraction) {
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "";
    return (fraction * 100).toFixed(2);
  }

  function buyPrice(mid, spread, buyMargin) {
    const margin = typeof spread === "number" ? spread : buyMargin;
    if (!(mid > 0) || typeof margin !== "number") return null;
    return mid * (1 - margin);
  }

  function sellPrice(mid, spread, sellMargin) {
    const margin = typeof spread === "number" ? spread : sellMargin;
    if (!(mid > 0) || typeof margin !== "number") return null;
    return mid * (1 + margin);
  }

  function nearly(left, right) {
    return Math.abs((left || 0) - (right || 0)) < 1e-8;
  }

  /* A hand-set spot stays within 2% of the feed, the same band the
     desk editor uses. No feed means no band, and the caller says so. */
  function clampSpot(value, feed) {
    if (!(value > 0) || !Number.isFinite(value)) {
      return { ok: false, value: null, clamped: false, hasFeed: !!(feed > 0) };
    }
    if (!(feed > 0)) return { ok: true, value: round(value, 6), clamped: false, hasFeed: false };
    const next = Math.min(feed * 1.02, Math.max(feed * 0.98, value));
    return { ok: true, value: round(next, 6), clamped: Math.abs(next - value) > 1e-9, hasFeed: true };
  }

  function stepMargin(fraction, direction) {
    const next = (fraction || 0) + direction * 0.0005;
    return Math.max(0, Math.min(0.2, round(next, 5)));
  }

  function codesOf(board) {
    const rows = (board && board.rows) || {};
    const order = [];
    const given = board && Array.isArray(board.order) ? board.order : [];
    given.forEach((code) => {
      if (code !== "CAD" && rows[code] && order.indexOf(code) < 0) order.push(code);
    });
    Object.keys(rows).forEach((code) => {
      if (code !== "CAD" && order.indexOf(code) < 0) order.push(code);
    });
    return order;
  }

  function copyBoard(board) {
    const order = codesOf(board);
    const rows = {};
    order.forEach((code) => {
      const row = board.rows[code] || {};
      rows[code] = {
        mid: typeof row.mid === "number" ? row.mid : 0,
        show: row.show !== false,
        spread: typeof row.spread === "number" ? row.spread : null,
        manual: !!row.manual,
      };
    });
    return {
      buyMargin: typeof board.buyMargin === "number" ? board.buyMargin : 0.015,
      sellMargin: typeof board.sellMargin === "number" ? board.sellMargin : 0.015,
      rows: rows,
      order: order,
      publishedAt: board.publishedAt || null,
      publishedBy: board.publishedBy || "",
    };
  }

  function factoryBoard() {
    const list = typeof CUR !== "undefined" && CUR ? CUR : [];
    const rows = {};
    const order = [];
    list.forEach((item) => {
      if (!item || item.code === "CAD") return;
      const per = item.perCadDefault > 0 ? item.perCadDefault : item.perCad;
      const mid = per > 0 ? round(1 / per, 6) : 0;
      if (!(mid > 0)) return;
      rows[item.code] = { mid: mid, show: true, spread: null, manual: false };
      order.push(item.code);
    });
    return { buyMargin: 0.015, sellMargin: 0.015, rows: rows, order: order, publishedAt: null, publishedBy: "" };
  }

  function shownCodes(rows, order) {
    return order.filter((code) => rows[code] && rows[code].show !== false);
  }

  function homeSix(rows, order) {
    return shownCodes(rows, order).slice(0, 6);
  }

  function sameSpread(left, right) {
    if (left == null && right == null) return true;
    if (left == null || right == null) return false;
    return nearly(left, right);
  }

  function changes(published, draft) {
    const lines = [];
    let count = 0;
    if (!published) {
      count = 1;
      lines.push({ label: "Rate board", detail: "First publish, " + draft.order.length + " currencies" });
    } else {
      draft.order.forEach((code) => {
        const was = published.rows[code];
        const now = draft.rows[code];
        if (!now) return;
        if (!was) {
          count += 1;
          lines.push({ label: code, detail: "Added to the board" });
          return;
        }
        if (!nearly(was.mid, now.mid)) {
          count += 1;
          const hand = now.manual ? ", set by hand" : "";
          lines.push({ label: code + " spot", detail: formatSpot(was.mid) + " to " + formatSpot(now.mid) + hand });
        }
        if (!sameSpread(was.spread, now.spread)) {
          count += 1;
          const from = was.spread == null ? "desk margin" : formatPercent(was.spread);
          const to = now.spread == null ? "desk margin" : formatPercent(now.spread);
          lines.push({ label: code + " spread", detail: from + " to " + to });
        }
        if ((was.show !== false) !== (now.show !== false)) {
          count += 1;
          lines.push({ label: code, detail: now.show === false ? "Hidden from the board" : "On the board" });
        }
      });
      published.order.forEach((code) => {
        if (!draft.rows[code]) {
          count += 1;
          lines.push({ label: code, detail: "Removed from the board" });
        }
      });
      if (published.order.join(",") !== draft.order.join(",")) {
        count += 1;
        lines.push({ label: "Homepage order", detail: homeSix(draft.rows, draft.order).join(", ") });
      }
    }
    const marginsSame = published && nearly(published.buyMargin, draft.buyMargin) && nearly(published.sellMargin, draft.sellMargin);
    if (!marginsSame) {
      if (published) count += 1;
      const detail = nearly(draft.buyMargin, draft.sellMargin)
        ? formatPercent(draft.buyMargin) + " each"
        : formatPercent(draft.buyMargin) + " buy, " + formatPercent(draft.sellMargin) + " sell";
      lines.push({ label: "Buy and sell margin", detail: detail });
    } else {
      lines.push({ label: "Buy and sell margin", detail: formatPercent(draft.buyMargin) + " each, no change", quiet: true });
    }
    return { count: count, lines: lines };
  }

  function previewNote(rows, order) {
    const on = shownCodes(rows, order);
    const rest = on.slice(6);
    const hidden = order.filter((code) => rows[code] && rows[code].show === false);
    const parts = [];
    if (rest.length === 1) parts.push("1 more on the rate board page (" + rest[0] + ").");
    else if (rest.length > 1) parts.push(rest.length + " more on the rate board page (" + rest.join(", ") + ").");
    if (hidden.length === 1) parts.push(hidden[0] + " is hidden.");
    else if (hidden.length > 1) parts.push(hidden.join(", ") + " are hidden.");
    return parts.join(" ");
  }

  function publishBody(draft) {
    const rows = {};
    draft.order.forEach((code) => {
      const row = draft.rows[code];
      if (!row || !(row.mid > 0)) return;
      const out = { mid: row.mid, show: row.show !== false };
      if (typeof row.spread === "number") out.spread = row.spread;
      rows[code] = out;
    });
    return {
      buyMargin: draft.buyMargin,
      sellMargin: draft.sellMargin,
      rows: rows,
      order: ["CAD"].concat(draft.order.filter((code) => code !== "CAD")),
    };
  }

  function clockLabel(value, zone) {
    const format = window.CDOS && window.CDOS.formatPhoneTime;
    if (typeof format !== "function" || value == null || value === "") return "";
    const when = typeof value === "number" ? new Date(value) : value;
    const label = format(when, zone || "");
    if (!label || label.indexOf("\u2014") >= 0 || label.indexOf("\u2013") >= 0) return "";
    return label;
  }

  function plainPublishError(status, body) {
    if (status === 403) return "The server refused (403). Only a manager or an admin can publish rates.";
    if (status === 401) return "Your session ended. Sign in again, then publish.";
    if (status === 400) {
      const detail = body && body.detail ? String(body.detail) : "";
      return detail ? "The server refused the board (400). " + detail : "The server refused the board (400).";
    }
    return "The server could not publish (" + status + "). Nothing was changed.";
  }

  window.CDOS = window.CDOS || {};
  window.CDOS.phoneRates = {
    canChangeRates: canChangeRates,
    currencyName: currencyName,
    formatSpot: formatSpot,
    formatPercent: formatPercent,
    percentNumber: percentNumber,
    buyPrice: buyPrice,
    sellPrice: sellPrice,
    clampSpot: clampSpot,
    stepMargin: stepMargin,
    copyBoard: copyBoard,
    factoryBoard: factoryBoard,
    homeSix: homeSix,
    changes: changes,
    previewNote: previewNote,
    publishBody: publishBody,
    clockLabel: clockLabel,
    plainPublishError: plainPublishError,
  };
})();
