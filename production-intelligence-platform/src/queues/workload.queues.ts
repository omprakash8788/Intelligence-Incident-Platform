import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "./workload.queue-names.js";

import type {
  WorkloadJobData,
  WorkloadJobResult
} from "./jobs/workload.job.js";

export const interactiveWorkloadQueue = new Queue<
  WorkloadJobData,
  WorkloadJobResult
>(
  INTERACTIVE_WORKLOAD_QUEUE,
  {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const batchWorkloadQueue = new Queue<
  WorkloadJobData,
  WorkloadJobResult
>(
  BATCH_WORKLOAD_QUEUE,
  {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const waitForWorkloadQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      interactiveWorkloadQueue.waitUntilReady(),
      batchWorkloadQueue.waitUntilReady()
    ]);
  };

export const closeWorkloadQueues =
  async (): Promise<void> => {
    await Promise.allSettled([
      interactiveWorkloadQueue.close(),
      batchWorkloadQueue.close()
    ]);
  };