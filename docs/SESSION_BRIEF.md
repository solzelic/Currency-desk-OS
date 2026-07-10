# CurrencyDesk OS — Project Handoff / Session Brief

Give this whole file to a new AI session as context. It explains what the product is,
what's done, and what to tackle next.

---

## What this project is

**CurrencyDesk OS** — a full click-through prototype of an operating system for a
currency-exchange / money-services desk (rate board, ledger, transfers, cheques, client
KYC, compliance, till/vault cash, multi-branch, reports, module store). Buildless React
(Babel-in-browser), one `window.CDOS` global, files split by domain (`cdos-*.jsx`).

**Entry points:**
- `CurrencyDesk OS.html` — dev version (loads source `.jsx` files).
- `CurrencyDesk OS (standalone).html` — self-contained demo; rebuild this after any
  source change via the `super_inline_html` tool (input `CurrencyDesk OS.html`).
- `KYC Nudge States.html` — standalone reference page: every verification state, the
  pricing tiers, and a live playground. Has its own standalone build too.

**Full docs already written (read these first):**
- `design_handoff_kyc/README.md` — architecture, file map, how to run, KYC system explained.
- `design_handoff_kyc/BRAND.md` — colour/type/shape tokens.
- `design_handoff_kyc/MOTION.md` — every animation, exact CSS/keyframes.
- `design_handoff_kyc/WHOLESALE_MARKETPLACE.md` — the banknote-marketplace business exploration.

## Status: everything previously planned is DONE

The KYC verification system (the core IP of this prototype) is fully built and
consistent: three tiers (Quick $3.99 / Verified $6.99 / Verified Plus $14.99), the
amber→green badge ladder, the recommendation nudge (tier-aware, forcing vs. suggesting),
first-time gating, seeded demo clients spanning every state, the buried partner-code
discount, and the full brand/motion documentation. Nothing is queued right now.

## Open threads / good next moves (not yet started — pick based on priority)

1. **Wholesale banknote marketplace — move from concept to design.**
   `WHOLESALE_MARKETPLACE.md` has the full plan (order-money flow, revenue levers,
   phasing). Next step would be wireframing the actual screens (Vault reorder nudge,
   basket builder, quote comparison, receive/reconcile) — currently just written, not designed.

2. **Settings — expose KYC house parameters as real tweak-able fields.**
   `recheckDays` (180) and `reverifyDays` (365) and the high-risk→Plus escalation rule are
   hardcoded in `cdos-kyc.jsx`'s `VerificationNudge`. Wiring them into Settings → Compliance
   as editable fields was discussed but never built.

3. **Large-deal mandatory check threshold — confirm it's fully wired.**
   The "$10,000 → recommend/require Verify Plus" rule and the Settings toggle for
   "mandatory check even on verified profiles over $X" were discussed; double check
   `cdos-txmodal.jsx` + Settings → Compliance reflect the final intended logic before
   relying on it in a demo.

4. **Developer handoff → actual engineering kickoff.**
   The package is written and ready (`design_handoff_kyc/`). Next real step is a developer
   reading it and starting the production rebuild (real backend, real KYC provider API,
   real auth) per the "Rebuild notes" section of README.md.

5. **Business model validation.**
   Revenue estimates (desk count, KYC volume, banknote bps) were modeled in conversation
   but not written to a doc. If you want that written up formally (for a pitch deck or
   investor conversation), that's a fresh doc to create — ask the user for their actual
   client conversations/data first since the earlier estimates were rough.

## How to work in this project (quick reference)

- Edit `.jsx` source files directly, then rebuild the standalone with `super_inline_html`
  (input `CurrencyDesk OS.html` → output `CurrencyDesk OS (standalone).html`).
- Sign-in for testing: any staff ID (e.g. `a.singh`), any password, 2FA is pre-filled `000000`.
- Demo client data resets via Settings → Business → "Reset demo data", or clearing
  `localStorage` keys prefixed `cdos_`.
- Brand accent is `#2B50E2` (blue) — used for recommendations/selection only; the desk's
  base palette is ink-on-paper (see BRAND.md).
