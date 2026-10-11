import {
  QueueEvents
} from "bullmq";

import {
  DEMO_QUEUE_NAME
} from "./demo.queue.js";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  logger
} from "../logging/logger.js";

export const demoQueueEvents =
  new QueueEvents(
    DEMO_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(null)
    }
  );

demoQueueEvents.on(
  "waiting",
  ({ jobId, prev }) => {
    logger.info(
      "BullMQ job waiting",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        previousState: prev
      }
    );
  }
);

demoQueueEvents.on(
  "active",
  ({ jobId, prev }) => {
    logger.info(
      "BullMQ job active",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        previousState: prev
      }
    );
  }
);

demoQueueEvents.on(
  "progress",
  ({ jobId, data }) => {
    logger.info(
      "BullMQ job progress",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        progress: data
      }
    );
  }
);

demoQueueEvents.on(
  "completed",
  ({ jobId, returnvalue }) => {
    logger.info(
      "BullMQ job completed",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        returnvalue
      }
    );
  }
);

demoQueueEvents.on(
  "failed",
  ({ jobId, failedReason }) => {
    logger.error(
      "BullMQ job failed",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        failedReason
      }
    );
  }
);

demoQueueEvents.on(
  "delayed",
  ({ jobId, delay }) => {
    logger.info(
      "BullMQ job delayed",
      {
        queue: DEMO_QUEUE_NAME,
        jobId,
        delay
      }
    );
  }
);

demoQueueEvents.on(
  "stalled",
  ({ jobId }) => {
    logger.warn(
      "BullMQ job stalled",
      {
        queue: DEMO_QUEUE_NAME,
        jobId
      }
    );
  }
);

demoQueueEvents.on(
  "error",
  (error) => {
    logger.error(
      "BullMQ QueueEvents listener error",
      {
        queue: DEMO_QUEUE_NAME,
        error: error.message
      }
    );
  }
);

export const startDemoQueueEvents =
  async (): Promise<void> => {
    await demoQueueEvents.waitUntilReady();

    logger.info(
      "BullMQ QueueEvents listener ready",
      {
        queue: DEMO_QUEUE_NAME
      }
    );
  };

export const closeDemoQueueEvents =
  async (): Promise<void> => {
    await demoQueueEvents.close();

    logger.info(
      "BullMQ QueueEvents listener closed",
      {
        queue: DEMO_QUEUE_NAME
      }
    );
  };