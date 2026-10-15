import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_ANALYZE_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineAnalyzeData,
  PipelineAnalyzeResult,
  PipelineNormalizeResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

const isPipelineNormalizeResult = (
  value: unknown
): value is PipelineNormalizeResult => {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const result =
    value as Record<string, unknown>;

  return (
    typeof result.workflowId === "string" &&
    typeof result.originalText === "string" &&
    typeof result.normalizedText === "string"
  );
};

export const pipelineAnalyzeWorker =
  new Worker<
    PipelineAnalyzeData,
    PipelineAnalyzeResult
  >(
    PIPELINE_ANALYZE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline analysis started",
        {
          queue:
            PIPELINE_ANALYZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      const childValues =
        await job.getChildrenValues();

      const results: unknown[] =
        Object.values(childValues);

      if (results.length !== 1) {
        throw new Error(
          `Expected one normalization result, received ${results.length}`
        );
      }

      const normalizedResult =
        results.find(
          isPipelineNormalizeResult
        );

      if (!normalizedResult) {
        throw new Error(
          "Normalization result is invalid"
        );
      }

      if (
        normalizedResult.workflowId !==
        job.data.workflowId
      ) {
        throw new Error(
          "Normalization result belongs to another workflow"
        );
      }

      const normalizedText =
        normalizedResult.normalizedText;

      const wordCount =
        normalizedText.length === 0
          ? 0
          : normalizedText.split(/\s+/).length;

      const result: PipelineAnalyzeResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          normalizedResult.originalText,

        normalizedText,

        wordCount,

        characterCount:
          normalizedText.length
      };

      logger.info(
        "Pipeline analysis completed",
        {
          queue:
            PIPELINE_ANALYZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          wordCount,
          characterCount:
            result.characterCount
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

pipelineAnalyzeWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline analysis failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineAnalyzeWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline analysis worker error",
      {
        error: error.message
      }
    );
  }
);