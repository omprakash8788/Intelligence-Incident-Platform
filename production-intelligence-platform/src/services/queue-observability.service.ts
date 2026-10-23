import {
  demoQueue,
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  externalApiQueue,
  EXTERNAL_API_QUEUE_NAME
} from "../queues/external-api.queue.js";

import type {
  QueueHealth
} from "./demo-queue-metrics.service.js";

export interface QueueObservabilitySnapshot {
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

const MAX_WAITING_JOBS = 10;

const collectQueueMetrics = async (
  queueName: string,
  queue: typeof demoQueue
): Promise<QueueObservabilitySnapshot> => {
  const counts = await queue.getJobCounts(
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

  const backlog = normalizedCounts.waiting;

  const health: QueueHealth =
    backlog > MAX_WAITING_JOBS
      ? "degraded"
      : "healthy";

  return {
    queue: queueName,
    counts: normalizedCounts,
    backlog,
    health,
    thresholds: {
      maxWaiting: MAX_WAITING_JOBS
    },
    sampledAt: new Date().toISOString()
  };
};

export const getQueueObservability = async () => {
  const queues = await Promise.all([
    collectQueueMetrics(
      DEMO_QUEUE_NAME,
      demoQueue
    ),
    collectQueueMetrics(
      EXTERNAL_API_QUEUE_NAME,
      externalApiQueue
    )
  ]);

  return {
    queues,
    sampledAt: new Date().toISOString()
  };
};