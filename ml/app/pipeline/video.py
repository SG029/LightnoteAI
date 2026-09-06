"""ffmpeg wrappers: probing, frame extraction, and final encoding."""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("lightedit.video")

# Windows: stop a console window flashing on every subprocess call.
_CREATE_NO_WINDOW = 0x08000000 if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


class VideoError(RuntimeError):
    """ffmpeg could not read or write the file."""


@dataclass(frozen=True)
class VideoMeta:
    duration_sec: float
    width: int
    height: int
    fps: float
    frame_count: int
    has_audio: bool


def _run(args: list[str], *, what: str) -> subprocess.CompletedProcess[str]:
    log.debug("%s: %s", what, " ".join(args[:8]))
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        creationflags=_CREATE_NO_WINDOW,
    )
    if proc.returncode != 0:
        # ffmpeg writes diagnostics to stderr; the last lines carry the cause.
        tail = "\n".join(proc.stderr.strip().splitlines()[-4:])
        raise VideoError(f"{what} failed: {tail or 'unknown ffmpeg error'}")
    return proc


def _parse_fps(rational: str | None) -> float:
    if not rational or "/" not in rational:
        return 0.0
    num, den = rational.split("/", 1)
    try:
        return float(num) / float(den) if float(den) else 0.0
    except ValueError:
        return 0.0


def probe(path: Path) -> VideoMeta:
    proc = _run(
        [
            "ffprobe", "-v", "error",
            "-print_format", "json",
            "-show_format", "-show_streams",
            str(path),
        ],
        what="ffprobe",
    )
    data = json.loads(proc.stdout)

    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise VideoError("The file contains no video stream.")

    duration = float(data.get("format", {}).get("duration", 0.0))
    fps = _parse_fps(video.get("avg_frame_rate")) or _parse_fps(video.get("r_frame_rate"))
    frame_count = int(video.get("nb_frames", 0) or 0) or round(duration * fps)

    return VideoMeta(
        duration_sec=duration,
        width=int(video.get("width", 0)),
        height=int(video.get("height", 0)),
        fps=fps or 25.0,
        frame_count=frame_count,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
    )


def extract_frames(video_path: Path, out_dir: Path, target_height: int) -> list[Path]:
    """Demuxes to PNG frames, downscaled so the long edge stays manageable.

    PNG rather than JPEG because every later stage composites against these
    pixels — JPEG ringing around the object edge would be baked into the
    final result and is very visible after inpainting.

    Height is forced even (`-2` on width) because H.264 cannot encode odd
    dimensions, and the frames must round-trip back through the encoder.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.png"):
        stale.unlink()

    _run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(video_path),
            "-vf", f"scale=-2:{target_height}:flags=lanczos",
            "-start_number", "0",
            str(out_dir / "%06d.png"),
        ],
        what="frame extraction",
    )

    frames = sorted(out_dir.glob("*.png"))
    if not frames:
        raise VideoError("No frames could be extracted from this video.")
    return frames


def encode(
    frames_dir: Path,
    out_path: Path,
    fps: float,
    audio_from: Path | None = None,
) -> Path:
    """Re-encodes edited frames to H.264, carrying the original audio across."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    args = [
        "ffmpeg", "-y", "-v", "error",
        "-framerate", f"{fps:.6f}",
        # Frames are written 000000-first, but the image2 demuxer starts
        # looking at 1 by default and then fails with an opaque
        # "received no packets" error rather than a missing-file one.
        "-start_number", "0",
        "-i", str(frames_dir / "%06d.png"),
    ]

    if audio_from is not None:
        args += ["-i", str(audio_from)]

    args += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",              # visually lossless; the edit is the story, not the codec
        "-pix_fmt", "yuv420p",     # required for browser <video> playback
        "-movflags", "+faststart", # lets the player start before the full download
    ]

    if audio_from is not None:
        # Map video from the frames, audio from the original. `-shortest`
        # guards against a small duration mismatch after re-encoding.
        args += ["-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "128k", "-shortest"]

    args.append(str(out_path))
    _run(args, what="encoding")

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise VideoError("Encoding produced an empty file.")
    return out_path
