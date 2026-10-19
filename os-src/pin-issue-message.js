/* Sentences for Issue a new PIN. The screen never repeats the server's
   words. A code we know becomes one of these sentences. Anything else,
   including Bad Request and a database error, is the same fallback. */
function pinIssueFailure(status, body) {
  const code = body && typeof body.error === "string" ? body.error : "";
  if (code === "role_exceeds_yours") return "You can only issue a PIN for someone below your role.";
  if (code === "use_set_pin") return "Set your own PIN from My account.";
  if (code === "not_found" || status === 404) return "That person is not on this desk.";
  if (code === "unauthenticated" || status === 401) return "Sign in again, then issue the PIN.";
  if (code === "forbidden" || status === 403) return "Only the owner or a manager can issue a PIN.";
  return "The PIN was not issued. Try again.";
}
