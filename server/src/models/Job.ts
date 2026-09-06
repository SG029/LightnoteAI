import mongoose, { Schema, type HydratedDocument, type Model } from "mongoose";
import {
  STAGES,
  type JobStatus,
  type StageName,
  type StageStatus,
  type Strategy,
} from "../types.js";

/**
 * Mongoose's `InferSchemaType` flattens nested object literals to `{}`, which
 * silently erases the types of `source`, `plan` and `artifacts` at every call
 * site. Declaring the document shape explicitly and passing it to
 * `Schema<IJob>` keeps those fields typed.
 */
export interface IStage {
  name: StageName;
  status: StageStatus;
  progress: number;
  ms: number | null;
  detail: string | null;
}

export interface IJobPlan {
  operation: "replace" | "remove" | null;
  target: string | null;
  replacement: string | null;
  targetHint: string | null;
  confidence: number | null;
  reasoning: string | null;
}

export interface IJobSource {
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

export interface IJobArtifacts {
  outputPath: string | null;
  maskPreviewPath: string | null;
  assetPath: string | null;
}

export interface IJobError {
  code: string | null;
  message: string | null;
  stage: StageName | null;
}

export interface IJob {
  status: JobStatus;
  prompt: string;
  plan: IJobPlan;
  source: IJobSource;
  stages: IStage[];
  artifacts: IJobArtifacts;
  strategy: Strategy | null;
  error: IJobError;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const stageSchema = new Schema<IStage>(
  {
    name: { type: String, enum: STAGES, required: true },
    status: {
      type: String,
      enum: ["pending", "running", "done", "skipped", "failed"],
      default: "pending",
    },
    progress: { type: Number, default: 0, min: 0, max: 1 },
    ms: { type: Number, default: null },
    detail: { type: String, default: null },
  },
  { _id: false },
);

const jobSchema = new Schema<IJob>(
  {
    status: {
      type: String,
      enum: ["queued", "parsing", "processing", "completed", "failed"],
      default: "queued",
      index: true,
    },

    prompt: { type: String, required: true, trim: true, maxlength: 500 },

    // Populated by Gemini before the job is dispatched, so the UI can show
    // the interpretation immediately rather than after the render finishes.
    plan: {
      operation: { type: String, enum: ["replace", "remove", null], default: null },
      target: { type: String, default: null },
      replacement: { type: String, default: null },
      targetHint: { type: String, default: null },
      confidence: { type: Number, default: null },
      reasoning: { type: String, default: null },
    },

    source: {
      videoPath: { type: String, required: true },
      refImagePath: { type: String, default: null },
      originalName: { type: String, required: true },
      sizeBytes: { type: Number, required: true },
      durationSec: { type: Number, default: null },
      width: { type: Number, default: null },
      height: { type: Number, default: null },
      fps: { type: Number, default: null },
      frameCount: { type: Number, default: null },
    },

    stages: {
      type: [stageSchema],
      default: () =>
        STAGES.map((name) => ({ name, status: "pending", progress: 0, ms: null, detail: null })),
    },

    artifacts: {
      outputPath: { type: String, default: null },
      maskPreviewPath: { type: String, default: null },
      assetPath: { type: String, default: null },
    },

    strategy: {
      type: String,
      enum: ["gemini_keyframe", "reference_composite", "removal_only", null],
      default: null,
    },

    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      stage: { type: String, default: null },
    },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, any>) {
        ret.id = ret._id?.toString?.() ?? ret._id;
        delete ret._id;
        delete ret.__v;
        // Filesystem paths are an internal detail — the client addresses
        // artifacts through /api/jobs/:id/output and /:id/mask instead.
        if (ret.source) {
          delete ret.source.videoPath;
          delete ret.source.refImagePath;
        }
        delete ret.artifacts;
        return ret;
      },
    },
  },
);

/** Total wall-clock processing time, surfaced in the history list. */
jobSchema.virtual("elapsedMs").get(function (this: IJob) {
  if (!this.startedAt) return null;
  return (this.finishedAt ?? new Date()).getTime() - this.startedAt.getTime();
});

/** True once an output video exists and can be streamed. */
jobSchema.virtual("hasOutput").get(function (this: IJob) {
  return Boolean(this.artifacts?.outputPath);
});

jobSchema.index({ createdAt: -1 });

export type JobDoc = HydratedDocument<IJob>;

export const Job: Model<IJob> = mongoose.model<IJob>("Job", jobSchema);
