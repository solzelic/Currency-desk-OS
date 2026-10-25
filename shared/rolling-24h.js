/* ============================================================
   The 24 consecutive hours before a deal.

   The server requires this file. The desk shell loads the same
   file as a plain script. A large cash total uses this lookback
   on both sides. It does not reset at midnight.

   A stored civil date and HH:MM are the branch's wall clock.
   wallInstant reads them in that zone. rollingWindow then steps
   back by elapsed milliseconds, so a daylight-saving night is
   still 24 hours and not 23 or 25.

   The start is inclusive and the end is exclusive. A receipt
   one millisecond older than the start does not.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.wallInstant = api.wallInstant;
    cdos.rollingWindow = api.rollingWindow;
    cdos.inRollingWindow = api.inRollingWindow;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var HOUR = 60 * 60 * 1000;

  function zoneOffsetMs(at, timeZone) {
    var whole = new Date(Math.floor(at.getTime() / 1000) * 1000);
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(whole);
    function pick(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return Number(parts[i].value);
      }
      return 0;
    }
    var hour = pick("hour");
    if (hour === 24) hour = 0;
    var asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), hour, pick("minute"), pick("second"));
    return asUtc - whole.getTime();
  }

  function wallFields(at, timeZone) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    function pick(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) return Number(parts[i].value);
      }
      return 0;
    }
    var hour = pick("hour");
    if (hour === 24) hour = 0;
    return {
      y: pick("year"),
      mo: pick("month"),
      d: pick("day"),
      h: hour,
      mi: pick("minute"),
      s: pick("second"),
    };
  }

  function sameWall(at, y, mo, d, h, mi, s, timeZone) {
    var got = wallFields(at, timeZone);
    return got.y === y && got.mo === mo && got.d === d && got.h === h && got.mi === mi && got.s === s;
  }

  /* Civil date YYYY-MM-DD and HH:MM[:SS[.mmm]] in timeZone.
     A spring-forward gap has no instant, so this returns null. */
  function wallInstant(date, time, timeZone) {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date == null ? "" : date).trim());
    var tm = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(String(time == null ? "" : time).trim());
    if (!dm || !tm) return null;
    var y = +dm[1];
    var mo = +dm[2];
    var d = +dm[3];
    var h = +tm[1];
    var mi = +tm[2];
    var s = +(tm[3] || 0);
    var frac = tm[4] || "";
    var ms = frac ? +frac.padEnd(3, "0").slice(0, 3) : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    var zone = String(timeZone || "").trim() || "America/Toronto";
    var guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    var offset;
    try {
      offset = zoneOffsetMs(new Date(guess), zone);
    } catch (e) {
      return null;
    }
    var instant = guess - offset;
    var corrected;
    try {
      corrected = zoneOffsetMs(new Date(instant), zone);
    } catch (e2) {
      return null;
    }
    if (corrected !== offset) instant = guess - corrected;
    var at = new Date(instant);
    if (sameWall(at, y, mo, d, h, mi, s, zone)) return at;
    var earlier = new Date(instant - HOUR);
    if (sameWall(earlier, y, mo, d, h, mi, s, zone)) return earlier;
    var later = new Date(instant + HOUR);
    if (sameWall(later, y, mo, d, h, mi, s, zone)) return later;
    return null;
  }

  function asDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    var parsed = new Date(value);
    return parsed;
  }

  /* [at - hours, at). Start inclusive, end exclusive. hours defaults to 24. */
  function rollingWindow(at, hours) {
    var end = asDate(at);
    if (isNaN(end.getTime())) return null;
    var h = Number(hours);
    if (!isFinite(h) || h <= 0) h = 24;
    return { start: new Date(end.getTime() - h * HOUR), end: end };
  }

  function inRollingWindow(earlier, later, hours) {
    var window = rollingWindow(later, hours);
    var left = asDate(earlier);
    if (!window || isNaN(left.getTime())) return false;
    var t = left.getTime();
    return t >= window.start.getTime() && t <= window.end.getTime();
  }

  return {
    wallInstant: wallInstant,
    rollingWindow: rollingWindow,
    inRollingWindow: inRollingWindow,
  };
});
