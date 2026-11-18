/* Client stubs for the new sign-in methods.
   While a flag is off the matching control is not drawn, and calling
   the stub still returns not_available without a network request.
   Passkey, Google, Microsoft, and the sign-in link are not wired in
   this change. Later tickets replace these functions. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.signInAdapter = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function flagsFromWindow(w) {
    var bag = w && w.CDOS && w.CDOS.signInFlags;
    if (!bag || typeof bag !== "object") return { passkey: false, google: false, microsoft: false };
    return {
      passkey: bag.passkey === true,
      google: bag.google === true,
      microsoft: bag.microsoft === true,
    };
  }

  function anyOn(flags) {
    return !!(flags && (flags.passkey || flags.google || flags.microsoft));
  }

  /* Every non-empty address opens the password step. This does not
     ask the server whether the address exists or which methods it has. */
  function openPasswordStep(email) {
    return String(email == null ? "" : email).trim().length > 0;
  }

  /* The last connected method cannot be removed. */
  function removalBlocked(methods, id) {
    var connected = (methods || []).filter(function (m) { return m && m.connected; });
    if (connected.length > 1) return false;
    return connected.some(function (m) { return m.id === id; });
  }

  function unavailable() {
    return Promise.resolve({ status: "not_available" });
  }

  function createSignInAdapter() {
    return {
      continueWithPasskey: function () { return unavailable(); },
      continueWithGoogle: function () { return unavailable(); },
      continueWithMicrosoft: function () { return unavailable(); },
      sendSignInLink: function () { return unavailable(); },
    };
  }

  return {
    flagsFromWindow: flagsFromWindow,
    anyOn: anyOn,
    openPasswordStep: openPasswordStep,
    removalBlocked: removalBlocked,
    createSignInAdapter: createSignInAdapter,
  };
});
