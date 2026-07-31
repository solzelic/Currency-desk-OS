# The next push

Written after walking every flow in a browser against the built app on
2026-07-31 — the public site, all eight panel pages, the early-access form,
the setup flow, a desk being created, and a returning owner signing back in
from a cold browser.

Everything below was **seen**, not inferred. Where something is a guess it
says so.

---

## What already works, so nobody re-checks it

- Applying → the application lands in review → the acknowledgement goes out
  on its own.
- Approving in one press → the invitation with the reference and setup link.
- Setup → confirmation code → the desk is built → they land inside it,
  signed in, with their own shop's name on it and no trading on the ledger.
- **A returning owner can sign in from a cold browser**: email, password,
  emailed six-digit code — typed on a keyboard, not just the on-screen
  keypad — station picker, desk. Walked end to end.
- The Inbox, the compose page, the sample sender, the Emails page.
- The public site renders. No broken images and no empty image slots — the
  large blank bands are the design's own whitespace, checked rather than
  assumed.

---

## P0 · Somebody is locked out and rings you

### 1. Forgot password, self-serve

**The gap, exactly.** There is no recovery route of any kind. `routes/auth.ts`
has `login`, `login/start`, `login/verify`, `change-password` (needs an
existing session), `logout`, `me`. That is all.

What a locked-out owner is told today, in their own words on the screen:

> Forgot it? **The owner can reset it.**

They *are* the owner. And on the ID screen:

> No ID? **Ask the owner of your desk.**

There is nobody above them. The only working path is: ring CurrencyDesk,
somebody opens the panel, presses **Reset their password**, and reads a
temporary one down the phone. That is fine for forty desks and impossible
for four hundred — and it is a support call at 8am on a Saturday when the
shop is opening.

**Build:** request a reset by address → one-time token, short-lived, single
use, hashed at rest → emailed link or code → set a new password → every
existing session revoked. The pieces already exist: `onboarding/verify.ts`
is exactly this shape for setup codes, and `staff/reset-password` already
knows how to revoke sessions and force a change.

Careful about two things. Asking for a reset must give the **same answer**
whether or not the address exists, or the form becomes a way to find out who
banks with us. And a reset must kill live sessions — a password change that
leaves the thief signed in is theatre.

### 2. The sign-in screen is talking about somebody else's desk

On a cold browser at `/app` the ID screen offers:

```
EXAMPLES
j.masri · owner
r.haddad · manager
```

Those are the **demo desk's** staff, hardcoded in `os-src/cdos-base.jsx`,
shown to every returning customer. A real owner signs in with their email
address, which looks nothing like `j.masri`, and is being shown two examples
that are neither theirs nor valid for them.

(Checked: this is client-side demo data, not a leak. Every server endpoint —
`/api/tenant`, `/api/tenant/state`, `/api/auth/me` — correctly 401s to a
signed-out visitor.)

**Build:** show examples only once the browser has actually seen this desk's
staff; otherwise say what the field wants — "the email address you set the
desk up with". And the two dead-end lines above need to point at the reset
flow from item 1 instead of at a person who does not exist.

---

## P1 · Things that look unfinished to a customer

### 3. The Tailwind Play CDN is still on the OS and the panel

The last off-domain request either app makes, and the worst kind: it is a
**compiler that runs in the browser**, scanning the DOM and generating CSS
on every load. Tailwind's own documentation says never to ship it.

Now that the JSX is compiled ahead of time this is the single remaining
thing standing between a customer and their till when somebody else's CDN
is having a morning.

**Build:** generate a real stylesheet at build time, beside `web/app/os.js`.
Same shape as the build that already exists.

### 4. Three 404s on every page load

| Request | Where | What it is |
|---|---|---|
| `/api/site/rates` | `/app`, `/login` | `yorkfx-converter.js` asking a **storefront** endpoint on the app domain. Correctly 404s — there is no site for that host — so it should not be asked. |
| `/{{ p.src }}`, `/{{ f.src }}` | the home page | The browser's preload scanner fetching the design's template bindings literally, before the runtime substitutes them. Harmless, and it is a broken-image icon for a frame plus two wasted requests. |
| `/.image-slots.state.json` | the home page | `image-slot.js` is a **design-time** runtime looking for its editor sidecar. It should not ship. |

None of these breaks anything. All three are the kind of thing somebody
opens the console and finds, and then wonders what else is wrong.

---

## P2 · The two emails that are still the plain fallback

`docs/EMAIL-BUILD.md` has the detail. A1 and A2 render the design; these do
not.

- **A4 · contact auto-reply — does not exist at all.** Somebody writes in
  from the contact page and hears nothing back until a person answers. It is
  the simplest of the four and the most obviously missing.
- **A3 · sign-in code.** Currently plain text in a box. After A2 it is the
  email a customer sees most often — every single sign-in.

---

## P3 · Money

Neither of these is a bug; both are load-bearing for what the emails and the
site already promise.

- **Stripe does not gate anything.** A desk is created without a card, and
  setup does not end at a payment step. That is why A2 currently omits the
  founding-code block: there is no checkout for a code to work at.
- **No founding promo code**, so "the first three months come to zero" has
  no mechanism behind it. Today nothing is charged at all, so the promise is
  kept by accident rather than by design — which stops being true the moment
  billing is switched on.

---

## P4 · Platform hygiene

The panel already lists these under **Settings → Still to build**, and they
are correctly described there:

- **Admin MFA.** One password stands between anybody and every customer's
  desk. This should probably be P1 rather than P4 the day a second person
  gets an account.
- Security, Communications, Privacy & compliance, Integrations sections.
- The **Day-1 checklist** still lives as a mock rather than in the real OS.

---

## Suggested order for one push

1. Forgot password, end to end — route, screen, email, session revocation.
2. The sign-in screen's copy and examples, which is where a locked-out
   person is standing when they need item 1.
3. The three 404s. Half an hour, and it makes the console clean enough that
   the next real error is visible.
4. A4, the contact auto-reply.

That is a coherent push: **nobody is stranded, and nobody writes to us into
silence.** Tailwind, A3, Stripe and MFA are each big enough to deserve their
own.
