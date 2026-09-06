import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { jobEvents, type JobEvent } from "../lib/eventBus.js";
import { probeVideo } from "../lib/ffprobe.js";
import { Job } from "../models/Job.js";
import { uploadJobFiles, normaliseUploadError } from "../middleware/upload.js";
import { parseInstruction } from "../services/gemini.js";
import { enqueue, getQueuePosition } from "../services/dispatcher.js";

export const jobsRouter = Router();

type UploadedFiles = Record<string, Express.Multer.File[]> | undefined;

/** Best-effort cleanup so a rejected request doesn't leave files behind. */
async function discardUploads(files: UploadedFiles) {
  for (const file of Object.values(files ?? {}).flat()) {
    await unlink(file.path).catch(() => {});
  }
}

/**
 * Artifact paths come from our own pipeline, but they are still read off a
 * database document — so confirm they resolve inside storage/ before serving.
 * Prevents a corrupted or tampered record from turning into arbitrary file read.
 */
function assertInsideStorage(path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(config.paths.root, path);
  const storageRoot = resolve(config.paths.root, "storage");
  if (!abs.startsWith(storageRoot)) {
    logger.error({ path: abs }, "Artifact path escaped storage directory");
    throw AppError.notFound("Artifact not available.");
  }
  return abs;
}

const createJobBody = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, "Describe the edit you want, e.g. \"Replace the bottle with a Pepsi can\".")
    .max(500, "Keep the instruction under 500 characters."),
});

// ── POST /api/jobs ──────────────────────────────────────────────────────
// Upload + parse + enqueue. Responds as soon as the instruction is understood,
// so the UI can render the plan while the render is still queued.
jobsRouter.post("/", (req, res, next) => {
  uploadJobFiles(req, res, (err) => {
    if (err) {
      void discardUploads(req.files as UploadedFiles);
      return next(normaliseUploadError(err));
    }
    void createJob(req, res, next);
  });
});

async function createJob(req: Request, res: Response, next: NextFunction) {
  const files = req.files as UploadedFiles;

  try {
    const video = files?.video?.[0];
    if (!video) {
      throw AppError.badRequest("missing_video", "A video file is required.");
    }

    const { prompt } = createJobBody.parse(req.body);

    // ── Reject unusable input before spending Gemini calls or GPU time ──
    const meta = await probeVideo(video.path);

    if (meta.durationSec > config.MAX_DURATION_SEC) {
      throw AppError.badRequest(
        "video_too_long",
        `That clip is ${meta.durationSec.toFixed(1)}s. The limit is ${config.MAX_DURATION_SEC}s — ` +
          `trim it and try again.`,
      );
    }
    if (meta.durationSec < 0.2) {
      throw AppError.badRequest("video_too_short", "That clip is too short to process.");
    }

    const plan = await parseInstruction(prompt);

    const refImage = files?.referenceImage?.[0] ?? null;

    const job = await Job.create({
      status: "queued",
      prompt,
      plan,
      source: {
        videoPath: video.path,
        refImagePath: refImage?.path ?? null,
        originalName: video.originalname,
        sizeBytes: video.size,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        frameCount: meta.frameCount,
      },
    });

    const queuePosition = enqueue(job.id);

    res.status(201).json({
      job: job.toJSON(),
      queuePosition,
      hasReferenceImage: Boolean(refImage),
    });
  } catch (err) {
    // The job never made it into Mongo, so nothing will ever clean these up.
    await discardUploads(files);
    next(err);
  }
}

// ── GET /api/jobs ───────────────────────────────────────────────────────
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  skip: z.coerce.number().int().min(0).default(0),
  status: z.enum(["queued", "parsing", "processing", "completed", "failed"]).optional(),
});

jobsRouter.get("/", async (req, res) => {
  const { limit, skip, status } = listQuery.parse(req.query);
  const filter = status ? { status } : {};

  const [jobs, total] = await Promise.all([
    Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Job.countDocuments(filter),
  ]);

  res.json({
    jobs: jobs.map((j) => j.toJSON()),
    total,
    limit,
    skip,
  });
});

// ── GET /api/jobs/:id ───────────────────────────────────────────────────
jobsRouter.get("/:id", async (req, res) => {
  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  res.json({
    job: job.toJSON(),
    queuePosition: getQueuePosition(job.id),
  });
});

// ── GET /api/jobs/:id/stream ────────────────────────────────────────────
// Server-sent events. The client falls back to polling if this drops.
jobsRouter.get("/:id/stream", async (req, res) => {
  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: { type: string; payload: unknown }) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  };

  // Send the current state immediately — a client connecting late still gets a
  // correct picture rather than waiting for the next stage transition.
  send({ type: "snapshot", payload: { job: job.toJSON() } });

  const unsubscribe = jobEvents.subscribe(req.params.id!, (event: JobEvent) => {
    send({ type: event.type, payload: event.payload });
  });

  // Proxies and browsers drop idle connections; a comment frame keeps it warm.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// ── GET /api/jobs/:id/output ────────────────────────────────────────────
jobsRouter.get("/:id/output", async (req, res) => {
  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  const path = job.artifacts?.outputPath;
  if (!path) {
    throw AppError.conflict(
      "output_not_ready",
      job.status === "failed"
        ? "This job failed, so there is no output video."
        : "This job has not finished rendering yet.",
    );
  }

  const abs = assertInsideStorage(path);
  if (!existsSync(abs)) throw AppError.notFound("The output file is missing from disk.");

  // sendFile handles Range requests, which is what makes seeking work in the
  // <video> element rather than forcing a full download first.
  res.sendFile(abs, {
    headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=3600" },
  });
});

// ── GET /api/jobs/:id/mask ──────────────────────────────────────────────
// Mask overlay frame — proves the segmentation is real, and is the single most
// useful artifact when debugging a bad result.
jobsRouter.get("/:id/mask", async (req, res) => {
  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  const path = job.artifacts?.maskPreviewPath;
  if (!path) throw AppError.conflict("mask_not_ready", "No mask preview for this job yet.");

  const abs = assertInsideStorage(path);
  if (!existsSync(abs)) throw AppError.notFound("The mask preview is missing from disk.");

  res.sendFile(abs, { headers: { "Content-Type": "image/png" } });
});

// ── DELETE /api/jobs/:id ────────────────────────────────────────────────
jobsRouter.delete("/:id", async (req, res) => {
  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  if (job.status === "processing") {
    throw AppError.conflict("job_running", "Cannot delete a job while it is rendering.");
  }

  const paths = [
    job.source?.videoPath,
    job.source?.refImagePath,
    job.artifacts?.outputPath,
    job.artifacts?.maskPreviewPath,
    job.artifacts?.assetPath,
  ].filter((p): p is string => Boolean(p));

  for (const p of paths) {
    await unlink(assertInsideStorage(p)).catch(() => {});
  }

  await job.deleteOne();
  logger.info({ jobId: req.params.id, files: paths.length }, "Job deleted");
  res.status(204).end();
});
