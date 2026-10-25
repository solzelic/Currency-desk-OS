/* Labels for the staging door on the sign-in screen.
   Disabled (anything other than true) renders nothing, so the
   login page shows no buttons when the config endpoint is off. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.stagingEnterButtons = api.stagingEnterButtons;
    cdos.renderStagingEnterButtons = api.renderStagingEnterButtons;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var BUTTONS = [
    { role: "administrator", label: "Enter as Owner" },
    { role: "branch_manager", label: "Enter as Manager" },
    { role: "supervisor", label: "Enter as Supervisor" },
    { role: "compliance_officer", label: "Enter as Compliance officer" },
    { role: "teller", label: "Enter as Teller" },
    { role: "auditor", label: "Enter as Auditor" },
  ];
  function stagingEnterButtons(enabled) {
    return enabled === true ? BUTTONS.slice() : [];
  }
  function renderStagingEnterButtons(enabled) {
    return stagingEnterButtons(enabled).map(function (b) {
      return '<button type="button" data-staging-role="' + b.role + '">' + b.label + '</button>';
    }).join("");
  }
  return { stagingEnterButtons: stagingEnterButtons, renderStagingEnterButtons: renderStagingEnterButtons };
});
