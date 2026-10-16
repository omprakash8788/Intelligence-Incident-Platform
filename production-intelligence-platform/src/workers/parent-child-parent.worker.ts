import {
  Job,
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PARENT_CHILD_PARENT_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemResult,
  ParentChildParentData,
  ParentChildParentResult
} from "../queues/jobs/parent-child.job.js";

import { logger } from "../logging/logger.js";

export const parentChildParentWorker =
  new Worker<
    ParentChildParentData,
    ParentChildParentResult
  >(
    PARENT_CHILD_PARENT_QUEUE,
    async (
      job: Job<ParentChildParentData>
    ): Promise<ParentChildParentResult> => {
      const childResults =
        await job.getChildrenValues<
          ParentChildItemResult
        >();

      const items = Object.values(childResults);

      if (items.length !== job.data.itemCount) {
        throw new Error(
          `Expected ${job.data.itemCount} child results, received ${items.length}`
        );
      }

      const orderedItems = [...items].sort(
        (a, b) => a.index - b.index
      );

      const invalidResult = orderedItems.some(
        (item, index) =>
          item.batchId !== job.data.batchId ||
          item.index !== index
      );

      if (invalidResult) {
        throw new Error(
          "Child results do not match the expected batch"
        );
      }

      const summary = orderedItems
        .map((item) => item.normalizedValue)
        .join(", ");

      const result: ParentChildParentResult = {
        batchId: job.data.batchId,
        completedCount: orderedItems.length,
        items: orderedItems,
        summary
      };

      logger.info("Parent-child batch aggregated", {
        batchId: result.batchId,
        completedCount: result.completedCount,
        jobId: job.id
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 2
    }
  );