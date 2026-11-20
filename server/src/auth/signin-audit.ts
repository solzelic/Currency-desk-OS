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

/* Names, not a fixed list of spellings. "emailed" stays. "email",
   "backupCode", and "accessToken" do not. */
const SECRET_KEY = /token|password|secret|assertion|verifier|cookie|authorization|bearer|email(?!ed)|code$/i;

function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEY.test(key) || value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = scrubDetail(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Drops keys that must not be written on an audit row. */
export function signInAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return scrubDetail(detail);
}
