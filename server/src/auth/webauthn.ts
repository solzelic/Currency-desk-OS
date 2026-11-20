/* Relying party binding for desk passkeys.
   Sign-up registration imports this and re-exports it. The checks are
   the same ones sign-up already used: ES256 and RS256 stay with the
   caller, UV required stays with the caller, and a missing or invalid
   RP ID fails closed. */
import type { Db } from "../db/index.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type RelyingParty = { id: string; name: string; origins: string[] };

/* Browsers refuse an RP ID that is a public suffix (the Public Suffix List
   is theirs, not ours). These are the shared hosts this deployment can sit
   under; a desk on Render needs its own name, e.g.
   currencydesk-staging.onrender.com, never onrender.com. */
const SHARED_SUFFIXES = new Set(["onrender.com"]);

/** RP binding is permanent. Missing or invalid deployment config fails closed. */
export function relyingParty(env: NodeJS.ProcessEnv = process.env): RelyingParty | null {
  const id = env.WEBAUTHN_RP_ID?.trim().toLowerCase();
  const origins = (env.WEBAUTHN_ORIGINS ?? "").split(",").map(o => o.trim()).filter(Boolean);
  if (!id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || !origins.length) return null;
  if (SHARED_SUFFIXES.has(id) || (id !== "localhost" && !id.includes("."))) return null;
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { return null; }
    if (url.origin !== origin || url.username || url.password
      || !(url.hostname === id || url.hostname.endsWith(`.${id}`))
      || !(url.protocol === "https:" || (id === "localhost" && url.protocol === "http:" && env.NODE_ENV !== "production"))) return null;
  }
  return { id, name: "CurrencyDesk", origins };
}

/** Kept so later assertion checks can share the five-minute window. */
export function challengeExpiry(now = Date.now()): Date {
  return new Date(now + CHALLENGE_TTL_MS);
}

export type WebAuthnDb = Db;
