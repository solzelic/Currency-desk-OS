# Building the designed emails

Handoff for a fresh session. The design is committed at
`design/emails/CurrencyDesk Emails.dc.html` — open it in a browser to see
what each email should look like.

---

## What the design contains

Seventeen emails, and the designer has already tagged them by phase. Four
are **Launch**, and only those four are in scope:

| # | Email | Subject | Fires on |
|---|---|---|---|
| A1 | Application received | *We're looking at your shop* | Early Access form submitted · immediate, before the call |
| A2 | You're in | *Your CurrencyDesk ID is inside* | Approve on the call · fired live |
| A3 | Sign-in code | *482 190 — your sign-in code* | Password accepted · second factor |
| A4 | Contact auto-reply | *Got it — CD-4471* | Contact form submitted · immediate |

The other thirteen are tagged **Soon** (setup unfinished, team invite, new
device, receipt, payment failed, verification result, LCTR ready, deadline
approaching) and **Later** (declined, monthly summary, rule change, what
shipped, jurisdiction live). Leave them. Several depend on systems that do
not exist yet — Stripe receipts, LCTR filing, device fingerprinting — and
building the template before the trigger is how you get a beautiful email
nothing can send.

## The flow the design assumes, and whether it already works

> A1 on submit → phone call → approve on that call → A2 with the ID and setup link

**This already works exactly like that.** An application lands in `reviewing`
and A1's trigger fires automatically; approving is one button that sends A2
with the reference and link. Nothing about the pipeline needs changing —
only the words and the markup.

---

## Step 1 — Know what you are up against

The design is a web page. It uses flexbox and CSS grid in about a hundred
places. **None of that works in email.** Gmail, Outlook and Yahoo strip or
ignore modern layout; Outlook on Windows renders through Word.

So this is not a copy-paste job. Each email has to be rebuilt as nested
`<table>` elements with inline styles, keeping the design's spacing, type
and colour. That is the bulk of the work — budget most of your time here,
not on the wiring.

Rules that are not negotiable:

- Layout in `<table role="presentation">`, never flex or grid
- Every style inline; no `<style>` block for layout (a `<style>` head block
  is fine for `@media`, which some clients honour and none require)
- Width 600px maximum, one column
- Web fonts do not load — set the family, and expect a fallback
- No background images for anything load-bearing
- Every email needs a plain-text version; the existing ones have one and it
  matters for deliverability

## Step 2 — Fill four data gaps before writing any markup

The design declares its own merge fields. Four of them have nothing behind
them today. **Resolve these first** — writing templates against data you do
not have is the fastest way to ship a mail that says `undefined`.

| Field | Used by | Problem | Recommended |
|---|---|---|---|
| `shop_name` | A1, A2 | **The early-access form never asks for it.** It collects a workspace slug (`bayfx`), a website and a person's name — no business name. So *"thanks for putting Yorkville Currency forward"* has no source. | Add one field to the early-access form. It is one more question on a form that already asks nine, and it is the single most personal thing in the email. Fall back to the workspace slug where it is missing — every existing application is missing it. |
| `card_url` | A2 | The charter card is drawn client-side as a PNG in the browser at the end of the wizard. There is no URL for it. | Cut it from the launch version, or serve a rendered card at `/card/<reference>.png`. Cutting is fine; the card already reaches them on screen. |
| `device` | A3 | Sign-in codes do not record the requesting device. | Capture the user-agent on the login-code request and pass a coarse label ("Chrome on Mac"). Small change in `routes/auth.ts`. Or cut the line. |
| `topic`, `message` | A4 | Both exist on the record. **But the auto-reply itself does not exist** — the contact form emails the platform team and says nothing to the sender. | Build it. New template plus a send in `routes/enquiries.ts` where the operator alert already goes. |

`first_name`, `ref`, `cohort_no`, `issued_date`, `setup_url`, `code` and
`expires_in` all exist and are already passed.

## Step 3 — Where the code lives

Everything is in two files.

- **`server/src/email.ts`** — one exported function per email, each returning
  `{ subject, text, html }`. A1 is `reviewEmail`, A2 is `inviteEmail`, A3 is
  `loginCodeEmail`. A4 does not exist yet.
- **`server/src/comms.ts`** — the catalogue. Every template has an entry with
  its audience, trigger, and a `sample()`. **Add A4's entry when you add A4**,
  or the drift test fails, which is the point of it.

Nothing else needs touching. The pipeline already calls these.

## Step 4 — Order of work

1. `shop_name` on the early-access form + the server storing it
2. A1 — the one that fires most and is seen first
3. A4 — the missing one; it is also the simplest
4. A2 — the biggest, and the one carrying the ID and the link
5. A3 — mostly a code in a box; least design in it

Commit after each. They are independent.

## Step 5 — How to check your work

**The panel renders them for you.** `/admin` → **Emails** lists every template
with a live sample, so you see the real output with real merge fields
without sending anything. That page reads `comms.ts`, so a new template
appears the moment you register it.

Then, in order:

```
npm run check:parse          # every browser script still parses
cd server && npx vitest run  # the catalogue-vs-pipeline drift test lives here
npm run test:e2e             # the full customer walk still passes
```

Before sending to anyone real, send one of each to yourself and open it in
**Gmail on a phone, Outlook on Windows, and Apple Mail**. Those three break
different things. A litmus/email-testing account is worth the money for one
afternoon.

## Step 6 — Turn sending on

Nothing above sends anything. Sending is off until these are set on the host:

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | The from address, e.g. `SAM <sam@mail.currencydeskos.com>` — the design signs every email **— SAM · Smart Automated Machine**, so the from name should agree |
| `REPLY_TO` | An inbox a person reads. The design promises *"a person reads every reply"* on every email — that promise needs somewhere to land |

**Verify the sending domain at Resend first** (SPF, DKIM, ideally DMARC).
Do it before the founding cohort: mail from an unverified domain lands in
spam, and burning a fresh domain's reputation on your first forty customers
is not recoverable.

Until those are set, every send is written to the server log and the panel
says so on each one. That is deliberate — a reply that reached a log file
must never look like one that reached a person.

---

## The call: decided, keep the copy as designed

A1 promises a call the same day — *"about ten minutes, mostly us
listening"* — and A2 says the ID and setup link arrive *"while we're still
on the phone."* Both attribute it to **SAM**, which writes and calls.

**Write it exactly as designed. Do not soften it.** The automated call ships
before this goes public; until then the founder places every call by hand.
The end state and the copy agree, and the interim is a person doing what
the machine will do — not a promise nobody intends to keep.

### What that means operationally, today

Anyone who applies right now gets A1 within seconds and expects a phone
call the same day. So somebody has to know they applied.

Two things carry that, and **only one of them works right now**:

- The **Applications** badge in the panel goes amber the moment an
  application lands. Works today.
- The **new-application alert** to the platform team is an email — and email
  is not switched on, so it is written to the server log and reaches nobody.

Until `RESEND_API_KEY` is set, **the panel is the only notification**. While
volume is a handful a day that is fine, as long as somebody is actually
opening it. It stops being fine the moment the site is public, which is the
same moment sending is on — so this resolves itself, but not before.
