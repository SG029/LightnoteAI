import { EventEmitter } from "node:events";

export interface JobEvent {
  type: "stage" | "status" | "done" | "error";
  jobId: string;
  payload: unknown;
}

/**
 * Fan-out for live job progress: the internal webhook from the Python worker
 * publishes here, and every open SSE connection for that job receives it.
 *
 * In-process only, which is correct for this deployment — a single Express
 * instance owns the single GPU worker. Scaling to multiple API replicas would
 * mean swapping this for Redis pub/sub, and nothing outside this file would
 * need to change.
 */
class JobEventBus extends EventEmitter {
  constructor() {
    super();
    // One listener per open browser tab watching a job; the default cap of 10
    // is easy to exceed during development with hot reloads.
    this.setMaxListeners(100);
  }

  publish(jobId: string, event: Omit<JobEvent, "jobId">) {
    this.emit(jobId, { ...event, jobId } satisfies JobEvent);
  }

  subscribe(jobId: string, handler: (event: JobEvent) => void): () => void {
    this.on(jobId, handler);
    return () => this.off(jobId, handler);
  }
}

export const jobEvents = new JobEventBus();
