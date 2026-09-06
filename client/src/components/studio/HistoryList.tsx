import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, History } from "lucide-react";
import { deleteJob, listJobs } from "@/lib/api";
import type { Job } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_DOT: Record<Job["status"], string> = {
  completed: "bg-ok",
  failed: "bg-bad",
  processing: "bg-accent animate-pulse",
  queued: "bg-warn",
  parsing: "bg-warn",
};

/**
 * Past renders, read back from MongoDB.
 *
 * This is what makes the database more than a write-only log: jobs, plans and
 * results persist across restarts and can be reopened, which is also the
 * cheapest way to re-show a good result without re-rendering it.
 */
export function HistoryList({ activeId, onSelect }: Props) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => listJobs(15),
    // Picks up jobs finishing in other tabs without a manual refresh.
    refetchInterval: 10_000,
  });

  const remove = useMutation({
    mutationFn: deleteJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const jobs = data?.jobs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center gap-2">
        <History size={12} className="text-ink-faint" />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          History
        </h3>
        {jobs.length > 0 && (
          <span className="tnum ml-auto text-[11px] text-ink-faint">{data?.total}</span>
        )}
      </div>

      <div className="-mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {isLoading && <p className="py-3 text-[11px] text-ink-faint">Loading…</p>}

        {!isLoading && jobs.length === 0 && (
          <p className="py-3 text-[11px] leading-relaxed text-ink-faint">
            No renders yet. Your finished jobs will collect here.
          </p>
        )}

        {jobs.map((job) => (
          <div
            key={job.id}
            className={cn(
              "group relative cursor-pointer rounded-lg border px-2.5 py-2 transition",
              job.id === activeId
                ? "border-accent/40 bg-accent/[0.06]"
                : "border-transparent hover:border-line hover:bg-surface-2",
            )}
            onClick={() => onSelect(job.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onSelect(job.id)}
          >
            <div className="flex items-center gap-2">
              <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[job.status])} />
              <span className="truncate text-[12px] text-ink-dim" title={job.prompt}>
                {job.prompt}
              </span>
            </div>

            <div className="mt-1 flex items-center gap-2 pl-3.5">
              <span className="text-[10px] text-ink-faint">{timeAgo(job.createdAt)}</span>
              {job.plan?.operation && (
                <span className="rounded border border-line px-1 font-mono text-[9px] uppercase text-ink-faint">
                  {job.plan.operation}
                </span>
              )}
            </div>

            {job.status !== "processing" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove.mutate(job.id);
                }}
                aria-label="Delete job"
                className="absolute right-1.5 top-1.5 hidden rounded p-1 text-ink-faint transition hover:bg-bad/15 hover:text-bad group-hover:block"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
