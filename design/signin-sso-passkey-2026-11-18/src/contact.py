#!/usr/bin/env python3
"""Rebuild the overview contact sheet from the latest stills.

Keeps the original composition (A, D, G at 1280 plus A at 390) and redraws
the date larger and darker so 2026 cannot be misread as 2024.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PNG = ROOT / "png"
FONTS = ROOT / "fonts"
OUT = PNG / "contact-sheet.png"

PAPER = (247, 244, 237)
INK = (23, 20, 15)
MUTE = (110, 103, 94)
GRAPH = (69, 64, 58)
HAIR = (217, 210, 196)
FAINT = (156, 148, 138)

# Measured from the first contact sheet (1962 x 548)
W, H = 1962, 548
FRAMES = [
    (PNG / "A-signin-1280.png", (56, 120, 592, 455), "A  Sign-in  ·  1280"),
    (PNG / "D-owner-confirm-1280.png", (621, 120, 1157, 455), "D  Owner confirm  ·  1280"),
    (PNG / "G-passkey-setup-1280.png", (1186, 120, 1722, 455), "G  Passkey setup  ·  1280"),
    (PNG / "A-signin-390.png", (1751, 120, 1905, 455), "A  Sign-in  ·  390"),
]

def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)

def main():
    im = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(im)

    kicker = font("IBMPlexMono-Medium.ttf", 11)
    title = font("InstrumentSerif-Regular.ttf", 36)
    date_f = font("IBMPlexMono-SemiBold.ttf", 16)
    cap_f = font("IBMPlexMono-Regular.ttf", 11)
    foot_f = font("IBMPlexMono-Regular.ttf", 11)

    # Kicker, title, date, rules — same positions as the original sheet
    draw.text((56, 40), "SIGN-IN   ·   PASSKEY AND SSO", font=kicker, fill=MUTE)
    draw.text((56, 62), "Open the desk", font=title, fill=INK)

    date = "18 Nov 2026"
    # Right-align to the same right edge as the last tile (1905)
    bbox = draw.textbbox((0, 0), date, font=date_f)
    dw = bbox[2] - bbox[0]
    # Vertically centre the date on the title x-height band (~68–97)
    date_x = 1905 - dw
    date_y = 70
    draw.text((date_x, date_y), date, font=date_f, fill=INK)

    # Hairline under the title, starting after the wordmark
    # Original rule ran nearly full width at y=108–109
    draw.line([(56, 108), (1906, 108)], fill=HAIR, width=1)
    draw.line([(56, 109), (1906, 109)], fill=HAIR, width=1)

    for src, box, _caption in FRAMES:
        x0, y0, x1, y1 = box
        inner = (x0 + 1, y0 + 1, x1, y1)
        tile = Image.open(src).convert("RGB")
        iw, ih = inner[2] - inner[0], inner[3] - inner[1]
        # Cover the inner box, centre-crop if aspect differs (phone is taller)
        scale = max(iw / tile.width, ih / tile.height)
        nw, nh = int(round(tile.width * scale)), int(round(tile.height * scale))
        tile = tile.resize((nw, nh), Image.Resampling.LANCZOS)
        cx = (nw - iw) // 2
        cy = (nh - ih) // 2
        tile = tile.crop((cx, cy, cx + iw, cy + ih))
        im.paste(tile, (inner[0], inner[1]))
        draw.rectangle([x0, y0, x1, y1], outline=HAIR, width=1)

    # Captions under tiles (original sat around y=470)
    # Use the original wording, measured left edges ~56, 621, 1186, 1751
    captions = [
        (56, "A   Sign-in  ·  1280"),
        (621, "D   Owner confirm  ·  1280"),
        (1186, "G   Passkey setup  ·  1280"),
        (1751, "A   Sign-in  ·  390"),
    ]
    for x, text in captions:
        draw.text((x, 468), text, font=cap_f, fill=GRAPH)

    # Footer rule and credit
    draw.line([(56, 512), (1906, 512)], fill=HAIR, width=1)
    draw.line([(56, 513), (1906, 513)], fill=HAIR, width=1)
    draw.text(
        (56, 522),
        "CurrencyDesk   ·   Existing Open the desk design, with Google, Microsoft and passkey.",
        font=foot_f,
        fill=MUTE,
    )

    im.save(OUT, "PNG")
    print("wrote", OUT, im.size)

if __name__ == "__main__":
    main()
