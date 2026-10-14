import {
  FANOUT_AGGREGATE_QUEUE_NAME,
  FANOUT_TASK_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutTaskData
} from "../queues/jobs/fanout.job.js";

export interface FanoutInputItem {
  itemId: string;
  value: string;
}

export const buildFanoutFlowDefinition = (
  workflowId: string,
  items: FanoutInputItem[]
) => {
  return {
    name: "aggregate-results",

    queueName:
      FANOUT_AGGREGATE_QUEUE_NAME,

    data: {
      workflowId,
      expectedChildren: items.length
    },

    opts: {
      attempts: 3,

      backoff: {
        type: "exponential" as const,
        delay: 1000
      }
    },

    children: items.map((item) => {
      const data: FanoutTaskData = {
        workflowId,
        itemId: item.itemId,
        value: item.value
      };

      return {
        name: "process-item",

        queueName:
          FANOUT_TASK_QUEUE_NAME,

        data,

        opts: {
          attempts: 3,

          backoff: {
            type: "exponential" as const,
            delay: 1000
          }
        }
      };
    })
  };
};

