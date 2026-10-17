import { distributedLockQueue } from "../distributed-lock.queue.js";

import type { DistributedLockJobData } from "../jobs/distributed-lock.job.js";

export async function enqueueDistributedLockJob(
  data: DistributedLockJobData
): Promise<string> {
  const job = await distributedLockQueue.add(
    "process-report",
    data
  );

  if (!job.id) {
    throw new Error("BullMQ did not return a job ID");
  }

  return job.id;
}