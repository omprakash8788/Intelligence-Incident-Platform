import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE
} from "../queues/workload.queue-names.js";

import type {
  WorkloadJobData,
  WorkloadJobResult
} from "../queues/jobs/workload.job.js";

import { logger } from "../logging/logger.js";

export const interactiveWorkloadWorker =
  new Worker<
    WorkloadJobData,
    WorkloadJobResult
  >(
    INTERACTIVE_WORKLOAD_QUEUE,
    async (job): Promise<WorkloadJobResult> => {
      const processedMessage =
        job.data.message.trim().toLowerCase();

      const result: WorkloadJobResult = {
        workloadId: job.data.workloadId,
        workloadType: job.data.workloadType,
        originalMessage: job.data.message,
        processedMessage,
        processedAt: new Date().toISOString()
      };

      logger.info(
        "Interactive workload completed",
        {
          workloadId: result.workloadId,
          jobId: job.id,
          queue: INTERACTIVE_WORKLOAD_QUEUE
        }
      );

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 10
    }
  );