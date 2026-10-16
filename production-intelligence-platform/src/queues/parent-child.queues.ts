import {
  FlowProducer,
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  PARENT_CHILD_ITEM_QUEUE,
  PARENT_CHILD_PARENT_QUEUE
} from "./parent-child.queue-names.js";

export const parentChildItemQueue =
  new Queue(PARENT_CHILD_ITEM_QUEUE, {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });

export const parentChildParentQueue =
  new Queue(PARENT_CHILD_PARENT_QUEUE, {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });

export const parentChildFlowProducer =
  new FlowProducer({
    connection: createBullMQConnection(1)
  });

export const waitForParentChildQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      parentChildItemQueue.waitUntilReady(),
      parentChildParentQueue.waitUntilReady()
    ]);
  };

export const closeParentChildQueues =
  async (): Promise<void> => {
    await Promise.allSettled([
      parentChildFlowProducer.close(),
      parentChildItemQueue.close(),
      parentChildParentQueue.close()
    ]);
  };
