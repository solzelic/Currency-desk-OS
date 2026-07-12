/* ============================================================
   Backend API client (server/ — Fastify).
   In dev, Vite proxies /api → http://127.0.0.1:8787; in production
   the server serves this app itself, so it's always same-origin and
   the session lives in an httpOnly cookie the JS never touches.
   ============================================================ */
import type { StaffRole } from "../domain/types";

export interface ApiUser {
  id: string;
  name: string;
  role: StaffRole;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  authorizedBranchIds: string[];
}

export type LoginResult =
  | { ok: true; user: ApiUser }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "unreachable" };

// Demo bridge: the seeded backend password. A real password field on the
// sign-in screen replaces this constant when credentials become real.
export const DEMO_PASSWORD = "yorkville";

export async function apiLogin(staffId: string, password: string = DEMO_PASSWORD): Promise<LoginResult> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ staffId, password }),
    });
    if (res.ok) {
      const body = (await res.json()) as { user: ApiUser };
      return { ok: true, user: body.user };
    }
    return { ok: false, reason: "invalid_credentials" };
  } catch {
    // no backend running (offline demo / CI) — caller decides the fallback
    return { ok: false, reason: "unreachable" };
  }
}

export async function apiLogout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    /* best-effort */
  }
}

export async function apiMe(): Promise<ApiUser | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as { user: ApiUser };
    return body.user;
  } catch {
    return null;
  }
}
