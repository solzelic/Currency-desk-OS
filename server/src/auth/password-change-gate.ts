/* A must-change-password session is not a desk session.

   The flag used to be read only by the sign-in screen. The cookie was
   already a full session, so GET /api/staff and every other protected
   route answered 200 (issue #419). The screen cannot be the control.
   This hook runs before the handler, on every /api request that carries
   a live session, and answers 403 password_change_required.

   Two kinds of route stay open, and both are exact.

   The change itself, and sign-out. Closing those is the dead end this
   codebase already knows: a gate that also blocks the only call that
   can lift the gate. The back control on the change screen does not
   sign out, so the sign-in doors stay open too. They do not authorize
   from this cookie. They replace it, or they ignore it.

   Public routes that never read the session stay open for the same
   reason. The browser sends the cookie on every same-origin call. A
   refusal there would not hide anything — the same call without the
   cookie still works — and it would break the page the person is
   standing on. A path that could be normalised into a protected route
   is not treated as public. */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { resolveSessionState, SESSION_COOKIE } from "./sessions.js";

const OPEN = new Set([
  "POST /api/auth/change-password",
  "POST /api/auth/logout",
  "POST /api/auth/login",
  "POST /api/auth/login/start",
  "POST /api/auth/login/verify",
  "POST /api/auth/forgot",
  "POST /api/auth/reset",
  "POST /api/admin/login",
  "POST /api/admin/login/enroll",
  "POST /api/admin/login/totp",
  "GET /api/health",
  "POST /api/signup",
  "POST /api/signup/resend",
  "POST /api/signup/verify",
  "POST /api/enquiries",
  "GET /api/site/early-access",
  "GET /api/site/rates",
  "GET /api/site/config",
  "GET /api/rates/market",
  "GET /api/staging/signin",
  "POST /api/staging/enter",
  "POST /api/staging/fresh-shop",
  "POST /api/staging/fresh-onboarding",
  "POST /api/billing/webhook",
]);

/* Published rates, the storefront, webhooks, and the invite flow.
   None of them authorize from the desk cookie. */
function publicPrefix(path: string): boolean {
  return path.startsWith("/api/public/")
    || path.startsWith("/api/sites/")
    || path.startsWith("/api/webhooks/")
    || path.startsWith("/api/onboarding/");
}

/* `..`, a double slash, or an encoded dot/slash can be folded into a
   protected path after this check. Those requests are not public. */
function requestPath(url: string): string | null {
  const stop = url.search(/[?#]/);
  const path = stop === -1 ? url : url.slice(0, stop);
  if (path.includes("\\") || path.includes("//")) return null;
  if (/%2e|%2f|%5c/i.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === "..")) return null;
  return path;
}

export function skipsPasswordChangeGate(method: string, url: string): boolean {
  const path = requestPath(url);
  if (path == null) return false;
  if (OPEN.has(`${method.toUpperCase()} ${path}`)) return true;
  return publicPrefix(path);
}

export const PASSWORD_CHANGE_REQUIRED = {
  error: "password_change_required",
  detail: "Change your password to keep going.",
} as const;

export function registerPasswordChangeGate(app: FastifyInstance, db: Db): void {
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url ?? "/";
    if (!url.startsWith("/api/")) return;
    if (skipsPasswordChangeGate(req.method, url)) return;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return;
    const state = await resolveSessionState(db, token);
    if (state.state !== "active" || !state.user.mustChangePassword) return;
    return reply.code(403).send(PASSWORD_CHANGE_REQUIRED);
  });
}
