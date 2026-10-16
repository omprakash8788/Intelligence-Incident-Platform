import {
  PARENT_CHILD_ITEM_QUEUE,
  PARENT_CHILD_PARENT_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemData,
  ParentChildParentData
} from "../queues/jobs/parent-child.job.js";

export interface ParentChildFlowDefinition {
  name: string;
  queueName: string;
  data: ParentChildItemData | ParentChildParentData;
  opts?: {
    attempts?: number;
    backoff?: {
      type: "exponential";
      delay: number;
    };
  };
  children?: ParentChildFlowDefinition[];
}

export const buildParentChildFlow = (
  batchId: string,
  items: string[]
): ParentChildFlowDefinition => {
  return {
    name: "aggregate-batch",
    queueName: PARENT_CHILD_PARENT_QUEUE,
    data: {
      batchId,
      itemCount: items.length
    },
    opts: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      }
    },
    children: items.map((value, index) => ({
      name: "process-batch-item",
      queueName: PARENT_CHILD_ITEM_QUEUE,
      data: {
        batchId,
        index,
        value
      },
      opts: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000
        }
      }
    }))
  };
};
