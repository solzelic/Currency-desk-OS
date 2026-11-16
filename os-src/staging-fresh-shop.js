/* Staging "Start a fresh shop" and "Start on Day 1" on the sign-in page.
   Absent unless the door is open.

   Start a fresh shop opens the website with a one-time staging ticket, and
   the whole journey runs from there: the homepage, the Early Access v2.1
   application, You're in, then the desk setup at /onboarding/CD-...

   Start on Day 1 opens the sign-up page at #day1, which asks the server
   for a new test shop and lands its owner on Day 1. The click leaves a bare
   timestamp in this tab (cdDayOne, no secret), so the sign-up page acts on
   #day1 only for a click made here moments ago, never for a link another
   site opened. Nothing else is written to storage or the log. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.freshShopButton = api.freshShopButton;
    cdos.freshShopMessage = api.freshShopMessage;
    cdos.freshShopEntry = api.freshShopEntry;
    cdos.startDayOne = api.startDayOne;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var START = /^\/\?door=[0-9a-f]{32}&email=[A-Za-z0-9%._+-]+$/;
  var DAY_ONE_MARK = "cdDayOne";
  var DAY_ONE_PAGE = "/onboarding#day1";

  /* `mark` is the button's data-fresh-shop value. */
  function freshShopButton(enabled) {
    return enabled === true ? [
      { key: "fresh-shop", mark: "1", label: "Start a fresh shop" },
      { key: "day-one", mark: "day1", label: "Start on Day 1", dayOne: true },
    ] : [];
  }

  /* The click's mark, then the sign-up page. Blocked storage still opens
     the page, which then mounts as usual. */
  function startDayOne(win) {
    try { win.sessionStorage.setItem(DAY_ONE_MARK, String(Date.now())); } catch (e) { /* no mark: the page ignores #day1 */ }
    win.location.assign(DAY_ONE_PAGE);
  }

  function freshShopMessage(status) {
    if (status === 429 || status === "slow") return "Slow down. Try again in a little while.";
    if (status === 0 || status === "network") return "The desk did not answer. Check your connection and try again.";
    return "Something went wrong. Try again.";
  }

  /* This site's homepage, with the ticket the server handed out.
     Anything else, a password or a code included, opens nothing. */
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
    startDayOne: startDayOne,
  };
});
