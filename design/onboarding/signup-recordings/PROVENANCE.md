# Signup app recordings

Recorded by GPT6 Astra on 16 November 2026 in the isolated CD206 checkout,
application source b9cce394363c586a9080519f191b9ba1d517d9af plus the subsequent
frontend accessibility corrections. These replace the frozen prototype clips;
the frozen files and their original provenance remain unchanged.

Each clip uses the actual /app shell, real authenticated synthetic tenant and
local owned PostgreSQL database. No app/API response is mocked in recording.
The account was provisioned through the real signup activation with an explicitly
mocked Stripe SetupIntent: this proves no live Stripe, bank or OIDC acceptance.
Names, shop, rates and records are synthetic. Global market rows are test fixtures,
not a live market-feed claim. The Home clip embeds the real session-gated signup
Home in a framing-only HTML harness; it is not returning-login Home.

At 1200×750, recordings show Home, Rates/Board, Rates/Website & Window,
Rates/Cost & stock, Settings/Compliance, Dashboard, Rates/currency selection,
and Settings/Cash on hand. Videos are silent VP8 WebM, trimmed to the last six
seconds of the corresponding app interaction, without invented frames or data.
PNG stills come from the same session and panel. Product captions identify the
synthetic recording; HTML deal/report illustrations remain distinct from clips.

Raw recording logs, raw WebMs and session-free screenshots are under this
reviewer's ignored test-results/integrated-review/real-recordings/. Session
cookies are local 0600 test evidence and are not part of these assets.

Re-record against a fresh synthetic signup and owned disposable local database
when the app changes. Do not record customer accounts, external credentials,
or a live charge. Reduced-motion users see the PNG and manually advance the
same tour; motion playback must never override that preference.
