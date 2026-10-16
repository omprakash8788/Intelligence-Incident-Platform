import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  SHARDED_QUEUE_NAMES
} from "../queues/sharding.config.js";

import type {
  ShardedJobData,
  ShardedJobResult
} from "../queues/jobs/sharded-job.js";

import { logger } from "../logging/logger.js";

export const shardedWorkers = SHARDED_QUEUE_NAMES.map(
  (queueName, expectedShardIndex) =>
    new Worker<ShardedJobData, ShardedJobResult>(
      queueName,
      async (job): Promise<ShardedJobResult> => {
        if (
          job.data.shardIndex !== expectedShardIndex
        ) {
          throw new Error(
            `Shard mismatch: expected ${expectedShardIndex}, received ${job.data.shardIndex}`
          );
        }

        const result: ShardedJobResult = {
          partitionKey: job.data.partitionKey,
          shardIndex: expectedShardIndex,
          originalMessage: job.data.message,
          processedMessage: job.data.message
            .trim()
            .toLowerCase(),
          processedAt: new Date().toISOString()
        };

        logger.info("Sharded job completed", {
          jobId: job.id,
          partitionKey: result.partitionKey,
          shardIndex: result.shardIndex,
          queueName
        });

        return result;
      },
      {
        connection: createBullMQConnection(1),
        concurrency: 3
      }
    )
);