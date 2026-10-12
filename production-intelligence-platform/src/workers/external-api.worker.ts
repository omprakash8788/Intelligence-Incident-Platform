import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  EXTERNAL_API_QUEUE_NAME,
  EXTERNAL_API_RATE_LIMIT
} from "../queues/external-api.queue.js";

import type {
  ExternalApiJobData,
  ExternalApiJobResult
} from "../queues/jobs/external-api.job.js";

import {
  logger
} from "../logging/logger.js";

const simulateExternalApiRequest =
  async (
    data: ExternalApiJobData
  ): Promise<ExternalApiJobResult> => {
    // Simulate a short external API request.
    // Replace this function with a real HTTP client later.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    return {
      requestId: data.requestId,
      processedAt: new Date().toISOString(),
      success: true
    };
  };

export const externalApiWorker =
  new Worker<
    ExternalApiJobData,
    ExternalApiJobResult
  >(
    EXTERNAL_API_QUEUE_NAME,

    async (job) => {
      logger.info(
        "External API job started",
        {
          queue: EXTERNAL_API_QUEUE_NAME,
          jobId: job.id,
          requestId: job.data.requestId
        }
      );

      const result =
        await simulateExternalApiRequest(
          job.data
        );

      logger.info(
        "External API job completed",
        {
          queue: EXTERNAL_API_QUEUE_NAME,
          jobId: job.id,
          requestId: result.requestId,
          processedAt: result.processedAt
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 5,

      limiter: {
        max:
          EXTERNAL_API_RATE_LIMIT.max,

        duration:
          EXTERNAL_API_RATE_LIMIT.duration
      }
    }
  );

externalApiWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "External API job failed",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        jobId: job?.id,
        error: error.message
      }
    );
  }
);

externalApiWorker.on(
  "error",
  (error) => {
    logger.error(
      "External API worker error",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        error: error.message
      }
    );
  }
);