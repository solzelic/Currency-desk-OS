/* The displayed preference is the server's evidence, not a preselected box. */
(function () {
  "use strict";
  var CD = window.__cdOnb, api = CD.h.api, why = CD.h.why;
  CD.toggleCall = function (c) {
    var pref = CD.callPreference;
    if (CD._consentBusy || !pref || (!pref.call && !pref.canCall)) return;
    var id = CD.code;
    var choice = pref.call ? { call: false } : { call: true, version: pref.version, target: pref.target };
    CD._consentBusy = true; CD.consentError = ""; c.forceUpdate();
    api("POST", "/preferences", choice).then(function (r) {
      if (CD.code !== id) return;
      CD._consentBusy = false;
      if (r.status === 200 && r.body.preference) {
        CD.callPreference = r.body.preference; c.set("call", r.body.preference.call);
      } else {
        CD.consentError = why(r, "Your call preference wasn’t saved. Try again.");
        // Keep the last saved choice visible; a failed request is not consent.
        c.forceUpdate();
      }
    });
  };
  var priced = CD.priced;
  CD.priced = function (c, R) {
    R = priced(c, R);
    var p = CD.callPreference;
    R.onXCall = function () { c._tone("tap"); CD.toggleCall(c); };
    R.samBusy = !!CD._consentBusy || !p || (!p.call && !p.canCall);
    R.samText = p ? p.text + " Number: " + p.phone + "." : "Call consent is available after you verify your email.";
    R.samStatus = CD.consentError || (CD._consentBusy ? "Saving your call preference…" : p && p.call ? "Permission saved. Tap to switch it off." : "No call permission is saved.");
    return R;
  };
})();
