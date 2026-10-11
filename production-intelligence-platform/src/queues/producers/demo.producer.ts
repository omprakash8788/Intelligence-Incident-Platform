import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData,
  DemoJobPriority
} from "../jobs/demo.job.js";


export interface AddDemoJobOptions {
  delayMs?: number;
  priority?: DemoJobPriority;

}

const isValidDelay = (
  delayMs: number
): boolean => {
  return (
    Number.isInteger(delayMs) &&
    delayMs >= 0 &&
    delayMs <= 86_400_000
  );
};

export const addDemoJob =
  async (
    data: Omit<DemoJobData, "priority">,
    options: AddDemoJobOptions = {}
  ): Promise<string> => {

    const delayMs =
      options.delayMs ?? 0;

    const priority =
      options.priority ?? 5;

    if (!isValidDelay(delayMs)) {
      throw new Error(
        "delayMs must be an integer between 0 and 86400000"
      );
    }


    const job = await demoQueue.add(
      "demo-job",
      {
        ...data,
        priority
      },
      {
        priority,
        ...(delayMs > 0
          ? { delay: delayMs }
          : {})
      }
    );

    if (!job.id) {
      throw new Error(
        "BullMQ did not return a job ID"
      );
    }

    return job.id;
  };