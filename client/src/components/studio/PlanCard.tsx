import { motion } from "framer-motion";
import { Sparkles, ArrowRight } from "lucide-react";
import type { EditPlan } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Renders the structured plan Gemini extracted from the instruction.
 *
 * This is the most important element on the page for explaining the product:
 * it turns "AI integration" from a claim into something visible. A viewer sees
 * free-form English become typed fields in about a second, before any video
 * processing starts.
 */
export function PlanCard({ plan }: { plan: EditPlan }) {
  if (!plan?.operation) return null;

  const confidence = plan.confidence ?? 0;
  const confidenceTone =
    confidence >= 0.8 ? "text-ok" : confidence >= 0.5 ? "text-warn" : "text-bad";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden rounded-xl border border-accent/25 bg-gradient-to-b from-accent/[0.07] to-transparent"
    >
      <div className="flex items-center gap-2 border-b border-accent/15 px-3.5 py-2">
        <Sparkles size={13} className="text-accent" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          Instruction understood
        </span>
        <span className={cn("tnum ml-auto text-[11px] font-medium", confidenceTone)}>
          {Math.round(confidence * 100)}%
        </span>
      </div>

      <div className="space-y-2 px-3.5 py-3">
        <Row label="operation">
          <span className="rounded-md border border-violet/30 bg-violet/10 px-1.5 py-0.5 font-mono text-[11px] text-violet">
            {plan.operation}
          </span>
        </Row>

        <Row label="target">
          <span className="font-mono text-[12px] text-ink">{plan.target}</span>
        </Row>

        {plan.replacement && (
          <Row label="replacement">
            <span className="flex items-center gap-1.5">
              <ArrowRight size={11} className="text-ink-faint" />
              <span className="font-mono text-[12px] text-accent">{plan.replacement}</span>
            </span>
          </Row>
        )}

        {plan.targetHint && (
          <Row label="hint">
            <span className="text-[12px] text-ink-dim">{plan.targetHint}</span>
          </Row>
        )}
      </div>

      {plan.reasoning && (
        <p className="border-t border-accent/10 px-3.5 py-2 text-[11px] leading-relaxed text-ink-faint">
          {plan.reasoning}
        </p>
      )}
    </motion.div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[86px] shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}
