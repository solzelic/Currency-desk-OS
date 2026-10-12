/* Phone time, date, and money.
   The long-tail screens import this file. Exact outputs:
   "3:02 PM", "Jun 18, 2026", "1,765.05 CAD".
   A list group for the business day is "Today, Oct 11".
   A YYYY-MM-DD string is a calendar day. It is not parsed as a Date,
   so it cannot move to the previous day through UTC midnight.
   A wall clock ("15:02") and a calendar day do not need a zone.
   A Date, or a string with Z or a numeric offset, is an instant.
   The caller passes the shop's zone. Omitting it does not assume
   Toronto. A clock or a date is accepted only when the whole string
   is that value: "junk 9:05 junk", "ref 12:34", "2026-10-11 junk"
   and "0000-01-01" are not times or dates. An impossible date, a
   bad clock, a bad zone, or any of those is the word Unknown, never
   a computed value. A malformed amount is an em dash. Blank stays
   blank. */
(function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DASH = '\u2014';
  const UNKNOWN = 'Unknown';

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

  /* '' means the caller did not pass a zone. null means they passed
     one and it is not a real zone. */
  function zoneOf(timeZone) {
    if (timeZone == null || timeZone === '') return '';
    const named = String(timeZone);
    try {
      Intl.DateTimeFormat('en-US', { timeZone: named }).format(0);
      return named;
    } catch (e) {
      return null;
    }
  }

  function isInstantText(text) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /* Year 0 is not a civil year we will print. The match is the whole
     string: a date with words after it is not that date. */
  function calendarFrom(yearText, monthText, dayText) {
    if (!/^\d{4}$/.test(yearText) || !/^\d{2}$/.test(monthText) || !/^\d{2}$/.test(dayText)) return null;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year: year, month: month, day: day };
  }

  function clockFrom(hourText, minuteText, ap) {
    if (!/^\d{1,2}$/.test(hourText) || !/^\d{2}$/.test(minuteText)) return null;
    let hour = Number(hourText);
    const minute = Number(minuteText);
    if (minute > 59) return null;
    const suffix = ap ? String(ap).toLowerCase() : '';
    if (suffix) {
      /* "13:02 AM" is not a clock. A suffix only belongs on 1–12. */
      if (hour < 1 || hour > 12) return null;
      const pm = suffix === 'pm';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    } else if (hour > 23) {
      return null;
    }
    return { hour: hour, minute: minute };
  }

  function clockLabel(hour, minute) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
    const suffix = hour >= 12 ? 'PM' : 'AM';
    let h = hour % 12;
    if (h === 0) h = 12;
    return h + ':' + String(minute).padStart(2, '0') + ' ' + suffix;
  }

  function dateLabel(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return '';
    return MONTHS[month - 1] + ' ' + day + ', ' + year;
  }

  function instantParts(date, timeZone) {
    if (!timeZone || !(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
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
    const year = Number(bag.year);
    const month = Number(bag.month);
    const day = Number(bag.day);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year: year, month: month, day: day, hour: hour, minute: Number(bag.minute) };
  }

  function read(value, timeZone) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      const parts = instantParts(value, timeZone);
      return parts ? { kind: 'instant', parts: parts } : { kind: 'bad' };
    }
    const text = String(value).trim();
    if (!text) return null;
    if (isInstantText(text)) {
      const parsed = new Date(text);
      const parts = instantParts(parsed, timeZone);
      return parts ? { kind: 'instant', parts: parts } : { kind: 'bad' };
    }
    const dateClock = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
    if (dateClock) {
      const calendar = calendarFrom(dateClock[1], dateClock[2], dateClock[3]);
      const clock = clockFrom(dateClock[4], dateClock[5], '');
      if (!calendar || !clock) return { kind: 'bad' };
      return { kind: 'wall', calendar: calendar, clock: clock };
    }
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dateOnly) {
      const calendar = calendarFrom(dateOnly[1], dateOnly[2], dateOnly[3]);
      return calendar ? { kind: 'wall', calendar: calendar, clock: null } : { kind: 'bad' };
    }
    const clockOnly = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:\s*([ap]m))?$/i.exec(text);
    if (clockOnly) {
      const clock = clockFrom(clockOnly[1], clockOnly[2], clockOnly[3] || '');
      return clock ? { kind: 'wall', calendar: null, clock: clock } : { kind: 'bad' };
    }
    return { kind: 'bad' };
  }

  /* A wait the keypad can say out loud. Under an hour is m:ss.
     An hour or more is h:mm:ss, so a day is 24:00:00 and not 1440:00.
     Zero and negative are not a wait. */
  function formatPhoneWait(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.floor(seconds);
    const pad = (n) => String(n).padStart(2, '0');
    if (total >= 3600) {
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return h + ':' + pad(m) + ':' + pad(s);
    }
    return Math.floor(total / 60) + ':' + pad(total % 60);
  }

  /* The lock sentence. A wait that is already over (0, negative, or an
     end in the past) says the keypad is back. A live wait names the
     till PIN, the remaining time, and the 12-hour clock when it ends. */
  function formatPhoneLock(secondsLeft, endsAt, timeZone) {
    const hasSeconds = typeof secondsLeft === 'number' && Number.isFinite(secondsLeft);
    let endMs = null;
    if (endsAt instanceof Date) endMs = endsAt.getTime();
    else if (typeof endsAt === 'number' && Number.isFinite(endsAt)) endMs = endsAt;
    else if (typeof endsAt === 'string' && endsAt) {
      const parsed = Date.parse(endsAt);
      if (Number.isFinite(parsed)) endMs = parsed;
    }
    const stillWaiting = hasSeconds && secondsLeft > 0;
    const over = (hasSeconds && secondsLeft <= 0) || (endMs != null && endMs <= Date.now() && !stillWaiting);
    if (over && (hasSeconds || endMs != null)) return 'The keypad is back.';
    const wait = stillWaiting ? formatPhoneWait(secondsLeft) : '';
    /* An instant with no shop zone is not a clock. The formatter
       says an em dash, or Unknown once a bad time is a word. Neither
       is read out, so the sentence names the wait and stops. */
    const spoken = endMs != null ? formatPhoneTime(new Date(endMs), timeZone) : '';
    const endLabel = spoken && spoken !== '\u2014' && spoken !== 'Unknown' ? spoken : '';
    const head = 'Too many wrong tries. The till PIN is locked too.';
    const back = endLabel ? ' The keypad comes back at ' + endLabel + '.' : '';
    if (wait) return head + ' Try again in ' + wait + '.' + back;
    if (endLabel) return head + back;
    return '';
  }

  function formatPhoneTime(value, timeZone) {
    const zone = zoneOf(timeZone);
    if (zone === null) return UNKNOWN;
    if (value == null || value === '') return '';
    const readValue = read(value, zone);
    if (!readValue || readValue.kind === 'bad') return UNKNOWN;
    if (readValue.kind === 'instant') {
      if (!zone) return UNKNOWN;
      return clockLabel(readValue.parts.hour, readValue.parts.minute) || UNKNOWN;
    }
    if (!readValue.clock) return UNKNOWN;
    return clockLabel(readValue.clock.hour, readValue.clock.minute) || UNKNOWN;
  }

  /* A list heading. Today is "Today, Oct 11". Any other calendar day
     is "Oct 11, 2026". `today` is the business date, YYYY-MM-DD.
     The day is read off the string, the same way formatPhoneDate is. */
  function formatPhoneListGroup(value, today) {
    if (value == null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!dateOnly) return UNKNOWN;
    const cal = calendarFrom(dateOnly[1], dateOnly[2], dateOnly[3]);
    if (!cal) return UNKNOWN;
    const monthDay = MONTHS[cal.month - 1] + ' ' + cal.day;
    const todayText = String(today || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(todayText) && text === todayText) return 'Today, ' + monthDay;
    return monthDay + ', ' + cal.year;
  }

  function formatPhoneDate(value, timeZone) {
    const zone = zoneOf(timeZone);
    if (zone === null) return UNKNOWN;
    if (value == null || value === '') return '';
    const readValue = read(value, zone);
    if (!readValue || readValue.kind === 'bad') return UNKNOWN;
    if (readValue.kind === 'instant') {
      if (!zone) return UNKNOWN;
      return dateLabel(readValue.parts.year, readValue.parts.month, readValue.parts.day) || UNKNOWN;
    }
    if (!readValue.calendar) return UNKNOWN;
    return dateLabel(readValue.calendar.year, readValue.calendar.month, readValue.calendar.day) || UNKNOWN;
  }

  function groupDigits(ints) {
    const digits = String(ints).replace(/^0+(?=\d)/, '') || '0';
    let out = '';
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
      out += digits.charAt(i);
    }
    return out;
  }

  /* Round the fraction half away from zero, entirely on the digit
     string, so a 16-digit amount does not pass through a float. */
  function roundParts(ints, frac, digits) {
    const whole = String(ints).replace(/\D/g, '') || '0';
    const extra = frac.slice(digits);
    let kept = frac.slice(0, digits);
    while (kept.length < digits) kept += '0';
    const bump = extra.length > 0 && extra.charAt(0) >= '5';
    if (!bump) return { ints: whole.replace(/^0+(?=\d)/, '') || '0', frac: kept };
    const chars = (whole + kept).split('');
    let carry = 1;
    for (let i = chars.length - 1; i >= 0 && carry; i--) {
      const n = (chars[i].charCodeAt(0) - 48) + carry;
      chars[i] = String(n % 10);
      carry = n >= 10 ? 1 : 0;
    }
    if (carry) chars.unshift('1');
    const all = chars.join('');
    if (!digits) return { ints: all.replace(/^0+(?=\d)/, '') || '0', frac: '' };
    return {
      ints: (all.slice(0, all.length - digits) || '0').replace(/^0+(?=\d)/, '') || '0',
      frac: all.slice(all.length - digits),
    };
  }

  function moneyParts(amount) {
    if (amount == null || amount === '') return { absent: true };
    if (typeof amount === 'number') {
      if (!Number.isFinite(amount)) return { invalid: true };
      if (Math.abs(amount) > Number.MAX_SAFE_INTEGER) return { invalid: true };
    }
    const text = String(amount).trim();
    if (!text) return { absent: true };
    if (/[xXeE]/.test(text)) return { invalid: true };
    const grouped = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
    const plain = /^-?\d+(\.\d+)?$/;
    if (!grouped.test(text) && !plain.test(text)) return { invalid: true };
    const neg = text.charAt(0) === '-';
    const body = (neg ? text.slice(1) : text).replace(/,/g, '');
    const cut = body.indexOf('.');
    const ints = cut < 0 ? body : body.slice(0, cut);
    const frac = cut < 0 ? '' : body.slice(cut + 1);
    return { neg: neg, ints: ints, frac: frac };
  }

  /* Code after the number. Never Intl currency style — that prints "$".
     Absent (null, blank) is an empty string. A malformed amount is an
     em dash, never a parsed guess. */
  function formatPhoneMoney(amount, code) {
    const parsed = moneyParts(amount);
    if (parsed.absent) return '';
    if (parsed.invalid) return DASH;
    const ccy = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) return '';
    const rounded = roundParts(parsed.ints, parsed.frac, minorUnits(ccy));
    const body = groupDigits(rounded.ints) + (rounded.frac ? '.' + rounded.frac : '');
    const zero = body === '0' || /^0\.0+$/.test(body);
    return (parsed.neg && !zero ? '\u2212' : '') + body + ' ' + ccy;
  }

  const api = {
    formatPhoneTime: formatPhoneTime,
    formatPhoneDate: formatPhoneDate,
    formatPhoneListGroup: formatPhoneListGroup,
    formatPhoneMoney: formatPhoneMoney,
    formatPhoneWait: formatPhoneWait,
    formatPhoneLock: formatPhoneLock,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof window !== 'undefined') {
    const Phone = window.CDOS && window.CDOS.Phone;
    if (Phone) {
      Phone.formatTime = formatPhoneTime;
      Phone.formatDate = formatPhoneDate;
      Phone.formatListGroup = formatPhoneListGroup;
      Phone.formatMoney = formatPhoneMoney;
    }
    window.CDOS = Object.assign(window.CDOS || {}, api);
  }
})();
