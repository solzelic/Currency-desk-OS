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
