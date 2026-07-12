# Saily MSB Workspace — Prototype Package

## What's in here

**`index.html`** — The deployable version.
Single self-contained file. No build step, no npm install. Open it directly in
a browser, or drag-and-drop it onto Vercel/Netlify and it's live in minutes.
This is the one to actually deploy.

Includes:
- Public marketing site (services, live rate strip, about section)
- Staff login at the bottom of the page, scrolls into the app
- Simulated 2FA (demo code: 418302)
- Full back-office workspace: ledger, clients/KYC, dashboard, day close, audit log, settings
- Floating draggable calculator window
- Structuring detection (rolling 7-day client totals vs $10k threshold)
- Single-transaction reportable flag (≥$10k)
- KYC gate with optional ID photo upload
- Append-only audit trail
- Owner settings: toggle teller permissions, require-ID-photo, structuring window
- Printable receipts

**`msb-ledger.jsx`** — Same app as a React component, for use in a normal
React build pipeline (Vite/Next/CRA) if you want it inside a larger codebase
later. Functionally identical to index.html, just without the public site
wrapper and without the inline CDN script tags.

## How to actually deploy this week

1. Sign up: Vercel (hosting), Supabase (database/auth — not wired in yet),
   Cloudflare (domain).
2. Drop `index.html` straight into a new Vercel project. It's live immediately
   at a `.vercel.app` URL.
3. Point a real domain at it via Cloudflare DNS once you've got a client.

## What's real vs. mocked — read this before showing anyone real data

This is a sales/demo prototype. Specifically fake:
- **Auth** — any username/password works, the "SMS code" is printed on screen
  instead of texted
- **Storage** — everything lives in browser memory; refresh and it's gone
- **Rates** — hardcoded, not pulled from a live feed
- **SMS compliance alerts** — not implemented, this is UI/logic only

Before a single real MSB transaction goes in here, the data layer needs to be
swapped for: Supabase (or similar) with Row Level Security per business_id,
real auth, Twilio for SMS, and a real rate feed. That backend work is the
actual hard/important part — this file is the front end and the behavior spec.

## Pricing model this was built around (for reference)
- Website build: $3,500 one-time
- Tier 1 (rates only): $250–299/mo
- Tier 2 (full backend): $500–749/mo
- Tier 3 (+ AI features, not yet built): $750–999/mo
- First year paid in full at signing, monthly thereafter

— Built by Saily
