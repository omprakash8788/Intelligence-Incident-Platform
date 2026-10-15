import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_REPORT_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineAnalyzeResult,
  PipelineReportData,
  PipelineReportResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

const isPipelineAnalyzeResult = (
  value: unknown
): value is PipelineAnalyzeResult => {
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
    typeof result.normalizedText === "string" &&
    typeof result.wordCount === "number" &&
    typeof result.characterCount === "number"
  );
};

export const pipelineReportWorker =
  new Worker<
    PipelineReportData,
    PipelineReportResult
  >(
    PIPELINE_REPORT_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline report generation started",
        {
          queue:
            PIPELINE_REPORT_QUEUE_NAME,
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
          `Expected one analysis result, received ${results.length}`
        );
      }

      const analysisResult =
        results.find(
          isPipelineAnalyzeResult
        );

      if (!analysisResult) {
        throw new Error(
          "Analysis result is invalid"
        );
      }

      if (
        analysisResult.workflowId !==
        job.data.workflowId
      ) {
        throw new Error(
          "Analysis result belongs to another workflow"
        );
      }

      if (
        !Number.isInteger(
          analysisResult.wordCount
        ) ||
        analysisResult.wordCount < 0 ||
        !Number.isInteger(
          analysisResult.characterCount
        ) ||
        analysisResult.characterCount < 0
      ) {
        throw new Error(
          "Analysis result contains invalid counts"
        );
      }

      const result: PipelineReportResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          analysisResult.originalText,

        normalizedText:
          analysisResult.normalizedText,

        wordCount:
          analysisResult.wordCount,

        characterCount:
          analysisResult.characterCount,

        status: "completed",

        completedAt:
          new Date().toISOString()
      };

      logger.info(
        "Pipeline report generation completed",
        {
          queue:
            PIPELINE_REPORT_QUEUE_NAME,
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

      concurrency: 2
    }
  );

pipelineReportWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline report generation failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineReportWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline report worker error",
      {
        error: error.message
      }
    );
  }
);