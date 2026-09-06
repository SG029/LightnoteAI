import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { editPlanSchema, type EditPlan } from "../types.js";
import { logger } from "../lib/logger.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

/**
 * Handed to Gemini as `response_format.schema` so the model is constrained
 * to emit exactly this shape. Written as literal JSON Schema rather than
 * generated from the zod type because the `description` strings are load-
 * bearing prompt engineering — they are what teach the model that `target`
 * must be *groundable by a vision model*, not just a paraphrase of the
 * user's words. The zod schema still validates the response afterwards.
 */
const EDIT_PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["replace", "remove"],
      description:
        "'replace' to swap the target for something else. 'remove' to erase it and fill in the background.",
    },
    target: {
      type: "string",
      description:
        "The object to act on, as a concise visual noun phrase that an object detector can locate in a frame. " +
        "Prefer concrete appearance over abstract reference: 'red Coca-Cola bottle', not 'the drink he mentioned'.",
    },
    replacement: {
      type: ["string", "null"],
      description:
        "What the target should become, described visually. Null when operation is 'remove'.",
    },
    targetHint: {
      type: ["string", "null"],
      description:
        "A spatial disambiguator, used only when the frame plausibly contains several matching objects. " +
        "Example: 'the one in the person's right hand'. Null if the target is unambiguous.",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1. How confidently this instruction maps onto a concrete video edit. " +
        "Score low for vague ('make it better'), contradictory, or non-visual instructions.",
    },
    reasoning: {
      type: "string",
      description: "One short sentence explaining the interpretation. Shown to the user in the UI.",
    },
  },
  required: ["operation", "target", "replacement", "targetHint", "confidence", "reasoning"],
} as const;

const SYSTEM_INSTRUCTION = `
You convert natural-language video editing instructions into a structured edit plan.

The downstream pipeline can do exactly two things:
  • replace — erase an object and composite a different one in its place
  • remove  — erase an object and inpaint the background behind it

Rules:
1. "target" must be something an open-vocabulary object detector can find in a
   single frame. Translate abstract references into visual descriptions.
2. Brand and text swaps are "replace" operations. For "Replace Coca-Cola with
   Pepsi", the target is the visible Coca-Cola product (bottle, can, or logo) —
   not the word itself.
3. If the user asks for anything outside replace/remove — colour grading, adding
   objects that are not replacing something, style transfer, speed changes,
   audio edits — set confidence below 0.4 and explain why in "reasoning".
4. Never invent a target that the instruction does not mention.
5. Keep "reasoning" to one sentence, written for the user, not for a developer.
`.trim();

/** Instructions scoring below this are rejected rather than silently mis-edited. */
const MIN_CONFIDENCE = 0.4;

/**
 * Pulls the assistant's text out of an interaction response.
 *
 * The May 2026 schema change replaced the flat `outputs[]` array with
 * `steps[]`, where each step carries a type discriminator and its own content
 * blocks. `output_text` is the supported convenience accessor and is tried
 * first; the manual walk exists because a response containing thought or
 * tool steps alongside the answer must still yield only the answer text.
 * The legacy path is kept so an older SDK degrades rather than returning "".
 */
function extractText(interaction: unknown): string {
  const it = interaction as {
    output_text?: string;
    steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    outputs?: Array<{ type?: string; text?: string }>;
  };

  if (typeof it.output_text === "string" && it.output_text.trim()) {
    return it.output_text.trim();
  }

  const fromSteps = (it.steps ?? [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();

  if (fromSteps) return fromSteps;

  return (it.outputs ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

/** Retries on transient upstream failures with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const status = (err as { status?: number })?.status;
      // 4xx other than 429 will fail identically on retry — surface immediately.
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      const backoffMs = 2 ** (attempt - 1) * 500;
      logger.warn({ attempt, backoffMs, label }, "Gemini call failed, retrying");
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  throw lastError;
}

/**
 * Turns "Replace the Coca-Cola bottle with Pepsi" into
 * { operation: 'replace', target: 'Coca-Cola bottle', replacement: 'Pepsi', ... }
 *
 * Runs before the job is dispatched so an unusable instruction costs the user
 * one second, not a full render.
 */
export async function parseInstruction(prompt: string): Promise<EditPlan> {
  const started = Date.now();

  let raw: string;
  try {
    const interaction = await withRetry(
      () =>
        ai.interactions.create({
          model: config.GEMINI_TEXT_MODEL,
          system_instruction: SYSTEM_INSTRUCTION,
          input: `Instruction: ${prompt}`,
          // The schema nests inside response_format. Passing it flat with a
          // sibling response_mime_type — which the SDK's own docstring implies
          // — is rejected with "responseFormat must be set when
          // responseMimeType is set". Verified against the live API.
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: EDIT_PLAN_JSON_SCHEMA,
          },
          // Reproducibility: the same instruction should yield the same plan,
          // so a bad edit can be debugged by re-running it. `temperature` was
          // removed from generation_config in the v2 schema; `seed` is the
          // supported control now.
          generation_config: { seed: 7 },
        }),
      "parseInstruction",
    );

    raw = extractText(interaction);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    logger.error({ err, status }, "Gemini intent parsing failed");

    if (status === 429) {
      throw AppError.upstream(
        "gemini_rate_limited",
        "Gemini rate limit reached. Wait a moment and try again.",
      );
    }
    if (status === 401 || status === 403) {
      throw AppError.upstream(
        "gemini_auth_failed",
        "Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.",
      );
    }
    throw AppError.upstream(
      "gemini_unavailable",
      "Could not reach Gemini to interpret the instruction.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error({ raw }, "Gemini returned non-JSON despite response_format");
    throw AppError.upstream("gemini_bad_response", "Gemini returned an unreadable response.");
  }

  const result = editPlanSchema.safeParse(parsed);
  if (!result.success) {
    logger.error({ parsed, issues: result.error.issues }, "Gemini response failed schema validation");
    throw AppError.upstream("gemini_bad_response", "Gemini returned an unexpected plan shape.");
  }

  const plan = result.data;

  if (plan.confidence < MIN_CONFIDENCE) {
    throw AppError.badRequest(
      "instruction_unclear",
      plan.reasoning ||
        "That instruction could not be mapped to a replace or remove operation. Try something like \"Replace the bottle with a Pepsi can\".",
      { confidence: plan.confidence },
    );
  }

  if (plan.operation === "replace" && !plan.replacement) {
    throw AppError.badRequest(
      "missing_replacement",
      "The instruction asks for a replacement but does not say what to replace it with.",
    );
  }

  logger.info({ ms: Date.now() - started, plan }, "Parsed instruction");
  return plan;
}

/** Used by /api/health to report whether the Gemini key actually works. */
export async function checkGeminiReachable(): Promise<{ ok: boolean; detail: string }> {
  try {
    await ai.interactions.create({
      model: config.GEMINI_TEXT_MODEL,
      input: "Reply with the single word: ok",
    });
    return { ok: true, detail: `${config.GEMINI_TEXT_MODEL} responded` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
