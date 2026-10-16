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

import {
  parentChildItemWorker
} from "./workers/parent-child-item.worker.js";

import {
  parentChildParentWorker
} from "./workers/parent-child-parent.worker.js";

import {
  closeParentChildQueues,
  waitForParentChildQueuesReady
} from "./queues/parent-child.queues.js";


import {
  interactiveWorkloadWorker
} from "./workers/interactive-workload.worker.js";

import {
  batchWorkloadWorker
} from "./workers/batch-workload.worker.js";

import {
  closeWorkloadQueues,
  waitForWorkloadQueuesReady
} from "./queues/workload.queues.js";


import {
  shardedWorkers
} from "./workers/sharded.worker.js";

import {
  closeShardedQueues,
  waitForShardedQueuesReady
} from "./queues/sharded.queues.js";



let isShuttingDown = false;

const start = async (): Promise<void> => {
  try {
    await startDemoQueueEvents();

    await demoWorker.waitUntilReady();

    await externalApiWorker.waitUntilReady();

    await waitForFanoutQueuesReady();

    await waitForPipelineQueuesReady();

    await waitForParentChildQueuesReady();

    await waitForWorkloadQueuesReady();

    await waitForShardedQueuesReady();


    await Promise.all([
      fanoutTaskWorker.waitUntilReady(),
      fanoutAggregateWorker.waitUntilReady(),
      pipelineNormalizeWorker.waitUntilReady(),
      pipelineAnalyzeWorker.waitUntilReady(),
      pipelineReportWorker.waitUntilReady(),
      parentChildItemWorker.waitUntilReady(),
      parentChildParentWorker.waitUntilReady(),
      interactiveWorkloadWorker.waitUntilReady(),
      batchWorkloadWorker.waitUntilReady(),
      shardedWorkers.map(
        (worker) => worker.waitUntilReady()
      )
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

      parentChildItemWorker.close(),
      parentChildParentWorker.close(),

      interactiveWorkloadWorker.close(),
      batchWorkloadWorker.close(),

      ...shardedWorkers.map(
  (worker) => worker.close()
),

      // Queue resources
      closeDemoQueueEvents(),
      closeFanoutQueues(),
      closePipelineQueues(),
      closeParentChildQueues(),

      closeWorkloadQueues(),

      closeShardedQueues()
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
      pipelineReportWorker.close(),
      parentChildItemWorker.close(),
      parentChildParentWorker.close(),
      interactiveWorkloadWorker.close(),
      batchWorkloadWorker.close(),
      ...shardedWorkers.map(
  (worker) => worker.close()
)
    ]);



    await closeParentChildQueues();

    // 2. Close QueueEvents.
    await closeDemoQueueEvents();

    // 3. Close fan-out queues and FlowProducer.
    await closeFanoutQueues();

    await closePipelineQueues();

    await closeWorkloadQueues();

    await closeShardedQueues();


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
