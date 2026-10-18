/* One cheque fee, in integer cents, half up.
   The screen and the server both call this. A float multiply is wrong
   here: 1000.25 * 2 / 100 is not 20.005 in binary, and toFixed says 20.00.
   Returns a two-place decimal string, or null when a figure is not a fee. */
function chequeScheduleFee(face, feePct, feeMin) {
  var faceCents = moneyCents(face);
  var minCents = moneyCents(feeMin == null || feeMin === "" ? 0 : feeMin);
  var pct = percentParts(feePct == null || feePct === "" ? 0 : feePct);
  if (faceCents == null || minCents == null || pct == null) return null;
  if (faceCents < 0 || minCents < 0 || pct.num < 0) return null;
  var percentCents = divHalfUp(faceCents * pct.num, pct.scale * 100);
  if (percentCents == null) return null;
  var due = percentCents > minCents ? percentCents : minCents;
  return centsText(due);
}

function moneyCents(value) {
  var match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  var cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function percentParts(value) {
  var match = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(String(value).trim());
  if (!match) return null;
  var frac = match[2] || "";
  var scale = 10 ** frac.length;
  var num = Number(match[1]) * scale + (frac === "" ? 0 : Number(frac));
  return Number.isSafeInteger(num) ? { num: num, scale: scale } : null;
}

function divHalfUp(numer, denom) {
  if (!Number.isSafeInteger(numer) || !Number.isSafeInteger(denom) || denom <= 0) return null;
  var q = Math.floor(numer / denom);
  var r = numer % denom;
  if (r * 2 >= denom) q += 1;
  return q;
}

function centsText(cents) {
  return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
}
