/* The desk's one clock. Screens call this. They do not format a time
   or a civil day themselves.
   deskTime(value, '12h', zone) is "3:43 pm". '24h' is "15:43".
   deskDay is the civil date in that zone, not UTC and not the browser.
   A stored row keeps 24-hour HH:MM. deskRow turns an instant, or that
   stored reading, into the desk's format. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.deskTime = api.deskTime;
    cdos.deskDay = api.deskDay;
    cdos.deskStamp = api.deskStamp;
    cdos.deskClockText = api.deskClockText;
    cdos.deskRow = api.deskRow;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function asDate(value) {
    if (value instanceof Date) return value;
    return new Date(value);
  }
  function parts(date, timeZone, kinds) {
    var opts = { hourCycle: "h23" };
    for (var i = 0; i < kinds.length; i++) opts[kinds[i]] = kinds[i] === "year" ? "numeric" : "2-digit";
    if (timeZone) opts.timeZone = timeZone;
    return new Intl.DateTimeFormat("en-US", opts).formatToParts(date);
  }
  function pick(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i].value;
    return "";
  }
  function hourMinute(date, timeZone) {
    var list = parts(date, timeZone, ["hour", "minute"]);
    var h = +pick(list, "hour");
    var m = +pick(list, "minute");
    if (h === 24) h = 0;
    if (!isFinite(h) || !isFinite(m)) return null;
    return { h: h, m: m };
  }
  function deskTime(value, timeFormat, timeZone) {
    var date = asDate(value);
    var hm = null;
    try { hm = hourMinute(date, timeZone); } catch (e) { hm = null; }
    if (!hm) { try { hm = { h: date.getHours(), m: date.getMinutes() }; } catch (e2) { hm = null; } }
    if (!hm || !isFinite(hm.h) || !isFinite(hm.m)) hm = { h: date.getUTCHours(), m: date.getUTCMinutes() };
    var h = hm.h;
    var m = hm.m;
    if ((timeFormat || "12h") !== "24h") {
      var ap = h < 12 ? "am" : "pm";
      var hh = h % 12;
      if (hh === 0) hh = 12;
      return hh + ":" + String(m).padStart(2, "0") + " " + ap;
    }
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  function deskDay(value, timeZone) {
    var date = asDate(value);
    try {
      var list = parts(date, timeZone, ["year", "month", "day"]);
      var y = pick(list, "year");
      var mo = pick(list, "month");
      var d = pick(list, "day");
      if (/^\d{4}$/.test(y) && /^\d{2}$/.test(mo) && /^\d{2}$/.test(d)) return y + "-" + mo + "-" + d;
    } catch (e) { /* an unreadable zone falls through */ }
    try {
      return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    } catch (e2) {
      return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
    }
  }
  function deskStamp(value, timeFormat, timeZone) {
    return deskDay(value, timeZone) + " " + deskTime(value, timeFormat, timeZone);
  }
  function deskClockText(text, timeFormat) {
    var raw = String(text == null ? "" : text).trim();
    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i.exec(raw);
    if (!m) return raw;
    var h = +m[1];
    var min = +m[2];
    var ap = m[3] ? m[3].toLowerCase() : "";
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return raw;
    return deskTime(new Date(2000, 0, 1, h, min), timeFormat);
  }
  function deskRow(row, timeFormat, timeZone) {
    var at = row && row.at;
    if (typeof at === "number" && isFinite(at)) return { day: deskDay(at, timeZone), time: deskTime(at, timeFormat, timeZone) };
    if (at instanceof Date && !isNaN(at.getTime())) return { day: deskDay(at, timeZone), time: deskTime(at, timeFormat, timeZone) };
    return { day: row && row.date != null ? String(row.date) : "", time: deskClockText(row && row.time, timeFormat) };
  }
  return { deskTime: deskTime, deskDay: deskDay, deskStamp: deskStamp, deskClockText: deskClockText, deskRow: deskRow };
});
