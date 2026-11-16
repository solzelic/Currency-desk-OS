/* Draft counts are not an opening cash position or a converted valuation. */
(function () {
  "use strict";
  var CD = window.__cdOnb, priced = CD.priced;
  CD.priced = function (c, r) {
    var R = priced(c, r), d = c.state.data;
    R.countSummaryLabel = "Opening count";
    if (c.state.i === 8) { R.showDrawer = true; R.drawerStr = "Not posted"; }
    if (Array.isArray(R.reviewCards)) R.reviewCards = R.reviewCards.map(function (card) {
      if (card.t !== "Vault count") return card;
      var entered = Object.keys(d.count || {}).length || Object.values(d.float || {}).some(function (v) { return String(v || "").trim(); });
      /* Only the valued main line changes; the prototype's own "n of m counted" sub stays. */
      return Object.assign({}, card, { main: d.countLater || !entered ? "Count inside" : "Count saved by currency" });
    });
    return R;
  };
})();
