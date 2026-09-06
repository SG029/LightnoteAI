"""Stage 3 — segment the target and track it across every frame.

This is the temporal backbone of the pipeline. Grounding gives us the object
in *one* frame; this stage turns that into a per-frame mask.

Two backends, tried in order:

  1. SAM 2 (`Sam2VideoModel`) — a video model with streaming memory, so the
     mask stays attached to the object through motion, rotation and partial
     occlusion. This is the one we want.
  2. OpenCV CSRT — a classical correlation-filter box tracker, with the
     grounding polygon warped along to approximate a mask. Markedly worse on
     deformation and occlusion, but it needs no weights and no GPU, so the
     product still works on a machine where SAM 2 cannot load.

Masks are written to disk as PNGs rather than held in memory: a 15s 720p clip
is ~450 frames, and keeping every full-resolution mask resident costs several
hundred megabytes for no benefit, since later stages read them one at a time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from ..config import resolve_device, settings
from .grounding import Grounding

log = logging.getLogger("lightedit.segment")

ProgressCb = Callable[[float, str | None], None]

# hiera-small is the accuracy/VRAM sweet spot on a 6GB card. "tiny" fits more
# comfortably if VRAM is tight; "large" needs headroom this project cannot assume.
SAM2_CHECKPOINT = "facebook/sam2.1-hiera-small"

# Frames per tracking session. The processor batches a whole session through
# resize/rescale/normalize at 1024², so peak memory scales with this number,
# not with clip length. 12 keeps each transient copy near 150MB, which matters
# on Windows hosts where the commit limit — not physical RAM — is the ceiling.
CHUNK_FRAMES = 12

_sam2_cache: tuple[object, object] | None = None


@dataclass
class TrackResult:
    mask_paths: list[Path]
    backend: str
    coverage: float  # fraction of frames where a non-empty mask was produced


class TrackingError(RuntimeError):
    """Neither tracking backend could follow the object."""


# ── SAM 2 ────────────────────────────────────────────────────────────────


def _load_sam2():
    """Loads SAM 2 once and keeps it resident across jobs.

    Model load is ~10s and dominated by weight I/O; reloading it per job would
    add that to every render for no reason. Returns None if unavailable, which
    is the signal to fall back.
    """
    global _sam2_cache
    if _sam2_cache is not None:
        return _sam2_cache

    try:
        import torch
        from transformers import Sam2VideoModel, Sam2VideoProcessor
    except ImportError as exc:
        log.warning("SAM 2 unavailable (%s) — falling back to OpenCV tracking", exc)
        return None

    device = resolve_device()
    try:
        model = Sam2VideoModel.from_pretrained(SAM2_CHECKPOINT).to(device)
        model.eval()
        processor = Sam2VideoProcessor.from_pretrained(SAM2_CHECKPOINT)
    except Exception as exc:  # noqa: BLE001 — network, disk, or VRAM
        log.warning("Could not load %s (%s) — falling back to OpenCV", SAM2_CHECKPOINT, exc)
        return None

    log.info("SAM 2 loaded on %s", device)
    _sam2_cache = (model, processor)
    return _sam2_cache


def _mask_box(mask: np.ndarray | None) -> tuple[int, int, int, int] | None:
    """Tight bounding box of a binary mask, or None if it is empty."""
    if mask is None or not mask.any():
        return None
    ys, xs = np.where(mask > 127)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _run_chunk(
    model,
    processor,
    frame_paths: list[Path],
    seed_local_idx: int,
    box: tuple[int, int, int, int],
    device: str,
) -> dict[int, np.ndarray]:
    """Tracks one chunk from a box prompt. Returns {local index: mask}."""
    import gc

    import torch
    from PIL import Image

    images = [Image.open(p).convert("RGB") for p in frame_paths]

    session = processor.init_video_session(
        video=images,
        inference_device=device,
        # Decoded frames live in system RAM; only the working window is on GPU.
        video_storage_device="cpu",
        processing_device="cpu",
        dtype=torch.float32,
    )

    x1, y1, x2, y2 = box
    processor.add_inputs_to_inference_session(
        inference_session=session,
        frame_idx=seed_local_idx,
        obj_ids=1,
        input_boxes=[[[float(x1), float(y1), float(x2), float(y2)]]],
    )

    # Order matters: original_sizes is (height, width). Passing it the other
    # way round silently returns a transposed mask rather than an error.
    original_sizes = [[session.video_height, session.video_width]]
    out: dict[int, np.ndarray] = {}

    def harvest(output) -> None:
        masks = processor.post_process_masks(
            [output.pred_masks], original_sizes=original_sizes, binarize=False
        )[0]
        # (objects, 1, H, W) logits -> one binary mask at threshold 0.
        out[output.frame_idx] = (masks[0, 0] > 0).cpu().numpy().astype(np.uint8) * 255

    try:
        with torch.inference_mode():
            for output in model.propagate_in_video_iterator(session, start_frame_idx=seed_local_idx):
                harvest(output)
            if seed_local_idx > 0:
                for output in model.propagate_in_video_iterator(
                    session, start_frame_idx=seed_local_idx, reverse=True
                ):
                    harvest(output)
    finally:
        # Sessions hold the whole chunk's features. Releasing between chunks is
        # what keeps peak memory flat instead of growing with clip length.
        del session, images
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()

    return out


def _track_sam2(
    frames: list[Path],
    init_idx: int,
    grounding: Grounding,
    masks_dir: Path,
    progress: ProgressCb,
) -> TrackResult | None:
    """Tracks the object across the clip in bounded-memory chunks.

    SAM 2's processor normalises an entire session's frames in one batch —
    96 frames at 1024² float32 is a 1.2GB allocation, and the transient copies
    during resize/rescale/normalize stack several times that. It OOMs a 6GB
    card, and moving preprocessing to CPU only relocates the failure.

    So the clip is tracked in chunks. Each chunk after the first is re-seeded
    from the bounding box of the previous chunk's final mask, which costs one
    frame of drift at each boundary but keeps peak memory flat regardless of
    clip length. Box prompts are used for re-seeding rather than mask prompts
    because the box coordinate convention is verified and unambiguous.
    """
    loaded = _load_sam2()
    if loaded is None:
        return None

    model, processor = loaded
    device = resolve_device()
    total = len(frames)
    collected: dict[int, np.ndarray] = {}

    def note_progress() -> None:
        progress(len(collected) / max(1, total), f"frame {len(collected)}/{total}")

    try:
        bounds: list[tuple[int, int]] = []
        start = 0
        while start < total:
            end = min(total, start + CHUNK_FRAMES)
            bounds.append((start, end))
            start = end

        seed_chunk = next(i for i, (a, b) in enumerate(bounds) if a <= init_idx < b)

        # ── the chunk holding the grounded frame, from the real box ──
        a, b = bounds[seed_chunk]
        for local, mask in _run_chunk(
            model, processor, frames[a:b], init_idx - a, grounding.box, device
        ).items():
            collected[a + local] = mask
        note_progress()

        # ── forward ──
        carry = _mask_box(collected.get(b - 1))
        for index in range(seed_chunk + 1, len(bounds)):
            if carry is None:
                log.warning("object lost at chunk %d — later frames left unmasked", index)
                break
            a2, b2 = bounds[index]
            chunk = _run_chunk(model, processor, frames[a2:b2], 0, carry, device)
            for local, mask in chunk.items():
                collected[a2 + local] = mask
            note_progress()
            carry = _mask_box(collected.get(b2 - 1))

        # ── backward ──
        carry = _mask_box(collected.get(a))
        for index in range(seed_chunk - 1, -1, -1):
            if carry is None:
                log.warning("object lost going backwards at chunk %d", index)
                break
            a2, b2 = bounds[index]
            chunk = _run_chunk(model, processor, frames[a2:b2], b2 - a2 - 1, carry, device)
            for local, mask in chunk.items():
                collected[a2 + local] = mask
            note_progress()
            carry = _mask_box(collected.get(a2))

    except Exception as exc:  # noqa: BLE001 — fall back rather than fail the job
        log.warning("SAM 2 tracking failed (%s) — falling back to OpenCV", exc, exc_info=True)
        return None

    if not collected:
        return None

    paths = _write_masks(collected, frames, masks_dir)
    coverage = sum(1 for m in collected.values() if m.any()) / total
    return TrackResult(mask_paths=paths, backend="sam2", coverage=coverage)


# ── OpenCV fallback ──────────────────────────────────────────────────────


def _track_opencv(
    frames: list[Path],
    init_idx: int,
    grounding: Grounding,
    masks_dir: Path,
    progress: ProgressCb,
) -> TrackResult:
    """CSRT box tracking with the grounding polygon carried along.

    The polygon is translated and scaled to follow the box rather than being
    re-estimated per frame — there is no segmentation model here, so the shape
    is assumed roughly rigid. Good enough to erase a bottle on a table; it will
    not survive the object turning around.
    """
    first = cv2.imread(str(frames[init_idx]))
    if first is None:
        raise TrackingError(f"Could not read frame {frames[init_idx].name}")
    height, width = first.shape[:2]

    seed_mask = grounding.to_mask(height, width)
    if seed_mask is None:
        seed_mask = grounding.box_mask(height, width)

    x1, y1, x2, y2 = grounding.box
    seed_box = (x1, y1, max(1, x2 - x1), max(1, y2 - y1))

    def make_tracker():
        # The class moved between OpenCV versions and builds.
        for factory in ("TrackerCSRT_create", "TrackerKCF_create"):
            if hasattr(cv2, factory):
                return getattr(cv2, factory)()
            legacy = getattr(cv2, "legacy", None)
            if legacy is not None and hasattr(legacy, factory):
                return getattr(legacy, factory)()
        raise TrackingError(
            "No OpenCV tracker available. Install opencv-contrib-python, or "
            "resolve the SAM 2 installation for much better results."
        )

    collected: dict[int, np.ndarray] = {}

    def warp_to(box: tuple[int, int, int, int]) -> np.ndarray:
        """Maps the seed mask onto a new box via an affine transform."""
        bx, by, bw, bh = box
        sx = bw / max(1, seed_box[2])
        sy = bh / max(1, seed_box[3])
        matrix = np.array(
            [[sx, 0, bx - seed_box[0] * sx], [0, sy, by - seed_box[1] * sy]],
            dtype=np.float32,
        )
        return cv2.warpAffine(seed_mask, matrix, (width, height), flags=cv2.INTER_NEAREST)

    # Two passes from the seed frame: forward, then backward.
    for direction in (1, -1):
        tracker = make_tracker()
        tracker.init(first, seed_box)
        collected[init_idx] = seed_mask

        index = init_idx + direction
        while 0 <= index < len(frames):
            frame = cv2.imread(str(frames[index]))
            if frame is None:
                break

            ok, box = tracker.update(frame)
            if not ok:
                # Lost lock: hold the last known mask rather than emitting an
                # empty one, which would make the object flicker back in.
                collected[index] = collected.get(index - direction, seed_mask)
            else:
                collected[index] = warp_to(tuple(int(v) for v in box))

            progress(len(collected) / max(1, len(frames)), f"frame {len(collected)}/{len(frames)}")
            index += direction

    paths = _write_masks(collected, frames, masks_dir)
    coverage = sum(1 for m in collected.values() if m.any()) / len(frames)
    log.info("OpenCV tracking finished, coverage=%.2f", coverage)
    return TrackResult(mask_paths=paths, backend="opencv-csrt", coverage=coverage)


# ── shared ───────────────────────────────────────────────────────────────


def _write_masks(collected: dict[int, np.ndarray], frames: list[Path], masks_dir: Path) -> list[Path]:
    """Persists one mask PNG per frame, filling gaps with an empty mask."""
    masks_dir.mkdir(parents=True, exist_ok=True)
    for stale in masks_dir.glob("*.png"):
        stale.unlink()

    sample = next(iter(collected.values()))
    empty = np.zeros_like(sample)

    paths: list[Path] = []
    for index in range(len(frames)):
        mask = collected.get(index, empty)
        path = masks_dir / f"{index:06d}.png"
        cv2.imwrite(str(path), mask)
        paths.append(path)
    return paths


def track(
    frames: list[Path],
    init_idx: int,
    grounding: Grounding,
    masks_dir: Path,
    progress: ProgressCb,
) -> TrackResult:
    """Produces a per-frame mask, preferring SAM 2 and degrading to OpenCV."""
    result = _track_sam2(frames, init_idx, grounding, masks_dir, progress)
    if result is not None and result.coverage > 0.1:
        log.info("SAM 2 tracking finished, coverage=%.2f", result.coverage)
        return result

    if result is not None:
        log.warning("SAM 2 produced near-empty masks (coverage=%.2f) — retrying with OpenCV", result.coverage)

    return _track_opencv(frames, init_idx, grounding, masks_dir, progress)
