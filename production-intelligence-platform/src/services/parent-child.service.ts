import { randomUUID } from "node:crypto";

import {
  parentChildFlowProducer,
  parentChildParentQueue
} from "../queues/parent-child.queues.js";

import {
  buildParentChildFlow
} from "./parent-child-flow-builder.js";

const MAX_BATCH_SIZE = 20;
const MAX_ITEM_LENGTH = 200;

export interface SubmitParentChildBatchResult {
  batchId: string;
  parentJobId: string;
  itemCount: number;
}

export const submitParentChildBatch = async (
  items: string[]
): Promise<SubmitParentChildBatchResult> => {
  if (!Array.isArray(items)) {
    throw new TypeError(
      "Items must be an array"
    );
  }

  if (
    items.length === 0 ||
    items.length > MAX_BATCH_SIZE
  ) {
    throw new RangeError(
      `Batch size must be between 1 and ${MAX_BATCH_SIZE}`
    );
  }

  const validItems = items.every(
    (item) =>
      typeof item === "string" &&
      item.trim().length > 0 &&
      item.length <= MAX_ITEM_LENGTH
  );

  if (!validItems) {
    throw new TypeError(
      `Each item must be a non-empty string of at most ${MAX_ITEM_LENGTH} characters`
    );
  }

  const normalizedInputs = items.map(
    (item) => item.trim()
  );

  const batchId = randomUUID();

  const flow = buildParentChildFlow(
    batchId,
    normalizedInputs
  );

  const result = await parentChildFlowProducer.add(
    flow
  );

  if (!result.job.id) {
    throw new Error(
      "BullMQ did not return a parent job ID"
    );
  }

  return {
    batchId,
    parentJobId: result.job.id,
    itemCount: normalizedInputs.length
  };
};

export const getParentChildBatchStatus = async (
  parentJobId: string
) => {
  const job = await parentChildParentQueue.getJob(
    parentJobId
  );

  if (!job) {
    return null;
  }

  const state = await job.getState();

  return {
    parentJobId: job.id,
    batchId: job.data.batchId,
    itemCount: job.data.itemCount,
    state,
    result: job.returnvalue,
    failedReason: job.failedReason || null
  };
};