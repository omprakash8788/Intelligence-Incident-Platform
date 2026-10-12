import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import type {
  ExternalApiJobData,
  ExternalApiJobResult
} from "./jobs/external-api.job.js";

export const EXTERNAL_API_QUEUE_NAME =
  "external-api";

export const EXTERNAL_API_RATE_LIMIT = {
  max: 3,
  duration: 5000
} as const;

export const externalApiQueue = new Queue<
  ExternalApiJobData,
  ExternalApiJobResult
>(
  EXTERNAL_API_QUEUE_NAME,
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

