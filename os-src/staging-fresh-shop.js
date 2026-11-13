/* Staging "Start a fresh shop" on the sign-in page.
   Absent unless the door is open. The button opens the Early Access
   v2.1 page with a one-time staging ticket, and the whole journey
   runs from there: apply, You're in, then the desk setup at
   /onboarding/CD-... Nothing here is written to storage or the log. */
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
  var START = /^\/early-access\?door=[0-9a-f]{32}&email=[A-Za-z0-9%._+-]+$/;

  function freshShopButton(enabled) {
    return enabled === true ? [{ label: "Start a fresh shop" }] : [];
  }

  function freshShopMessage(status) {
    if (status === 429 || status === "slow") return "Slow down. Try again in a little while.";
    if (status === 0 || status === "network") return "The desk did not answer. Check your connection and try again.";
    return "Something went wrong. Try again.";
  }

  /* The Early Access page on this site, with the ticket the server
     handed out. Anything else, a password or a code included, opens
     nothing. */
  function freshShopEntry(body) {
    var start = body && typeof body.start === "string" ? body.start.trim() : "";
    if (!START.test(start)) return null;
    if (body.password || body.code) return null;
    return start;
  }

  return {
    freshShopButton: freshShopButton,
    freshShopMessage: freshShopMessage,
    freshShopEntry: freshShopEntry,
  };
});
