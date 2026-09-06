import { z } from "zod";

/**
 * The six pipeline stages, in execution order. This array is the single
 * source of truth: the Mongo document seeds `stages[]` from it, the ML
 * worker reports progress against these names, and the UI timeline
 * renders them in this order. Adding a stage here propagates everywhere.
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

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";

export type JobStatus = "queued" | "parsing" | "processing" | "completed" | "failed";

/**
 * Which tier of the replacement ladder actually produced the output.
 * Recorded so the API can be honest about degraded results instead of
 * silently returning a lower-quality edit.
 */
export type Strategy = "gemini_keyframe" | "reference_composite" | "removal_only";

/**
 * Structured interpretation of the user's natural-language instruction.
 * Doubles as the response schema handed to Gemini, so the model is
 * constrained to emit exactly this shape — no JSON repair needed.
 */
export const editPlanSchema = z.object({
  operation: z
    .enum(["replace", "remove"])
    .describe("replace = swap the target for something else; remove = erase it and inpaint the background"),
  target: z
    .string()
    .min(1)
    .describe("The object to act on, as a short noun phrase a vision model can ground, e.g. 'Coca-Cola bottle'"),
  replacement: z
    .string()
    .nullable()
    .describe("What the target becomes. Null when operation is 'remove'."),
  targetHint: z
    .string()
    .nullable()
    .describe("Optional disambiguator when several similar objects appear, e.g. 'the one in the person's right hand'"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How unambiguous the instruction was. Below 0.4 the request is rejected."),
  reasoning: z.string().describe("One sentence explaining the interpretation, surfaced in the UI."),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export interface StageState {
  name: StageName;
  status: StageStatus;
  progress: number; // 0..1
  ms: number | null;
  detail: string | null;
}

export interface VideoSource {
  videoPath: string;
  refImagePath: string | null;
  originalName: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameCount: number | null;
}

export interface JobArtifacts {
  outputPath: string | null;
  maskPreviewPath: string | null;
  assetPath: string | null;
}

export interface JobError {
  code: string;
  message: string;
  stage: StageName | null;
}

/** Payload the Python worker posts back to `/internal/jobs/:id/progress`. */
export const progressUpdateSchema = z.object({
  stage: z.enum(STAGES),
  status: z.enum(["running", "done", "skipped", "failed"]),
  progress: z.number().min(0).max(1).optional(),
  detail: z.string().nullable().optional(),
  ms: z.number().nonnegative().optional(),
  strategy: z.enum(["gemini_keyframe", "reference_composite", "removal_only"]).optional(),
  artifacts: z
    .object({
      outputPath: z.string().nullable().optional(),
      maskPreviewPath: z.string().nullable().optional(),
      assetPath: z.string().nullable().optional(),
    })
    .optional(),
  source: z
    .object({
      durationSec: z.number().nullable().optional(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      fps: z.number().nullable().optional(),
      frameCount: z.number().nullable().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;
