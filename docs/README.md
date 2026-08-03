# What's in here, and which of it is true

Seventeen documents accumulated over a few months, several describing a
codebase that was deleted. This says which to trust, so nobody spends an
afternoon following a plan that was abandoned in July.

**Audited 2026-08-03** — every claim checked against the code, not against
the previous update.

## Read these

| | |
|---|---|
| **`ARCHITECTURE.md`** | How the system is built and why. The table-versus-document rule, the path off the blob, security for our customers and for us, and how to build when most code is written with AI. Start here. |
| **`NEXT-PUSH.md`** | What to do next, in order, with what's already done so nobody re-checks it. |
| **`DEVELOPMENT.md`** | How to run it, edit it, and test it. |
| **`EMAIL-BUILD.md`** | The designed emails: which are built, which are deliberately not, and the rules for writing HTML email that survives Outlook. |
| **`STRIPE_BILLING.md`** | How billing is wired. |

## Reference — narrow, accurate, still current

The ledger and quote docs describe code that hasn't moved and are precise
about invariants. Trust them when working in `server/src/ledger` or
`server/src/quotes`.

- `LEDGER_POSTING_API.md`, `LEDGER_POSTING_INVARIANTS.md`
- `QUOTE_SERVICE.md`, `QUOTE_INVARIANTS.md`
- `JURISDICTION_PACK_ARCHITECTURE.md`

## Correct in substance, wrong about scope

Written for the React foundation under `src/` that was deleted. Each now
opens with a correction. The threats and the compliance gaps they list are
still real; the code they describe is not.

- `THREAT_MODEL.md` — still the right checklist of threats to answer.
- `SECURITY_COMPLIANCE_FOUNDATION.md` — its warning against real KYC in
  browser storage is *live*, not historical. That's P0 in `NEXT-PUSH.md`.

## History — do not follow

Kept because they explain how things got this way, and because a decision
you don't understand is worse than one you disagree with.

- `HANDOFF.md` — the source of truth as of 2026-07-22. Its §7 "Gotchas" is
  still worth reading; its "Next 10" is re-checked in the note at the top.
- `NEXT-AGENT-PROMPT.md` — a brief for a session that already happened.
- `MIGRATION.md` — the plan to move to Vite/React. Abandoned; that app was
  deleted after its CI ran green while the shipped code went unwatched.
- `SAAS_ROADMAP.md` — the strategic plan, now annotated phase by phase with
  what actually shipped. Phases A and C are done, D is built but gates
  nothing, B is half done and the remaining half is the compliance half.
- `CurrencyDesk OS - Roadmap v2.html` — an early product roadmap. Design
  reference only.

## The rule

If a document tells you to do something and the code disagrees, **the code
wins and the document is a bug.** Fix it in the same push, or say plainly at
the top that it's stale. A confidently wrong document costs more than a
missing one — it was `ARCHITECTURE.md` telling people not to refactor the
product for two weeks that made this audit necessary.
