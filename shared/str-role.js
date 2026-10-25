/* Who may see an STR, who may file, and who may see the structuring watch.
   The server reads this file. The desk can import the same file.
   STR and filing any report: administrator, branch_manager, compliance_officer.
   Watch, and reading an LCTR: those three, plus supervisor.
   A teller, an auditor, and any other role fail closed. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.canSeeStr = api.canSeeStr;
    cdos.canSeeStructuringWatch = api.canSeeStructuringWatch;
    cdos.canViewFiling = api.canViewFiling;
    cdos.canReleaseFiling = api.canReleaseFiling;
    cdos.presentDeal = api.presentDeal;
    cdos.STR_KEYS = api.STR_KEYS;
    cdos.WATCH_KEYS = api.WATCH_KEYS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var STR = { administrator: 1, branch_manager: 1, compliance_officer: 1 };
  var WATCH = { administrator: 1, branch_manager: 1, compliance_officer: 1, supervisor: 1 };
  var STR_KEYS = Object.freeze(["strTag", "strLink"]);
  var WATCH_KEYS = Object.freeze(["structuring", "structuringTotal", "ackStr", "ackStrInfo"]);

  function named(set, role) {
    return !!set[String(role || "").trim()];
  }
  function canSeeStr(role) {
    return named(STR, role);
  }
  function canSeeStructuringWatch(role) {
    return named(WATCH, role);
  }
  function canViewFiling(role, code) {
    var kind = String(code || "").trim().toUpperCase();
    if (kind === "LCTR") return canSeeStructuringWatch(role);
    return canSeeStr(role);
  }
  function canReleaseFiling(role, code) {
    if (!String(code || "").trim()) return false;
    return canSeeStr(role);
  }
  function presentDeal(role, deal) {
    if (!deal || typeof deal !== "object") return deal;
    if (!canSeeStr(role)) STR_KEYS.forEach(function (key) { delete deal[key]; });
    if (!canSeeStructuringWatch(role)) WATCH_KEYS.forEach(function (key) { delete deal[key]; });
    return deal;
  }
  return {
    canSeeStr: canSeeStr,
    canSeeStructuringWatch: canSeeStructuringWatch,
    canViewFiling: canViewFiling,
    canReleaseFiling: canReleaseFiling,
    presentDeal: presentDeal,
    STR_KEYS: STR_KEYS,
    WATCH_KEYS: WATCH_KEYS,
  };
});
