import { useEffect, useRef, useState } from "react";
import { getJob, streamUrl } from "@/lib/api";
import type { Job, Stage, StageName, StageStatus, Strategy } from "@/lib/types";

interface StageEvent {
  stage: StageName;
  status: StageStatus;
  progress: number;
  detail: string | null;
  ms: number | null;
  strategy: Strategy | null;
}

/**
 * Live job state over Server-Sent Events, with polling as a safety net.
 *
 * SSE is the primary channel because stage transitions should appear the
 * instant they happen, not up to a second later. But an EventSource can fail
 * for reasons that have nothing to do with the job — a proxy restart, a
 * suspended laptop — and silently freezing the progress UI would be worse
 * than being a second behind. So a failed stream degrades to polling rather
 * than surfacing an error.
 */
export function useJobStream(jobId: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<"sse" | "polling" | null>(null);

  // Read inside intervals without making them a dependency, which would tear
  // down and rebuild the timer on every progress tick.
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setTransport(null);
      setConnected(false);
      return;
    }

    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const isTerminal = (status?: string) => status === "completed" || status === "failed";

    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setTransport("polling");

      pollTimer = setInterval(async () => {
        try {
          const { job: fresh } = await getJob(jobId);
          if (cancelled) return;
          setJob(fresh);
          setConnected(true);
          if (isTerminal(fresh.status) && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          setConnected(false);
        }
      }, 1000);
    };

    // Seed immediately so the UI has data before the first event arrives.
    getJob(jobId)
      .then(({ job: initial }) => {
        if (!cancelled) setJob(initial);
      })
      .catch(() => {});

    try {
      source = new EventSource(streamUrl(jobId));

      source.addEventListener("open", () => {
        if (cancelled) return;
        setConnected(true);
        setTransport("sse");
      });

      source.addEventListener("snapshot", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { job: Job };
        if (!cancelled) setJob(data.job);
      });

      // Patch the single changed stage rather than refetching the whole job —
      // this fires many times per second during per-frame loops.
      source.addEventListener("stage", (event) => {
        const update = JSON.parse((event as MessageEvent).data) as StageEvent;
        setJob((current) => {
          if (!current) return current;
          const stages: Stage[] = current.stages.map((stage) =>
            stage.name === update.stage
              ? {
                  ...stage,
                  status: update.status,
                  progress: update.progress,
                  detail: update.detail,
                  ms: update.ms,
                }
              : stage,
          );
          return { ...current, stages, strategy: update.strategy ?? current.strategy };
        });
      });

      source.addEventListener("status", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { status: Job["status"] };
        setJob((current) => (current ? { ...current, status: data.status } : current));
      });

      // Terminal events carry only a summary, so refetch once for the
      // authoritative record (artifact flags, timings, final strategy).
      const finish = () => {
        source?.close();
        getJob(jobId)
          .then(({ job: final }) => {
            if (!cancelled) setJob(final);
          })
          .catch(() => {});
      };

      source.addEventListener("done", finish);
      source.addEventListener("error", (event) => {
        // A payload means the job failed; no payload means the connection did.
        if ((event as MessageEvent).data) {
          finish();
          return;
        }
        setConnected(false);
        source?.close();
        source = null;
        if (!isTerminal(jobRef.current?.status)) startPolling();
      });
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [jobId]);

  return { job, connected, transport };
}
