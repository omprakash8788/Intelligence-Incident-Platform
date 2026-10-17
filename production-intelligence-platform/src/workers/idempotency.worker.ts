import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  IDEMPOTENCY_QUEUE_NAME
} from "../queues/idempotency.queue.js";

import type {
  IdempotencyJobData
} from "../queues/jobs/idempotency.job.js";

import type {
  IdempotentEffectResult
} from "../services/idempotent-effect.service.js";

import {
  recordIdempotentEffect
} from "../services/idempotent-effect.service.js";

import { logger } from "../logging/logger.js";

export const idempotencyWorker =
  new Worker<
    IdempotencyJobData,
    IdempotentEffectResult
  >(
    IDEMPOTENCY_QUEUE_NAME,
    async (job) => {
      const result = await recordIdempotentEffect({
        idempotencyKey: job.data.idempotencyKey,
        message: job.data.message
      });

      logger.info("Idempotency job processed", {
        jobId: job.id,
        idempotencyKey: result.idempotencyKey,
        effectId: result.effectId,
        created: result.created
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 5
    }
  );