#!/usr/bin/env python3
"""Record the one-shot hairline + dot animation on frame A at 1280 and 390.

Drives CSS animation currentTime so the clip is exact, not wall-clock bound.
"""
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "src" / "frames.html"
OUT = ROOT / "motion"
OUT.mkdir(parents=True, exist_ok=True)

FPS = 30
DURATION_MS = 3700
SIZES = [
    ("1280", 1280, 800),
    ("390", 390, 844),
]

def ffmpeg(*args):
    cmd = ["/usr/bin/ffmpeg", "-y", *args]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg failed: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r

def frames_to_mp4_gif(frame_dir: Path, stem: str, w: int, h: int):
    pattern = str(frame_dir / "f_%04d.png")
    mp4 = OUT / f"{stem}.mp4"
    gif = OUT / f"{stem}.gif"
    vw, vh = w if w % 2 == 0 else w - 1, h if h % 2 == 0 else h - 1
    ffmpeg(
        "-framerate", str(FPS),
        "-i", pattern,
        "-vf", f"scale={vw}:{vh}:flags=lanczos,fps={FPS}",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "16",
        "-movflags", "+faststart",
        str(mp4),
    )
    palette = frame_dir / "palette.png"
    gw, gh = vw // 2, vh // 2
    ffmpeg(
        "-i", str(mp4),
        "-vf", f"fps=20,scale={gw}:{gh}:flags=lanczos,palettegen=stats_mode=full",
        str(palette),
    )
    ffmpeg(
        "-i", str(mp4),
        "-i", str(palette),
        "-lavfi", f"fps=20,scale={gw}:{gh}:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a",
        "-loop", "0",
        str(gif),
    )
    print("wrote", mp4, mp4.stat().st_size, "and", gif, gif.stat().st_size)

def capture(page, frame_dir: Path, w: int, h: int):
    page.evaluate(
        """() => {
          window.startMotion();
          const freeze = () => {
            for (const a of document.getAnimations()) {
              a.pause();
            }
          };
          // Pause on the next frame once the animations exist.
          requestAnimationFrame(() => requestAnimationFrame(freeze));
        }"""
    )
    page.wait_for_timeout(50)
    n = int(round(DURATION_MS * FPS / 1000))
    for i in range(n):
        t = i * 1000 / FPS
        page.evaluate(
            """(t) => {
              const anims = document.getAnimations();
              if (!anims.length) {
                window.startMotion();
              }
              for (const a of document.getAnimations()) {
                a.currentTime = t;
                a.pause();
              }
            }""",
            t,
        )
        dest = frame_dir / f"f_{i:04d}.png"
        page.screenshot(path=str(dest), clip={"x": 0, "y": 0, "width": w, "height": h})

def main():
    uri = HTML.resolve().as_uri()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for dev, w, h in SIZES:
            url = f"{uri}?f=A&d={dev}&still=0&hold=1"
            ctx = browser.new_context(
                viewport={"width": w, "height": h},
                device_scale_factor=2,
            )
            page = ctx.new_page()
            page.goto(url, wait_until="networkidle")
            page.evaluate("() => document.fonts.ready")
            page.wait_for_timeout(250)
            with tempfile.TemporaryDirectory(prefix=f"motion-A-{dev}-") as td:
                td = Path(td)
                print(f"capturing A-{dev}…")
                capture(page, td, w, h)
                frames_to_mp4_gif(td, f"A-signin-{dev}", w * 2, h * 2)
            ctx.close()
        browser.close()
    print("done")

if __name__ == "__main__":
    main()
