import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  SHARDED_QUEUE_NAMES
} from "./sharding.config.js";

import type {
  ShardedJobData,
  ShardedJobResult
} from "./jobs/sharded-job.js";

export const shardedQueues = SHARDED_QUEUE_NAMES.map(
  (queueName) =>
    new Queue<ShardedJobData, ShardedJobResult>(
      queueName,
      {
        connection: createBullMQConnection(1),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000
          },
          removeOnComplete: 100,
          removeOnFail: 500
        }
      }
    )
);

export const waitForShardedQueuesReady =
  async (): Promise<void> => {
    await Promise.all(
      shardedQueues.map(
        (queue) => queue.waitUntilReady()
      )
    );
  };

export const closeShardedQueues =
  async (): Promise<void> => {
    await Promise.allSettled(
      shardedQueues.map(
        (queue) => queue.close()
      )
    );
  };