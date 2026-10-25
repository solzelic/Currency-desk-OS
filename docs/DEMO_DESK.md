# Product-demo desk

The sitting-down path for a product meeting: a teller signs into **the OS**,
not the platform admin panel, and the York FX book already looks like a
working shop.

## What Sol does

1. Open [`https://www.currencydeskos.com/login`](https://www.currencydeskos.com/login)
   (that is `/login` → `/app`, never `/admin`).
2. Staff id: `demo`.
3. Password: the value stored in Render / Keeper for
   `DEMO_STAFF_BOOTSTRAP`. It is not in this repository.

The tenant is York FX (`tnt-yorkfx`, site slug `yorkfx`). Login defaults to
that tenant when none is sent.

## One-shot password

`DEMO_STAFF_BOOTSTRAP="demo:password"` on the Render web service.

- Creates staff id `demo` on York FX if it is missing, and stamps the
  password.
- If `demo` already exists and already has a stamped password, boot **does
  not** overwrite it (same spirit as `PLATFORM_ADMIN_BOOTSTRAP` / issue #31).
- Other staff ids in that env var are refused — this is not a second
  `RESET_STAFF_PASSWORD`.
- After the first successful sign-in, **remove the env var** from Render.
  While it is set, the plaintext lives in the host environment.

The password itself belongs in Keeper (or the host dashboard), not in git,
PR bodies, or logs.

## Populated history

`DEMO_POPULATE=1` on the same service.

On boot the server posts a small, already-saved set **through the real
quote, ledger, and client-record services** — not by inserting fake
ledger rows. The set is:

- four identified customers (desk file + ledger counterparty)
- opening till balances if the drawer has never been initialised
- a vault opening position, stated once: CAD 40,000, USD 20,000,
  EUR 10,000, GBP 5,000. That is the safe, separate from the drawer.
  A desk that already has its history, and has never stated a vault
  position, still gets this count. A vault that already has a
  position is left where it is, so a later boot does not add the
  figures again and a float still comes out of the safe
- an open till session
- six posted CAD↔USD / CAD↔EUR exchanges a teller would see in history

Idempotency keys are stable (`demo-desk:tx:1` …). A second boot posts
nothing new. The seeder hard-codes the York FX scope and refuses to run
unless that tenant is present with `siteSlug=yorkfx`. It never accepts a
tenant id from the caller and never writes to another tenant.

Unset `DEMO_POPULATE` after the book is populated if you do not want the
check to run on every deploy. Leaving it set is safe: deals are not
posted twice, and a vault that already has a position is not counted
again. A vault that was never counted gets this opening.

## Staging quick sign-in

`STAGING=1` on the staging host. It is not in `render.yaml`. A person sets it on that host. This repository does not.

The login page calls `GET /api/staging/signin`. When that answers `{enabled:true}`, six buttons sign in as Owner, Manager, Supervisor, Compliance officer, Teller, or Auditor. No password, code, or PIN. The session lasts three days (`cdos_session` plus `cdos_staging=1`). A normal sign-in stays twelve hours and clears the marker.

The routes pass the request Host into `isStagingRuntime`. It has to agree with `RENDER_EXTERNAL_HOSTNAME`: `staging.currencydeskos.com`, `currencydesk-staging.onrender.com`, or `currencydesk-staging-pr-<digits>.onrender.com` while `IS_PULL_REQUEST=true`. `currencydeskos.com` and `www.currencydeskos.com` are refused. The shop has to be `tnt-yorkfx`. A shop id in the body is ignored.

The people are `j.masri`, `r.haddad`, `a.singh`, `c.adebayo`, `m.costa`, and `l.berg`. A boot with `STAGING` exactly `1` adds the compliance officer and the auditor when they are missing, including on a database that already has the other demo staff. An existing row is not overwritten.

A Staging banner stays on every screen for that session. A later password sign-in clears it.

`isStagingRuntime` in `server/src/auth/staging-runtime.ts` is the flag-plus-host check. A follow-up can reuse it to force sandbox mode for email, SMS, and identity checks. Those calls are not changed here. They live in `server/src/routes/onboarding-public.ts` (verify send), `server/src/onboarding/pipeline.ts` (invite and review mail), `server/src/routes/signup.ts` (signup mail), `server/src/email.ts`, `server/src/sms.ts`, and `server/src/idv/` (identity checks).

## What this is not

- Not platform admin (`admin@…` / `/admin`).
- Not Stripe, Twilio, or MFA.
- Not a reset for `j.masri` / `r.haddad` / the other seeded staff. Those
  passwords are first-create only (`SEED_PASSWORD`) and are lived-in on
  production. `c.adebayo` (compliance officer) and `l.berg` (auditor)
  are inserted only when `STAGING` is exactly `1`. A live boot does not
  create them. If `SEED_PASSWORD` is unset, their password is random and
  password sign-in is off. A later staging boot does not rewrite a password.
- Not a second book. The browser still only renders what the ledger
  posted.
