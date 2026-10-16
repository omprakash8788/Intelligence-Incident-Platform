import {
  Job,
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PARENT_CHILD_ITEM_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemData,
  ParentChildItemResult
} from "../queues/jobs/parent-child.job.js";

import { logger } from "../logging/logger.js";

export const parentChildItemWorker =
  new Worker<
    ParentChildItemData,
    ParentChildItemResult
  >(
    PARENT_CHILD_ITEM_QUEUE,
    async (
      job: Job<ParentChildItemData>
    ): Promise<ParentChildItemResult> => {
      const normalizedValue =
        job.data.value.trim().toLowerCase();

      if (normalizedValue.length === 0) {
        throw new Error(
          "Child item cannot be empty"
        );
      }

      const result: ParentChildItemResult = {
        batchId: job.data.batchId,
        index: job.data.index,
        originalValue: job.data.value,
        normalizedValue
      };

      logger.info("Parent-child item completed", {
        batchId: result.batchId,
        index: result.index,
        normalizedValue: result.normalizedValue,
        jobId: job.id
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 5
    }
  );