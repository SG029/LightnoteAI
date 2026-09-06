"""Renders a synthetic test clip — `npm run sample`.

Two jobs. It is the fallback when no suitable footage is at hand, and it lets
anyone who clones this repo try the pipeline immediately without sourcing a
video of their own.

The subject is a red soda can sliding across a desk. Deliberately simple and
high-contrast: an unambiguous target for grounding, a clean background for
inpainting to reconstruct, and steady motion so tracking has something real to
follow without being a stress test.

Output: storage/uploads/sample-can.mp4
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = ROOT / "storage" / "uploads" / "sample-can.mp4"

WIDTH, HEIGHT = 1280, 720
FPS = 24
DURATION_SEC = 4
FRAME_COUNT = FPS * DURATION_SEC

DESK_Y = 470  # where the desk surface meets the wall


def _backdrop() -> Image.Image:
    """Wall-and-desk background with a soft light falloff."""
    image = Image.new("RGB", (WIDTH, HEIGHT), (196, 188, 176))
    draw = ImageDraw.Draw(image)

    # Wall: vertical gradient, lighter at the top.
    for y in range(DESK_Y):
        t = y / DESK_Y
        shade = int(206 - 26 * t)
        draw.line([(0, y), (WIDTH, y)], fill=(shade, shade - 6, shade - 16))

    # Desk: warmer, darkening toward the foreground.
    for y in range(DESK_Y, HEIGHT):
        t = (y - DESK_Y) / max(1, HEIGHT - DESK_Y)
        draw.line([(0, y), (WIDTH, y)], fill=(int(150 - 34 * t), int(112 - 26 * t), int(74 - 18 * t)))

    draw.line([(0, DESK_Y), (WIDTH, DESK_Y)], fill=(96, 70, 46), width=3)

    # Wood grain, so the inpainter has real texture to reconstruct rather than
    # a flat fill it can trivially clone.
    rng = np.random.default_rng(7)
    pixels = np.array(image).astype(np.int16)
    grain = rng.normal(0, 4, (HEIGHT, WIDTH, 1)).astype(np.int16)
    pixels[DESK_Y:] = np.clip(pixels[DESK_Y:] + grain[DESK_Y:], 0, 255)
    image = Image.fromarray(pixels.astype(np.uint8))

    return image.filter(ImageFilter.GaussianBlur(0.4))


def _draw_can(canvas: Image.Image, cx: int, cy: int, height: int) -> None:
    """A red can with a white label band, drawn bottom-centred at (cx, cy)."""
    width = int(height * 0.42)
    left, right = cx - width // 2, cx + width // 2
    top, bottom = cy - height, cy

    draw = ImageDraw.Draw(canvas, "RGBA")

    # Contact shadow, drawn first so the can sits on top of it.
    draw.ellipse(
        [left - width // 3, bottom - 10, right + width // 3, bottom + 14],
        fill=(40, 26, 16, 110),
    )

    draw.rounded_rectangle([left, top, right, bottom], radius=width // 5, fill=(198, 26, 32))

    # Cylindrical shading: a bright column left of centre, dark edges.
    for i in range(width):
        t = i / max(1, width - 1)
        falloff = math.sin(math.pi * t)
        highlight = int(90 * (falloff ** 2.2))
        shade = int(58 * (1 - falloff))
        x = left + i
        draw.line(
            [(x, top + 4), (x, bottom - 4)],
            fill=(min(255, 198 + highlight - shade), 26 + highlight // 3, 32 + highlight // 3),
        )

    # Label band and lid.
    band_top = top + int(height * 0.36)
    draw.rectangle([left, band_top, right, band_top + int(height * 0.17)], fill=(242, 240, 236))
    draw.ellipse([left, top - 6, right, top + 12], fill=(178, 178, 182))
    draw.ellipse([left + 4, top - 3, right - 4, top + 9], fill=(206, 206, 210))


def render() -> Path:
    backdrop = _backdrop()
    temp_dir = Path(tempfile.mkdtemp(prefix="lightedit-sample-"))

    try:
        for index in range(FRAME_COUNT):
            t = index / (FRAME_COUNT - 1)
            frame = backdrop.copy()

            # Left to right, with a slight bob and a touch of scale change so
            # the tracker sees genuine motion rather than a static crop.
            cx = int(WIDTH * (0.22 + 0.56 * t))
            cy = DESK_Y + 6 + int(4 * math.sin(t * math.pi * 2))
            can_height = int(190 + 18 * math.sin(t * math.pi))

            _draw_can(frame, cx, cy, can_height)
            frame.save(temp_dir / f"{index:06d}.png")

        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-framerate", str(FPS),
                "-i", str(temp_dir / "%06d.png"),
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                str(OUT_PATH),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return OUT_PATH


if __name__ == "__main__":
    try:
        path = render()
    except FileNotFoundError:
        print("\n  ffmpeg is not on PATH. Install it first — see README \"Setup\".\n")
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        print(f"\n  ffmpeg failed:\n{exc.stderr}\n")
        sys.exit(1)

    size_mb = path.stat().st_size / 1_048_576
    print(f"\n  Sample clip written to:\n    {path}  ({size_mb:.1f} MB)\n")
    print("  Try it with a prompt like:")
    print('    "Replace the red soda can with a Pepsi can"')
    print('    "Remove the red can"\n')
