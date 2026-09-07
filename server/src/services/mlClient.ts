import http from "node:http";
import https from "node:https";

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
 * POSTs JSON and waits for the whole response, with no cap other than the one
 * passed in.
 *
 * Not `fetch`: undici applies a `headersTimeout` of five minutes and there is
 * no way to raise it without a custom dispatcher, which is not reachable from
 * Node's global fetch. `/process` sends nothing at all until the render is
 * finished, so every job longer than five minutes was aborted mid-render and
 * surfaced as a bare "fetch failed" — indistinguishable from a worker that had
 * actually gone away. `node:http` imposes no such limit, so the only deadline
 * is the explicit one below.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );

    // A whole-render deadline. Deliberately not `request.setTimeout`, which
    // fires on socket idleness — and a long render looks exactly like an idle
    // socket from this end.
    const deadline = setTimeout(() => {
      const err = new Error(`no response within ${Math.round(timeoutMs / 60_000)} minutes`);
      err.name = "TimeoutError";
      request.destroy(err);
    }, timeoutMs);

    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
    request.end(payload);
  });
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

  let status: number;
  let raw: string;
  try {
    // A 15s clip on CPU can legitimately take many minutes, and a 4K source
    // longer still. The worker enforces its own per-stage limits; this only
    // stops a genuinely hung socket from pinning the queue forever.
    ({ status, body: raw } = await postJson(
      url,
      {
        "content-type": "application/json",
        "x-internal-secret": config.INTERNAL_SECRET,
      },
      JSON.stringify(req),
      30 * 60_000,
    ));
  } catch (err) {
    // Worth separating: "it never answered" is a stuck render, while
    // "nothing is listening" is a worker that was never started.
    const cause =
      (err as Error).name === "TimeoutError"
        ? "did not respond in time"
        : "is unreachable";
    logger.error({ err, jobId: req.jobId, ms: Date.now() - started }, "ML worker call failed");
    throw AppError.upstream(
      "ml_unreachable",
      `The video processing service ${cause} at ${config.ML_SERVICE_URL}. ` +
        `Is it running? Start it with "npm run dev:ml".`,
    );
  }

  let body: (ProcessResult & { error?: { code: string; message: string } }) | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  if (status < 200 || status >= 300) {
    const code = body?.error?.code ?? "ml_failed";
    const message = body?.error?.message ?? `ML worker returned ${status}`;
    logger.error({ jobId: req.jobId, status, code, message }, "ML worker rejected job");
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
