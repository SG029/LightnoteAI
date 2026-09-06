import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import mongoose from "mongoose";
import { config } from "../config.js";
import { checkMlService } from "../services/mlClient.js";
import { checkGeminiReachable } from "../services/gemini.js";
import { getQueueDepth } from "../services/dispatcher.js";

const run = promisify(execFile);
export const healthRouter = Router();

// mongoose.connection.readyState is 0-3, plus 99 for "uninitialized".
const MONGO_STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
  99: "uninitialized",
};

async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("ffmpeg", ["-version"], { windowsHide: true });
    return stdout.split("\n")[0]?.replace("ffmpeg version ", "").split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/health           — fast checks only (no upstream API calls)
 * GET /api/health?deep=1    — additionally verifies the Gemini key works
 *
 * The deep variant costs a real Gemini call, so it is opt-in rather than
 * something a polling dashboard would trigger by accident.
 */
healthRouter.get("/", async (req, res) => {
  const deep = req.query.deep === "1";

  const [ffmpeg, ml, gemini] = await Promise.all([
    ffmpegVersion(),
    checkMlService(),
    deep ? checkGeminiReachable() : Promise.resolve(null),
  ]);

  const mongoState = MONGO_STATES[mongoose.connection.readyState] ?? "unknown";

  const checks = {
    mongo: { ok: mongoState === "connected", detail: mongoState },
    ffmpeg: { ok: ffmpeg !== null, detail: ffmpeg ?? "not found on PATH" },
    mlService: ml,
    ...(gemini ? { gemini } : {}),
  };

  const ok = Object.values(checks).every((c) => c.ok);

  res.status(ok ? 200 : 503).json({
    ok,
    checks,
    queue: { depth: getQueueDepth() },
    limits: {
      maxVideoMb: config.MAX_VIDEO_MB,
      maxDurationSec: config.MAX_DURATION_SEC,
      targetHeight: config.TARGET_HEIGHT,
    },
    models: {
      text: config.GEMINI_TEXT_MODEL,
      image: config.GEMINI_IMAGE_MODEL,
    },
  });
});
