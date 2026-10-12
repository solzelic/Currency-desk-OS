/* Phone time, date, and money.
   The long-tail screens import this file. Exact outputs:
   "3:02 pm", "Jun 18, 2026", "1,765.05 CAD".
   A YYYY-MM-DD string is a calendar day. It is not parsed as a Date,
   so it cannot move to the previous day through UTC midnight.
   A Date, or a string with Z or a numeric offset, is an instant and
   is shown in the branch time zone (America/Toronto when omitted). */
(function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DEFAULT_ZONE = 'America/Toronto';

  /* Minor units. Mirrors EXCEPTIONS in server/src/ledger/currencies.ts.
     The browser cannot import that module. Change both together. */
  const ZERO_MINOR = {
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
    PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  };
  const THREE_MINOR = { BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3 };

  function minorUnits(code) {
    const c = String(code || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(ZERO_MINOR, c)) return 0;
    if (Object.prototype.hasOwnProperty.call(THREE_MINOR, c)) return 3;
    return 2;
  }

  /* Code after the number. Never Intl currency style — that prints "$".
     Absent (null, blank, not a number, bad code) is an empty string. */
  function formatPhoneMoney(amount, code) {
    if (amount == null || amount === '') return '';
    const raw = typeof amount === 'number' ? amount : Number(String(amount).replace(/,/g, '').trim());
    if (!Number.isFinite(raw)) return '';
    const ccy = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) return '';
    const digits = minorUnits(ccy);
    const body = new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true,
    }).format(Math.abs(raw));
    return (raw < 0 ? '\u2212' : '') + body + ' ' + ccy;
  }

  function zoneOf(timeZone) {
    const named = timeZone == null || timeZone === '' ? DEFAULT_ZONE : String(timeZone);
    try {
      Intl.DateTimeFormat('en-US', { timeZone: named }).format(0);
      return named;
    } catch (e) {
      return null;
    }
  }

  function isInstantText(text) {
    return /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  }

  function calendarParts(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year: year, month: month, day: day };
  }

  function wallClock(text) {
    const m = /(?:^|[ T])(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:\s*([ap]m)\b)?/i.exec(text);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const ap = m[3] ? m[3].toLowerCase() : '';
    if (ap && hour <= 12) {
      const pm = ap === 'pm';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return { hour: hour, minute: minute };
  }

  function clockLabel(hour, minute) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
    const suffix = hour >= 12 ? 'pm' : 'am';
    let h = hour % 12;
    if (h === 0) h = 12;
    return h + ':' + String(minute).padStart(2, '0') + ' ' + suffix;
  }

  function dateLabel(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    return MONTHS[month - 1] + ' ' + day + ', ' + year;
  }

  function instantParts(date, timeZone) {
    const zone = zoneOf(timeZone);
    if (!zone || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {
      return null;
    }
    const bag = {};
    const parts = fmt.formatToParts(date);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') bag[parts[i].type] = parts[i].value;
    }
    let hour = Number(bag.hour);
    if (hour === 24) hour = 0;
    return {
      year: Number(bag.year),
      month: Number(bag.month),
      day: Number(bag.day),
      hour: hour,
      minute: Number(bag.minute),
    };
  }

  function read(value, timeZone) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      const parts = instantParts(value, timeZone);
      return parts ? { kind: 'instant', parts: parts } : null;
    }
    const text = String(value).trim();
    if (!text) return null;
    if (isInstantText(text)) {
      const parsed = new Date(text);
      const parts = instantParts(parsed, timeZone);
      return parts ? { kind: 'instant', parts: parts } : null;
    }
    return {
      kind: 'wall',
      calendar: calendarParts(text),
      clock: wallClock(text),
    };
  }

  function formatPhoneTime(value, timeZone) {
    if (!zoneOf(timeZone)) return '';
    const readValue = read(value, timeZone);
    if (!readValue) return '';
    if (readValue.kind === 'instant') return clockLabel(readValue.parts.hour, readValue.parts.minute);
    if (!readValue.clock) return '';
    return clockLabel(readValue.clock.hour, readValue.clock.minute);
  }

  function formatPhoneDate(value, timeZone) {
    if (!zoneOf(timeZone)) return '';
    const readValue = read(value, timeZone);
    if (!readValue) return '';
    if (readValue.kind === 'instant') return dateLabel(readValue.parts.year, readValue.parts.month, readValue.parts.day);
    if (!readValue.calendar) return '';
    return dateLabel(readValue.calendar.year, readValue.calendar.month, readValue.calendar.day);
  }

  const api = {
    formatPhoneTime: formatPhoneTime,
    formatPhoneDate: formatPhoneDate,
    formatPhoneMoney: formatPhoneMoney,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof window !== 'undefined') {
    const Phone = window.CDOS && window.CDOS.Phone;
    if (Phone) {
      Phone.formatTime = formatPhoneTime;
      Phone.formatDate = formatPhoneDate;
      Phone.formatMoney = formatPhoneMoney;
    }
    window.CDOS = Object.assign(window.CDOS || {}, api);
  }
})();
