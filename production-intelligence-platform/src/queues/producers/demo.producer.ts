import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";

export const addDemoJob =
  async (
    data: DemoJobData
  ): Promise<string> => {

    const job =
      await demoQueue.add(
        "demo-job",
        data
      );

    if (
      job.id === undefined
    ) {
      throw new Error(
        "BullMQ job ID was not generated"
      );
    }

    return job.id;
  };