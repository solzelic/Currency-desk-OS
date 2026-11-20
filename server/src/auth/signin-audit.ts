/* Action names for desk sign-in, linking, passkeys, and recovery.
   Detail may carry method, issuer, staff, shop, device, result, and IP.
   It must never carry a token, a code, an id_token, an assertion, or an email. */

export const SIGN_IN_AUDIT = {
  login: "auth.login",
  loginFailed: "auth.login_failed",
  loginLocked: "auth.login_locked",
  linked: "auth.identity_linked",
  unlinked: "auth.identity_unlinked",
  passkeyAdded: "auth.passkey_added",
  passkeyRemoved: "auth.passkey_removed",
  recoveryIssued: "auth.recovery_codes_issued",
  recoveryUsed: "auth.recovery_code_used",
  stepUp: "auth.step_up",
  stepUpFailed: "auth.step_up_failed",
} as const;

export type SignInAuditAction = (typeof SIGN_IN_AUDIT)[keyof typeof SIGN_IN_AUDIT];

const SECRET_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "assertion",
  "email",
  "password",
  "secret",
  "verifier",
]);

/** Drops keys that must not be written on an audit row. */
export function signInAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
