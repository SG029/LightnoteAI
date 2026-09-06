import { config } from "../config.js";
import { jobEvents } from "../lib/eventBus.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { Job } from "../models/Job.js";
import { processVideo } from "./mlClient.js";
import type { EditPlan, StageName } from "../types.js";

/**
 * Serialised job queue.
 *
 * Concurrency is fixed at 1 deliberately: there is one GPU, and running two
 * renders concurrently on 6GB of VRAM causes CUDA OOM rather than throughput.
 * The queue exists so the API can accept work instantly and return a queue
 * position, instead of blocking the request for the length of a render.
 *
 * This is an in-process queue backed by MongoDB. That is the right size for a
 * single-GPU deployment; the trade-off is documented in the README. Because
 * every consumer goes through `enqueue()` / `getQueuePosition()`, swapping in
 * BullMQ or RQ would be a change to this file alone.
 */
const CONCURRENCY = 1;

const queue: string[] = [];
let active = 0;
let draining = false;

export function getQueueDepth(): number {
  return queue.length + active;
}

/** 0 = currently rendering, 1 = next up, etc. Returns null if not queued. */
export function getQueuePosition(jobId: string): number | null {
  const idx = queue.indexOf(jobId);
  if (idx === -1) return null;
  return idx + active;
}

export function enqueue(jobId: string): number {
  queue.push(jobId);
  const position = getQueuePosition(jobId) ?? 0;
  logger.info({ jobId, position, depth: getQueueDepth() }, "Job enqueued");
  queueMicrotask(pump);
  return position;
}

function pump(): void {
  if (draining) return;
  while (active < CONCURRENCY && queue.length > 0) {
    const jobId = queue.shift()!;
    active++;
    void runJob(jobId).finally(() => {
      active--;
      pump();
    });
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = await Job.findById(jobId);
  if (!job) {
    logger.warn({ jobId }, "Queued job vanished before it ran");
    return;
  }

  job.status = "processing";
  job.startedAt = new Date();
  await job.save();
  jobEvents.publish(jobId, { type: "status", payload: { status: "processing" } });

  try {
    const result = await processVideo({
      jobId,
      plan: job.plan as EditPlan,
      videoPath: job.source.videoPath,
      refImagePath: job.source.refImagePath ?? null,
      callbackUrl: `http://localhost:${config.PORT}/internal/jobs/${jobId}/progress`,
      options: {
        targetHeight: config.TARGET_HEIGHT,
        maxDurationSec: config.MAX_DURATION_SEC,
        forceCpu: config.FORCE_CPU,
      },
    });

    const fresh = await Job.findById(jobId);
    if (!fresh) return;

    fresh.status = "completed";
    fresh.finishedAt = new Date();
    fresh.strategy = result.strategy;
    fresh.artifacts = {
      outputPath: result.outputPath,
      maskPreviewPath: result.maskPreviewPath ?? null,
      assetPath: result.assetPath ?? null,
    };
    await fresh.save();

    logger.info({ jobId, strategy: result.strategy }, "Job completed");
    jobEvents.publish(jobId, {
      type: "done",
      payload: { status: "completed", strategy: result.strategy },
    });
  } catch (err) {
    const appErr =
      err instanceof AppError
        ? err
        : new AppError(500, "internal_error", (err as Error).message || "Processing failed");

    // Blame the stage that was mid-flight, so the UI can highlight where it
    // broke rather than just reddening the whole timeline.
    const fresh = await Job.findById(jobId);
    const failedStage =
      (fresh?.stages.find((s) => s.status === "running")?.name as StageName | undefined) ?? null;

    if (fresh) {
      fresh.status = "failed";
      fresh.finishedAt = new Date();
      fresh.error = { code: appErr.code, message: appErr.message, stage: failedStage };
      for (const stage of fresh.stages) {
        if (stage.status === "running") stage.status = "failed";
      }
      await fresh.save();
    }

    logger.error({ jobId, code: appErr.code, stage: failedStage }, "Job failed");
    jobEvents.publish(jobId, {
      type: "error",
      payload: { status: "failed", error: { code: appErr.code, message: appErr.message, stage: failedStage } },
    });
  }
}

/**
 * Jobs left mid-render by a server restart can never complete — the worker
 * that owned them is gone. Mark them failed at boot so the history list
 * doesn't show phantom spinners forever.
 */
export async function reconcileOrphanedJobs(): Promise<void> {
  const result = await Job.updateMany(
    { status: { $in: ["processing", "parsing"] } },
    {
      $set: {
        status: "failed",
        finishedAt: new Date(),
        error: {
          code: "interrupted",
          message: "The server restarted while this job was running.",
          stage: null,
        },
      },
    },
  );

  if (result.modifiedCount > 0) {
    logger.warn({ count: result.modifiedCount }, "Marked orphaned jobs as failed");
  }
}

/** Lets in-flight work finish on SIGINT instead of being killed mid-write. */
export async function drain(timeoutMs = 10_000): Promise<void> {
  draining = true;
  queue.length = 0;
  const deadline = Date.now() + timeoutMs;
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
