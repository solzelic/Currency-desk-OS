#!/usr/bin/env python3
"""Render CurrencyDesk sign-in SSO/passkey frames at 1280 and 390."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "src" / "frames.html"
OUT = ROOT / "png"
OUT.mkdir(parents=True, exist_ok=True)

FRAMES = [
    ("A", "A-signin"),
    ("A2", "A2-email-password"),
    ("B", "B-passkey-waiting"),
    ("C", "C-no-passkey"),
    ("D", "D-owner-confirm"),
    ("E", "E-teller-pin"),
    ("F", "F-pick-shop"),
    ("G", "G-passkey-setup"),
    ("G2", "G-passkey-setup-success"),
    ("H", "H-settings-methods"),
]
SIZES = [("1280", 1280, 800), ("390", 390, 844)]

def main():
    uri = HTML.resolve().as_uri()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/bin/google-chrome")
        for key, name in FRAMES:
            for dev, w, h in SIZES:
                url = f"{uri}?f={key}&d={dev}"
                ctx = browser.new_context(
                    viewport={"width": w, "height": h},
                    device_scale_factor=2,
                )
                page = ctx.new_page()
                page.goto(url, wait_until="networkidle")
                page.evaluate("() => document.fonts.ready")
                page.wait_for_timeout(200)
                dest = OUT / f"{name}-{dev}.png"
                page.screenshot(path=str(dest), clip={"x": 0, "y": 0, "width": w, "height": h})
                print("wrote", dest.name)
                ctx.close()
        browser.close()
    print("done")

if __name__ == "__main__":
    main()
