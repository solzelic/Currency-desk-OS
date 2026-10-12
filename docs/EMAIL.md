# Email — the constraints and the sending contract

(Consolidated from the completed email build-out. The designed templates
live in `server/src/emails/design.ts`; `server/tests/designed-emails.test.ts`
holds every registered email to these rules.)

## The rules that are not negotiable

Gmail, Outlook and Yahoo strip or ignore modern layout; Outlook on Windows
renders through Word. So every email is built as:

- Layout in `<table role="presentation">` — never flex or grid.
- Every style inline; no `<style>` block for layout (a head block for
  `@media` is fine — some clients honour it, none require it).
- 600px maximum width, one column.
- No web fonts; system stacks only.
- A plain-text twin for every HTML body.

These are enforced by the drift guards in `designed-emails.test.ts` —
an email that regresses to the plain fallback fails the suite.

## Sending

Nothing sends until these are set on the host (Render dashboard):

| Variable | What it is |
| --- | --- |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | The from address; the design signs every email "— SAM · Smart Automated Machine", so the from-name should agree |
| `REPLY_TO` | An inbox a person actually reads — every email promises "a person reads every reply" |

**Verify the sending domain at Resend first** (SPF, DKIM, ideally DMARC):
mail from an unverified domain lands in spam, and burning a fresh domain's
reputation on the founding cohort is not recoverable.

Until the variables are set, dev and test write the send to the server
log so a sign-in code can be read back in a suite. Production does not.
If `RESEND_API_KEY` or `EMAIL_FROM` is missing and `NODE_ENV` is
`production`, the send is refused. One missing name, the warning says
`is not set`. Both missing, it says
`RESEND_API_KEY and EMAIL_FROM are not set`. It does not contain the
code, the subject, or the body. A sign-in subject line is the code.
A provider error body that cannot be read still logs the status.
Signup answers 503 when that send fails, so the screen does not move
on to a code that was never mailed.
The panel still says, per send, when a message did not reach a person.
Until sending is on, **the admin panel is the only notification** for
inbound enquiries; somebody has to be opening it.
