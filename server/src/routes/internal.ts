import { Router } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { jobEvents } from "../lib/eventBus.js";
import { Job } from "../models/Job.js";
import { progressUpdateSchema } from "../types.js";

export const internalRouter = Router();

/**
 * Only the Python worker may report progress. The secret is shared via the
 * root .env and never leaves localhost, but checking it means a stray request
 * cannot drive a job's state machine.
 */
internalRouter.use((req, _res, next) => {
  if (req.get("x-internal-secret") !== config.INTERNAL_SECRET) {
    return next(AppError.unauthorized("Invalid internal secret."));
  }
  next();
});

// ── POST /internal/jobs/:id/progress ────────────────────────────────────
// Called by the ML worker at every stage transition. Updates the persisted
// stage array and fans the event out to any open SSE connection.
internalRouter.post("/jobs/:id/progress", async (req, res) => {
  const update = progressUpdateSchema.parse(req.body);

  const job = await Job.findById(req.params.id).catch(() => null);
  if (!job) throw AppError.notFound("No job with that id.");

  const stage = job.stages.find((s) => s.name === update.stage);
  if (!stage) {
    throw AppError.badRequest("unknown_stage", `"${update.stage}" is not a pipeline stage.`);
  }

  stage.status = update.status;
  if (update.progress !== undefined) stage.progress = update.progress;
  if (update.detail !== undefined) stage.detail = update.detail;
  if (update.ms !== undefined) stage.ms = update.ms;

  // A finished stage is a full stage — avoids the bar freezing at 94%.
  if (update.status === "done") stage.progress = 1;

  if (update.strategy) job.strategy = update.strategy;

  // Video metadata is only fully known once the worker has demuxed the file.
  // Assigned field by field rather than by spreading, so the worker cannot
  // introduce keys the schema does not define.
  if (update.source) {
    const { durationSec, width, height, fps, frameCount } = update.source;
    if (durationSec != null) job.source.durationSec = durationSec;
    if (width != null) job.source.width = width;
    if (height != null) job.source.height = height;
    if (fps != null) job.source.fps = fps;
    if (frameCount != null) job.source.frameCount = frameCount;
  }

  if (update.artifacts) {
    const { outputPath, maskPreviewPath, assetPath } = update.artifacts;
    if (outputPath !== undefined) job.artifacts.outputPath = outputPath;
    if (maskPreviewPath !== undefined) job.artifacts.maskPreviewPath = maskPreviewPath;
    if (assetPath !== undefined) job.artifacts.assetPath = assetPath;
  }

  if (update.status === "failed" && update.error) {
    job.error = { code: update.error.code, message: update.error.message, stage: update.stage };
  }

  await job.save();

  jobEvents.publish(job.id, {
    type: "stage",
    payload: {
      stage: update.stage,
      status: update.status,
      progress: stage.progress,
      detail: stage.detail,
      ms: stage.ms,
      strategy: job.strategy,
    },
  });

  logger.debug(
    { jobId: job.id, stage: update.stage, status: update.status, progress: stage.progress },
    "Stage update",
  );

  res.status(204).end();
});
