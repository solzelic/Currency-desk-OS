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
- an open till session
- six posted CAD↔USD / CAD↔EUR exchanges a teller would see in history

Idempotency keys are stable (`demo-desk:tx:1` …). A second boot posts
nothing new. The seeder hard-codes the York FX scope and refuses to run
unless that tenant is present with `siteSlug=yorkfx`. It never accepts a
tenant id from the caller and never writes to another tenant.

Unset `DEMO_POPULATE` after the book is populated if you do not want the
check to run on every deploy. Leaving it set is safe: the second run is
a no-op.

## What this is not

- Not platform admin (`admin@…` / `/admin`).
- Not Stripe, Twilio, or MFA.
- Not a reset for `j.masri` / `r.haddad` / the other seeded staff. Those
  passwords are first-create only (`SEED_PASSWORD`) and are lived-in on
  production.
- Not a second book. The browser still only renders what the ledger
  posted.
