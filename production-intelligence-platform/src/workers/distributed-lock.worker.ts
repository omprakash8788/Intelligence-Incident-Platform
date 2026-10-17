import { Worker } from "bullmq";

import { createBullMQConnection } from "../queues/bullmq.connection.js";

import { DISTRIBUTED_LOCK_QUEUE_NAME } from "../queues/distributed-lock.queue.js";

import type { DistributedLockJobData } from "../queues/jobs/distributed-lock.job.js";

import { distributedLockService } from "../services/distributed-lock.service.js";

const LOCK_TTL_MS = 30_000;

function simulateReportWork(
  workMs: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, workMs);
  });
}

export const distributedLockWorker =
  new Worker<DistributedLockJobData>(
    DISTRIBUTED_LOCK_QUEUE_NAME,

    async (job) => {
      const resource = `report:${job.data.reportId}`;

      const token = await distributedLockService.acquire(
        resource,
        LOCK_TTL_MS
      );

      if (!token) {
        throw new Error(
          `Resource is locked: ${resource}`
        );
      }

      console.log(
        `[distributed-lock] Acquired resource=${resource} jobId=${job.id}`
      );

      try {
        console.log(
          `[distributed-lock] Work started resource=${resource} jobId=${job.id}`
        );

        await simulateReportWork(job.data.workMs);

        console.log(
          `[distributed-lock] Work finished resource=${resource} jobId=${job.id}`
        );

        return {
          success: true,
          reportId: job.data.reportId,
          processedAt: new Date().toISOString()
        };
      } finally {
        try {
          const released =
            await distributedLockService.release(
              resource,
              token
            );

          if (!released) {
            console.error(
              `[distributed-lock] Release rejected; ownership changed or lease expired resource=${resource} jobId=${job.id}`
            );
          } else {
            console.log(
              `[distributed-lock] Released resource=${resource} jobId=${job.id}`
            );
          }
        } catch (error) {
          console.error(
            `[distributed-lock] Release failed; lock may remain until TTL expiration resource=${resource} jobId=${job.id}`,
            error
          );
        }
      }
    },

    {
      connection: createBullMQConnection(null),
      concurrency: 5
    }
  );

distributedLockWorker.on("failed", (job, error) => {
  console.error(
    `[distributed-lock] Job failed jobId=${job?.id}`,
    error
  );
});

distributedLockWorker.on("error", (error) => {
  console.error(
    "[distributed-lock] Worker error",
    error
  );
});