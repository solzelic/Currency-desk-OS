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

Until the variables are set, every send is written to the server log and
the panel says so per-send — deliberate, so a reply that reached a log
file never looks like one that reached a person. Note the operational
corollary: until sending is on, **the admin panel is the only
notification** for inbound enquiries; somebody has to be opening it.
