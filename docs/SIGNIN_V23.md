# Sign in v2.3 — bounded presentation contract

CD-221 is **In progress**, not feature-complete. This first candidate contains
real reusable React presentation in the existing shipped OS bundle, with its
default activation pending. It is not a parallel prototype or a new frontend.

## Implemented boundary

`CDOS.SignInV23` exports `FirstScreen`, `Password`, `Frame`, and identifier
formatting. `SignIn({ presentation: 'v23', ...existingProps })` composes the first
and password views with the current state machine and real server requests.
No current OS caller passes this prop. Tests intercept the **compiled** bundle
response immediately before OS startup to select it. No production test route,
query flag, local-storage flag, seeded account or fixture data was added.

The server still decides password validity, code requirements, lock timing,
password-change gating, session identity and tenancy. The adapter keeps the
existing request latch. A network error fails closed even on localhost, instead
of entering the existing offline demo path. A rejected password uses the original
v2.3 copy and clears its field. The legacy default presentation is unchanged.
The existing code/recovery/password-change screens continue after these two views.

Provider methods are composable callbacks. The adapter supplies none, so passkey,
Google and Microsoft controls are disabled, with explanatory accessible titles.
No callback pretends to authenticate. A shop name may only be supplied from an
authoritative future lookup; the adapter displays no local-directory shop/person
name before authentication. The existing legacy staff-ID resolution is retained
inside its password request handler, not promoted as the new CD-ID contract.
First Back goes to `/`; Create your desk goes to the existing `/signup` route.
Change/Back clears the password and its visibility. Recovery uses the existing
real reset lifecycle. No signup-owned file or migration was changed.

## Original source and intentional differences

Source: the supplied `signin-v2.3-pack`, BUILD-SIGN-IN v2.3 (15 Nov), original
SIGNUP-LOGIC and prototype. Original prototype SHA-256:
`9f59182e10a6e817d39314714921b05e15a08acb9349937a6c995929632164cf`.
The bundled original HTML also identifies itself internally as v2.3.

Cream `#F6F3EC`, ink `#17140F`, green `#1D6B45` and deep green `#17583A`,
Schibsted Grotesk, IBM Plex Mono and Instrument Serif come from the original.
All 23 original font binaries already match the repository's self-hosted fonts
byte for byte. The component links that existing font CSS only when mounted.
Classes have a `si23-` prefix because shared site `.hero` styles otherwise leak
into a scoped descendant. No shared styles are changed.

The comparison uses supplied JSON with a ±1px box threshold and exact font,
foreground, background and radius checks on matching elements. Named exceptions:

- Official CD-207 provider artwork replaces prototype letter/square stand-ins.
- `OS`/Recommended use the requested 10px minimum rather than 9.5px. The phone
  `OS` uses accessible light green. The tag grows about 4px; the mark grows 1px.
- The phone arrow is 44×44 rather than 40×40; Show is 44px rather than 34px.
  The phone input correspondingly has 4px less space.
- Placeholder contrast is raised from `#B5AFA4` to the original faint token
  `#736C62`. Focus rings, labels, status associations and alerts are explicit.
- The phone password header keeps its 22px inset; removing the hidden progress
  counter avoids the original 4px overflow. The disabled passkey link is a button.
- There is no unverified “York Currency Exchange” lede after typing an ID; its
  absence changes the original ID-state hero position. No synthetic account lookup.
- Screenshots settle finite animation and omit the prototype's perpetual halo.
  Reduced motion disables animation and the wire. The original wire/pulse PNG is
  mid-animation, so it is not a pixel-for-pixel comparison oracle.
- 360×740 first screen retains the original 6px vertical sheet overflow. Desktop
  1440×860, 1280×760 and 1100×700 do not scroll. Password sheets do not scroll at
  any requested size. Smaller keyboard/zoom viewports remain scrollable.

## Verification and reproduction

`tests/e2e/signin-v23.spec.ts` covers all four supplied viewports plus 1100×700:
blank, typed ID, typed email, password, rejected password; layout measurements,
axe, keyboard focus/Enter/Show/Change, reduced motion, unavailable methods,
503/429/network failure, the request latch and legacy code handoff, a real
password-only server session, and inactive production URL flags. No private data
is used. Fixture credentials exist only in tests; captures never show passwords.

Run after `npm ci`, `npm ci --prefix server`, and `npm run build`:

```sh
SEAM_DATABASE_URL=postgres://127.0.0.1:55431/FRESH_DISPOSABLE_DB \
  SIGNIN_CAPTURE_DIR=/absolute/evidence/directory \
  npx playwright test tests/e2e/signin-v23.spec.ts tests/e2e/signin-lock.spec.ts
```

Every full run needs a fresh disposable database. `SIGNIN_CAPTURE_DIR` is only a
Node test-process output directory, not a product flag. Reference JSON is committed
under `tests/fixtures/signin-v23`. Captures and comparison reports live with this
candidate's review evidence, not as production assets. Full server, PostgreSQL,
browser and governance results are recorded with the exact candidate handoff;
this document does not imply unrun suites or CI passed.

## Next slice, owned by the coordinator

Reconcile a stable CD-206 source/contract first. #721 and unpublished signup heads
are provisional, not acceptance dependencies. Returning credential assertion,
OIDC state/callback and account mapping, CD-ID lookup/error behavior, authoritative
shop selection and 30-day known-device trust must exist before default activation.
CD-206's 24h sliding enrolment is not known-device trust; expired enrolment lacks
a reauthentication/resume interface. Do not duplicate signup modules/migrations.

Code, shop/device approval, names/PIN, invited enrolment, recovery v2.3, step-up
and lock remain later slices. Q19 owner/money endpoints, Q20 initial no-email PIN
and Q21 idle timing remain in the existing Message Board discussion. No policy
values have been invented. Provider full visible labels need reconciliation with
CD-207 before activation; Back reuses CD-208 semantics without claiming it Done.
