import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  FANOUT_TASK_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutTaskData,
  FanoutTaskResult
} from "../queues/jobs/fanout.job.js";

import {
  logger
} from "../logging/logger.js";

export const fanoutTaskWorker =
  new Worker<
    FanoutTaskData,
    FanoutTaskResult
  >(
    FANOUT_TASK_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Fan-out child job started",
        {
          queue: FANOUT_TASK_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          itemId:
            job.data.itemId
        }
      );

      // Simulate a short asynchronous task.
      await new Promise<void>(
        (resolve) => {
          setTimeout(resolve, 100);
        }
      );

      const result: FanoutTaskResult = {
        workflowId:
          job.data.workflowId,

        itemId:
          job.data.itemId,

        input:
          job.data.value,

        transformed:
          job.data.value.toUpperCase()
      };

      logger.info(
        "Fan-out child job completed",
        {
          queue: FANOUT_TASK_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          itemId:
            job.data.itemId
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

fanoutTaskWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Fan-out child job failed",
      {
        queue: FANOUT_TASK_QUEUE_NAME,
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

fanoutTaskWorker.on(
  "error",
  (error) => {
    logger.error(
      "Fan-out child worker error",
      {
        queue: FANOUT_TASK_QUEUE_NAME,
        error: error.message
      }
    );
  }
);