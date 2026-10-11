/* Desk errors, four fields, and nothing a form held.
   window.onerror and unhandledrejection both post here. The server
   drops a report that is too big or carries any other field. Sentry
   sees it only when SENTRY_DSN is set. A failed post is not a second
   error: there is nowhere else to send it that is not the same network. */
(function () {
  var VERSION = "0.1.0";

  function route() {
    try { return String(location.pathname || "").slice(0, 200); }
    catch (err) { console.warn("client-error route unavailable"); return ""; }
  }

  function send(message, stack) {
    var body;
    try {
      body = JSON.stringify({
        message: String(message == null ? "error" : message).slice(0, 500),
        stack: stack ? String(stack).slice(0, 2000) : undefined,
        version: VERSION,
        route: route(),
      });
    } catch (err) {
      console.warn("client-error report was not built");
      return;
    }
    try {
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {
        console.warn("client-error report was not delivered");
      });
    } catch (err) {
      console.warn("client-error report was not delivered");
    }
  }

  window.onerror = function (message, source, line, col, error) {
    send(message, error && error.stack);
    return false;
  };

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    send(message, reason && reason.stack);
  });
})();
