/**
 * Client-side mirror of `server/src/types.ts`.
 *
 * Duplicated rather than shared through a workspace package: two consumers
 * do not justify the build complexity, and the API surface is small enough
 * to keep in sync by hand. The server is the source of truth.
 */

export const STAGES = ["intent", "ground", "track", "clean", "compose", "encode"] as const;
export type StageName = (typeof STAGES)[number];

export const STAGE_LABELS: Record<StageName, string> = {
  intent: "Understand instruction",
  ground: "Locate target",
  track: "Segment & track",
  clean: "Remove object",
  compose: "Composite replacement",
  encode: "Encode video",
};

/** Shown under each stage while it waits, so the timeline explains itself. */
export const STAGE_HINTS: Record<StageName, string> = {
  intent: "Gemini parses the instruction into a structured edit plan",
  ground: "Gemini locates the target object in a keyframe",
  track: "SAM 2 segments it and propagates the mask across every frame",
  clean: "LaMa erases the object and reconstructs the background",
  compose: "The replacement is generated and composited along the tracked path",
  encode: "Frames are re-encoded to H.264 with the original audio",
};

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type JobStatus = "queued" | "parsing" | "processing" | "completed" | "failed";
export type Strategy =
  | "gemini_keyframe"
  | "reference_composite"
  | "generated_composite"
  | "removal_only";

/** Shown on the result so a degraded run is labelled, never passed off. */
export const STRATEGY_LABELS: Record<Strategy, string> = {
  gemini_keyframe: "Scene-matched AI replacement",
  reference_composite: "Reference image composite",
  generated_composite: "AI-generated replacement",
  removal_only: "Removal only — no replacement built",
};

export interface EditPlan {
  operation: "replace" | "remove" | null;
  target: string | null;
  replacement: string | null;
  targetHint: string | null;
  confidence: number | null;
  reasoning: string | null;
}

export interface Stage {
  name: StageName;
  status: StageStatus;
  progress: number;
  ms: number | null;
  detail: string | null;
}

export interface JobSource {
  originalName: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameCount: number | null;
}

export interface JobError {
  code: string | null;
  message: string | null;
  stage: StageName | null;
}

export interface Job {
  id: string;
  status: JobStatus;
  prompt: string;
  plan: EditPlan;
  source: JobSource;
  stages: Stage[];
  strategy: Strategy | null;
  error: JobError;
  hasOutput: boolean;
  elapsedMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface CreateJobResponse {
  job: Job;
  queuePosition: number;
  hasReferenceImage: boolean;
}

export interface JobListResponse {
  jobs: Job[];
  total: number;
  limit: number;
  skip: number;
}

export interface HealthResponse {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail: unknown }>;
  queue: { depth: number };
  limits: { maxVideoMb: number; maxDurationSec: number; targetHeight: number };
  models: { text: string; image: string };
}
