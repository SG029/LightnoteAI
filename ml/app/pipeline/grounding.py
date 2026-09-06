"""Stage 2 — locate the target object in a keyframe.

Uses Gemini rather than an open-vocabulary detector such as OWLv2 or
GroundingDINO. Those are CLIP-derived and ground generic categories well
("bottle") but degrade sharply on the brand-level targets this product is
actually asked for ("the Coca-Cola bottle"). Gemini carries that world
knowledge, and returns a polygon outline alongside the box, which gives the
tracker a far better prompt than a rectangle alone.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from ..config import settings
from ..gemini_client import GeminiError, call, extract_text, image_part

log = logging.getLogger("lightedit.grounding")

DETECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "detections": {
            "type": "array",
            "description": "Every instance of the requested target visible in the image.",
            "items": {
                "type": "object",
                "properties": {
                    "box_2d": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Bounding box as [ymin, xmin, ymax, xmax], each normalised to 0-1000.",
                    },
                    "mask": {
                        "type": "array",
                        "items": {"type": "array", "items": {"type": "integer"}},
                        "description": (
                            "Outline of the object as a closed polygon of [x, y] points, "
                            "each normalised to 0-1000. Follow the silhouette, not the box."
                        ),
                    },
                    "label": {"type": "string", "description": "What this instance is."},
                    "confidence": {
                        "type": "number",
                        "description": "0-1 confidence that this is the object the user asked about.",
                    },
                },
                "required": ["box_2d", "mask", "label", "confidence"],
            },
        }
    },
    "required": ["detections"],
}

SYSTEM_INSTRUCTION = """
You are an object grounding model for a video editing pipeline.

Given a video frame and a description of a target object, return the location
of every instance of that target.

Rules:
1. Coordinates are normalised to 0-1000 in both axes, regardless of the image's
   real pixel dimensions. box_2d is [ymin, xmin, ymax, xmax].
2. "mask" must trace the object's actual silhouette as a closed polygon. Use at
   least 12 points for anything non-rectangular. Do not just repeat the corners
   of the bounding box.
3. Set confidence honestly. If nothing in the image matches the description,
   return an empty detections array rather than guessing at the nearest object.
4. Match on visual identity, including brand and packaging cues where the
   description mentions them.
""".strip()


@dataclass
class Grounding:
    """A located target, in pixel coordinates for a specific frame size."""

    box: tuple[int, int, int, int]  # x1, y1, x2, y2
    polygon: np.ndarray | None      # (N, 2) int32 pixel coords, or None
    label: str
    confidence: float

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.box
        return max(0, x2 - x1) * max(0, y2 - y1)

    def to_mask(self, height: int, width: int) -> np.ndarray | None:
        """Rasterises the polygon to a binary mask, or None if unavailable."""
        if self.polygon is None or len(self.polygon) < 3:
            return None
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.fillPoly(mask, [self.polygon], 255)
        return mask

    def box_mask(self, height: int, width: int) -> np.ndarray:
        """Fallback mask: the filled bounding box."""
        mask = np.zeros((height, width), dtype=np.uint8)
        x1, y1, x2, y2 = self.box
        mask[y1:y2, x1:x2] = 255
        return mask


class TargetNotFound(RuntimeError):
    """The requested object is not visible in the sampled frames."""


def _denorm_box(box: list[int], width: int, height: int) -> tuple[int, int, int, int]:
    """[ymin, xmin, ymax, xmax] on a 0-1000 grid -> pixel (x1, y1, x2, y2)."""
    ymin, xmin, ymax, xmax = box[:4]
    x1 = int(round(xmin / 1000 * width))
    y1 = int(round(ymin / 1000 * height))
    x2 = int(round(xmax / 1000 * width))
    y2 = int(round(ymax / 1000 * height))

    # Models occasionally emit inverted or out-of-range corners.
    x1, x2 = sorted((max(0, min(x1, width)), max(0, min(x2, width))))
    y1, y2 = sorted((max(0, min(y1, height)), max(0, min(y2, height))))
    return x1, y1, x2, y2


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """IoU of two (x1, y1, x2, y2) boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _denorm_polygon(
    points: list[list[int]],
    width: int,
    height: int,
    box_px: tuple[int, int, int, int],
) -> np.ndarray | None:
    """Rasterisable polygon in pixel coordinates, or None if unusable.

    The model's point order is not dependable. `box_2d` is documented as
    y-first, and the polygon sometimes follows that convention and sometimes
    the [x, y] the schema asks for — on the same model, between frames. A
    silently transposed mask is a nasty failure: tracking still "succeeds",
    and the inpainter erases a rectangle of empty background.

    So the order is not trusted. Both readings are scored against `box_px`,
    which has a reliable order, and the better fit wins. If neither agrees
    with the box, the polygon is discarded and the caller falls back to the
    box mask.
    """
    raw = [p for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(raw) < 3:
        return None

    def build(x_index: int, y_index: int) -> np.ndarray:
        return np.array(
            [
                [
                    int(round(max(0, min(1000, p[x_index])) / 1000 * width)),
                    int(round(max(0, min(1000, p[y_index])) / 1000 * height)),
                ]
                for p in raw
            ],
            dtype=np.int32,
        )

    candidates = {"xy": build(0, 1), "yx": build(1, 0)}

    best_key, best_poly, best_iou = None, None, 0.0
    for key, poly in candidates.items():
        extent = (
            float(poly[:, 0].min()),
            float(poly[:, 1].min()),
            float(poly[:, 0].max()),
            float(poly[:, 1].max()),
        )
        score = _iou(extent, tuple(float(v) for v in box_px))  # type: ignore[arg-type]
        if score > best_iou:
            best_key, best_poly, best_iou = key, poly, score

    # 0.35 admits a polygon that traces the silhouette inside a looser box,
    # while rejecting one that landed somewhere else entirely.
    if best_poly is None or best_iou < 0.35:
        log.warning("polygon disagrees with box (best IoU %.2f) — using box mask", best_iou)
        return None

    if best_key == "yx":
        log.info("polygon points were [y, x]; corrected (IoU %.2f)", best_iou)

    return best_poly


def locate(
    frame_path: Path,
    target: str,
    hint: str | None = None,
    *,
    min_confidence: float = 0.3,
) -> Grounding:
    """Finds `target` in one frame, returning the best-matching instance."""
    image = cv2.imread(str(frame_path))
    if image is None:
        raise TargetNotFound(f"Could not read keyframe {frame_path.name}")
    height, width = image.shape[:2]

    request = f"Find: {target}"
    if hint:
        request += f"\nDisambiguator: {hint}"

    interaction = call(
        model=settings.gemini_text_model,
        system_instruction=SYSTEM_INSTRUCTION,
        inputs=[{"type": "text", "text": request}, image_part(frame_path)],
        response_schema=DETECTION_SCHEMA,
        label="grounding",
    )

    raw = extract_text(interaction)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GeminiError(f"Grounding returned unparseable JSON: {raw[:200]}") from exc

    detections = payload.get("detections") or []
    if not detections:
        raise TargetNotFound(
            f"Could not find \"{target}\" in the video. "
            f"Try describing it by appearance, or use a clip where it is clearly visible."
        )

    candidates: list[Grounding] = []
    for det in detections:
        box = det.get("box_2d")
        if not isinstance(box, list) or len(box) < 4:
            continue
        box_px = _denorm_box(box, width, height)
        grounding = Grounding(
            box=box_px,
            polygon=_denorm_polygon(det.get("mask") or [], width, height, box_px),
            label=str(det.get("label", target)),
            confidence=float(det.get("confidence", 0.0)),
        )
        # A zero-area box is a hallucinated detection, not a tiny object.
        if grounding.area > 0:
            candidates.append(grounding)

    if not candidates:
        raise TargetNotFound(f"Grounding returned no usable boxes for \"{target}\".")

    best = max(candidates, key=lambda g: (g.confidence, g.area))

    if best.confidence < min_confidence:
        raise TargetNotFound(
            f"\"{target}\" was not confidently found (best match {best.confidence:.0%}). "
            f"Try a clip where it is larger or less occluded."
        )

    log.info(
        "grounded %r as %r conf=%.2f box=%s polygon=%s",
        target, best.label, best.confidence, best.box,
        len(best.polygon) if best.polygon is not None else None,
    )
    return best


def locate_in_any(
    frame_paths: list[Path],
    target: str,
    hint: str | None = None,
) -> tuple[int, Path, Grounding]:
    """Tries several frames and returns the first confident hit.

    The first frame is a poor bet on its own: the object may be occluded,
    motion-blurred, or not yet on screen. Sampling across the clip makes
    tracking initialisation far more reliable, at the cost of extra API
    calls only when the early samples fail.

    Returns (position within `frame_paths`, that frame's path, grounding).
    """
    errors: list[str] = []

    for position, path in enumerate(frame_paths):
        try:
            return position, path, locate(path, target, hint)
        except TargetNotFound as exc:
            errors.append(str(exc))
            log.info("target not found in %s, trying next sample", path.name)
        except GeminiError:
            # A key or quota problem will not fix itself on the next frame.
            raise

    raise TargetNotFound(errors[-1] if errors else f"Could not find \"{target}\".")
