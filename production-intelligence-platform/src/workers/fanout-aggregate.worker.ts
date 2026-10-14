import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  FANOUT_AGGREGATE_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutAggregateData,
  FanoutAggregateResult,
  FanoutTaskResult
} from "../queues/jobs/fanout.job.js";

import {
  logger
} from "../logging/logger.js";

const isFanoutTaskResult = (
  value: unknown
): value is FanoutTaskResult => {
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
    typeof result.itemId === "string" &&
    typeof result.input === "string" &&
    typeof result.transformed === "string"
  );
};

export const fanoutAggregateWorker =
  new Worker<
    FanoutAggregateData,
    FanoutAggregateResult
  >(
    FANOUT_AGGREGATE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Fan-in aggregation started",
        {
          queue:
            FANOUT_AGGREGATE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          expectedChildren:
            job.data.expectedChildren
        }
      );

      const childrenValues =
        await job.getChildrenValues();

      const rawResults: unknown[] =
        Object.values(childrenValues);

      const results =
        rawResults.filter(
          isFanoutTaskResult
        );

      if (
        results.length !==
        job.data.expectedChildren
      ) {
        throw new Error(
          `Expected ${job.data.expectedChildren} child results but received ${results.length}`
        );
      }

      const hasWrongWorkflow =
        results.some(
          (result) =>
            result.workflowId !==
            job.data.workflowId
        );

      if (hasWrongWorkflow) {
        throw new Error(
          "A child result belongs to a different workflow"
        );
      }

      const orderedResults =
        [...results].sort(
          (a, b) =>
            a.itemId.localeCompare(
              b.itemId
            )
        );

      const aggregateResult:
        FanoutAggregateResult = {
          workflowId:
            job.data.workflowId,

          childCount:
            orderedResults.length,

          results:
            orderedResults,

          completedAt:
            new Date().toISOString()
        };

      logger.info(
        "Fan-in aggregation completed",
        {
          queue:
            FANOUT_AGGREGATE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          childCount:
            aggregateResult.childCount
        }
      );

      return aggregateResult;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 2
    }
  );

fanoutAggregateWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Fan-in aggregation failed",
      {
        queue:
          FANOUT_AGGREGATE_QUEUE_NAME,
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

fanoutAggregateWorker.on(
  "error",
  (error) => {
    logger.error(
      "Fan-in aggregation worker error",
      {
        queue:
          FANOUT_AGGREGATE_QUEUE_NAME,
        error: error.message
      }
    );
  }
);
