import { tryCatch, Worker } from "bullmq";

import {
  workerPerformanceMetrics
} from "../services/worker-performance-metrics.service.js";

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

import {
  workerMetrics
} from "../services/worker-metrics.service.js";

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
      const jobId = String(job.id);
      //  workerMetrics.jobStarted();
      workerPerformanceMetrics.jobStarted(jobId);
      logger.info(
        "External API job started",
        {
          queue: EXTERNAL_API_QUEUE_NAME,
          jobId,
          requestId: job.data.requestId
        }
      );

      try {
        const result =
          await simulateExternalApiRequest(
            job.data
          );

        workerPerformanceMetrics.jobCompleted(jobId);
        logger.info(
          "External API job completed",
          {
            queue: EXTERNAL_API_QUEUE_NAME,
            jobId,
            requestId: result.requestId,
            processedAt: result.processedAt
          }
        );
        //  workerMetrics.jobCompleted();
        return result;
      } catch (error) {
        workerPerformanceMetrics.jobFailed(jobId);
        throw error;
      }


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
    if (job && job.attemptsMade < job.opts.attempts!) {
      workerPerformanceMetrics.jobRetried();
    }
    logger.error(
      "External API job failed",
      {
       queue: EXTERNAL_API_QUEUE_NAME,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        configuredAttempts: job?.opts.attempts,
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