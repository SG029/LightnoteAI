import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// One .env at the repo root feeds all three services, so there is a single
// place to put the Gemini key rather than three copies drifting apart.
const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const ROOT_DIR = resolve(serverDir, "..");

dotenv.config({ path: join(ROOT_DIR, ".env") });

/** Coerces "1"/"true"/"yes" to a boolean, defaulting to false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => /^(1|true|yes)$/i.test(v ?? ""));

const schema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required — see .env.example"),
  GEMINI_TEXT_MODEL: z.string().default("gemini-3.5-flash"),
  GEMINI_IMAGE_MODEL: z.string().default("gemini-3.1-flash-image"),

  MONGODB_URI: z.string().default("mongodb://localhost:27017/lightedit"),

  PORT: z.coerce.number().int().positive().default(4000),
  ML_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  INTERNAL_SECRET: z.string().min(1).default("change-me-to-anything"),

  MAX_VIDEO_MB: z.coerce.number().positive().default(100),
  MAX_DURATION_SEC: z.coerce.number().positive().default(15),
  TARGET_HEIGHT: z.coerce.number().int().positive().default(720),
  FORCE_CPU: boolish,

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `    • ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`\n  ✗ Invalid environment configuration:\n\n${issues}\n\n  Copy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isDev: env.NODE_ENV === "development",

  /** Absolute paths for the shared artifact directories. */
  paths: {
    root: ROOT_DIR,
    uploads: join(ROOT_DIR, "storage", "uploads"),
    frames: join(ROOT_DIR, "storage", "frames"),
    outputs: join(ROOT_DIR, "storage", "outputs"),
  },

  maxVideoBytes: env.MAX_VIDEO_MB * 1024 * 1024,
} as const;

export type Config = typeof config;
