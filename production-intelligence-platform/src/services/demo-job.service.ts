import type {
  Job,
  JobState
} from "bullmq";

import {
  demoQueue
} from "../queues/demo.queue.js";

export interface DemoJobStatus {
  id: string;
  name: string;
  state: JobState | unknown;
  data: unknown;
  result: unknown;
  failedReason: string | undefined;
}

export const getDemoJobStatus =
  async (
    jobId: string
  ): Promise<
    DemoJobStatus | null
  > => {

    const job =
      await demoQueue.getJob(
        jobId
      );

    if (!job) {
      return null;
    }

    const state =
      await job.getState();

    return {
      id:
        job.id ?? jobId,

      name:
        job.name,

      state,

      data:
        job.data,

      result:
        job.returnvalue,

      failedReason:
        job.failedReason
    };
  };