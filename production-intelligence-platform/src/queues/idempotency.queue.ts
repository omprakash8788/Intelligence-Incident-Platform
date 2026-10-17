import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import type {
  IdempotencyJobData
} from "./jobs/idempotency.job.js";

import type {
  IdempotentEffectResult
} from "../services/idempotent-effect.service.js";

export const IDEMPOTENCY_QUEUE_NAME =
  "idempotency-demo";

export const idempotencyQueue = new Queue<
  IdempotencyJobData,
  IdempotentEffectResult
>(
  IDEMPOTENCY_QUEUE_NAME,
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

export const waitForIdempotencyQueueReady =
  async (): Promise<void> => {
    await idempotencyQueue.waitUntilReady();
  };

export const closeIdempotencyQueue =
  async (): Promise<void> => {
    await idempotencyQueue.close();
  };