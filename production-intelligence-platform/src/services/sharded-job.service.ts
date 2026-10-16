import { randomUUID } from "node:crypto";

import {
  SHARDED_QUEUE_NAMES,
  SHARD_COUNT
} from "../queues/sharding.config.js";

import {
  shardedQueues
} from "../queues/sharded.queues.js";

import type {
  ShardedJobData
} from "../queues/jobs/sharded-job.js";

import {
  resolveShardIndex
} from "./sharding.policy.js";

const MAX_MESSAGE_LENGTH = 500;
const MAX_PARTITION_KEY_LENGTH = 100;

export interface SubmitShardedJobInput {
  partitionKey: string;
  message: string;
}

export interface SubmitShardedJobResult {
  workloadId: string;
  jobId: string;
  partitionKey: string;
  shardIndex: number;
  queueName: string;
}

export const submitShardedJob = async (
  input: SubmitShardedJobInput
): Promise<SubmitShardedJobResult> => {
  if (
    typeof input.partitionKey !== "string" ||
    input.partitionKey.trim().length === 0 ||
    input.partitionKey.length > MAX_PARTITION_KEY_LENGTH
  ) {
    throw new TypeError(
      `Partition key must contain 1 to ${MAX_PARTITION_KEY_LENGTH} characters`
    );
  }

  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const partitionKey = input.partitionKey.trim();
  const message = input.message.trim();

  const shardIndex = resolveShardIndex(
    partitionKey,
    SHARD_COUNT
  );

  const queue = shardedQueues[shardIndex];

  if (!queue) {
    throw new Error(
      `No queue configured for shard ${shardIndex}`
    );
  }

  const workloadId = randomUUID();

  const data: ShardedJobData = {
    partitionKey,
    shardIndex,
    message,
    submittedAt: new Date().toISOString()
  };

  const job = await queue.add(
    "process-sharded-job",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return {
    workloadId,
    jobId: job.id,
    partitionKey,
    shardIndex,
    queueName: SHARDED_QUEUE_NAMES[shardIndex]
  };
};

export const getShardedJobStatus = async (
  shardIndex: number,
  jobId: string
) => {
  if (
    !Number.isInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= SHARD_COUNT
  ) {
    throw new RangeError(
      "Invalid shard index"
    );
  }

  if (
    typeof jobId !== "string" ||
    jobId.trim().length === 0
  ) {
    throw new TypeError(
      "Job ID must be a non-empty string"
    );
  }

  const queue = shardedQueues[shardIndex];

  if (!queue) {
    throw new Error(
      `No queue configured for shard ${shardIndex}`
    );
  }

  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  return {
    jobId: job.id,
    queueName: SHARDED_QUEUE_NAMES[shardIndex],
    shardIndex,
    partitionKey: job.data.partitionKey,
    state: await job.getState(),
    result: job.returnvalue,
    failedReason: job.failedReason || null
  };
};