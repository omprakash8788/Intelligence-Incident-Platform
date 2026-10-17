import { idempotencyQueue } from "../idempotency.queue.js";

import type {
  IdempotencyJobData
} from "../jobs/idempotency.job.js";

export const enqueueIdempotencyJob = async (
  data: IdempotencyJobData
): Promise<string> => {
  const job = await idempotencyQueue.add(
    "record-idempotent-effect",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return job.id;
};