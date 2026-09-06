import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Zap, ArrowRight, Brain, Crosshair, Route, Eraser, Layers3, Film, Github,
} from "lucide-react";

/**
 * Marketing surface — intentionally light, where the studio is dark.
 *
 * Its job is to explain the pipeline before someone uses it, because the
 * interesting part of this project is the six stages, not the upload form.
 */

const STAGES = [
  {
    icon: Brain,
    name: "Understand",
    tech: "Gemini · structured output",
    body: "The instruction is parsed into a typed edit plan — operation, target, replacement — not passed through as a raw string.",
  },
  {
    icon: Crosshair,
    name: "Locate",
    tech: "Gemini · spatial grounding",
    body: "The target is found in a keyframe. Gemini is used over CLIP-based detectors because it knows brands, not just categories.",
  },
  {
    icon: Route,
    name: "Track",
    tech: "SAM 2 · video propagation",
    body: "One box becomes a mask on every frame. SAM 2's streaming memory keeps the mask attached through motion and occlusion.",
  },
  {
    icon: Eraser,
    name: "Erase",
    tech: "LaMa · feed-forward inpainting",
    body: "The object is removed and the background reconstructed. Deterministic, so consecutive frames agree instead of boiling.",
  },
  {
    icon: Layers3,
    name: "Composite",
    tech: "Generate once, track everywhere",
    body: "The replacement is rendered a single time and follows the tracked path — temporally stable by construction.",
  },
  {
    icon: Film,
    name: "Encode",
    tech: "ffmpeg · H.264",
    body: "Frames are muxed back to MP4 with the original audio track carried across untouched.",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-paper text-paper-ink">
      {/* ── Nav ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-paper-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3.5">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-violet">
            <Zap size={15} className="text-[#04222a]" fill="currentColor" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">LightEdit</span>

          <nav className="ml-auto flex items-center gap-5 text-[13px] text-paper-ink-dim">
            <a href="#how" className="transition hover:text-paper-ink">
              How it works
            </a>
            <a href="#stack" className="transition hover:text-paper-ink">
              Stack
            </a>
            <Link
              to="/studio"
              className="rounded-lg bg-paper-ink px-3.5 py-1.5 font-medium text-paper transition hover:opacity-90"
            >
              Open studio
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-paper-line">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.5]"
          style={{
            background:
              "radial-gradient(60% 55% at 50% 0%, rgba(34,211,238,0.16) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-5xl px-6 pb-20 pt-20 text-center">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-paper-line bg-paper-2 px-3 py-1 text-[12px] text-paper-ink-dim">
              <span className="size-1.5 rounded-full bg-accent" />
              Gemini · SAM 2 · LaMa
            </span>

            <h1 className="mx-auto mt-6 max-w-3xl text-[44px] font-extrabold leading-[1.08] tracking-[-0.03em] sm:text-[58px]">
              Edit objects in video by
              <span className="bg-gradient-to-r from-accent to-violet bg-clip-text text-transparent">
                {" "}
                just saying so
              </span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-paper-ink-dim">
              Upload a clip, describe the change in plain English, and get it back
              edited. Replace a product, remove it entirely — the object is tracked
              frame by frame, not pasted on.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/studio"
                className="group flex items-center gap-2 rounded-xl bg-paper-ink px-5 py-3 text-[14px] font-semibold text-paper transition hover:opacity-90"
              >
                Open the studio
                <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
              </Link>
              <a
                href="#how"
                className="flex items-center gap-2 rounded-xl border border-paper-line px-5 py-3 text-[14px] font-medium text-paper-ink-dim transition hover:border-paper-ink/25 hover:text-paper-ink"
              >
                See the pipeline
              </a>
            </div>
          </motion.div>

          {/* Instruction → plan, the core idea in one graphic. */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className="mx-auto mt-14 max-w-2xl overflow-hidden rounded-2xl border border-paper-line bg-paper-2 shadow-[0_20px_60px_-25px_rgba(0,0,0,0.25)]"
          >
            <div className="flex items-center gap-1.5 border-b border-paper-line px-4 py-2.5">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-[11px] text-paper-ink-dim">
                POST /api/jobs
              </span>
            </div>

            <div className="space-y-3 p-5 text-left font-mono text-[12.5px]">
              <div>
                <span className="text-paper-ink-dim">prompt </span>
                <span className="text-paper-ink">
                  "Replace the Coca-Cola bottle with Pepsi"
                </span>
              </div>

              <div className="flex items-center gap-2 text-paper-ink-dim">
                <span className="h-px flex-1 bg-paper-line" />
                <span className="text-[10px] uppercase tracking-wider">Gemini</span>
                <span className="h-px flex-1 bg-paper-line" />
              </div>

              <pre className="overflow-x-auto rounded-lg bg-paper p-3.5 leading-relaxed">
                <span className="text-paper-ink-dim">{"{"}</span>
                {"\n  "}
                <span className="text-violet">"operation"</span>
                <span className="text-paper-ink-dim">: </span>
                <span className="text-accent-dim">"replace"</span>
                <span className="text-paper-ink-dim">,</span>
                {"\n  "}
                <span className="text-violet">"target"</span>
                <span className="text-paper-ink-dim">: </span>
                <span className="text-accent-dim">"Coca-Cola bottle"</span>
                <span className="text-paper-ink-dim">,</span>
                {"\n  "}
                <span className="text-violet">"replacement"</span>
                <span className="text-paper-ink-dim">: </span>
                <span className="text-accent-dim">"Pepsi"</span>
                {"\n"}
                <span className="text-paper-ink-dim">{"}"}</span>
              </pre>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Pipeline ────────────────────────────────────────────────── */}
      <section id="how" className="border-b border-paper-line py-20">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-[30px] font-bold tracking-tight">Six stages</h2>
          <p className="mt-2 max-w-lg text-[15px] text-paper-ink-dim">
            Each one does a single job, reports its own progress, and degrades
            gracefully if the stage below it cannot run.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STAGES.map((stage, index) => (
              <motion.div
                key={stage.name}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.4, delay: index * 0.05 }}
                className="rounded-xl border border-paper-line bg-paper-2 p-5 transition hover:border-paper-ink/15"
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid size-8 place-items-center rounded-lg bg-paper text-accent-dim ring-1 ring-paper-line">
                    <stage.icon size={15} />
                  </span>
                  <span className="tnum font-mono text-[11px] text-paper-ink-dim">
                    0{index + 1}
                  </span>
                </div>

                <h3 className="mt-3.5 text-[15px] font-semibold">{stage.name}</h3>
                <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wider text-accent-dim">
                  {stage.tech}
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-paper-ink-dim">
                  {stage.body}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stack ───────────────────────────────────────────────────── */}
      <section id="stack" className="border-b border-paper-line py-20">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <h2 className="text-[30px] font-bold tracking-tight">
              Two services, each in the right language
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-paper-ink-dim">
              Express owns the API, job lifecycle and MongoDB. A FastAPI worker owns
              the GPU pipeline, with models kept warm in memory between jobs. They
              talk over localhost HTTP, and the worker streams stage-level progress
              back through a webhook.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper-ink-dim">
              Splitting them means Node never blocks on a three-minute render, and
              Python never has to serve a REST API it would be worse at.
            </p>

            <Link
              to="/studio"
              className="mt-7 inline-flex items-center gap-2 rounded-xl bg-paper-ink px-5 py-3 text-[14px] font-semibold text-paper transition hover:opacity-90"
            >
              Try it <ArrowRight size={15} />
            </Link>
          </div>

          <div className="space-y-2.5">
            {[
              ["Frontend", "React · Vite · TypeScript · Tailwind"],
              ["API", "Express 5 · Mongoose · Zod · multer"],
              ["Database", "MongoDB — jobs, plans, history"],
              ["Worker", "FastAPI · PyTorch CUDA"],
              ["Understanding", "Gemini — structured output + grounding"],
              ["Segmentation", "SAM 2 via HF transformers"],
              ["Inpainting", "LaMa TorchScript"],
              ["Media", "ffmpeg / ffprobe"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 rounded-lg border border-paper-line bg-paper-2 px-4 py-3"
              >
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-right font-mono text-[11.5px] text-paper-ink-dim">
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="py-10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-6 text-[12.5px] text-paper-ink-dim">
          <span>LightEdit — AI video object replacement</span>
          <a
            href="https://github.com"
            className="ml-auto flex items-center gap-1.5 transition hover:text-paper-ink"
          >
            <Github size={14} />
            Source
          </a>
        </div>
      </footer>
    </div>
  );
}
