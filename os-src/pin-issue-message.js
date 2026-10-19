/* Sentences for Issue a new PIN. The screen and the server both read
   these words from here. The screen never repeats anything else the
   server sends. */
var PIN_ISSUE_COPY = {
  role_exceeds_yours: "You can only issue a PIN for someone below your role.",
  use_set_pin: "Set your own PIN from My account.",
  not_found: "That person is not on this desk.",
  unauthenticated: "Sign in again, then issue the PIN.",
  forbidden: "Only the owner or a manager can issue a PIN.",
  fallback: "The PIN was not issued. Try again.",
};
var PIN_ISSUE_OFFLINE = "No connection. The PIN was not issued.";

function pinIssueRank(role) {
  if (role === "Owner" || role === "administrator") return 4;
  if (role === "Manager" || role === "branch_manager" || role === "compliance_officer") return 3;
  if (role === "Senior teller" || role === "supervisor") return 2;
  if (role === "Cashier" || role === "Trainee" || role === "teller" || role === "auditor") return 1;
  return 0;
}

/* True when this person outranks the one who is signed in. */
function pinIssueAbove(actorRole, targetRole) {
  return pinIssueRank(targetRole) > pinIssueRank(actorRole);
}

function pinIssueFailure(status, body) {
  var code = body && typeof body.error === "string" ? body.error : "";
  if (code === "role_exceeds_yours") return PIN_ISSUE_COPY.role_exceeds_yours;
  if (code === "use_set_pin") return PIN_ISSUE_COPY.use_set_pin;
  if (code === "not_found" || status === 404) return PIN_ISSUE_COPY.not_found;
  if (code === "unauthenticated" || status === 401) return PIN_ISSUE_COPY.unauthenticated;
  if (code === "forbidden" || status === 403) return PIN_ISSUE_COPY.forbidden;
  return PIN_ISSUE_COPY.fallback;
}

/* What the Employees button runs. A thrown request is no connection.
   Any other failure is one of the sentences above. */
async function issueStaffPin(loginId, fetchImpl) {
  var go = fetchImpl || fetch;
  try {
    var res = await go("/api/staff/" + encodeURIComponent(loginId) + "/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    var body = null;
    if (res && typeof res.json === "function") {
      try { body = await res.json(); } catch (parseErr) { body = null; }
    }
    var status = res && typeof res.status === "number" ? res.status : 0;
    if (!res || res.ok === false || !body || typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
      return { ok: false, err: pinIssueFailure(status, body) };
    }
    return { ok: true, pin: body.pin };
  } catch (err) {
    return { ok: false, err: PIN_ISSUE_OFFLINE };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PIN_ISSUE_COPY: PIN_ISSUE_COPY,
    PIN_ISSUE_OFFLINE: PIN_ISSUE_OFFLINE,
    pinIssueFailure: pinIssueFailure,
    pinIssueAbove: pinIssueAbove,
    issueStaffPin: issueStaffPin,
  };
}
