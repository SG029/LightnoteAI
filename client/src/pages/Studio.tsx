import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wand2, AlertTriangle, Download, Layers, Film, Loader2, Zap,
} from "lucide-react";

import { Dropzone } from "@/components/ui/Dropzone";
import { PipelineTimeline } from "@/components/studio/PipelineTimeline";
import { PlanCard } from "@/components/studio/PlanCard";
import { CompareSlider } from "@/components/studio/CompareSlider";
import { HistoryList } from "@/components/studio/HistoryList";
import { useJobStream } from "@/hooks/useJobStream";
import { ApiRequestError, createJob, getHealth, maskUrl, outputUrl } from "@/lib/api";
import { STRATEGY_LABELS } from "@/lib/types";
import { cn, formatDuration, formatSeconds } from "@/lib/utils";

const EXAMPLE_PROMPTS = [
  "Replace the red soda can with a Pepsi can",
  "Remove the bottle from the table",
  "Replace the Coca-Cola bottle with Pepsi",
];

export default function Studio() {
  const { jobId: routeJobId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [refImage, setRefImage] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(false);

  const jobId = routeJobId ?? null;
  const { job, transport } = useJobStream(jobId);

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
    retry: false,
  });

  // Local preview of the file being uploaded, so the centre pane is not empty
  // while the user writes their instruction.
  const localPreview = useMemo(
    () => (videoFile ? URL.createObjectURL(videoFile) : null),
    [videoFile],
  );
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const busy = job?.status === "processing" || job?.status === "queued" || submitting;
  const done = job?.status === "completed";
  const failed = job?.status === "failed";

  async function submit() {
    if (!videoFile || prompt.trim().length < 3) return;

    setSubmitting(true);
    setSubmitError(null);
    setUploadPct(0);
    setShowMask(false);

    try {
      const { job: created } = await createJob({
        video: videoFile,
        referenceImage: refImage,
        prompt: prompt.trim(),
        onProgress: setUploadPct,
      });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/studio/${created.id}`);
    } catch (error) {
      setSubmitError(
        error instanceof ApiRequestError
          ? error.message
          : "Something went wrong submitting the job.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setVideoFile(null);
    setRefImage(null);
    setPrompt("");
    setSubmitError(null);
    setShowMask(false);
    navigate("/studio");
  }

  const apiReachable = health?.checks?.mongo?.ok ?? false;
  const mlReachable = health?.checks?.mlService?.ok ?? false;

  return (
    <div className="flex h-screen flex-col bg-canvas">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <Link to="/" className="flex items-center gap-2 text-ink transition hover:opacity-80">
          <span className="grid size-6 place-items-center rounded-md bg-gradient-to-br from-accent to-violet">
            <Zap size={13} className="text-[#04222a]" fill="currentColor" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">LightEdit</span>
        </Link>

        <span className="text-[11px] text-ink-faint">Studio</span>

        <div className="ml-auto flex items-center gap-4">
          {health && (
            <div className="flex items-center gap-3 text-[10px] text-ink-faint">
              <StatusPill ok={apiReachable} label="api" />
              <StatusPill ok={mlReachable} label="gpu worker" />
              <span className="font-mono">{health.models.text}</span>
            </div>
          )}
          {transport && (
            <span className="text-[10px] text-ink-faint">
              {transport === "sse" ? "live" : "polling"}
            </span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr_300px]">
        {/* ── Left: inputs ──────────────────────────────────────────── */}
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line p-4">
          <Dropzone
            kind="video"
            file={videoFile}
            onSelect={setVideoFile}
            label="1 · Source video"
            hint={`MP4, MOV or WebM · max ${health?.limits.maxDurationSec ?? 15}s`}
            disabled={busy}
          />

          <Dropzone
            kind="image"
            file={refImage}
            onSelect={setRefImage}
            label="2 · Reference image"
            hint="The product to insert"
            optional
            disabled={busy}
          />

          <div>
            <label className="mb-2 block text-[13px] font-medium text-ink">
              3 · Instruction
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={500}
              placeholder="Replace the Coca-Cola bottle with Pepsi"
              className="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/50 focus:outline-none disabled:opacity-50"
            />

            <div className="mt-2 flex flex-wrap gap-1">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  disabled={busy}
                  onClick={() => setPrompt(example)}
                  className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-ink-faint transition hover:border-accent/40 hover:text-accent disabled:opacity-40"
                >
                  {example.length > 30 ? `${example.slice(0, 30)}…` : example}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={submit}
            disabled={!videoFile || prompt.trim().length < 3 || busy}
            className="btn-primary flex items-center justify-center gap-2 rounded-lg py-2.5 text-[13px]"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {uploadPct < 1 ? `Uploading ${Math.round(uploadPct * 100)}%` : "Analysing…"}
              </>
            ) : busy ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Processing
              </>
            ) : (
              <>
                <Wand2 size={14} />
                Process video
              </>
            )}
          </button>

          {(job || submitError) && !busy && (
            <button onClick={reset} className="btn-ghost rounded-lg py-2 text-xs">
              Start a new edit
            </button>
          )}

          {submitError && (
            <div className="flex gap-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-bad" />
              <p className="text-[11px] leading-relaxed text-bad">{submitError}</p>
            </div>
          )}

          <div className="mt-auto border-t border-line pt-3">
            <HistoryList
              activeId={jobId}
              onSelect={(id) => navigate(`/studio/${id}`)}
            />
          </div>
        </aside>

        {/* ── Centre: preview ───────────────────────────────────────── */}
        <main className="min-h-0 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl space-y-4">
            <AnimatePresence mode="wait">
              {done && job ? (
                <motion.div
                  key="result"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-4"
                >
                  {showMask ? (
                    <div className="overflow-hidden rounded-xl border border-line bg-black">
                      <img
                        src={maskUrl(job.id)}
                        alt="Segmentation mask overlay"
                        className="w-full"
                      />
                    </div>
                  ) : (
                    <CompareSlider
                      beforeSrc={localPreview ?? outputUrl(job.id)}
                      afterSrc={outputUrl(job.id)}
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setShowMask((v) => !v)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition",
                        showMask
                          ? "border border-accent/40 bg-accent/10 text-accent"
                          : "btn-ghost",
                      )}
                    >
                      <Layers size={13} />
                      {showMask ? "Show comparison" : "Show mask"}
                    </button>

                    <a
                      href={outputUrl(job.id)}
                      download={`lightedit-${job.id}.mp4`}
                      className="btn-ghost flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs"
                    >
                      <Download size={13} />
                      Download
                    </a>

                    {job.strategy && (
                      <span className="ml-auto rounded-md border border-line bg-surface-2 px-2 py-1 text-[10px] text-ink-dim">
                        {STRATEGY_LABELS[job.strategy]}
                      </span>
                    )}
                  </div>

                  {job.strategy === "removal_only" && job.plan.operation === "replace" && (
                    <Notice tone="warn">
                      The object was removed successfully, but no replacement could be
                      generated — so this is a removal, not a swap. Adding a reference
                      image usually fixes this.
                    </Notice>
                  )}
                </motion.div>
              ) : failed && job ? (
                <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Notice tone="bad" title={`Failed at "${job.error.stage ?? "unknown"}"`}>
                    {job.error.message ?? "The job failed for an unknown reason."}
                  </Notice>
                </motion.div>
              ) : localPreview ? (
                <motion.div key="local" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <video
                    src={localPreview}
                    controls
                    muted
                    playsInline
                    className="aspect-video w-full rounded-xl border border-line bg-black object-contain"
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="grid aspect-video place-items-center rounded-xl border border-dashed border-line"
                >
                  <div className="text-center">
                    <Film size={26} className="mx-auto mb-3 text-ink-faint" />
                    <p className="text-sm text-ink-dim">Upload a video to begin</p>
                    <p className="mt-1 text-[11px] text-ink-faint">
                      No footage handy? Run{" "}
                      <code className="rounded bg-surface-2 px-1 font-mono text-accent">
                        npm run sample
                      </code>
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {job?.plan?.operation && <PlanCard plan={job.plan} />}
          </div>
        </main>

        {/* ── Right: pipeline ───────────────────────────────────────── */}
        <aside className="min-h-0 overflow-y-auto border-l border-line p-4">
          {job ? (
            <div className="space-y-5">
              <PipelineTimeline stages={job.stages} />

              <div className="space-y-1.5 border-t border-line pt-4">
                <Meta label="Status" value={job.status} />
                <Meta
                  label="Resolution"
                  value={job.source.width ? `${job.source.width}×${job.source.height}` : "—"}
                />
                <Meta label="Duration" value={formatSeconds(job.source.durationSec)} />
                <Meta label="Frames" value={job.source.frameCount?.toString() ?? "—"} />
                <Meta label="Elapsed" value={formatDuration(job.elapsedMs)} />
              </div>
            </div>
          ) : (
            <div className="pt-6 text-center">
              <p className="text-[11px] leading-relaxed text-ink-faint">
                The processing pipeline will appear here once you start a job.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", ok ? "bg-ok" : "bg-bad")} />
      {label}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-ink-faint">{label}</span>
      <span className="tnum truncate text-[11px] text-ink-dim">{value}</span>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "bad";
  title?: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "bad" ? "border-bad/30 bg-bad/10 text-bad" : "border-warn/30 bg-warn/10 text-warn";

  return (
    <div className={cn("flex gap-2.5 rounded-xl border px-4 py-3", styles)}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div>
        {title && <p className="mb-1 text-[13px] font-semibold">{title}</p>}
        <p className="text-[12px] leading-relaxed opacity-90">{children}</p>
      </div>
    </div>
  );
}
