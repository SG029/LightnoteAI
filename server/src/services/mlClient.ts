import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { EditPlan, Strategy } from "../types.js";

export interface ProcessRequest {
  jobId: string;
  plan: EditPlan;
  videoPath: string;
  refImagePath: string | null;
  callbackUrl: string;
  options: {
    targetHeight: number;
    maxDurationSec: number;
    forceCpu: boolean;
  };
}

export interface ProcessResult {
  outputPath: string;
  maskPreviewPath: string | null;
  assetPath: string | null;
  strategy: Strategy;
}

/**
 * `/process` is intentionally a *blocking* call: the Python worker holds the
 * connection open for the whole render and returns the final result.
 *
 * The alternative — 202 Accepted plus a terminal webhook — means duplicating
 * completion and failure handling across two code paths. Keeping it blocking
 * means a crashed worker surfaces as a rejected promise right here, with the
 * stack intact. Live progress still streams independently over the webhook,
 * so the UI is not waiting on this response.
 */
export async function processVideo(req: ProcessRequest): Promise<ProcessResult> {
  const url = `${config.ML_SERVICE_URL}/process`;
  const started = Date.now();

  logger.info({ jobId: req.jobId, url }, "Dispatching to ML worker");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": config.INTERNAL_SECRET,
      },
      body: JSON.stringify(req),
      // A 15s clip on CPU can legitimately take many minutes. The worker
      // enforces its own per-stage limits; this only guards a hung socket.
      signal: AbortSignal.timeout(30 * 60_000),
    });
  } catch (err) {
    const cause = (err as Error).name === "TimeoutError" ? "timed out" : "is unreachable";
    logger.error({ err, jobId: req.jobId }, "ML worker call failed");
    throw AppError.upstream(
      "ml_unreachable",
      `The video processing service ${cause} at ${config.ML_SERVICE_URL}. ` +
        `Is it running? Start it with "npm run dev:ml".`,
    );
  }

  const body = (await response.json().catch(() => null)) as
    | (ProcessResult & { error?: { code: string; message: string } })
    | null;

  if (!response.ok) {
    const code = body?.error?.code ?? "ml_failed";
    const message = body?.error?.message ?? `ML worker returned ${response.status}`;
    logger.error({ jobId: req.jobId, status: response.status, code, message }, "ML worker rejected job");
    throw new AppError(502, code, message);
  }

  if (!body?.outputPath) {
    throw AppError.upstream("ml_bad_response", "ML worker completed without producing an output video.");
  }

  logger.info({ jobId: req.jobId, ms: Date.now() - started, strategy: body.strategy }, "ML worker finished");
  return body;
}

/** Health probe: reports GPU, VRAM and which models are resident. */
export async function checkMlService(): Promise<{
  ok: boolean;
  detail: Record<string, unknown> | string;
}> {
  try {
    const res = await fetch(`${config.ML_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, detail: `returned ${res.status}` };
    return { ok: true, detail: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
