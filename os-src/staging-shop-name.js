/* On staging the seed shop shows as Test FX, so nobody takes it for a real
   shop (Sol, 3 Nov 2026). Live keeps York FX. Only when the server says
   staging (the flag the staging bar reads) and the shop is the seed shop.
   A name that does not say York was typed by a tester and is kept. Nothing
   changed returns the same object, so a second run is a no-op. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CDOS = Object.assign(root.CDOS || {}, { stagingShopName: api });
})(typeof window !== "undefined" ? window : globalThis, function () {
  var SEED_TENANT = "tnt-yorkfx";
  var NAMES = { bizName: "Test FX Inc.", operatingName: "Test FX", receiptHeader: "Test FX" };
  var TEXTS_KEY = "cdos_tg_settings_v1";
  var TEXTS = { desk: "TEST FX", from: "TESTFX" };
  var YORK = /york/i;

  function applies(tenantId, staging) { return staging === true && tenantId === SEED_TENANT; }

  /* The keys whose value says York (or, for the texts, is not set yet). */
  function stale(record, names, missingCounts) {
    return Object.keys(names).filter(function (k) {
      var v = record[k];
      return typeof v === "string" ? YORK.test(v) : missingCounts && v === undefined;
    });
  }

  function renameSettings(settings, tenantId, staging) {
    if (!settings || !applies(tenantId, staging)) return settings;
    var keys = stale(settings, NAMES, false);
    if (!keys.length) return settings;
    var next = Object.assign({}, settings);
    keys.forEach(function (k) { next[k] = NAMES[k]; });
    return next;
  }

  /* The Texts app keeps its own sender name. True when it was written. */
  function renameTexts(storage, tenantId, staging) {
    if (!storage || !applies(tenantId, staging)) return false;
    try {
      var raw = storage.getItem(TEXTS_KEY);
      var saved = raw === null ? {} : JSON.parse(raw);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
      var keys = stale(saved, TEXTS, true);
      if (!keys.length) return false;
      keys.forEach(function (k) { saved[k] = TEXTS[k]; });
      storage.setItem(TEXTS_KEY, JSON.stringify(saved));
      return true;
    } catch (e) {
      return false;   // storage is off or the saved value is not JSON: leave it
    }
  }

  return { SEED_TENANT: SEED_TENANT, applies: applies, renameSettings: renameSettings, renameTexts: renameTexts };
});
