/* Till and end-of-day copy. The rules run once, here.
   A sentence starts with a capital and ends with a period.
   A fragment has no period. Screens read the result. */
(function () {
  function ruled(text, kinds) {
    var parts = String(text).split(". ");
    if (parts.length !== kinds.length) throw new Error("copy parts: " + text);
    for (var i = 0; i < parts.length; i++) {
      var piece = i < parts.length - 1 ? parts[i] + "." : parts[i];
      var sentence = kinds[i] === "sentence";
      if (sentence && (!/^[A-Z0-9]/.test(piece) || !/\.$/.test(piece))) throw new Error("sentence: " + piece);
      if (!sentence && /\.$/.test(piece)) throw new Error("fragment: " + piece);
    }
    return text;
  }
  var copy = {
    nobodyOnTill: ruled("Nobody is on this till. No session is open.", ["sentence", "sentence"]),
    showExpected: ruled("Show the expected amount.", ["sentence"]),
    hideExpected: ruled("Hide expected. Keep the count blind.", ["sentence", "sentence"]),
    countedOne: ruled("1 till counted", ["fragment"]),
    countedNone: ruled("0 tills counted", ["fragment"]),
    notInTill: ruled("Not in this till.", ["sentence"]),
    notCounted: ruled("Not counted.", ["sentence"]),
    noVariance: ruled("No variance.", ["sentence"]),
    notInSafe: ruled("Not in the safe.", ["sentence"]),
    unassigned: ruled("unassigned", ["fragment"]),
  };
  window.CDOS = Object.assign(window.CDOS || {}, { copy: copy });
})();
