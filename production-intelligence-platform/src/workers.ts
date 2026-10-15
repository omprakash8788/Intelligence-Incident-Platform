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


import {
  pipelineNormalizeWorker
} from "./workers/pipeline-normalize.worker.js";

import {
  pipelineAnalyzeWorker
} from "./workers/pipeline-analyze.worker.js";

import {
  pipelineReportWorker
} from "./workers/pipeline-report.worker.js";

import {
  closePipelineQueues,
  waitForPipelineQueuesReady
} from "./queues/pipeline.queues.js";

let isShuttingDown = false;

const start = async (): Promise<void> => {
  try {
    await startDemoQueueEvents();

    await demoWorker.waitUntilReady();

    await externalApiWorker.waitUntilReady();

    await waitForFanoutQueuesReady();

    await waitForPipelineQueuesReady();

    await Promise.all([
      fanoutTaskWorker.waitUntilReady(),
      fanoutAggregateWorker.waitUntilReady(),
      pipelineNormalizeWorker.waitUntilReady(),
      pipelineAnalyzeWorker.waitUntilReady(),
      pipelineReportWorker.waitUntilReady()
    ]);

    logger.info("Worker process started");
  } catch (error) {
    logger.error("Worker process startup failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });



    await Promise.allSettled([
      // Existing workers
      demoWorker.close(),
      externalApiWorker.close(),

      // Fan-out workers
      fanoutTaskWorker.close(),
      fanoutAggregateWorker.close(),

      // Pipeline workers
      pipelineNormalizeWorker.close(),
      pipelineAnalyzeWorker.close(),
      pipelineReportWorker.close(),

      // Queue resources
      closeDemoQueueEvents(),
      closeFanoutQueues(),
      closePipelineQueues()
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
      fanoutAggregateWorker.close(),
      pipelineNormalizeWorker.close(),
      pipelineAnalyzeWorker.close(),
      pipelineReportWorker.close()
    ]);
    // 2. Close QueueEvents.
    await closeDemoQueueEvents();

      // 3. Close fan-out queues and FlowProducer.
      await closeFanoutQueues();

    await closePipelineQueues();


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
