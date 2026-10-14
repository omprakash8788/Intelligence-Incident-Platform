import {
  demoWorker
} from "./workers/demo.worker.js";

import {
  startDemoQueueEvents,
  closeDemoQueueEvents
} from "./queues/demo.queue-events.js";

import {
  logger
} from "./logging/logger.js";

import {
  externalApiWorker
} from "./workers/external-api.worker.js";


import {
  fanoutTaskWorker
} from "./workers/fanout-task.worker.js";

import {
  fanoutAggregateWorker
} from "./workers/fanout-aggregate.worker.js";

import {
  closeFanoutQueues,
  waitForFanoutQueuesReady
} from "./queues/fanout.queues.js";

let isShuttingDown = false;

const start = async (): Promise<void> => {
  try {
    await startDemoQueueEvents();

    await demoWorker.waitUntilReady();

    await externalApiWorker.waitUntilReady();

    await waitForFanoutQueuesReady();

    await Promise.all([
      fanoutTaskWorker.waitUntilReady(),
      fanoutAggregateWorker.waitUntilReady()
    ]);

    logger.info("Worker process started");
  } catch (error) {
    logger.error("Worker process startup failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });



    await Promise.allSettled([
      demoWorker.close(),
      externalApiWorker.close(),
      closeDemoQueueEvents()
    ]);

    process.exitCode = 1;
  }
};

const shutdown = async (
  signal: string
): Promise<void> => {
  if (isShuttingDown) {
    logger.warn("Worker shutdown already in progress", {
      signal
    });

    return;
  }

  isShuttingDown = true;

  logger.info("Worker shutdown started", {
    signal
  });



  try {
    await Promise.all([
      demoWorker.close(),
      externalApiWorker.close(),
      fanoutTaskWorker.close(),
      fanoutAggregateWorker.close()
    ]);
    // 2. Close QueueEvents.
    await closeDemoQueueEvents(),

    // 3. Close fan-out queues and FlowProducer.
    await closeFanoutQueues();


    logger.info("Worker shutdown completed");

    process.exitCode = 0;
  } catch (error) {
    logger.error("Worker shutdown failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });

    process.exitCode = 1;
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start();
