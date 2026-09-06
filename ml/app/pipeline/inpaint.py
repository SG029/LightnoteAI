"""Stage 4 — erase the tracked object and reconstruct the background.

LaMa (Large Mask Inpainting) is used rather than a diffusion inpainter for two
reasons. It is a single feed-forward pass, so it runs in tens of milliseconds
per frame instead of tens of seconds; and it is deterministic, so consecutive
frames reconstruct the same background the same way. A diffusion model samples
independently per frame, which produces a background that visibly boils.

The output of this stage — the "clean plate" — is the final result for a
removal job, and the canvas the replacement is composited onto otherwise.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from . import lama

log = logging.getLogger("lightedit.inpaint")

ProgressCb = Callable[[float, str | None], None]

# Masks are dilated before inpainting. An exactly-fitting mask leaves a halo of
# the original object's edge pixels — anti-aliased boundary, colour fringing,
# contact shadow — which the inpainter then treats as background to preserve.
DILATE_PX = 7


def _dilate(mask: np.ndarray, px: int = DILATE_PX) -> np.ndarray:
    if px <= 0:
        return mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (px * 2 + 1, px * 2 + 1))
    return cv2.dilate(mask, kernel, iterations=1)


def inpaint_frame(frame_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Removes the masked region from a single frame."""
    if not mask.any():
        return frame_bgr

    dilated = _dilate(mask)

    if lama.available():
        try:
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            filled = lama.inpaint(rgb, dilated)
            if filled is not None:
                return cv2.cvtColor(filled, cv2.COLOR_RGB2BGR)
        except Exception as exc:  # noqa: BLE001 — one bad frame must not kill the render
            log.warning("LaMa failed on a frame (%s) — using Telea for it", exc)

    # Classical fallback. Blurrier, but structurally sound for small regions.
    return cv2.inpaint(frame_bgr, dilated, inpaintRadius=3, flags=cv2.INPAINT_TELEA)


def clean_plate(
    frames: list[Path],
    masks: list[Path],
    out_dir: Path,
    progress: ProgressCb,
) -> list[Path]:
    """Runs inpainting across every frame, writing the object-free plates."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.png"):
        stale.unlink()

    total = len(frames)
    outputs: list[Path] = []

    for index, (frame_path, mask_path) in enumerate(zip(frames, masks)):
        frame = cv2.imread(str(frame_path))
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)

        if frame is None:
            raise RuntimeError(f"Could not read frame {frame_path.name}")
        if mask is None:
            mask = np.zeros(frame.shape[:2], dtype=np.uint8)

        # Binarise: masks are written as 0/255 but survive a JPEG round trip
        # in some paths, and a soft edge here would smear the inpaint.
        _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

        result = inpaint_frame(frame, mask)

        out_path = out_dir / f"{index:06d}.png"
        cv2.imwrite(str(out_path), result)
        outputs.append(out_path)

        progress((index + 1) / total, f"frame {index + 1}/{total}")

    return outputs
