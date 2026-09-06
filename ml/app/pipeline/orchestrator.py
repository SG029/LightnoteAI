"""Runs the six-stage pipeline for one job.

    intent → ground → track → clean → compose → encode

`intent` already ran in the Express layer before dispatch, so it is reported
as complete on entry; it appears in the timeline because it is genuinely part
of the pipeline from the user's point of view.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from ..config import settings
from ..memory import release, snapshot
from ..progress import ProgressReporter
from ..schemas import ProcessRequest, ProcessResult, Strategy
from . import assets, compose, grounding, inpaint, segment, video

log = logging.getLogger("lightedit.orchestrator")

# How many frames to try grounding on before giving up. The target may be
# occluded, blurred, or off-screen at the start, so a single attempt on frame 0
# fails far more often than it should.
GROUNDING_SAMPLES = 4


class PipelineError(RuntimeError):
    """A stage failed in a way the user should be told about verbatim."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _sample_indices(frame_count: int, samples: int) -> list[int]:
    """Frame indices to attempt grounding on, earliest first.

    Weighted toward the start of the clip: an early lock means the backward
    propagation pass is short, and the tracker has more of the video ahead of
    it to work with.
    """
    if frame_count <= samples:
        return list(range(frame_count))
    fractions = [0.0, 0.15, 0.4, 0.7, 0.9][:samples]
    seen: list[int] = []
    for fraction in fractions:
        index = min(frame_count - 1, int(frame_count * fraction))
        if index not in seen:
            seen.append(index)
    return seen


def run(request: ProcessRequest, reporter: ProgressReporter) -> ProcessResult:
    plan = request.plan
    job_dir = settings.frames_dir / request.jobId

    raw_dir = job_dir / "raw"
    masks_dir = job_dir / "masks"
    plates_dir = job_dir / "plates"
    comp_dir = job_dir / "comp"
    asset_dir = job_dir / "asset"

    video_path = Path(request.videoPath)
    ref_path = Path(request.refImagePath) if request.refImagePath else None

    if not video_path.exists():
        raise PipelineError("source_missing", "The uploaded video is no longer on disk.")

    output_path = settings.outputs_dir / f"{request.jobId}.mp4"
    preview_path = settings.outputs_dir / f"{request.jobId}_mask.png"

    # ── 1. intent ────────────────────────────────────────────────────────
    summary = (
        f"{plan.operation} · {plan.target}"
        + (f" → {plan.replacement}" if plan.replacement else "")
    )
    reporter.update("intent", "done", progress=1.0, detail=summary)

    # ── 2. ground ────────────────────────────────────────────────────────
    with reporter.stage("ground", "Reading video") as stage:
        meta = video.probe(video_path)

        if meta.duration_sec > request.options.maxDurationSec + 0.5:
            raise PipelineError(
                "video_too_long",
                f"This clip is {meta.duration_sec:.1f}s; the limit is "
                f"{request.options.maxDurationSec:.0f}s.",
            )

        stage.detail("Extracting frames")
        frames = video.extract_frames(video_path, raw_dir, request.options.targetHeight)

        reporter.update(
            "ground",
            "running",
            source={
                "durationSec": meta.duration_sec,
                "width": meta.width,
                "height": meta.height,
                "fps": meta.fps,
                "frameCount": len(frames),
            },
        )

        stage.progress(0.4, f"Locating \"{plan.target}\"")
        samples = _sample_indices(len(frames), GROUNDING_SAMPLES)

        try:
            position, keyframe, located = grounding.locate_in_any(
                [frames[i] for i in samples], plan.target, plan.targetHint
            )
        except grounding.TargetNotFound as exc:
            raise PipelineError("target_not_found", str(exc)) from exc
        except grounding.GeminiError as exc:
            raise PipelineError("gemini_failed", str(exc)) from exc

        init_idx = samples[position]
        stage.progress(1.0, f"Found \"{located.label}\" at {located.confidence:.0%}")

    # ── 3. track ─────────────────────────────────────────────────────────
    with reporter.stage("track", "Segmenting and propagating") as stage:
        tracked = segment.track(frames, init_idx, located, masks_dir, stage.progress)

        if tracked.coverage < 0.05:
            raise PipelineError(
                "tracking_failed",
                f"The object could only be followed through {tracked.coverage:.0%} of the clip. "
                f"Try footage where it stays visible.",
            )

        release()
        log.info("after track — %s", snapshot())

        compose.mask_preview(frames[init_idx], tracked.mask_paths[init_idx], preview_path)
        reporter.update(
            "track",
            "running",
            detail=f"{tracked.backend}, {tracked.coverage:.0%} coverage",
            artifacts={"maskPreviewPath": str(preview_path)},
        )

    # ── 4. clean ─────────────────────────────────────────────────────────
    with reporter.stage("clean", "Removing the original object") as stage:
        plates = inpaint.clean_plate(frames, tracked.mask_paths, plates_dir, stage.progress)
        release()
        log.info("after clean — %s", snapshot())

    # ── 5. compose ───────────────────────────────────────────────────────
    strategy: Strategy = "removal_only"
    final_frames = plates
    asset_path: str | None = None

    if plan.operation == "replace":
        with reporter.stage("compose", "Building the replacement") as stage:
            asset = assets.build(plan, keyframe, located, ref_path, asset_dir)

            if asset is None:
                # The ladder bottomed out. The object is still gone, which is a
                # partial success worth returning rather than a hard failure.
                stage.detail("No replacement asset could be built — removal only")
                log.warning("job %s degraded to removal_only", request.jobId)
            else:
                strategy = asset.strategy
                # The job directory is deleted after encoding, so the asset is
                # promoted to outputs/ where the API can still serve it.
                kept = settings.outputs_dir / f"{request.jobId}_asset.png"
                shutil.copy2(asset.path, kept)
                asset_path = str(kept)

                stage.detail(f"Compositing via {asset.strategy}")
                final_frames = compose.composite(
                    plates, tracked.mask_paths, asset, comp_dir, stage.progress
                )
                reporter.update(
                    "compose", "running", strategy=strategy, artifacts={"assetPath": asset_path}
                )
    else:
        reporter.skip("compose", "Removal job — nothing to composite")

    # ── 6. encode ────────────────────────────────────────────────────────
    with reporter.stage("encode", "Encoding video") as stage:
        # ffmpeg is a subprocess and needs headroom this process may still be
        # holding. On a host with a small page file, skipping this shows up as
        # an opaque "Error submitting video frame to the encoder".
        release()
        log.info("before encode — %s", snapshot())

        frames_dir = final_frames[0].parent
        video.encode(
            frames_dir,
            output_path,
            fps=meta.fps,
            audio_from=video_path if meta.has_audio else None,
        )
        stage.progress(1.0, f"{output_path.stat().st_size / 1_048_576:.1f} MB")

    _cleanup(job_dir)

    return ProcessResult(
        outputPath=str(output_path),
        maskPreviewPath=str(preview_path) if preview_path.exists() else None,
        assetPath=asset_path,
        strategy=strategy,
    )


def _cleanup(job_dir: Path) -> None:
    """Deletes intermediate frames once the video is encoded.

    A 15s clip produces roughly 450 frames at each of four stages. Left on
    disk that is well over a gigabyte per job, and none of it is reachable
    through the API — the output video and mask preview live elsewhere.
    """
    try:
        shutil.rmtree(job_dir, ignore_errors=True)
    except OSError as exc:  # noqa: BLE001 — disk hygiene must not fail a job
        log.warning("could not clean %s: %s", job_dir, exc)
