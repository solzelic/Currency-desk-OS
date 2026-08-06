# Handoff — lead research and the outbound call

A second workstream, independent of the ledger work in
`docs/HANDOFF_LEDGER_WORK.md`. Nothing here touches money, so the
cash-ownership invariants do not apply — but one of their lessons does,
and it is the most important design decision in this document. See §2.

## 1. What exists now

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

The growth workflow is implemented alongside that row:

```
server/src/growth/research.ts  Tavily search → targeted extract → cited brief
server/src/growth/worker.ts    durable queue claiming, retries and stale-lock recovery
server/src/growth/workflow.ts  one derived team-facing stage and next action
server/src/growth/calls.ts     reviewed-brief gate and idempotent ElevenLabs placement
server/src/growth/routes.ts    detail, pipeline, assignment, review, call and webhook APIs
server/src/db/migrations/022_growth_operations.sql
                              jobs, timeline events, assignment history and briefs
admin.html                    process rail, owner, brief, sources and call history
```

An early-access submission commits its consent evidence, an
`application_received` event and a queued research job in the same
transaction. The public request never waits for Tavily. If Tavily is not
configured, the job remains safe and visible as **Research waiting**.

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
  tool). A finding with no source is not a finding; render it as absent
  rather than as fact (`docs/ABSENT_FIGURES.md`).
- A source is saved only when its extracted text names the applicant's
  stated business exactly. The supplied website is read directly, public
  search snippets are candidates only, and a generic currency-exchange
  result is discarded before extraction. Never substitute a contact's
  personal name or email for a business identity.
- The submitted email and phone are **corroboration signals**, not public
  search terms. The research job may check whether either is published on
  the applicant's stated corporate website, and it records that positive
  result with the page URL. It never sends personal contact details to a web
  search provider for a reverse people-search.
- A completed run also records exact-match counts for other early-access
  applications (same email, phone, or stated business). Those are a
  staff-only duplicate-resolution aid: they reveal no other applicant's
  details and are never sent to ElevenLabs or rendered as public research.
- The compact caller brief records that identity check. A historical run
  from before this rule remains append-only for audit, but cannot be
  reviewed or used to place an AI call; the operator must re-run it.
- The admin panel shows stated and inferred data **visually distinct**.

Current shape:

```
enquiry_research_runs id, enquiry_id, run_at, provider, model, status,
                      summary, brief, credits_used, cost_cents, created_by
enquiry_research_facts research_id, key, value, source_url, confidence,
                      method ('web_search' | 'website_read' | 'registry' | 'model_inference')
enquiry_growth_jobs   enquiry_id, status, attempts, available_at, lock,
                      research_id, error, requested_by
enquiry_growth_events enquiry_id, type, detail, actor, created_at
enquiry_growth_assignments enquiry_id, assigned_to, assigned_by, assigned_at
```

## 3. The work, in three stages

Each stage ships on its own and is useful without the next.

### Stage 1 — research a lead — implemented

- A durable job takes an `enquiries` row and produces one append-only
  research run: discover and extract their website, search for the
  business, look for evidence in the FINTRAC
  MSB registry, summarise what a salesperson would want to know before
  dialling.
- It is identity-gated: without a stated business/legal name it fails
  visibly without making a public people-search. It only searches FINTRAC
  when the applicant states a Canadian jurisdiction.
- Triggered automatically after signup. The operator can also re-run it
  manually. Automatic jobs retry with a bounded backoff and stale worker
  locks are recovered after a restart.
- Store the cost per run. This is the kind of thing that is fine at 10
  leads and surprising at 500.
- Its result includes a caller-safe handoff: call goal, sourced public
  business context, and suggested questions. It is distinct from both the
  applicant's form answers and the operator-only duplicate check.

### Stage 2 — show it, and let an operator act — implemented

- The application detail view in `admin.html` grows a research panel:
  the summary, the facts with their sources, and when it was run.
- Actions: re-run research, mark reviewed, and **call now**.
- The board and list show the operational stage, current owner and next
  action. The detail view adds a six-step process rail, structured caller
  brief and append-only event history. Owner and Support can work it;
  Auditor remains read-only through the existing platform permissions.
- Nothing calls automatically at this stage.

### Stage 3 — the ElevenLabs call — implemented, disabled until configured

- An ElevenLabs Conversational AI agent receives two separately labelled
  context blocks: what the applicant submitted and a caller-safe, sourced
  business context. Staff-only duplicate counts do not cross that boundary.
  A staff member must approve the latest brief before calling.
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

`ELEVENLABS_API_KEY`, the agent id, and `TAVILY_API_KEY`
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
- Two workers racing for one queued job produce one research run.
- The team pipeline derives **Brief ready** from the stored run and shows
  the current append-only assignment.

That last one is the one to write first. It is the failure that reaches a
real person.
