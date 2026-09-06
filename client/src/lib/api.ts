import type {
  CreateJobResponse,
  HealthResponse,
  Job,
  JobListResponse,
} from "./types";

// Same-origin: Vite proxies /api to Express in dev. Keeping one origin means
// EventSource works without CORS credentials, which it cannot send headers for.
const BASE = "/api";

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) {
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  // The API always fails as { error: { code, message } }; anything else means
  // the request never reached it (proxy down, wrong port).
  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | null;

  throw new ApiRequestError(
    response.status,
    body?.error?.code ?? "unknown_error",
    body?.error?.message ?? `Request failed with status ${response.status}`,
    body?.error?.details,
  );
}

export interface CreateJobInput {
  video: File;
  referenceImage?: File | null;
  prompt: string;
  onProgress?: (fraction: number) => void;
}

/**
 * Uploads a job. Uses XMLHttpRequest rather than fetch because fetch still
 * cannot report upload progress, and a 100MB video on a slow disk needs a
 * progress bar or the UI looks frozen.
 */
export function createJob(input: CreateJobInput): Promise<CreateJobResponse> {
  const form = new FormData();
  form.append("video", input.video);
  form.append("prompt", input.prompt);
  if (input.referenceImage) form.append("referenceImage", input.referenceImage);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/jobs`);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        input.onProgress?.(event.loaded / event.total);
      }
    });

    xhr.addEventListener("load", () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }

      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body as CreateJobResponse);
      } else {
        reject(
          new ApiRequestError(
            xhr.status,
            body?.error?.code ?? "upload_failed",
            body?.error?.message ?? `Upload failed with status ${xhr.status}`,
            body?.error?.details,
          ),
        );
      }
    });

    xhr.addEventListener("error", () =>
      reject(
        new ApiRequestError(
          0,
          "network_error",
          "Could not reach the API. Is the server running on port 4000?",
        ),
      ),
    );

    xhr.addEventListener("abort", () =>
      reject(new ApiRequestError(0, "aborted", "Upload cancelled.")),
    );

    xhr.send(form);
  });
}

export async function getJob(id: string): Promise<{ job: Job; queuePosition: number | null }> {
  return unwrap(await fetch(`${BASE}/jobs/${id}`));
}

export async function listJobs(limit = 20): Promise<JobListResponse> {
  return unwrap(await fetch(`${BASE}/jobs?limit=${limit}`));
}

export async function deleteJob(id: string): Promise<void> {
  return unwrap(await fetch(`${BASE}/jobs/${id}`, { method: "DELETE" }));
}

export async function getHealth(): Promise<HealthResponse> {
  return unwrap(await fetch(`${BASE}/health`));
}

export const outputUrl = (id: string) => `${BASE}/jobs/${id}/output`;
export const maskUrl = (id: string) => `${BASE}/jobs/${id}/mask`;
export const streamUrl = (id: string) => `${BASE}/jobs/${id}/stream`;
