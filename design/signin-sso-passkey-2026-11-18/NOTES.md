# Sign-in, SSO and passkey frames · 18 Nov 2026

Reused the existing Open the desk sign-in:
`/workspace/design/signin-artdirection-2026-11-10/signin.html`

Source HTML and render script: `src/frames.html`, `src/render.py`
PNGs (end state of the hairline): `png/`
Motion clips of frame A: `motion/`

## Hairline

The original source has a 1px ink slot, positioned in JS after fonts.ready:
left = dot.right + 20, width = target.left - (dot.right + 20),
top = dot.top + dot.height/2 - 0.5. No CSS keyframes exist in that source.

This set restores that geometry on every 1280 Open the desk frame (A to G2).
The right column is shifted so the connect target centres on the green dot,
which keeps titles above the line. 390 has no line (the source is desktop only).
H (settings) has no this composition and has no line.

## Animation (added here; not in the source)

One-shot only, not a loop.

- Line: `slotDraw`, scaleX 0 to 1 from the left, 720ms, cubic-bezier(0.22, 1, 0.32, 1), 300ms delay, forwards. Visibly complete around 730ms.
- Dot: `dotOnce`, scale 1 to 1.18 at 40% then back to 1, 560ms, same easing, 180ms delay, both fill. Peaks around 400ms.

Stills use `html.still` (line fully drawn, no animation). Motion recordings use `?still=0&hold=1`, then `window.startMotion()`.

No dark mode: the source design has none.

## Email step (18 Nov, after Sol's spacing note)

Default A and C show only the email field plus a secondary "Continue with email"
button. The password is not on the first step.

A2 opens the password under the email for every address. The filled example
`jordan@yorkfx.ca` is what they just typed, not a welcome-back or "we found
your account" state. Copy never hints whether an account exists.

Reveal: CSS grid-template-rows 0fr to 1fr plus opacity, 240ms,
cubic-bezier(0.22, 1, 0.32, 1). Email field stays put. Layout measures
`#form-core` (through the email field only) so the hairline does not jump.
`prefers-reduced-motion` and `html.still` turn the transition off.

"Sign in" sits inside the password field (14px/600, right of the eye) because
a second 56px button plus links would collide with the 1280 footer if the
title and hairline composition are kept. Recover sits on the footer hairline
on 1280 (about 0.5px).

## Spacing (8px grid)

Desktop: options inner 16px (row gap and passkey-to-row). Divider `.or`
margin 24px 0 (between groups, larger than inner 16). Email label-to-field
8px. Field-to-Continue / reveal padding-top 16px. Foot margin 16px, gap 8px.
Recover margin-top 8px.

Phone: left padding-top 12, h1 margin-top 8, sub margin-top 12, right
margin-top 16, or margin 16px 0, row gap 12 / margin-top 12.

Type, lockup, and hairline geometry are unchanged.

## Owner confirm (D) vs teller PIN (E)

D title: "Confirm with a passkey or the 6-digit code from your authenticator
app." Primary: Continue with a passkey. Secondary: Enter your 6-digit code.
Small link: Use a backup code. Not a PIN. E is still the teller PIN on a
shared counter.

## Motion (updated clip)

About 5 seconds at 30fps, A at 1280 and 390, MP4 plus GIF in `motion/`.
1280: hairline and one-shot dot, then Continue with email at 1700ms, password
opens at 1800ms. 390: no hairline, same one-shot dot plus the same reveal.

Contact sheet date: 18 Nov 2026. Overview: A, A2, D at 1280, plus A at 390.

## C at 390 (PR 807 height check)

C-390 fits in 390 by 844 with no scroll. Measured in the browser, no JS
shift needed: Recover bottom 763.6, footer starts 792, gap 28.4px.
scrollHeight 844. Same email step as A (password not shown). Phone
spacing matches A: left padding-top 12, h1 margin-top 8, sub margin-top
12, right margin-top 16, or margin 16px 0, row gap 12 / margin-top 12,
field-to-Continue padding-top 16, foot margin 16, recover margin-top 8.
