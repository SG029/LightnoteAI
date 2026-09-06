"""Stage 5 — composite the replacement asset onto the clean plate.

The asset is rendered once and then *tracked*, rather than re-generated per
frame. That is the central design decision of this pipeline: a per-frame
generative edit has no notion of the previous frame, so the object's identity
drifts and the result strobes. Placing one fixed asset along a tracked path
is temporally stable by construction.

The trade-off is honest and documented: the asset does not re-light, re-pose,
or rotate with the scene. It is a 2D billboard following a 2D path. For a
handheld bottle on a table that reads fine; for an object that turns to show
another face, it does not.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .assets import ReplacementAsset

log = logging.getLogger("lightedit.compose")

ProgressCb = Callable[[float, str | None], None]

# Window for smoothing the target box across frames. Per-frame mask boxes
# wobble by a few pixels even on a static object; without smoothing the
# composited asset visibly vibrates.
SMOOTH_WINDOW = 5

# Feathering the asset's alpha hides the hard cut-out edge against the plate.
FEATHER_PX = 3


def _mask_boxes(mask_paths: list[Path]) -> list[tuple[int, int, int, int] | None]:
    """Per-frame bounding box of the tracked mask; None where the mask is empty."""
    boxes: list[tuple[int, int, int, int] | None] = []
    for path in mask_paths:
        mask = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if mask is None or not mask.any():
            boxes.append(None)
            continue
        ys, xs = np.where(mask > 127)
        boxes.append((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    return boxes


def _smooth(boxes: list[tuple[int, int, int, int] | None]) -> list[tuple[int, int, int, int] | None]:
    """Moving-average filter over present boxes, leaving gaps untouched."""
    smoothed: list[tuple[int, int, int, int] | None] = []
    half = SMOOTH_WINDOW // 2

    for index, box in enumerate(boxes):
        if box is None:
            smoothed.append(None)
            continue

        window = [
            b
            for b in boxes[max(0, index - half) : index + half + 1]
            if b is not None
        ]
        if not window:
            smoothed.append(box)
            continue

        stacked = np.array(window, dtype=np.float32).mean(axis=0)
        smoothed.append(tuple(int(round(v)) for v in stacked))  # type: ignore[arg-type]

    return smoothed


def _fit(asset: ReplacementAsset, box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Places the asset inside the target box, preserving its aspect ratio.

    Fitted by height and bottom-aligned: replacement objects usually rest on
    the same surface the original did, so matching the base line matters more
    than centring. Squashing to the box exactly would distort the product.
    """
    x1, y1, x2, y2 = box
    target_h = max(1, y2 - y1)
    aspect = asset.bgr.shape[1] / max(1, asset.bgr.shape[0])

    new_h = target_h
    new_w = max(1, int(round(target_h * aspect)))

    cx = (x1 + x2) // 2
    left = cx - new_w // 2
    bottom = y2

    return left, bottom - new_h, left + new_w, bottom


def _harmonise(patch: np.ndarray, backdrop: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Nudges the asset's brightness toward its surroundings.

    A cheap luminance match, not full colour transfer: it corrects an asset
    that is obviously brighter or darker than the plate it lands on, which is
    the most noticeable compositing artifact, without risking a colour cast
    that would ruin an otherwise good render.
    """
    if not alpha.any():
        return patch

    subject = alpha > 32
    if subject.sum() < 16:
        return patch

    patch_lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
    back_lab = cv2.cvtColor(backdrop, cv2.COLOR_BGR2LAB).astype(np.float32)

    patch_l = patch_lab[:, :, 0][subject]
    back_l = back_lab[:, :, 0]

    delta = float(np.median(back_l) - np.median(patch_l))
    # Only a partial correction, and clamped — the asset should still read as
    # its own object, not be dragged to the background's average.
    delta = float(np.clip(delta * 0.5, -25, 25))

    patch_lab[:, :, 0] = np.clip(patch_lab[:, :, 0] + delta, 0, 255)
    return cv2.cvtColor(patch_lab.astype(np.uint8), cv2.COLOR_LAB2BGR)


def composite(
    plates: list[Path],
    mask_paths: list[Path],
    asset: ReplacementAsset,
    out_dir: Path,
    progress: ProgressCb,
) -> list[Path]:
    """Places the asset on every frame, following the tracked mask."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.png"):
        stale.unlink()

    boxes = _smooth(_mask_boxes(mask_paths))
    total = len(plates)
    outputs: list[Path] = []
    placed = 0

    for index, plate_path in enumerate(plates):
        frame = cv2.imread(str(plate_path))
        if frame is None:
            raise RuntimeError(f"Could not read clean plate {plate_path.name}")

        box = boxes[index]
        if box is not None:
            frame = _place(frame, asset, box)
            placed += 1

        out_path = out_dir / f"{index:06d}.png"
        cv2.imwrite(str(out_path), frame)
        outputs.append(out_path)
        progress((index + 1) / total, f"frame {index + 1}/{total}")

    log.info("composited asset onto %d/%d frames", placed, total)
    return outputs


def _place(frame: np.ndarray, asset: ReplacementAsset, box: tuple[int, int, int, int]) -> np.ndarray:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = _fit(asset, box)

    dest_w, dest_h = x2 - x1, y2 - y1
    if dest_w < 2 or dest_h < 2:
        return frame

    # INTER_AREA when shrinking preserves detail far better than INTER_LINEAR,
    # and the asset is almost always larger than its slot.
    interp = cv2.INTER_AREA if dest_w < asset.bgr.shape[1] else cv2.INTER_CUBIC
    scaled_bgr = cv2.resize(asset.bgr, (dest_w, dest_h), interpolation=interp)
    scaled_alpha = cv2.resize(asset.alpha, (dest_w, dest_h), interpolation=interp)

    if FEATHER_PX > 0:
        k = FEATHER_PX * 2 + 1
        scaled_alpha = cv2.GaussianBlur(scaled_alpha, (k, k), 0)

    # Clip against the frame edges — the asset can legitimately overhang.
    sx1, sy1 = max(0, -x1), max(0, -y1)
    dx1, dy1 = max(0, x1), max(0, y1)
    dx2, dy2 = min(w, x2), min(h, y2)

    if dx2 <= dx1 or dy2 <= dy1:
        return frame

    patch = scaled_bgr[sy1 : sy1 + (dy2 - dy1), sx1 : sx1 + (dx2 - dx1)]
    alpha = scaled_alpha[sy1 : sy1 + (dy2 - dy1), sx1 : sx1 + (dx2 - dx1)]
    backdrop = frame[dy1:dy2, dx1:dx2]

    if patch.shape[:2] != backdrop.shape[:2]:
        return frame

    patch = _harmonise(patch, backdrop, alpha)

    a = (alpha.astype(np.float32) / 255.0)[:, :, None]
    frame[dy1:dy2, dx1:dx2] = (patch * a + backdrop * (1 - a)).astype(np.uint8)
    return frame


def mask_preview(frame_path: Path, mask_path: Path, out_path: Path) -> Path:
    """Renders a mask overlay for the UI.

    Worth its keep twice over: it is the fastest way to diagnose a bad result
    (wrong object tracked? mask too tight?), and it is the frame that proves to
    a viewer that real segmentation happened rather than a filter.
    """
    frame = cv2.imread(str(frame_path))
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if frame is None or mask is None:
        raise RuntimeError("Could not build mask preview")

    overlay = frame.copy()
    overlay[mask > 127] = (255, 90, 40)  # BGR — cyan-ish against most footage
    blended = cv2.addWeighted(overlay, 0.45, frame, 0.55, 0)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(blended, contours, -1, (255, 220, 120), 2)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), blended)
    return out_path
