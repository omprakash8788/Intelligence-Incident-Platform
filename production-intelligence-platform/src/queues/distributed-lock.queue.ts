import { Queue } from "bullmq";

import { createBullMQConnection } from "./bullmq.connection.js";

import type { DistributedLockJobData } from "./jobs/distributed-lock.job.js";

export const DISTRIBUTED_LOCK_QUEUE_NAME =
  "distributed-lock-demo";

export const distributedLockQueue =
  new Queue<DistributedLockJobData>(
    DISTRIBUTED_LOCK_QUEUE_NAME,
    {
      connection: createBullMQConnection(1),

      defaultJobOptions: {
        attempts: 5,

        backoff: {
          type: "exponential",
          delay: 1000
        },

        removeOnComplete: 100,
        removeOnFail: 500
      }
    }
  );