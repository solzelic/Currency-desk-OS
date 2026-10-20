/* Words for a currency exchange. A cross is a deal where neither side
   is the desk's home currency. Home pairs keep the one-sided sentence. */
function exchangeWords(row, home) {
  var inn = String((row && row.inCcy) || "");
  var out = String((row && row.outCcy) || "");
  var desk = String(home || "");
  var cross = !!(inn && out && desk && inn !== desk && out !== desk);
  if (cross) {
    return {
      cross: true,
      pricing: "We bought " + inn + ", sold " + out,
      row: "Bought " + inn + ", sold " + out,
    };
  }
  var buy = !!(row && row.side === "buy");
  var sell = !!(row && row.side === "sell");
  if (!buy && !sell) {
    if (out && out === desk) buy = true;
    else if (inn && inn === desk) sell = true;
  }
  return {
    cross: false,
    pricing: buy ? "We bought " + inn : sell ? "We sold " + out : "Cross",
    row: buy ? "Bought " + inn : sell ? "Sold " + out : "Exchange",
  };
}

function ledgerLine(row, home) {
  var words = exchangeWords(row, home);
  var tail = row && row.priced === "override" ? " · hand-priced" : row && row.priced === "locked" ? " · rate locked" : "";
  return (words.cross ? words.row : words.pricing) + tail;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { exchangeWords: exchangeWords, ledgerLine: ledgerLine };
}
if (typeof window !== "undefined") {
  window.CDOS = Object.assign(window.CDOS || {}, { exchangeWords: exchangeWords, ledgerLine: ledgerLine });
}
