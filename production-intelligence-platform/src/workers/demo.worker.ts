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


import {
  UnrecoverableError
} from "bullmq";

import {
  RetryableJobError,
  NonRetryableJobError
} from "../errors/job.errors.js";

export const demoWorker =
  new Worker<
    DemoJobData,
    {
      processed: boolean;
      attempt: number;
    }
  >(
    DEMO_QUEUE_NAME,

    async (
      job: Job<DemoJobData>
    ) => {

      const attempt =
        job.attemptsMade + 1;

      console.log(
        `[DemoWorker] Processing job ${job.id}`
      );

      console.log(
        `[DemoWorker] Attempt: ${attempt}`
      );

      console.log(
        `[DemoWorker] Mode: ${job.data.mode}`
      );


      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

      /*
      * Permanent failure.
      *
      * This error is intentionally
      * treated as non-retryable.
      */

      if (
        job.data.mode ===
        "non-retryable"
      ) {
        const error =
          new NonRetryableJobError(
            "Invalid job data. This error must not be retried."
          );

        throw new UnrecoverableError(
          error.message
        );
      }

      /*
      * Retryable failure.
      *
      * This error is intentionally
      * retryable.
      */

      if (
        job.data.mode ===
        "retryable"
      ) {

        if (
          job.attemptsMade < 2
        ) {
          throw new RetryableJobError(
            `Temporary failure on attempt ${attempt}`
          );
        }
      }
      /*
      * Existing permanent failure
      * from previous lectures.
      */


      if (
        job.data.mode ===
        "failure"
      ) {
        const error =
          new NonRetryableJobError(
            "Intentional permanent demo failure"
          );

        throw new UnrecoverableError(
          error.message
        );
      }

      /*
      * Existing transient failure.
      *
      * Fail twice, then succeed.
      */

      if (
        job.data.mode ===
        "fail-twice"
      ) {

        if (
          job.attemptsMade < 2
        ) {
          throw new RetryableJobError(
            `Intentional transient failure on attempt ${attempt
            }`
          );
        }
      }

      /*
     * Slow job.
     */

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
      console.log(
        `[DemoWorker] Job ${job.id} succeeded on attempt ${attempt}`
      );

      return {
        processed: true,
        attempt
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
      {

        errorType:
          error.name,

        message:
          error.message,

        attemptsMade:
          job?.attemptsMade,

        attemptsAllowed:
          job?.opts.attempts
      }
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