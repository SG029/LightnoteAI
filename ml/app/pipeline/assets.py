"""Builds the replacement object as an RGBA cut-out.

The strategy ladder, best first:

  1. gemini_keyframe      — Gemini's image model renders the replacement,
                            conditioned on a crop of the actual scene so the
                            lighting, colour temperature and camera angle
                            match. A user-supplied reference image is passed
                            in too, so the output is that product, harmonised
                            to this scene. Unavailable on a free API tier,
                            where the image models report a quota of zero.
  2. reference_composite  — the reference image is cut out and used directly.
                            No harmonisation, so it can look pasted on, but it
                            needs no image-generation quota. Preferred over
                            tier 3 whenever a reference exists: the user told
                            us exactly what they want, so generating something
                            approximate instead would be wrong.
  3. generated_composite  — Pollinations renders the replacement from text.
                            Keyless, so it works where tier 1 cannot, but it
                            sees no scene context and so cannot match lighting.
  4. (none)               — no asset; the caller falls back to removal only.

Every path ends at the same artifact: a tight RGBA cut-out. Compositing does
not care how it was produced, which is what keeps the ladder cheap.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ..config import settings
from ..gemini_client import GeminiError, call, extract_image, image_part
from ..schemas import EditPlan, Strategy
from . import pollinations
from .grounding import Grounding

log = logging.getLogger("lightedit.assets")

ASSET_INSTRUCTION = """
You produce isolated product images for a video compositing pipeline.

Render ONLY the requested object:
  • centred, filling most of the frame, nothing cropped off
  • on a plain flat white background
  • no shadows, no reflections, no surface it rests on, no other objects
  • photographic, not illustrated

The attached scene crop shows where this object will be composited. Match its
lighting direction, colour temperature, exposure and camera angle so the result
sits naturally in that scene. Do not copy the scene itself into the output.
""".strip()


@dataclass
class ReplacementAsset:
    """A cut-out ready to composite: BGR pixels plus an alpha channel."""

    bgr: np.ndarray
    alpha: np.ndarray
    path: Path
    strategy: Strategy

    @property
    def size(self) -> tuple[int, int]:
        return self.bgr.shape[1], self.bgr.shape[0]  # (w, h)


def _cutout(image_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Removes the background, returning (bgr, alpha) cropped to the subject."""
    try:
        from PIL import Image
        from rembg import remove
    except ImportError as exc:
        log.warning("rembg unavailable (%s) — falling back to threshold matting", exc)
        return _threshold_cutout(image_bgr)

    try:
        rgb = Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
        cut = remove(rgb)
        rgba = np.array(cut.convert("RGBA"))
    except Exception as exc:  # noqa: BLE001
        log.warning("rembg failed (%s) — falling back to threshold matting", exc)
        return _threshold_cutout(image_bgr)

    alpha = rgba[:, :, 3]
    if not alpha.any():
        return None

    bgr = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2BGR)
    return _crop_to_alpha(bgr, alpha)


def _threshold_cutout(image_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Matting fallback: assume a light, flat background and key it out.

    Only valid because every path that reaches here asked for a plain white
    background. It would be wrong on a photograph.
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Keep only the largest blob — drops speckle from JPEG noise.
    largest = max(contours, key=cv2.contourArea)
    alpha = np.zeros_like(mask)
    cv2.drawContours(alpha, [largest], -1, 255, thickness=cv2.FILLED)
    alpha = cv2.GaussianBlur(alpha, (5, 5), 0)

    return _crop_to_alpha(image_bgr, alpha)


def _crop_to_alpha(bgr: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Trims transparent margins so the asset's box maps onto the target's box."""
    ys, xs = np.where(alpha > 8)
    if len(ys) == 0:
        return None
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    return bgr[y1:y2, x1:x2], alpha[y1:y2, x1:x2]


def _scene_crop(keyframe: Path, grounding: Grounding, out_dir: Path) -> Path:
    """Crops the region around the target, with context, as lighting reference."""
    image = cv2.imread(str(keyframe))
    h, w = image.shape[:2]
    x1, y1, x2, y2 = grounding.box

    # 60% padding: enough surrounding scene to read the lighting, tight enough
    # that the object of interest still dominates.
    pad_x = int((x2 - x1) * 0.6)
    pad_y = int((y2 - y1) * 0.6)
    crop = image[max(0, y1 - pad_y) : min(h, y2 + pad_y), max(0, x1 - pad_x) : min(w, x2 + pad_x)]

    path = out_dir / "scene_context.png"
    cv2.imwrite(str(path), crop)
    return path


def _generate_with_gemini(
    plan: EditPlan,
    keyframe: Path,
    grounding: Grounding,
    ref_image: Path | None,
    out_dir: Path,
) -> np.ndarray | None:
    """Asks Gemini's image model for the replacement object."""
    context = _scene_crop(keyframe, grounding, out_dir)

    request = f"Render this object: {plan.replacement}"
    if ref_image is not None:
        request += (
            "\n\nThe second attached image is the exact product to render. "
            "Reproduce that product faithfully — its shape, branding and colours — "
            "while matching the lighting of the scene crop."
        )

    inputs: list[dict] = [
        {"type": "text", "text": request},
        image_part(context),
    ]
    if ref_image is not None:
        inputs.append(image_part(ref_image))

    interaction = call(
        model=settings.gemini_image_model,
        system_instruction=ASSET_INSTRUCTION,
        inputs=inputs,
        response_modalities=["image"],
        temperature=0.4,  # a little variation helps plausibility here
        attempts=2,
        label="asset generation",
    )

    data = extract_image(interaction)
    if not data:
        log.warning("Image model returned no image for %r", plan.replacement)
        return None

    raw_path = out_dir / "asset_raw.png"
    raw_path.write_bytes(data)

    return cv2.imread(str(raw_path))


def build(
    plan: EditPlan,
    keyframe: Path,
    grounding: Grounding,
    ref_image: Path | None,
    out_dir: Path,
) -> ReplacementAsset | None:
    """Walks the strategy ladder and returns the first asset that works."""
    out_dir.mkdir(parents=True, exist_ok=True)

    if plan.operation != "replace" or not plan.replacement:
        return None

    # ── Tier 1 ──────────────────────────────────────────────────────────
    try:
        generated = _generate_with_gemini(plan, keyframe, grounding, ref_image, out_dir)
        if generated is not None:
            cut = _cutout(generated)
            if cut is not None:
                bgr, alpha = cut
                path = out_dir / "asset.png"
                cv2.imwrite(str(path), np.dstack([bgr, alpha]))
                log.info("asset via gemini_keyframe, %dx%d", bgr.shape[1], bgr.shape[0])
                return ReplacementAsset(bgr, alpha, path, "gemini_keyframe")
            log.warning("Generated asset had no separable subject")
    except GeminiError as exc:
        log.warning("Gemini asset generation unavailable (%s)", exc)

    # ── Tier 2 ──────────────────────────────────────────────────────────
    if ref_image is not None:
        image = cv2.imread(str(ref_image))
        if image is not None:
            cut = _cutout(image)
            if cut is not None:
                bgr, alpha = cut
                path = out_dir / "asset.png"
                cv2.imwrite(str(path), np.dstack([bgr, alpha]))
                log.info("asset via reference_composite, %dx%d", bgr.shape[1], bgr.shape[0])
                return ReplacementAsset(bgr, alpha, path, "reference_composite")
        log.warning("Reference image could not be cut out")

    # ── Tier 3 ──────────────────────────────────────────────────────────
    data = pollinations.generate(pollinations.build_prompt(plan.replacement))
    if data:
        raw_path = out_dir / "asset_pollinations.png"
        raw_path.write_bytes(data)
        image = cv2.imread(str(raw_path))

        if image is not None:
            cut = _cutout(image)
            if cut is not None:
                bgr, alpha = cut
                path = out_dir / "asset.png"
                cv2.imwrite(str(path), np.dstack([bgr, alpha]))
                log.info("asset via generated_composite, %dx%d", bgr.shape[1], bgr.shape[0])
                return ReplacementAsset(bgr, alpha, path, "generated_composite")
            log.warning("Generated asset had no separable subject")

    # ── Tier 4 ──────────────────────────────────────────────────────────
    log.warning("No replacement asset could be built — job degrades to removal only")
    return None
