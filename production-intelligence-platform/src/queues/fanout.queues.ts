import {
  FlowProducer,
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  FANOUT_AGGREGATE_QUEUE_NAME,
  FANOUT_TASK_QUEUE_NAME
} from "./fanout.queue-names.js";

import type {
  FanoutAggregateData,
  FanoutAggregateResult,
  FanoutTaskData,
  FanoutTaskResult
} from "./jobs/fanout.job.js";

export const fanoutTaskQueue = new Queue<
  FanoutTaskData,
  FanoutTaskResult
>(
  FANOUT_TASK_QUEUE_NAME,
  {
    connection:
      createBullMQConnection(1),

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 1000
      },

      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const fanoutAggregateQueue = new Queue<
  FanoutAggregateData,
  FanoutAggregateResult
>(
  FANOUT_AGGREGATE_QUEUE_NAME,
  {
    connection:
      createBullMQConnection(1),

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 1000
      },

      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const fanoutFlowProducer =
  new FlowProducer({
    connection:
      createBullMQConnection(1)
  });

export const waitForFanoutQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      fanoutTaskQueue.waitUntilReady(),
      fanoutAggregateQueue.waitUntilReady(),
      fanoutFlowProducer.waitUntilReady()
    ]);
  };

export const closeFanoutQueues =
  async (): Promise<void> => {
    await Promise.all([
      fanoutFlowProducer.close(),
      fanoutTaskQueue.close(),
      fanoutAggregateQueue.close()
    ]);
  };