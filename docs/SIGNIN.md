# Desk sign-in

Returning staff sign in with the password they already have. Google and
Microsoft are optional extras for a staff row that is already linked.
They do not create a staff row, a tenant, or a shop. Sign-up is a
different flow and keeps `SSO_REDIRECT_URI`.

Flags default off. With `SIGNIN_GOOGLE`, `SIGNIN_MICROSOFT`, and
`SIGNIN_PASSKEY` unset, `/login` is unchanged and the new routes answer
503.

## Redirect URIs

Each value is an exact `https` origin plus one path. No user, password,
query, or fragment. If a value is missing or does not match, that way
in is not offered.

| Env | Staging value | Path |
| --- | --- | --- |
| `SSO_REDIRECT_URI` | `https://currencydesk-staging.onrender.com/onboarding/sso` | Sign-up only |
| `SSO_SIGNIN_REDIRECT_URI` | `https://currencydesk-staging.onrender.com/auth/sso/callback` | Google and Microsoft sign-in. The provider is stored with the state. |
| `SSO_LINK_REDIRECT_URI` | `https://currencydesk-staging.onrender.com/auth/sso/link/callback` | Linking from a signed-in session |

Live uses the same variable names and its own origin. Sol sets them in
Render. This repository does not contain the secrets.

## Other env names

These already exist. There is no tenant id in the environment.

| Env | Use |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google web client |
| `GOOGLE_CLIENT_SECRET` | Google web client |
| `MICROSOFT_CLIENT_ID` | Microsoft app registration, `common` accounts |
| `MICROSOFT_CLIENT_SECRET` | Microsoft app registration |
| `SIGNIN_GOOGLE` | `1`, `true`, `yes`, or `on`. Anything else is off. |
| `SIGNIN_MICROSOFT` | Same parser. Off until Sol turns it on for a test. |
| `SIGNIN_PASSKEY` | Off. Passkey sign-in is not wired. |
| `WEBAUTHN_RP_ID` | Passkey relying party. Not used for Google or Microsoft. |
| `WEBAUTHN_ORIGINS` | Comma-separated https origins for that relying party. |
| `PLATFORM_MFA_KEY` | Encrypts owner authenticator secrets. Already required in production for platform operators. |

Sol confirmed on 26 November that staging passkeys will use
`WEBAUTHN_RP_ID=currencydesk-staging.onrender.com` and
`WEBAUTHN_ORIGINS=https://currencydesk-staging.onrender.com`. This chooses the
staging binding only; it does not enable the unfinished passkey sign-in flow or
choose a live relying party. Staging credentials will be separate from live.

A shop may set `tenants.ms_tenant_allowlist` to a list of Microsoft
tenant ids. Null, the default, leaves that check off.

## What sign-in will not do

- Match a person by email. Google matches `iss` + `sub`. Microsoft matches `tid` + `oid`.
- Treat an identity-provider sign-in as a second factor. An owner also needs an authenticator or a passkey, plus a recovery code, and must enter that second step.
- Store an identity-provider access token or refresh token.
- Run with live keys on the demo shop `tnt-yorkfx`.

## Connecting a method from Settings

With a sign-in flag enabled, Settings → Sign-in methods asks for fresh
confirmation before Connect or Remove. It calls `/api/auth/stepup` with the
password and, when required, an authenticator code. An already-enrolled passkey
can instead use the existing `/stepup/passkey/options` and `/verify` endpoints.
That browser path requires `PublicKeyCredential.parseRequestOptionsFromJSON`
and `toJSON`; older browsers keep the password/authenticator path.

Owners first set up an authenticator through `/api/auth/mfa/enroll/start` and
`/confirm`. The UI shows the setup key and recovery codes in memory only and
requires acknowledgment that the codes were saved. It never stores them in
browser storage or the desk state. Existing owners can replace their recovery
codes through `/api/auth/mfa/recovery` after reconfirming; this immediately
invalidates the older codes. The server retains all role, session, tenant,
factor, lockout and last-method checks.

The new setup controls disable duplicate actions, abort on unmount and use a
30-second budget. No operation is automatically retried. A lost enrollment
confirmation may have committed, so the screen asks the person to reload and
check before starting again. This does not implement passkey registration or
returning passkey login, and does not enable a provider or change hosted config.

`signin-method-setup.spec.ts` checks UI failure/cancellation and routing with
explicit API responses (including a simulated authenticator). The separate
`signin-method-setup-server.spec.ts` drives the built Settings component against
a real HTTP server and disposable PGlite, enrolls a real TOTP secret, and checks
that the server then requires the factor. It owns an ephemeral loopback port;
its flags do not change the ordinary flags-off test server. Neither spec proves
real Google/Microsoft authorization or physical-device passkey behavior.
