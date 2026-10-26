/* Staging "Start a fresh shop" on the sign-in page.
   Absent unless the door is open. The button opens the existing
   desk setup at /onboarding/CD-... Nothing here is written to
   storage, the address bar, or the log. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.freshShopButton = api.freshShopButton;
    cdos.freshShopMessage = api.freshShopMessage;
    cdos.freshShopEntry = api.freshShopEntry;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var REF = /^CD-[2-9A-HJ-NP-Z]{6,12}$/;

  function freshShopButton(enabled) {
    return enabled === true ? [{ label: "Start a fresh shop" }] : [];
  }

  function freshShopMessage(status) {
    if (status === 429 || status === "slow") return "Slow down. Try again in a little while.";
    if (status === 0 || status === "network") return "The desk did not answer. Check your connection and try again.";
    return "Something went wrong. Try again.";
  }

  /* The same address the invite link uses. A password or a code
     is not a reference, so those bodies do not open a page. */
  function freshShopEntry(body) {
    var ref = body && typeof body.reference === "string" ? body.reference.trim().toUpperCase() : "";
    if (!REF.test(ref)) return null;
    if (body.password || body.code) return null;
    return "/onboarding/" + ref;
  }

  return {
    freshShopButton: freshShopButton,
    freshShopMessage: freshShopMessage,
    freshShopEntry: freshShopEntry,
  };
});
