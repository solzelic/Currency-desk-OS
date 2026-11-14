/* The staging bar's X hides it for ten minutes, never longer. Anything that
   is not a moment in the past, or storage that refuses to answer, means the
   bar shows. The clock is passed in, so tests can set it. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, { stagingBanner: api });
})(typeof window !== "undefined" ? window : globalThis, function () {
  var KEY = "cdos.stagingBanner.hiddenAt";
  var HIDE_MS = 600000;
  function validTime(value) {
    return Number.isSafeInteger(value) && value > 0;
  }
  function isHidden(stored, now) {
    var at = typeof stored === "number" ? stored
      : typeof stored === "string" && /^[0-9]+$/.test(stored) ? Number(stored) : NaN;
    return validTime(at) && validTime(now) && at <= now && now - at < HIDE_MS;
  }
  function hiddenNow(storage, now) {
    try { return !!storage && isHidden(storage.getItem(KEY), now); }
    catch (e) { return false; }   // storage is off: show the bar
  }
  function hide(storage, now) {
    /* Storage is off: the bar still hides on this screen, and the next
       screen change cannot read the time back, so it shows again. */
    try { if (storage && validTime(now)) storage.setItem(KEY, String(now)); } catch (e) { return; }
  }
  return { KEY: KEY, HIDE_MS: HIDE_MS, isHidden: isHidden, hiddenNow: hiddenNow, hide: hide };
});
