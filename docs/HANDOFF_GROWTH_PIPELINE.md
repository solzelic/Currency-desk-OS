# Handoff — lead research and the outbound call

A second workstream, independent of the ledger work in
`docs/HANDOFF_LEDGER_WORK.md`. Nothing here touches money, so the
cash-ownership invariants do not apply — but one of their lessons does,
and it is the most important design decision in this document. See §2.

## 1. What exists already

A prospect fills in the early-access form on the public site. That is the
**initial capture**, before onboarding, and it is the trigger for
everything below.

```
web/early-access.html          the form
server/src/routes/enquiries.ts POST handler, throttled, mints a CD-XXXXXX reference
server/src/db/schema.ts        the `enquiries` table (line ~400)
server/src/routes/admin.ts     the operator's API
admin.html                     admin panel source — builds to web/app/admin.js
```

An `enquiries` row carries: `reference`, `kind` (`early_access` |
`contact`), `email`, `name`, a free-form `details` JSONB blob, `status`,
`notes`, `charterNo`, `labels`, and `tenantId` once they convert.

The form collects **business name, contact name, email, website and
phone**. That is genuinely enough to research a currency exchange: a
website to read, a name and city to search, and — in Canada — a
FINTRAC MSB registration to look up, which is public and is the single
highest-signal field available about this particular kind of business.

**Do not change `details` to a fixed schema.** The comment on it explains
why it is a blob; the two forms ask different questions and both keep
changing.

## 2. The one design decision that matters

**What the applicant TOLD us and what we INFERRED about them are
different facts and must never share a column.**

This codebase has been bitten repeatedly by two sources of one number
living in one place — see `docs/CASH_OWNERSHIP_INVARIANTS.md`. The same
shape applies here and the consequences are worse than a wrong balance:
an operator reading a screen must be able to tell, at a glance, whether
"handles about $2M a month" is something the owner said or something an
AI guessed from a LinkedIn page. One of those you can quote back to them
on a call. The other will embarrass you.

So:

- `enquiries.details` stays exactly what the applicant typed. Research
  never writes to it.
- Research goes in its own table, one row per run, **append-only** — a
  later run does not overwrite an earlier one, it adds to the history.
  Re-running research on a lead you already called must not silently
  rewrite what the caller saw.
- Every research finding carries **where it came from** (source URL or
  tool) and **how confident** it is. A finding with no source is not a
  finding; render it as absent rather than as fact
  (`docs/ABSENT_FIGURES.md`).
- The admin panel shows stated and inferred data **visually distinct**.

Suggested shape, adjust as you build:

```
enquiry_research      id, enquiry_id, run_at, model, status, summary,
                      cost_cents, created_by
enquiry_research_facts research_id, key, value, source_url, confidence,
                      method ('web_search' | 'website_read' | 'registry' | 'model_inference')
```

## 3. The work, in three stages

Each stage ships on its own and is useful without the next.

### Stage 1 — research a lead

- A job that takes an `enquiries` row and produces one `enquiry_research`
  run: read their website, search for the business, look up the FINTRAC
  MSB registry, summarise what a salesperson would want to know before
  dialling.
- Triggered **manually from the admin panel first** (a "Research" button
  on the application), automatic later. Manual first means you see a
  dozen real outputs before anything runs unattended.
- Store the cost per run. This is the kind of thing that is fine at 10
  leads and surprising at 500.

### Stage 2 — show it, and let an operator act

- The application detail view in `admin.html` grows a research panel:
  the summary, the facts with their sources, and when it was run.
- Actions: re-run research, mark reviewed, and **call now**.
- Nothing calls automatically at this stage.

### Stage 3 — the ElevenLabs call

- An ElevenLabs Conversational AI agent, given the research summary as
  context, placed as an outbound call to the phone on the application.
- Persist to an append-only `enquiry_calls` table: placed_at, agent id,
  call id, duration, outcome, recording URL, transcript.
- The transcript comes back into the admin panel against the application,
  the same way research does.
- **Idempotency**: one call per lead per trigger, keyed so a retry or a
  double-click cannot dial somebody twice. This codebase already does
  this everywhere money moves; a phone ringing twice at 8pm is the same
  class of mistake.

## 4. Requirements that are not optional

These are build requirements, not legal advice — get a lawyer's read
before the first unattended call. They are cheap now and expensive to
retrofit.

- **Record the consent.** The applicant submitted a form asking to be
  contacted, which is the strongest possible footing. Store the
  timestamp, the form version, and the IP with the enquiry so it is
  provable later. Right now the row does not carry it.
- **The agent identifies itself as an AI**, in its opening line. Several
  jurisdictions require it and all of them are trending that way.
- **Announce recording** at the start if calls are recorded.
- **Honour do-not-call**, immediately and permanently. A `do_not_contact`
  flag on the enquiry, set by the caller agent when asked, by an operator
  from the panel, and never cleared automatically.
- **Call windows.** Canada's rules permit 9am–9pm local. Derive the
  window from the lead's own timezone, not the server's.
- **A kill switch.** One setting that stops all outbound calling,
  reachable without a deploy. The first time an agent misbehaves you will
  want it in seconds, not minutes.
- **Never dial a number the applicant did not give you.** Research may
  turn up a phone number; that number has not consented. Call the one on
  the form.

## 5. Secrets and configuration

`ELEVENLABS_API_KEY`, the agent id, and whatever the research tool needs
go in environment variables, never in the repo. There is an existing
pattern for optional integrations — look at how `RATES_SYNC` and the
Stripe keys are handled: absent config disables the feature cleanly
rather than crashing at boot.

## 6. How you will know it works

Same standard as the rest of the repo: **done means a test fails if it
regresses.**

- The research job runs against a fixture lead and produces facts that
  each carry a source.
- The admin panel renders stated and inferred data distinguishably —
  a test that fails if research ever lands in `enquiries.details`.
- A lead marked `do_not_contact` is never dialled. Assert the refusal.
- A call outside the permitted window is refused, with the reason.
- The same trigger fired twice places one call.

That last one is the one to write first. It is the failure that reaches a
real person.
