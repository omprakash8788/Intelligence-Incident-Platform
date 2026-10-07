import {
  Worker,
  Job
} from "bullmq";

import {
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import type {
  DemoJobData
} from "../queues/jobs/demo.job.js";

export const demoWorker =
  new Worker<
    DemoJobData,
    {
      processed: boolean;
    }
  >(
    DEMO_QUEUE_NAME,

    async (
      job: Job<DemoJobData>
    ) => {

      console.log(
        `[DemoWorker] Processing job ${job.id}`
      );

        console.log(
        `[DemoWorker] Mode: ${job.data.mode}`
      );


      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

         if (
        job.data.mode ===
        "failure"
      ) {
        throw new Error(
          "Intentional demo job failure"
        );
      }
     
         if (
        job.data.mode ===
        "slow"
      ) {
        await new Promise<void>(
          (resolve) => {
            setTimeout(
              resolve,
              10000
            );
          }
        );
      }
      
      return {
        processed: true
      };
    },

    {
      connection:
        createBullMQConnection(
          null
        )
    }
  );

demoWorker.on(
  "completed",
  (job) => {

    console.log(
      `[DemoWorker] Job ${job.id} completed`
    );
  }
);

demoWorker.on(
  "failed",
  (
    job,
    error
  ) => {

    console.error(
      `[DemoWorker] Job ${job?.id ?? "unknown"} failed`,
      error
    );
  }
);

demoWorker.on(
  "error",
  (error) => {

    console.error(
      "[DemoWorker] Worker error",
      error
    );
  }
);