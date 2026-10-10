import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";


export interface AddDemoJobOptions {
  delayMs?: number;
}

export const addDemoJob =
  async (
    data: DemoJobData,
    options: AddDemoJobOptions = {}
  ): Promise<string> => {

    const delayMs =
      options.delayMs ?? 0;

    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0
    ) {
      throw new Error(
        "delayMs must be a non-negative integer"
      );
    }


    const job = await demoQueue.add(
      "demo-job",
      data,
      delayMs > 0
        ? { delay: delayMs }
        : {}
    );

    if (!job.id) {
      throw new Error(
        "BullMQ did not return a job ID"
      );
    }

    return job.id;
  };