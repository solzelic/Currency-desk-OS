# Sign in v2.3 reference fixtures

The supplied 15 November 2026 pack's `reference/prototype/index.html` is copied
byte-for-byte to `prototype.html` (SHA-256
`9f59182e10a6e817d39314714921b05e15a08acb9349937a6c995929632164cf`).
The twenty supplied JSON files are unchanged. `font-sha256.json` pins the 23
original font binaries already in `web/fonts`, plus the existing stylesheet;
its only difference from the original stylesheet is `./` URLs rebased to
`/web/fonts/`.

These are test inputs, not application sources. The server refuses this path.
Playwright intercepts a separate reference origin and only replays the five
first/password states. It blocks other network requests. Prototype success,
password and provider simulations must never enter the production lifecycle.

Geometry is compared with the frozen prototype in the same browser and OS, at
1px tolerance and the previously documented exceptions. Text and computed
styles still compare with the supplied JSON. Neither the original nor candidate
measurements are automatically blessed as a new baseline. Failed comparisons
retain both versions' PNG/JSON attachments for review. Original captures remain
the design evidence; this reference replay is a portable geometry oracle.

The prototype computes its desktop/laptop hero's vertical margin before web
fonts load. That margin depends on the operating system's fallback fonts. For
first-screen “Sign in”, “Open desk” and “the”, the asserted y position therefore
remains the supplied JSON value at 1px tolerance. Their x, width and height use
the same-browser replay; no box check is dropped. The existing complete-ID
exception for the omitted, unverified shop line remains unchanged. Tests also
assert the actual viewport equals the supplied JSON viewport. Candidate PNG/JSON
is attached before overflow, viewport and reference-hash assertions; reference
evidence is attached after the fixture passes integrity checks.
