import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "./errors.js";

const run = promisify(execFile);

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  hasAudio: boolean;
}

/** Parses ffprobe's "30000/1001" rational frame-rate notation. */
function parseFps(rational: string | undefined): number {
  if (!rational) return 0;
  const [num, den] = rational.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

/**
 * Reads video metadata up front so oversized or overlong clips are rejected
 * with a clear 400 before any GPU time is spent, and so the UI can show
 * duration and resolution the moment the upload lands.
 */
export async function probeVideo(path: string): Promise<VideoMeta> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      "ffprobe",
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (err) {
    const message = (err as { code?: string }).code === "ENOENT"
      ? "ffprobe is not installed or not on PATH. See README \"Setup\"."
      : "This file could not be read as a video.";
    throw AppError.badRequest("unreadable_video", message);
  }

  const probe = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      nb_frames?: string;
    }>;
  };

  const video = probe.streams?.find((s) => s.codec_type === "video");
  if (!video) {
    throw AppError.badRequest("no_video_stream", "That file contains no video track.");
  }

  const durationSec = Number(probe.format?.duration ?? 0);
  const fps = parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate) || 0;
  const frameCount = Number(video.nb_frames ?? 0) || Math.round(durationSec * fps);

  return {
    durationSec,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    frameCount,
    hasAudio: Boolean(probe.streams?.some((s) => s.codec_type === "audio")),
  };
}
