/* Sign-up Google and Microsoft.
   The implementation lives in auth/oidc.ts. This file re-exports it so
   sign-up routes and tests keep the same module path and the same
   behaviour. Sign-in uses the separate functions in that module. */
export {
  PROVIDERS,
  SSO_TIMEOUT_MS,
  ProviderHttpError,
  fetchJson,
  clearJwksCache,
  providerConfig,
  ssoOrigin,
  startSso,
  verifyIdToken,
  sameEmail,
  finishSso,
} from "../auth/oidc.js";
export type { Provider, ProviderConfig, FetchJson, SsoResult } from "../auth/oidc.js";
