# Build brief: Persona PR 2 (ID check tiers 1 and 3, consent, badge, masked ID number)

Written Mon 16 Nov 2026, about 3:05 am Israel time, for a cloud coding agent.
Repo: solzelic/Currency-desk-OS. Base branch: `staging`. Open a DRAFT PR into `staging`. Never merge.
Sources are quoted inline because you cannot see the box these rules came from. Where the sources disagree, the point is listed under "Open questions" at the end. Do not guess on those. Build the safe default named there and say in the PR body which default you used.

## 0. Context you need first

- This is Sol's top build priority (relayed by the CEO, 16 Nov). The Persona track has three PRs:
  - PR 1 is PR 722 (`cursor/persona-sandbox-webhook-6501`): sandbox start check, signed webhook, `npm run persona -- register-webhook`, migration `074_idv_inquiry_client.sql`. Still open while it is merged into staging. If it is not on `staging` when you start, base on `staging` anyway, rebase once 722 lands, and do not copy its code.
  - PR 2 is this brief.
  - PR 3 (not yours): in-house sanctions plus the CAD 3,000 posting lock, with Compliance sign-off before merge.
- What "done" means for the whole track: a full staged deal at the counter where the ID check runs end to end through the Persona sandbox. PR 2 has to provide everything for that except the posting lock: a check a teller can start, a customer can complete on the counter device, a stored record, and a badge on the client file.
- Sanctions PRs 728 and 729 are on `staging` (migrations 075, 076, 077). PR 729 added `POST /api/screening/id-check` with `tier: "1" | "2" | "3" | "quick" | "verify" | "plus"` (`server/src/screening/routes.ts`). Leave its screening logic alone. Don't break that route.
- PR 731 (Exchange v2.9.1, CD-233/235/257/260) is stopped by Sol. Don't depend on it, copy it, or use its design.

## 1. What tiers 1 and 3 mean

The code numbers the tiers in `os-src/cdos-kyc.jsx` (line ~679: `const tierNo = tplId === 'plus' ? '3' : tplId === 'quick' ? '1' : '2';`) and in `server/src/screening/routes.ts` (`TIER_NUMBER`: `"1"`=quick, `"2"`=verify, `"3"`=plus). On 15 Nov, Compliance and Sol renamed the tiers (Notion CD-216 and the Compliance decision "KYC tiers: FINTRAC method per tier", 15 Nov about 10:07 pm Israel). The mapping:

| Code tier | Old name in code | Current name (use this in UI) | Placeholder price | FINTRAC method |
|---|---|---|---|---|
| (none) | (none) | In person (free) | Free | Photo ID, in person: staff inspect the original ID |
| 1 | `quick`, "Quick check" | Returning client | $3.99 | Not a new check. Relies on this same shop's earlier valid check (PCMLTFR s.155(1), Guide 11 s.3) |
| 2 | `verify`, "Verified" | ID and selfie | $6.99 | Photo ID method: Persona authenticity, liveness, face match |
| 3 | `plus`, "Verified Plus" | ID, selfie and database | $14.99 | ID and selfie, plus credit file or dual process **once confirmed** |

Sol's ruling, 15 Nov about 10:06 pm Israel (CEO pasted his exact words): every tier must be FINTRAC valid, and no tier carries a "not valid for FINTRAC" label. Prices are placeholders (CD-213). Don't build pricing, billing or charges.

### Tier 1, Returning client (Compliance decision, 15 Nov, and draft shop addendum clause 2.4)
Allowed only when ALL of these hold. Otherwise the UI offers a full check instead.
- (a) This same shop verified the person earlier with a FINTRAC method (In person, ID and selfie, or ID, selfie and database).
- (b) The full earlier record is on file: method, document type, number, issuer, country, expiry at the time, date verified, and who verified.
- (c) A staff member confirms by eye that this is the same person, with name and date of birth matching, and records "no doubts". The face is checked against the stored photo. See open question Q6: the planned face crop is not built.
- (d) No identifying details have changed (for example a name change).
- (e) The earlier record is still held, and fewer than 5 years have passed since the last full check. From 3 years, show a recommendation (advice only) to do a new ID and selfie check. At 5 years a new full check is required.
- Never for a first-time client. Never on the strength of another shop's check, and never across shops (`tenant_id` and `legal_entity_id` scope on every query).
- A doubt blocks tier 1 for that visit, and the reason is stored.
- Each use is logged with the deal (or client, if no deal yet) and links to the original check record.
- It does not start a Persona inquiry. It uses no Persona token, account or face template.
- Keep the PR 729 PEP question for tier 1 working as it does now.

### Tier 3, ID, selfie and database (Compliance decision 15 Nov, draft addendum clause 2.5)
- Runs the ID and selfie method through Persona: document authenticity, live selfie with liveness, face match, name match, valid and not expired.
- The database step (Canadian credit file at least 3 years old, or dual process) stays **switched off** until Persona confirms a qualifying Canadian source in writing and counsel approves. Until then, tier 3 runs ID and selfie only, and the UI says so plainly, for example: "The database step is not on yet. This check runs ID and selfie."
- Adverse media, phone risk and email risk are "supporting information only, not a FINTRAC ID method". Don't build them in PR 2.
- If the selfie step is declined, abandoned or fails, the result is **"Method not completed"** (addendum 2.6). That is not a verification. The teller is sent to the In person path.

### In person (free), needed for consent "No thanks" and for Quebec
You must build the counter path, because consent must offer a real alternative (OPC biometrics guidance) and Quebec is counter only. The teller handles the original document, checks it looks authentic, valid and not expired, and matches the face. Then the teller enters the record fields (section 4) and attests. No photo or copy of the document is taken in this path. Free. No Persona call.

## 2. Consent and notice (CD-219)

Use the CD-219 wording v0.3.7 (legal draft "PIPEDA and biometric wording", sections H3 and H4). The 24 Oct "Face check" copy is older and has been replaced. This is draft wording that is still awaiting lawyer review, so put every customer-facing string in one copy module with a version id (for example `consent-v0.3.7-draft`) so it can be swapped later.

**Notice, shown before the check starts (H4, the parts that apply in sandbox at the counter):**
> **Before we check your ID**
> [Shop legal name] ("we") must verify your identity under Canada's anti-money laundering law for some transactions. We use CurrencyDesk, our software provider, and its identity verification provider Persona to do this for us.
> **What we collect:** photos of your ID, the details on it, a selfie if you agree, and information about your device.
> **Why:** to confirm your identity, to detect fraud in this check, and to keep the records the law requires.
> **Where:** your information is stored and processed in the United States, and may be accessed by courts, law enforcement and national security authorities there.
> **Fraud prevention by Persona:** Persona may also use your information to prevent fraud.
> **How long:** ID photos and selfies are deleted within 30 days. Your ID details are kept for at least 5 years because the law requires it. Persona may keep some device information longer to prevent fraud.
> **Your choice:** you can show your ID to staff at the counter instead.
> **Your rights:** to see or correct your information, or to ask a question, contact [Shop privacy officer name or title, email, phone]. Privacy policy: [link]. Persona's privacy notice: [link].

**Selfie consent, a separate screen with the box NOT pre-ticked (H3):**
> **Optional face match**
> To check that you are the person on your ID, [Shop legal name] can compare a selfie with the photo on your ID. This uses the shape of your face, which is biometric information.
> The match is done for [Shop legal name] by CurrencyDesk using its provider Persona. Your selfie and ID images are processed and stored in the United States and may be accessed by courts, law enforcement and national security authorities there. They are deleted within 30 days. Your ID details are kept for at least 5 years because the law requires it.
> You do not have to agree. You can show your ID to staff at the counter instead.
> [ ] I agree to the face match.
> Questions: [Shop privacy contact, email, phone].

Rules:
- Name the US data region. Never say or imply "data stays in Canada".
- **Leave out** the H3/H4 sentence "We also keep a small photo of your face so staff can recognise you." The approved copy drops it when the face crop is off, and the face crop is not built (it waits on a lawyer and on Persona's permission). See Q6.
- The "[Remote only]" paragraph in H3 is out of scope. PR 2 is at the counter only.
- "I agree" and "No thanks, check my ID at the counter" are buttons of equal size, and nothing is pre-checked. Consent must be a separate tick, never bundled with terms.
- "No thanks" goes to the In person path and tells the teller only: "Customer chose the counter check. Inspect the original ID."
- Store a consent record per check: time (stored in UTC, shown in the branch zone as a 12-hour time), copy version id, language, Persona inquiry id, the choice (agreed or counter check chosen), and the staff id. Store it before the Persona link opens. No consent record means no link.
- Fill the shop legal name and privacy contact from shop settings. If missing, show a clear placeholder and block the link on staging only with a message to the owner. Don't invent a contact.
- **Quebec branches are counter only** (Sol's decision D, 24 Oct, until the shop files with the CAI). For a Quebec branch, don't show the face match or start a Persona inquiry. Only the In person path is offered, with a teller line such as "Face match is off for this branch. Inspect the original ID." French copy is required for Quebec branches when that changes. Not in this PR. See Q7 on how to know the branch is in Quebec.

## 3. Badge and status wording

Rules from Compliance (15 Nov) and draft addendum 12.1:
- Never use the words "Verified", "Approved", "Cleared", "FINTRAC approved", "compliant" or "Certificate" anywhere in UI copy, API messages shown to users, or new identifiers shown on screen.
- A completed check reads **"ID checked [date], [method]"**, in a neutral colour with no green approval tick.
- The detail view adds: "Shows the check done on this date. Not a guarantee of identity."
- Keep PR 722's sandbox style: a sandbox pass shows **"Check passed (test)"**, and the record line carries "(test)" too, for example "ID checked 16 Nov 2026, ID and selfie (test)". A `persona_production` key never reaches a pass in this PR.

States to build (exact copy may be tuned by Compliance and Head of Design, but keep the meaning):

| State | Line on the client file |
|---|---|
| No check | "No ID check on file" |
| Started or in progress | "ID check in progress" |
| Needs review | Teller: "This needs review. Your compliance officer will review this." (the existing PR 729 sentence). Compliance officer and owner see the reason. |
| Passed, sandbox | "Check passed (test)", plus "ID checked [date], [method] (test)" |
| Declined | "Check not passed. Check the ID at the counter." Route it to the compliance officer (addendum 5.2). No hint to the customer. |
| Abandoned, expired or failed capture | "Method not completed. Check the ID at the counter." |
| In person recorded | "ID checked [date], photo ID in person" |
| Returning client used | "ID checked [original date], [original method]. Returning client [today]" |
| Re-check advised (3+ years) | "A new ID and selfie check is advised." (advice only) |
| Full check due (5 years) | "A new full ID check is needed." Returning client is blocked. |

Method words: "photo ID, in person", "ID and selfie, Persona", "ID, selfie and database, Persona", "Returning client".
Remove or replace the old ladder words "ID verified" and "Verified Plus" and the green badge (`design/kyc-handoff/README.md`, `os-src/cdos-kyc.jsx`) where PR 2's screens show them. Tier labels in the chooser use the current names in section 1.

## 4. The ID check record (CD-263 field list)

Field list from Notion ticket CD-263 ("Field list (Compliance 15 Nov 11:19 pm, Data and Privacy agrees, via CTO)"), plus PCMLTFR s.108(a) and draft addendum 3.1. Store a new append-only record per finished check (Persona or In person) and per Returning client use:

- Name as shown on the ID
- Date verified (branch date), with the timestamp stored in UTC and shown as a 12-hour time
- Method and tier (In person, Returning client, ID and selfie, ID selfie and database)
- Document type (the catalogue label from `shared/id-document-types.js`, plus Persona's id class for Persona checks). Health cards are refused (existing rule).
- Full document number, **encrypted** (section 5)
- Issuing jurisdiction (province or state) and country
- Expiry date, if on the document
- Result (pass, declined, needs review, method not completed) and the reasons or checks the provider gave
- Persona inquiry id, plus the government ID and selfie verification ids, template id and version (for Persona checks)
- The staff member who started the check. For In person, the named staff member who inspected the document and their attestation. For Returning client, the staff member who confirmed the person, plus a link to the original record.
- Link to the client, and a link to the deal (see Q9)
- Consent record id, or "counter check chosen"
- At CAD 3,000 or more (FX ticket, PCMLTFR s.1(2)(b)): also address, date of birth and occupation (see Q10 on where those live)
- Superseded marker (who and when) when a newer record replaces it. Never overwrite and never delete early (FINTRAC ID rulings 12 Oct, Q4).

Retention: at least 5 years from the check, and longer while a Returning client use relies on it (addendum 4.1). Don't build any delete path in this PR. Append-only: updates only add superseded markers or new rows.

Persona checks: on a terminal webhook, the server fetches the inquiry server to server with `include=verifications` (or the current equivalent; check Persona's docs for API version `2026-09-29`, which PR 722 pins). It writes the record fields in the same transaction as the status change. Read only text attributes (names, `identification-number`, `id-class`, `issuing-subdivision`, `issuing-country`, `expiration-date`, `birthdate`, address fields). **Never** request, read, store, log or forward any photo, file or URL attribute (`front-photo`, `back-photo`, selfie photos, video, document files). Write a test that proves photo fields are dropped even when the sandbox response contains them.

Make the CD-263 fields part of PR 2. They must ship before Persona's 30-day redaction is switched on, or the FINTRAC record would exist nowhere (D&P PR 722 review, F4).

## 5. Masked document number, reveal and audit

Sources: Compliance "Exchange build answers" section 5 (15 Nov, 9:45 pm Israel), CD-263, draft addendum 3.3.
- Store the full number encrypted, using AES-256-GCM with a key from env. Follow the pattern in `server/src/auth/totp-secret.ts`: fail closed on staging and live when the key is unset, use a fixed dev key only in dev, unit tests and the seam, and never write the key next to the ciphertext. Suggested env name: `ID_NUMBER_KEY` (Q4). Never log the number or put it in an audit row, error, URL or analytics field.
- Default display everywhere is masked to the last 4 characters, for example "•••• 1234". Client search hints, where they exist, show the last 3 at most (Compliance 24 Oct client search ruling). Don't change search in PR 2.
- Teller: sees the full number only while capturing and checking it in the In person path. There is no reveal afterward. Persona-sourced numbers are never shown in full to a teller.
- Reveal is allowed for roles above teller only: `supervisor`, `branch_manager`, `compliance_officer` and `administrator` (owner). `teller` and `auditor` cannot reveal. See Q5.
- Each reveal requires a reason picked from a list: FINTRAC request, report filing, ID mismatch, client request. An optional note is allowed. See Q5 on adding "Other".
- Every reveal writes an append-only audit row in the same transaction that returns the number. The row records who, role, when, client, deal if any, and the reason. It never includes the number. Follow the existing pattern in `server/src/clients/records.ts` `revealDocumentScan` (audit written before the answer, same transaction). Keep audit rows for 5 years. Exports and printouts of ID numbers count as reveals. If you add no export, say so.
- Reveal happens on the server, through a dedicated POST endpoint. The client read API only ever returns the masked form.
- Scope: Persona and In person records created by PR 2. The older manual ID documents in `desk_client_identity_documents` still return `docNumber` in full from `documentJson` (`records.ts` ~1474). Don't silently change that table in PR 2 (Q11).

## 6. Images: never stored by this PR

- PR 2 stores no image, selfie, video, face template or document file from Persona, anywhere: no database, disk, logs or cache.
- Don't add rows to `desk_client_images`. Don't build the face crop. That waits on a lawyer and on Persona's written permission (CD-219 v0.3.6: "Not built yet ... stays unbuilt until the lawyer clears permission to keep the crop").
- Persona's 30-day redaction is Persona dashboard config, not code. Keep PR 722's TODO and docs line.

## 7. Sandbox only, keys and runtime

- Staging accepts `persona_sandbox` keys only. `persona_production` is refused on every runtime. Any other `persona_` prefix is refused. A live host (currencydeskos.com and the live Render host) refuses every key. Keep PR 722's `personaKeyMatchesRuntime` rules exactly. Don't loosen them.
- Every new outbound Persona call in PR 2 goes through ONE shared key assertion inside the Persona client, before any network call: fetching the inquiry and its verifications, and generating the one-time link (`POST /api/v1/inquiries/{id}/generate-one-time-link`, link in `meta.one-time-link`). Security's 722 notes ask for this, and for: fail-closed runtime detection, and unprefixed keys only in tests or with a stub base (Q12).
- Persona keys and secrets come from env only (`PERSONA_API_KEY` through the shop's `apiKeyRef`, `PERSONA_WEBHOOK_SECRET`). Sol puts keys into Render himself. Don't read, set or print any key, don't touch Render env, and never commit a secret. Tests use stubs. Any live sandbox test is skipped unless `PERSONA_SANDBOX_API_KEY` is set (existing pattern).
- Template ids are not secrets and live in shop settings (`PUT /api/settings/idv`). If tier 3 needs its own sandbox template, add an optional per-tier template id to the shop config (Q3).
- No paid plan, no billing, no credit charges, no contract, no spend. Leave the credit ledger alone unless a test needs it to stay green.
- The one-time link opens on the counter device. Don't send it by email, SMS or any other outbound channel.

## 8. Copy rules

- No em dash (U+2014) or en dash (U+2013) anywhere in new or changed lines, including UI copy, comments, docs, tests and the PR body. `server/tests/dash-ratchet.test.ts` fails CI when a file's dash count changes. Don't raise any baseline. Lower one only if you removed dashes, and say so.
- Times are 12-hour, in the branch zone. Dates look like "16 Nov 2026".
- Customer-facing screens never mention sanctions, lists, suspicious, PEP, FINTRAC reports or police.

## 9. Size: split it

This is too much for one reviewable PR. Split it into two PRs, each based on `staging`. Avoid a stack if you can: GitHub refuses a GraphQL or `gh pr merge` merge on a stacked PR. If 2b must stack on 2a, say so in both PR bodies.
- **PR 2a, server.** Migration, encrypted ID record (CD-263 fields), Persona inquiry fetch on the terminal webhook with photo fields dropped, one shared key assertion, the one-time link endpoint, the consent record API, the In person record endpoint, the tier 1 rules (eligibility, doubt, 3 and 5 years) and the tier 3 rules (database step off), the reveal endpoint with audit, and the client read with masked numbers. Tests.
- **PR 2b, UI.** Notice and consent screens, the counter path, the start or link screen for tier 3, the Returning client confirm screen, badge states, the masked number with the reveal dialog, tier names in the chooser, the Quebec counter-only state, the rebuilt `web/app/os.js`, the seam spec, and the screenshots.
Put a size table in each PR body (product lines without `web/app/os.js`, tests, docs), as PR 722 did. If either part still runs well past about 300 product lines, ask the CTO for a written size waiver in a PR comment. Don't pad it or bundle unrelated work.

**Migration number:** don't hard-code 078. `staging` has 075 to 077. Open PRs already claim 074 (722, 707, 731), 075 to 078 (sign-up PRs 715, 717, 718, 720), 079 (725) and 080 (727). Before you write the file, list `server/src/db/migrations/` on the current `staging` AND check the open PRs (`gh pr list --state open` then each PR's files). Take the next number above all of them, which is 081 or higher as of 3 am Israel, 16 Nov. Register it in `server/src/db/migrations.ts`. Re-check before you mark the PR ready.

## 10. Tests to add (vitest plus the Playwright seam)

Server:
- The record stores every CD-263 field for an In person check and a Persona sandbox check, plus the deal link where one is given.
- Document number: ciphertext in the database, never plaintext. Decrypt round trip. A tampered ciphertext fails closed. Staging or live with no key fails closed. The masked form shows the last 4 only.
- Reveal: teller 403, auditor 403, and supervisor, branch_manager, compliance_officer and administrator allowed. A missing or unknown reason is 400. The audit row is written in the same transaction and contains no number. A failed audit insert means no number is returned. Cross-tenant reveal is 404.
- The client read never returns a full Persona-sourced number to any role.
- Persona fetch: photo, file and URL attributes are dropped and never stored or logged (a stub response contains them). Only text fields are stored.
- Shared key assertion: every new outbound call refuses `persona_production`, unknown prefixes, any key on a live host, and unprefixed keys outside the test stub, before fetch is called.
- Consent: no consent record means no one-time link (409). The stored record has UTC time, copy version, language, inquiry id and staff id. "Counter check chosen" routes to In person and starts no Persona inquiry.
- Quebec branch: the Persona start and link are refused, and only In person is allowed.
- Tier 1: refused for a first-time client, for a record from another shop, when doubt is set, when details changed, and at 5 years or more since the last full check. The 3-year advice flag is set. Each use links to the original record and logs the deal or client.
- Tier 3: the database step is reported off and the check runs as ID and selfie. Selfie declined or failed means "Method not completed", which is not a verification.
- Append-only: no update or delete path changes a stored record. Supersede adds a marker with who and when.
- Copy guard: a test fails if any new UI string or API message contains "Verified", "Approved", "Cleared" or "FINTRAC approved" (case-insensitive, whole word).
- Dash ratchet still passes.
Seam (`tests/e2e/`): teller starts tier 3, consent agreed, one-time link stubbed, webhook stubbed to approved, badge shows "Check passed (test)" and "ID checked [date], ID selfie and database (test)", masked number shown. Supervisor reveals with a reason and the audit is listed. Teller has no reveal control. "No thanks" goes to the counter path.

Add the new suites to the PR body's Validation list. All 6 required checks must be green: `browser-validate`, `browser-seam`, `server-validate`, `governance-docs-freshness`, `zones (Asia/Jerusalem)`, `zones (America/Toronto)`.

## 11. Screenshots

Every real screen PR 2 adds or changes, at 1280 and 390 wide, light and dark (4 shots per screen), plus scrolled 390 shots where content runs below the fold. Save them to `/opt/cursor/artifacts/` with names like `pr2-consent-1280-light.png`, and link each one in the PR body. Use only sandbox or fixture data. Never a real person's ID.
Screens: notice; consent (unticked); "No thanks" teller line; In person entry form (teller); tier chooser with the new names; tier 3 start or one-time link screen; Returning client confirm screen; the Returning client blocked state; each badge state in section 3 on the client file; masked number view (teller, no reveal control); reveal dialog with reasons (supervisor); reveal audit list (owner or CO); Quebec counter-only state; "Method not completed".
Persona's own hosted pages are not our screens. One sandbox evidence shot is fine, but it is not required.

## 12. Docs

Update `docs/PROJECT_STATE.md` and `docs/REPOSITORY_MAP.md` (the governance-docs-freshness check). Keep the line: "Persona 30-day redaction policy (images, selfies, facial geometry, including Accounts) must be on before any real customer check. CD-219, addendum 4.4."

## 13. Gates

1. Open a draft PR to `staging` and fill the PR checklist and body (Understanding, End state, Size, Validation, shots, Risk and rollback).
2. All 6 required checks green on the exact head.
3. Reviews, in order: CTO review, Compliance Officer (identity checks and record keeping), Data and Privacy Lead, Security Reviewer, QA Lead. Each grades the exact head SHA, and any new push needs a re-grade.
4. **Never merge**, and never mark ready on your own. Only the CTO merges, and each staging merge needs Sol's own yes. Nothing goes to `main` or live.

Don't do any of these: touch Render env or keys; promote to live; build CRA filing; send any email or message; start the face crop; build pricing or billing; touch PR 731, 732 or 734; use any denied exact-candidate validation route.

## Open questions (flagged, not guessed)

- **Q1. Tier numbering.** "Tiers 1 and 3" is read here as the code numbering (`1` = quick = Returning client, `3` = plus = ID, selfie and database), from `cdos-kyc.jsx` and `screening/routes.ts`. The Compliance and addendum tier list is unnumbered and starts with In person. Read in that order, tier 1 = In person and tier 3 = ID and selfie. The CEO relay doesn't say which. **Needs CEO or Sol to confirm.** The brief covers both risks: In person is built anyway (consent and Quebec need it), and tier 3 runs ID and selfie until the database step is confirmed.
- **Q2. What PR 722's check is.** PR 722 starts one shop template (`itmpl_AVBb88sxEE9tJDxDPrTh54H5WGbXtm`). It is not recorded whether that template is ID only or ID and selfie, or which tier it counts as. If it is ID only, Compliance says a remote "ID photo" check without a selfie is not valid.
- **Q3. Tier 3 template.** Does tier 3 need its own Persona sandbox template, and does tier 2 stay on 722's template? Sol sets templates in the Persona dashboard. The default here is an optional per-tier template id in shop settings.
- **Q4. Encryption key env var.** A new staging env var (suggested `ID_NUMBER_KEY`) is needed, and only Sol sets Render env. The staging walk fails closed until he does. Needs Sol (and Security on the name and key handling).
- **Q5. Reveal roles and reasons.** Compliance: "manager or supervisor, owner and named compliance officer". The code roles are `supervisor`, `branch_manager`, `compliance_officer`, `administrator`. Should any `compliance_officer` role reveal, or only the named CO (`legal_entities.compliance_officer_staff_id`)? Can `auditor` reveal? (Default here: no.) Memory says CD-233 adds an "Other" reason, but CD-233 is in stopped PR 731. Default here: the four listed reasons plus an optional note, with no "Other". Compliance to confirm.
- **Q6. "Never store images" vs the CD-219 face crop.** Sol approved (relayed by the D&P Lead, 15 Nov 10:31 and 10:34 pm, not his own words) a face crop kept 5 years for recognition by eye, and the approved consent sentence mentions it. The crop is unbuilt pending a lawyer. Returning client condition (c) checks the face "against the stored photo", and that photo doesn't exist for Persona checks yet. Default here: no crop, the sentence is dropped, and the by-eye check uses the original ID in hand. The desk's existing manual `client_photograph` and ID scans (`desk_client_images`) are untouched. PR 722's body says "this desk already keeps its own ID images" (manual scans). Needs Compliance and D&P to confirm this default for tier 1.
- **Q7. Quebec detection.** The server has no branch province field in idv or branch code (only on enquiries). How does PR 2 know a branch is in Quebec? Suggested default: a branch or legal entity province setting, where unknown means counter only (fail closed), with the staging test shop set to its real province. Needs CTO or Compliance.
- **Q8. Consent wording status.** The H3 and H4 text is a draft for counsel. "Lawyer wording" on biometric consent is still outstanding (CD-219), and only one sentence carries Sol's approval (relayed). Fine for sandbox. Not for real customers.
- **Q9. Deal link.** CD-263 needs a deal link, but the CAD 3,000 posting lock is PR 3. Default here: an append-only check-to-deal link table and server function, plus linking from the existing deal or quote screen where a check is started, without touching posting. PR 3 calls it at post. Does the CTO want PR 2 to touch posting at all?
- **Q10. DOB, address and occupation at CAD 3,000+.** Are these stored on the ID record (as Persona returns them) or on the client file or deal? Occupation is a teller entry, and CD-257 (occupation from 3,000) sits in stopped PR 731. Default here: store DOB and address from the ID on the record when present, and leave occupation to PR 3 or the client file.
- **Q11. Older manual ID numbers.** `desk_client_identity_documents.doc_number` is plaintext and returned in full to anyone with `customer:view`. That breaks "masked everywhere", but fixing it touches the client file broadly. Default here: out of scope for PR 2, file a ticket. Compliance and D&P to confirm.
- **Q12. Security residuals from 722.** Fail-closed runtime detection, unprefixed keys only in tests or a stub base, and one shared key assertion are folded into PR 2a, because PR 2 adds new outbound calls. The other parked P2 items (event and status in one transaction, webhook before `setProviderRef`, required `clientId`, the in-memory rate limit) are not in scope unless the CTO adds them.
- **Q13. Wording conflict.** The user asked to keep "Check passed (test)". Compliance's badge rule is "ID checked [date], [method]", and the draft addendum allows only that form for a completed check. The default here shows both (status line plus record line). Head of Design and Compliance to confirm.
- **Q14. Design source.** The v2.9 "Clients · KYC" design in `design/new-transaction-v2.9-2026-11-15/` belongs to the Exchange v2.9 work, which Sol stopped ("That's not the design file at all", 12:50 am Israel, 16 Nov, about PRs 731, 732 and 734). Default here: follow the existing client file styles, and don't use that design. Should Head of Design check the PR 2b screens before review?
- **Q15. Migration numbers on open PRs.** Sign-up PRs 715 to 727 already claim 075 to 080, which collides with staging's 075 to 077. QA's note that 731 "must move 074 to 078" collides with PR 720's 078. PR 2 takes the next free number above all of them. Someone should sort out the sign-up numbering.
