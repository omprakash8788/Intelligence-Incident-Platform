import {
  demoQueue,
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

export type QueueHealth =
  | "healthy"
  | "degraded";

const MAX_WAITING_JOBS = 10;

export interface DemoQueueMetrics {
  queue: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    waitingChildren: number;
  };
  backlog: number;
  health: QueueHealth;
  thresholds: {
    maxWaiting: number;
  };
  sampledAt: string;
}

export const getDemoQueueMetrics =
  async (): Promise<DemoQueueMetrics> => {
    const counts =
      await demoQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed",
        "waiting-children"
      );

    const normalizedCounts = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      waitingChildren:
        counts["waiting-children"] ?? 0
    };

    const backlog =
      normalizedCounts.waiting;

    const health: QueueHealth =
      backlog > MAX_WAITING_JOBS
        ? "degraded"
        : "healthy";

    return {
      queue: DEMO_QUEUE_NAME,
      counts: normalizedCounts,
      backlog,
      health,
      thresholds: {
        maxWaiting: MAX_WAITING_JOBS
      },
      sampledAt: new Date().toISOString()
    };
  };