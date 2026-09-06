import { Check, X, Minus, Loader2, Circle } from "lucide-react";
import { motion } from "framer-motion";
import { STAGE_HINTS, STAGE_LABELS, type Stage } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

interface Props {
  stages: Stage[];
  queuePosition?: number | null;
}

const STATUS_STYLES = {
  done: { ring: "border-ok/40 bg-ok/10 text-ok", text: "text-ink" },
  running: { ring: "border-accent/50 bg-accent/10 text-accent", text: "text-ink" },
  failed: { ring: "border-bad/50 bg-bad/10 text-bad", text: "text-bad" },
  skipped: { ring: "border-line bg-surface-2 text-ink-faint", text: "text-ink-faint" },
  pending: { ring: "border-line bg-surface-2 text-ink-faint", text: "text-ink-faint" },
} as const;

function StageIcon({ status }: { status: Stage["status"] }) {
  switch (status) {
    case "done":
      return <Check size={12} strokeWidth={3} />;
    case "running":
      return <Loader2 size={12} className="animate-spin" />;
    case "failed":
      return <X size={12} strokeWidth={3} />;
    case "skipped":
      return <Minus size={12} strokeWidth={3} />;
    default:
      return <Circle size={5} fill="currentColor" />;
  }
}

/**
 * The live pipeline view.
 *
 * Each stage names what it is actually doing, not a generic "processing"
 * spinner — the point is to make an opaque three-minute wait legible, and to
 * show a viewer that six distinct pieces of machinery are involved.
 */
export function PipelineTimeline({ stages, queuePosition }: Props) {
  const activeIndex = stages.findIndex((s) => s.status === "running");

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Pipeline
        </h3>
        {queuePosition != null && queuePosition > 0 && (
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-dim">
            {queuePosition} ahead in queue
          </span>
        )}
      </div>

      <ol className="relative">
        {stages.map((stage, index) => {
          const styles = STATUS_STYLES[stage.status];
          const isActive = index === activeIndex;
          const isLast = index === stages.length - 1;

          return (
            <li key={stage.name} className="relative flex gap-3 pb-4 last:pb-0">
              {/* Connector rail, brightened for stages already passed. */}
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-[11px] top-6 h-[calc(100%-14px)] w-px",
                    stage.status === "done" || stage.status === "skipped"
                      ? "bg-ok/25"
                      : "bg-line-soft",
                  )}
                />
              )}

              <span
                className={cn(
                  "relative z-10 mt-0.5 grid size-[23px] shrink-0 place-items-center rounded-full border",
                  styles.ring,
                )}
              >
                <StageIcon status={stage.status} />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("text-[13px] font-medium", styles.text)}>
                    {STAGE_LABELS[stage.name]}
                  </span>
                  {stage.ms != null && stage.status !== "running" && (
                    <span className="tnum shrink-0 text-[11px] text-ink-faint">
                      {formatDuration(stage.ms)}
                    </span>
                  )}
                </div>

                <p
                  className={cn(
                    "mt-0.5 truncate text-[11px]",
                    stage.detail ? "text-ink-dim" : "text-ink-faint",
                  )}
                  title={stage.detail ?? STAGE_HINTS[stage.name]}
                >
                  {stage.detail ?? STAGE_HINTS[stage.name]}
                </p>

                {isActive && (
                  <div className="relative mt-2 h-[3px] overflow-hidden rounded-full bg-surface-3">
                    {stage.progress > 0 ? (
                      <motion.div
                        className="h-full rounded-full bg-accent"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(stage.progress * 100)}%` }}
                        transition={{ ease: "linear", duration: 0.25 }}
                      />
                    ) : (
                      // No meaningful fraction yet (loading a model, waiting on
                      // an API call) — an indeterminate bar is honest here.
                      <div className="shimmer absolute inset-0" />
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
