import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_NORMALIZE_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineNormalizeData,
  PipelineNormalizeResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

export const pipelineNormalizeWorker =
  new Worker<
    PipelineNormalizeData,
    PipelineNormalizeResult
  >(
    PIPELINE_NORMALIZE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline normalization started",
        {
          queue:
            PIPELINE_NORMALIZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      const normalizedText =
        job.data.originalText
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase();

      const result: PipelineNormalizeResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          job.data.originalText,

        normalizedText
      };

      logger.info(
        "Pipeline normalization completed",
        {
          queue:
            PIPELINE_NORMALIZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 5
    }
  );

pipelineNormalizeWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline normalization failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineNormalizeWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline normalization worker error",
      {
        error: error.message
      }
    );
  }
);